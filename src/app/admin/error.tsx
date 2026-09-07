"use client";
export default function AdminError({ reset }: { reset: () => void }) {
  return (
    <section className="panel empty-state" role="alert">
      <h1>Unable to load this page</h1>
      <p>Your changes may not have completed. Try loading the page again.</p>
      <button className="button" onClick={reset}>
        Try again
      </button>
    </section>
  );
}
