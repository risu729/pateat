import { type JudgementKey, type JudgementReservation } from "@pateat/generation";
import { utcDayStart } from "@pateat/generation";
import { describe, expect, it, vi } from "vitest";
import { createDeviceGenerationBackend, type DeviceGenerationStorage } from "./device-generation";
import { createDeviceModel } from "./device-model";
import { createDeviceRecipes } from "./device-recipes";

const NOW = Date.UTC(2026, 10, 12, 12);
const key: JudgementKey = {
  recipeId: "gen_synthetic",
  branch: "1000",
  revision: 1,
  origin: "https://shop.example.test",
  path: "/home",
  promptVersion: "current",
};
const stale = { expired: utcDayStart(NOW), versions: [key.promptVersion] };
const operation = (startedAt = NOW): JudgementReservation => ({
  id: crypto.randomUUID(),
  startedAt,
  fingerprint: "synthetic",
});
function setup() {
  let stored: unknown;
  let clock = NOW;
  let failWrite = false;
  const storage: DeviceGenerationStorage = {
    read: async () => structuredClone(stored),
    write: async (record) => {
      if (failWrite) throw new Error("synthetic storage full");
      stored = structuredClone(record);
    },
    clear: async () => {
      stored = undefined;
    },
  };
  const recipes = createDeviceRecipes({
    storage: { read: async () => undefined, write: async () => {}, clear: async () => {} },
    transport: { writeRecipe: vi.fn() },
  });
  const model = createDeviceModel({
    storage: { read: async () => undefined, write: async () => {}, clear: async () => {} },
    spend: { read: async () => undefined, write: async () => {} },
    limits: async () => ({ dailyUsd: 5, monthlyUsd: 100 }),
    fetch: vi.fn(async () => {
      throw new Error("A quota test must never call a provider");
    }),
  });
  const restart = () =>
    createDeviceGenerationBackend({
      storage,
      recipes,
      key: model.direct,
      bindings: async () => [],
      paired: async () => false,
      now: () => clock,
    });
  return {
    backend: restart(),
    restart,
    record: () => structuredClone(stored),
    seedRecord: (record: unknown) => {
      stored = structuredClone(record);
    },
    setTime: (at: number) => {
      clock = at;
    },
    failWrites: (fail: boolean) => {
      failWrite = fail;
    },
  };
}

describe("durable daily judgement quota on an unpaired device", () => {
  it("serializes concurrent reservations at exactly twenty", async () => {
    const { backend } = setup();
    const answers = await Promise.all(
      Array.from({ length: 40 }, (_, index) =>
        backend.reserveJudgement({ ...key, path: `/page-${index}` }, NOW, stale, "a", operation()),
      ),
    );
    expect(answers.filter((answer) => answer.status === "taken")).toHaveLength(20);
    expect(answers.filter((answer) => answer.status === "limited")).toHaveLength(20);
  });

  it("retains twenty same-page overwrites across serialization and a backend restart", async () => {
    const { backend, restart } = setup();
    /* oxlint-disable no-await-in-loop -- Each claim is completed before the next synthetic login. */
    for (let index = 0; index < 20; index++) {
      const claim = operation();
      expect((await backend.reserveJudgement(key, NOW, stale, "a", claim)).status).toBe("taken");
      await backend.keepVerdict(key, "optional", claim.id);
      await backend.finishJudgement(key, claim);
    }
    /* oxlint-enable no-await-in-loop */
    const restored = restart();
    expect(await restored.judgement(key)).toEqual({ verdict: "optional", inputs: "a" });
    expect((await restored.reserveJudgement(key, NOW, stale, "a", operation())).status).toBe(
      "limited",
    );
    expect(await restored.judgement(key)).toEqual({ verdict: "optional", inputs: "a" });
  });

  it("keeps a recipe's live quota after more than two thousand other cache entries", async () => {
    const { backend, restart, record, seedRecord } = setup();
    /* oxlint-disable no-await-in-loop -- Each claim is completed before the next synthetic login. */
    for (let index = 0; index < 20; index++) {
      const claim = operation();
      const page = { ...key, path: `/first-${index}` };
      await backend.reserveJudgement(page, NOW, stale, "a", claim);
      await backend.keepVerdict(page, "rejected", claim.id);
      await backend.finishJudgement(page, claim);
    }
    /* oxlint-enable no-await-in-loop */
    // A serialized store from 2,005 other pages. One real mutation must prune the
    // answer cache without applying that cache bound to today's immutable usage.
    const stored = record() as {
      quotas: Record<string, unknown>[];
      judgements: Record<string, unknown>[];
    };
    const others = Array.from({ length: 2_005 }, (_, index) => ({
      recipeId: `gen_other-${index}`,
      id: crypto.randomUUID(),
    }));
    seedRecord({
      ...stored,
      quotas: [...stored.quotas, ...others.map((other) => ({ ...stored.quotas[0]!, ...other }))],
      judgements: [
        ...stored.judgements,
        ...others.map((other) => ({
          ...stored.judgements[0]!,
          recipeId: other.recipeId,
          claimId: other.id,
        })),
      ],
    });
    const restored = restart();
    expect(
      (
        await restored.reserveJudgement(
          { ...key, recipeId: "gen_new" },
          NOW,
          stale,
          "a",
          operation(),
        )
      ).status,
    ).toBe("taken");
    expect(await restored.judgement({ ...key, path: "/first-0" })).toBeUndefined();
    expect(
      (await restored.reserveJudgement({ ...key, path: "/fresh" }, NOW, stale, "a", operation()))
        .status,
    ).toBe("limited");
    expect(
      (
        await restored.reserveJudgement(
          { ...key, recipeId: "gen_another" },
          NOW,
          stale,
          "a",
          operation(),
        )
      ).status,
    ).toBe("taken");
  });

  it("does not reset daily usage when recipes and their cached answers are forgotten", async () => {
    const { backend, restart } = setup();
    await Promise.all(
      Array.from({ length: 20 }, (_, index) =>
        backend.reserveJudgement({ ...key, path: `/page-${index}` }, NOW, stale, "a", operation()),
      ),
    );
    await backend.forget();
    const restored = restart();
    expect(await restored.judgement({ ...key, path: "/page-0" })).toBeUndefined();
    expect((await restored.reserveJudgement(key, NOW, stale, "a", operation())).status).toBe(
      "limited",
    );
  });

  it("restores the exact previous answer on cancellation and prevents stale claim writes", async () => {
    const { backend } = setup();
    const previous = operation();
    await backend.reserveJudgement(key, NOW, stale, "a", previous);
    await backend.keepVerdict(key, "partial", previous.id);
    await backend.finishJudgement(key, previous);
    const current = operation();
    await backend.reserveJudgement(key, NOW, stale, "b", current);
    await backend.keepVerdict(key, "signed-in", previous.id);
    expect(await backend.judgement(key)).toEqual({ verdict: null, inputs: "b" });
    expect(await backend.cancelJudgement(key, current)).toBe(true);
    await backend.keepVerdict(key, "rejected", current.id);
    expect(await backend.judgement(key)).toEqual({ verdict: "partial", inputs: "a" });
  });

  it("fails a reservation without losing its previous answer when persistence fails", async () => {
    const { backend, restart, failWrites } = setup();
    const first = operation();
    await backend.reserveJudgement(key, NOW, stale, "a", first);
    await backend.keepVerdict(key, "optional", first.id);
    await backend.finishJudgement(key, first);
    failWrites(true);
    await expect(backend.reserveJudgement(key, NOW, stale, "b", operation())).rejects.toThrow(
      "synthetic storage full",
    );
    failWrites(false);
    expect(await restart().judgement(key)).toEqual({ verdict: "optional", inputs: "a" });
    expect((await restart().reserveJudgement(key, NOW, stale, "b", operation())).status).toBe(
      "taken",
    );
  });

  it("starts a fresh allowance at UTC midnight while retaining yesterday's entries", async () => {
    const { backend, restart, setTime } = setup();
    await Promise.all(
      Array.from({ length: 20 }, (_, index) =>
        backend.reserveJudgement({ ...key, path: `/page-${index}` }, NOW, stale, "a", operation()),
      ),
    );
    const tomorrow = utcDayStart(NOW) + 86_400_000;
    setTime(tomorrow);
    expect(
      (await restart().reserveJudgement(key, tomorrow, stale, "a", operation(tomorrow))).status,
    ).toBe("taken");
  });
});
