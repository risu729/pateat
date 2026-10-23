import { describe, expect, it, vi } from "vitest";
import type { LoginReport } from "../login/runtime";
import {
  MAX_RECENT_RECIPE_USES,
  RECIPE_USE_REPEAT_MS,
  createRecipeUse,
  recipeUseOf,
  type RecipeUseSent,
} from "./recipe-use";
import type { ServiceConnection } from "./runtime";
import type { OutcomeResult, ServiceTransport } from "./transport";

// Synthetic reports, recipes and service only; nothing leaves the test.

const CONNECTION: ServiceConnection = {
  origin: "https://pateat.example.com",
  deviceId: "6f1d3c1e-5d0b-4a52-9d55-3d7a8f0e2b41",
  credential: `pateat_device_${"C".repeat(43)}`,
  rejected: false,
};
const NOW = Date.UTC(2026, 9, 19, 9, 0);

type StartReport = Extract<LoginReport, { type: "start" }>;
type Overrides = { [K in keyof StartReport]?: StartReport[K] | undefined };
/** A login that just started on a service recipe revision. */
function started(overrides: Overrides = {}): LoginReport {
  return {
    type: "start",
    tabId: 7,
    origin: "https://bank.example",
    recipeId: "gen-0123",
    recipeRevision: 3,
    // The layout the login started on (ADR 0060).
    layout: "1000",
    route: "password",
    variant: 0,
    account: "match",
    candidates: 1,
    itemId: "item-1",
    ...overrides,
  } as LoginReport;
}

describe("recipeUseOf", () => {
  it("sends the version, revision and layout only, never the origin, account or route", () => {
    expect(recipeUseOf(started())).toEqual({
      recipeId: "gen-0123",
      report: { version: 1, revision: 3, layout: "1000" },
    });
    // A fill-only login, one at a later step and one on a chooser's list count as well.
    for (const report of [
      started({ fillOnly: true }),
      started({ startStep: 1 }),
      started({ click: "none", listMiss: { username: "email", entries: 2 } as never }),
    ])
      expect(recipeUseOf(report)).toEqual({
        recipeId: "gen-0123",
        report: { version: 1, revision: 3, layout: "1000" },
      });
  });

  it("sends nothing for other reports, a local recipe or an invalid recipe ID", () => {
    const none: LoginReport[] = [
      // Every later report of a login, also one that ended with its times.
      {
        type: "attempt",
        tabId: 7,
        origin: "https://bank.example",
        recipeId: "gen-0123",
        recipeRevision: 3,
        route: "password",
        state: "authenticated",
        stepIndex: 2,
        stepCount: 2,
        outcome: "authenticated",
        reason: "signed-in",
      } as LoginReport,
      { type: "refused", tabId: 7, origin: "https://bank.example", reason: "no-recipe" },
      { type: "logout" } as LoginReport,
      // No layout (ADR 0060).
      started({ layout: undefined }),
      // No service recipe revision.
      started({ recipeRevision: 0 }),
      started({ recipeRevision: -1 }),
      started({ recipeRevision: 1.5 }),
      started({ recipeId: "not a recipe" }),
      started({ recipeId: "" }),
      started({ recipeId: "x".repeat(200) }),
    ];
    for (const report of none) expect(recipeUseOf(report)).toBeUndefined();
  });
});

function setup(
  options: {
    connection?: () => Promise<ServiceConnection | undefined>;
    answer?: () => Promise<OutcomeResult>;
    report?: (sent: RecipeUseSent) => void;
    local?: (recipeId: string, layout: string) => Promise<void>;
  } = {},
) {
  let now = NOW;
  const answer = options.answer ?? (async (): Promise<OutcomeResult> => ({ kind: "kept" }));
  const reportUse = vi.fn<ServiceTransport["reportUse"]>(() => answer());
  const logged: RecipeUseSent[] = [];
  const use = createRecipeUse({
    service: { connection: options.connection ?? (async () => CONNECTION) },
    transport: { reportUse },
    report:
      options.report ??
      ((sent) => {
        logged.push(sent);
      }),
    ...(options.local ? { local: options.local } : {}),
    now: () => now,
  });
  return { use, reportUse, logged, advance: (ms: number) => (now += ms) };
}

/** Lets every send started so far settle. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 10));

describe("createRecipeUse", () => {
  it("sends a started login's revision to the paired service with its credential", async () => {
    const { use, reportUse, logged } = setup();
    // Two reports at once, as two tabs starting together, send once.
    use.observe(started());
    use.observe(started({ tabId: 8 }));
    await vi.waitFor(() => expect(logged).toHaveLength(1));
    await settle();
    expect(reportUse.mock.calls).toEqual([
      [
        CONNECTION.origin,
        CONNECTION.credential,
        "gen-0123",
        { version: 1, revision: 3, layout: "1000" },
      ],
    ]);
    expect(logged).toEqual([{ recipeId: "gen-0123", revision: 3, layout: "1000", result: "kept" }]);
  });

  it("sends a revision once an hour per service, and each other revision or recipe", async () => {
    let connection = CONNECTION;
    const { use, reportUse, logged, advance } = setup({ connection: async () => connection });
    use.observe(started());
    await vi.waitFor(() => expect(logged).toHaveLength(1));
    // A login retried at once, or later within the hour, adds nothing.
    use.observe(started());
    advance(RECIPE_USE_REPEAT_MS - 1);
    use.observe(started({ tabId: 8 }));
    await settle();
    expect(reportUse).toHaveBeenCalledTimes(1);
    // Another revision, another recipe and another service are each their own.
    use.observe(started({ recipeRevision: 4 }));
    use.observe(started({ recipeId: "gen-4567" }));
    await vi.waitFor(() => expect(logged).toHaveLength(3));
    connection = { ...CONNECTION, origin: "https://other.example.com" };
    use.observe(started());
    await vi.waitFor(() => expect(logged).toHaveLength(4));
    expect(reportUse.mock.calls.map((call) => [call[0], call[2], call[3].revision])).toEqual([
      [CONNECTION.origin, "gen-0123", 3],
      [CONNECTION.origin, "gen-0123", 4],
      [CONNECTION.origin, "gen-4567", 3],
      ["https://other.example.com", "gen-0123", 3],
    ]);
  });

  it("sends a revision again once the hour since its send has passed", async () => {
    const { use, reportUse, logged, advance } = setup();
    use.observe(started());
    await vi.waitFor(() => expect(logged).toHaveLength(1));
    advance(RECIPE_USE_REPEAT_MS);
    use.observe(started());
    await vi.waitFor(() => expect(logged).toHaveLength(2));
    // The hour counts from the latest send, not the first.
    advance(RECIPE_USE_REPEAT_MS - 1);
    use.observe(started());
    await settle();
    expect(reportUse).toHaveBeenCalledTimes(2);
  });

  it("remembers a revision the service refused as sent", async () => {
    const { use, reportUse, logged } = setup({ answer: async () => ({ kind: "refused" }) });
    use.observe(started());
    await vi.waitFor(() => expect(logged).toHaveLength(1));
    use.observe(started());
    await settle();
    expect(reportUse).toHaveBeenCalledTimes(1);
    expect(logged).toEqual([
      { recipeId: "gen-0123", revision: 3, layout: "1000", result: "refused" },
    ]);
  });

  it("forgets a failed send, so the next login on the revision sends again", async () => {
    const answers: OutcomeResult[] = [
      { kind: "failed", error: "unreachable" },
      { kind: "rejected" },
      { kind: "failed", error: "rate-limited" },
      { kind: "kept" },
    ];
    const { use, reportUse, logged } = setup({ answer: async () => answers.shift()! });
    for (let index = 1; index <= 4; index += 1) {
      use.observe(started());
      // oxlint-disable-next-line no-await-in-loop -- each login waits for the last send
      await vi.waitFor(() => expect(logged).toHaveLength(index));
    }
    // Never retried on its own: each send was a new login's.
    await settle();
    expect(reportUse).toHaveBeenCalledTimes(4);
    expect(logged.map((sent) => sent.result)).toEqual([
      "failed:unreachable",
      "rejected",
      "failed:rate-limited",
      "kept",
    ]);
    use.observe(started());
    await settle();
    expect(reportUse).toHaveBeenCalledTimes(4);
  });

  it("forgets a send that threw and logs it as failed:threw", async () => {
    let fail = true;
    const { use, reportUse, logged } = setup({
      answer: async () => {
        if (fail) throw new Error("synthetic");
        return { kind: "kept" };
      },
    });
    expect(() => use.observe(started())).not.toThrow();
    await vi.waitFor(() =>
      expect(logged).toEqual([
        { recipeId: "gen-0123", revision: 3, layout: "1000", result: "failed:threw" },
      ]),
    );
    fail = false;
    use.observe(started());
    await vi.waitFor(() => expect(logged).toHaveLength(2));
    expect(reportUse).toHaveBeenCalledTimes(2);
  });

  it("remembers at most 100 revisions, forgetting the oldest first", async () => {
    const { use, reportUse, logged } = setup();
    const ids = Array.from({ length: MAX_RECENT_RECIPE_USES + 1 }, (_, index) => `gen-${index}`);
    for (const id of ids) use.observe(started({ recipeId: id }));
    await vi.waitFor(() => expect(logged).toHaveLength(ids.length));
    // The 101st send pushed out the first; the second is still remembered.
    use.observe(started({ recipeId: ids[1] }));
    use.observe(started({ recipeId: ids.at(-1) }));
    await settle();
    expect(reportUse).toHaveBeenCalledTimes(ids.length);
    use.observe(started({ recipeId: ids[0] }));
    await vi.waitFor(() => expect(logged).toHaveLength(ids.length + 1));
    expect(reportUse.mock.calls.at(-1)?.[2]).toBe(ids[0]);
    // Sending it again pushed out the oldest remembered, the second.
    use.observe(started({ recipeId: ids[1] }));
    await vi.waitFor(() => expect(logged).toHaveLength(ids.length + 2));
    expect(reportUse.mock.calls.at(-1)?.[2]).toBe(ids[1]);
  });

  it("refreshes a revision sent again, so it is not the oldest remembered", async () => {
    const { use, reportUse, logged, advance } = setup();
    use.observe(started({ recipeId: "gen-first" }));
    await vi.waitFor(() => expect(logged).toHaveLength(1));
    advance(RECIPE_USE_REPEAT_MS);
    use.observe(started({ recipeId: "gen-second" }));
    // Sent again after its hour: now newer than gen-second.
    use.observe(started({ recipeId: "gen-first" }));
    await vi.waitFor(() => expect(logged).toHaveLength(3));
    const others = Array.from({ length: MAX_RECENT_RECIPE_USES - 1 }, (_, index) => `gen-${index}`);
    for (const id of others) use.observe(started({ recipeId: id }));
    await vi.waitFor(() => expect(logged).toHaveLength(3 + others.length));
    // gen-second went first, though sent within the hour; gen-first is still remembered.
    use.observe(started({ recipeId: "gen-first" }));
    use.observe(started({ recipeId: "gen-second" }));
    await vi.waitFor(() => expect(logged).toHaveLength(4 + others.length));
    await settle();
    expect(reportUse).toHaveBeenCalledTimes(4 + others.length);
    expect(reportUse.mock.calls.at(-1)?.[2]).toBe("gen-second");
  });

  it("marks the layout used on this device without a paired service, once an hour (ADR 0040)", async () => {
    const local = vi.fn(async () => {});
    const h = setup({ connection: async () => undefined, local });
    h.use.observe(started());
    await settle();
    h.use.observe(started());
    await settle();
    expect(local).toHaveBeenCalledTimes(1);
    expect(h.reportUse).not.toHaveBeenCalled();
    expect(h.logged).toEqual([]);
    h.advance(RECIPE_USE_REPEAT_MS);
    h.use.observe(started());
    await settle();
    expect(local).toHaveBeenCalledTimes(2);
  });

  it("sends nothing for reports without a use, without a paired service or with a rejected device", async () => {
    const quiet = setup();
    quiet.use.observe(started({ recipeRevision: 0 }));
    quiet.use.observe({ type: "logout" } as LoginReport);
    const unpaired = setup({ connection: async () => undefined });
    unpaired.use.observe(started());
    const rejected = setup({ connection: async () => ({ ...CONNECTION, rejected: true }) });
    rejected.use.observe(started());
    await settle();
    for (const { reportUse, logged } of [quiet, unpaired, rejected]) {
      expect(reportUse).not.toHaveBeenCalled();
      expect(logged).toEqual([]);
    }
    // Nothing was remembered: a later pairing sends the revision at once.
    let connection: ServiceConnection | undefined;
    const later = setup({ connection: async () => connection });
    later.use.observe(started());
    await settle();
    connection = CONNECTION;
    later.use.observe(started());
    await vi.waitFor(() => expect(later.reportUse).toHaveBeenCalledTimes(1));
  });

  it("never throws into the login when the service, transport or log throws", async () => {
    const reportUse = vi.fn<ServiceTransport["reportUse"]>(async () => ({ kind: "kept" }));
    const broken = createRecipeUse({
      service: {
        connection: async () => {
          throw new Error("synthetic");
        },
      },
      transport: { reportUse },
      report: () => {
        throw new Error("synthetic");
      },
    });
    expect(() => broken.observe(started())).not.toThrow();
    const syncThrow = createRecipeUse({
      service: {
        connection: () => {
          throw new Error("synthetic");
        },
      },
      transport: { reportUse },
    });
    expect(() => syncThrow.observe(started())).not.toThrow();
    await settle();
    expect(reportUse).not.toHaveBeenCalled();

    const throwingTransport = createRecipeUse({
      service: { connection: async () => CONNECTION },
      transport: {
        reportUse: () => {
          throw new Error("synthetic");
        },
      },
      report: () => {
        throw new Error("synthetic");
      },
    });
    expect(() => throwingTransport.observe(started())).not.toThrow();
    // A report that is not a login report at all.
    expect(() => throwingTransport.observe(null as never)).not.toThrow();
    await settle();
  });
});
