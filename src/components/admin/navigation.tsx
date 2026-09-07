"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { Icon } from "@/components/ui/icon";

const entries = [
  ["Dashboard", "", "grid"],
  ["Franchises", "/franchises", "flag"],
  ["Lineups", "/lineups", "layers"],
  ["Catalog", "/catalog", "tag"],
  ["Inventory", "/inventory", "box"],
] as const;
export function Navigation() {
  const pathname = usePathname();
  return (
    <nav aria-label="Merchandise navigation">
      {entries.map(([label, suffix, icon]) => {
        const href = `/admin/merchandise${suffix}`;
        const active = suffix ? pathname.startsWith(href) : pathname === href;
        return (
          <Link
            key={label}
            href={href}
            className={`nav-link ${active ? "active" : ""}`}
            aria-current={active ? "page" : undefined}
          >
            <Icon name={icon} />
            {label}
            {active && <span className="nav-mark" />}
          </Link>
        );
      })}
    </nav>
  );
}
