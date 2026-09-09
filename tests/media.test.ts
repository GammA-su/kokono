import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import sharp from "sharp";
import {
  detectImage,
  discardNewImage,
  loadImage,
  MAX_IMAGE_SIZE,
  saveImage,
  normalizeImage,
} from "../src/modules/media/storage";

let directory: string | undefined;
const original = process.env.MERCHANDISE_UPLOAD_DIR;
afterEach(async () => {
  if (original === undefined) delete process.env.MERCHANDISE_UPLOAD_DIR;
  else process.env.MERCHANDISE_UPLOAD_DIR = original;
  if (directory) {
    if (!directory.startsWith(join(tmpdir(), "kokono-media-test-")))
      throw new Error("Unsafe cleanup target");
    await rm(directory, { recursive: true });
    directory = undefined;
  }
});
describe("private image storage", () => {
  it("rejects SVG/HTML, oversized files and path traversal", async () => {
    expect(() =>
      detectImage(Buffer.from("<svg onload='alert(1)'></svg>")),
    ).toThrow();
    await expect(
      saveImage(new File([new Uint8Array(MAX_IMAGE_SIZE + 1)], "large.png")),
    ).rejects.toMatchObject({ code: "IMAGE_TOO_LARGE" });
    await expect(loadImage("../../.env")).rejects.toThrow();
  });
  it("stores image bytes under a generated key and permits cleanup of only that uploaded file", async () => {
    directory = await mkdtemp(join(tmpdir(), "kokono-media-test-"));
    process.env.MERCHANDISE_UPLOAD_DIR = directory;
    const bytes = Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAYAAABytg0kAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAAEUlEQVQImWNwWPX/PwgzwBgAY44LoVZSKggAAAAASUVORK5CYII=",
      "base64",
    );
    const reference = await saveImage(new File([bytes], "../../arbitrary.png"));
    expect(reference).toMatch(/^admin-media\/[a-f0-9-]+\.png$/);
    const loaded = await loadImage(reference.slice(12));
    expect(loaded.mime).toBe("image/png");
    expect(await sharp(loaded.bytes).raw().toBuffer()).toEqual(await sharp(bytes).raw().toBuffer());
    await discardNewImage(reference);
    await expect(loadImage(reference.slice(12))).rejects.toThrow();
  });
  it("rejects signature-only, truncated and corrupted compressed payloads", async () => {
    const bytes = await sharp({ create: { width: 20, height: 20, channels: 3, background: "red" } }).png().toBuffer();
    for (const invalid of [bytes.subarray(0, 8), bytes.subarray(0, bytes.length - 25), Buffer.concat([bytes.subarray(0, 45), Buffer.alloc(bytes.length - 45)])])
      await expect(normalizeImage(invalid)).rejects.toMatchObject({ code: "INVALID_IMAGE" });
  });
  it("rejects excessive dimensions and pixel budgets even for small compressed inputs", async () => {
    for (const [width, height] of [[8193, 1], [4001, 4000]]) {
      const bytes = await sharp({ create: { width, height, channels: 3, background: "white" } }).png().toBuffer();
      expect(bytes.length).toBeLessThan(MAX_IMAGE_SIZE);
      await expect(normalizeImage(bytes)).rejects.toMatchObject({ code: "INVALID_IMAGE" });
    }
  });
  it("decodes JPEG and WebP and strips metadata intentionally", async () => {
    const jpeg = await sharp({ create: { width: 3, height: 2, channels: 3, background: "red" } }).withMetadata({ orientation: 6 }).jpeg().toBuffer();
    const result = await normalizeImage(jpeg);
    const metadata = await sharp(result.bytes).metadata();
    expect([metadata.width, metadata.height]).toEqual([2, 3]);
    expect(metadata.exif).toBeUndefined();
    expect(metadata.icc).toBeUndefined();
    const webp = await sharp(result.bytes).webp().toBuffer();
    expect((await normalizeImage(webp)).mime).toBe("image/webp");
  });
});
