import { describe, expect, it } from "vitest";
import {
  attemptRouteChoice,
  createAttemptMetadata,
  parseAttemptMetadata,
  transitionLoginAttempt,
} from "./login-attempt";
import type { LoginRecipe } from "./login";

const document = {
  origin: "https://rp.example.test",
  tabId: 7,
  frameId: 0,
  documentId: "rp-document",
};
const account = { origin: document.origin, connectionId: "rp-vault", itemId: "rp-item" };
const timing = { since: 1, serviceMs: 0, networkMs: 0, personMs: 0, pageMs: 0 };
const facts = { password: false, totp: false, passkey: false, discoverablePasskey: false };
const parent = () => ({
  version: 1,
  id: "sso-parent",
  recipeId: "synthetic-sso",
  recipeRevision: 2,
  layout: "1000",
  policyRevision: 3,
  account,
  route: "sso",
  ssoParent: true,
  facts,
  handlers: [],
  document,
  state: "reconciling",
  stepIndex: 0,
  stepCount: 1,
  submissions: 1,
  maxSubmissions: 1,
  retries: 0,
  maxRetries: 2,
  usedOperationIds: [],
  timing,
});
const nativeRecipe: LoginRecipe = {
  version: 1,
  id: "synthetic-native",
  revision: 1,
  origin: document.origin,
  pageKind: "sign-in",
  slots: ["password"],
  steps: [
    {
      kind: "fill",
      effect: "prepare",
      path: "/signin",
      fields: [{ slot: "password", target: { by: "id", value: "password" } }],
    },
    { kind: "click", path: "/signin", target: { by: "id", value: "submit" }, purpose: "submit" },
  ],
  maxSubmissions: 1,
  completion: [{ target: { by: "id", value: "authenticated" } }],
};
const native = () =>
  createAttemptMetadata({
    id: "native-attempt",
    timing,
    recipe: nativeRecipe,
    policyRevision: 3,
    account,
    choice: { route: "password", variant: 0 },
    facts: { ...facts, password: true },
    document,
  });

describe("diagnostic SSO parent metadata", () => {
  it("records an explicit top-level parent while it waits for positive RP evidence", () => {
    const value = parent();
    expect(parseAttemptMetadata(value)).toEqual(value);
    expect(value.account.origin).toBe(document.origin);
    expect(() => attemptRouteChoice(parseAttemptMetadata(value))).toThrow("SSO parent");
  });
  it.each([
    { state: "authenticated", outcome: "authenticated" },
    { state: "blocked", outcome: "cancelled" },
  ])(
    "records the coordinator's $state result without acquiring native execution state",
    (result) => {
      const value = { ...parent(), ...result };
      expect(parseAttemptMetadata(value)).toEqual(value);
      expect(() => attemptRouteChoice(parseAttemptMetadata(value))).toThrow("SSO parent");
    },
  );
  it.each([
    { ssoParent: undefined },
    { ssoParent: false },
    { variant: 0 },
    { handlers: [{ index: 0, start: 0 }] },
    { chooser: { click: "entry" } },
    { usedOperationIds: ["native-operation"] },
    {
      operationId: "native-operation",
      operationKind: "click",
      usedOperationIds: ["native-operation"],
    },
    { mutationIntent: true },
    { fillOnly: true },
    { signInFill: true },
    { document: { ...document, frameId: 1 } },
    { stepCount: 2 },
    { stepIndex: 1 },
    { state: "ready" },
    { state: "executing" },
    { state: "submit-intent" },
    { state: "awaiting-result" },
    { watch: { since: 1, documentId: document.documentId, pages: 0, path: "/signin" } },
  ])("refuses native authority grafted onto parent metadata %#", (changed) => {
    expect(() => parseAttemptMetadata({ ...parent(), ...changed })).toThrow();
  });
  it("does not reinterpret a native login as an SSO parent merely by changing its route", () => {
    expect(() => parseAttemptMetadata({ ...native(), route: "sso" })).toThrow();
    expect(() => parseAttemptMetadata({ ...native(), ssoParent: true })).toThrow();
  });
  it.each([
    { type: "RESOLVE" },
    { type: "PREPARE", operationId: "native-operation", kind: "click" },
    { type: "ROUTE", route: "password", steps: 1 },
    { type: "OBSERVED", state: "authenticated" },
  ])("never sends a parent through a native transition: $type", (event) => {
    expect(() => transitionLoginAttempt(parseAttemptMetadata(parent()), event)).toThrow(
      "SSO parent",
    );
  });
  it("keeps SSO out of native route transition events", () => {
    const ready = transitionLoginAttempt(native(), { type: "RESOLVE" });
    expect(() =>
      transitionLoginAttempt(ready, { type: "ROUTE", route: "sso", steps: 1 }),
    ).toThrow();
  });
});
