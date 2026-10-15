import type { D1Migration } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";

// Synthetic owners and recipe documents only. The setup applied every migration to an
// empty database; this test seeds rows as an earlier build wrote them, then runs one
// migration's statements again.

const migration = (name: string) => {
  const found = (env as unknown as { TEST_MIGRATIONS: D1Migration[] }).TEST_MIGRATIONS.find(
    (entry) => entry.name.startsWith(name),
  );
  if (!found) throw new Error(`missing migration ${name}`);
  return found;
};

async function owner() {
  const ownerId = `owner-${crypto.randomUUID()}`;
  await env.DB.prepare("INSERT INTO owners (id, created_at) VALUES (?, ?)")
    .bind(ownerId, Date.now())
    .run();
  return ownerId;
}

const fill = { kind: "fill", path: "/login", fields: [{ slot: "password", target: "pw" }] };
const route = (pageKind?: string) => ({
  version: 1,
  id: "r",
  revision: 1,
  origin: "https://bank.example",
  ...(pageKind ? { pageKind } : {}),
  slots: ["password"],
  steps: [fill],
});

describe("0016 discard recipes without page kinds (ADR 0035)", () => {
  it("discards only route recipes and chooser branches stored without a page kind", async () => {
    const ownerId = await owner();
    const other = await owner();
    let sequence = 0;
    const recipe = (at: string, id: string, documents: (object | null)[]) => {
      sequence += 1;
      return [
        env.DB.prepare(
          "INSERT INTO recipe_heads (owner_id, recipe_id, revision, state, sequence, write_id, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
        ).bind(
          at,
          id,
          documents.length,
          documents.at(-1) ? "active" : "revoked",
          sequence,
          crypto.randomUUID(),
          Date.now(),
        ),
        ...documents.map((document, index) =>
          env.DB.prepare(
            "INSERT INTO recipe_revisions (owner_id, recipe_id, revision, state, document, created_at) VALUES (?, ?, ?, ?, ?, ?)",
          ).bind(
            at,
            id,
            index + 1,
            document ? "active" : "revoked",
            document && JSON.stringify(document),
            Date.now(),
          ),
        ),
      ];
    };
    const attempt = (at: string, id: string) =>
      env.DB.prepare(
        "INSERT INTO generation_attempts (owner_id, recipe_id, branch, origin, path, base_revision, attempted_at) VALUES (?, ?, '', 'https://bank.example', '/login', 0, ?)",
      ).bind(at, id, Date.now());
    const judgement = (at: string, id: string) =>
      env.DB.prepare(
        "INSERT INTO page_judgements (owner_id, recipe_id, branch, revision, origin, path, prompt_version, judged_at, verdict) VALUES (?, ?, '', 1, 'https://bank.example', '/home', 'v', ?, 'signed-in')",
      ).bind(at, id, Date.now());
    const chooser = (branch?: object) => ({
      version: 1,
      id: "c",
      revision: 1,
      origin: "https://bank.example",
      chooser: { path: "/accounts", ...(branch ? { afterAccount: branch } : {}) },
    });
    const entry = {
      version: 1,
      id: "e",
      revision: 1,
      origin: "https://bank.example",
      entry: { path: "/", target: { by: "text", value: "Log in" } },
    };
    await env.DB.batch([
      ...recipe(ownerId, "old-route", [route(), route()]),
      ...recipe(ownerId, "old-revoked", [route(), null]),
      ...recipe(ownerId, "old-branch", [chooser(route())]),
      ...recipe(other, "other-old-route", [route()]),
      ...recipe(ownerId, "new-route", [route("confirm")]),
      ...recipe(ownerId, "new-branch", [chooser(route("sign-in"))]),
      ...recipe(ownerId, "bare-chooser", [chooser()]),
      ...recipe(ownerId, "entry", [entry]),
      ...recipe(ownerId, "new-revoked", [route("sign-in"), null]),
      attempt(ownerId, "old-route"),
      attempt(ownerId, "new-route"),
      judgement(ownerId, "old-branch"),
      judgement(ownerId, "new-branch"),
    ]);

    await env.DB.batch(migration("0016_").queries.map((query) => env.DB.prepare(query)));

    const ids = async (table: string) =>
      (
        await env.DB.prepare(
          `SELECT DISTINCT recipe_id FROM ${table} WHERE owner_id IN (?, ?) ORDER BY recipe_id`,
        )
          .bind(ownerId, other)
          .all<{ recipe_id: string }>()
      ).results.map((row) => row.recipe_id);
    const kept = ["bare-chooser", "entry", "new-branch", "new-revoked", "new-route"];
    expect(await ids("recipe_heads")).toEqual(kept);
    expect(await ids("recipe_revisions")).toEqual(kept);
    expect(await ids("generation_attempts")).toEqual(["new-route"]);
    expect(await ids("page_judgements")).toEqual(["new-branch"]);
  });
});
