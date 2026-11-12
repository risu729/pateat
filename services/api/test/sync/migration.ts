import type { D1Migration } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { writeRecipe } from "../../src/recipe-store";

import { type Device, enrollOwner, recipe } from "./harness";

export function registerRecipeMigrationTests() {
  describe("migration 0029 (ADR 0060)", () => {
    it("discards old-shape recipes and the rows that named their branches, keeping the logs", async () => {
      const device = await enrollOwner();
      const other = await enrollOwner();
      // A recipe as stored before layouts: one route at the top level, with its revisions,
      // a judged page, a generation attempt and a first-login result naming a bare branch.
      const old = JSON.stringify({
        version: 1,
        id: "gen-old",
        revision: 2,
        origin: "https://bank.example",
        pageKind: "sign-in",
        slots: ["username"],
        steps: [
          {
            kind: "fill",
            path: "/login",
            fields: [{ slot: "username", target: { by: "id", value: "user" } }],
          },
        ],
        maxSubmissions: 1,
      });
      const seed = (by: Device) => [
        env.DB.prepare(
          "INSERT INTO recipe_heads (owner_id, recipe_id, revision, state, sequence, write_id, updated_at, last_used_at) VALUES (?, 'gen-old', 2, 'active', 1, ?, 0, 0)",
        ).bind(by.ownerId, `write-${crypto.randomUUID()}`),
        env.DB.prepare(
          "INSERT INTO recipe_revisions (owner_id, recipe_id, revision, state, document, created_at, created_by_device_id) VALUES (?, 'gen-old', 1, 'active', ?, 0, ?), (?, 'gen-old', 2, 'active', ?, 0, ?)",
        ).bind(by.ownerId, old, by.deviceId, by.ownerId, old, by.deviceId),
        env.DB.prepare(
          "INSERT INTO page_judgements (owner_id, recipe_id, branch, revision, origin, path, prompt_version, judged_at, verdict) VALUES (?, 'gen-old', 'account', 2, 'https://bank.example', '/home', 'v', 0, 'signed-in')",
        ).bind(by.ownerId),
        env.DB.prepare(
          "INSERT INTO generation_attempts (owner_id, recipe_id, branch, origin, path, base_revision, attempted_at) VALUES (?, 'gen-old', 'other', 'https://bank.example', '/password', 1, 0)",
        ).bind(by.ownerId),
        env.DB.prepare(
          "INSERT INTO login_outcomes (owner_id, recipe_id, branch, revision, outcome, cause, step, created_at) VALUES (?, 'gen-old', 'account', 2, 'unknown-submit', 'settled', 1, 0)",
        ).bind(by.ownerId),
        env.DB.prepare(
          "INSERT INTO login_timings (id, owner_id, recipe_id, branch, revision, origin, outcome, extension_build, total_ms, service_ms, network_ms, person_ms, page_ms, created_at) VALUES (?, ?, 'gen-old', '', 2, 'https://bank.example', 'authenticated', 'development', 4000, 0, 0, 0, 0, 0)",
        ).bind(`login-${crypto.randomUUID()}`, by.ownerId),
        env.DB.prepare(
          "INSERT INTO inference_log (id, owner_id, role, provider, model_id, origin, path, request, outcome, recipe_id, cost_micro_usd, created_at) VALUES (?, ?, 'generate', 'anthropic', 'm', 'https://bank.example', '/login', '{}', 'ok', 'gen-old', 0, 0)",
        ).bind(`log-${crypto.randomUUID()}`, by.ownerId),
      ];
      await env.DB.batch([...seed(device), ...seed(other)]);
      const migration = (env as unknown as { TEST_MIGRATIONS: D1Migration[] }).TEST_MIGRATIONS.find(
        ({ name }) => name.startsWith("0029_recipe_layouts"),
      );
      // The committed deletions in their order, without comments, scoped to this owner so
      // they leave other tests' rows alone.
      const deletions = (migration?.queries ?? [])
        .map((query) => query.replaceAll(/^--.*$/gm, "").trim())
        .filter((query) => query.startsWith("DELETE"));
      const tables = ["login_outcomes", "page_judgements", "generation_attempts"];
      expect(deletions.map((query) => /^DELETE FROM `(\w+)`/.exec(query)?.[1])).toEqual(
        expect.arrayContaining(["recipe_revisions", "recipe_heads", ...tables]),
      );
      // Revisions refer to their head, so they go first.
      expect(deletions.findIndex((query) => query.includes("`recipe_revisions`"))).toBeLessThan(
        deletions.findIndex((query) => query.includes("`recipe_heads`")),
      );
      await env.DB.batch(
        deletions.map((query) =>
          env.DB.prepare(`${query.replace(/;$/, "")} WHERE owner_id = ?`).bind(device.ownerId),
        ),
      );
      const count = async (table: string, ownerId: string) =>
        (
          await env.DB.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE owner_id = ?`)
            .bind(ownerId)
            .first<{ n: number }>()
        )?.n;
      for (const table of ["recipe_heads", "recipe_revisions", ...tables]) {
        // oxlint-disable-next-line no-await-in-loop -- one count per table
        expect(await count(table, device.ownerId)).toBe(0);
        // oxlint-disable-next-line no-await-in-loop -- one count per table
        expect(await count(table, other.ownerId)).toBeGreaterThan(0);
      }
      // The request log and login records stay.
      expect(await count("login_timings", device.ownerId)).toBe(1);
      expect(await count("inference_log", device.ownerId)).toBe(1);
      // The owner's recipes start again from the first sequence number and revision.
      const written = await writeRecipe(
        env.DB,
        device.ownerId,
        "gen-old",
        { version: 1, expectedRevision: 0, state: "active", recipe: recipe("gen-old", 1) },
        device.deviceId,
      );
      expect(written).toMatchObject({ ok: true, change: { revision: 1 } });
    });
  });
}
