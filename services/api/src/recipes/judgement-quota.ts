import {
  JUDGEMENT_RESERVATION_MS,
  JUDGEMENTS_PER_RECIPE_DAY,
  utcDayStart,
  type JudgementKey,
  type JudgementReservation,
  type JudgementReservationState,
  type JudgementReservationResult,
  type PageJudgementVerdict,
} from "@pateat/generation";

type ReservationRow = {
  device_id: string;
  recipe_id: string;
  branch: string;
  revision: number;
  origin: string;
  path: string;
  prompt_version: string;
  fingerprint: string;
  started_at: number;
  state: "active" | "finished" | "cancelled";
  issued_count: number;
  response_hash: string | null;
  processing: number;
  previous_at: number | null;
  previous_verdict: PageJudgementVerdict | null;
  previous_inputs: string | null;
};
const pageWhere =
  "owner_id = ? AND recipe_id = ? AND branch = ? AND revision = ? AND origin = ? AND path = ? AND prompt_version = ?";
const pageValues = (ownerId: string, key: JudgementKey) => [
  ownerId,
  key.recipeId,
  key.branch,
  key.revision,
  key.origin,
  key.path,
  key.promptVersion,
];
const previous = (row: ReservationRow) =>
  row.previous_at === null
    ? undefined
    : { verdict: row.previous_verdict, inputs: row.previous_inputs };

/** D1 batches are transactions: the quota entry and page claim commit or roll back together. */
export function judgementQuota(db: D1Database, ownerId: string, deviceId: string) {
  async function read(id: string) {
    return db
      .prepare("SELECT * FROM judgement_reservations WHERE owner_id = ? AND id = ?")
      .bind(ownerId, id)
      .first<ReservationRow>();
  }
  const matches = (row: ReservationRow, key: JudgementKey, operation: JudgementReservation) =>
    row.device_id === deviceId &&
    row.recipe_id === key.recipeId &&
    row.branch === key.branch &&
    row.revision === key.revision &&
    row.origin === key.origin &&
    row.path === key.path &&
    row.prompt_version === key.promptVersion &&
    row.fingerprint === operation.fingerprint &&
    row.started_at === operation.startedAt;
  async function state(
    key: JudgementKey,
    operation: JudgementReservation,
    now: number,
  ): Promise<JudgementReservationState> {
    if (operation.startedAt > now || now - operation.startedAt >= JUDGEMENT_RESERVATION_MS)
      return { status: "invalid" };
    const row = await read(operation.id);
    if (!row) return { status: "missing" };
    if (!matches(row, key, operation) || row.state !== "active") return { status: "invalid" };
    const page = await db
      .prepare(`SELECT claim_id FROM page_judgements WHERE ${pageWhere}`)
      .bind(...pageValues(ownerId, key))
      .first<{ claim_id: string | null }>();
    return page?.claim_id === operation.id
      ? { status: "active", previous: previous(row) }
      : { status: "invalid" };
  }
  async function reserve(
    key: JudgementKey,
    now: number,
    stale: { expired: number; versions: readonly string[] },
    inputs: string,
    operation: JudgementReservation,
  ): Promise<JudgementReservationResult> {
    const held = await state(key, operation, now);
    if (held.status === "active") return { status: "resumed", previous: held.previous };
    if (held.status === "invalid") return { status: "held" };
    const day = utcDayStart(now);
    // The LEFT JOIN preserves the old answer for an explicit known-not-sent cancellation.
    // No writer can intervene between this quota insertion and the cache claim in the batch.
    await db.batch([
      db
        .prepare(`
        INSERT INTO judgement_reservations
          (owner_id, id, device_id, recipe_id, branch, revision, origin, path, prompt_version,
           fingerprint, started_at, day, state, previous_at, previous_verdict, previous_inputs)
        SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', p.judged_at, p.verdict, p.inputs
        FROM (SELECT 1) LEFT JOIN page_judgements p ON
          p.owner_id = ? AND p.recipe_id = ? AND p.branch = ? AND p.revision = ?
          AND p.origin = ? AND p.path = ? AND p.prompt_version = ?
        WHERE (p.owner_id IS NULL OR p.verdict IN ('partial', 'optional')
          OR (p.verdict IN ('challenge', 'unclear') AND p.inputs IS NOT ?))
          AND NOT EXISTS (SELECT 1 FROM judgement_quota_cutovers WHERE owner_id = ? AND recipe_id = ? AND day = ?)
          AND (SELECT count(*) FROM judgement_reservations
            WHERE owner_id = ? AND recipe_id = ? AND day = ? AND state != 'cancelled') < ?
        ON CONFLICT (owner_id, id) DO NOTHING
      `)
        .bind(
          ownerId,
          operation.id,
          deviceId,
          key.recipeId,
          key.branch,
          key.revision,
          key.origin,
          key.path,
          key.promptVersion,
          operation.fingerprint,
          operation.startedAt,
          day,
          ...pageValues(ownerId, key),
          inputs,
          ownerId,
          key.recipeId,
          day,
          ownerId,
          key.recipeId,
          day,
          JUDGEMENTS_PER_RECIPE_DAY,
        ),
      db
        .prepare(`
        INSERT INTO page_judgements
          (owner_id, recipe_id, branch, revision, origin, path, prompt_version, judged_at, inputs, claim_id)
        SELECT owner_id, recipe_id, branch, revision, origin, path, prompt_version, ?, ?, id
        FROM judgement_reservations WHERE owner_id = ? AND id = ? AND state = 'active'
          AND device_id = ? AND fingerprint = ? AND started_at = ?
        ON CONFLICT (owner_id, recipe_id, branch, revision, origin, path, prompt_version)
        DO UPDATE SET judged_at = excluded.judged_at, inputs = excluded.inputs,
          verdict = NULL, claim_id = excluded.claim_id
      `)
        .bind(
          now,
          inputs,
          ownerId,
          operation.id,
          deviceId,
          operation.fingerprint,
          operation.startedAt,
        ),
      db
        .prepare(`DELETE FROM page_judgements WHERE owner_id = ? AND recipe_id = ?
        AND (revision < ? OR prompt_version NOT IN (SELECT value FROM json_each(?)))
        AND judged_at < ? AND (claim_id IS NULL OR NOT EXISTS (
          SELECT 1 FROM judgement_reservations r WHERE r.owner_id = page_judgements.owner_id
          AND r.id = page_judgements.claim_id AND r.state = 'active' AND r.started_at > ?))`)
        .bind(
          ownerId,
          key.recipeId,
          key.revision,
          JSON.stringify(stale.versions),
          stale.expired,
          now - JUDGEMENT_RESERVATION_MS,
        ),
      // Keep yesterday too: a bounded relay may finish across midnight. Old identities
      // cannot allocate again because their startedAt is outside the resume window.
      db
        .prepare("DELETE FROM judgement_reservations WHERE owner_id = ? AND day < ?")
        .bind(ownerId, day - 86_400_000),
      db
        .prepare("DELETE FROM judgement_quota_cutovers WHERE owner_id = ? AND day < ?")
        .bind(ownerId, day),
    ]);
    const taken = await state(key, operation, now);
    if (taken.status === "active") return { status: "taken", previous: taken.previous };
    const limited = await db
      .prepare(`SELECT
      EXISTS (SELECT 1 FROM judgement_quota_cutovers WHERE owner_id = ? AND recipe_id = ? AND day = ?)
      OR (SELECT count(*) FROM judgement_reservations WHERE owner_id = ? AND recipe_id = ? AND day = ? AND state != 'cancelled') >= ? AS limited`)
      .bind(ownerId, key.recipeId, day, ownerId, key.recipeId, day, JUDGEMENTS_PER_RECIPE_DAY)
      .first<{ limited: number }>();
    return { status: limited?.limited ? "limited" : "held" };
  }
  async function continueCall(
    key: JudgementKey,
    operation: JudgementReservation,
    responseHashes: readonly string[],
    now: number,
  ) {
    if ((await state(key, operation, now)).status !== "active" || responseHashes.length === 0)
      return false;
    const result = await db
      .prepare(
        "UPDATE judgement_reservations SET processing = 1 WHERE owner_id = ? AND id = ? AND state = 'active' AND processing = 0 AND issued_count = ? AND response_hash = ?",
      )
      .bind(ownerId, operation.id, responseHashes.length, responseHashes.at(-1)!)
      .run();
    return result.meta.changes === 1;
  }
  async function dispatch(
    key: JudgementKey,
    operation: JudgementReservation,
    call: { index: number; hash: string },
  ) {
    const row = await read(operation.id);
    if (!row || !matches(row, key, operation)) return false;
    const result = await db
      .prepare(
        "UPDATE judgement_reservations SET processing = 0, issued_count = ?, response_hash = ? WHERE owner_id = ? AND id = ? AND state = 'active' AND processing = 1 AND issued_count = ?",
      )
      .bind(call.index + 1, call.hash, ownerId, operation.id, call.index)
      .run();
    return result.meta.changes === 1;
  }
  async function finish(key: JudgementKey, operation: JudgementReservation) {
    const row = await read(operation.id);
    if (!row || !matches(row, key, operation)) return;
    await db
      .prepare(
        "UPDATE judgement_reservations SET state = 'finished' WHERE owner_id = ? AND id = ? AND state = 'active'",
      )
      .bind(ownerId, operation.id)
      .run();
  }
  async function cancel(key: JudgementKey, operation: JudgementReservation) {
    const row = await read(operation.id);
    if (!row || !matches(row, key, operation) || row.state !== "active") return false;
    await db.batch([
      db
        .prepare(`DELETE FROM page_judgements WHERE ${pageWhere} AND claim_id = ? AND
        EXISTS (SELECT 1 FROM judgement_reservations WHERE owner_id = ? AND id = ? AND state = 'active' AND previous_at IS NULL)`)
        .bind(...pageValues(ownerId, key), operation.id, ownerId, operation.id),
      db
        .prepare(`UPDATE page_judgements SET judged_at = ?, verdict = ?, inputs = ?, claim_id = NULL
        WHERE ${pageWhere} AND claim_id = ? AND
        EXISTS (SELECT 1 FROM judgement_reservations WHERE owner_id = ? AND id = ? AND state = 'active' AND previous_at IS NOT NULL)`)
        .bind(
          row.previous_at,
          row.previous_verdict,
          row.previous_inputs,
          ...pageValues(ownerId, key),
          operation.id,
          ownerId,
          operation.id,
        ),
      db
        .prepare(
          "UPDATE judgement_reservations SET state = CASE WHEN issued_count = 0 THEN 'cancelled' ELSE 'finished' END WHERE owner_id = ? AND id = ? AND state = 'active'",
        )
        .bind(ownerId, operation.id),
    ]);
    return true;
  }
  return { state, reserve, continueCall, dispatch, finish, cancel };
}
