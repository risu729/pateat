import {
  loginObservationSchema,
  semanticSlotsSchema,
  type LoginObservation,
  type SemanticSlot,
  type ValueShape,
} from "@pateat/contracts";
import * as v from "valibot";
import type { CaseRequest, ScoredResult } from "./cases";
import type { LabelSource, LogCorpusFile, LoggedLogin, LogPageCase, LogPageDraft } from "./log";

/**
 * One `inference_log` generation row as a read-only SELECT of the production database
 * returns it (ADR 0012): `request`, `answer` and `result` are JSON text.
 */
export type LogRow = {
  id: string;
  owner_id: string;
  origin: string;
  path: string;
  recipe_page: string | null;
  request: string;
  answer: string | null;
  result: string | null;
  outcome: string;
  model_id: string | null;
  effort: string | null;
  speed: string | null;
  prompt_version: string | null;
  source: string | null;
  build: string | null;
  created_at: number;
  recipe_id: string | null;
  branch: string | null;
  revision: number | null;
  observation_hash: string | null;
};

/** One `login_outcomes` row (ADR 0012). */
export type OutcomeRow = {
  owner_id: string;
  recipe_id: string;
  /** The recipe layout (ADR 0060), then `:` and the chooser branch when there is one. */
  branch: string;
  revision: number;
  outcome: string;
  cause: string | null;
  step: number;
};

/**
 * Replacements for text that would reveal more than the site (ADR 0012): each logged
 * vault field name to a synthetic name of the same meaning, and any other page text, such
 * as a person's name, to a synthetic one. Kept outside the repository.
 */
export type Replacements = {
  fieldNames?: Record<string, string>;
  text?: Record<string, string>;
};

/** Hosts of the owner's local test servers, never part of a corpus. */
const localHosts = new Set(["localhost", "127.0.0.1", "[::1]"]);

/**
 * Hosts whose subdomain or path names a tenant, workspace or person rather than the site
 * (owner, 2026-11-03 11:35 UTC: `*.slack.com`, `*.oraclecloud.com`). A hint for the
 * reviewer, who decides.
 */
const tenantHosts = [
  /^(?!app\.)[^.]+\.(enterprise\.)?slack\.com$/u,
  /\.oraclecloud\.com$/u,
  /\.smarthr\.jp$/u,
  /\.snar\.jp$/u,
  /\.starrezhousing\.com$/u,
  /\.atlassian\.net$/u,
  /\.okta\.com$/u,
  /\.my\.salesforce\.com$/u,
  /\.zendesk\.com$/u,
  /\.myshopify\.com$/u,
];
// A label or path segment that looks like an identifier: 16 or more hex digits, or a UUID.
const longId = /[0-9a-f]{16,}|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/iu;
const email = /[\w.+-]+@[\w-]+(?:\.[\w-]+)+/gu;
const digitRun = /\d{4,}/gu;

/** A synthetic digit string of the same length, so length constraints still read the same. */
const syntheticDigits = (length: number) =>
  Array.from({ length }, (_, index) => String((index + 1) % 10)).join("");

/**
 * Replaces in one page text what could identify the owner: the configured strings, email
 * addresses and runs of four or more digits.
 */
export function scrubText(text: string, replacements: ReadonlyMap<string, string>): string {
  let scrubbed = text;
  // Longest first, so a full name is replaced before a part of it.
  for (const [from, to] of [...replacements].sort((a, b) => b[0].length - a[0].length))
    scrubbed = scrubbed.split(from).join(to);
  return scrubbed
    .replace(email, "user@example.com")
    .replace(digitRun, (run) => syntheticDigits(run.length));
}

// Observation keys whose values are structure, not page text.
const structuralKeys = new Set([
  "version",
  "origin",
  "language",
  "complete",
  "id",
  "role",
  "by",
  "group",
  "autocomplete",
  "inputMode",
  "accountEntries",
]);

function scrubValue(value: unknown, key: string, replace: (text: string) => string): unknown {
  if (typeof value === "string") return structuralKeys.has(key) ? value : replace(value);
  if (Array.isArray(value)) return value.map((entry) => scrubValue(entry, key, replace));
  if (value !== null && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value).map(([entryKey, entry]) => [
        entryKey,
        scrubValue(entry, entryKey, replace),
      ]),
    );
  return value;
}

/**
 * The observation with its page text scrubbed. Each listed account becomes `Account N`,
 * wherever its text shows, since a list shows the owner's own names.
 */
export function scrubObservation(
  observation: LoginObservation,
  replacements: ReadonlyMap<string, string>,
): LoginObservation {
  const all = new Map(replacements);
  observation.accounts?.forEach((entry, index) => all.set(entry, `Account ${index + 1}`));
  return scrubValue(observation, "", (text) => scrubText(text, all)) as LoginObservation;
}

/**
 * A value shape that keeps what tells fields apart, its character classes, whether it is
 * an email, and a short length exactly (a 3-digit branch from a 7-digit account), but
 * rounds a length over 8 up to a multiple of 4, so a username's exact length is not kept.
 */
export function coarseShape(shape: ValueShape): ValueShape {
  const length = shape.length <= 8 ? shape.length : Math.min(1024, Math.ceil(shape.length / 4) * 4);
  return { ...shape, length };
}

/**
 * The slots with each vault field name replaced by its synthetic name, or `field N` when
 * none is configured, and every value shape coarsened (ADR 0012).
 */
export function scrubSlots(
  slots: readonly SemanticSlot[],
  fieldNames: Readonly<Record<string, string>>,
): { slots: SemanticSlot[]; unnamed: string[] } {
  const unnamed: string[] = [];
  const scrubbed = slots.map((slot, index) => {
    const named =
      slot.fieldName === undefined
        ? {}
        : { fieldName: fieldNames[slot.fieldName] ?? `field ${index + 1}` };
    if (slot.fieldName !== undefined && fieldNames[slot.fieldName] === undefined)
      unnamed.push(slot.id);
    return {
      ...slot,
      ...named,
      ...(slot.valueShape === undefined ? {} : { valueShape: coarseShape(slot.valueShape) }),
    };
  });
  return { slots: scrubbed, unnamed };
}

/** Why a page may reveal more than which site the owner uses. */
export function privateHints(origin: string, path: string): string[] {
  const host = new URL(origin).hostname;
  const hints: string[] = [];
  if (tenantHosts.some((pattern) => pattern.test(host))) hints.push(`tenant host ${host}`);
  if (host.split(".").some((label) => longId.test(label))) hints.push(`identifier in host ${host}`);
  if (path.split("/").some((segment) => longId.test(segment) || /\d{4,}/u.test(segment)))
    hints.push("identifier in path");
  return hints;
}

const parseJson = (text: string | null): unknown => (text === null ? undefined : JSON.parse(text));

type LoggedRequest = {
  slots?: unknown;
  observation?: unknown;
  passkeyOnly?: unknown;
  signedIn?: unknown;
};

/** The case request a log row's request implies. */
function caseRequest(row: LogRow, request: LoggedRequest): CaseRequest | undefined {
  const flags: CaseRequest = {
    ...(row.recipe_page === "continuation" ? { startPage: false as const } : {}),
    ...(typeof request.signedIn === "boolean" ? { signedIn: request.signedIn } : {}),
    ...(request.passkeyOnly === true ? { passkeyOnly: true as const } : {}),
    ...(request.slots === undefined && request.passkeyOnly !== true
      ? { entry: true as const }
      : {}),
  };
  return Object.keys(flags).length === 0 ? undefined : flags;
}

// The chooser branch an outcome's branch names, after its layout (ADR 0060).
const chooserBranch = (branch: string) => {
  const colon = branch.indexOf(":");
  return colon === -1 ? "" : branch.slice(colon + 1);
};

/** The first reported login of the row's revision, else of the next one its recipe wrote. */
export function loginOf(row: LogRow, outcomes: readonly OutcomeRow[]): LoggedLogin | undefined {
  if (row.recipe_id === null || row.revision === null) return undefined;
  const revision = row.revision;
  const ofRecipe = outcomes.filter(
    (outcome) =>
      outcome.owner_id === row.owner_id &&
      outcome.recipe_id === row.recipe_id &&
      chooserBranch(outcome.branch) === (row.branch ?? "") &&
      outcome.revision >= revision,
  );
  const same = ofRecipe.find((outcome) => outcome.revision === revision);
  const later = ofRecipe
    .filter((outcome) => outcome.revision > revision)
    .sort((a, b) => a.revision - b.revision)[0];
  const found = same ?? later;
  if (found === undefined) return undefined;
  return {
    outcome: found.outcome,
    cause: found.cause,
    step: found.step,
    revision: same === undefined ? "later" : "same",
  };
}

/**
 * Turns request-log generation rows into unlabelled cases (ADR 0012). Rows of the owner's
 * local test servers and rows whose request no longer parses are left out. Rows asking
 * the same thing of the same observation become one case, kept from the latest row with a
 * model answer (else the latest row), with every row's ID.
 */
export function draftLogCases(
  rows: readonly LogRow[],
  outcomes: readonly OutcomeRow[],
  replacements: Replacements = {},
): { drafts: LogPageDraft[]; skipped: { id: string; reason: string }[] } {
  const text = new Map(Object.entries(replacements.text ?? {}));
  const skipped: { id: string; reason: string }[] = [];
  const groups = new Map<string, { row: LogRow; request: LoggedRequest }[]>();
  for (const row of rows) {
    if (localHosts.has(new URL(row.origin).hostname)) {
      skipped.push({ id: row.id, reason: "local test server" });
      continue;
    }
    const request = parseJson(row.request) as LoggedRequest;
    const key = JSON.stringify([
      row.observation_hash,
      row.recipe_page,
      caseRequest(row, request),
      request.slots,
    ]);
    groups.set(key, [...(groups.get(key) ?? []), { row, request }]);
  }
  const drafts: LogPageDraft[] = [];
  const ids = new Map<string, number>();
  for (const group of groups.values()) {
    const byTime = [...group].sort((a, b) => b.row.created_at - a.row.created_at);
    const { row, request } = byTime.find((entry) => entry.row.answer !== null) ?? byTime[0]!;
    const observation = v.safeParse(loginObservationSchema, request.observation);
    if (!observation.success) {
      skipped.push({ id: row.id, reason: "observation no longer parses" });
      continue;
    }
    const slotless = request.slots === undefined || observation.output.accounts !== undefined;
    const parsedSlots = slotless ? undefined : v.safeParse(semanticSlotsSchema, request.slots);
    if (parsedSlots !== undefined && !parsedSlots.success) {
      skipped.push({ id: row.id, reason: "slots no longer parse" });
      continue;
    }
    const { slots, unnamed } = scrubSlots(parsedSlots?.output ?? [], replacements.fieldNames ?? {});
    const base = `log-${row.observation_hash ?? row.id}`;
    const seen = (ids.get(base) ?? 0) + 1;
    ids.set(base, seen);
    const flags = caseRequest(row, request);
    const login = loginOf(row, outcomes);
    const answer = parseJson(row.answer);
    const result = parseJson(row.result);
    drafts.push({
      id: seen === 1 ? base : `${base}-${seen}`,
      source: {
        dataset: "log",
        logIds: group.map((entry) => entry.row.id).sort(),
        observed: new Date(row.created_at).toISOString().slice(0, 10),
        build: row.build,
      },
      ...(flags === undefined ? {} : { request: flags }),
      slots,
      observation: scrubObservation(observation.output, text),
      logged: {
        outcome: row.outcome,
        promptVersion: row.prompt_version,
        modelId: row.model_id,
        effort: row.effort,
        speed: row.speed,
        source: row.source,
        ...(answer === undefined ? {} : { answer }),
        ...(result === undefined ? {} : { result }),
      },
      ...(login === undefined ? {} : { login }),
      privateHints: [
        ...privateHints(row.origin, row.path),
        ...unnamed.map((slot) => `no synthetic name for ${slot}'s vault field`),
      ],
    });
  }
  drafts.sort((a, b) => a.id.localeCompare(b.id));
  return { drafts, skipped };
}

/**
 * A labeller's verdict on one draft: its truth and who labelled it, and whether the page
 * stays outside the repository; or why it is left out of scoring, such as a page the
 * labellers could not decide.
 */
export type CaseLabel =
  | { expected: ScoredResult; labelSource: LabelSource; private?: boolean }
  | { exclude: string };

/**
 * Splits labelled drafts into the repository's corpus and the one kept outside it (owner,
 * 2026-11-03 11:35 UTC). A draft without a label is reported, never guessed; a draft whose
 * private hints are still open needs its label to say `private` either way.
 */
export function assembleLogCorpus(
  drafts: readonly LogPageDraft[],
  labels: Readonly<Record<string, CaseLabel>>,
  built: string,
): { public: LogCorpusFile; private: LogCorpusFile; unlabelled: string[]; undecided: string[] } {
  const source = { dataset: "log" as const, built };
  const shown: LogPageCase[] = [];
  const kept: LogPageCase[] = [];
  const unlabelled: string[] = [];
  const undecided: string[] = [];
  for (const draft of drafts) {
    const label = labels[draft.id];
    if (label === undefined) {
      unlabelled.push(draft.id);
      continue;
    }
    if ("exclude" in label) continue;
    if (draft.privateHints.length > 0 && label.private === undefined) {
      undecided.push(draft.id);
      continue;
    }
    const { privateHints: _hints, ...rest } = draft;
    const entry: LogPageCase = {
      ...rest,
      expected: label.expected,
      labelSource: label.labelSource,
    };
    (label.private ? kept : shown).push(entry);
  }
  return {
    public: { source, cases: shown },
    private: { source, cases: kept },
    unlabelled,
    undecided,
  };
}
