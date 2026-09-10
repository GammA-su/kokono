"use client";

import { useRef } from "react";
import { deleteItemForm, restoreItemForm } from "@/modules/catalog/actions";
import { ActionForm } from "./action-form";

/**
 * Delete and restore controls for one catalog item.
 *
 * An item that has stock, orders, purchases, shipments, listings or gacha history cannot be
 * deleted without orphaning those records, so the server archives it instead. `hasHistory` only
 * decides what this dialog *promises*; the server decides what actually happens, so a stale page
 * cannot cause a delete the data no longer allows.
 */
export function ItemActions({
  id,
  name,
  hasHistory,
  archived,
}: {
  id: string;
  name: string;
  hasHistory: boolean;
  archived: boolean;
}) {
  const deleteDialog = useRef<HTMLDialogElement>(null);
  return (
    <>
      <button
        type="button"
        className="text-button"
        onClick={() => deleteDialog.current?.showModal()}
      >
        {hasHistory ? "Archive item" : "Delete item"}
      </button>
      {archived && (
        <ActionForm
          action={restoreItemForm}
          submitLabel="Restore item"
          className="inline-action"
        >
          <input type="hidden" name="id" value={id} />
        </ActionForm>
      )}
      <dialog
        ref={deleteDialog}
        className="dialog"
        aria-labelledby="delete-item-title"
      >
        <div className="dialog-body">
          <div className="dialog-title">
            <h2 id="delete-item-title">
              {hasHistory ? "Archive item?" : "Delete item?"}
            </h2>
            <button
              type="button"
              className="text-button"
              aria-label="Close delete dialog"
              onClick={() => deleteDialog.current?.close()}
            >
              Close
            </button>
          </div>
          <p>
            {hasHistory
              ? "This item has stock, orders, purchases, shipments, listings or gacha history. It will be archived and hidden from the storefront; every movement and record is retained and nothing is deleted."
              : "This item has no stock, orders or history. It will be permanently deleted along with its source links, images and purchase watch."}
          </p>
          <ActionForm
            action={deleteItemForm}
            submitLabel={hasHistory ? "Archive item" : "Delete item"}
            danger
          >
            <input type="hidden" name="id" value={id} />
            <label className="field">
              Type “{name}” to confirm
              <input name="confirmedName" required autoComplete="off" />
            </label>
          </ActionForm>
        </div>
      </dialog>
    </>
  );
}
