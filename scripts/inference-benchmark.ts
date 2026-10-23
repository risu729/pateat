// The Claude run is paid: it needs the owner's approval for each run (ADR 0014) and reads
// only ANTHROPIC_API_KEY. The heuristic run is free and local. Both print the report as
// JSON; the report carries no page text.
import { parseArgs } from "node:util";
import {
  runClaudeBenchmark,
  runClaudeJudgeBenchmark,
  runHeuristicBenchmark,
} from "../packages/inference/src/bench";
import { evaluationCorpus } from "../packages/inference/src/corpus/cases";
import { judgeCorpus } from "../packages/inference/src/corpus/judge";
import {
  japanesePageCorpus,
  realPageCorpus,
  webPageCorpus,
} from "../packages/inference/src/corpus/real";
import {
  claudeBenchmarkModels,
  claudeEfforts,
  claudeFastModeRates,
  claudeGeneration,
  type ClaudeBenchmarkModel,
  type ClaudeEffort,
} from "../packages/inference/src/providers/claude";

const corpora = {
  synthetic: evaluationCorpus,
  real: realPageCorpus,
  japanese: japanesePageCorpus,
  web: webPageCorpus,
  // The sign-in judge's pages; Claude only, since the heuristic has no judge.
  judge: judgeCorpus,
};

const { values } = parseArgs({
  options: {
    paid: { type: "boolean", default: false },
    "max-cost-usd": { type: "string", default: "2" },
    corpus: { type: "string", default: "synthetic" },
    provider: { type: "string", default: "claude" },
    from: { type: "string", default: "0" },
    count: { type: "string" },
    model: { type: "string", default: claudeGeneration.modelId },
    effort: { type: "string", default: claudeGeneration.effort },
    speed: { type: "string", default: "standard" },
  },
});
if (!Object.hasOwn(corpora, values.corpus)) {
  console.error(`Choose a corpus: ${Object.keys(corpora).join(", ")}.`);
  process.exit(2);
}
const corpus = corpora[values.corpus as keyof typeof corpora];
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
if (values.provider !== "claude") {
  console.error("Choose a provider: claude, heuristic.");
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

if (!Object.hasOwn(claudeBenchmarkModels, values.model)) {
  console.error(`Choose a model: ${Object.keys(claudeBenchmarkModels).join(", ")}.`);
  process.exit(2);
}
if (!(claudeEfforts as readonly string[]).includes(values.effort)) {
  console.error(`Choose an effort: ${claudeEfforts.join(", ")}.`);
  process.exit(2);
}

const fastRates = Object.hasOwn(claudeFastModeRates, values.model)
  ? claudeFastModeRates[values.model as keyof typeof claudeFastModeRates]
  : undefined;
if (values.speed !== "standard" && (values.speed !== "fast" || fastRates === undefined)) {
  console.error(`Fast mode runs only on ${Object.keys(claudeFastModeRates).join(", ")}.`);
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
          rates: claudeBenchmarkModels[values.model as ClaudeBenchmarkModel],
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
