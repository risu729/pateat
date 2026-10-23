// Reads Claude's public pricing page (Markdown) into the rates the service and the benchmark
// charge (ADR 0014). The page is written for people, so the reader is strict: any table it
// cannot read whole stops the refresh, rather than writing partial or guessed rates.

export const claudePricingSource = "https://platform.claude.com/docs/en/about-claude/pricing.md";

/** USD per million tokens; output includes thinking. */
export type ClaudeTokenRates = { input: number; output: number };

/** A model's published rates, by its display name (the Models API `display_name`). */
export type ClaudeModelPricing = ClaudeTokenRates & {
  /** Higher rates for a request whose prompt exceeds `overInputTokens` (Haiku 5.5). */
  longPrompt?: ClaudeTokenRates & { overInputTokens: number };
  /** Fast mode's rates, on the models that offer it. */
  fast?: ClaudeTokenRates;
};

export type ClaudePricing = { source: string; models: Record<string, ClaudeModelPricing> };

type Table = { header: string[]; rows: string[][] };

const cells = (line: string) =>
  line
    .trim()
    .replace(/^\||\|$/g, "")
    .split("|")
    .map((cell) => cell.trim());

// The first table after the heading line `heading`, within that heading's section.
function tableAfter(markdown: string, heading: string): Table {
  const lines = markdown.split("\n");
  const start = lines.findIndex((line) => line.trim() === heading);
  if (start === -1) throw new Error(`The pricing page has no "${heading}" section.`);
  const level = heading.match(/^#+/)![0].length;
  const table: string[] = [];
  for (const line of lines.slice(start + 1)) {
    const depth = line.match(/^(#+)\s/)?.[1]?.length;
    if (depth !== undefined && depth <= level) break;
    if (line.trim().startsWith("|")) table.push(line);
    else if (table.length > 0) break;
  }
  const [header, rule, ...rows] = table;
  if (header === undefined || rule === undefined || !/^[\s|:-]+$/.test(rule) || rows.length === 0)
    throw new Error(`The "${heading}" section has no table.`);
  const width = cells(header).length;
  const parsed = rows.map(cells);
  if (parsed.some((row) => row.length !== width))
    throw new Error(`A row of the "${heading}" table has the wrong number of cells.`);
  return { header: cells(header), rows: parsed };
}

function column(table: Table, name: string, heading: string) {
  const index = table.header.indexOf(name);
  if (index === -1) throw new Error(`The "${heading}" table has no "${name}" column.`);
  return index;
}

// `$4 / MTok`, `$0.20 / MTok<sup>2</sup>`, `$8 USD / MTok`. Footnotes are dropped: they
// qualify cache prices or record a price change already shown in the cell.
function price(cell: string): number {
  const text = cell.replace(/<sup>.*?<\/sup>/g, "").trim();
  const match = /^\$(\d+(?:\.\d+)?)(?: USD)? \/ MTok$/.exec(text);
  if (match === null) throw new Error(`Cannot read the price "${cell}".`);
  return Number(match[1]);
}

const longPromptPattern = /^(.+?) \(for prompts (up to|over) ([\d,]+) tokens\)$/;

/** Reads the model and fast mode tables of the pricing page; throws on anything unexpected. */
export function parseClaudePricing(markdown: string): ClaudePricing {
  const heading = "## Model pricing";
  const table = tableAfter(markdown, heading);
  const name = column(table, "Model", heading);
  const input = column(table, "Base input tokens", heading);
  const output = column(table, "Output tokens", heading);
  const models: Record<string, ClaudeModelPricing> = {};
  const longPrompts = new Map<string, ClaudeTokenRates & { overInputTokens: number }>();
  for (const row of table.rows) {
    const rates = { input: price(row[input]!), output: price(row[output]!) };
    // `Claude Opus 4.1 ([retired, ...](...))`: the Claude API no longer serves it.
    // `Claude Mythos 5.1 ([limited availability](...))`: listed; the Models API decides.
    const status = /^(.+?) \(\[([^\]]+)\]\([^)]*\)\)$/.exec(row[name]!);
    if (status?.[2]?.startsWith("retired")) continue;
    if (status !== null && status[2] !== "limited availability")
      throw new Error(`Unknown model status "${row[name]}".`);
    const label = status?.[1] ?? row[name]!;
    const tier = longPromptPattern.exec(label);
    const model = tier?.[1] ?? label;
    if (!/^Claude [A-Z][a-z]+ \d+(?:\.\d+)?$/.test(model))
      throw new Error(`Cannot read the model name "${row[name]}".`);
    if (tier?.[2] === "over") {
      longPrompts.set(model, { ...rates, overInputTokens: Number(tier[3]!.replaceAll(",", "")) });
      continue;
    }
    if (Object.hasOwn(models, model)) throw new Error(`"${model}" is listed twice.`);
    models[model] = rates;
  }
  for (const [model, rates] of longPrompts) {
    if (!Object.hasOwn(models, model)) throw new Error(`"${model}" has only long-prompt prices.`);
    models[model]!.longPrompt = rates;
  }

  const fastHeading = "### Fast mode pricing";
  const fast = tableAfter(markdown, fastHeading);
  const fastName = column(fast, "Model", fastHeading);
  const fastInput = column(fast, "Input", fastHeading);
  const fastOutput = column(fast, "Output", fastHeading);
  for (const row of fast.rows) {
    const rates = { input: price(row[fastInput]!), output: price(row[fastOutput]!) };
    // `Claude Opus 5 / Claude Opus 4.8` shares one price.
    for (const model of row[fastName]!.split(" / ")) {
      if (!Object.hasOwn(models, model))
        throw new Error(`Fast mode lists "${model}", which has no model price.`);
      models[model]!.fast = rates;
    }
  }
  if (Object.keys(models).length === 0) throw new Error("The pricing page lists no model.");
  return { source: claudePricingSource, models };
}

/**
 * The display name a model ID's pricing row uses: `claude-opus-5-5` → `Claude Opus 5.5`,
 * `claude-haiku-4-5-20251001` → `Claude Haiku 4.5`. Undefined for any other shape of ID.
 */
export function claudePricingName(modelId: string): string | undefined {
  const match = /^claude-([a-z]+)-(\d+)(?:-(\d))?(?:-\d{8})?$/.exec(modelId);
  if (match === null) return undefined;
  const [, family, major, minor] = match;
  return `Claude ${family![0]!.toUpperCase()}${family!.slice(1)} ${major}${minor === undefined ? "" : `.${minor}`}`;
}
