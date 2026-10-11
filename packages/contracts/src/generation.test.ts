import * as v from "valibot";
import { describe, expect, it } from "vitest";
import {
  generationUnavailableReasonSchema,
  recipeCompletionRequestSchema,
  recipeCompletionResultSchema,
  recipeGenerationRequestSchema,
  recipeGenerationResultSchema,
} from "./generation";

// Synthetic pages and recipes only.

const observation = {
  version: 1,
  origin: "https://shop.example.test",
  path: "/login",
  language: "en",
  complete: true,
  candidates: [{ id: "next", role: "button", target: { by: "id", value: "next" } }],
};
const slots = [{ id: "email", kind: "identifier", description: "account email address" }];
const recipe = {
  version: 1,
  id: "gen-1",
  revision: 2,
  origin: "https://shop.example.test",
  slots: ["email"],
  steps: [
    {
      kind: "fill",
      path: "/login",
      fields: [{ slot: "email", target: { by: "id", value: "email" } }],
    },
    { kind: "click", path: "/login", target: { by: "id", value: "next" }, purpose: "advance" },
  ],
  maxSubmissions: 1,
};

describe("recipe generation contracts", () => {
  it("accepts a page with slots and an optional base revision", () => {
    expect(v.is(recipeGenerationRequestSchema, { version: 1, observation, slots })).toBe(true);
    const base = { recipeId: "gen-1", revision: 1 };
    expect(v.is(recipeGenerationRequestSchema, { version: 1, observation, slots, base })).toBe(
      true,
    );
    for (const invalid of [
      { version: 1, observation, slots, base: { recipeId: "gen-1", revision: 0 } },
      { version: 1, observation, slots: [] },
      { version: 1, observation, slots, item: "vault-item" },
    ])
      expect(v.is(recipeGenerationRequestSchema, invalid)).toBe(false);
  });

  it("answers recipes only as active changes whose identity matches", () => {
    const change = { recipeId: "gen-1", revision: 2, state: "active", recipe };
    expect(v.is(recipeGenerationResultSchema, { version: 1, status: "recipe", change })).toBe(true);
    for (const invalid of [
      { recipeId: "gen-1", revision: 2, state: "revoked" },
      { ...change, revision: 3 },
      { ...change, recipeId: "gen-2" },
    ]) {
      expect(
        v.is(recipeGenerationResultSchema, { version: 1, status: "recipe", change: invalid }),
      ).toBe(false);
      expect(
        v.is(recipeCompletionResultSchema, { version: 1, status: "signed-in", change: invalid }),
      ).toBe(false);
    }
  });

  it("names reasons and failures from fixed lists", () => {
    expect(
      v.is(recipeGenerationResultSchema, { version: 1, status: "unavailable", reason: "busy" }),
    ).toBe(true);
    expect(
      v.is(recipeCompletionResultSchema, { version: 1, status: "failed", error: "timeout" }),
    ).toBe(true);
    expect(
      v.is(recipeGenerationResultSchema, { version: 1, status: "failed", error: "cancelled" }),
    ).toBe(false);
    expect(
      v.is(recipeGenerationResultSchema, {
        version: 1,
        status: "abstained",
        reason: "low-confidence",
      }),
    ).toBe(false);
  });
});

describe("page judgement contracts (ADR 0027)", () => {
  const change = { recipeId: "gen-1", revision: 2, state: "active", recipe };

  it("names the login's route, defaulting to the password route", () => {
    expect(
      v.parse(recipeCompletionRequestSchema, { version: 1, revision: 2, observation }),
    ).toEqual({ version: 1, revision: 2, route: "password", observation });
    expect(
      v.parse(recipeCompletionRequestSchema, {
        version: 1,
        revision: 2,
        route: "password",
        observation,
      }).route,
    ).toBe("password");
    for (const route of ["passkey", "sso", ""])
      expect(
        v.is(recipeCompletionRequestSchema, { version: 1, revision: 2, route, observation }),
      ).toBe(false);
  });

  it("answers signed-in and challenge with or without a change", () => {
    for (const status of ["signed-in", "challenge"]) {
      expect(v.is(recipeCompletionResultSchema, { version: 1, status })).toBe(true);
      expect(v.is(recipeCompletionResultSchema, { version: 1, status, change })).toBe(true);
      expect(
        v.is(recipeCompletionResultSchema, {
          version: 1,
          status,
          change: { ...change, revision: 3 },
        }),
      ).toBe(false);
    }
    for (const status of ["rejected", "unclear"])
      expect(v.is(recipeCompletionResultSchema, { version: 1, status, change })).toBe(false);
  });

  it("names the judging limits as unavailable reasons", () => {
    for (const reason of ["already-judged", "judgement-limit", "not-judgeable"]) {
      expect(v.is(generationUnavailableReasonSchema, reason)).toBe(true);
      expect(
        v.is(recipeCompletionResultSchema, { version: 1, status: "unavailable", reason }),
      ).toBe(true);
    }
  });
});
