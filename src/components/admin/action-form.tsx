"use client";

import {
  createContext,
  startTransition,
  useActionState,
  useContext,
} from "react";
import Link from "next/link";
import type { FormState } from "@/modules/lineups/action-state";

const FormContext = createContext<FormState>({});
export function ActionForm({
  action,
  children,
  submitLabel,
  cancelHref,
  danger = false,
  className = "",
}: {
  action: (state: FormState, data: FormData) => Promise<FormState>;
  children: React.ReactNode;
  submitLabel: string;
  cancelHref?: string;
  danger?: boolean;
  className?: string;
}) {
  const [state, dispatch, pending] = useActionState(action, {});
  return (
    <FormContext value={state}>
      <form
        className={className}
        onSubmit={(event) => {
          event.preventDefault();
          const data = new FormData(event.currentTarget);
          startTransition(() => dispatch(data));
        }}
        aria-busy={pending}
      >
        {state.error && (
          <div className="alert error" role="alert">
            {state.error}
          </div>
        )}
        <fieldset disabled={pending} className="form-fieldset">
          {children}
          <div className="form-actions">
            {cancelHref && (
              <Link href={cancelHref} className="button">
                Cancel
              </Link>
            )}
            <button
              className={`button ${danger ? "danger" : "primary"}`}
              type="submit"
              disabled={pending}
            >
              {pending ? "Saving…" : submitLabel}
            </button>
          </div>
        </fieldset>
      </form>
    </FormContext>
  );
}
export function Field({
  name,
  label,
  children,
  full = false,
  hint,
}: {
  name: string;
  label: string;
  children: React.ReactNode;
  full?: boolean;
  hint?: string;
}) {
  const errors = useContext(FormContext).fields?.[name];
  return (
    <label
      className={`field ${full ? "full" : ""} ${errors?.length ? "has-error" : ""}`}
    >
      <span>{label}</span>
      {children}
      {hint && <small>{hint}</small>}
      {errors?.map((error, i) => (
        <small className="field-error" role="alert" key={i}>
          {error}
        </small>
      ))}
    </label>
  );
}
export function SourceErrors() {
  const errors = useContext(FormContext).fields?.sources;
  return errors?.length ? (
    <p className="alert error" role="alert">
      {errors.join(" ")}
    </p>
  ) : null;
}
export function FieldErrors({ name }: { name: string }) {
  const errors = useContext(FormContext).fields?.[name];
  return errors?.map((error, index) => (
    <small className="field-error" role="alert" key={index}>
      {error}
    </small>
  ));
}
