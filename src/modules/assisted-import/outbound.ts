import { lookup } from "node:dns/promises";
import { request } from "node:https";
import { BlockList, isIP } from "node:net";
import { DomainError } from "../shared/errors";
import { detectImage, normalizeImage } from "../media/storage";

const blocked = new BlockList();
for (const [ip, bits] of [
  ["0.0.0.0", 8],
  ["10.0.0.0", 8],
  ["100.64.0.0", 10],
  ["127.0.0.0", 8],
  ["169.254.0.0", 16],
  ["172.16.0.0", 12],
  ["192.0.0.0", 24],
  ["192.0.2.0", 24],
  ["192.88.99.0", 24],
  ["192.168.0.0", 16],
  ["198.18.0.0", 15],
  ["198.51.100.0", 24],
  ["203.0.113.0", 24],
  ["224.0.0.0", 4],
  ["240.0.0.0", 4],
] as const)
  blocked.addSubnet(ip, bits, "ipv4");
const globalV6 = new BlockList();
globalV6.addSubnet("2000::", 3, "ipv6");
blocked.addAddress("168.63.129.16", "ipv4"); // Cloud platform virtual IP, not an ordinary public origin.
for (const [ip, bits] of [
  ["2001::", 23],
  ["2001:db8::", 32],
  ["2002::", 16],
  ["3fff::", 20],
] as const)
  blocked.addSubnet(ip, bits, "ipv6");
export function publicAddress(address: string) {
  const family = isIP(address);
  return family === 4
    ? !blocked.check(address, "ipv4")
    : family === 6 &&
        globalV6.check(address, "ipv6") &&
        !blocked.check(address, "ipv6");
}
const fail = (message: string) => new DomainError("SOURCE_FETCH", message);
export function outboundUrl(raw: string) {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw fail("Enter a complete public HTTPS URL.");
  }
  const host = url.hostname.replace(/^\[|\]$/g, "");
  if (
    raw.length > 2048 ||
    /[\x00-\x20\x7f\\]/.test(raw) ||
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    (url.port && url.port !== "443") ||
    url.hash ||
    (!isIP(host) &&
      (!host.includes(".") ||
        host.endsWith(".") ||
        /(?:^|\.)(?:localhost|local|internal|lan|home|test|invalid|onion)$/.test(
          host,
        ))) ||
    (isIP(host) && !publicAddress(host))
  )
    throw fail(
      "Use public HTTPS on port 443, without credentials or fragments. Local and reserved addresses are blocked.",
    );
  return url;
}
export type Resolver = (
  host: string,
) => Promise<{ address: string; family: number }[]>;
const resolver: Resolver = (host) =>
  lookup(host, { all: true, order: "verbatim" });
export async function publicTarget(raw: string, resolve: Resolver = resolver) {
  const url = outboundUrl(raw),
    host = url.hostname.replace(/^\[|\]$/g, "");
  const addresses = isIP(host)
    ? [{ address: host, family: isIP(host) }]
    : await resolve(host);
  if (
    !addresses.length ||
    addresses.some(
      (row) => !publicAddress(row.address) || row.family !== isIP(row.address),
    )
  )
    throw fail(
      "The source resolves to a local, reserved or unsupported network address.",
    );
  return { url, address: addresses[0] };
}
type Target = Awaited<ReturnType<typeof publicTarget>>;
export type Download = {
  status: number;
  location?: string;
  type: string;
  bytes: Buffer;
};
export type Transport = (
  target: Target,
  maxBytes: number,
  signal: AbortSignal,
) => Promise<Download>;
/** DNS is resolved/validated once, then pinned for this socket. TLS still verifies the original hostname. */
const transport: Transport = (target, maxBytes, signal) =>
  new Promise((resolve, reject) => {
    const req = request(
      target.url,
      {
        method: "GET",
        agent: false,
        signal,
        maxHeaderSize: 16384,
        family: target.address.family,
        headers: {
          Accept: "text/html,image/png,image/jpeg,image/webp",
          "Accept-Encoding": "identity",
          "User-Agent": "Kokono-Admin-Importer/1.0",
        },
        lookup: (_host, _options, callback) =>
          callback(null, target.address.address, target.address.family),
      },
      (response) => {
        const status = response.statusCode ?? 0;
        const type = String(response.headers["content-type"] ?? "");
        if ([301, 302, 303, 307, 308].includes(status)) {
          response.destroy();
          resolve({
            status,
            location: response.headers.location,
            type,
            bytes: Buffer.alloc(0),
          });
          return;
        }
        if (status !== 200) {
          response.destroy();
          reject(
            fail(
              `The source returned HTTP ${status}. Check the URL or retry later.`,
            ),
          );
          return;
        }
        if (
          !/^(text\/html|image\/(png|jpeg|webp))(?:;|$)/i.test(type) ||
          ![undefined, "identity"].includes(
            response.headers["content-encoding"],
          ) ||
          Number(response.headers["content-length"] ?? 0) > maxBytes
        ) {
          response.destroy();
          reject(
            fail(
              "The source response has an unsupported format, compression, or exceeds the download limit.",
            ),
          );
          return;
        }
        const chunks: Buffer[] = [];
        let size = 0;
        response.on("data", (chunk: Buffer) => {
          size += chunk.length;
          if (size > maxBytes) {
            response.destroy(fail("The source exceeds the download limit."));
            return;
          }
          chunks.push(chunk);
        });
        response.on("error", reject);
        response.on("end", () =>
          resolve({ status, type, bytes: Buffer.concat(chunks) }),
        );
      },
    );
    req.on("error", reject);
    req.end();
  });
let active = 0;
export async function downloadPublic(
  raw: string,
  kind: "html" | "image",
  deps: { resolve?: Resolver; transport?: Transport; timeoutMs?: number } = {},
) {
  if (active >= 4)
    throw fail("Other source downloads are running. Retry in a moment.");
  active++;
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(fail("The source took too long to respond. Retry later."));
    }, deps.timeoutMs ?? 12000);
  });
  try {
    return await Promise.race([
      timeout,
      (async () => {
        let current = raw;
        for (let hop = 0; hop <= 3; hop++) {
          const target = await publicTarget(current, deps.resolve);
          if (controller.signal.aborted) throw fail("Source request expired.");
          const result = await (deps.transport ?? transport)(
            target,
            kind === "html" ? 2 * 1024 * 1024 : 1024 * 1024,
            controller.signal,
          );
          if ([301, 302, 303, 307, 308].includes(result.status)) {
            if (!result.location || hop === 3)
              throw fail(
                "The source redirected too many times or omitted its destination.",
              );
            current = new URL(result.location, target.url).href;
            continue;
          }
          if (
            result.status !== 200 ||
            result.bytes.length >
              (kind === "html" ? 2 * 1024 * 1024 : 1024 * 1024)
          )
            throw fail("The source response is invalid or too large.");
          if (kind === "html") {
            if (!/^text\/html(?:;|$)/i.test(result.type))
              throw fail("The source must be an HTML page.");
            const charset =
              /charset\s*=\s*["']?([^;\s"']+)/i.exec(result.type)?.[1] ??
              /<meta[^>]*charset\s*=\s*["']?([^\s"'/>;]+)/i.exec(
                result.bytes.toString("ascii", 0, 2048),
              )?.[1] ??
              "utf-8";
            if (
              !/^(utf-8|utf8|shift_jis|shift-jis|windows-31j|euc-jp)$/i.test(
                charset,
              )
            )
              throw fail("The source uses an unsupported text encoding.");
            return {
              url: target.url.href,
              bytes: result.bytes,
              type: "text/html",
              html: new TextDecoder(charset, { fatal: true }).decode(
                result.bytes,
              ),
            };
          }
          const b = result.bytes;
          const type = detectImage(b).mime;
          if (result.type.split(";")[0].toLowerCase() !== type)
            throw fail(
              "Only verified PNG, JPEG and WebP image responses are supported.",
            );
          const image = await normalizeImage(b);
          return { url: target.url.href, bytes: image.bytes, type, html: "" };
        }
        throw fail("Unable to fetch source.");
      })(),
    ]);
  } catch (error) {
    if (error instanceof DomainError) throw error;
    throw fail(
      "The source could not be downloaded safely. Check the URL, encoding and availability, then retry.",
    );
  } finally {
    clearTimeout(timer);
    controller.abort();
    active--;
  }
}
