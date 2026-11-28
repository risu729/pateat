import {
  builtInLoginSlots,
  loginObservationSchema,
  type LoginObservation,
  type ObservedCandidate,
} from "@pateat/contracts";
import * as v from "valibot";
import { describe, expect, it } from "vitest";
import { validateGeneratedPage, validatePagePlan } from "./plan";

// A click layer named by the text laid over it (ADR 0090): a synthetic page shaped like
// UNSW Endeavour's sign-in dialog, with no form or button, whose "log on" is a layer.
const layer = (id: string, label: string, extra: Partial<ObservedCandidate> = {}) =>
  ({
    id,
    role: "button",
    target: { by: "id", value: `${id}:areaElement` },
    label,
    overlaid: true,
    ...extra,
  }) as const satisfies ObservedCandidate;
const page = (...extra: ObservedCandidate[]): LoginObservation =>
  v.parse(loginObservationSchema, {
    version: 1,
    origin: "https://sign-in.example.test",
    path: "/Apps/Endeavour/",
    language: "en",
    complete: true,
    candidates: [
      {
        id: "c1",
        role: "text",
        target: { by: "id", value: "232:credentialElement" },
        autocomplete: "username",
      },
      {
        id: "c2",
        role: "password",
        target: { by: "id", value: "240:credentialElement" },
        autocomplete: "current-password",
      },
      layer("274", "log on"),
      layer("259", "exit"),
      ...extra,
    ],
  });
const slots = [builtInLoginSlots.username, builtInLoginSlots.password];
const fields = [
  { slot: "username", candidate: "c1" },
  { slot: "password", candidate: "c2" },
];
const logOn = { candidate: "274", purpose: "submit" } as const;

describe("a plan whose action is a click layer", () => {
  it("clicks it with the text laid over it as `shows`", () => {
    const result = validatePagePlan(page(), slots, { fields, action: logOn });
    if (!result.ok) throw new Error(result.reason);
    expect(result.plan.steps.at(-1)).toEqual({
      kind: "click",
      path: "/Apps/Endeavour/",
      target: { by: "id", value: "274:areaElement" },
      purpose: "submit",
      shows: "log on",
    });
    // A button that is no layer gets none.
    const plain = validatePagePlan(
      page({ id: "c9", role: "button", target: { by: "id", value: "go" }, label: "log on" }),
      slots,
      { fields, action: { candidate: "c9", purpose: "submit" } },
    );
    if (!plain.ok) throw new Error(plain.reason);
    expect(plain.plan.steps.at(-1)).not.toHaveProperty("shows");
  });

  it("refuses a layer named by its text or without a label", () => {
    const text = layer("c9", "log on", { target: { by: "text", value: "log on" } });
    expect(
      validatePagePlan(page(text), slots, {
        fields,
        action: { candidate: "c9", purpose: "submit" },
      }),
    ).toEqual({ ok: false, reason: "incompatible-role" });
    // An observation that skipped its contract, so the plan's own check is what refuses.
    const unnamed = page();
    const { label: _, ...bare } = layer("c9", "log on");
    const unchecked = { ...unnamed, candidates: [...unnamed.candidates, bare] };
    expect(
      validatePagePlan(unchecked, slots, {
        fields,
        action: { candidate: "c9", purpose: "submit" },
      }),
    ).toEqual({ ok: false, reason: "incompatible-role" });
  });

  it("refuses a layer as the account switch", () => {
    expect(
      validatePagePlan(page(), slots, { fields, action: logOn, accountSwitch: "259" }),
    ).toEqual({ ok: false, reason: "incompatible-role" });
    // A button that is no layer may be one.
    const other = { id: "c9", role: "button", target: { by: "id", value: "other" } } as const;
    expect(
      validatePagePlan(page({ ...other, label: "Use another account" }), slots, {
        fields,
        action: logOn,
        accountSwitch: "c9",
      }).ok,
    ).toBe(true);
  });

  it("ignores a layer named as the passkey button", () => {
    const passkey = layer("326", "Sign in with a passkey");
    const result = validateGeneratedPage(page(passkey), slots, {
      fields,
      action: logOn,
      passkeyButton: "326",
    });
    if (!result.ok) throw new Error(result.reason);
    expect(result.plan).not.toHaveProperty("passkeyButton");
    expect(result.plan).not.toHaveProperty("passkeyTarget");
    expect(result.plan.steps.at(-1)).toMatchObject({ shows: "log on" });
    // The same button drawn as a real button is kept.
    const real = { ...passkey, overlaid: undefined };
    const kept = validateGeneratedPage(page(real), slots, {
      fields,
      action: logOn,
      passkeyButton: "326",
    });
    if (!kept.ok) throw new Error(kept.reason);
    expect(kept.plan).toMatchObject({ passkeyButton: "326" });
  });

  it("never makes a passkey-only plan of a layer", () => {
    const only = (candidate: ObservedCandidate) =>
      validateGeneratedPage(
        v.parse(loginObservationSchema, { ...page(), candidates: [candidate] }),
        [],
        { fields: [], action: { candidate: "326", purpose: "submit" }, passkeyButton: "326" },
      );
    const passkey = layer("326", "Sign in with a passkey");
    expect(only(passkey)).toEqual({ ok: false, reason: "empty-plan" });
    expect(only({ ...passkey, overlaid: undefined }).ok).toBe(true);
  });
});
