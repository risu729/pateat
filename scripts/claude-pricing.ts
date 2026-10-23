// Refreshes the committed Claude rates from the public pricing page (ADR 0014). The
// scheduled pricing workflow runs it and proposes any change as a pull request.
import { writeFile } from "node:fs/promises";
import {
  claudePricingSource,
  parseClaudePricing,
} from "../packages/inference/src/providers/claude-pricing";

const target = new URL("../packages/inference/src/providers/claude-pricing.json", import.meta.url);
const response = await fetch(claudePricingSource, { redirect: "error" });
if (!response.ok) {
  console.error(`The pricing page answered ${response.status}.`);
  process.exit(1);
}
const pricing = parseClaudePricing(await response.text());
await writeFile(target, `${JSON.stringify(pricing, null, 2)}\n`);
console.log(`Wrote the rates of ${Object.keys(pricing.models).length} models.`);
