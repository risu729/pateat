import type { LoginObservation, SemanticSlot } from "@pateat/contracts";
import type { CaseRequest, EvaluationCase, ScoredResult } from "./cases";
import log from "./log.json";

/**
 * Where a request-log case came from (ADR 0012): the rows it merges, the date of the one
 * it keeps, and that row's service build (null on rows from before 2026-10-18).
 */
export type LogCaseSource = {
  dataset: "log";
  logIds: string[];
  observed: string;
  build: string | null;
};

/**
 * What production answered for the kept row, as the log holds it: the row's outcome code,
 * the model's own answer and the result that ran. It is history across prompt versions and
 * models, never a baseline for the current role.
 */
export type LoggedAnswer = {
  outcome: string;
  promptVersion: string | null;
  modelId: string | null;
  effort: string | null;
  speed: string | null;
  source: string | null;
  answer?: unknown;
  result?: unknown;
};

/**
 * How the first reported login of the kept row's recipe revision ended (`login_outcomes`,
 * ADR 0012): of that revision (`same`) or of the revision right after it (`later`).
 */
export type LoggedLogin = {
  outcome: string;
  cause: string | null;
  step: number;
  revision: "same" | "later";
};

/** A request-log page before its truth is labelled. */
export type LogPageDraft = {
  id: string;
  source: LogCaseSource;
  request?: CaseRequest;
  slots: SemanticSlot[];
  observation: LoginObservation;
  logged: LoggedAnswer;
  login?: LoggedLogin;
  /** Reasons the page may reveal more than which site the owner uses, for a reviewer. */
  privateHints: string[];
};

/**
 * Who labelled the truth (owner, 2026-11-03 11:36 UTC): the plan that ran when its login
 * succeeded, two labellers who agreed without seeing the logged answer, or the owner.
 */
export type LabelSource = "login" | "agreed" | "owner";

/** A labelled request-log page. */
export type LogPageCase = Omit<LogPageDraft, "privateHints"> & {
  expected: ScoredResult;
  labelSource: LabelSource;
};

/** A request-log corpus file: the repository's, or the one kept outside it. */
export type LogCorpusFile = { source: { dataset: "log"; built: string }; cases: LogPageCase[] };

/** Request-log cases as the evaluation scores them. */
export const logPageCases = (
  file: LogCorpusFile,
): (EvaluationCase<ScoredResult> & { labelSource: LabelSource })[] =>
  file.cases.map((entry) => ({
    id: entry.id,
    locale: entry.observation.language,
    summary: `${entry.observation.origin}${entry.observation.path}`,
    observation: entry.observation,
    slots: entry.slots,
    expected: entry.expected,
    labelSource: entry.labelSource,
    ...(entry.request === undefined ? {} : { request: entry.request }),
  }));

/**
 * Pages from the owner's request log that reveal no more than which site is used (owner,
 * 2026-11-03 11:35 UTC); the others stay in a file outside the repository.
 */
export const logPageCorpus = logPageCases(log as unknown as LogCorpusFile);
