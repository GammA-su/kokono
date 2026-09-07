"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

export function LoginForm({ accessDenied }: { accessDenied: boolean }) {
  const router = useRouter();
  const [error, setError] = useState(
    accessDenied ? "Your account does not have active internal access." : "",
  );
  const [pending, setPending] = useState(false);
  return (
    <form
      className="form-stack"
      onSubmit={async (event) => {
        event.preventDefault();
        setPending(true);
        setError("");
        const data = new FormData(event.currentTarget);
        try {
          const response = await fetch("/api/auth/sign-in/email", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              email: data.get("email"),
              password: data.get("password"),
            }),
          });
          if (!response.ok) {
            setError(
              "Unable to sign in. Check your email and password and try again.",
            );
            setPending(false);
            return;
          }
          router.replace("/admin/merchandise/lineups");
          router.refresh();
        } catch {
          setError("Connection failed. Please try again.");
          setPending(false);
        }
      }}
    >
      {error && (
        <p className="alert error" role="alert">
          {error}
        </p>
      )}
      <label className="field">
        Email
        <input
          name="email"
          type="email"
          autoComplete="username"
          required
          autoFocus
        />
      </label>
      <label className="field">
        Password
        <input
          name="password"
          type="password"
          autoComplete="current-password"
          required
        />
      </label>
      <button className="button primary" disabled={pending}>
        {pending ? "Signing in…" : "Sign in to workspace"}
      </button>
    </form>
  );
}
