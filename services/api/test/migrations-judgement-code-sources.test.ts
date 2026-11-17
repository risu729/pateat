import { applyD1Migrations, type D1Migration } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { expect, it } from "vitest";

// Synthetic rows only. Each test file starts with an empty MIGRATION_DB, and
// `migrations.test.ts` applies every migration to its own, so 0041 is tested here.
const { MIGRATION_DB: db, TEST_MIGRATIONS: migrations } = env as unknown as {
  MIGRATION_DB: D1Database;
  TEST_MIGRATIONS: D1Migration[];
};

it("keeps a page judged before 0041 with no code source, beside one of the path's authenticator page", async () => {
  const codeSources = migrations.findIndex((migration) =>
    migration.name.startsWith("0041_page_judgement_code_sources"),
  );
  expect(codeSources).toBeGreaterThan(0);
  await applyD1Migrations(db, migrations.slice(0, codeSources));
  const owner = "00000000-0000-4000-8000-0000000000a4";
  const judged =
    "INSERT INTO page_judgements (owner_id, recipe_id, branch, revision, origin, path, prompt_version, judged_at, verdict, inputs) VALUES (?, 'recipe', '', 2, 'https://example.com', '/signin', 'v1', 9, 'challenge', 'digest')";
  await db.batch([
    db.prepare("INSERT INTO owners (id, created_at) VALUES (?, 1)").bind(owner),
    db.prepare(judged).bind(owner),
  ]);
  await applyD1Migrations(db, migrations.slice(codeSources));
  await db
    .prepare(
      "INSERT INTO page_judgements (owner_id, recipe_id, branch, revision, origin, path, prompt_version, code_source, judged_at, verdict, inputs) VALUES (?, 'recipe', '', 2, 'https://example.com', '/signin', 'v1', 'authenticator', 10, 'challenge', 'digest')",
    )
    .bind(owner)
    .run();
  expect(
    (
      await db
        .prepare(
          "SELECT code_source, judged_at, verdict, inputs FROM page_judgements ORDER BY code_source",
        )
        .all()
    ).results,
  ).toEqual([
    { code_source: "", judged_at: 9, verdict: "challenge", inputs: "digest" },
    { code_source: "authenticator", judged_at: 10, verdict: "challenge", inputs: "digest" },
  ]);
  // The same page of the same code source is still one row.
  await expect(
    db
      .prepare(
        "INSERT INTO page_judgements (owner_id, recipe_id, branch, revision, origin, path, prompt_version, code_source, judged_at) VALUES (?, 'recipe', '', 2, 'https://example.com', '/signin', 'v1', 'authenticator', 11)",
      )
      .bind(owner)
      .run(),
  ).rejects.toThrow(/UNIQUE/u);
  expect((await db.prepare("PRAGMA foreign_key_check").all()).results).toEqual([]);
  expect(
    (await db.prepare("PRAGMA index_list(page_judgements)").all()).results.map(
      (index) => (index as { name: string }).name,
    ),
  ).toContain("page_judgements_day");
});
