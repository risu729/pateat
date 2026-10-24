import { describe, expect, it } from "vitest";
import * as v from "valibot";
import {
  loginChooserDocumentSchema,
  loginRecipeDocumentSchema,
  toLoginLayout,
  type LoginChooserDocument,
  type LoginRecipe,
  type LoginRecipeDocument,
} from "@pateat/contracts";
import { chooserRepairWrite, repairBase, repairWrite } from "@pateat/generation";

// Synthetic recipes only (ADR 0041).

const id = (value: string) => ({ by: "id" as const, value });
const text = (value: string) => ({ by: "text" as const, value });

function route(button = "next", extra: Partial<LoginRecipe> = {}): LoginRecipe {
  return {
    version: 1,
    id: `gen-${"a".repeat(32)}`,
    revision: 4,
    origin: "https://login.example",
    pageKind: "sign-in",
    slots: ["username", "password"],
    steps: [
      {
        kind: "fill",
        effect: "prepare",
        path: "/signin",
        fields: [{ slot: "username", target: id("email") }],
      },
      { kind: "click", path: "/signin", target: text(button), purpose: "advance" },
      {
        kind: "fill",
        effect: "prepare",
        path: "/password",
        fields: [{ slot: "password", target: id("password") }],
      },
      { kind: "click", path: "/password", target: id("login"), purpose: "submit" },
    ],
    completion: [{ target: id("sign-out") }],
    maxSubmissions: 2,
    ...extra,
  };
}

function recipe(...layouts: [LoginRecipe, number][]): LoginRecipeDocument {
  return {
    version: 1,
    id: `gen-${"a".repeat(32)}`,
    revision: 4,
    origin: "https://login.example",
    layouts: layouts.map(([layout, createdAt]) =>
      toLoginLayout(layout, { key: String(createdAt), createdAt }),
    ),
  };
}

describe("what a start page's repair writes", () => {
  it("adds a layout for a reworded or translated start page, keeping the others", () => {
    const stored = recipe([route("次へ"), 1000]);
    const written = repairWrite(stored, route("Next"), { createdAt: 2000, language: "en" });
    expect(written).toMatchObject({ kind: "added", layout: "2000" });
    if (written.kind === "same") throw new Error("expected a write");
    expect(v.is(loginRecipeDocumentSchema, written.recipe)).toBe(true);
    expect(written.recipe.revision).toBe(5);
    expect(written.recipe.layouts.map((layout) => [layout.key, layout.language])).toEqual([
      ["1000", undefined],
      ["2000", "en"],
    ]);
    // The stale layout keeps what it learned.
    expect(written.recipe.layouts[0]!.completion).toEqual([{ target: id("sign-out") }]);
  });

  it("writes nothing when a layout already has the answer's start page", () => {
    const stored = recipe([route("次へ"), 1000], [route("Next"), 2000]);
    // A slow page whose elements showed after all: the model gives the same start page,
    // whatever its later pages.
    const answer = route("Next", { completion: undefined, maxSubmissions: 1 });
    answer.steps = answer.steps.slice(0, 2);
    expect(repairWrite(stored, answer, { createdAt: 3000 })).toEqual({
      kind: "same",
      layout: "2000",
    });
  });

  it("merges a passkey button into the layout whose start page is otherwise the same", () => {
    const stored = recipe([route("次へ"), 1000], [route("Next"), 2000]);
    const passkey = { path: "/signin", target: text("Sign in with a passkey") };
    const written = repairWrite(stored, route("Next", { passkey }), { createdAt: 3000 });
    expect(written).toMatchObject({ kind: "merged", layout: "2000" });
    if (written.kind === "same") throw new Error("expected a write");
    expect(written.recipe.layouts).toHaveLength(2);
    expect(written.recipe.layouts[1]).toMatchObject({
      key: "2000",
      passkey,
      completion: [{ target: id("sign-out") }],
    });
    expect(v.is(loginRecipeDocumentSchema, written.recipe)).toBe(true);
  });

  it("merges a passkey button named by other locators while the page shows the layout's elements", () => {
    const stored = recipe([route("Next"), 1000]);
    const passkey = { path: "/signin", target: text("Sign in with a passkey") };
    // The model named the email field by its label and the button by its accessible name.
    const answer = route("Next", { passkey });
    answer.steps = [
      {
        kind: "fill",
        effect: "prepare",
        path: "/signin",
        fields: [{ slot: "username", target: { by: "label", value: "Email" } }],
      },
      {
        kind: "click",
        path: "/signin",
        target: { by: "accessible-name", value: "Next" },
        purpose: "advance",
      },
      ...answer.steps.slice(2),
    ];
    const shown = [id("email"), text("Next"), passkey.target];
    const written = repairWrite(stored, answer, { createdAt: 3000, shown });
    expect(written).toMatchObject({ kind: "merged", layout: "1000" });
    if (written.kind === "same") throw new Error("expected a write");
    // The layout keeps its own locators and what it learned, and gains the button.
    expect(written.recipe.layouts).toEqual([{ ...stored.layouts[0]!, passkey }]);
    // A page that no longer shows one of the layout's elements gets its own layout.
    expect(
      repairWrite(stored, answer, { createdAt: 3000, shown: [text("Next"), passkey.target] }),
    ).toMatchObject({ kind: "added" });
    // Another flow on the start page, as a password asked there too, is no merge.
    const both = route("Next", { passkey });
    both.steps = [
      {
        kind: "fill",
        effect: "prepare",
        path: "/signin",
        fields: [
          { slot: "username", target: id("email") },
          { slot: "password", target: id("pw") },
        ],
      },
      { kind: "click", path: "/signin", target: text("Next"), purpose: "submit" },
    ];
    expect(
      repairWrite(stored, both, { createdAt: 3000, shown: [...shown, id("pw")] }),
    ).toMatchObject({ kind: "added" });
  });

  it("replaces the least recently used layout when three are held", () => {
    const stored = recipe([route("one"), 1000], [route("two"), 2000], [route("three"), 3000]);
    // The oldest layout was used yesterday; the second one never.
    const lastUsed = (key: string) => (key === "1000" ? 5000 : undefined);
    const written = repairWrite(stored, route("four"), { createdAt: 6000, lastUsed });
    expect(written).toMatchObject({ kind: "replaced", layout: "6000", removed: "2000" });
    if (written.kind === "same") throw new Error("expected a write");
    expect(written.recipe.layouts.map((layout) => layout.key)).toEqual(["1000", "3000", "6000"]);
    expect(v.is(loginRecipeDocumentSchema, written.recipe)).toBe(true);
  });

  it("gives a layout created in the same millisecond as another its own key", () => {
    const stored = recipe([route("one"), 1000]);
    expect(repairWrite(stored, route("two"), { createdAt: 1000 })).toMatchObject({
      kind: "added",
      layout: "1001",
    });
  });
});

describe("a later step's repair", () => {
  it("cuts the layout before the step that did not show, without its markers", () => {
    const base = repairBase(route(), 2);
    expect(base?.steps).toEqual(route().steps.slice(0, 2));
    expect(base?.completion).toBeUndefined();
  });

  it("does not cut a layout whose step follows no advance, or with other variants", () => {
    expect(repairBase(route(), 1)).toBeUndefined();
    expect(repairBase(route(), 3)).toBeUndefined();
    expect(repairBase(route(), 0)).toBeUndefined();
    expect(repairBase(route(), 9)).toBeUndefined();
    const variants = route("next", {
      alternatives: [{ slots: ["password"], steps: route().steps.slice(2) }],
    });
    expect(repairBase(variants, 2)).toBeUndefined();
  });

  it("adds the continued layout unless one already has its steps", () => {
    const stale = route();
    const continued = route("next", {
      completion: undefined,
      steps: [
        ...stale.steps.slice(0, 2),
        {
          kind: "fill",
          effect: "prepare",
          path: "/password",
          fields: [{ slot: "password", target: id("passcode") }],
        },
        { kind: "click", path: "/password", target: id("continue"), purpose: "submit" },
      ],
    });
    const stored = recipe([stale, 1000]);
    const written = repairWrite(stored, continued, { createdAt: 2000, later: true });
    expect(written).toMatchObject({ kind: "added", layout: "2000" });
    if (written.kind === "same") throw new Error("expected a write");
    expect(repairWrite(written.recipe, continued, { createdAt: 3000, later: true })).toEqual({
      kind: "same",
      layout: "2000",
    });
  });
});

describe("what a chooser's repaired list writes", () => {
  const chooser = (...others: [string, number][]): LoginChooserDocument => ({
    version: 1,
    id: `gen-${"a".repeat(32)}`,
    revision: 2,
    origin: "https://login.example",
    chooser: {
      path: "/signin",
      layouts: others.map(([other, createdAt]) => ({
        key: String(createdAt),
        createdAt,
        other: text(other),
      })),
    },
  });
  const layout = (other: string, createdAt: number) => ({
    key: String(createdAt),
    createdAt,
    other: text(other),
  });

  it("writes nothing for a list whose buttons a layout has, and adds one otherwise", () => {
    const stored = chooser(["Use another account", 1000]);
    expect(chooserRepairWrite(stored, layout("Use another account", 2000))).toEqual({
      kind: "same",
      layout: "1000",
    });
    const written = chooserRepairWrite(stored, layout("別のアカウント", 2000));
    expect(written).toMatchObject({ kind: "added", layout: "2000" });
    if (written.kind === "same") throw new Error("expected a write");
    expect(v.is(loginChooserDocumentSchema, written.recipe)).toBe(true);
    expect(written.recipe.revision).toBe(3);
  });

  it("replaces the least recently used list when three are held", () => {
    const stored = chooser(["one", 1000], ["two", 2000], ["three", 3000]);
    const written = chooserRepairWrite(stored, layout("four", 6000), (key) =>
      key === "1000" ? 5000 : undefined,
    );
    expect(written).toMatchObject({ kind: "replaced", removed: "2000" });
    if (written.kind === "same") throw new Error("expected a write");
    expect(written.recipe.chooser.layouts.map((entry) => entry.key)).toEqual([
      "1000",
      "3000",
      "6000",
    ]);
  });
});
