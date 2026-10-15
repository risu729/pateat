import { describe, expect, it } from "vitest";
import type { LoginRecipe } from "@pateat/contracts";
import {
  classifyStartMiss,
  createRecipeRepairs,
  REPAIR_MISSES,
  type StartMissVerdict,
} from "./repair";
import type { StartMiss } from "./wire";

// Synthetic recipes and pages only (proposed ADR 0041).

const id = (value: string) => ({ by: "id" as const, value });
const label = (value: string) => ({ by: "label" as const, value });
const text = (value: string) => ({ by: "text" as const, value });
const recipe = (
  fields: LoginRecipe["steps"][number] & { kind: "fill" },
  language?: "ja" | "en",
): Pick<LoginRecipe, "steps" | "language"> => ({
  steps: [fields, { kind: "click", path: "/login", target: text("Sign in"), purpose: "submit" }],
  ...(language ? { language } : {}),
});
const byId = recipe(
  {
    kind: "fill",
    path: "/login",
    effect: "prepare",
    fields: [
      { slot: "username", target: id("email") },
      { slot: "password", target: id("password") },
    ],
  },
  "en",
);
const byLabel = recipe(
  {
    kind: "fill",
    path: "/login",
    effect: "prepare",
    fields: [
      { slot: "username", target: label("メールアドレス") },
      { slot: "password", target: label("パスワード") },
    ],
  },
  "ja",
);
const mixed = recipe(
  {
    kind: "fill",
    path: "/login",
    effect: "prepare",
    fields: [
      { slot: "username", target: id("email") },
      { slot: "password", target: label("パスワード") },
    ],
  },
  "ja",
);

describe("which start page misses count toward a repair", () => {
  const miss = (missing: StartMiss["missing"], extra: Partial<StartMiss> = {}): StartMiss => ({
    missing,
    language: "en",
    status: 200,
    ...extra,
  });
  const cases: [
    string,
    Pick<LoginRecipe, "steps" | "language">,
    StartMiss | undefined,
    StartMissVerdict,
  ][] = [
    ["a page that said nothing about its miss", byId, undefined, "no-detail"],
    ["an attribute locator that matches nothing", byId, miss([id("email")]), "stale"],
    [
      "a locator that matches several elements, reported with the missing",
      byId,
      miss([id("password")]),
      "stale",
    ],
    ["a maintenance page served with 503", byId, miss([id("email")], { status: 503 }), "status"],
    ["a page answered 404", byId, miss([id("email")], { status: 404 }), "status"],
    [
      "a load whose status the browser did not report",
      byId,
      miss([id("email")], { status: undefined }),
      "stale",
    ],
    ["elements found but not usable yet, as on a slow page", byId, miss([]), "unusable"],
    ["a miss of another recipe's targets only", byId, miss([id("other")]), "unusable"],
    // The owner's case: the same page in another language.
    [
      "Japanese labels on the page in English",
      byLabel,
      miss([label("パスワード")], { language: "en" }),
      "language",
    ],
    [
      "Japanese labels on the Japanese page, reworded",
      byLabel,
      miss([label("パスワード")], { language: "ja" }),
      "stale",
    ],
    [
      "Japanese labels on a page of mixed language",
      byLabel,
      miss([label("パスワード")], { language: "mixed" }),
      "stale",
    ],
    [
      "a label and an attribute locator both missing in English",
      mixed,
      miss([id("email"), label("パスワード")], { language: "en" }),
      "stale",
    ],
    [
      "only the label missing in English",
      mixed,
      miss([label("パスワード")], { language: "en" }),
      "language",
    ],
    // A recipe that records no language is read by the words of its missing locators.
    [
      "Japanese labels of a recipe with no recorded language, on the English page",
      { steps: byLabel.steps },
      miss([label("パスワード")], { language: "en" }),
      "language",
    ],
    [
      "Japanese labels of a recipe with no recorded language, on the Japanese page",
      { steps: byLabel.steps },
      miss([label("パスワード")], { language: "ja" }),
      "stale",
    ],
    [
      // Japanese pages also name fields in Latin letters, so these say nothing.
      "English text of a recipe with no recorded language, on the Japanese page",
      { steps: [{ kind: "click", path: "/login", target: text("Sign in"), purpose: "submit" }] },
      miss([text("Sign in")], { language: "ja" }),
      "stale",
    ],
    [
      "labels in both scripts of a recipe with no recorded language",
      recipe({
        kind: "fill",
        path: "/login",
        effect: "prepare",
        fields: [
          { slot: "username", target: label("Email") },
          { slot: "password", target: label("パスワード") },
        ],
      }),
      miss([label("Email"), label("パスワード")], { language: "en" }),
      "stale",
    ],
  ];
  it.each(cases)("%s", (_name, given, reported, verdict) => {
    expect(classifyStartMiss(given, reported)).toBe(verdict);
  });
});

describe("misses in a row", () => {
  function store(now = { at: Date.UTC(2026, 9, 15, 12) }) {
    const storage = { value: undefined as unknown };
    const repairs = createRecipeRepairs(
      {
        read: async () => storage.value,
        write: async (value) => {
          storage.value = structuredClone(value);
        },
      },
      () => now.at,
    );
    return { repairs, storage, now };
  }
  const entry = (documentId: string, revision = 1, path = "/login") => ({
    recipeId: "gen-a",
    revision,
    path,
    documentId,
  });

  it("is due once separate page loads missed in a row", async () => {
    const { repairs } = store();
    expect(REPAIR_MISSES).toBe(2);
    expect(await repairs.miss(entry("d1"))).toBe("noted");
    // The same document reporting again is not another load.
    expect(await repairs.miss(entry("d1"))).toBe("repeat");
    expect(await repairs.miss(entry("d2"))).toBe("due");
    // A sent repair starts the count over.
    expect(await repairs.miss(entry("d3"))).toBe("noted");
    expect(await repairs.miss(entry("d4"))).toBe("due");
  });

  it("starts over on another revision or path, or once a login started", async () => {
    const { repairs } = store();
    await repairs.miss(entry("d1"));
    expect(await repairs.miss(entry("d2", 2))).toBe("noted");
    expect(await repairs.miss(entry("d3", 2, "/signin"))).toBe("noted");
    await repairs.started("gen-a");
    expect(await repairs.miss(entry("d4", 2, "/signin"))).toBe("noted");
    expect(await repairs.miss(entry("d5", 2, "/signin"))).toBe("due");
  });

  it("holds a recipe whose repair was tried until the next UTC day", async () => {
    const { repairs, now } = store();
    await repairs.miss(entry("d1"));
    await repairs.miss(entry("d2"));
    await repairs.tried("gen-a");
    // A newer revision keeps the day's try.
    await repairs.miss(entry("d3", 2));
    expect(await repairs.miss(entry("d4", 2))).toBe("held");
    now.at = Date.UTC(2026, 9, 16, 0, 1);
    expect(await repairs.miss(entry("d5", 2))).toBe("due");
  });

  it("counts stored records that do not parse as none, and reports a failed write", async () => {
    const { repairs, storage } = store();
    storage.value = { version: 0 };
    expect(await repairs.miss(entry("d1"))).toBe("noted");
    const failing = createRecipeRepairs({
      read: async () => undefined,
      write: async () => {
        throw new Error("quota");
      },
    });
    expect(await failing.miss(entry("d1"))).toBe("unavailable");
    await expect(failing.started("gen-a")).resolves.toBeUndefined();
  });
});
