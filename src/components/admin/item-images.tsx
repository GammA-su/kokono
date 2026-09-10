"use client";

import { useRef } from "react";
import {
  addItemImageForm,
  deleteItemImageForm,
  setItemImageApprovalForm,
} from "@/modules/catalog/actions";
import { ActionForm, Field } from "./action-form";
import { MediaImage } from "@/components/ui/media-image";

export type ItemImageValue = {
  id: string;
  storageKey: string;
  caption: string | null;
  imageRole: string;
  approvedForPublicUse: boolean;
  sourceProvider: string | null;
  usedByListing: boolean;
};

/**
 * Image management for one catalog item.
 *
 * These are separate forms from the item's metadata form, because an image upload is its own
 * operation and HTML does not allow nested forms — and because an operator adding a photo should
 * not have to re-save unrelated fields to keep it.
 *
 * Approval is explicit and per image: `approvedForPublicUse` is what allows an image onto the
 * storefront, and nothing else in the admin sets it, so it is surfaced directly here.
 */
export function ItemImages({
  itemId,
  images,
}: {
  itemId: string;
  images: ItemImageValue[];
}) {
  const uploadDialog = useRef<HTMLDialogElement>(null);
  return (
    <section className="panel form-section">
      <div className="panel-heading">
        <h2 className="section-title">
          Images <span className="heading-count">{images.length}</span>
        </h2>
        <button
          type="button"
          className="button"
          onClick={() => uploadDialog.current?.showModal()}
        >
          Add image
        </button>
      </div>
      <p className="table-note">
        Only images marked public can appear on the storefront, and a published
        product needs at least one.
      </p>

      <div className="image-strip">
        {images.map((image) => (
          <figure key={image.id}>
            <MediaImage
              reference={image.storageKey}
              alt={image.caption ?? "Item image"}
            />
            <figcaption>
              <span>{image.imageRole.toLowerCase().replaceAll("_", " ")}</span>
              {image.approvedForPublicUse && (
                <span className="badge catalog-live">Public</span>
              )}
              {image.usedByListing && <span className="badge">In listing</span>}
              {image.caption && (
                <span className="muted small-copy">{image.caption}</span>
              )}
              <ActionForm
                action={setItemImageApprovalForm}
                submitLabel={
                  image.approvedForPublicUse ? "Make private" : "Approve public"
                }
                className="inline-action"
              >
                <input type="hidden" name="itemId" value={itemId} />
                <input type="hidden" name="imageId" value={image.id} />
                <input
                  type="hidden"
                  name="approved"
                  value={image.approvedForPublicUse ? "false" : "true"}
                />
              </ActionForm>
              {image.usedByListing ? (
                <span className="muted small-copy">
                  Selected by a store listing — remove it there before deleting.
                </span>
              ) : (
                <ActionForm
                  action={deleteItemImageForm}
                  submitLabel="Delete"
                  className="inline-action"
                  danger
                >
                  <input type="hidden" name="itemId" value={itemId} />
                  <input type="hidden" name="imageId" value={image.id} />
                </ActionForm>
              )}
            </figcaption>
          </figure>
        ))}
        {!images.length && (
          <p className="muted small-copy">
            No images yet. Add one before publishing this item to the store.
          </p>
        )}
      </div>

      <dialog
        ref={uploadDialog}
        className="dialog"
        aria-labelledby="add-item-image-title"
      >
        <div className="dialog-body">
          <div className="dialog-title">
            <h2 id="add-item-image-title">Add image</h2>
            <button
              type="button"
              className="text-button"
              aria-label="Close image dialog"
              onClick={() => uploadDialog.current?.close()}
            >
              Close
            </button>
          </div>
          <ActionForm action={addItemImageForm} submitLabel="Upload image">
            <input type="hidden" name="itemId" value={itemId} />
            <div className="field-grid">
              <Field
                name="file"
                label="Image file"
                hint="PNG, JPEG or WebP, up to 5 MB."
                full
              >
                <input
                  name="file"
                  type="file"
                  accept="image/png,image/jpeg,image/webp"
                  required
                />
              </Field>
              <Field name="imageRole" label="Role">
                <select name="imageRole" defaultValue="PRODUCT">
                  <option value="PRIMARY">Primary</option>
                  <option value="PRODUCT">Product</option>
                  <option value="PACKAGE">Package</option>
                  <option value="PROMOTIONAL">Promotional</option>
                  <option value="CHARACTER_ART">Character art</option>
                  <option value="OTHER">Other</option>
                </select>
              </Field>
              <Field name="caption" label="Caption" full>
                <input name="caption" maxLength={500} />
              </Field>
            </div>
            <label className="field">
              <input type="checkbox" name="approvedForPublicUse" />
              Approve for public use on the storefront
            </label>
          </ActionForm>
        </div>
      </dialog>
    </section>
  );
}
