"use client";
import { useState, useTransition } from "react";
import { prepareMerchandiseBatch } from "@/modules/bulk-management/actions";
import type { BulkReview } from "@/modules/bulk-management/service";
import { BulkReviewDialog } from "./bulk-review-dialog";
export function PublishItemButton({ itemId }: { itemId: string }) {
  const [review, setReview] = useState<BulkReview | null>(null),
    [error, setError] = useState<string>(),
    [pending, startTransition] = useTransition();
  return (
    <>
      <button
        className="button primary"
        disabled={pending}
        onClick={() =>
          startTransition(async () => {
            setError(undefined);
            try {
              const response = await prepareMerchandiseBatch({
                action: "publish",
                filters: { archived: "true" },
                selection: { mode: "explicit", ids: [itemId] },
              });
              if (response.review) setReview(response.review);
              else setError(response.error);
            } catch {
              setError("Could not open publication review. Please retry.");
            }
          })
        }
      >
        {pending ? "Opening review…" : "Publish to Store"}
      </button>
      {error && (
        <p role="alert" className="field-error">
          {error}
        </p>
      )}
      {review && (
        <BulkReviewDialog review={review} onClose={() => setReview(null)} />
      )}
    </>
  );
}
