import { LoginForm } from "@/components/admin/login-form";
export const metadata = { title: "Sign in" };
export default async function Login({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const params = await searchParams;
  return (
    <main className="login-screen">
      <section className="login-card">
        <div className="brand">
          <span className="brand-symbol">k</span>kokono
        </div>
        <p className="eyebrow">INTERNAL WORKSPACE</p>
        <h1>Your collection, in order.</h1>
        <p className="muted">
          Sign in to manage merchandise releases and inventory.
        </p>
        <LoginForm accessDenied={params.error === "access"} />
        <p className="login-note">
          Access is limited to authorized internal accounts.
        </p>
      </section>
    </main>
  );
}
