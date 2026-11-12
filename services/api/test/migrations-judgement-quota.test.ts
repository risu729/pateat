import { applyD1Migrations, type D1Migration } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { expect, it } from "vitest";
import { judgementQuota } from "../src/recipes/judgement-quota";

const { MIGRATION_DB: db, TEST_MIGRATIONS: migrations } = env as unknown as {
  MIGRATION_DB: D1Database;
  TEST_MIGRATIONS: D1Migration[];
};

it("closes every existing owner/recipe ID, including tombstones with no cache history, for only the migration UTC day", async () => {
  const cutover = migrations.findIndex((migration) =>
    migration.name.startsWith("0039_judgement_daily_quota"),
  );
  expect(cutover).toBeGreaterThan(0);
  await applyD1Migrations(db, migrations.slice(0, cutover));
  await db.batch([
    db.prepare("INSERT INTO owners (id, created_at) VALUES ('owner-one', 1), ('owner-two', 1)"),
    db.prepare(`INSERT INTO recipe_heads
      (owner_id, recipe_id, revision, state, sequence, write_id, updated_at)
      VALUES ('owner-one', 'gen-active', 3, 'active', 1, 'a', 1),
        ('owner-one', 'gen-revoked', 5, 'revoked', 2, 'b', 1),
        ('owner-two', 'gen-active', 1, 'active', 1, 'c', 1)`),
    // One overwritten cache answer is evidence of a call, never proof of its true count.
    db.prepare(`INSERT INTO page_judgements
      (owner_id, recipe_id, branch, revision, origin, path, prompt_version, judged_at, verdict)
      VALUES ('owner-one', 'gen-active', '1000', 3, 'https://shop.example.test', '/old', 'old', 1, 'optional')`),
  ]);
  await applyD1Migrations(db, migrations.slice(cutover));
  const rows = (
    await db
      .prepare(
        "SELECT owner_id, recipe_id, day FROM judgement_quota_cutovers ORDER BY owner_id, recipe_id",
      )
      .all<{ owner_id: string; recipe_id: string; day: number }>()
  ).results;
  expect(rows.map(({ owner_id, recipe_id }) => ({ owner_id, recipe_id }))).toEqual([
    { owner_id: "owner-one", recipe_id: "gen-active" },
    { owner_id: "owner-one", recipe_id: "gen-revoked" },
    { owner_id: "owner-two", recipe_id: "gen-active" },
  ]);
  const day = rows[0]!.day;
  expect(day % 86_400_000).toBe(0);
  expect(rows.every((row) => row.day === day)).toBe(true);
  expect((await db.prepare("SELECT * FROM judgement_reservations").all()).results).toEqual([]);
  const quota = judgementQuota(db, "owner-one", "synthetic-device");
  const key = {
    recipeId: "gen-active",
    branch: "1000",
    revision: 3,
    origin: "https://shop.example.test",
    path: "/new",
    promptVersion: "current",
  };
  const reserve = (recipeId: string, at: number) =>
    quota.reserve({ ...key, recipeId }, at, { expired: day, versions: ["current"] }, "a", {
      id: crypto.randomUUID(),
      startedAt: at,
      fingerprint: "synthetic",
    });
  expect((await reserve("gen-active", day + 1)).status).toBe("limited");
  expect((await reserve("gen-revoked", day + 1)).status).toBe("limited");
  expect((await reserve("gen-brand-new", day + 1)).status).toBe("taken");
  expect((await reserve("gen-active", day + 86_400_000)).status).toBe("taken");
  expect((await reserve("gen-revoked", day + 86_400_000)).status).toBe("taken");
  expect((await db.prepare("PRAGMA foreign_key_check").all()).results).toEqual([]);
});
