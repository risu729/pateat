// Builds the request-log corpus (ADR 0012) from rows a read-only SELECT of the production
// database returned. It reads and writes local files only and calls nothing. Keep the
// rows, the drafts, the replacements and the labels outside the repository: only the
// assembled public corpus, src/corpus/log.json, is committed.
import { readFileSync, writeFileSync } from "node:fs";
import { parseArgs } from "node:util";
import {
  assembleLogCorpus,
  draftLogCases,
  type CaseLabel,
  type LogRow,
  type OutcomeRow,
  type Replacements,
} from "../packages/inference/src/corpus/log-convert";
import type { LogPageDraft } from "../packages/inference/src/corpus/log";

const publicCorpus = new URL("../packages/inference/src/corpus/log.json", import.meta.url);

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    rows: { type: "string" },
    outcomes: { type: "string" },
    replacements: { type: "string" },
    drafts: { type: "string" },
    labels: { type: "string" },
    private: { type: "string" },
  },
});
const read = <T>(path: string): T => JSON.parse(readFileSync(path, "utf8")) as T;
const write = (path: string | URL, data: unknown) =>
  writeFileSync(path, `${JSON.stringify(data, null, 2)}\n`);
const need = (name: keyof typeof values) => {
  const value = values[name];
  if (typeof value !== "string" || value === "") {
    console.error(`Pass --${name}.`);
    process.exit(2);
  }
  return value;
};

const command = positionals[0];
if (command === "draft") {
  const { drafts, skipped } = draftLogCases(
    read<LogRow[]>(need("rows")),
    read<OutcomeRow[]>(need("outcomes")),
    values.replacements === undefined ? {} : read<Replacements>(values.replacements),
  );
  write(need("drafts"), drafts);
  const hinted = drafts.filter((draft) => draft.privateHints.length > 0);
  console.log(
    JSON.stringify(
      { drafts: drafts.length, withPrivateHints: hinted.map((draft) => draft.id), skipped },
      null,
      2,
    ),
  );
} else if (command === "assemble") {
  const built = new Date().toISOString().slice(0, 10);
  const assembled = assembleLogCorpus(
    read<LogPageDraft[]>(need("drafts")),
    read<Record<string, CaseLabel>>(need("labels")),
    built,
  );
  write(publicCorpus, assembled.public);
  write(need("private"), assembled.private);
  console.log(
    JSON.stringify(
      {
        public: assembled.public.cases.length,
        private: assembled.private.cases.length,
        unlabelled: assembled.unlabelled,
        undecided: assembled.undecided,
      },
      null,
      2,
    ),
  );
  if (assembled.unlabelled.length > 0 || assembled.undecided.length > 0) process.exitCode = 1;
} else {
  console.error("Choose a command: draft, assemble.");
  process.exit(2);
}
