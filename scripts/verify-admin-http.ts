import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createDatabaseClient } from "../src/db/client";
import { provisionInternalUser } from "../src/modules/auth/provision";
import { parseCatalogCsv } from "../src/modules/catalog-csv/format";

// Opt-in runtime check against the running local app. All created records are temporary.
const base = new URL(process.env.BETTER_AUTH_URL ?? "http://localhost:3000");
const databaseUrl = new URL(process.env.DATABASE_URL ?? "");
if (
  process.env.NODE_ENV === "production" ||
  !["localhost", "127.0.0.1"].includes(base.hostname) ||
  !["localhost", "127.0.0.1"].includes(databaseUrl.hostname) ||
  !databaseUrl.pathname.endsWith("_dev")
) {
  throw new Error(
    "This HTTP check runs only against a loopback app and a local _dev database.",
  );
}
const db = createDatabaseClient(databaseUrl.toString());
let actor: { id: string; email: string } | undefined;
let temporaryFranchise: string | undefined;
let temporaryLineup: string | undefined;
let cookie = "";
try {
  const password = randomUUID() + randomUUID();
  actor = await provisionInternalUser(db, {
    name: "Temporary HTTP verifier",
    email: `http-${randomUUID()}@example.test`,
    password,
  });
  const signIn = await fetch(new URL("/api/auth/sign-in/email", base), {
    method: "POST",
    headers: { "Content-Type": "application/json", Origin: base.origin },
    body: JSON.stringify({ email: actor.email, password }),
  });
  assert.equal(signIn.status, 200, "Sign-in endpoint failed");
  cookie = signIn.headers
    .getSetCookie()
    .map((part) => part.split(";")[0])
    .join("; ");
  assert.ok(cookie.includes("session_token"), "Missing session cookie");
  const franchise = await db.franchise.create({
    data: { name: "Temporary HTTP verification", slug: randomUUID() },
  });
  temporaryFranchise = franchise.id;
  const lineup = await db.lineup.create({
    data: {
      franchiseId: franchise.id,
      name: "Temporary month precision check",
      slug: randomUUID(),
      releaseDate: new Date("2026-11-01T00:00:00Z"),
      releaseDatePrecision: "MONTH",
      sources: {
        create: {
          provider: "Temporary evidence",
          sourceType: "OFFICIAL_STORE",
          url: "https://example.com/verification",
        },
      },
    },
  });
  temporaryLineup = lineup.id;
  const existing = await db.merchandiseItem.findFirst({
    where: {
      archivedAt: null,
      lineup: { archivedAt: null, franchise: { archivedAt: null } },
    },
    select: { id: true, lineupId: true },
  });
  const paths = [
    "/admin",
    "/admin/merchandise/import-source",
    "/admin/merchandise/franchises",
    "/admin/merchandise/catalog",
    "/admin/inventory",
    "/admin/inventory?stock=any&sort=stock&size=48",
    "/admin/inventory/locations",
    "/admin/inventory/locations/new",
    "/admin/inventory/record",
    "/admin/watchlist",
    "/admin/watchlist?below=yes&sort=gap&page=999",
    "/admin/watchlist?country=JP&checked=30&sort=checked",
    "/admin/merchandise/lineups",
    "/admin/merchandise/lineups?sort=oldest&year=2026",
    "/admin/merchandise/lineups/new",
    `/admin/merchandise/lineups/${lineup.id}`,
    `/admin/merchandise/lineups/${lineup.id}/edit`,
    `/admin/merchandise/lineups/${lineup.id}/items/new`,
    `/admin/merchandise/lineups/${lineup.id}/items/bulk`,
    `/admin/merchandise/lineups/${lineup.id}/import`,
    "/admin/merchandise/catalog?stock=fulfillable&sort=stock&size=48",
    "/admin/merchandise/catalog?q=%E3%83%AC%E3%83%A0&watch=enabled",
    ...(existing
      ? [
          `/admin/merchandise/lineups/${existing.lineupId}`,
          `/admin/merchandise/lineups/${existing.lineupId}/items/${existing.id}/sources`,
          `/admin/merchandise/catalog/${existing.id}`,
          `/admin/merchandise/catalog/${existing.id}/movements`,
          `/admin/merchandise/catalog/${existing.id}/movements?type=PURCHASE&from=2026-01-01&to=2026-12-31`,
          `/admin/inventory/record?item=${existing.id}`,
          `/admin/inventory/record?item=${existing.id}&type=TRANSFER`,
          `/admin/inventory/record?item=${existing.id}&type=ADJUSTMENT`,
          `/admin/watchlist/${existing.id}`,
        ]
      : []),
  ];
  for (const path of paths) {
    const response = await fetch(new URL(path, base), {
      headers: { cookie },
      redirect: "manual",
    });
    assert.equal(response.status, 200, `Unexpected status for ${path}`);
    const body = await response.text();
    assert.ok(
      body.includes("Merchandise"),
      `Missing admin rendering for ${path}`,
    );
    assert.ok(!body.includes('"digest":"'), `Server render error for ${path}`);
    if (path === "/admin") {
      for (const label of [
        "Store operations",
        "High-priority sourcing",
        "Low storefront availability",
        "Physical logistics",
        "Estimated landed inventory value",
        "Unavailable",
        "Recent inventory activity",
        "Lineups by year",
      ])
        assert.ok(body.includes(label), `Missing dashboard section: ${label}`);
      assert.ok(
        !response.headers.get("cache-control")?.includes("public"),
        "Dashboard must not be publicly cached",
      );
    }
    if (path === "/admin/merchandise/import-source") {
      assert.ok(body.includes("Extract candidates"));
      assert.ok(body.includes("Existing lineup"));
    }
    if (path === "/admin/watchlist") {
      for (const label of [
        "Purchase watchlist",
        "Still wanted",
        "Last checked age",
        "Highest priority",
        "Largest quantity gap",
        "Physical country stock",
      ])
        assert.ok(body.includes(label), `Missing watchlist control: ${label}`);
    }
    if (path === "/admin/inventory") {
      for (const label of [
        "Quantity by physical location",
        "Latest acquisition unit cost",
        "Estimated value",
        "Fulfillable",
        "SaleListing price",
      ])
        assert.ok(body.includes(label), `Missing inventory column: ${label}`);
    }
    if (path === "/admin/inventory/locations/new") {
      for (const name of [
        "code",
        "name",
        "type",
        "parentId",
        "active",
        "fulfillmentEnabled",
        "notes",
      ])
        assert.ok(
          body.includes(`name="${name}"`),
          `Missing location field: ${name}`,
        );
    }
    if (
      existing &&
      path.startsWith(`/admin/inventory/record?item=${existing.id}`)
    ) {
      for (const name of [
        "merchandiseItemId",
        "operationKey",
        "movementType",
        "quantity",
        "note",
      ])
        assert.ok(
          body.includes(`name="${name}"`),
          `Missing inventory command field: ${name}`,
        );
      if (path.endsWith("type=TRANSFER")) {
        assert.ok(
          body.includes('name="sourceLocationId"') &&
            body.includes('name="destinationLocationId"'),
        );
      }
      if (path.endsWith("type=ADJUSTMENT"))
        assert.ok(body.includes('name="reason"'));
    }
    if (
      path === "/admin/merchandise/catalog" ||
      path === `/admin/merchandise/lineups/${lineup.id}`
    ) {
      assert.ok(
        body.includes("Select all visible"),
        `Missing visible selection for ${path}`,
      );
      assert.ok(
        body.includes("Clear selection"),
        `Missing clear selection for ${path}`,
      );
    }
    if (path === `/admin/merchandise/lineups/${lineup.id}`)
      assert.ok(
        body.includes("Select entire lineup"),
        "Missing entire-lineup selection",
      );
    if (existing && path === `/admin/merchandise/lineups/${existing.lineupId}`)
      assert.ok(
        body.includes('class="item-selection"'),
        "Missing per-item selection checkbox",
      );
    if (existing && path === `/admin/merchandise/catalog/${existing.id}`) {
      for (const panel of ["Catalog", "Sourcing", "Inventory", "Sale"])
        assert.ok(
          body.includes(`>${panel}</h2>`),
          `Item detail panel missing: ${panel}`,
        );
    }
    if (path === `/admin/merchandise/lineups/${lineup.id}/items/bulk`) {
      for (const control of [
        "Add another item",
        "Duplicate previous row",
        "Apply lineup values to all items",
        "Save all",
      ])
        assert.ok(
          body.includes(control),
          `Bulk entry control missing: ${control}`,
        );
      assert.ok(
        body.includes("November 2026"),
        "Bulk entry lost the lineup's release date precision",
      );
    }
    if (path === `/admin/merchandise/lineups/${lineup.id}`) {
      assert.ok(
        body.includes("November 2026"),
        "Month-only date did not render at its original precision",
      );
      assert.ok(
        !body.includes("November 1, 2026") && !body.includes("1 November 2026"),
        "Invented release day in rendered content",
      );
    }
    console.log(`PASS ${path}`);
  }
  const anonymousMedia = await fetch(
    new URL(`/api/admin/media/${randomUUID()}.png`, base),
  );
  assert.equal(anonymousMedia.status, 401);
  const template = await fetch(
    new URL("/api/admin/catalog/csv?template=1", base),
    { headers: { cookie } },
  );
  assert.equal(template.status, 200);
  assert.ok(
    template.headers.get("content-disposition")?.includes("attachment"),
  );
  assert.ok((await template.text()).includes("release_date_precision"));
  const exportAnonymous = await fetch(new URL("/api/admin/catalog/csv", base));
  assert.equal(exportAnonymous.status, 401);
  if (existing) {
    const response = await fetch(
      new URL(
        `/api/admin/catalog/csv?scope=lineup&lineup=${existing.lineupId}&page=999&size=1`,
        base,
      ),
      { headers: { cookie } },
    );
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("cache-control"), "private, no-store");
    const csv = parseCatalogCsv(await response.text());
    const total = await db.merchandiseItem.count({
      where: { lineupId: existing.lineupId },
    });
    assert.equal(
      csv.rows.length,
      total,
      "Lineup CSV must export all items regardless of page size",
    );
    assert.ok(
      !csv.headers.some((header) => /stock|inventory|owned/.test(header)),
    );
    const noStock = await fetch(
      new URL(
        `/api/admin/catalog/csv?lineup=${existing.lineupId}&stock=none`,
        base,
      ),
      { headers: { cookie } },
    );
    assert.equal(noStock.status, 200);
    const expected = await db.merchandiseItem.count({
      where: {
        lineupId: existing.lineupId,
        archivedAt: null,
        inventoryBalances: { none: { quantity: { gt: 0 } } },
      },
    });
    if (expected)
      assert.equal(parseCatalogCsv(await noStock.text()).rows.length, expected);
  }
  console.log(
    "PASS catalog CSV downloads, all-lineup export, filters and anonymous protection",
  );
  const legacy = await fetch(
    new URL("/admin/merchandise/inventory?stock=has", base),
    { headers: { cookie }, redirect: "manual" },
  );
  assert.equal(legacy.status, 307);
  assert.equal(legacy.headers.get("location"), "/admin/inventory?stock=has");
  const location = await db.storageLocation.findFirst({ select: { id: true } });
  if (location) {
    const response = await fetch(
      new URL(`/admin/inventory/locations/${location.id}/edit`, base),
      { headers: { cookie } },
    );
    assert.equal(response.status, 200);
    assert.ok(
      (await response.text()).includes('name="updatedAt"'),
      "Missing location edit conflict token",
    );
  }
  const legacyDashboard = await fetch(new URL("/admin/merchandise", base), {
    headers: { cookie },
    redirect: "manual",
  });
  assert.equal(legacyDashboard.status, 307);
  assert.equal(legacyDashboard.headers.get("location"), "/admin");
  const sourceImage = new URL("/api/admin/source-image?url=https://127.0.0.1/private.png", base);
  assert.equal((await fetch(sourceImage)).status, 401, "Source images require authentication");
  assert.equal((await fetch(sourceImage, {headers: {cookie}})).status, 400, "Image proxy must reject local addresses");
  for (const path of [
    "/admin",
    "/admin/merchandise/import-source",
    "/admin/merchandise/lineups",
    `/admin/merchandise/lineups/${lineup.id}/items/bulk`,
    "/admin/merchandise/catalog?stock=has",
    "/admin/watchlist",
    `/admin/merchandise/lineups/${lineup.id}/import`,
    ...(existing ? [`/admin/watchlist/${existing.id}`] : []),
    "/admin/inventory",
    "/admin/inventory/locations",
    "/admin/inventory/locations/new",
    "/admin/inventory/record",
    ...(existing ? [`/admin/merchandise/catalog/${existing.id}`] : []),
  ]) {
    const anonymous = await fetch(new URL(path, base));
    assert.ok(
      anonymous.url.endsWith("/login") ||
        (await anonymous.text()).includes("/login"),
      `Anonymous access to ${path} was not redirected`,
    );
  }
  console.log("PASS anonymous admin and media protection");
} finally {
  if (cookie)
    await fetch(new URL("/api/auth/sign-out", base), {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Origin: base.origin,
        cookie,
      },
      body: "{}",
    }).catch(() => undefined);
  if (temporaryLineup) {
    await db.lineupSource.deleteMany({ where: { lineupId: temporaryLineup } });
    await db.lineup.delete({ where: { id: temporaryLineup } });
  }
  if (temporaryFranchise)
    await db.franchise.delete({ where: { id: temporaryFranchise } });
  if (actor) await db.user.delete({ where: { id: actor.id } });
  await db.$disconnect();
}
