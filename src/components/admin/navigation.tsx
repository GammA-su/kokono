"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { Icon } from "@/components/ui/icon";

const entries = [
  ["Dashboard", "/admin", "grid"],
  ["Franchises", "/admin/merchandise/franchises", "flag"],
  ["Lineups", "/admin/merchandise/lineups", "layers"],
  ["Catalog", "/admin/merchandise/catalog", "tag"],
  ["Gacha", "/admin/gacha", "layers"],
  ["Gacha fulfillment", "/admin/gacha/rewards", "box"],
  ["Customer orders", "/admin/orders", "box"],
  ["Customers", "/admin/customers", "flag"],
  ["Store publication", "/admin/publication", "tag"],
  ["Watchlist", "/admin/watchlist", "flag"],
  ["Marketplace candidates", "/admin/marketplace-listings", "tag"],
  ["Purchases", "/admin/purchases", "tag"],
  ["Shipments", "/admin/shipments", "box"],
  ["Inventory", "/admin/inventory", "box"],
  ["Storage locations", "/admin/inventory/locations", "layers"],
] as const;
export function Navigation() {
  const pathname = usePathname();
  return (
    <nav aria-label="Merchandise navigation">
      {entries.map(([label, href, icon]) => {
        const active =
          label === "Dashboard"
            ? pathname === href
            : label === "Inventory"
              ? pathname.startsWith(href) &&
                !pathname.startsWith(`${href}/locations`)
              : label === "Gacha"
                ? pathname.startsWith(href) &&
                  !pathname.startsWith("/admin/gacha/rewards")
                : pathname.startsWith(href);
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
