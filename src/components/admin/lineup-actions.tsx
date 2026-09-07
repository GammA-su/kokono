"use client";

import { useRef } from "react";
import {
  deleteLineupForm,
  duplicateLineupForm,
  restoreLineupForm,
} from "@/modules/lineups/actions";
import { ActionForm } from "./action-form";

export function LineupActions({
  id,
  name,
  hasItems,
  archived,
}: {
  id: string;
  name: string;
  hasItems: boolean;
  archived: boolean;
}) {
  const deleteDialog = useRef<HTMLDialogElement>(null);
  const duplicateDialog = useRef<HTMLDialogElement>(null);
  return (
    <>
      <button
        type="button"
        className="button"
        onClick={() => duplicateDialog.current?.showModal()}
      >
        Duplicate lineup
      </button>
      <button
        type="button"
        className="text-button"
        onClick={() => deleteDialog.current?.showModal()}
      >
        Delete lineup
      </button>
      {archived && (
        <ActionForm
          action={restoreLineupForm}
          submitLabel="Restore lineup"
          className="inline-action"
        >
          <input type="hidden" name="id" value={id} />
          <span className="small-copy muted">
            Restoring also restores visibility of previously published items.
          </span>
        </ActionForm>
      )}
      <dialog
        ref={duplicateDialog}
        className="dialog"
        aria-labelledby="duplicate-lineup-title"
      >
        <div className="dialog-body">
          <div className="dialog-title">
            <h2 id="duplicate-lineup-title">Duplicate lineup</h2>
            <button
              type="button"
              className="text-button"
              aria-label="Close duplicate dialog"
              onClick={() => duplicateDialog.current?.close()}
            >
              Close
            </button>
          </div>
          <p>
            Copy the lineup details and source links, then edit the new release.
            Merchandise items, stock, watches, and listings are not copied.
            Source checks are reset.
          </p>
          <ActionForm action={duplicateLineupForm} submitLabel="Create copy">
            <input type="hidden" name="id" value={id} />
          </ActionForm>
        </div>
      </dialog>
      <dialog
        ref={deleteDialog}
        className="dialog"
        aria-labelledby="delete-lineup-title"
      >
        <div className="dialog-body">
          <div className="dialog-title">
            <h2 id="delete-lineup-title">Delete lineup?</h2>
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
            {hasItems
              ? "This lineup contains merchandise. It will be archived and hidden publicly; all merchandise, stock, and history will be retained."
              : "This empty lineup and its source links will be permanently deleted."}
          </p>
          <ActionForm
            action={deleteLineupForm}
            submitLabel={hasItems ? "Archive lineup" : "Delete lineup"}
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
