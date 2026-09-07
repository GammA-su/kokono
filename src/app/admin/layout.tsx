import Link from "next/link";
import { requireAdminPage } from "@/lib/admin";
import { Navigation } from "@/components/admin/navigation";
import { SignOut } from "@/components/admin/sign-out";

export default async function AdminLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  await requireAdminPage();
  return (
    <div className="admin-shell">
      <a href="#main-content" className="skip-link">
        Skip to content
      </a>
      <aside className="sidebar">
        <Link href="/admin/merchandise" className="brand">
          <span className="brand-symbol">k</span>
          <span>
            kokono<span className="brand-caption">COLLECTION MANAGEMENT</span>
          </span>
        </Link>
        <div className="nav-label">Merchandise</div>
        <Navigation />
        <div className="sidebar-footer">
          <span className="internal-dot" /> Internal workspace
          <SignOut />
        </div>
      </aside>
      <div className="workspace">
        <header className="topbar">
          <span>
            Workspace <span className="muted">/</span>{" "}
            <strong>Merchandise</strong>
          </span>
          <span className="workspace-label">Catalog & inventory</span>
        </header>
        <main id="main-content" className="main-content">
          {children}
        </main>
      </div>
    </div>
  );
}
