import { env } from "cloudflare:workers";

export const documentBytes = (document: unknown) =>
  new TextEncoder().encode(JSON.stringify(document)).byteLength;

/** Seed a valid head document with trailing JSON whitespace to reach an exact byte boundary.
 * The schema has no per-recipe byte limit, and D1 stores the original serialized string.
 * These synthetic heads represent existing data; every tested write uses the real claim.
 */
export async function seedRecipeBytes(ownerId: string, bytes: number) {
  const document = JSON.stringify({
    version: 1,
    id: "byte-seed",
    revision: 1,
    origin: "https://seed.example.test",
    entry: { path: "/", target: { by: "text", value: "ログイン" } },
  });
  const padded = document + " ".repeat(bytes - new TextEncoder().encode(document).byteLength);
  await env.DB.batch([
    env.DB.prepare(`INSERT INTO recipe_heads
      (owner_id, recipe_id, revision, state, sequence, write_id, updated_at)
      VALUES (?, 'byte-seed', 1, 'active', 1000000, 'byte-seed', 0)`).bind(ownerId),
    env.DB.prepare(`INSERT INTO recipe_revisions
      (owner_id, recipe_id, revision, state, document, created_at, created_by_device_id)
      VALUES (?, 'byte-seed', 1, 'active', ?, 0, NULL)`).bind(ownerId, padded),
  ]);
}

export async function storedRecipeBytes(ownerId: string) {
  const row =
    await env.DB.prepare(`SELECT COALESCE(SUM(length(CAST(r.document AS BLOB))), 0) AS bytes
    FROM recipe_heads h JOIN recipe_revisions r
      ON r.owner_id = h.owner_id AND r.recipe_id = h.recipe_id AND r.revision = h.revision
    WHERE h.owner_id = ? AND h.state = 'active'`)
      .bind(ownerId)
      .first<{ bytes: number }>();
  return row?.bytes ?? 0;
}
