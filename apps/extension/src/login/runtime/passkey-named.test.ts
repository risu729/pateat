import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ConditionalDecision } from "../../passkeys/runtime";
import type { ParkedRequest } from "./types";
import type { Runtime } from "./state";

vi.mock("wxt/browser", () => ({ browser: {} }));
const { passkeyAnswered, passkeyReverification, reviewRequests } = await import("./passkey");
const {
  passkeySignInLeft,
  passkeySignedIn,
  personStepFor,
  personStepNext,
  personStepped,
  recipeOnPath,
  tabLoginRuns,
} = await import("./passkey-named");

// The rules of a conditional request that names its credentials on a path where no recipe
// starts (ADR 0034 amendment of 2026-11-17, #1673), read on a runtime built by hand.
const origin = "https://login.example";
const other = "https://other.example";
const doc = (documentId: string, frameId = 0, at = origin) => ({
  origin: at,
  tabId: 1,
  frameId,
  documentId,
});
const top = (documentId: string, path: string, extra: Record<string, unknown> = {}) => ({
  document: doc(documentId),
  url: `${origin}${path}`,
  path,
  ...extra,
});
const run = (documentId: string, state: string, extra: Record<string, unknown> = {}) => ({
  live: { document: doc(documentId) },
  metadata: { account: { origin }, state, ...extra },
});
function runtime(
  options: {
    starts?: () => Promise<unknown[]>;
    entries?: () => Promise<unknown[]>;
    routes?: () => Promise<unknown[]>;
  } = {},
) {
  return {
    vars: { loaded: Promise.resolve(), sessionLoaded: Promise.resolve() },
    attempts: new Map(),
    pending: new Map(),
    picked: new Map(),
    choicePasskeys: new Map(),
    documents: new Map(),
    persisted: new Map(),
    sso: { flows: new Map() },
    parkedRequests: new Set<ParkedRequest>(),
    admitting: new Map(),
    signInSubmits: new Map(),
    passkeyAnswers: new Map(),
    personSteps: new Map(),
    recipes: {
      starts: vi.fn(
        options.starts ?? (async () => [{ path: "/signin", later: [{ path: "/signin/next" }] }]),
      ),
      entries: vi.fn(options.entries ?? (async () => [{ entry: { path: "/welcome" } }])),
      routes: vi.fn(options.routes ?? (async () => [])),
    },
  } as unknown as Runtime;
}
/** A named request of the password page, waiting since `waited` milliseconds ago. */
function park(rt: Runtime, waited = 0, extra: Partial<ParkedRequest> = {}) {
  const settle = vi.fn((_decision: ConditionalDecision) => rt.parkedRequests.delete(parked));
  const parked: ParkedRequest = {
    tabId: 1,
    origin,
    documentId: "password-page",
    since: Date.now() - waited,
    path: "/signin/password",
    named: true,
    settle,
    ...extra,
  };
  rt.parkedRequests.add(parked);
  return { parked, settle };
}
/** The person sent the email page's form `ago` milliseconds ago. */
const stepped = (rt: Runtime, ago = 0) => {
  vi.setSystemTime(Date.now() - ago);
  personStepped(rt, doc("email-page"), "/signin");
  vi.setSystemTime(Date.now() + ago);
};
/** The password page announced with no sign-in. */
const announce = (rt: Runtime, extra: Record<string, unknown> = {}) => {
  rt.documents.set("1:0", top("password-page", "/signin/password", extra) as never);
  personStepNext(rt, doc("password-page"));
};
const named = { kind: "named" };
const handedOn = { kind: "delegate", reason: "no-login", named: true };

beforeEach(() => void vi.useFakeTimers());
afterEach(() => void vi.useRealTimers());

describe("a named request no login took", () => {
  it("is answered as soon as its page announced after the person's step, using it up", () => {
    const rt = runtime();
    stepped(rt);
    const { settle } = park(rt);
    reviewRequests(rt);
    // Not announced yet: it waits.
    expect(settle).not.toHaveBeenCalled();
    announce(rt);
    reviewRequests(rt);
    expect(settle).toHaveBeenCalledWith(named);
    expect(rt.personSteps.size).toBe(0);
    // The next request of the page has no step left.
    const again = park(rt);
    reviewRequests(rt);
    expect(again.settle).toHaveBeenCalledWith(handedOn);
  });

  it.each<[string, (rt: Runtime) => void, Partial<ParkedRequest>?]>([
    ["is still admitted", (rt) => rt.admitting.set("1:0", Promise.resolve())],
    ["announced a sign-in", (rt) => announce(rt, { shownAt: 1 })],
    ["announced another path", (rt) => announce(rt, { path: "/account" })],
    [
      "is another document",
      (rt) => rt.documents.set("1:0", top("other-page", "/signin/password") as never),
    ],
    [
      "is of another origin",
      (rt) =>
        rt.documents.set("1:0", {
          ...top("password-page", "/signin/password"),
          document: doc("password-page", 0, other),
        } as never),
    ],
    ["came on a path it did not tell", (rt) => announce(rt), { path: undefined } as never],
  ])("waits for the bound while its page %s", (_name, set, extra) => {
    const rt = runtime();
    stepped(rt);
    set(rt);
    const { settle } = park(rt, 0, extra);
    reviewRequests(rt);
    expect(settle).not.toHaveBeenCalled();
  });

  it.each<[string, Record<string, unknown>]>([
    ["runs", { state: "executing" }],
    ["is watched for a code", { state: "watching" }],
  ])("is handed on, flagged, at the bound while a login of its tab %s", (_name, metadata) => {
    const rt = runtime();
    stepped(rt);
    announce(rt);
    rt.attempts.set(1, run("sign-in-page", metadata["state"] as string, metadata) as never);
    const early = park(rt);
    reviewRequests(rt);
    expect(early.settle).not.toHaveBeenCalled();
    rt.parkedRequests.clear();
    const { settle } = park(rt, 3_000);
    reviewRequests(rt);
    expect(settle).toHaveBeenCalledWith(handedOn);
  });

  it("is answered when the tab's login is settled or has ended", () => {
    for (const metadata of [{ state: "executing", settled: true }, { state: "blocked" }]) {
      const rt = runtime();
      stepped(rt);
      announce(rt);
      rt.attempts.set(1, run("sign-in-page", metadata.state, metadata) as never);
      const { settle } = park(rt);
      reviewRequests(rt);
      expect(settle).toHaveBeenCalledWith(named);
    }
  });

  it("is handed on once a login of its document ran, even after that login is gone", () => {
    const rt = runtime();
    stepped(rt);
    announce(rt);
    const { settle } = park(rt, 3_000, { during: true });
    reviewRequests(rt);
    expect(settle).toHaveBeenCalledWith(handedOn);
    expect(rt.personSteps.size).toBe(1);
  });

  it("leaves a login of its document that ended before it was seen to decide it", () => {
    const rt = runtime();
    stepped(rt);
    announce(rt);
    rt.attempts.set(1, run("password-page", "blocked") as never);
    const { settle } = park(rt, 3_000);
    reviewRequests(rt);
    expect(settle).toHaveBeenCalledWith({ kind: "delegate", reason: "login-ended" });
  });

  it("is handed on, flagged, with no step of the person, at once or at the bound", () => {
    const rt = runtime();
    announce(rt);
    const announced = park(rt);
    reviewRequests(rt);
    expect(announced.settle).toHaveBeenCalledWith(handedOn);
    rt.documents.clear();
    const silent = park(rt);
    reviewRequests(rt);
    expect(silent.settle).not.toHaveBeenCalled();
    vi.advanceTimersByTime(3_000);
    reviewRequests(rt);
    expect(silent.settle).toHaveBeenCalledWith(handedOn);
  });
});

describe("the person's own sign-in step a request follows", () => {
  const request = (documentId: string, path: string | null = "/signin/password") => ({
    tabId: 1,
    origin,
    documentId,
    ...(path === null ? {} : { path }),
    since: Date.now(),
  });

  it("is the tab's latest on the origin, less than a minute before", () => {
    const rt = runtime();
    stepped(rt, 59_999);
    expect(personStepFor(rt, request("password-page"))).toBeDefined();
    stepped(rt, 60_000);
    expect(personStepFor(rt, request("password-page"))).toBeUndefined();
    // A clock set back counts nothing.
    stepped(rt, -1);
    expect(personStepFor(rt, request("password-page"))).toBeUndefined();
    // Another origin's, or another tab's, is none.
    stepped(rt);
    expect(personStepFor(rt, { ...request("password-page"), origin: other })).toBeUndefined();
    expect(personStepFor(rt, { ...request("password-page"), tabId: 2 })).toBeUndefined();
  });

  it("is followed by the next top document of its origin only", () => {
    const rt = runtime();
    stepped(rt);
    // A frame, another origin's page and the step's own page are no next document.
    personStepNext(rt, doc("frame", 3));
    personStepNext(rt, doc("elsewhere", 0, other));
    personStepNext(rt, doc("email-page"));
    personStepNext(rt, doc("password-page"));
    personStepNext(rt, doc("later-page"));
    expect(personStepFor(rt, request("later-page"))).toBeUndefined();
    expect(personStepFor(rt, request("password-page"))).toBeDefined();
    // A request of a document no other followed the step with is that next one.
    const asked = runtime();
    stepped(asked);
    expect(personStepFor(asked, request("password-page"))).toBeDefined();
    expect(personStepFor(asked, request("later-page"))).toBeUndefined();
  });

  it("is in the request's own document only on another, known path", () => {
    const rt = runtime();
    stepped(rt);
    expect(personStepFor(rt, request("email-page", "/signin/password"))).toBeDefined();
    expect(personStepFor(rt, request("email-page", "/signin/"))).toBeUndefined();
    expect(personStepFor(rt, request("email-page", null))).toBeUndefined();
  });

  it("is never a frame's, and a newer step replaces it", () => {
    const rt = runtime();
    personStepped(rt, doc("frame", 3), "/pay");
    expect(rt.personSteps.size).toBe(0);
    stepped(rt);
    personStepNext(rt, doc("password-page"));
    personStepped(rt, doc("password-page"), "/signin/password");
    expect(rt.personSteps.get(`1 ${origin}`)).toEqual({
      documentId: "password-page",
      path: "/signin/password",
      at: Date.now(),
    });
  });
});

describe("a path where a recipe starts", () => {
  it("is a start, a later step, a sign-in entry or a route's first page", async () => {
    const routes = async () => [{ steps: [{ path: "/verify" }] }];
    for (const path of ["/signin", "/signin/next", "/welcome", "/verify"])
      // eslint-disable-next-line no-await-in-loop
      expect(await recipeOnPath(runtime({ routes }), origin, path)).toBe(true);
    expect(await recipeOnPath(runtime({ routes }), origin, "/signin/password")).toBe(false);
  });

  it("is any path when the path or the origin's recipes cannot be read", async () => {
    const failed = async () => Promise.reject(new Error("unreadable"));
    expect(await recipeOnPath(runtime(), origin, undefined)).toBe(true);
    for (const options of [{ starts: failed }, { entries: failed }, { routes: failed }])
      // eslint-disable-next-line no-await-in-loop
      expect(await recipeOnPath(runtime(options), origin, "/signin/password")).toBe(true);
  });
});

describe("a login of the tab a named request leaves its answer to", () => {
  it("runs or is watched, and is not one that ended or settled", () => {
    const rt = runtime();
    expect(tabLoginRuns(rt, 1)).toBe(false);
    for (const [metadata, runs] of [
      [{ state: "executing" }, true],
      [{ state: "watching" }, true],
      [{ state: "executing", settled: true }, false],
      [{ state: "authenticated" }, false],
      [{ state: "blocked" }, false],
    ] as const) {
      rt.attempts.set(1, run("page", metadata.state, metadata) as never);
      expect(tabLoginRuns(rt, 1)).toBe(runs);
    }
  });
});

describe("a passkey sign-in of the tab outside a login", () => {
  const answered = (rt: Runtime) =>
    rt.passkeyAnswers.set(`1 ${origin}`, {
      at: 1,
      rpId: "login.example",
      signedIn: "password-page",
    });

  it("is marked only for an answer outside a running login", async () => {
    const rt = runtime();
    rt.attempts.set(1, run("password-page", "executing") as never);
    passkeyAnswered(rt, 1, origin, "login.example", undefined, {
      incognito: false,
      documentId: "password-page",
    });
    expect(rt.passkeyAnswers.get(`1 ${origin}`)?.signedIn).toBeUndefined();
    expect(await passkeyReverification(rt, 1, origin, "account", true)).toBe(false);
    rt.attempts.clear();
    passkeyAnswered(rt, 1, origin, "login.example", undefined, {
      incognito: false,
      documentId: "password-page",
    });
    expect(await passkeyReverification(rt, 1, origin, "account", true)).toBe(true);
    expect(await passkeyReverification(rt, 1, origin, "account")).toBe(false);
  });

  it("holds for the tab's other pages until a recipe's first step shows again", () => {
    const rt = runtime();
    answered(rt);
    expect(passkeySignedIn(rt, 1, origin, "account-page")).toBe(true);
    expect(passkeySignedIn(rt, 1, origin, "password-page")).toBe(false);
    expect(passkeySignedIn(rt, 2, origin, "account-page")).toBe(false);
    // The page it signed in showing a start keeps it, as the answer's own page.
    passkeySignInLeft(rt, doc("password-page"));
    expect(passkeySignedIn(rt, 1, origin, "account-page")).toBe(true);
    // Another top page shows a start while the tab's known top page is still that page.
    rt.documents.set("1:0", top("password-page", "/signin/password") as never);
    passkeySignInLeft(rt, doc("frame", 3));
    expect(passkeySignedIn(rt, 1, origin, "account-page")).toBe(true);
    passkeySignInLeft(rt, doc("sign-in-again"));
    expect(passkeySignedIn(rt, 1, origin, "account-page")).toBe(false);
    expect(rt.passkeyAnswers.get(`1 ${origin}`)).toEqual({ at: 1, rpId: "login.example" });
  });
});
