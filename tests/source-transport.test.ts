import { EventEmitter } from "node:events";
import { Readable } from "node:stream";
import { request, type RequestOptions } from "node:https";
import { beforeEach, expect, it, vi } from "vitest";
import { downloadPublic } from "../src/modules/assisted-import/outbound";
vi.mock("node:https", () => ({request: vi.fn()}));
let options: RequestOptions, origin: URL;
let headers: Record<string, string>, chunks: Buffer[];
beforeEach(() => {
  headers = {"content-type": "text/html"}; chunks = [Buffer.from("<h1>Fixture</h1>")];
  vi.mocked(request).mockImplementation(((url: URL, opts: RequestOptions, callback: (stream: Readable) => void) => {
    origin = url; options = opts;
    const req = new EventEmitter() as EventEmitter & {end: () => void};
    req.end = () => queueMicrotask(() => {
      const stream = Object.assign(Readable.from(chunks), {statusCode: 200, headers});
      callback(stream);
    });
    return req;
  }) as unknown as typeof request);
});
const resolve = async () => [{address: "93.184.216.34", family: 4}];
it("pins the actual HTTPS lookup, retains the TLS hostname, disables pooling and sends no credentials", async () => {
  await downloadPublic("https://merch.example.com/product", "html", {resolve});
  expect(origin.hostname).toBe("merch.example.com");
  expect(options.agent).toBe(false); expect(options.family).toBe(4);
  expect(options.rejectUnauthorized).not.toBe(false);
  expect(options.headers).toMatchObject({"Accept-Encoding": "identity"});
  expect(options.headers).not.toHaveProperty("Cookie"); expect(options.headers).not.toHaveProperty("Authorization");
  const callback = vi.fn();
  options.lookup!("merch.example.com", {}, callback);
  expect(callback).toHaveBeenCalledWith(null, "93.184.216.34", 4);
});
it("rejects excessive Content-Length and unrequested compressed responses before reading", async () => {
  headers["content-length"] = String(3 * 1024 * 1024);
  await expect(downloadPublic("https://example.com", "html", {resolve})).rejects.toThrow(/download limit/);
  headers = {"content-type": "text/html", "content-encoding": "gzip"};
  await expect(downloadPublic("https://example.com", "html", {resolve})).rejects.toThrow(/compression/);
});
it("enforces streamed-byte limits when no Content-Length was declared", async () => {
  chunks = [Buffer.alloc(1024 * 1024), Buffer.alloc(1024 * 1024), Buffer.alloc(1)];
  await expect(downloadPublic("https://example.com", "html", {resolve})).rejects.toThrow(/download limit/);
});
