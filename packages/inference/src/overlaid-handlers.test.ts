import type { LoginObservation, LoginStep, ObservedCandidate } from "@pateat/contracts";
import { describe, expect, it } from "vitest";
import { validateAccountList } from "./account-list";
import { addHandler, appendPageSteps } from "./assemble";
import { createCompletionJudge } from "./completion";
import { textModel, textResult } from "./testing/fake-models";

// Only a plan's action may be a click layer named by the text laid over it (ADR 0090): no
// handler, code or detail submit, and no passkey button beside an account list, is one.
// Synthetic pages only.
const origin = "https://bank.example";
const id = (value: string) => ({ by: "id", value }) as const;
const button = (name: string, label: string, overlaid?: true): ObservedCandidate => ({
  id: name,
  role: "button",
  target: id(name),
  label,
  ...(overlaid ? { overlaid } : {}),
});
const page = (path: string, candidates: ObservedCandidate[]): LoginObservation => ({
  version: 1,
  origin,
  path,
  language: "en",
  title: "Two-factor authentication",
  headings: ["Confirm it's you"],
  complete: true,
  candidates,
});

const judge = (observation: LoginObservation, result: Record<string, unknown>) =>
  createCompletionJudge({
    model: textModel(async () => textResult(JSON.stringify({ result }))),
    limits: { timeoutMs: 1_000, maxInputBytes: 16_384 },
    maxOutputTokens: 512,
  })({ observation, loginPaths: ["/login"] });

describe("a challenge judgement naming a click layer", () => {
  const choices = (overlaid?: true) =>
    page("/login/verify", [
      button("key", "Use security key", overlaid),
      button("choose-password", "Password", overlaid),
      button("app", "Authenticator app", overlaid),
    ]);
  const named = {
    decision: "challenge",
    passkeyButton: "key",
    passwordButton: "choose-password",
    authenticatorButton: "app",
  };

  it("adds no passkey, password or authenticator handler for it", async () => {
    expect(await judge(choices(true), named)).toEqual(
      expect.objectContaining({ status: "ok", value: { decision: "challenge" } }),
    );
    // The same buttons drawn as buttons each get one.
    expect(await judge(choices(), named)).toMatchObject({
      status: "ok",
      value: {
        decision: "challenge",
        passkey: id("key"),
        password: id("choose-password"),
        authenticator: id("app"),
      },
    });
  });

  it("drops a code whose submit is a click layer", async () => {
    const code = {
      id: "code",
      role: "text",
      target: id("otp"),
      label: "Code",
      inputMode: "numeric",
      maxLength: 6,
      group: "form-1",
    } as const;
    const answer = {
      decision: "challenge",
      code: { field: "code", submit: "verify", source: "authenticator-app" },
    };
    const layer = { ...button("verify", "Verify", true), group: "form-1" };
    expect(await judge(page("/two-factor", [code, layer]), answer)).toEqual(
      expect.objectContaining({
        status: "ok",
        value: { decision: "challenge", totpDropped: "click-layer" },
      }),
    );
    const { overlaid: _, ...plain } = layer;
    expect(await judge(page("/two-factor", [code, plain]), answer)).toMatchObject({
      value: { totp: { field: id("otp"), target: id("verify") } },
    });
  });

  it("drops every detail whose submit is a click layer", async () => {
    const birth = {
      id: "birth",
      role: "text",
      target: id("birth_ym"),
      label: "Year and month of birth",
      inputMode: "numeric",
      maxLength: 6,
      group: "form-1",
    } as const;
    const phone = {
      id: "phone",
      role: "tel",
      target: { by: "name", value: "tel_last4" },
      label: "Last 4 digits of your phone",
      maxLength: 4,
      group: "form-1",
    } as const;
    const answer = {
      decision: "challenge",
      details: [
        { field: "birth", value: "birth-date", format: "yyyymm" },
        { field: "phone", value: "phone-last-4" },
      ],
      detailSubmit: "next",
    };
    const layer = { ...button("next", "Next", true), group: "form-1" };
    expect(await judge(page("/login/confirm", [birth, phone, layer]), answer)).toEqual(
      expect.objectContaining({
        status: "ok",
        value: { decision: "challenge", detailsDropped: ["click-layer", "click-layer"] },
      }),
    );
    const { overlaid: _, ...plain } = layer;
    expect(await judge(page("/login/confirm", [birth, phone, plain]), answer)).toMatchObject({
      value: { detail: { target: id("next") } },
    });
  });
});

describe("a handler whose button is only a click layer", () => {
  const steps: LoginStep[] = [
    { kind: "fill", path: "/login", effect: "prepare", fields: [{ slot: "pw", target: id("pw") }] },
    { kind: "click", path: "/login", target: id("sign-in"), purpose: "submit" },
  ];
  const built = appendPageSteps(undefined, { pageKind: "sign-in", id: "gen-1", origin, steps });
  if (!built.ok) throw new Error(built.reason);
  const recipe = built.recipe;
  const code = { id: "code", role: "text", target: id("otp"), maxLength: 6 } as const;

  it.each([
    ["passkey", "Use security key"],
    ["password", "Password"],
    ["authenticator", "Authenticator app"],
  ] as const)("adds no %s handler for it", (kind, label) => {
    const handler = { kind, target: id("key") };
    expect(addHandler(recipe, page("/mfa", [button("key", label, true)]), handler)).toEqual({
      ok: false,
      reason: "not-on-page",
    });
    expect(addHandler(recipe, page("/mfa", [button("key", label)]), handler).ok).toBe(true);
  });

  it("adds no totp or detail handler submitted by it", () => {
    const layered = page("/mfa", [code, button("verify", "Verify", true)]);
    expect(
      addHandler(recipe, layered, { kind: "totp", field: id("otp"), target: id("verify") }),
    ).toEqual({ ok: false, reason: "not-on-page" });
    expect(
      addHandler(recipe, layered, {
        kind: "detail",
        fields: [{ detail: "phone-last-4", target: id("otp") }],
        target: id("verify"),
      }),
    ).toEqual({ ok: false, reason: "not-on-page" });
    // The same button drawn as a button takes the handler.
    const plain = page("/mfa", [code, button("verify", "Verify")]);
    expect(
      addHandler(recipe, plain, { kind: "totp", field: id("otp"), target: id("verify") }).ok,
    ).toBe(true);
  });
});

describe("a passkey button beside an account list that is a click layer", () => {
  const list = (overlaid?: true): LoginObservation => ({
    ...page("/choose", [
      { id: "other", role: "button", target: id("other"), label: "Use another account" },
      button("passkey", "Sign in with a passkey", overlaid),
    ]),
    accounts: ["[email] Last used"],
  });

  it("is dropped, and the list kept", () => {
    expect(validateAccountList(list(true), { other: "other", passkeyButton: "passkey" })).toEqual({
      ok: true,
      list: { accountList: true, other: { candidate: "other", target: id("other") } },
    });
    expect(validateAccountList(list(), { other: "other", passkeyButton: "passkey" })).toEqual({
      ok: true,
      list: {
        accountList: true,
        other: { candidate: "other", target: id("other") },
        passkey: { candidate: "passkey", target: id("passkey") },
      },
    });
  });
});
