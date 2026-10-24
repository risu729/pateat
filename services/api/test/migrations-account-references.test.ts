import { applyD1Migrations, type D1Migration } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { expect, it } from "vitest";
import { readSettings } from "../src/settings-store";

// Synthetic rows only. Each test file starts with an empty MIGRATION_DB, and
// `migrations.test.ts` applies every migration to its own, so 0035 is tested here.
const { MIGRATION_DB: db, TEST_MIGRATIONS: migrations } = env as unknown as {
  MIGRATION_DB: D1Database;
  TEST_MIGRATIONS: D1Migration[];
};

it("removes account references without a server once, so the settings read again", async () => {
  const at = migrations.findIndex((migration) =>
    migration.name.startsWith("0035_old_account_references"),
  );
  expect(at).toBeGreaterThan(0);
  await applyD1Migrations(db, migrations.slice(0, at));
  const owner = "00000000-0000-4000-8000-0000000000a3";
  const device = "00000000-0000-4000-8000-0000000000b3";
  const account = { provider: "bitwarden", userId: "u-1", itemId: "i-1" };
  const named = { ...account, server: "cloud-us" };
  const binding = {
    recipeId: "login",
    origin: "https://shop.example",
    itemName: "Shop",
    slots: [{ slot: "username", field: "username" }],
  };
  const link = {
    origin: "https://shop.example",
    itemId: "i-1",
    detail: "card-code",
    source: { itemId: "i-2", field: "card.code" },
  };
  await db.batch([
    db.prepare("INSERT INTO owners (id, created_at) VALUES (?, 1)").bind(owner),
    db
      .prepare("INSERT INTO profiles (owner_id, id, name, document) VALUES (?, ?, 'Default', ?)")
      .bind(
        owner,
        owner,
        JSON.stringify({
          excludedSites: [{ hostname: "bank.example", includeSubdomains: true }],
          repromptSites: [],
          siteDefaults: [
            { origin: "https://old.example", ...account },
            { origin: "https://new.example", ...named },
          ],
        }),
      ),
    db
      .prepare(
        "INSERT INTO devices (id, owner_id, profile_id, token_hash, created_at, last_used_at) VALUES (?, ?, ?, 'hash', 1, 1)",
      )
      .bind(device, owner, owner),
    db
      .prepare(
        "INSERT INTO settings (owner_id, revision, document, updated_at, updated_by_device_id) VALUES (?, 3, ?, 1, ?)",
      )
      .bind(
        owner,
        JSON.stringify({
          bindings: [
            { ...binding, provider: "bitwarden", userId: "u-1", itemId: "i-1" },
            { ...binding, ...named },
          ],
          detailLinks: [
            { ...link, provider: "bitwarden", userId: "u-1" },
            { ...link, provider: "bitwarden", userId: "u-1", server: "cloud-us" },
          ],
        }),
        device,
      ),
  ]);
  await expect(readSettings(db, owner, owner)).rejects.toThrow();

  await applyD1Migrations(db, migrations.slice(at));
  const state = await readSettings(db, owner, owner);
  expect(state.revision).toBe(3);
  expect(state.settings).toMatchObject({
    excludedSites: [{ hostname: "bank.example", includeSubdomains: true }],
    siteDefaults: [{ origin: "https://new.example", ...named }],
    bindings: [{ ...binding, ...named }],
    detailLinks: [{ ...link, provider: "bitwarden", userId: "u-1", server: "cloud-us" }],
  });
});
