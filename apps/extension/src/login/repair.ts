import { sameLoginTarget, syncRecipeIdSchema, type LoginRecipe } from "@pateat/contracts";
import * as v from "valibot";
import { loginReadiness, type StartMiss } from "./wire";

// Repairing a generated recipe whose start page no longer matches it (proposed ADR 0039,
// Claude's design pending the owner's approval): which misses count, and how many page
// loads in a row it takes before the start page is sent to be generated again.

/**
 * What one start page's miss says about its recipe: `stale` when it counts toward a
 * repair; otherwise why not. `status` for a document whose load the server answered with
 * an error status, as a maintenance page on the login page's URL; `unusable` when every
 * element was found once but cannot be used yet, as on a slow page; `language` when only
 * text or label locators miss and the page now reads in another language than the one
 * the recipe was generated on; `no-detail` when the page did not say what it missed.
 */
export type StartMissVerdict = "stale" | "status" | "unusable" | "language" | "no-detail";

/** Whether a locator depends on the page's wording: a button's text or a field's name. */
const worded = (target: { by: string }) => target.by === "text" || target.by === "label";
const japanese = /[\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Han}]/u;
/**
 * The language worded locators were written in, for a recipe that records none (one
 * generated on a page of mixed language): Japanese when every value holds Japanese
 * script. Latin letters say nothing, since Japanese pages also name fields "ID" or
 * "Email".
 */
function wordedLanguage(values: readonly string[]): "ja" | undefined {
  return values.length && values.every((value) => japanese.test(value)) ? "ja" : undefined;
}

/**
 * Whether a recipe's start page, which showed a sign-in input for the step wait without
 * a ready first step, counts as a stale recipe. Only the first step of the recipe's own
 * steps (its first variant) is compared: that is the page a repair generates again.
 */
export function classifyStartMiss(
  recipe: Pick<LoginRecipe, "steps" | "language">,
  miss: StartMiss | undefined,
): StartMissVerdict {
  if (!miss) return "no-detail";
  if (miss.status !== undefined && (miss.status < 200 || miss.status > 299)) return "status";
  const first = recipe.steps[0];
  const missing = first
    ? loginReadiness(first).targets.filter((target) =>
        miss.missing.some((other) => sameLoginTarget(other, target)),
      )
    : [];
  if (!missing.length) return "unusable";
  // Same page in another language: the recipe is still right where its words show. A
  // recipe that records no language is read by the words of its missing locators.
  const written =
    recipe.language ??
    (missing.every(worded)
      ? wordedLanguage(missing.map((target) => ("value" in target ? String(target.value) : "")))
      : undefined);
  if (
    missing.every(worded) &&
    written !== undefined &&
    (miss.language === "ja" || miss.language === "en") &&
    miss.language !== written
  )
    return "language";
  return "stale";
}

/** How many separate page loads of the start page must miss in a row (proposed ADR 0039). */
export const REPAIR_MISSES = 2;
/** Recipes whose misses are remembered at once; the least recently missed go first. */
export const MAX_REPAIR_ENTRIES = 200;
const DAY_MS = 24 * 60 * 60 * 1000;
const utcDay = (at: number) => Math.floor(at / DAY_MS);

const repairsSchema = v.strictObject({
  version: v.literal(1),
  recipes: v.pipe(
    v.array(
      v.strictObject({
        recipeId: syncRecipeIdSchema,
        revision: v.pipe(v.number(), v.integer(), v.minValue(1)),
        path: v.pipe(v.string(), v.maxLength(300)),
        /** The documents whose start page missed, oldest first. */
        documents: v.pipe(
          v.array(v.pipe(v.string(), v.minLength(1), v.maxLength(120))),
          v.maxLength(REPAIR_MISSES),
        ),
        /** When the service last answered a repair of this recipe, but `busy`. */
        tried: v.optional(v.pipe(v.number(), v.integer(), v.minValue(0))),
      }),
    ),
    v.maxLength(MAX_REPAIR_ENTRIES),
  ),
});
type RepairRecords = v.InferOutput<typeof repairsSchema>;
type RepairRecord = RepairRecords["recipes"][number];

export interface RepairStorage {
  read(): Promise<unknown>;
  write(value: RepairRecords): Promise<void>;
}

/**
 * What a counted miss leads to: `noted` until the misses in a row reach the limit, `due`
 * when the start page should be sent for repair now, `held` when a repair of the recipe
 * was already tried this UTC day, `repeat` for a document that missed before, and
 * `unavailable` when the record could not be read or written.
 */
export type RepairNote = "noted" | "due" | "held" | "repeat" | "unavailable";

export interface RecipeRepairs {
  /** Counts one document's miss of a recipe revision's start page. */
  miss(entry: {
    recipeId: string;
    revision: number;
    path: string;
    documentId: string;
  }): Promise<RepairNote>;
  /** A login started on the recipe, so its start page matched: the misses start over. */
  started(recipeId: string): Promise<void>;
  /** The service answered a repair of the recipe, so it is held until the next UTC day. */
  tried(recipeId: string): Promise<void>;
}

/**
 * The misses of each generated recipe's start page on this device, kept across service
 * worker restarts. Stored records that do not parse count as none.
 */
export function createRecipeRepairs(
  storage: RepairStorage,
  now: () => number = Date.now,
): RecipeRepairs {
  let queue: Promise<unknown> = Promise.resolve();
  // Recipes known to have misses, so a login's start reads storage only when it may write.
  let known: Set<string> | undefined;
  function update<T>(change: (records: RepairRecord[]) => { records?: RepairRecord[]; result: T }) {
    const next = queue.then(async () => {
      const parsed = v.safeParse(repairsSchema, await storage.read());
      const records = parsed.success ? parsed.output.recipes : [];
      const { records: changed, result } = change(records);
      if (changed) {
        const kept = changed.slice(-MAX_REPAIR_ENTRIES);
        await storage.write({ version: 1, recipes: kept });
        known = new Set(
          kept.filter((entry) => entry.documents.length).map((entry) => entry.recipeId),
        );
      } else
        known ??= new Set(
          records.filter((entry) => entry.documents.length).map((entry) => entry.recipeId),
        );
      return result;
    });
    queue = next.catch(() => undefined);
    return next;
  }
  const without = (records: RepairRecord[], recipeId: string) =>
    records.filter((entry) => entry.recipeId !== recipeId);
  return {
    miss({ recipeId, revision, path, documentId }) {
      return update<RepairNote>((records) => {
        const before = records.find((entry) => entry.recipeId === recipeId);
        // Another revision or start path starts the count over; the day's try is kept.
        const same = before?.revision === revision && before.path === path;
        const documents = same ? before.documents : [];
        if (documents.includes(documentId)) return { result: "repeat" };
        const record: RepairRecord = {
          recipeId,
          revision,
          path,
          documents: [...documents, documentId].slice(-REPAIR_MISSES),
          ...(before?.tried === undefined ? {} : { tried: before.tried }),
        };
        const result: RepairNote =
          record.documents.length < REPAIR_MISSES
            ? "noted"
            : record.tried !== undefined && utcDay(record.tried) === utcDay(now())
              ? "held"
              : "due";
        // A sent repair starts the count over, so a repair the service did not take is
        // asked for again only after as many loads again.
        if (result === "due") record.documents = [];
        return { records: [...without(records, recipeId), record], result };
      }).catch(() => "unavailable" as const);
    },
    async started(recipeId) {
      if (known && !known.has(recipeId)) return;
      await update((records) => {
        const before = records.find((entry) => entry.recipeId === recipeId);
        if (!before?.documents.length) return { result: undefined };
        return {
          records: [...without(records, recipeId), { ...before, documents: [] }],
          result: undefined,
        };
      }).catch(() => undefined);
    },
    async tried(recipeId) {
      await update((records) => {
        const before = records.find((entry) => entry.recipeId === recipeId);
        if (!before) return { result: undefined };
        return {
          records: [...without(records, recipeId), { ...before, tried: now() }],
          result: undefined,
        };
      }).catch(() => undefined);
    },
  };
}
