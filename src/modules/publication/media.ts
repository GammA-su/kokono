import { loadImage, inspectImage } from "../media/storage";

export const managedImagePattern =
  /^admin-media\/[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}\.(png|jpg|webp)$/;
/** Existing private managed objects only; this never requests a remote URL. */
export async function loadManagedPublicImage(reference: string) {
  if (!managedImagePattern.test(reference)) return null;
  try {
    await inspectImage(reference.slice("admin-media/".length));
    return await loadImage(reference.slice("admin-media/".length));
  } catch {
    return null;
  }
}
export async function isDeliverableImage(reference: string) {
  if (!managedImagePattern.test(reference)) return false;
  try {
    await inspectImage(reference.slice("admin-media/".length));
    return true;
  } catch {
    return false;
  }
}
