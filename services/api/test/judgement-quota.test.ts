import {
  JUDGEMENT_RESERVATION_MS,
  type JudgementKey,
  type JudgementReservation,
  type PageJudgementVerdict,
} from "@pateat/generation";
import { utcDayStart } from "@pateat/generation";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { d1Backend } from "../src/recipes/backend";

const NOW = Date.UTC(2026, 10, 12, 12);
const key: JudgementKey = {
  recipeId: "gen_synthetic",
  branch: "1000",
  revision: 2,
  origin: "https://shop.example.test",
  path: "/home",
  promptVersion: "current",
};
const stale = { expired: utcDayStart(NOW), versions: [key.promptVersion] };
const operation = (startedAt = NOW): JudgementReservation => ({
  id: crypto.randomUUID(),
  startedAt,
  fingerprint: "synthetic-request-fingerprint",
});
async function setup() {
  const ownerId = crypto.randomUUID();
  const deviceId = crypto.randomUUID();
  await env.DB.prepare("INSERT INTO owners (id, created_at) VALUES (?, ?)")
    .bind(ownerId, NOW)
    .run();
  const backend = (device = deviceId) =>
    d1Backend(env, { ownerId, deviceId: device, profileId: ownerId }, { startedAt: NOW });
  const count = async (recipeId = key.recipeId, at = NOW) =>
    (await env.DB.prepare(
      "SELECT count(*) AS n FROM judgement_reservations WHERE owner_id = ? AND recipe_id = ? AND day = ? AND state != 'cancelled'",
    )
      .bind(ownerId, recipeId, utcDayStart(at))
      .first<{ n: number }>())!.n;
  return {
    ownerId,
    backend: backend(),
    anotherDevice: backend(),
    otherDevice: backend("other-device"),
    count,
  };
}

describe("atomic daily judgement reservations in real local D1", () => {
  it("admits exactly twenty concurrent pages and never claims the rejected pages", async () => {
    const { ownerId, backend, count } = await setup();
    const attempts = await Promise.all(
      Array.from({ length: 40 }, async (_, index) => {
        const page = { ...key, path: `/page-${index}` };
        const result = await backend.reserveJudgement(page, NOW, stale, "a", operation());
        return { page, result };
      }),
    );
    expect(attempts.filter(({ result }) => result.status === "taken")).toHaveLength(20);
    expect(attempts.filter(({ result }) => result.status === "limited")).toHaveLength(20);
    expect(await count()).toBe(20);
    expect(
      (await env.DB.prepare("SELECT * FROM page_judgements WHERE owner_id = ?").bind(ownerId).all())
        .results,
    ).toHaveLength(20);
    await Promise.all(
      attempts
        .filter(({ result }) => result.status === "limited")
        .map(async ({ page }) => {
          expect(await backend.judgement(page)).toBeUndefined();
        }),
    );
  });

  it("charges only the winner when concurrent requests claim the same page", async () => {
    const { backend, anotherDevice, count } = await setup();
    const results = await Promise.all(
      Array.from({ length: 12 }, (_, index) =>
        (index % 2 ? backend : anotherDevice).reserveJudgement(key, NOW, stale, "a", operation()),
      ),
    );
    expect(results.filter((result) => result.status === "taken")).toHaveLength(1);
    expect(results.filter((result) => result.status === "held")).toHaveLength(11);
    expect(await count()).toBe(1);
  });

  it.each<PageJudgementVerdict>(["optional", "partial", "challenge", "unclear"])(
    "charges all twenty overwrites of one %s page and preserves its answer at the cap",
    async (verdict) => {
      const { backend, count } = await setup();
      /* oxlint-disable no-await-in-loop -- Every overwrite depends on the previous settled claim. */
      for (let index = 0; index < 20; index++) {
        const claim = operation();
        expect(
          (await backend.reserveJudgement(key, NOW, stale, `input-${index}`, claim)).status,
        ).toBe("taken");
        await backend.keepVerdict(key, verdict, claim.id);
        await backend.finishJudgement(key, claim);
      }
      /* oxlint-enable no-await-in-loop */
      expect(await count()).toBe(20);
      expect(
        (await backend.reserveJudgement(key, NOW, stale, "next-input", operation())).status,
      ).toBe("limited");
      expect(await backend.judgement(key)).toEqual({ verdict, inputs: "input-19" });
      expect(await count()).toBe(20);
    },
  );

  it("binds verdict writes and cancellation to the exact page claim", async () => {
    const { backend, otherDevice, count } = await setup();
    const first = operation();
    expect((await backend.reserveJudgement(key, NOW, stale, "a", first)).status).toBe("taken");
    await backend.keepVerdict(key, "optional", first.id);
    await backend.finishJudgement(key, first);
    const second = operation();
    expect((await backend.reserveJudgement(key, NOW, stale, "b", second)).status).toBe("taken");
    await backend.keepVerdict(key, "signed-in", first.id);
    await backend.finishJudgement(key, first);
    expect(await backend.cancelJudgement(key, first)).toBe(false);
    expect(await otherDevice.cancelJudgement(key, second)).toBe(false);
    expect(await backend.cancelJudgement({ ...key, path: "/other" }, second)).toBe(false);
    expect(await backend.judgement(key)).toEqual({ verdict: null, inputs: "b" });
    expect(await backend.cancelJudgement(key, second)).toBe(true);
    expect(await backend.judgement(key)).toEqual({ verdict: "optional", inputs: "a" });
    expect(await count()).toBe(1);
    await backend.keepVerdict(key, "rejected", second.id);
    expect(await backend.judgement(key)).toEqual({ verdict: "optional", inputs: "a" });
  });

  it("refunds a never-issued call but retains a dispatched call when restoring its previous answer", async () => {
    const { backend, count } = await setup();
    const first = operation();
    await backend.reserveJudgement(key, NOW, stale, "a", first);
    expect(await backend.cancelJudgement(key, first)).toBe(true);
    expect(await count()).toBe(0);
    expect(await backend.judgement(key)).toBeUndefined();
    const prior = operation();
    await backend.reserveJudgement(key, NOW, stale, "a", prior);
    await backend.keepVerdict(key, "partial", prior.id);
    await backend.finishJudgement(key, prior);
    const sent = operation();
    await backend.reserveJudgement(key, NOW, stale, "b", sent);
    expect(await backend.dispatchJudgement(key, sent, { index: 0, hash: "body-hash" })).toBe(true);
    expect(await backend.cancelJudgement(key, sent)).toBe(true);
    expect(await backend.judgement(key)).toEqual({ verdict: "partial", inputs: "a" });
    expect(await count()).toBe(2);
    expect((await backend.reserveJudgement(key, NOW, stale, "b", sent)).status).toBe("held");
    expect(await count()).toBe(2);
  });

  it("binds relay resumption to owner, device, exact key, fingerprint and unexpired start", async () => {
    const { backend, otherDevice, count } = await setup();
    const foreign = await setup();
    const claim = operation();
    await backend.reserveJudgement(key, NOW, stale, "a", claim);
    expect((await backend.judgementReservation(key, claim, NOW)).status).toBe("active");
    expect((await otherDevice.judgementReservation(key, claim, NOW)).status).toBe("invalid");
    expect((await foreign.backend.judgementReservation(key, claim, NOW)).status).toBe("missing");
    await Promise.all(
      [
        { ...key, recipeId: "gen_other" },
        { ...key, branch: "2000" },
        { ...key, revision: 3 },
        { ...key, origin: "https://other.example.test" },
        { ...key, path: "/other" },
        { ...key, promptVersion: "other" },
      ].map(async (changed) => {
        expect((await backend.judgementReservation(changed, claim, NOW)).status).toBe("invalid");
      }),
    );
    expect(
      (await backend.judgementReservation(key, { ...claim, fingerprint: "different" }, NOW)).status,
    ).toBe("invalid");
    expect(
      (await backend.judgementReservation(key, { ...claim, startedAt: NOW + 1 }, NOW)).status,
    ).toBe("invalid");
    expect(
      (await backend.judgementReservation(key, claim, NOW + JUDGEMENT_RESERVATION_MS)).status,
    ).toBe("invalid");
    expect(await count()).toBe(1);
  });

  it("consumes each exact outstanding relay response once and shares the slot across fallback", async () => {
    const { backend, count } = await setup();
    const claim = operation();
    await backend.reserveJudgement(key, NOW, stale, "a", claim);
    expect(await backend.dispatchJudgement(key, claim, { index: 0, hash: "first" })).toBe(true);
    expect(await backend.dispatchJudgement(key, claim, { index: 0, hash: "first" })).toBe(false);
    expect(await backend.continueJudgement(key, claim, [], NOW)).toBe(false);
    expect(await backend.continueJudgement(key, claim, ["wrong"], NOW)).toBe(false);
    expect(await backend.continueJudgement(key, claim, ["first"], NOW)).toBe(true);
    expect(await backend.continueJudgement(key, claim, ["first"], NOW)).toBe(false);
    expect(await backend.dispatchJudgement(key, claim, { index: 1, hash: "fallback" })).toBe(true);
    expect(await backend.continueJudgement(key, claim, ["first"], NOW)).toBe(false);
    expect(await backend.continueJudgement(key, claim, ["first", "fallback"], NOW)).toBe(true);
    expect(await count()).toBe(1);
    await backend.finishJudgement(key, claim);
    expect(await backend.dispatchJudgement(key, claim, { index: 2, hash: "fresh" })).toBe(false);
    expect(await backend.continueJudgement(key, claim, ["first", "fallback"], NOW)).toBe(false);
    expect(
      (await backend.reserveJudgement({ ...key, path: "/fresh" }, NOW, stale, "a", claim)).status,
    ).toBe("held");
    expect(await count()).toBe(1);
  });

  it("isolates recipes and owners and opens twenty fresh slots on the next UTC day", async () => {
    const { backend, count } = await setup();
    const at = utcDayStart(NOW) + 86_400_000 - 1;
    const claims = Array.from({ length: 20 }, () => operation(at));
    await Promise.all(
      claims.map((claim, index) =>
        backend.reserveJudgement({ ...key, path: `/p${index}` }, at, stale, "a", claim),
      ),
    );
    expect((await backend.reserveJudgement(key, at, stale, "a", operation(at))).status).toBe(
      "limited",
    );
    expect(
      (
        await backend.reserveJudgement(
          { ...key, recipeId: "gen_other" },
          at,
          stale,
          "a",
          operation(at),
        )
      ).status,
    ).toBe("taken");
    const foreign = await setup();
    expect(
      (await foreign.backend.reserveJudgement(key, at, stale, "a", operation(at))).status,
    ).toBe("taken");
    expect(
      (await backend.reserveJudgement(key, at + 1, stale, "a", operation(at + 1))).status,
    ).toBe("taken");
    await backend.finishJudgement({ ...key, path: "/p0" }, claims[0]!);
    expect(await count()).toBe(20);
    expect(await count(key.recipeId, at + 1)).toBe(1);
  });

  it("rolls back the quota debit when the page claim fails in the D1 transaction", async () => {
    const { ownerId, backend, count } = await setup();
    const trigger = `fail_quota_${ownerId.replaceAll("-", "")}`;
    await env.DB.exec(
      `CREATE TRIGGER ${trigger} BEFORE INSERT ON page_judgements WHEN NEW.owner_id = '${ownerId}' BEGIN SELECT RAISE(ABORT, 'synthetic claim failure'); END`,
    );
    try {
      await expect(backend.reserveJudgement(key, NOW, stale, "a", operation())).rejects.toThrow();
      expect(await count()).toBe(0);
      expect(await backend.judgement(key)).toBeUndefined();
    } finally {
      await env.DB.exec(`DROP TRIGGER ${trigger}`);
    }
    expect((await backend.reserveJudgement(key, NOW, stale, "a", operation())).status).toBe(
      "taken",
    );
  });
});
