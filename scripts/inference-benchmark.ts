// The Claude run is paid: it needs the owner's approval for each run (ADR 0014) and reads
// only ANTHROPIC_API_KEY. The Clef run is paid too, on Workers AI, and reads only
// CLOUDFLARE_API_TOKEN and CLOUDFLARE_ACCOUNT_ID. The heuristic run is free and local. All
// print the report as JSON; the report carries no page text.
import { readFileSync } from "node:fs";
import { parseArgs } from "node:util";
import {
  runClaudeBenchmark,
  runClaudeJudgeBenchmark,
  runHeuristicBenchmark,
} from "../packages/inference/src/bench";
import { runClefBenchmark } from "../packages/inference/src/bench-clef";
import { evaluationCorpus } from "../packages/inference/src/corpus/cases";
import { judgeCorpus } from "../packages/inference/src/corpus/judge";
import {
  logPageCases,
  logPageCorpus,
  type LogCorpusFile,
} from "../packages/inference/src/corpus/log";
import {
  japanesePageCorpus,
  realPageCorpus,
  webPageCorpus,
} from "../packages/inference/src/corpus/real";
import {
  claudeEfforts,
  claudeGeneration,
  claudeModelRates,
  type ClaudeEffort,
} from "../packages/inference/src/providers/claude";
import { clefModels, isClefModel } from "../packages/inference/src/providers/clef";

const corpora = {
  synthetic: evaluationCorpus,
  real: realPageCorpus,
  japanese: japanesePageCorpus,
  web: webPageCorpus,
  // The owner's request-log pages (ADR 0012); `--corpus-file` adds those kept outside
  // the repository.
  log: logPageCorpus,
  // The sign-in judge's pages; Claude only, since the heuristic has no judge.
  judge: judgeCorpus,
};

const { values } = parseArgs({
  options: {
    paid: { type: "boolean", default: false },
    "max-cost-usd": { type: "string", default: "2" },
    corpus: { type: "string", default: "synthetic" },
    "corpus-file": { type: "string" },
    provider: { type: "string", default: "claude" },
    from: { type: "string", default: "0" },
    count: { type: "string" },
    model: { type: "string", default: claudeGeneration.modelId },
    effort: { type: "string", default: claudeGeneration.effort },
    speed: { type: "string", default: "standard" },
    // Clef only: the role's threshold, and whether to reverse each question's options.
    "min-probability": { type: "string", default: "0.5" },
    "reverse-options": { type: "boolean", default: false },
  },
});
if (!Object.hasOwn(corpora, values.corpus)) {
  console.error(`Choose a corpus: ${Object.keys(corpora).join(", ")}.`);
  process.exit(2);
}
if (values["corpus-file"] !== undefined && values.corpus !== "log") {
  console.error("--corpus-file adds request-log pages; use it with --corpus log.");
  process.exit(2);
}
const corpus =
  values["corpus-file"] === undefined
    ? corpora[values.corpus as keyof typeof corpora]
    : [
        ...logPageCorpus,
        ...logPageCases(JSON.parse(readFileSync(values["corpus-file"], "utf8")) as LogCorpusFile),
      ];
const from = Number(values.from);
const count = values.count === undefined ? undefined : Number(values.count);
if (
  !Number.isSafeInteger(from) ||
  from < 0 ||
  from >= corpus.length ||
  (count !== undefined && (!Number.isSafeInteger(count) || count <= 0))
) {
  console.error(
    `Use an integer --from from 0 to ${corpus.length - 1} and a positive integer --count.`,
  );
  process.exit(2);
}
// A batch is a slice of the corpus in its fixed order, so batches can be run in turn.
const cases = corpus.slice(from, count === undefined ? undefined : from + count);

if (values.provider === "heuristic") {
  if (values.corpus === "judge") {
    console.error("The heuristic has no judge; run the judge corpus with Claude.");
    process.exit(2);
  }
  console.log(
    JSON.stringify(await runHeuristicBenchmark(cases as typeof evaluationCorpus), null, 2),
  );
  process.exit(0);
}
if (values.provider === "clef") {
  if (values.corpus === "judge") {
    console.error("Clef has no judge; run the judge corpus with Claude.");
    process.exit(2);
  }
  if (!values.paid) {
    console.error("This run calls paid Workers AI. Pass --paid once the owner has approved it.");
    process.exit(2);
  }
  const modelId = values.model === claudeGeneration.modelId ? "clef-flash" : values.model;
  if (!isClefModel(modelId)) {
    console.error(`Choose a Clef model: ${Object.keys(clefModels).join(", ")}.`);
    process.exit(2);
  }
  const apiToken = process.env.CLOUDFLARE_API_TOKEN;
  const accountId = process.env.CLOUDFLARE_ACCOUNT_ID;
  if (apiToken === undefined || apiToken.trim() === "" || accountId === undefined) {
    console.error("Set CLOUDFLARE_API_TOKEN and CLOUDFLARE_ACCOUNT_ID in the environment.");
    process.exit(2);
  }
  const result = await runClefBenchmark({
    accountId,
    apiToken,
    modelId,
    maxCostUsd: Number(values["max-cost-usd"]),
    cases: cases as typeof evaluationCorpus,
    minProbability: Number(values["min-probability"]),
    reverseOptions: values["reverse-options"],
  });
  console.log(JSON.stringify(result, null, 2));
  if (result.report.stoppedBefore !== undefined) {
    console.error(`Stopped at the cost cap before ${result.report.stoppedBefore}.`);
    process.exit(1);
  }
  process.exit(0);
}
if (values.provider !== "claude") {
  console.error("Choose a provider: claude, clef, heuristic.");
  process.exit(2);
}
if (!values.paid) {
  console.error("This run calls the paid Claude API. Pass --paid once the owner has approved it.");
  process.exit(2);
}
const apiKey = process.env.ANTHROPIC_API_KEY;
if (apiKey === undefined || apiKey.trim() === "") {
  console.error("Set ANTHROPIC_API_KEY in the environment.");
  process.exit(2);
}

// Only a model the pricing page lists, so the cost cap can hold.
const rates = claudeModelRates(values.model);
if (rates === undefined) {
  console.error(
    `The pricing page lists no price for ${values.model}; choose a model in claude-pricing.json.`,
  );
  process.exit(2);
}
if (!(claudeEfforts as readonly string[]).includes(values.effort)) {
  console.error(`Choose an effort: ${claudeEfforts.join(", ")}.`);
  process.exit(2);
}

const fastRates = claudeModelRates(values.model, "fast");
if (values.speed !== "standard" && (values.speed !== "fast" || fastRates === undefined)) {
  console.error(`The pricing page lists no fast mode price for ${values.model}.`);
  process.exit(2);
}
const run = {
  apiKey,
  maxCostUsd: Number(values["max-cost-usd"]),
  choice:
    values.speed === "fast"
      ? {
          modelId: values.model,
          effort: values.effort as ClaudeEffort,
          rates: fastRates!,
          speed: "fast" as const,
        }
      : {
          modelId: values.model,
          effort: values.effort as ClaudeEffort,
          rates,
        },
};
const result =
  values.corpus === "judge"
    ? await runClaudeJudgeBenchmark({ ...run, cases: cases as typeof judgeCorpus })
    : await runClaudeBenchmark({ ...run, cases: cases as typeof evaluationCorpus });
console.log(JSON.stringify(result, null, 2));
if (result.report.stoppedBefore !== undefined) {
  console.error(`Stopped at the cost cap before ${result.report.stoppedBefore}.`);
  process.exit(1);
}
