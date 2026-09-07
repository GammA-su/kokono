"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Icon } from "@/components/ui/icon";

export function SignOut() {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(false);
  return (
    <>
      <button
        className="text-button sign-out"
        disabled={busy}
        onClick={async () => {
          setBusy(true);
          setError(false);
          try {
            const response = await fetch("/api/auth/sign-out", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: "{}",
            });
            if (!response.ok) throw new Error();
            router.replace("/login");
            router.refresh();
          } catch {
            setError(true);
            setBusy(false);
          }
        }}
      >
        <Icon name="logout" />
        {busy ? "Signing out…" : "Sign out"}
      </button>
      {error && <small role="alert">Unable to sign out. Try again.</small>}
    </>
  );
}
