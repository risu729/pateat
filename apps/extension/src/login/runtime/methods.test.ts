import type { LoginAttemptMetadata } from "@pateat/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
const session = vi.hoisted(() => new Map<string, unknown>());
vi.mock("wxt/utils/storage", () => ({
  storage: {
    getItem: async (key: string) => session.get(key) ?? null,
    setItem: async (key: string, value: unknown) => void session.set(key, value),
  },
}));
import { RESULT_CORRECTION_MS } from "./constants";
import {
  methodRouteChanged,
  methodsCorrected,
  methodUsed,
  loadMethods,
  openMethods,
  restoreMethods,
  takeMethods,
} from "./methods";
import type { LoginReport } from "./report";
import type { Runtime } from "./state";

function runtime() {
  const reports: LoginReport[] = [];
  const report = (entry: LoginReport) => {
    reports.push(entry);
  };
  const rt = { options: { report } } as unknown as Runtime;
  return { rt, reports };
}

function ended(
  id: string,
  route: LoginAttemptMetadata["route"],
  state: "authenticated" | "blocked" = "authenticated",
): LoginAttemptMetadata {
  return {
    id,
    route,
    state,
    outcome: state === "authenticated" ? "authenticated" : "challenge",
    recipeId: "gen-0123456789abcdef0123456789abcdef",
    recipeRevision: 4,
    layout: "1760000000000",
    document: { tabId: 7, frameId: 0, documentId: "doc", origin: "https://bank.example" },
  } as LoginAttemptMetadata;
}

describe("sign-in methods of a login (ADR 0055, amended 2026-11-18)", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("names a passkey the login used on its password route, and warns of nothing", () => {
    const { rt, reports } = runtime();
    openMethods(rt, "a", ["passkey", "password"]);
    methodUsed(rt, "a", "passkey");
    expect(takeMethods(rt, ended("a", "password"))).toEqual({
      route: "password",
      used: "passkey",
      held: "passkey.password",
    });
    vi.advanceTimersByTime(RESULT_CORRECTION_MS);
    expect(reports).toEqual([]);
    // Taken once: a later report of the same login names none.
    expect(takeMethods(rt, ended("a", "password"))).toBeUndefined();
  });

  it("warns once the second factor can no longer come after a password over a passkey", () => {
    const { rt, reports } = runtime();
    openMethods(rt, "a", ["passkey", "password"]);
    methodUsed(rt, "a", "password");
    expect(takeMethods(rt, ended("a", "password"))).toEqual({
      route: "password",
      used: "password",
      held: "passkey.password",
      why: "no-passkey-route",
    });
    expect(reports).toEqual([]);
    vi.advanceTimersByTime(RESULT_CORRECTION_MS);
    expect(reports).toEqual([
      {
        type: "route",
        tabId: 7,
        origin: "https://bank.example",
        recipeId: "gen-0123456789abcdef0123456789abcdef",
        recipeRevision: 4,
        layout: "1760000000000",
        route: "password",
        used: "password",
        held: "passkey.password",
        why: "no-passkey-route",
        outcome: "authenticated",
      },
    ]);
  });

  it("leaves the warning out when the passkey came as the second factor", () => {
    const { rt, reports } = runtime();
    openMethods(rt, "a", ["passkey", "password"]);
    methodUsed(rt, "a", "password");
    takeMethods(rt, ended("a", "password"));
    methodUsed(rt, "a", "passkey");
    vi.advanceTimersByTime(RESULT_CORRECTION_MS);
    expect(reports).toEqual([]);
  });

  it("warns at once of a login that did not sign in, with the route change that made it", () => {
    const { rt, reports } = runtime();
    openMethods(rt, "a", ["passkey", "password"]);
    methodRouteChanged(rt, "a", "answer-failed");
    methodUsed(rt, "a", "password");
    expect(takeMethods(rt, ended("a", "password", "blocked"))?.why).toBe("answer-failed");
    expect(reports).toMatchObject([{ type: "route", why: "answer-failed", outcome: "challenge" }]);
  });

  it("warns of a passkey-held login that went on with a code alone", () => {
    const { rt, reports } = runtime();
    openMethods(rt, "a", ["passkey"]);
    expect(takeMethods(rt, ended("a", "password", "blocked"))).toEqual({
      route: "password",
      used: "none",
      held: "passkey",
      why: "no-passkey-route",
    });
    expect(reports).toMatchObject([{ why: "no-passkey-route", used: "none" }]);
  });

  it("records the person's choice and settings, and warns of none of them", () => {
    const { rt, reports } = runtime();
    openMethods(rt, "a", ["passkey", "password"], { picked: true });
    methodUsed(rt, "a", "password");
    expect(takeMethods(rt, ended("a", "password"))?.why).toBe("picked");
    openMethods(rt, "b", ["passkey", "password"], { signInFill: true });
    expect(takeMethods(rt, ended("b", "password"))?.why).toBe("sign-in-fill");
    openMethods(rt, "c", ["sso", "password"]);
    methodUsed(rt, "c", "password");
    expect(takeMethods(rt, ended("c", "password"))?.why).toBe("sso-not-automatic");
    vi.advanceTimersByTime(RESULT_CORRECTION_MS);
    expect(reports).toEqual([]);
  });

  it("names why an SSO login or a later start passed over the passkey", () => {
    const { rt, reports } = runtime();
    openMethods(rt, "a", ["passkey", "sso", "password"], { passkeyRefused: true }, ["sso"]);
    expect(takeMethods(rt, ended("a", "sso"))).toEqual({
      route: "sso",
      used: "sso",
      held: "passkey.sso.password",
      why: "passkey-refused",
    });
    openMethods(rt, "b", ["passkey", "password"], { later: true });
    methodUsed(rt, "b", "password");
    expect(takeMethods(rt, ended("b", "password", "blocked"))?.why).toBe("later-start");
    vi.advanceTimersByTime(RESULT_CORRECTION_MS);
    expect(reports.map((report) => "why" in report && report.why)).toEqual([
      "later-start",
      "passkey-refused",
    ]);
  });

  it("warns of no passkey route that ended before its answer, nor of a cancel", () => {
    const { rt, reports } = runtime();
    openMethods(rt, "a", ["passkey", "password"]);
    expect(takeMethods(rt, ended("a", "passkey", "blocked"))?.why).toBe("not-answered");
    openMethods(rt, "b", ["passkey", "password"]);
    methodUsed(rt, "b", "password");
    expect(
      takeMethods(rt, { ...ended("b", "password", "blocked"), outcome: "cancelled" })?.why,
    ).toBe("no-passkey-route");
    expect(reports).toEqual([]);
  });

  it("warns of no login that went on after its passkey button and ended before the answer", () => {
    const { rt, reports } = runtime();
    openMethods(rt, "a", ["passkey", "password"]);
    // The switch to the step asking for the account moves the login to that layout's
    // password route, with no password typed (ADR 0060 amendment of 2026-11-18).
    expect(
      takeMethods(rt, { ...ended("a", "password", "blocked"), passkeyButton: true })?.why,
    ).toBe("not-answered");
    expect(reports).toEqual([]);
  });

  it("keeps the worker up for a held warning, and names nothing for an item with no method", async () => {
    const { rt } = runtime();
    const kept: Promise<void>[] = [];
    rt.options.keepAlive = (work) => {
      kept.push(work);
    };
    openMethods(rt, "a", ["passkey", "password"]);
    methodUsed(rt, "a", "password");
    takeMethods(rt, ended("a", "password"));
    expect(kept).toHaveLength(1);
    vi.advanceTimersByTime(RESULT_CORRECTION_MS);
    await expect(kept[0]).resolves.toBeUndefined();
    openMethods(rt, "b", []);
    expect(takeMethods(rt, ended("b", "password"))).toBeUndefined();
  });

  it("names the corrected outcome of a warning still held", () => {
    const { rt, reports } = runtime();
    openMethods(rt, "a", ["passkey", "password"]);
    methodUsed(rt, "a", "password");
    takeMethods(rt, ended("a", "password"));
    methodsCorrected(rt, { ...ended("a", "password", "blocked"), outcome: "credential-rejected" });
    vi.advanceTimersByTime(RESULT_CORRECTION_MS);
    expect(reports).toMatchObject([{ outcome: "credential-rejected" }]);
  });

  it("names the methods a stopped worker kept for a login it left (USI, 2026-11-18)", async () => {
    session.clear();
    const stopped = runtime();
    openMethods(stopped.rt, "a", ["passkey", "password"], { later: true });
    methodUsed(stopped.rt, "a", "password");
    openMethods(stopped.rt, "ended", ["password"]);
    await vi.waitFor(() => expect(session.get("session:pateat.login-methods.v1")).toHaveLength(2));
    const { rt } = runtime();
    loadMethods(rt);
    // A login this worker opened before the restore keeps its own methods, and its write
    // does not lose the stopped worker's.
    openMethods(rt, "b", ["password"]);
    await vi.waitFor(() => expect(session.get("session:pateat.login-methods.v1")).toHaveLength(1));
    await restoreMethods(rt, new Set(["a", "b"]));
    // Nor does it stay in storage.
    await vi.waitFor(() =>
      expect(
        (session.get("session:pateat.login-methods.v1") as { attemptId: string }[]).map(
          (entry) => entry.attemptId,
        ),
      ).toEqual(["a", "b"]),
    );
    expect(takeMethods(rt, ended("a", "password", "blocked"))).toEqual({
      route: "password",
      used: "password",
      held: "passkey.password",
      why: "later-start",
    });
    expect(takeMethods(rt, ended("b", "password"))).toMatchObject({ used: "none" });
    // One whose record is gone, or ended, is not restored.
    expect(takeMethods(rt, ended("ended", "password"))).toBeUndefined();
  });

  it("names nothing for a login it does not keep", () => {
    const { rt, reports } = runtime();
    methodUsed(rt, "a", "password");
    expect(takeMethods(rt, ended("a", "password"))).toBeUndefined();
    expect(reports).toEqual([]);
  });
});
