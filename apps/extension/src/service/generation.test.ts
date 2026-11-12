import {
  type LoginChooserDocument,
  type EntryGenerationRequest,
  type LoginObservation,
  type RecipeGenerationRequest,
  type SemanticSlot,
} from "@pateat/contracts";
import { describe, vi } from "vitest";
import { createLoginGeneration } from "./generation";

import type { ServiceConnection } from "./runtime";
import type { InferenceResult, ServiceTransport } from "./transport";
import { registerRequests1 } from "../../test/service/generation/requests-1";
import { registerRequests2 } from "../../test/service/generation/requests-2";
import { registerRequests3 } from "../../test/service/generation/requests-3";
import { registerTiming1 } from "../../test/service/generation/timing-1";
import { registerHandlers1 } from "../../test/service/generation/handlers-1";
import { registerHandlers2 } from "../../test/service/generation/handlers-2";
import { registerContinuation1 } from "../../test/service/generation/continuation-1";
import { registerRepair1 } from "../../test/service/generation/repair-1";
import { registerContinuationClaims1 } from "../../test/service/generation/continuation-claims-1";
import { registerContinuationClaims2 } from "../../test/service/generation/continuation-claims-2";
import { registerSlotMaps1 } from "../../test/service/generation/slot-maps-1";
import { registerSlotMaps2 } from "../../test/service/generation/slot-maps-2";
import { registerSamples1 } from "../../test/service/generation/samples-1";
import { registerRepairClaims1 } from "../../test/service/generation/repair-claims-1";
import { registerPopup1 } from "../../test/service/generation/popup-1";

// Synthetic pages and a fake transport only; nothing leaves the test.

const connection: ServiceConnection = {
  origin: "https://pateat.example.com",
  deviceId: "6f1d3c1e-5d0b-4a52-9d55-3d7a8f0e2b41",
  credential: `pateat_device_${"C".repeat(43)}`,
  rejected: false,
};
const observation: LoginObservation = {
  version: 1,
  origin: "https://shop.example",
  path: "/login",
  language: "en",
  complete: true,
  candidates: [{ id: "c1", role: "password", target: { by: "id", value: "password" } }],
};
const request: RecipeGenerationRequest = {
  version: 1,
  observation,
  slots: [{ id: "password", kind: "secret", description: "account password" }],
  signedIn: false,
};
/** The layout key of the synthetic recipes: their creation time (ADR 0060). */
const KEY = "1760000000000";
type Identity = { version: 1; id: string; revision: number; origin: string };
/** A recipe a login runs, stored as the one layout of a recipe (ADR 0060). */
function storedOf<T extends Identity & { layout?: string }>(recipe: T, key = KEY) {
  const { version, id, revision, origin, layout: _layout, ...body } = recipe;
  return { version, id, revision, origin, layouts: [{ key, createdAt: Number(key), ...body }] };
}
/** A chooser a login runs, stored as the one layout of a chooser (ADR 0060). */
function chooserOf<T extends Identity & { chooser: { path: string } & Record<string, unknown> }>(
  recipe: T,
  key = KEY,
) {
  const { version, id, revision, origin } = recipe;
  const { path, afterAccount, afterOther, ...buttons } = recipe.chooser as {
    path: string;
    afterAccount?: Identity & Record<string, unknown>;
    afterOther?: Identity & Record<string, unknown>;
  } & Record<string, unknown>;
  const body = (branch: (Identity & Record<string, unknown>) | undefined) => {
    if (!branch) return undefined;
    const { version: _v, id: _i, revision: _r, origin: _o, layout: _l, ...route } = branch;
    return route;
  };
  return {
    version,
    id,
    revision,
    origin,
    chooser: {
      path,
      layouts: [
        {
          key,
          createdAt: Number(key),
          ...buttons,
          ...(afterAccount ? { afterAccount: body(afterAccount) } : {}),
          ...(afterOther ? { afterOther: body(afterOther) } : {}),
        },
      ],
    },
  } as unknown as LoginChooserDocument;
}
const route = {
  version: 1 as const,
  id: "gen-0123456789abcdef0123456789abcdef",
  revision: 1,
  origin: "https://shop.example",
  pageKind: "sign-in" as const,
  slots: ["password"],
  steps: [
    {
      kind: "fill" as const,
      path: "/login",
      fields: [{ slot: "password", target: { by: "id" as const, value: "password" } }],
      effect: "submit" as const,
      event: "change" as const,
    },
  ],
  maxSubmissions: 1,
};
/** The route as a login runs it: the layout of the stored recipe. */
const runs = { ...route, layout: KEY };
const recipeChange = {
  recipeId: "gen-0123456789abcdef0123456789abcdef",
  revision: 1,
  state: "active" as const,
  recipe: storedOf(route),
};

const entryChange = {
  recipeId: "gen-fedcba9876543210fedcba9876543210",
  revision: 1,
  state: "active" as const,
  recipe: {
    version: 1 as const,
    id: "gen-fedcba9876543210fedcba9876543210",
    revision: 1,
    origin: "https://shop.example",
    entry: { path: "/", target: { by: "text" as const, value: "Log in" } },
  },
};
const entryRequest: EntryGenerationRequest = {
  version: 1,
  observation: {
    version: 1,
    origin: "https://shop.example",
    path: "/",
    language: "en",
    complete: true,
    candidates: [
      { id: "c1", role: "link", target: { by: "text", value: "Log in" }, label: "Log in" },
    ],
  },
};

function setup(
  answer: Awaited<ReturnType<ServiceTransport["generateRecipe"]>> = {
    kind: "result",
    result: { version: 1, status: "recipe", change: recipeChange },
  },
  entryAnswer: Awaited<ReturnType<ServiceTransport["generateEntry"]>> = {
    kind: "result",
    result: { version: 1, status: "recipe", change: entryChange },
  },
) {
  let stored: unknown;
  let now = 1_000_000;
  const storage = {
    read: vi.fn(async () => structuredClone(stored)),
    write: vi.fn(async (value: unknown) => {
      stored = structuredClone(value);
    }),
  };
  const transport = {
    generateRecipe: vi.fn<ServiceTransport["generateRecipe"]>(async () => answer),
    generateEntry: vi.fn<ServiceTransport["generateEntry"]>(async () => entryAnswer),
    judgeCompletion: vi.fn<ServiceTransport["judgeCompletion"]>(
      async (): Promise<InferenceResult<never>> => ({ kind: "failed", error: "unreachable" }),
    ),
  };
  const service = {
    connection: vi.fn(async (): Promise<ServiceConnection | undefined> => connection),
  };
  const sync = vi.fn(async () => "synced");
  const refresh = vi.fn(async () => "synced");
  const created = createLoginGeneration({
    service,
    transport,
    storage,
    slotStorage: { read: async () => undefined, write: async () => undefined },
    sync,
    refresh,
    now: () => now,
  });
  // The logins of these tests run the recipe's one layout (ADR 0060) unless they say.
  const generation: typeof created = {
    ...created,
    judge: (recipeId, revision, judged, page, sent, branch = KEY, ...rest) =>
      created.judge(recipeId, revision, judged, page, sent, branch, ...rest),
  };
  return {
    generation,
    /** The generation as the runtime calls it, without a layout unless one is passed. */
    raw: created,
    transport,
    service,
    storage,
    sync,
    refresh,
    now: () => now,
    advance: (ms: number) => {
      now += ms;
    },
  };
}

export type GenerationTestFixtures = {
  connection: typeof connection;
  observation: typeof observation;
  request: typeof request;
  KEY: typeof KEY;
  chooserOf: typeof chooserOf;
  runs: typeof runs;
  recipeChange: typeof recipeChange;
  entryChange: typeof entryChange;
  entryRequest: typeof entryRequest;
  setup: typeof setup;
  storedOf: typeof storedOf;
  route: typeof route;
};

describe("recipe generation requests", () => {
  registerRequests1({
    connection,
    observation,
    request,
    KEY,
    chooserOf,
    runs,
    recipeChange,
    entryChange,
    entryRequest,
    setup,
  });

  type Answer = Awaited<ReturnType<ServiceTransport["generateRecipe"]>>;
  const freed: [string, Answer, string, string][] = [
    ["an unreachable service", { kind: "failed", error: "unreachable" }, "failed", "unreachable"],
    [
      "the service's request limit",
      { kind: "failed", error: "rate-limited" },
      "failed",
      "rate-limited",
    ],
    // The answer may be lost after a model call; the service then answers `recently-tried`.
    ["a timeout", { kind: "failed", error: "timeout" }, "failed", "timeout"],
    [
      "an unexpected answer",
      { kind: "failed", error: "unexpected-response" },
      "failed",
      "unexpected-response",
    ],
    ["a rejected device", { kind: "rejected" }, "failed", "device-rejected"],
    [
      "a request the service refused before the model",
      { kind: "result", result: { version: 1, status: "failed", error: "input-too-large" } },
      "failed",
      "input-too-large",
    ],
    ...(
      [
        "busy",
        "recently-tried",
        "credentials-not-configured",
        "token-exchange-failed",
        "daily-limit",
        "recipe-limit",
      ] as const
    ).map((reason): [string, Answer, string, string] => [
      `the service's ${reason}`,
      { kind: "result", result: { version: 1, status: "unavailable", reason } },
      "unavailable",
      reason,
    ]),
  ];
  registerRequests2({
    connection,
    observation,
    request,
    KEY,
    storedOf,
    route,
    recipeChange,
    setup,
    freed,
  });

  const unavailable = (reason: string) => ({
    kind: "result" as const,
    result: { version: 1 as const, status: "unavailable" as const, reason },
  });
  const failure = (error: string) => ({
    kind: "result" as const,
    result: { version: 1 as const, status: "failed" as const, error },
  });
  registerRequests3({ observation, recipeChange, setup, unavailable, failure });
});

describe("request timing for the local log (ADR 0019)", () => {
  const timing = { roundTripMs: 2_600, serverMs: 2_400, networkMs: 200, modelMs: 2_000 };
  registerTiming1({ observation, request, recipeChange, entryRequest, setup, timing });
});

describe("handlers and code fields in generation requests (ADR 0027)", () => {
  const totp = { id: "totp", kind: "one-time-code" as const, description: "one-time code" };
  /** The judged layout as the login runs it, with the handler the judge added. */
  const handledRuns = {
    ...runs,
    revision: 2,
    handlers: [
      {
        kind: "passkey" as const,
        path: "/login/webauthn",
        target: { by: "text" as const, value: "Use security key" },
      },
    ],
  };
  const handled = { ...recipeChange, revision: 2, recipe: storedOf(handledRuns) };
  const webauthn = { ...observation, path: "/login/webauthn" };
  registerHandlers1({
    connection,
    KEY,
    chooserOf,
    recipeChange,
    setup,
    handledRuns,
    handled,
    webauthn,
  });

  const completed = {
    ...handled,
    recipe: storedOf({
      ...handledRuns,
      completion: [{ target: { by: "id" as const, value: "logout" } }],
    }),
  };
  registerHandlers2({
    connection,
    observation,
    request,
    recipeChange,
    setup,
    totp,
    handled,
    webauthn,
    completed,
  });
});

describe("continuing a recipe after its final advance (ADR 0018)", () => {
  const base = { recipeId: recipeChange.recipeId, revision: 1 };
  // The password page, sent with the revision it continues.
  // It names the layout it continues (ADR 0060).
  const continuation: RecipeGenerationRequest = { ...request, base, branch: KEY };
  const continued = {
    ...recipeChange,
    revision: 2,
    recipe: storedOf({ ...route, revision: 2 }),
  };
  registerContinuation1({
    connection,
    observation,
    request,
    runs,
    setup,
    base,
    continuation,
    continued,
  });
});

describe("repairing a stale recipe's start page (ADR 0041)", () => {
  const repair: RecipeGenerationRequest = {
    ...request,
    repair: { recipeId: recipeChange.recipeId, revision: 2 },
  };
  registerRepair1({ connection, request, recipeChange, setup, repair });
});

describe("continuation claims and answers, probed independently (ADR 0018)", () => {
  const base = { recipeId: recipeChange.recipeId, revision: 1 };
  // It names the layout it continues (ADR 0060).
  const continuation: RecipeGenerationRequest = { ...request, base, branch: KEY };
  const answerOf = (revision: number) => ({
    kind: "result" as const,
    result: {
      version: 1 as const,
      status: "recipe" as const,
      change: { ...recipeChange, revision, recipe: storedOf({ ...route, revision }) },
    },
  });
  const sent = { outcome: "skipped", reason: "sent" };
  registerContinuationClaims1({ observation, request, runs, setup, continuation, answerOf, sent });

  registerContinuationClaims2({
    connection,
    observation,
    request,
    KEY,
    setup,
    base,
    continuation,
    answerOf,
    sent,
  });
});

describe("generated slot maps (ADR 0027)", () => {
  const offered: RecipeGenerationRequest = {
    ...request,
    slots: [
      ...request.slots,
      {
        id: "custom-1",
        kind: "identifier",
        description: "value of the user's vault field named in fieldName",
        fieldName: "Branch number",
      },
      {
        id: "custom-2",
        kind: "hidden",
        description: "concealed value of the user's vault field named in fieldName, such as a PIN",
        fieldName: "PIN",
        fieldPosition: { position: 2, count: 2 },
      },
    ],
  };
  const customSlots = [
    { slot: "店番号", offered: "custom-1" },
    { slot: "暗証番号", offered: "custom-2" },
  ];
  const mapped = [
    { slot: "店番号", field: { custom: "Branch number" } },
    { slot: "暗証番号", field: { custom: "PIN", position: 2, count: 2 } },
  ];
  const recipeId = recipeChange.recipeId;
  const idOf = (index: number) => `gen-${index.toString(16).padStart(32, "0")}`;

  function slotSetup(
    options: {
      customSlots?: { slot: string; offered: string }[];
      stored?: unknown;
      failWrite?: boolean;
      /** Reads that reject before one succeeds. */
      failReads?: number;
      /** The answered change, for a continuation. */
      change?: typeof recipeChange;
    } = {},
  ) {
    let stored = options.stored;
    let failReads = options.failReads ?? 0;
    const order: string[] = [];
    const slotStorage = {
      read: vi.fn(async () => {
        if (failReads > 0) {
          failReads -= 1;
          throw new Error("synthetic storage failure");
        }
        return structuredClone(stored);
      }),
      write: vi.fn(async (value: unknown) => {
        order.push("write");
        if (options.failWrite) throw new Error("synthetic storage failure");
        stored = structuredClone(value);
      }),
    };
    const transport = {
      generateRecipe: vi.fn<ServiceTransport["generateRecipe"]>(
        async (_origin, _credential, sent) => ({
          kind: "result" as const,
          result: {
            version: 1 as const,
            status: "recipe" as const,
            change: options.change ?? {
              ...recipeChange,
              recipeId: sent.observation.path === "/login" ? recipeId : idOf(0),
            },
            ...(options.customSlots === undefined
              ? { customSlots }
              : options.customSlots.length
                ? { customSlots: options.customSlots }
                : {}),
          },
        }),
      ),
      generateEntry: vi.fn<ServiceTransport["generateEntry"]>(),
      judgeCompletion: vi.fn<ServiceTransport["judgeCompletion"]>(),
    };
    const service = {
      connection: vi.fn(async (): Promise<ServiceConnection | undefined> => connection),
    };
    let attempts: unknown;
    const generation = createLoginGeneration({
      service,
      transport,
      storage: {
        read: async () => structuredClone(attempts),
        write: async (value) => {
          attempts = structuredClone(value);
        },
      },
      slotStorage,
      sync: vi.fn(async () => {
        order.push("sync");
        return "synced";
      }),
      refresh: vi.fn(async () => "synced"),
    });
    return { generation, service, slotStorage, order, stored: () => stored };
  }
  registerSlotMaps1({
    connection,
    observation,
    offered,
    customSlots,
    mapped,
    recipeId,
    idOf,
    slotSetup,
  });

  // Page 1 of a recipe mapped `店番号`; its continuation maps only page 2's slot.
  const ownMap = (id: string, slots: { slot: string; field: { custom: string } }[]) => ({
    service: connection.origin,
    deviceId: connection.deviceId,
    recipeId: id,
    slots,
  });
  const continued = {
    ...recipeChange,
    revision: 2,
    recipe: storedOf({
      ...route,
      revision: 2,
      slots: ["password", "店番号", "暗証番号"],
    }),
  };
  const continuation = { ...offered, base: { recipeId, revision: 1 }, branch: KEY };
  registerSlotMaps2({
    storedOf,
    route,
    offered,
    customSlots,
    mapped,
    recipeId,
    idOf,
    slotSetup,
    ownMap,
    continued,
    continuation,
  });
});

describe("signed-in page samples (ADR 0029, owner 2026-10-18 08:05 UTC)", () => {
  const recipeId = "gen-0123456789abcdef0123456789abcdef";
  const signedIn: LoginObservation = { ...observation, path: "/home", candidates: [] };
  // The layout the login ran (ADR 0060).
  const sample = { recipeId, revision: 2, route: "password" as const, branch: KEY };
  // The account's slots, as the judge gets them; the page shows no code field.
  const accountSlots: SemanticSlot[] = [
    { id: "username", kind: "identifier", description: "account username" },
    { id: "totp", kind: "one-time-code", description: "one-time authentication code" },
  ];
  function sampleSetup(paired: boolean | ServiceConnection = true) {
    let stored: unknown;
    let now = 5_000_000_000;
    const order: string[] = [];
    const sampleStorage = {
      read: vi.fn(async () => structuredClone(stored)),
      write: vi.fn(async (value: unknown) => {
        order.push("record");
        stored = structuredClone(value);
      }),
    };
    const samplePage = vi.fn<ServiceTransport["samplePage"]>(async () => {
      order.push("send");
      return { kind: "kept" };
    });
    const generation = createLoginGeneration({
      service: {
        connection: async () =>
          typeof paired === "object" ? paired : paired ? connection : undefined,
      },
      transport: {
        generateRecipe: vi.fn(),
        generateEntry: vi.fn(),
        judgeCompletion: vi.fn(),
        samplePage,
      },
      storage: { read: async () => undefined, write: async () => undefined },
      slotStorage: { read: async () => undefined, write: async () => undefined },
      sampleStorage,
      sync: async () => "synced",
      refresh: async () => "synced",
      now: () => now,
    });
    const describePage = vi.fn(
      async (): Promise<
        { observation: LoginObservation; slots: readonly SemanticSlot[] } | { unsent: string }
      > => ({
        observation: signedIn,
        slots: accountSlots,
      }),
    );
    return {
      generation,
      samplePage,
      sampleStorage,
      describePage,
      order,
      stored: () => stored,
      advance: (ms: number) => {
        now += ms;
      },
    };
  }
  registerSamples1({ connection, KEY, recipeId, signedIn, sample, accountSlots, sampleSetup });
});

describe("claiming the repair of a recipe the chosen item cannot run (ADR 0058 A)", () => {
  const recipeId = "gen-0123456789abcdef0123456789abcdef";
  /** Storage shared by every generation side built from it, as one browser profile's. */
  function shared() {
    let stored: unknown;
    return {
      stored: () => stored,
      set: (value: unknown) => {
        stored = structuredClone(value);
      },
      storage: () => ({
        read: vi.fn(async () => structuredClone(stored)),
        write: vi.fn(async (value: unknown) => {
          stored = structuredClone(value);
        }),
      }),
    };
  }
  function claimSetup(
    options: {
      store?: ReturnType<typeof shared>;
      paired?: () => ServiceConnection | undefined;
      now?: { value: number };
    } = {},
  ) {
    const store = options.store ?? shared();
    const clock = options.now ?? { value: 5_000_000_000 };
    const replaceStorage = store.storage();
    const generation = createLoginGeneration({
      service: {
        connection: vi.fn(async () => (options.paired ? options.paired() : connection)),
      },
      transport: { generateRecipe: vi.fn(), generateEntry: vi.fn(), judgeCompletion: vi.fn() },
      storage: { read: async () => undefined, write: async () => undefined },
      slotStorage: { read: async () => undefined, write: async () => undefined },
      replaceStorage,
      sync: vi.fn(async () => "synced"),
      refresh: vi.fn(async () => "synced"),
      now: () => clock.value,
    });
    return {
      generation,
      replaceStorage,
      store,
      advance: (ms: number) => {
        clock.value += ms;
      },
    };
  }
  const entries = (h: { store: ReturnType<typeof shared> }) =>
    (
      h.store.stored() as {
        replacements: { recipeId: string; deviceId: string; route: string; at: number }[];
      }
    ).replacements;
  registerRepairClaims1({ connection, recipeId, shared, claimSetup, entries });
});

describe("one-time generation from the popup", () => {
  registerPopup1({ observation, request, recipeChange, setup });
});
