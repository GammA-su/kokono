"use client";

import { useState } from "react";
import { Icon } from "./icon";

export function MediaImage({
  reference,
  alt,
  large = false,
}: {
  reference?: string | null;
  alt: string;
  large?: boolean;
}) {
  const [failedReference, setFailedReference] = useState<string | null>(null);
  const src = reference?.startsWith("admin-media/")
    ? `/api/admin/media/${reference.slice(12)}`
    : reference && /^https?:\/\//.test(reference)
      ? reference
      : null;
  return (
    <div className={`media-image ${large ? "large" : ""}`}>
      {src && failedReference !== reference ? (
        // Native images support private same-origin media and user-supplied external references without an image proxy.
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={src}
          alt={alt}
          loading="lazy"
          referrerPolicy="no-referrer"
          onError={() => setFailedReference(reference!)}
        />
      ) : (
        <span role="img" aria-label={`No image for ${alt}`}>
          <Icon name="image" size={large ? 36 : 22} />
        </span>
      )}
    </div>
  );
}
