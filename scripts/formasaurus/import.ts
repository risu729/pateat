// Derives real-page evaluation cases from a local Formasaurus checkout (ADR 0012): each
// annotated page is rendered offline in Chromium, observed by the extension's own
// extractor and labeled from the Formasaurus field annotations. Only the derived
// observations and labels are written; no page HTML leaves the checkout.
/* oxlint-disable no-await-in-loop -- one browser renders the pages one at a time */
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { chromium } from "@playwright/test";
import { label, type Annotation, type Skip } from "./label";
import type { ProbeResult } from "./probe";

const { values } = parseArgs({
  options: {
    source: { type: "string" },
    chromium: { type: "string" },
    probes: { type: "string" },
  },
});
if (!values.source) {
  console.error(
    "Usage: import.ts --source <Formasaurus checkout> [--chromium <path>] [--probes <cache.json>]",
  );
  process.exit(2);
}
const output = new URL("../../packages/inference/src/corpus/formasaurus.json", import.meta.url);

const data = join(values.source, "formasaurus", "data");
const index = JSON.parse(await readFile(join(data, "index.json"), "utf8")) as Record<
  string,
  Annotation
>;
const commit = execFileSync("git", ["-C", values.source, "rev-parse", "HEAD"], {
  encoding: "utf8",
}).trim();

type Probed = { file: string; probe: ProbeResult };

/** Most saved pages are UTF-8; others keep their own encoding, which Chromium detects. */
function contentType(html: Uint8Array): string {
  try {
    new TextDecoder("utf-8", { fatal: true }).decode(html);
    return "text/html; charset=utf-8";
  } catch {
    return "text/html";
  }
}

async function probeAll(): Promise<Probed[]> {
  const bundle = await Bun.build({
    entrypoints: [new URL("./probe.ts", import.meta.url).pathname],
    target: "browser",
    format: "iife",
  });
  if (!bundle.success) throw new AggregateError(bundle.logs, "Probe bundle failed");
  const probeSource = await bundle.outputs[0]!.text();
  const browser = await chromium.launch(values.chromium ? { executablePath: values.chromium } : {});
  const results: Probed[] = [];
  for (const [file, annotation] of Object.entries(index)) {
    const html = await readFile(join(data, file));
    // Scripts stay off and nothing but the saved document loads, so no request reaches
    // the original site.
    const context = await browser.newContext({
      javaScriptEnabled: false,
      viewport: { width: 1280, height: 800 },
    });
    const page = await context.newPage();
    let served = false;
    await page.route("**/*", (route) => {
      if (!served && route.request().isNavigationRequest()) {
        served = true;
        return route.fulfill({ status: 200, contentType: contentType(html), body: html });
      }
      return route.abort();
    });
    let probe: ProbeResult;
    try {
      await page.goto(annotation.url, { waitUntil: "domcontentloaded", timeout: 20_000 });
      probe = (await page.evaluate(`${probeSource}\n;pateatProbe()`)) as ProbeResult;
    } catch {
      probe = { ok: false, reason: "load-failed" };
    }
    results.push({ file, probe });
    await context.close();
  }
  await browser.close();
  return results;
}

// The cache is for relabeling only; it is reused for the same checkout commit alone.
const cached =
  values.probes && existsSync(values.probes)
    ? (JSON.parse(await readFile(values.probes, "utf8")) as { commit: string; probed: Probed[] })
    : undefined;
if (cached && cached.commit !== commit) {
  console.error(`${values.probes} was probed at another Formasaurus commit; delete it.`);
  process.exit(2);
}
const probed = cached?.probed ?? (await probeAll());
if (values.probes && !cached) await writeFile(values.probes, JSON.stringify({ commit, probed }));

const cases = [];
const skipped: Partial<Record<Skip, number>> = {};
for (const { file, probe } of probed) {
  const result = label(file, index[file]!, probe);
  if (result.ok) cases.push(result.testCase);
  else skipped[result.skip] = (skipped[result.skip] ?? 0) + 1;
}
const corpus = {
  source: {
    repository: "https://github.com/scrapinghub/Formasaurus",
    commit,
    // The MIT license covers the annotations; the derived page text is the sites' own.
    annotationsLicense: "MIT",
  },
  cases,
};
await writeFile(output, `${JSON.stringify(corpus, null, 2)}\n`);
console.log(
  JSON.stringify(
    {
      pages: probed.length,
      cases: cases.length,
      plans: cases.filter((entry) => entry.expected.kind === "plan").length,
      abstentions: cases.filter((entry) => entry.expected.kind === "abstain").length,
      skipped,
    },
    null,
    2,
  ),
);
