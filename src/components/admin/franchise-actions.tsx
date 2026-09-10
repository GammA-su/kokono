"use client";

import { useRef } from "react";
import {
  deleteFranchiseForm,
  restoreFranchiseForm,
  updateFranchiseForm,
} from "@/modules/admin/actions";
import { ActionForm, Field } from "./action-form";

/**
 * Edit, archive/delete and restore for one franchise, shown inline in the franchise list.
 *
 * A franchise with lineups or characters cannot be deleted without orphaning them, so the
 * server archives it instead — and archiving hides all of its merchandise from the storefront,
 * which the confirmation states explicitly. `hasDependents` only decides what this dialog
 * promises; the server re-checks and decides what actually happens.
 */
export function FranchiseActions({
  franchise,
  hasDependents,
}: {
  franchise: {
    id: string;
    name: string;
    japaneseName: string | null;
    description: string | null;
    updatedAt: string;
    archived: boolean;
  };
  hasDependents: boolean;
}) {
  const editDialog = useRef<HTMLDialogElement>(null);
  const deleteDialog = useRef<HTMLDialogElement>(null);
  const titleId = `franchise-${franchise.id}`;
  return (
    <>
      <button
        type="button"
        className="source-link"
        onClick={() => editDialog.current?.showModal()}
      >
        Edit
      </button>
      {" · "}
      <button
        type="button"
        className="source-link"
        onClick={() => deleteDialog.current?.showModal()}
      >
        {hasDependents ? "Archive" : "Delete"}
      </button>
      {franchise.archived && (
        <ActionForm
          action={restoreFranchiseForm}
          submitLabel="Restore"
          className="inline-action"
        >
          <input type="hidden" name="id" value={franchise.id} />
        </ActionForm>
      )}

      <dialog
        ref={editDialog}
        className="dialog"
        aria-labelledby={`${titleId}-edit`}
      >
        <div className="dialog-body">
          <div className="dialog-title">
            <h2 id={`${titleId}-edit`}>Edit franchise</h2>
            <button
              type="button"
              className="text-button"
              aria-label="Close edit dialog"
              onClick={() => editDialog.current?.close()}
            >
              Close
            </button>
          </div>
          <ActionForm action={updateFranchiseForm} submitLabel="Save franchise">
            <input type="hidden" name="id" value={franchise.id} />
            {/* Refuses the save if the row changed after this page was rendered. */}
            <input
              type="hidden"
              name="updatedAt"
              value={franchise.updatedAt}
            />
            <div className="field-grid">
              <Field name="name" label="Franchise name">
                <input
                  name="name"
                  required
                  maxLength={500}
                  defaultValue={franchise.name}
                />
              </Field>
              <Field name="japaneseName" label="Japanese name">
                <input
                  name="japaneseName"
                  lang="ja"
                  defaultValue={franchise.japaneseName ?? ""}
                />
              </Field>
              <Field name="description" label="Description" full>
                <textarea
                  name="description"
                  defaultValue={franchise.description ?? ""}
                />
              </Field>
            </div>
          </ActionForm>
        </div>
      </dialog>

      <dialog
        ref={deleteDialog}
        className="dialog"
        aria-labelledby={`${titleId}-delete`}
      >
        <div className="dialog-body">
          <div className="dialog-title">
            <h2 id={`${titleId}-delete`}>
              {hasDependents ? "Archive franchise?" : "Delete franchise?"}
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
            {hasDependents
              ? "This franchise still has lineups or characters. It will be archived, which also hides all of its merchandise from the storefront. Nothing is deleted and stock is retained."
              : "This franchise has no lineups or characters and will be permanently deleted."}
          </p>
          <ActionForm
            action={deleteFranchiseForm}
            submitLabel={hasDependents ? "Archive franchise" : "Delete franchise"}
            danger
          >
            <input type="hidden" name="id" value={franchise.id} />
            <label className="field">
              Type “{franchise.name}” to confirm
              <input name="confirmedName" required autoComplete="off" />
            </label>
          </ActionForm>
        </div>
      </dialog>
    </>
  );
}
