import { applyD1Migrations, type D1Migration } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { expect, it } from "vitest";

// Synthetic rows only, in a database of their own.
const { MIGRATION_DB: db, TEST_MIGRATIONS: migrations } = env as unknown as {
  MIGRATION_DB: D1Database;
  TEST_MIGRATIONS: D1Migration[];
};

it("rebuilds devices for settings profiles while recipe revisions, problem lines and settings name a device", async () => {
  const profiles = migrations.findIndex((migration) =>
    migration.name.startsWith("0031_settings_profiles"),
  );
  expect(profiles).toBeGreaterThan(0);
  await applyD1Migrations(db, migrations.slice(0, profiles));
  const owner = "00000000-0000-4000-8000-0000000000a1";
  const device = "00000000-0000-4000-8000-0000000000b1";
  await db.batch([
    db.prepare("INSERT INTO owners (id, created_at) VALUES (?, 1)").bind(owner),
    db
      .prepare(
        "INSERT INTO devices (id, owner_id, token_hash, label, created_at) VALUES (?, ?, 'hash', 'Laptop', 1)",
      )
      .bind(device, owner),
    db
      .prepare(
        "INSERT INTO recipe_heads (owner_id, recipe_id, revision, state, sequence, write_id, updated_at) VALUES (?, 'recipe', 1, 'active', 1, 'write', 1)",
      )
      .bind(owner),
    db
      .prepare(
        "INSERT INTO recipe_revisions (owner_id, recipe_id, revision, state, document, created_at, created_by_device_id) VALUES (?, 'recipe', 1, 'active', '{}', 1, ?)",
      )
      .bind(owner, device),
    db
      .prepare(
        "INSERT INTO settings (owner_id, revision, document, updated_at, updated_by_device_id) VALUES (?, 3, '{}', 1, ?)",
      )
      .bind(owner, device),
    db
      .prepare(
        "INSERT INTO problem_log (owner_id, device_id, log_id, seq, extension_build, level, event, fields, logged_at, created_at) VALUES (?, ?, 'log', 0, 'build', 'warn', 'event', '{}', 1, 1)",
      )
      .bind(owner, device),
  ]);
  await applyD1Migrations(db, migrations.slice(profiles));
  expect(await db.prepare("SELECT id, profile_id, label FROM devices").all()).toMatchObject({
    results: [{ id: device, profile_id: owner, label: "Laptop" }],
  });
  expect(await db.prepare("SELECT owner_id, id, name FROM profiles").all()).toMatchObject({
    results: [{ owner_id: owner, id: owner, name: "Default" }],
  });
  expect(await db.prepare("SELECT created_by_device_id FROM recipe_revisions").all()).toMatchObject(
    { results: [{ created_by_device_id: device }] },
  );
  expect(await db.prepare("SELECT device_id FROM problem_log").all()).toMatchObject({
    results: [{ device_id: device }],
  });
  expect((await db.prepare("SELECT COUNT(*) AS n FROM settings").first<{ n: number }>())?.n).toBe(
    0,
  );
  expect((await db.prepare("PRAGMA foreign_key_check").all()).results).toEqual([]);
});
