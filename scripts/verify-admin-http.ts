import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createDatabaseClient } from "../src/db/client";
import { provisionInternalUser } from "../src/modules/auth/provision";

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
    "/admin/merchandise",
    "/admin/merchandise/franchises",
    "/admin/merchandise/catalog",
    "/admin/merchandise/inventory",
    "/admin/merchandise/lineups",
    "/admin/merchandise/lineups?sort=oldest&year=2026",
    "/admin/merchandise/lineups/new",
    `/admin/merchandise/lineups/${lineup.id}`,
    `/admin/merchandise/lineups/${lineup.id}/edit`,
    `/admin/merchandise/lineups/${lineup.id}/items/new`,
    ...(existing
      ? [
          `/admin/merchandise/lineups/${existing.lineupId}`,
          `/admin/merchandise/lineups/${existing.lineupId}/items/${existing.id}/sources`,
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
  const anonymous = await fetch(new URL("/admin/merchandise/lineups", base));
  assert.ok(
    anonymous.url.endsWith("/login") ||
      (await anonymous.text()).includes("/login"),
    "Anonymous access was not redirected",
  );
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
