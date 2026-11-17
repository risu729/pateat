import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ConditionalDecision } from "../../passkeys/runtime";
import type { ParkedRequest } from "./types";
import type { Runtime } from "./state";

vi.mock("wxt/browser", () => ({ browser: {} }));
const { reviewRequests } = await import("./passkey");
const { followsSignIn, passkeySignInLeft, passkeySignedIn, recipeOnPath } =
  await import("./passkey-named");

// The rules of a conditional request that names its credentials on a path where no recipe
// starts (ADR 0034 amendment of 2026-11-17, #1673), read on a runtime built by hand.
const origin = "https://login.example";
const top = (documentId: string, path: string, extra: Record<string, unknown> = {}) => ({
  document: { origin, tabId: 1, frameId: 0, documentId },
  url: `${origin}${path}`,
  path,
  ...extra,
});
const run = (documentId: string, state: string) => ({
  live: { document: { origin, tabId: 1, frameId: 0, documentId } },
  metadata: { account: { origin }, state },
});
const start = (path: string, later: string[] = []) => ({
  path,
  steps: [],
  ...(later.length ? { later: later.map((step) => ({ path: step })) } : {}),
});
function runtime(
  options: {
    starts?: () => Promise<unknown[]>;
    entries?: () => Promise<unknown[]>;
    routes?: () => Promise<unknown[]>;
  } = {},
) {
  return {
    vars: { loaded: Promise.resolve() },
    attempts: new Map(),
    pending: new Map(),
    picked: new Map(),
    choicePasskeys: new Map(),
    documents: new Map(),
    persisted: new Map(),
    sso: { flows: new Map() },
    parkedRequests: new Set<ParkedRequest>(),
    admitting: new Map(),
    afterSignIn: new Map(),
    signInSubmits: new Map(),
    passkeyAnswers: new Map(),
    recipes: {
      starts: vi.fn(options.starts ?? (async () => [start("/signin", ["/signin/next"])])),
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
/** The password page announced with no sign-in, after the tab's sign-in page. */
const announce = (rt: Runtime, extra: Record<string, unknown> = {}) =>
  rt.documents.set(
    "1:0",
    top("password-page", "/signin/password", {
      previousUrl: `${origin}/signin`,
      ...extra,
    }) as never,
  );

beforeEach(() => void vi.useFakeTimers());
afterEach(() => void vi.useRealTimers());

describe("a named request no login took", () => {
  it("is decided as soon as its page announced with no sign-in, not after a wait", async () => {
    const rt = runtime();
    const { settle } = park(rt);
    reviewRequests(rt);
    await vi.advanceTimersByTimeAsync(0);
    // Not announced yet: it waits.
    expect(settle).not.toHaveBeenCalled();
    announce(rt);
    reviewRequests(rt);
    await vi.advanceTimersByTimeAsync(0);
    expect(settle).toHaveBeenCalledWith({ kind: "named" });
  });

  it.each<[string, (rt: Runtime) => void]>([
    ["is still admitted", (rt) => rt.admitting.set("1:0", Promise.resolve())],
    ["announced a sign-in", (rt) => announce(rt, { shownAt: 1 })],
    ["announced another path", (rt) => announce(rt, { path: "/account" })],
    [
      "is another document",
      (rt) => rt.documents.set("1:0", top("other-page", "/signin/password") as never),
    ],
  ])("waits for the bound while its page %s", async (_name, set) => {
    const rt = runtime();
    announce(rt);
    set(rt);
    const { settle } = park(rt);
    reviewRequests(rt);
    await vi.advanceTimersByTimeAsync(0);
    expect(settle).not.toHaveBeenCalled();
  });

  it("is handed on, flagged, at the bound while a login of its tab runs", async () => {
    const rt = runtime();
    announce(rt);
    rt.attempts.set(1, run("sign-in-page", "executing") as never);
    const { settle } = park(rt, 3_000);
    reviewRequests(rt);
    await vi.advanceTimersByTimeAsync(0);
    expect(settle).toHaveBeenCalledWith({ kind: "delegate", reason: "no-login", named: true });
  });

  it("is handed on once a login of its document ran, even after that login is gone", async () => {
    const rt = runtime();
    announce(rt);
    const { settle } = park(rt, 3_000, { during: true });
    reviewRequests(rt);
    await vi.advanceTimersByTimeAsync(0);
    expect(settle).toHaveBeenCalledWith({ kind: "delegate", reason: "no-login", named: true });
  });

  it("leaves a login of its document that ended before it was seen to decide it", async () => {
    const rt = runtime();
    announce(rt);
    rt.attempts.set(1, run("password-page", "blocked") as never);
    const { settle } = park(rt, 3_000);
    reviewRequests(rt);
    await vi.advanceTimersByTimeAsync(0);
    expect(settle).toHaveBeenCalledWith({ kind: "delegate", reason: "login-ended" });
  });

  it("is handed on, flagged, when its page follows no sign-in step", async () => {
    const rt = runtime();
    announce(rt, { previousUrl: `${origin}/help` });
    const { settle } = park(rt);
    reviewRequests(rt);
    await vi.advanceTimersByTimeAsync(0);
    expect(settle).toHaveBeenCalledWith({ kind: "delegate", reason: "no-login", named: true });
  });
});

describe("a page that follows the person's sign-in step", () => {
  const follows = async (rt: Runtime, previous?: string) => {
    announce(rt, previous === undefined ? { previousUrl: undefined } : { previousUrl: previous });
    return followsSignIn(rt, park(rt).parked);
  };

  it("comes after a recipe's start, a later step or a sign-in entry of the origin", async () => {
    expect(await follows(runtime(), `${origin}/signin`)).toBe(true);
    expect(await follows(runtime(), `${origin}/signin/next`)).toBe(true);
    expect(await follows(runtime(), `${origin}/welcome/`)).toBe(true);
    expect(await follows(runtime(), `${origin}/help`)).toBe(false);
    // Another origin's page, or none, is no step of this one.
    expect(await follows(runtime(), "https://other.example/signin")).toBe(false);
    expect(await follows(runtime())).toBe(false);
  });

  it("is the page after a sign-in form the person submitted", async () => {
    const rt = runtime();
    rt.afterSignIn.set(1, "password-page");
    expect(await follows(rt, `${origin}/help`)).toBe(true);
  });

  it("is none when the origin's starts or entries cannot be read", async () => {
    const failed = async () => Promise.reject(new Error("unreadable"));
    expect(await follows(runtime({ starts: failed }), `${origin}/signin`)).toBe(false);
    expect(await follows(runtime({ entries: failed }), `${origin}/welcome`)).toBe(false);
  });

  it("is none before its page announced", async () => {
    expect(await followsSignIn(runtime(), park(runtime()).parked)).toBe(false);
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

describe("a passkey sign-in of the tab outside a login", () => {
  const answered = (rt: Runtime) =>
    rt.passkeyAnswers.set(`1 ${origin}`, {
      at: 1,
      rpId: "login.example",
      signedIn: "password-page",
    });

  it("holds for the tab's other pages until a recipe's first step shows again", () => {
    const rt = runtime();
    answered(rt);
    expect(passkeySignedIn(rt, 1, origin, "account-page")).toBe(true);
    expect(passkeySignedIn(rt, 1, origin, "password-page")).toBe(false);
    expect(passkeySignedIn(rt, 2, origin, "account-page")).toBe(false);
    // The page it signed in showing a start keeps it, as the answer's own page.
    passkeySignInLeft(rt, { origin, tabId: 1, frameId: 0, documentId: "password-page" });
    expect(passkeySignedIn(rt, 1, origin, "account-page")).toBe(true);
    // A frame of that page too.
    rt.documents.set("1:0", top("password-page", "/signin/password") as never);
    passkeySignInLeft(rt, { origin, tabId: 1, frameId: 3, documentId: "frame" });
    expect(passkeySignedIn(rt, 1, origin, "account-page")).toBe(true);
    passkeySignInLeft(rt, { origin, tabId: 1, frameId: 0, documentId: "sign-in-again" });
    expect(passkeySignedIn(rt, 1, origin, "account-page")).toBe(false);
    expect(rt.passkeyAnswers.get(`1 ${origin}`)).toEqual({ at: 1, rpId: "login.example" });
  });
});
