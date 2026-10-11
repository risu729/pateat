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

describe("custom slots in a generated recipe (ADR 0027)", () => {
  const custom = {
    ...recipe,
    slots: ["email", "branch-number", "pin-code"],
    steps: [
      {
        kind: "fill",
        path: "/login",
        fields: [
          { slot: "email", target: { by: "id", value: "email" } },
          { slot: "branch-number", target: { by: "id", value: "branch" } },
          { slot: "pin-code", target: { by: "id", value: "pin" } },
        ],
      },
      recipe.steps[1],
    ],
  };
  const change = { recipeId: "gen-1", revision: 2, state: "active", recipe: custom };
  const answer = (customSlots: unknown) =>
    v.is(recipeGenerationResultSchema, { version: 1, status: "recipe", change, customSlots });

  it("maps recipe slots to offered request slots", () => {
    expect(v.is(recipeGenerationResultSchema, { version: 1, status: "recipe", change })).toBe(true);
    expect(answer([{ slot: "branch-number", offered: "custom-1" }])).toBe(true);
    expect(
      answer([
        { slot: "branch-number", offered: "custom-1" },
        { slot: "pin-code", offered: "custom-2" },
      ]),
    ).toBe(true);
  });

  it("refuses an empty, duplicate or oversized mapping", () => {
    expect(answer([])).toBe(false);
    expect(
      answer([
        { slot: "branch-number", offered: "custom-1" },
        { slot: "branch-number", offered: "custom-2" },
      ]),
    ).toBe(false);
    expect(
      answer([
        { slot: "branch-number", offered: "custom-1" },
        { slot: "pin-code", offered: "custom-1" },
      ]),
    ).toBe(false);
    // Up to 16: 8 fields in each of several variants, within one request's 16 offers.
    const seventeen = Array.from({ length: 17 }, (_, index) => ({
      slot: `slot-${"abcdefghijklmnopq"[index]!.repeat(2)}`,
      offered: `custom-${index + 1}`,
    }));
    const wide = {
      ...change,
      recipe: { ...custom, slots: [...custom.slots, ...seventeen.map((entry) => entry.slot)] },
    };
    const many = (entries: typeof seventeen) =>
      v.is(recipeGenerationResultSchema, {
        version: 1,
        status: "recipe",
        change: wide,
        customSlots: entries,
      });
    expect(many(seventeen.slice(0, 16))).toBe(true);
    expect(many(seventeen)).toBe(false);
  });

  it("maps the slots of every password variant", () => {
    const submit = { ...recipe.steps[1], purpose: "submit" };
    const varied = {
      ...change,
      recipe: {
        ...custom,
        steps: [custom.steps[0], submit],
        alternatives: [
          {
            slots: ["contract-number", "pin-code"],
            steps: [
              {
                kind: "fill",
                path: "/login",
                fields: [
                  { slot: "contract-number", target: { by: "id", value: "contract" } },
                  { slot: "pin-code", target: { by: "id", value: "pin" } },
                ],
              },
              submit,
            ],
          },
        ],
      },
    };
    const mapped = (customSlots: unknown) =>
      v.is(recipeGenerationResultSchema, {
        version: 1,
        status: "recipe",
        change: varied,
        customSlots,
      });
    expect(
      mapped([
        { slot: "branch-number", offered: "custom-1" },
        { slot: "contract-number", offered: "custom-2" },
        { slot: "pin-code", offered: "custom-3" },
      ]),
    ).toBe(true);
    expect(answer([{ slot: "contract-number", offered: "custom-2" }])).toBe(false);
  });

  it("refuses a slot the recipe lacks, a non-generic slot or an unsafe offered ID", () => {
    expect(answer([{ slot: "region", offered: "custom-1" }])).toBe(false);
    // Built-in slots and field names never come back as custom slots.
    for (const slot of ["password", "Branch number", "branch-2"])
      expect(answer([{ slot, offered: "custom-1" }])).toBe(false);
    for (const offered of ["", "custom 1", "x".repeat(65)])
      expect(answer([{ slot: "branch-number", offered }])).toBe(false);
    expect(answer([{ slot: "branch-number", offered: "custom-1", field: "Branch" }])).toBe(false);
  });

  it("never carries a mapping on another status", () => {
    expect(
      v.is(recipeGenerationResultSchema, {
        version: 1,
        status: "abstained",
        reason: "ambiguous",
        customSlots: [{ slot: "branch-number", offered: "custom-1" }],
      }),
    ).toBe(false);
  });
});

describe("page judgement contracts (ADR 0027)", () => {
  const change = { recipeId: "gen-1", revision: 2, state: "active", recipe };

  it("names the login's route, which is required", () => {
    expect(v.is(recipeCompletionRequestSchema, { version: 1, revision: 2, observation })).toBe(
      false,
    );
    expect(
      v.parse(recipeCompletionRequestSchema, {
        version: 1,
        revision: 2,
        route: "password",
        observation,
      }).route,
    ).toBe("password");
    expect(
      v.parse(recipeCompletionRequestSchema, {
        version: 1,
        revision: 2,
        route: "passkey",
        observation,
      }).route,
    ).toBe("passkey");
    for (const route of ["sso", ""])
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
