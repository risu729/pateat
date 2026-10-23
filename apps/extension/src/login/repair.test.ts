import { describe, expect, it } from "vitest";
import type { LoginStep } from "@pateat/contracts";
import {
  classifyStartMiss,
  createRecipeRepairs,
  MAX_REPAIR_ENTRIES,
  type StartMissVerdict,
} from "./repair";
import type { StartMiss } from "./wire";

// Synthetic recipes and pages only (ADR 0041).

const id = (value: string) => ({ by: "id" as const, value });
const label = (value: string) => ({ by: "label" as const, value });
const text = (value: string) => ({ by: "text" as const, value });
const fill: LoginStep = {
  kind: "fill",
  path: "/login",
  effect: "prepare",
  fields: [
    { slot: "username", target: id("email") },
    { slot: "password", target: label("パスワード") },
  ],
};
const passkey: LoginStep = {
  kind: "click",
  path: "/login",
  target: text("パスキーでログイン"),
  purpose: "advance",
};

describe("which start page misses are sent for repair", () => {
  const miss = (missing: StartMiss["missing"], status?: number): StartMiss => ({
    missing,
    ...(status === undefined ? {} : { status }),
  });
  const cases: [string, LoginStep[], StartMiss | undefined, StartMissVerdict][] = [
    ["a page that said nothing about its miss", [fill], undefined, "no-detail"],
    ["an attribute locator that matches nothing", [fill], miss([id("email")], 200), "stale"],
    ["a label missing, as on the page in English", [fill], miss([label("パスワード")]), "stale"],
    ["a maintenance page served with 503", [fill], miss([id("email")], 503), "status"],
    ["a page answered 404", [fill], miss([id("email")], 404), "status"],
    ["elements found but not usable yet, as on a slow page", [fill], miss([]), "unusable"],
    ["a miss of another recipe's targets only", [fill], miss([id("other")]), "unusable"],
    [
      "the password route missing while its passkey button shows",
      [fill, passkey],
      miss([id("email")]),
      "unusable",
    ],
    [
      "every route's first step missing",
      [fill, passkey],
      miss([id("email"), text("パスキーでログイン")]),
      "stale",
    ],
    // Past the list's limit, an unlisted target may be missing too.
    [
      "more misses than listed, with no watched first step found",
      [fill],
      { missing: [id("other")], more: true },
      "stale",
    ],
    [
      "more misses than listed, with a watched first step found",
      [fill],
      { missing: [id("email")], more: true, found: true },
      "unusable",
    ],
  ];
  it.each(cases)("%s", (_, steps, reported, verdict) => {
    expect(classifyStartMiss(steps, reported)).toBe(verdict);
  });
});

describe("the repairs a device sent", () => {
  const memory = () => {
    let value: unknown;
    let fail = false;
    return {
      storage: {
        read: async () => value,
        write: async (next: unknown) => {
          if (fail) throw new Error("quota");
          value = next;
        },
      },
      get value() {
        return value;
      },
      set value(next) {
        value = next;
      },
      failWrites() {
        fail = true;
      },
    };
  };
  const recipeId = `gen-${"a".repeat(32)}`;
  const other = `gen-${"b".repeat(32)}`;
  const DAY = 24 * 60 * 60 * 1000;

  it("sends each document's stale start page once", async () => {
    const store = memory();
    const repairs = createRecipeRepairs(store.storage, () => 10);
    expect(await repairs.due({ recipeId, revision: 3, documentId: "doc-1" })).toBe("due");
    expect(await repairs.due({ recipeId, revision: 3, documentId: "doc-1" })).toBe("repeat");
    expect(await repairs.due({ recipeId, revision: 3, documentId: "doc-2" })).toBe("due");
    // A newer revision of the same document is another miss.
    expect(await repairs.due({ recipeId, revision: 4, documentId: "doc-2" })).toBe("due");
  });

  it("holds a recipe the service answered until the next UTC day", async () => {
    const store = memory();
    let at = 3 * DAY + 1000;
    const repairs = createRecipeRepairs(store.storage, () => at);
    expect(await repairs.due({ recipeId, revision: 3, documentId: "doc-1" })).toBe("due");
    await repairs.hold(recipeId);
    expect(await repairs.due({ recipeId, revision: 3, documentId: "doc-2" })).toBe("held");
    // A newer revision, as from another device's repair, is held as well: this device's
    // repair of the day is spent at the service.
    expect(await repairs.due({ recipeId, revision: 4, documentId: "doc-3" })).toBe("held");
    expect(await repairs.due({ recipeId: other, revision: 1, documentId: "doc-4" })).toBe("due");
    at = 4 * DAY;
    expect(await repairs.due({ recipeId, revision: 4, documentId: "doc-5" })).toBe("due");
  });

  it("holds nothing for a recipe it never sent", async () => {
    const store = memory();
    const repairs = createRecipeRepairs(store.storage, () => 10);
    await repairs.hold(recipeId);
    expect(store.value).toBeUndefined();
  });

  it("counts a stored record that does not parse as none", async () => {
    const store = memory();
    store.value = { version: 1, recipes: [{ recipeId: "not-a-recipe" }] };
    const repairs = createRecipeRepairs(store.storage, () => 10);
    expect(await repairs.due({ recipeId, revision: 1, documentId: "doc-1" })).toBe("due");
  });

  it("answers unavailable when the record cannot be written", async () => {
    const store = memory();
    store.failWrites();
    const repairs = createRecipeRepairs(store.storage, () => 10);
    expect(await repairs.due({ recipeId, revision: 1, documentId: "doc-1" })).toBe("unavailable");
    // A failed write does not stop the next one.
    await expect(repairs.hold(recipeId)).resolves.toBeUndefined();
  });

  it("keeps the most recently sent recipes", async () => {
    const store = memory();
    const repairs = createRecipeRepairs(store.storage, () => 10);
    for (let index = 0; index <= MAX_REPAIR_ENTRIES; index += 1)
      // eslint-disable-next-line no-await-in-loop
      await repairs.due({
        recipeId: `gen-${index.toString(16).padStart(32, "0")}`,
        revision: 1,
        documentId: `doc-${index}`,
      });
    const stored = store.value as { recipes: { recipeId: string }[] };
    expect(stored.recipes).toHaveLength(MAX_REPAIR_ENTRIES);
    expect(stored.recipes[0]!.recipeId).toBe(`gen-${"1".padStart(32, "0")}`);
  });
});
