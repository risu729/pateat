import * as v from "valibot";
import { describe, expect, it } from "vitest";
import {
  storedLoginRecipeSchema,
  type LoginObservation,
  type ObservedCandidate,
  type StoredLoginRecipe,
} from "@pateat/contracts";
import { sameFormRecipe, showsFirstPage } from "@pateat/generation";

// Whether a first page on a new path shows the first page of one of the origin's sign-in
// layouts unchanged (ADR 0060 amendment of 2026-11-18). Synthetic pages in the shape of
// USI's Student Portal.
const ORIGIN = "https://portal.example";
const LEARNED = "/student/Usi/Forgotten/Success";
const id = (value: string) => ({ by: "id" as const, value });
const pad = { by: "id" as const, value: "pad" };

/** A recipe whose first page fills `fields` and presses Login. */
const recipe = (
  fields: {
    slot: string;
    target: { by: "id"; value: string };
    keypad?: typeof pad;
    split?: number[];
  }[] = [
    { slot: "username", target: id("UserName") },
    { slot: "password", target: id("Password") },
  ],
  click: { target?: { by: "id"; value: string }; shows?: string | undefined } = {},
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
          {
            kind: "click",
            path: LEARNED,
            target: click.target ?? id("Login"),
            purpose: "submit",
            ...(click.shows === undefined ? {} : { shows: click.shows }),
          },
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

  it("matches a split identifier only as the layout names its parts (ADR 0089)", () => {
    const parts = (lengths: number[]) =>
      lengths.map((maxLength, at) =>
        candidate(`No${at + 1}`, "text", {
          maxLength,
          group: "f1",
          split: { group: "s1", part: at + 1, of: lengths.length },
        }),
      );
    const split = recipe([
      { slot: "username", target: id("No1"), split: [4, 4, 5] },
      { slot: "password", target: id("Password") },
    ]);
    const rest = form.slice(1).map((entry) => ({ ...entry, group: "f1" }));
    expect(sameFormRecipe([split], page([...parts([4, 4, 5]), ...rest]))?.id).toBe("gen-learned");
    // Other lengths, another number of parts, or the first input alone.
    expect(sameFormRecipe([split], page([...parts([4, 4, 4]), ...rest]))).toBeUndefined();
    expect(sameFormRecipe([split], page([...parts([4, 4, 5, 2]), ...rest]))).toBeUndefined();
    expect(
      sameFormRecipe([split], page([candidate("No1", "text", { maxLength: 4 }), ...rest])),
    ).toBeUndefined();
    // A layout without split never matches a page that splits the identifier.
    const whole = recipe([
      { slot: "username", target: id("No1") },
      { slot: "password", target: id("Password") },
    ]);
    expect(sameFormRecipe([whole], page([...parts([4, 4, 5]), ...rest]))).toBeUndefined();
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

  // A click layer named by the text laid over it (ADR 0090), as UNSW Endeavour's "log on":
  // the same only while it shows the same text.
  describe("a click layer", () => {
    const area = id("274:areaElement");
    const layered = (shows?: string) => recipe(undefined, { target: area, shows });
    const layout = (shows?: string) => {
      const stored = layered(shows);
      if (!("layouts" in stored) || !stored.layouts?.[0]) throw new Error("no layout");
      return stored.layouts[0];
    };
    const shown = (button: Partial<ObservedCandidate>) =>
      page([
        ...form.slice(0, 2),
        { id: "c-layer", role: "button", target: area, label: "log on", ...button },
      ]);
    const layer = { overlaid: true } as const;

    it("matches a layer that shows the step's text", () => {
      expect(showsFirstPage(layout("log on"), LEARNED, shown(layer))).toBe(true);
      expect(sameFormRecipe([layered("log on")], shown(layer))?.id).toBe("gen-learned");
      expect(sameFormRecipe([layered("exit")], shown(layer))).toBeUndefined();
    });

    it("matches no layer that shows other text, nor a button that is no layer", () => {
      expect(showsFirstPage(layout("log on"), LEARNED, shown({ ...layer, label: "exit" }))).toBe(
        false,
      );
      expect(showsFirstPage(layout("log on"), LEARNED, shown({}))).toBe(false);
    });

    it("matches no layer with a step that has no `shows`", () => {
      expect(showsFirstPage(layout(), LEARNED, shown(layer))).toBe(false);
      // That step still matches the same element drawn as a button.
      expect(showsFirstPage(layout(), LEARNED, shown({}))).toBe(true);
    });
  });
});
