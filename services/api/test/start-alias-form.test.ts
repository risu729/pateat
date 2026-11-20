import * as v from "valibot";
import { describe, expect, it } from "vitest";
import {
  storedLoginRecipeSchema,
  type LoginObservation,
  type ObservedCandidate,
  type StoredLoginRecipe,
} from "@pateat/contracts";
import { sameFormRecipe } from "@pateat/generation";

// Whether a first page on a new path shows the first page of one of the origin's sign-in
// layouts unchanged (ADR 0060 amendment of 2026-11-18). Synthetic pages in the shape of
// USI's Student Portal.
const ORIGIN = "https://portal.example";
const LEARNED = "/student/Usi/Forgotten/Success";
const id = (value: string) => ({ by: "id" as const, value });
const pad = { by: "id" as const, value: "pad" };

/** A recipe whose first page fills `fields` and presses Login. */
const recipe = (
  fields: { slot: string; target: { by: "id"; value: string }; keypad?: typeof pad }[] = [
    { slot: "username", target: id("UserName") },
    { slot: "password", target: id("Password") },
  ],
): StoredLoginRecipe =>
  v.parse(storedLoginRecipeSchema, {
    version: 1,
    id: "gen-learned",
    revision: 1,
    origin: ORIGIN,
    layouts: [
      {
        key: "1000",
        createdAt: 1000,
        pageKind: "sign-in",
        slots: fields.map((field) => field.slot),
        steps: [
          { kind: "fill", path: LEARNED, effect: "prepare", fields },
          { kind: "click", path: LEARNED, target: id("Login"), purpose: "submit" },
        ],
        maxSubmissions: 1,
      },
    ],
  });
const candidate = (
  value: string,
  role: ObservedCandidate["role"],
  extra: Partial<ObservedCandidate> = {},
): ObservedCandidate => ({ id: `c-${value}`, role, target: id(value), label: value, ...extra });
const page = (
  candidates: ObservedCandidate[],
  extra: Partial<LoginObservation> = {},
): LoginObservation => ({
  version: 1,
  origin: ORIGIN,
  path: "/student",
  language: "en",
  complete: true,
  candidates,
  ...extra,
});
const form = [
  candidate("UserName", "text"),
  candidate("Password", "password"),
  candidate("Login", "button"),
];

describe("a first page compared with a recipe's sign-in form", () => {
  it("matches the same form", () => {
    expect(sameFormRecipe([recipe()], page(form))?.id).toBe("gen-learned");
  });

  it("matches no element its locator names twice", () => {
    const twice = [...form, { ...candidate("UserName", "text"), id: "c-again" }];
    expect(sameFormRecipe([recipe()], page(twice))).toBeUndefined();
  });

  it("matches a field's software keyboard only as the layout names it", () => {
    const keyed = recipe([
      { slot: "username", target: id("UserName") },
      { slot: "password", target: id("Password"), keypad: pad },
    ]);
    expect(sameFormRecipe([keyed], page(form))).toBeUndefined();
    const withPad = form.map((entry) =>
      entry.target.value === "Password" ? { ...entry, keypad: pad } : entry,
    );
    expect(sameFormRecipe([keyed], page(withPad))?.id).toBe("gen-learned");
    expect(sameFormRecipe([recipe()], page(withPad))).toBeUndefined();
  });

  it("matches neither an incomplete description nor a list of accounts", () => {
    expect(sameFormRecipe([recipe()], page(form, { complete: false }))).toBeUndefined();
    expect(sameFormRecipe([recipe()], page(form, { accounts: ["Taro [email]"] }))).toBeUndefined();
  });

  it("never compares a first page that asks for no identifier, as a password check", () => {
    const passwordOnly = recipe([{ slot: "password", target: id("Password") }]);
    const check = [candidate("Password", "password"), candidate("Login", "button")];
    expect(sameFormRecipe([passwordOnly], page(check))).toBeUndefined();
  });
});
