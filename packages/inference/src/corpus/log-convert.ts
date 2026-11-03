import {
  loginObservationSchema,
  semanticSlotsSchema,
  type LoginObservation,
  type SemanticSlot,
} from "@pateat/contracts";
import * as v from "valibot";
import type { CaseRequest, ScoredResult } from "./cases";
import type { LabelSource, LogCorpusFile, LoggedLogin, LogPageCase, LogPageDraft } from "./log";

/**
 * One `inference_log` row as a read-only SELECT of the production database returns it
 * (ADR 0012): `request`, `answer` and `result` are JSON text. Only generation rows become
 * cases.
 */
export type LogRow = {
  id: string;
  owner_id: string;
  role: string;
  origin: string;
  path: string;
  recipe_page: string | null;
  request: string | null;
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
  /** The request's branch: empty on a first page, else `<layout>[:<chooser branch>]`. */
  branch: string | null;
  /** The recipe layout (ADR 0060); null on rows from before layouts. */
  layout: string | null;
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
/** Hosts whose pages beyond sign-in show the owner's own repositories. */
const codeHosts = new Set(["github.com", "gitlab.com", "bitbucket.org"]);
const codeHostSignIn = /^\/(login|session|sessions|signin|users\/sign_in)(\/|$)/u;
// A label or path segment that looks like an identifier: 16 or more hex digits, or a UUID.
const longId = /[0-9a-f]{16,}|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/iu;
const email = /[\w.+-]+@[\w-]+(?:\.[\w-]+)+/gu;
// ASCII and full-width digits, as Japanese pages print both.
const digitRun = /[0-9０-９]{4,}/gu;
// The redaction marks a listed account's text keeps (`accountText` in plan.ts).
const accountMarks = /\[(?:email|masked|number|account)\]/gu;

/**
 * A synthetic digit string of the same length, so length constraints still read the same,
 * and unused on the page so far, so distinct runs stay distinct.
 */
function syntheticDigits(length: number, used: ReadonlySet<string>): string {
  const base = Array.from({ length }, (_, position) => String((position + 1) % 10)).join("");
  for (let attempt = 0; ; attempt += 1) {
    const suffix = attempt === 0 ? "" : String(attempt);
    const candidate = base.slice(0, Math.max(0, length - suffix.length)) + suffix;
    if (!used.has(candidate)) return candidate;
  }
}

const escapeRegExp = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");

/** A text scrubber for one page: the same original run always gets the same synthetic one. */
export function textScrubber(replacements: ReadonlyMap<string, string>): (text: string) => string {
  // One pass, longest first, so a full name is replaced before a part of it and no
  // replacement is scanned again.
  const keys = [...replacements.keys()].filter((key) => key !== "");
  keys.sort((a, b) => b.length - a.length);
  const pattern =
    keys.length === 0 ? undefined : new RegExp(keys.map(escapeRegExp).join("|"), "gu");
  const runs = new Map<string, string>();
  const used = new Set<string>();
  return (text) => {
    const replaced =
      pattern === undefined ? text : text.replace(pattern, (match) => replacements.get(match)!);
    return replaced.replace(email, "user@example.com").replace(digitRun, (run) => {
      const known = runs.get(run);
      if (known !== undefined) return known;
      const synthetic = syntheticDigits(run.length, used);
      runs.set(run, synthetic);
      used.add(synthetic);
      return synthetic;
    });
  };
}

/**
 * Replaces in one page text what could identify the owner: the configured strings, email
 * addresses and runs of four or more digits.
 */
export const scrubText = (text: string, replacements: ReadonlyMap<string, string>) =>
  textScrubber(replacements)(text);

// Keys whose values are structure, not page text.
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
  "decision",
  "pageKind",
  "irreversible",
  "slot",
  "candidate",
  "purpose",
  "recipeId",
  "layout",
  "kind",
  "status",
  "reason",
  "outcome",
  "check",
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

// A listed account as `Account N` with the redaction marks its text had (`Account 1 [email]`).
const accountName = (entry: string, index: number) =>
  [`Account ${index + 1}`, ...(entry.match(accountMarks) ?? [])].join(" ");

/**
 * The page's replacements plus each listed account's text, wherever it shows, as its
 * {@link accountName}: a list shows the owner's own names, and the role tells account text
 * by those marks. An entry that is only marks, or shown twice, is replaced in the list
 * alone, since its text says nothing of the owner and also shows elsewhere.
 */
function pageReplacements(
  observation: LoginObservation,
  replacements: ReadonlyMap<string, string>,
): Map<string, string> {
  const all = new Map(replacements);
  const entries = observation.accounts ?? [];
  entries.forEach((entry, index) => {
    const onlyMarks = entry.replace(accountMarks, "").trim() === "";
    const repeated = entries.indexOf(entry) !== index || entries.lastIndexOf(entry) !== index;
    if (!onlyMarks && !repeated && !all.has(entry)) all.set(entry, accountName(entry, index));
  });
  return all;
}

/** Scrubs an observation's page text, and names each listed account by its position. */
function scrubPage(observation: LoginObservation, replace: (text: string) => string): unknown {
  const scrubbed = scrubValue(observation, "", replace) as LoginObservation;
  return observation.accounts === undefined
    ? scrubbed
    : { ...scrubbed, accounts: observation.accounts.map(accountName) };
}

/** The observation with its page text scrubbed; see {@link pageReplacements}. */
export function scrubObservation(
  observation: LoginObservation,
  replacements: ReadonlyMap<string, string>,
): LoginObservation {
  const replace = textScrubber(pageReplacements(observation, replacements));
  return scrubPage(observation, replace) as LoginObservation;
}

/**
 * The slots with each vault field name replaced by its synthetic name, or `field N` when
 * none is configured. Value shapes stay exactly as production sent them (ADR 0012): a
 * rounded length made a 9-digit member number look like a 12-character email.
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
    return { ...slot, ...named };
  });
  return { slots: scrubbed, unnamed };
}

/** Why a page may reveal more than which site the owner uses. */
export function privateHints(origin: string, path: string): string[] {
  const host = new URL(origin).hostname;
  const hints: string[] = [];
  if (tenantHosts.some((pattern) => pattern.test(host))) hints.push(`tenant host ${host}`);
  // A code host's page beyond its sign-in names the owner's repositories and their text.
  if (codeHosts.has(host) && !codeHostSignIn.test(path)) hints.push(`repository page on ${host}`);
  if (host.split(".").some((label) => longId.test(label))) hints.push(`identifier in host ${host}`);
  if (path.split("/").some((segment) => longId.test(segment) || /\d{4,}/u.test(segment)))
    hints.push("identifier in path");
  return hints;
}

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

// The layout an outcome's branch names, before any chooser branch (ADR 0060).
const outcomeLayout = (branch: string) => branch.split(":", 1)[0]!;

/**
 * The first reported login of the row's revision, else of the revision right after it.
 * Rows from before recipe layouts (ADR 0060) get none: that migration removed every login
 * outcome and restarted revisions. A later page's row matches its own branch; a first
 * page's row matches any branch of its layout, so a list of accounts counts the logins its
 * chooser branches ran.
 */
export function loginOf(row: LogRow, outcomes: readonly OutcomeRow[]): LoggedLogin | undefined {
  if (row.recipe_id === null || row.revision === null || row.layout === null) return undefined;
  const layout = row.layout;
  const branch = row.branch ?? "";
  // A first page prefers the layout's own branch, then the chooser branches in order, so
  // the result does not depend on the export's row order.
  const matching = (revision: number) =>
    outcomes
      .filter(
        (outcome) =>
          outcome.owner_id === row.owner_id &&
          outcome.recipe_id === row.recipe_id &&
          outcome.revision === revision &&
          (branch === "" ? outcomeLayout(outcome.branch) === layout : outcome.branch === branch),
      )
      .sort((a, b) =>
        a.branch === layout ? -1 : b.branch === layout ? 1 : a.branch.localeCompare(b.branch),
      )[0];
  const same = matching(row.revision);
  const found = same ?? matching(row.revision + 1);
  if (found === undefined) return undefined;
  return {
    outcome: found.outcome,
    cause: found.cause,
    step: found.step,
    revision: same === undefined ? "later" : "same",
  };
}

/** FNV-1a, for case IDs that stay the same across exports. */
function shortHash(text: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, "0");
}

const parseJson = (text: string | null): unknown => (text === null ? undefined : JSON.parse(text));

type Parsed = {
  row: LogRow;
  key: string;
  /** What the case asks, from values a re-export or new replacements do not change. */
  idKey: string;
  flags: CaseRequest | undefined;
  slots: SemanticSlot[];
  unnamed: string[];
  observation: LoginObservation;
  answer: unknown;
  result: unknown;
};

/** One row parsed and scrubbed, or why it is left out. */
function parseRow(row: LogRow, replacements: Replacements): Parsed | { reason: string } {
  if (row.role !== "generate") return { reason: "not a generation row" };
  if (row.recipe_page === "logout") return { reason: "logout request" };
  if (localHosts.has(new URL(row.origin).hostname)) return { reason: "local test server" };
  let request: LoggedRequest;
  let answer: unknown;
  let result: unknown;
  try {
    request = (parseJson(row.request) ?? {}) as LoggedRequest;
    answer = parseJson(row.answer);
    result = parseJson(row.result);
  } catch {
    return { reason: "row does not parse" };
  }
  const observation = v.safeParse(loginObservationSchema, request.observation);
  if (!observation.success) return { reason: "observation no longer parses" };
  // A list of accounts (ADR 0028) and a passkey-only page (ADR 0053) are asked without
  // slots, as is an entry request (ADR 0031); the log may still hold `slots: []`.
  const slotless =
    request.slots === undefined ||
    request.passkeyOnly === true ||
    observation.output.accounts !== undefined ||
    (Array.isArray(request.slots) && request.slots.length === 0);
  const parsedSlots = slotless ? undefined : v.safeParse(semanticSlotsSchema, request.slots);
  if (parsedSlots !== undefined && !parsedSlots.success) return { reason: "slots no longer parse" };
  const { slots, unnamed } = scrubSlots(parsedSlots?.output ?? [], replacements.fieldNames ?? {});
  const page = pageReplacements(
    observation.output,
    new Map(Object.entries(replacements.text ?? {})),
  );
  const replace = textScrubber(page);
  const scrubbed = v.safeParse(loginObservationSchema, scrubPage(observation.output, replace));
  if (!scrubbed.success) return { reason: "scrubbed observation no longer parses" };
  const flags = caseRequest(row, request);
  return {
    row,
    // The same request of the same page, after scrubbing, so one site's accounts with
    // different field names or lengths do not each become a case.
    key: JSON.stringify([row.observation_hash ?? scrubbed.output, row.recipe_page, flags, slots]),
    idKey: JSON.stringify([row.recipe_page, flags, slots.map((slot) => [slot.id, slot.kind])]),
    flags,
    slots,
    unnamed,
    observation: scrubbed.output,
    // The model's answer and the result hold slot names from the page or the bindings.
    answer: answer === undefined ? undefined : scrubValue(answer, "", replace),
    result: result === undefined ? undefined : scrubValue(result, "", replace),
  };
}

/**
 * Turns request-log generation rows into unlabelled cases (ADR 0012). Rows that are not
 * generation requests, rows of the owner's local test servers and rows that no longer
 * parse are left out. Rows asking the same thing of the same observation become one case,
 * kept from the latest row with a model answer (else the latest row), with every row's ID.
 * A case's ID is its observation hash and a hash of what it asks (recipe page, flags, slot
 * IDs and kinds), so a label stays with its case across exports.
 */
export function draftLogCases(
  rows: readonly LogRow[],
  outcomes: readonly OutcomeRow[],
  replacements: Replacements = {},
): { drafts: LogPageDraft[]; skipped: { id: string; reason: string }[] } {
  const skipped: { id: string; reason: string }[] = [];
  const groups = new Map<string, Parsed[]>();
  for (const row of rows) {
    const parsed = parseRow(row, replacements);
    if ("reason" in parsed) {
      skipped.push({ id: row.id, reason: parsed.reason });
      continue;
    }
    groups.set(parsed.key, [...(groups.get(parsed.key) ?? []), parsed]);
  }
  const hashOf = (group: Parsed[]) =>
    group[0]!.row.observation_hash ?? shortHash(JSON.stringify(group[0]!.observation));
  const baseId = (group: Parsed[]) => `log-${hashOf(group)}-${shortHash(group[0]!.idKey)}`;
  const perId = new Map<string, number>();
  for (const group of groups.values())
    perId.set(baseId(group), (perId.get(baseId(group)) ?? 0) + 1);
  const drafts: LogPageDraft[] = [];
  for (const [key, group] of groups) {
    const byTime = [...group].sort((a, b) => b.row.created_at - a.row.created_at);
    const kept = byTime.find((entry) => entry.answer !== undefined) ?? byTime[0]!;
    const { row } = kept;
    const login = loginOf(row, outcomes);
    const id = baseId(group);
    drafts.push({
      // Two cases ask the same of one page only when their slots' names or shapes differ.
      id: perId.get(id) === 1 ? id : `${id}-${shortHash(key)}`,
      source: {
        dataset: "log",
        logIds: group.map((entry) => entry.row.id).sort(),
        observed: new Date(row.created_at).toISOString().slice(0, 10),
        build: row.build,
      },
      ...(kept.flags === undefined ? {} : { request: kept.flags }),
      slots: kept.slots,
      observation: kept.observation,
      logged: {
        outcome: row.outcome,
        promptVersion: row.prompt_version,
        modelId: row.model_id,
        effort: row.effort,
        speed: row.speed,
        source: row.source,
        ...(kept.answer === undefined ? {} : { answer: kept.answer }),
        ...(kept.result === undefined ? {} : { result: kept.result }),
      },
      ...(login === undefined ? {} : { login }),
      privateHints: [
        ...privateHints(row.origin, row.path),
        ...kept.unnamed.map((slot) => `no synthetic name for ${slot}'s vault field`),
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
 * private hints are still open needs its label to say `private` either way; a label whose
 * case no longer exists is reported.
 */
export function assembleLogCorpus(
  drafts: readonly LogPageDraft[],
  labels: Readonly<Record<string, CaseLabel>>,
  built: string,
): {
  public: LogCorpusFile;
  private: LogCorpusFile;
  unlabelled: string[];
  undecided: string[];
  unknownLabels: string[];
} {
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
  const ids = new Set(drafts.map((draft) => draft.id));
  return {
    public: { source, cases: shown },
    private: { source, cases: kept },
    unlabelled,
    undecided,
    unknownLabels: Object.keys(labels).filter((id) => !ids.has(id)),
  };
}
