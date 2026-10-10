// Paid run: needs the owner's approval for each run (ADR 0014). Reads only
// ANTHROPIC_API_KEY and prints the report as JSON; the report carries no page text.
import { parseArgs } from "node:util";
import { runClaudeBenchmark } from "../packages/inference/src/bench";

const { values } = parseArgs({
  options: {
    paid: { type: "boolean", default: false },
    "max-cost-usd": { type: "string", default: "2" },
  },
});
if (!values.paid) {
  console.error("This run calls the paid Claude API. Pass --paid once the owner has approved it.");
  process.exit(2);
}
const apiKey = process.env.ANTHROPIC_API_KEY;
if (apiKey === undefined || apiKey.trim() === "") {
  console.error("Set ANTHROPIC_API_KEY in the environment.");
  process.exit(2);
}

const result = await runClaudeBenchmark({ apiKey, maxCostUsd: Number(values["max-cost-usd"]) });
console.log(JSON.stringify(result, null, 2));
if (result.report.stoppedBefore !== undefined) {
  console.error(`Stopped at the cost cap before ${result.report.stoppedBefore}.`);
  process.exit(1);
}
