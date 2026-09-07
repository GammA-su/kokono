import { randomUUID } from "node:crypto";
import { mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import { resolve, sep } from "node:path";
import { DomainError } from "../shared/errors";

export const MAX_IMAGE_SIZE = 5 * 1024 * 1024;
const mediaKey =
  /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}\.(png|jpg|webp)$/;
export function detectImage(bytes: Uint8Array) {
  if (
    bytes.length >= 8 &&
    Buffer.from(bytes.subarray(0, 8)).equals(
      Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    )
  )
    return { extension: "png", mime: "image/png" };
  if (
    bytes.length >= 3 &&
    bytes[0] === 255 &&
    bytes[1] === 216 &&
    bytes[2] === 255
  )
    return { extension: "jpg", mime: "image/jpeg" };
  if (
    bytes.length >= 12 &&
    Buffer.from(bytes.subarray(0, 4)).toString() === "RIFF" &&
    Buffer.from(bytes.subarray(8, 12)).toString() === "WEBP"
  )
    return { extension: "webp", mime: "image/webp" };
  throw new DomainError("INVALID_IMAGE", "Choose a PNG, JPEG, or WebP image.");
}
function mediaPath(key: string) {
  if (!mediaKey.test(key))
    throw new DomainError("INVALID_IMAGE", "Invalid image reference.");
  // Uploads live on a runtime volume; they must not be traced into the server bundle.
  const root = resolve(
    /* turbopackIgnore: true */ process.env.MERCHANDISE_UPLOAD_DIR || ".local/uploads",
  );
  const path = resolve(root, key);
  if (!path.startsWith(root + sep))
    throw new DomainError("INVALID_IMAGE", "Invalid image reference.");
  return { root, path };
}
export async function saveImage(file: File) {
  if (file.size > MAX_IMAGE_SIZE)
    throw new DomainError("IMAGE_TOO_LARGE", "Images must be 5 MB or smaller.");
  const bytes = new Uint8Array(await file.arrayBuffer());
  const { extension } = detectImage(bytes);
  const key = `${randomUUID()}.${extension}`;
  const { root, path } = mediaPath(key);
  await mkdir(root, { recursive: true });
  await writeFile(path, bytes, { flag: "wx" });
  return `admin-media/${key}`;
}
export async function discardNewImage(reference: string) {
  const { path } = mediaPath(reference.replace(/^admin-media\//, ""));
  await unlink(path);
}
export async function loadImage(key: string) {
  const { path } = mediaPath(key);
  const bytes = await readFile(/* turbopackIgnore: true */ path);
  return { bytes, mime: detectImage(bytes).mime };
}
