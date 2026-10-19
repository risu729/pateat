import * as v from "valibot";
import { describe, expect, it } from "vitest";
import { recipeGenerationRequestSchema } from "./generation";
import {
  continuesRecipe,
  loginRecipeSchema,
  parseLoginRecipe,
  passwordVariants,
  recipeHasRoute,
  type LoginRecipe,
} from "./login";

const button = { by: "id", value: "passkey-login" } as const;
const passkeyOnly = {
  version: 1,
  id: "synthetic-passkey-only",
  revision: 1,
  origin: "https://login.example",
  slots: [],
  passkeyOnly: true,
  passkey: { path: "/signin", target: button },
  steps: [{ kind: "click", path: "/signin", target: button, purpose: "submit" }],
  maxSubmissions: 1,
} as const;
const issues = (value: unknown) =>
  v.safeParse(loginRecipeSchema, value).issues?.map((issue) => issue.message) ?? [];

describe("a passkey-only recipe (ADR 0053)", () => {
  it("has only its passkey route", () => {
    const recipe = parseLoginRecipe(passkeyOnly);
    expect(passwordVariants(recipe)).toEqual([]);
    expect(recipeHasRoute(recipe, "password")).toBe(false);
    expect(recipeHasRoute(recipe, "passkey")).toBe(true);
  });

  it("refuses an ordinary recipe without slots with its own message", () => {
    const { passkeyOnly: _marker, ...ordinary } = passkeyOnly;
    expect(issues(ordinary)).toContain("A recipe has at least one slot");
    expect(issues(ordinary)).not.toContain("A passkey-only recipe has only its passkey submit");
  });

  it.each<[string, Record<string, unknown>]>([
    ["slots", { slots: ["password"] }],
    ["alternatives", { alternatives: [{ slots: ["password"], steps: passkeyOnly.steps }] }],
    ["no passkey route", { passkey: undefined }],
    ["two steps", { steps: [...passkeyOnly.steps, ...passkeyOnly.steps] }],
    ["two submissions", { maxSubmissions: 2 }],
    ["an advance step", { steps: [{ ...passkeyOnly.steps[0], purpose: "advance" }] }],
    [
      "a step on another element",
      { steps: [{ ...passkeyOnly.steps[0], target: { by: "id", value: "other" } }] },
    ],
    ["a step on another path", { steps: [{ ...passkeyOnly.steps[0], path: "/other" }] }],
  ])("refuses one with %s", (_, change) => {
    expect(issues({ ...passkeyOnly, ...change })).toContain(
      "A passkey-only recipe has only its passkey submit",
    );
  });

  it("is never continued by, or continues into, a recipe of the other kind", () => {
    const ordinary = parseLoginRecipe({
      ...passkeyOnly,
      passkeyOnly: undefined,
      slots: ["password"],
      steps: [
        {
          kind: "fill",
          path: "/signin",
          fields: [{ slot: "password", target: { by: "id", value: "password" } }],
        },
        { kind: "click", path: "/signin", target: { by: "id", value: "next" }, purpose: "advance" },
      ],
    });
    const later = parseLoginRecipe({
      ...ordinary,
      revision: 2,
      steps: [
        ...ordinary.steps,
        {
          kind: "click",
          path: "/verify",
          target: { by: "id", value: "finish" },
          purpose: "submit",
        },
      ],
      maxSubmissions: 2,
    });
    expect(continuesRecipe(ordinary, later)).toBe(true);
    // Only the marker differs: the flip is refused.
    const flipped: LoginRecipe = { ...later, passkeyOnly: true };
    expect(continuesRecipe(ordinary, flipped)).toBe(false);
  });
});

describe("a passkey-only generation request (ADR 0053)", () => {
  const observation = {
    version: 1,
    origin: "https://login.example",
    path: "/signin",
    language: "en",
    complete: true,
    candidates: [{ id: "key", role: "button", label: "Sign in with a passkey", target: button }],
  };
  const requestIssues = (value: unknown) =>
    v.safeParse(recipeGenerationRequestSchema, value).issues?.map((issue) => issue.message) ?? [];

  it("refuses an ordinary request without slots with its own message", () => {
    expect(requestIssues({ version: 1, observation, slots: [] })).toEqual([
      "A request has at least one slot",
    ]);
    expect(requestIssues({ version: 1, observation, slots: [], passkeyOnly: true })).toEqual([]);
  });

  it("refuses a passkey-only request for a later page or a page with fields", () => {
    const shape = "A passkey-only request is a first page with no slots, fields or accounts";
    expect(
      requestIssues({
        version: 1,
        observation,
        slots: [],
        passkeyOnly: true,
        base: { recipeId: "gen-0123456789abcdef0123456789abcdef", revision: 1 },
      }),
    ).toContain(shape);
    expect(
      requestIssues({
        version: 1,
        observation: {
          ...observation,
          candidates: [
            ...observation.candidates,
            { id: "email", role: "email", target: { by: "id", value: "email" } },
          ],
        },
        slots: [],
        passkeyOnly: true,
      }),
    ).toContain(shape);
  });
});
