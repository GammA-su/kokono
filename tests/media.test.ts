import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  detectImage,
  discardNewImage,
  loadImage,
  MAX_IMAGE_SIZE,
  saveImage,
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
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jGmQAAAAASUVORK5CYII=",
      "base64",
    );
    const reference = await saveImage(new File([bytes], "../../arbitrary.png"));
    expect(reference).toMatch(/^admin-media\/[a-f0-9-]+\.png$/);
    const loaded = await loadImage(reference.slice(12));
    expect(loaded.mime).toBe("image/png");
    expect(loaded.bytes).toEqual(bytes);
    await discardNewImage(reference);
    await expect(loadImage(reference.slice(12))).rejects.toThrow();
  });
});
