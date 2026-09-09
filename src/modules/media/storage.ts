import { randomUUID } from "node:crypto";
import { mkdir, open, readFile, unlink, writeFile } from "node:fs/promises";
import { resolve, sep } from "node:path";
import { DomainError } from "../shared/errors";
import sharp from "sharp";

export const MAX_IMAGE_SIZE = 5 * 1024 * 1024;
export const MAX_IMAGE_PIXELS = 16_000_000;
export const MAX_IMAGE_DIMENSION = 8192;
/** Decode every pixel, reject warnings/animation, orient and strip metadata before storage. */
export async function normalizeImage(bytes: Uint8Array) {
  if (bytes.length > MAX_IMAGE_SIZE)
    throw new DomainError("IMAGE_TOO_LARGE", "Images must be 5 MB or smaller.");
  const format = detectImage(bytes);
  try {
    const input = sharp(bytes, { failOn: "warning", limitInputPixels: MAX_IMAGE_PIXELS }).timeout({ seconds: 5 });
    const metadata = await input.metadata();
    if (!metadata.width || !metadata.height || metadata.width > MAX_IMAGE_DIMENSION || metadata.height > MAX_IMAGE_DIMENSION || (metadata.pages ?? 1) !== 1)
      throw new Error("Unsupported dimensions or animation");
    const output = input.rotate(); // EXIF orientation is applied; metadata is stripped by default.
    const normalized = await (format.extension === "png" ? output.png() : format.extension === "jpg" ? output.jpeg({ quality: 90 }) : output.webp({ quality: 90 })).toBuffer();
    if (normalized.length > MAX_IMAGE_SIZE) throw new Error("Normalized image exceeds size limit");
    return { ...format, bytes: normalized };
  } catch {
    throw new DomainError("INVALID_IMAGE", "Choose a complete, uncorrupted static image up to 8192 pixels per side and 16 megapixels.");
  }
}
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
    /* turbopackIgnore: true */ process.env.MERCHANDISE_UPLOAD_DIR ||
      ".local/uploads",
  );
  const path = resolve(root, key);
  if (!path.startsWith(root + sep))
    throw new DomainError("INVALID_IMAGE", "Invalid image reference.");
  return { root, path };
}
export async function saveImage(file: File) {
  if (file.size > MAX_IMAGE_SIZE)
    throw new DomainError("IMAGE_TOO_LARGE", "Images must be 5 MB or smaller.");
  const { bytes, extension } = await normalizeImage(new Uint8Array(await file.arrayBuffer()));
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

/** Revalidate legacy media as well; a signature alone does not establish image integrity. */
export async function inspectImage(key: string) {
  const { path } = mediaPath(key);
  const file = await open(/* turbopackIgnore: true */ path, "r");
  try {
    const stat = await file.stat();
    if (!stat.isFile() || stat.size > MAX_IMAGE_SIZE)
      throw new DomainError("INVALID_IMAGE", "Invalid managed image.");
    const image = await normalizeImage(await file.readFile());
    return { extension: image.extension, mime: image.mime };
  } finally {
    await file.close();
  }
}
