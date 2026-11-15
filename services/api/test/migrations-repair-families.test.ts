import { applyD1Migrations, type D1Migration } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { expect, it } from "vitest";

// Synthetic rows only. Each test file starts with an empty MIGRATION_DB, and
// `migrations.test.ts` applies every migration to its own, so 0038 is tested here.
const { MIGRATION_DB: db, TEST_MIGRATIONS: migrations } = env as unknown as {
  MIGRATION_DB: D1Database;
  TEST_MIGRATIONS: D1Migration[];
};

it("keeps a repair made before 0038 as a native one, beside an SSO repair of its own", async () => {
  const families = migrations.findIndex((migration) =>
    migration.name.startsWith("0038_recipe_repair_families"),
  );
  expect(families).toBeGreaterThan(0);
  await applyD1Migrations(db, migrations.slice(0, families));
  const owner = "00000000-0000-4000-8000-0000000000a3";
  await db.batch([
    db.prepare("INSERT INTO owners (id, created_at) VALUES (?, 1)").bind(owner),
    db
      .prepare(
        "INSERT INTO recipe_repairs (owner_id, recipe_id, device_id, revision, repaired_at) VALUES (?, 'recipe', 'device', 2, 9)",
      )
      .bind(owner),
  ]);
  await applyD1Migrations(db, migrations.slice(families));
  await db
    .prepare(
      "INSERT INTO recipe_repairs (owner_id, recipe_id, device_id, family, revision, repaired_at) VALUES (?, 'recipe', 'device', 'sso', 3, 10)",
    )
    .bind(owner)
    .run();
  expect(
    (
      await db
        .prepare("SELECT family, revision, repaired_at FROM recipe_repairs ORDER BY family")
        .all()
    ).results,
  ).toEqual([
    { family: "native", revision: 2, repaired_at: 9 },
    { family: "sso", revision: 3, repaired_at: 10 },
  ]);
  expect((await db.prepare("PRAGMA foreign_key_check").all()).results).toEqual([]);
});
