import {
  loginRecipeSchema,
  passwordVariants,
  recipeGenerationRequestSchema,
  type LoginObservation,
} from "@pateat/contracts";
import * as v from "valibot";
import { describe, expect, it } from "vitest";
import { appendPageSteps } from "./assemble";
import { createRecipeGenerator } from "./generation";
import { validateGeneratedPage } from "./plan";
import { textModel, textResult } from "./testing/fake-models";

const target = { by: "id", value: "passkey-login" } as const;
const button = { id: "passkey", role: "button", label: "Sign in with a passkey", target } as const;
const observation: LoginObservation = {
  version: 1,
  origin: "https://bank.example",
  path: "/login",
  language: "en",
  complete: true,
  candidates: [button],
};
const draft = {
  fields: [],
  action: { candidate: "passkey", purpose: "submit" as const },
  passkeyButton: "passkey",
};
const request = { version: 1, observation, slots: [], passkeyOnly: true };

describe("passkey-only generation boundaries", () => {
  it("requires an explicit request marker and forbids base recipes, branches and fill slots", () => {
    expect(v.is(recipeGenerationRequestSchema, request)).toBe(true);
    for (const invalid of [
      { ...request, passkeyOnly: undefined },
      { ...request, base: { recipeId: "existing", revision: 1 } },
      { ...request, branch: "account" },
      { ...request, slots: [{ id: "password", kind: "password", description: "Password" }] },
    ])
      expect(v.is(recipeGenerationRequestSchema, invalid), JSON.stringify(invalid)).toBe(false);
  });

  it("validates the named button and assembles a recipe with no password fallback", () => {
    const validated = validateGeneratedPage(observation, [], draft);
    expect(validated.ok).toBe(true);
    if (!validated.ok) throw new Error(validated.reason);
    expect(validated.plan).toMatchObject({
      passkeyOnly: true,
      steps: [{ kind: "click", path: "/login", target, purpose: "submit" }],
    });
    const assembled = appendPageSteps(undefined, {
      id: "synthetic-passkey",
      origin: observation.origin,
      steps: validated.plan.steps,
      passkey: validated.plan.passkeyTarget!,
      passkeyOnly: true,
    });
    expect(assembled, JSON.stringify(assembled)).toMatchObject({ ok: true });
    if (!assembled.ok) throw new Error(assembled.reason);
    expect(assembled.recipe).toMatchObject({
      passkeyOnly: true,
      slots: [],
      passkey: { path: "/login", target },
    });
    expect(passwordVariants(assembled.recipe)).toEqual([]);
    expect(v.is(loginRecipeSchema, { ...assembled.recipe, passkey: undefined })).toBe(false);
  });

  it.each(["Create a passkey", "Register security key", "Add a passkey", "Set up passkey"])(
    "rejects registration control %s",
    (text) => {
      expect(
        validateGeneratedPage(
          { ...observation, candidates: [{ ...button, label: text }] },
          [],
          draft,
        ).ok,
      ).toBe(false);
    },
  );

  it("rejects links, unlabeled controls, fill forms and mismatched model button choices", () => {
    for (const changed of [
      { ...observation, candidates: [{ ...button, role: "link" as const }] },
      {
        ...observation,
        candidates: [
          { ...button, label: "Continue", target: { by: "id" as const, value: "continue" } },
        ],
      },
      {
        ...observation,
        candidates: [
          button,
          { id: "email", role: "email" as const, target: { by: "id" as const, value: "email" } },
        ],
      },
    ])
      expect(validateGeneratedPage(changed, [], draft).ok, JSON.stringify(changed)).toBe(false);
    expect(validateGeneratedPage(observation, [], { ...draft, passkeyButton: "other" }).ok).toBe(
      false,
    );
    expect(
      validateGeneratedPage(observation, [], {
        ...draft,
        action: { candidate: "passkey", purpose: "advance" },
      }).ok,
    ).toBe(false);
  });

  it("accepts a synthetic model plan only in the explicit passkey-only generation path", async () => {
    const model = textModel(async () =>
      textResult(JSON.stringify({ result: { decision: "plan", ...draft } })),
    );
    const generate = createRecipeGenerator({
      model,
      limits: { timeoutMs: 1000, maxInputBytes: 16384 },
      maxOutputTokens: 512,
    });
    expect(await generate({ observation, slots: [], passkeyOnly: true })).toMatchObject({
      status: "ok",
      value: { passkeyOnly: true },
    });
    expect(await generate({ observation, slots: [] })).toMatchObject({ status: "failed" });
  });
});
