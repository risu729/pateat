import { afterEach, describe, vi } from "vitest";
import {
  createPasskeyRuntime,
  type ConditionalDecision,
  type PasskeyChoice,
  type PasskeyChooser,
  type PasskeyItem,
  type PasskeySource,
} from "./runtime";
import type { PasskeyCandidates } from "./select";
import {
  registerSenderBindingCases,
  registerCancellationCases,
  registerDocumentReplacementCases,
  registerPageOptionCases,
  registerPolicyCases,
  registerPolicyCancellationCases,
  registerRequiredMediationCases,
} from "../../test/passkeys/runtime-admission-cases";
import { registerReportCases } from "../../test/passkeys/runtime-report-cases";
import {
  registerChooserAnswerCases,
  registerRepromptCases,
  registerChooserDelegationCases,
  registerUnsetDefaultCases,
  registerChooserLifetimeCases,
} from "../../test/passkeys/runtime-chooser-cases";
import {
  registerDuringLoginCases,
  registerAfterLoginCases,
} from "../../test/passkeys/runtime-login-cases";
import { registerConditionalCases } from "../../test/passkeys/runtime-conditional-cases";
import { registerPausedCases } from "../../test/passkeys/runtime-paused-cases";
import { registerImmediateCases } from "../../test/passkeys/runtime-immediate-cases";
import {
  registerReverificationCases,
  registerBrowserSiteCases,
} from "../../test/passkeys/runtime-browser-cases";

const extensionId = "synthetic-extension";
const origin = "https://login.example.com";
const sender = (overrides: Record<string, unknown> = {}) => ({
  id: extensionId,
  tab: { id: 7 },
  frameId: 0,
  documentId: "document-a",
  documentLifecycle: "active",
  origin,
  url: `${origin}/sign-in?next=%2F`,
  ...overrides,
});
const candidate = {
  credentialId: "AQID",
  rpId: "example.com",
  userHandle: "dXNlcg",
  discoverable: true,
  counter: 0,
};
const request = { challenge: "AAECAwQFBgcICQoLDA0ODw", rpId: "example.com", allowCredentials: [] };
const get = (operationId = crypto.randomUUID(), userActivation = true, focused = true) => ({
  version: 1,
  type: "passkey.get",
  operationId,
  request,
  userActivation,
  focused,
});

function source(overrides: Partial<PasskeySource> = {}): PasskeySource {
  return {
    candidates: vi.fn(async () => ({ candidates: [candidate], complete: true })),
    sign: vi.fn(async () => Uint8Array.of(0x30, 0x06, 0x02, 0x01, 0x01, 0x02, 0x01, 0x01)),
    ...overrides,
  };
}

describe("passkey runtime sender binding", () => {
  registerSenderBindingCases({ extensionId, origin, sender, candidate, request, get, source });
});

describe("passkey runtime cancellation", () => {
  const slowSign = () =>
    source({
      sign: vi.fn(
        (_candidate, _data, _hash, signal: AbortSignal) =>
          new Promise<Uint8Array>((_resolve, reject) => {
            signal.addEventListener("abort", () => reject(signal.reason), { once: true });
          }),
      ),
    });

  registerCancellationCases({ extensionId, sender, get, source, slowSign });
});

describe("a document replaced while Pateat answers its request", () => {
  const signature = Uint8Array.of(0x30, 0x06, 0x02, 0x01, 0x01, 0x02, 0x01, 0x01);
  /** What the relay sends for each pending request on `pagehide`. */
  const cancel = (operationId: string) => ({ version: 1, type: "passkey.cancel", operationId });
  const tick = () => new Promise((resolve) => setTimeout(resolve, 0));
  /** A runtime with every side effect of an assertion observed. */
  const setup = (backing: PasskeySource, choice?: PasskeyChoice) => {
    const chooser = {
      choose: vi.fn<PasskeyChooser["choose"]>(
        async () => choice ?? { kind: "chosen", index: 0, makeDefault: false },
      ),
    };
    const leave = vi.fn();
    const effects = {
      answered: vi.fn(),
      remember: vi.fn(async () => {}),
      report: vi.fn(),
      hold: vi.fn(async () => leave),
    };
    const runtime = createPasskeyRuntime(backing, {
      extensionId,
      chooser,
      ...effects,
    });
    return { runtime, chooser, leave, ...effects };
  };

  registerDocumentReplacementCases({
    origin,
    sender,
    candidate,
    get,
    source,
    signature,
    cancel,
    tick,
    setup,
  });
});

describe("page option snapshots", () => {
  registerPageOptionCases();
});

describe("passkey runtime policy", () => {
  registerPolicyCases({ extensionId, origin, sender, get, source });
});

describe("a cancel while the device's passkey policy is read", () => {
  registerPolicyCancellationCases({ extensionId, sender, get, source });
});

describe("passkey runtime required mediation", () => {
  registerRequiredMediationCases({ extensionId, origin, sender, candidate, get, source });
});

describe("passkey runtime reports", () => {
  registerReportCases({ extensionId, origin, sender, candidate, request, get, source });
});

describe("passkey chooser window", () => {
  const pair = [
    { ...candidate, display: { item: "Work", userName: "alice", account: "Personal" } },
    { ...candidate, credentialId: "BAUG" },
  ];
  const several = (overrides: Partial<PasskeySource> = {}, siteDefault?: "searched" | "unset") =>
    source({
      candidates: vi.fn(async () => ({
        candidates: pair,
        complete: true,
        ...(siteDefault ? { siteDefault } : {}),
      })),
      ...overrides,
    });
  const chooser = (
    answer: (input: Parameters<PasskeyChooser["choose"]>[0]) => Promise<PasskeyChoice>,
  ) => ({
    choose: vi.fn(answer),
  });

  registerChooserAnswerCases({ extensionId, origin, sender, get, pair, several, chooser });

  describe("Bitwarden master password re-prompt", () => {
    const guarded = { ...candidate, reprompt: true, display: { item: "Bank" } };
    const one = (overrides: Partial<PasskeySource> = {}) =>
      source({
        candidates: vi.fn(async () => ({ candidates: [guarded], complete: true })),
        ...overrides,
      });

    registerRepromptCases({ extensionId, sender, get, chooser, guarded, one });
  });

  registerChooserDelegationCases({ extensionId, sender, get, source, pair, several, chooser });

  describe("a site that treats its default as unset (ADR 0063)", () => {
    const withDefault = (items = [{ ...pair[0]!, preferred: true }, pair[1]!]) =>
      source({
        candidates: vi.fn(async () => ({
          candidates: items,
          complete: true,
          siteDefault: "searched" as const,
        })),
      });

    registerUnsetDefaultCases({
      extensionId,
      origin,
      sender,
      request,
      get,
      pair,
      chooser,
      withDefault,
    });
  });

  registerChooserLifetimeCases({ extensionId, sender, request, get, pair, several, chooser });
});

describe("passkey requests during a login (ADR 0027)", () => {
  const loginItem = { connectionId: "personal", itemId: "login-item" };
  type Stored = (typeof candidate & { preferred?: boolean }) & { item: string };
  const siteDefault: Stored = {
    ...candidate,
    credentialId: "BBBB",
    preferred: true,
    item: "default-item",
  };
  const ofLogin: Stored = { ...candidate, credentialId: "CCCC", item: "login-item" };
  /** A vault of several items: with `only`, just that item's passkeys, none preferred. */
  const vault = (stored: Stored[], complete = true) =>
    source({
      candidates: vi.fn(async (_origin: string, _rpId: string, _signal, only?: PasskeyItem) => ({
        candidates: only
          ? stored
              .filter((entry) => entry.item === only.itemId)
              .map(({ preferred: _preferred, ...entry }) => entry)
          : stored,
        complete,
      })),
    });
  const chooser = () => ({
    choose: vi.fn(async (): Promise<PasskeyChoice> => ({ kind: "closed" })),
  });

  registerDuringLoginCases({
    extensionId,
    origin,
    sender,
    candidate,
    get,
    loginItem,
    siteDefault,
    ofLogin,
    vault,
    chooser,
  });
});

describe("after Pateat signed in a tab (ADR 0062)", () => {
  const withDefault = [
    { ...candidate, credentialId: "BAUG", display: { item: "Home" } },
    { ...candidate, preferred: true, display: { item: "Work" } },
  ];

  registerAfterLoginCases({ extensionId, sender, get, source, withDefault });
});

describe("a page's own conditional request through a login (ADR 0034)", () => {
  const loginItem = { connectionId: "personal", itemId: "login-item" };
  const conditionalGet = (operationId = crypto.randomUUID()) => ({
    ...get(operationId, false),
    request: { ...request, mediation: "conditional" },
  });
  const tick = () => new Promise((resolve) => setTimeout(resolve, 0));
  type Input = {
    tabId: number;
    origin: string;
    documentId: string;
    signal: AbortSignal;
    incognito: boolean;
  };
  /** A login runtime whose decisions the test gives, one per waiting request. */
  function decisions() {
    const waiting: Array<{ input: Input; decide(decision: ConditionalDecision): void }> = [];
    const conditional = vi.fn(
      (input: Input) =>
        new Promise<ConditionalDecision>((resolve) => waiting.push({ input, decide: resolve })),
    );
    return { conditional, waiting };
  }
  /** A vault hold that records when it is taken and left. */
  function holds() {
    const events: string[] = [];
    const hold = vi.fn(async () => {
      events.push("hold");
      return () => void events.push("leave");
    });
    return { hold, events };
  }

  registerConditionalCases({
    extensionId,
    origin,
    sender,
    candidate,
    request,
    get,
    source,
    loginItem,
    conditionalGet,
    tick,
    decisions,
    holds,
  });
});

describe("a paused site's own modal and Immediate UI requests (ADR 0062)", () => {
  const work = { ...candidate, credentialId: "BAUG", display: { item: "Work", userName: "bob" } };
  const home = { ...candidate, display: { item: "Home", userName: "alice" } };
  const vault = (
    candidates: PasskeyCandidates["candidates"],
    { complete = true, siteDefault }: { complete?: boolean; siteDefault?: "searched" } = {},
  ) =>
    source({
      candidates: vi.fn(async () => ({
        candidates,
        complete,
        ...(siteDefault ? { siteDefault } : {}),
      })),
    });
  const answering = (choice: PasskeyChoice = { kind: "chosen", index: 0, makeDefault: false }) =>
    vi.fn<PasskeyChooser["choose"]>(async () => choice);
  const immediate = () => ({ ...get(), request: { ...request, uiMode: "immediate" } });

  registerPausedCases({
    extensionId,
    origin,
    sender,
    get,
    work,
    home,
    vault,
    answering,
    immediate,
  });
});

describe("Immediate UI requests (ADR 0052)", () => {
  afterEach(() => vi.useRealTimers());
  const immediate = (overrides: Record<string, unknown> = {}) => ({
    ...get(),
    request: { ...request, uiMode: "immediate" },
    ...overrides,
  });
  const pair = [candidate, { ...candidate, credentialId: "BAUG" }];
  const several = (complete = true) =>
    source({ candidates: vi.fn(async () => ({ candidates: pair, complete })) });

  registerImmediateCases({
    extensionId,
    origin,
    sender,
    candidate,
    request,
    source,
    immediate,
    pair,
    several,
  });
});

describe("passkey re-verification after Pateat's login (ADR 0035)", () => {
  const named = () => ({
    ...get(),
    request: { ...request, allowCredentials: [{ type: "public-key", id: "AQID" }] },
  });

  registerReverificationCases({ extensionId, origin, sender, get, source, named });
});

describe("sites whose passkey requests go to the browser (ADR 0007)", () => {
  const pair = [candidate, { ...candidate, credentialId: "BAUG" }];
  const several = () =>
    source({ candidates: vi.fn(async () => ({ candidates: pair, complete: true })) });
  const withRequest = (overrides: Record<string, unknown>, userActivation = true) => ({
    ...get(crypto.randomUUID(), userActivation),
    request: { ...request, ...overrides },
  });

  registerBrowserSiteCases({ extensionId, origin, sender, get, source, several, withRequest });
});
