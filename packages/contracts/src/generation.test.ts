import * as v from "valibot";
import { describe, expect, it } from "vitest";
import {
  entryGenerationRequestSchema,
  entryGenerationResultSchema,
  generationRequestSchema,
  generationUnavailableReasonSchema,
  isEntryObservation,
  recipeCompletionRequestSchema,
  recipeCompletionResultSchema,
  recipeGenerationRequestSchema,
  recipePageSampleRequestSchema,
  recipeGenerationResultSchema,
} from "./generation";
import { builtInLoginSlots, customFieldSlotDescriptions } from "./observation";

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
/** A recipe stored with one layout of the route (ADR 0060). */
const stored = (body: Record<string, unknown>) => ({
  version: 1,
  id: "gen-1",
  revision: 2,
  origin: "https://shop.example.test",
  layouts: [{ key: "1000", createdAt: 1000, ...body }],
});
const route = {
  pageKind: "sign-in",
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
const recipe = stored(route);

describe("recipe generation contracts", () => {
  it("accepts a page with slots and an optional base revision", () => {
    expect(
      v.is(recipeGenerationRequestSchema, { version: 1, observation, slots, signedIn: false }),
    ).toBe(true);
    const base = { recipeId: "gen-1", revision: 1 };
    // A base names the layout it continues (ADR 0060).
    expect(
      v.is(recipeGenerationRequestSchema, { version: 1, observation, slots, base, branch: "1000" }),
    ).toBe(true);
    // A chooser branch's page (ADR 0028) names its chooser as the base.
    expect(
      v.is(recipeGenerationRequestSchema, {
        version: 1,
        observation,
        slots,
        base,
        branch: "1000:other",
      }),
    ).toBe(true);
    for (const invalid of [
      { version: 1, observation, slots, base: { recipeId: "gen-1", revision: 0 }, branch: "1000" },
      { version: 1, observation, slots: [], signedIn: false },
      // A first page carries the signedIn hint (ADR 0035), and only a first page does.
      { version: 1, observation, slots },
      { version: 1, observation, slots, base, branch: "1000", signedIn: false },
      {
        version: 1,
        observation: { ...observation, accounts: ["[email]"] },
        slots: [],
        signedIn: true,
      },
      { version: 1, observation, slots, item: "vault-item" },
      { version: 1, observation, slots, base },
      { version: 1, observation, slots, branch: "1000:account" },
      { version: 1, observation, slots, base, branch: "other" },
      { version: 1, observation, slots, base, branch: "1000:entry" },
    ])
      expect(v.is(recipeGenerationRequestSchema, invalid)).toBe(false);
  });

  it("takes a list of accounts (ADR 0028) only without slots (owner 2026-10-23 11:48 UTC)", () => {
    const list = { ...observation, accounts: ["[email]", "[account]"] };
    expect(v.is(recipeGenerationRequestSchema, { version: 1, observation: list, slots: [] })).toBe(
      true,
    );
    expect(v.is(generationRequestSchema, { version: 1, observation: list, slots: [] })).toBe(true);
    const shaped = [
      { ...slots[0], valueShape: { length: 12, classes: ["ascii-letter"], email: false } },
    ];
    const named = [
      { id: "custom-1", kind: "identifier", description: "vault field", fieldName: "Branch" },
    ];
    for (const offered of [slots, shaped, named]) {
      // Each is a valid offer on a form, but never on a list.
      expect(
        v.is(generationRequestSchema, { version: 1, observation, slots: offered, signedIn: false }),
      ).toBe(true);
      expect(v.is(generationRequestSchema, { version: 1, observation: list, slots: offered })).toBe(
        false,
      );
    }
    expect(
      v
        .safeParse(recipeGenerationRequestSchema, { version: 1, observation: list, slots })
        .issues?.map((issue) => issue.message),
    ).toEqual(["A list of accounts has no slots"]);
    // A list is never an entry request or a passkey-only page.
    expect(v.is(generationRequestSchema, { version: 1, observation: list })).toBe(false);
    expect(
      v.is(generationRequestSchema, {
        version: 1,
        observation: list,
        slots: [],
        passkeyOnly: true,
      }),
    ).toBe(false);
  });

  it("accepts a repair of a recipe's start page, a form or a list, never with a base (ADR 0041)", () => {
    const repair = { recipeId: "gen-1", revision: 3 };
    // A start page is a recipe's first page and carries the signed-in hint (ADR 0035).
    expect(
      v.is(recipeGenerationRequestSchema, {
        version: 1,
        observation,
        slots,
        repair,
        signedIn: false,
      }),
    ).toBe(true);
    // A later step's page names the layout and the step that did not show.
    expect(
      v.is(recipeGenerationRequestSchema, {
        version: 1,
        observation,
        slots,
        repair: { ...repair, layout: "1760000000000", step: 2 },
      }),
    ).toBe(true);
    for (const invalid of [
      {
        version: 1,
        observation,
        slots,
        repair: { recipeId: "gen-1", revision: 0 },
        signedIn: false,
      },
      { version: 1, observation, slots, repair: { ...repair, layout: "1760000000000" } },
      { version: 1, observation, slots, repair: { ...repair, step: 2 }, signedIn: false },
      { version: 1, observation, slots, repair, base: repair, branch: "1760000000000" },
      { version: 1, observation, slots, repair },
      {
        version: 1,
        observation,
        slots,
        repair: { ...repair, layout: "1760000000000", step: 2 },
        signedIn: false,
      },
      {
        version: 1,
        observation: { ...observation, accounts: ["Taro"] },
        slots: [],
        repair: { ...repair, layout: "1760000000000", step: 2 },
      },
    ])
      expect(v.is(recipeGenerationRequestSchema, invalid)).toBe(false);
    // A start page that lists accounts, as a chooser's list, carries no hint (ADR 0035).
    expect(
      v.is(recipeGenerationRequestSchema, {
        version: 1,
        observation: { ...observation, accounts: ["Taro"] },
        slots: [],
        repair,
      }),
    ).toBe(true);
    // An entry page names the entry recipe it repairs.
    const entryPage = observation;
    expect(v.is(entryGenerationRequestSchema, { version: 1, observation: entryPage, repair })).toBe(
      true,
    );
    expect(
      v.is(entryGenerationRequestSchema, {
        version: 1,
        observation: entryPage,
        repair: { ...repair, layout: "1760000000000" },
      }),
    ).toBe(false);
  });

  it("answers a chooser recipe for an account list or one of its branches (ADR 0028)", () => {
    const chooser = {
      version: 1,
      id: "gen-1",
      revision: 2,
      origin: recipe.origin,
      chooser: {
        path: "/login",
        layouts: [{ key: "1000", createdAt: 1000, afterAccount: route }],
      },
    };
    const change = { recipeId: "gen-1", revision: 2, state: "active", recipe: chooser };
    expect(v.is(recipeGenerationResultSchema, { version: 1, status: "recipe", change })).toBe(true);
    expect(v.is(recipeCompletionResultSchema, { version: 1, status: "signed-in", change })).toBe(
      true,
    );
    // Its branches' slots are the ones a custom slot may name.
    const customSlots = [{ slot: "email", offered: "custom-1" }];
    expect(
      v.is(recipeGenerationResultSchema, { version: 1, status: "recipe", change, customSlots }),
    ).toBe(true);
    expect(
      v.is(recipeGenerationResultSchema, {
        version: 1,
        status: "recipe",
        change: {
          ...change,
          recipe: {
            ...chooser,
            chooser: { path: "/login", layouts: [{ key: "1000", createdAt: 1000 }] },
          },
        },
        customSlots,
      }),
    ).toBe(false);
    const judged = { version: 1, revision: 2, route: "password", observation, slots: [] };
    expect(v.is(recipeCompletionRequestSchema, { ...judged, branch: "1000:account" })).toBe(true);
    for (const branch of ["1000:list", "account"])
      expect(v.is(recipeCompletionRequestSchema, { ...judged, branch })).toBe(false);
  });

  it("takes a signed-in page sample (ADR 0029) with its route and only its own fields", () => {
    const sampled = {
      version: 1,
      revision: 2,
      route: "password",
      branch: "1000",
      observation,
      slots: [],
    };
    expect(v.is(recipePageSampleRequestSchema, sampled)).toBe(true);
    // The account's slots, as the judge request carries them (owner 2026-10-23).
    expect(
      v.is(recipePageSampleRequestSchema, { ...sampled, slots: [builtInLoginSlots.username] }),
    ).toBe(true);
    expect(v.is(recipePageSampleRequestSchema, { ...sampled, branch: "1000:account" })).toBe(true);
    // The layout the login ran is required.
    const { branch: _branch, ...unnamed } = sampled;
    for (const invalid of [
      unnamed,
      { ...sampled, branch: "account" },
      { ...sampled, branch: "1000:list" },
      { ...sampled, partial: true },
      { ...sampled, stop: true },
      { ...sampled, beside: true },
      { ...sampled, revision: 0 },
      { version: 1, revision: 2, branch: "1000", observation, slots: [] },
      { version: 1, revision: 2, route: "password", branch: "1000", observation },
      { ...sampled, slots: [{ ...builtInLoginSlots.username, value: "x" }] },
    ])
      expect(v.is(recipePageSampleRequestSchema, invalid)).toBe(false);
  });

  it("answers recipes only as active changes whose identity matches", () => {
    const change = { recipeId: "gen-1", revision: 2, state: "active", recipe };
    expect(v.is(recipeGenerationResultSchema, { version: 1, status: "recipe", change })).toBe(true);
    for (const invalid of [
      { recipeId: "gen-1", revision: 2, state: "revoked" },
      { ...change, revision: 3 },
      { ...change, recipeId: "gen-2" },
      // An entry recipe (ADR 0031) answers only an entry request, never a page or judgement.
      {
        ...change,
        recipe: {
          version: 1,
          id: "gen-1",
          revision: 2,
          origin: recipe.origin,
          entry: { path: "/", target: { by: "text", value: "Login" } },
        },
      },
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

  it("says which check refused invalid output, as codes only", () => {
    const failed = (error: string, rejection: unknown) =>
      v.is(recipeGenerationResultSchema, { version: 1, status: "failed", error, rejection });
    for (const rejection of [
      { check: "json" },
      { check: "schema", issue: "max-length", path: "result.alternatives" },
      { check: "schema", issue: "strict-object", path: "result.fields.0" },
      { check: "schema", issue: "object", path: "" },
      { check: "plan", reason: "incompatible-role" },
    ])
      expect(failed("invalid-output", rejection)).toBe(true);
    for (const rejection of [
      { check: "plan", reason: "incompatible-role", output: { result: {} } },
      { check: "plan", reason: "Invalid type: Expected string" },
      { check: "schema", issue: "max-length", path: "result.ｆｉｅｌｄｓ" },
      { check: "schema", issue: "max-length", path: "result..fields" },
      { check: "schema", issue: "max_length", path: "result" },
      { check: "values" },
    ])
      expect(failed("invalid-output", rejection)).toBe(false);
    expect(failed("timeout", { check: "json" })).toBe(false);
    expect(
      v.is(recipeCompletionResultSchema, {
        version: 1,
        status: "failed",
        error: "invalid-output",
        rejection: { check: "json" },
      }),
    ).toBe(false);
  });
});

describe("entry requests and answers (ADR 0031)", () => {
  // A synthetic top page without a login form.
  const topPage = {
    version: 1,
    origin: "https://shop.example.test",
    path: "/en/",
    language: "en",
    complete: true,
    candidates: [
      { id: "c1", role: "link", target: { by: "text", value: "Create account" } },
      { id: "c2", role: "link", target: { by: "text", value: "Login" } },
      { id: "c3", role: "button", target: { by: "text", value: "Search" } },
    ],
  };
  const entryRecipe = {
    version: 1,
    id: "gen-1",
    revision: 1,
    origin: "https://shop.example.test",
    entry: { path: "/en/", target: { by: "text", value: "Login" } },
  };
  const entryChange = { recipeId: "gen-1", revision: 1, state: "active", recipe: entryRecipe };

  it("takes a request without slots only for a page without fields or accounts", () => {
    const request = { version: 1, observation: topPage };
    expect(v.is(entryGenerationRequestSchema, request)).toBe(true);
    expect(v.is(generationRequestSchema, request)).toBe(true);
    // A request without slots is never a page request, and a page request still needs one.
    expect(v.is(recipeGenerationRequestSchema, request)).toBe(false);
    expect(v.is(generationRequestSchema, { version: 1, observation, slots, signedIn: true })).toBe(
      true,
    );
    expect(v.is(entryGenerationRequestSchema, { version: 1, observation, slots })).toBe(false);
    const withField = {
      ...topPage,
      candidates: [
        ...topPage.candidates,
        { id: "email", role: "email", target: { by: "id", value: "email" } },
      ],
    };
    for (const invalid of [
      { version: 1, observation: withField },
      { version: 1, observation: { ...topPage, accounts: ["[email]"] } },
      { version: 1, observation: topPage, base: { recipeId: "gen-1", revision: 1 } },
      { version: 1, observation: topPage, slots: [] },
      { version: 1, observation: topPage, item: "vault-item" },
    ])
      expect(v.is(generationRequestSchema, invalid)).toBe(false);
    // A checkbox is no field to fill.
    expect(
      isEntryObservation({
        ...topPage,
        language: "en",
        candidates: [
          { id: "c2", role: "link", target: { by: "text", value: "Login" } },
          { id: "remember", role: "checkbox", target: { by: "id", value: "remember" } },
        ],
      }),
    ).toBe(true);
  });

  it("answers an entry request with an entry recipe only", () => {
    expect(
      v.is(entryGenerationResultSchema, { version: 1, status: "recipe", change: entryChange }),
    ).toBe(true);
    const routeChange = { recipeId: "gen-1", revision: 2, state: "active", recipe };
    for (const invalid of [
      routeChange,
      { ...entryChange, revision: 2 },
      { ...entryChange, recipeId: "gen-2" },
      {
        ...entryChange,
        recipe: {
          ...entryRecipe,
          entry: { path: "/en/", target: { by: "autocomplete", value: "username" } },
        },
      },
      {
        ...entryChange,
        recipe: {
          version: 1,
          id: "gen-1",
          revision: 1,
          origin: entryRecipe.origin,
          chooser: { path: "/en/" },
        },
      },
    ])
      expect(
        v.is(entryGenerationResultSchema, { version: 1, status: "recipe", change: invalid }),
      ).toBe(false);
    // An entry recipe fills nothing, so no custom slot is mapped.
    expect(
      v.is(entryGenerationResultSchema, {
        version: 1,
        status: "recipe",
        change: entryChange,
        customSlots: [{ slot: "branch-number", offered: "custom-1" }],
      }),
    ).toBe(false);
    expect(
      v.is(entryGenerationResultSchema, {
        version: 1,
        status: "failed",
        error: "invalid-output",
        rejection: { check: "plan", reason: "unexpected-plan" },
      }),
    ).toBe(true);
    expect(
      v.is(entryGenerationResultSchema, {
        version: 1,
        status: "failed",
        error: "timeout",
        rejection: { check: "json" },
      }),
    ).toBe(false);
    for (const answer of [
      { version: 1, status: "abstained", reason: "no-login-form" },
      { version: 1, status: "unavailable", reason: "recently-tried" },
    ])
      expect(v.is(entryGenerationResultSchema, answer)).toBe(true);
  });
});

describe("custom slots in a generated recipe (ADR 0027)", () => {
  const custom = {
    ...route,
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
      route.steps[1],
    ],
  };
  const change = { recipeId: "gen-1", revision: 2, state: "active", recipe: stored(custom) };
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
      recipe: stored({
        ...custom,
        slots: [...custom.slots, ...seventeen.map((entry) => entry.slot)],
      }),
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
    const submit = { ...route.steps[1], purpose: "submit" };
    const varied = {
      ...change,
      recipe: stored({
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
      }),
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

  it("refuses a slot the recipe lacks, a built-in slot or an unsafe offered ID", () => {
    expect(answer([{ slot: "region", offered: "custom-1" }])).toBe(false);
    // Built-in slots never come back as custom slots, in any case.
    for (const slot of ["password", "Password"])
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
    expect(
      v.is(recipeCompletionRequestSchema, { version: 1, revision: 2, branch: "1000", observation }),
    ).toBe(false);
    expect(
      v.parse(recipeCompletionRequestSchema, {
        version: 1,
        revision: 2,
        route: "password",
        branch: "1000",
        observation,
        slots: [],
      }).route,
    ).toBe("password");
    expect(
      v.parse(recipeCompletionRequestSchema, {
        version: 1,
        revision: 2,
        route: "passkey",
        branch: "1000",
        observation,
        slots: [],
      }).route,
    ).toBe("passkey");
    for (const named of ["sso", ""])
      expect(
        v.is(recipeCompletionRequestSchema, {
          version: 1,
          revision: 2,
          route: named,
          branch: "1000",
          observation,
          slots: [],
        }),
      ).toBe(false);
    // So is the layout the login ran (ADR 0060).
    expect(
      v.is(recipeCompletionRequestSchema, {
        version: 1,
        revision: 2,
        route: "password",
        observation,
      }),
    ).toBe(false);
  });

  it("marks a description that left out a disabled field only as true (ADR 0029)", () => {
    const request = {
      version: 1,
      revision: 2,
      route: "password",
      branch: "1000",
      observation,
      slots: [],
    };
    expect(v.is(recipeCompletionRequestSchema, { ...request, partial: true })).toBe(true);
    for (const partial of [false, "true"])
      expect(v.is(recipeCompletionRequestSchema, { ...request, partial })).toBe(false);
  });

  it("marks a page at a stop before a missing password only as true (ADR 0036)", () => {
    const request = {
      version: 1,
      revision: 2,
      route: "password",
      branch: "1000",
      observation,
      slots: [],
    };
    expect(v.is(recipeCompletionRequestSchema, { ...request, stop: true })).toBe(true);
    for (const stop of [false, "true"])
      expect(v.is(recipeCompletionRequestSchema, { ...request, stop })).toBe(false);
    // Only a password login without a chooser has a stop.
    expect(v.is(recipeCompletionRequestSchema, { ...request, route: "passkey", stop: true })).toBe(
      false,
    );
    expect(
      v.is(recipeCompletionRequestSchema, { ...request, branch: "1000:account", stop: true }),
    ).toBe(false);
  });

  it("marks a page beside the sign-in form only as true, never with a stop (ADR 0061)", () => {
    const request = {
      version: 1,
      revision: 2,
      route: "password",
      branch: "1000",
      observation,
      slots: [],
    };
    expect(v.is(recipeCompletionRequestSchema, { ...request, beside: true })).toBe(true);
    expect(v.is(recipeCompletionRequestSchema, { ...request, beside: true, partial: true })).toBe(
      true,
    );
    for (const beside of [false, "true"])
      expect(v.is(recipeCompletionRequestSchema, { ...request, beside })).toBe(false);
    // Only a password login without a chooser, and never at its stop.
    for (const invalid of [
      { ...request, route: "passkey", beside: true },
      { ...request, branch: "1000:account", beside: true },
      { ...request, branch: "1000:other", beside: true },
      { ...request, stop: true, beside: true },
    ])
      expect(v.is(recipeCompletionRequestSchema, invalid)).toBe(false);
  });

  it("carries the account's slots as a generation request does (owner 2026-10-23)", () => {
    const request = { version: 1, revision: 2, route: "password", branch: "1000", observation };
    const accountSlots = [
      builtInLoginSlots.username,
      {
        id: "custom-1",
        kind: "hidden",
        description: customFieldSlotDescriptions.hidden,
        fieldName: "お母さんの旧姓",
      },
    ];
    expect(v.is(recipeCompletionRequestSchema, { ...request, slots: accountSlots })).toBe(true);
    // Required, as for generation; a Hidden field never carries a shape.
    expect(v.is(recipeCompletionRequestSchema, request)).toBe(false);
    expect(
      v.is(recipeCompletionRequestSchema, {
        ...request,
        slots: [
          { ...accountSlots[1], valueShape: { length: 6, classes: ["other"], email: false } },
        ],
      }),
    ).toBe(false);
    // Never a value or a binding.
    expect(
      v.is(recipeCompletionRequestSchema, {
        ...request,
        slots: [{ ...accountSlots[1], value: "x" }],
      }),
    ).toBe(false);
  });

  it("answers a challenge with secret questions paired for this account only", () => {
    const questions = [
      { field: { by: "name", value: "answer" }, slot: "custom-1", shown: "母親の旧姓は？" },
    ];
    expect(
      v.is(recipeCompletionResultSchema, { version: 1, status: "challenge", change, questions }),
    ).toBe(true);
    for (const bad of [
      [],
      [{ ...questions[0], shown: "" }],
      [{ ...questions[0], shown: "x".repeat(201) }],
      [{ ...questions[0], field: { by: "text", value: "Answer" } }],
      [{ ...questions[0], slot: "custom 1" }],
      [{ ...questions[0], answer: "x" }],
    ])
      expect(
        v.is(recipeCompletionResultSchema, { version: 1, status: "challenge", questions: bad }),
      ).toBe(false);
    expect(v.is(recipeCompletionResultSchema, { version: 1, status: "signed-in", questions })).toBe(
      false,
    );
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
