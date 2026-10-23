import { applyD1Migrations, type D1Migration } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { expect, it } from "vitest";

// Synthetic rows only. Each test file starts with an empty MIGRATION_DB, and
// `migrations.test.ts` applies every migration to its own, so 0033 is tested here.
const { MIGRATION_DB: db, TEST_MIGRATIONS: migrations } = env as unknown as {
  MIGRATION_DB: D1Database;
  TEST_MIGRATIONS: D1Migration[];
};

it("keeps a lock held across 0033 as its owner's first call slot", async () => {
  const slots = migrations.findIndex((migration) =>
    migration.name.startsWith("0033_inference_lock_slots"),
  );
  expect(slots).toBeGreaterThan(0);
  await applyD1Migrations(db, migrations.slice(0, slots));
  const owner = "00000000-0000-4000-8000-0000000000a2";
  await db.batch([
    db.prepare("INSERT INTO owners (id, created_at) VALUES (?, 1)").bind(owner),
    db
      .prepare("INSERT INTO inference_locks (owner_id, lock_id, expires_at) VALUES (?, 'held', 9)")
      .bind(owner),
  ]);
  await applyD1Migrations(db, migrations.slice(slots));
  expect(
    (await db.prepare("SELECT owner_id, slot, lock_id, expires_at FROM inference_locks").all())
      .results,
  ).toEqual([{ owner_id: owner, slot: 0, lock_id: "held", expires_at: 9 }]);
  // Further slots of the owner are rows of their own.
  await db
    .prepare(
      "INSERT INTO inference_locks (owner_id, slot, lock_id, expires_at) VALUES (?, 1, 'other', 9)",
    )
    .bind(owner)
    .run();
  expect((await db.prepare("PRAGMA foreign_key_check").all()).results).toEqual([]);
});
