// Observes public login pages live for the Japanese and English corpora (ADR 0012): one
// empty browser context per page (no profile, cookies or account), locale ja-JP, nothing
// typed or clicked. `--refresh` observes every page of the Japanese corpus, or of the one
// `--corpus` names, again and moves its label to the new observation; listed URLs are
// observed into a local report, labelled by hand.
/* oxlint-disable no-await-in-loop -- one browser observes the pages one at a time */
import { execFileSync } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import type { LoginObservation } from "@pateat/contracts";
import { chromium, type Browser, type Page } from "@playwright/test";
import { carryLabel } from "../../packages/inference/src/corpus/carry";
import type { JapanesePageCase } from "../../packages/inference/src/corpus/real";
import type { ProbeResult } from "../formasaurus/probe";

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    refresh: { type: "boolean", default: false },
    report: { type: "string" },
    corpus: { type: "string" },
    chromium: { type: "string" },
    headed: { type: "boolean", default: false },
  },
});
if (!values.refresh && positionals.length === 0) {
  console.error(
    "Usage: observe.ts [--chromium <path>] [--headed] (--refresh | --report <file> <url>...)",
  );
  process.exit(2);
}
if (positionals.length > 0 !== (values.report !== undefined)) {
  console.error("Name a --report file together with the pages to list; it stays local.");
  process.exit(2);
}

const root = fileURLToPath(new URL("../../", import.meta.url));
const git = (...args: string[]) =>
  execFileSync("git", ["-C", root, ...args], { encoding: "utf8" }).trim();
// A recorded commit must be the code that observed the page and moved its label.
const observing = [
  "apps/extension/src",
  "packages/contracts/src",
  "packages/inference/src/corpus/carry.ts",
  "scripts/formasaurus/probe.ts",
  "scripts/japanese",
];
if (git("status", "--porcelain", "--", ...observing)) {
  console.error("Commit the extractor and probe changes first; each case records the commit.");
  process.exit(2);
}
const commit = git("rev-parse", "--short=7", "HEAD");
// The local date, as the person who ran it would write it.
const observed = new Date().toLocaleDateString("sv-SE");

const bundle = await Bun.build({
  entrypoints: [fileURLToPath(new URL("../formasaurus/probe.ts", import.meta.url))],
  target: "browser",
  format: "iife",
});
if (!bundle.success) throw new AggregateError(bundle.logs, "Probe bundle failed");
const probeSource = await bundle.outputs[0]!.text();

type FrameProbe = { frame: string; probe: ProbeResult };
type PageReport =
  | { url: string; ok: false; status?: number; error: string }
  | { url: string; ok: true; status?: number; final: string; frames: FrameProbe[] };

/**
 * Loads one page in its own empty context and probes the main frame and every frame that
 * describes a login page, as the extension observes each frame (ADR 0017).
 */
async function observe(browser: Browser, url: string): Promise<PageReport> {
  const context = await browser.newContext({
    locale: "ja-JP",
    timezoneId: "Asia/Tokyo",
    viewport: { width: 1280, height: 800 },
  });
  try {
    const page = await context.newPage();
    let status: number | undefined;
    try {
      const response = await page.goto(url, { waitUntil: "load", timeout: 45_000 });
      status = response?.status();
      // Pages that render their form from script settle after the load event.
      await page.waitForLoadState("networkidle", { timeout: 15_000 }).catch(() => {});
      await page.waitForTimeout(2_000);
    } catch (error) {
      return { url, ok: false, ...(status ? { status } : {}), error: firstLine(error) };
    }
    const frames: FrameProbe[] = [];
    for (const frame of page.frames()) {
      let probe: ProbeResult;
      try {
        probe =
          frame === page.mainFrame()
            ? await probeMainFrame(page)
            : ((await frame.evaluate(`${probeSource}\n;pateatProbe()`)) as ProbeResult);
      } catch (error) {
        probe = { ok: false, reason: firstLine(error) };
      }
      if (frame === page.mainFrame() || probe.ok) frames.push({ frame: frame.url(), probe });
    }
    return { url, ok: true, ...(status ? { status } : {}), final: page.url(), frames };
  } finally {
    await context.close();
  }
}

/**
 * Probes the main frame in a world of its own, as the extension's content script runs:
 * the page's own scripts may replace built-ins such as `URL.parse` or `eval`.
 */
async function probeMainFrame(page: Page): Promise<ProbeResult> {
  const session = await page.context().newCDPSession(page);
  try {
    const { frameTree } = await session.send("Page.getFrameTree");
    const { executionContextId } = await session.send("Page.createIsolatedWorld", {
      frameId: frameTree.frame.id,
      worldName: "pateat-probe",
    });
    const { result, exceptionDetails } = await session.send("Runtime.evaluate", {
      expression: `${probeSource}\n;pateatProbe()`,
      contextId: executionContextId,
      returnByValue: true,
    });
    if (exceptionDetails) {
      throw new Error(exceptionDetails.exception?.description ?? exceptionDetails.text);
    }
    return result.value as ProbeResult;
  } finally {
    await session.detach();
  }
}

/** A frame's origin and path, without the query that may carry a session. */
const pageOf = (url: string) => {
  try {
    const { origin, pathname } = new URL(url);
    return `${origin}${pathname}`;
  } catch {
    return url;
  }
};

const firstLine = (error: unknown) =>
  (error instanceof Error ? error.message : String(error)).split("\n")[0]!;

const browser = await chromium.launch({
  headless: !values.headed,
  ...(values.chromium ? { executablePath: values.chromium } : {}),
  args: ["--lang=ja-JP"],
});
try {
  if (values.refresh) await refresh(browser);
  if (positionals.length > 0) {
    const reports = [];
    for (const url of positionals) reports.push(await observe(browser, url));
    await writeFile(values.report!, `${JSON.stringify({ observed, commit, reports }, null, 2)}\n`);
    console.log(
      JSON.stringify(
        reports.map((report) => ({
          url: report.url,
          ...(report.status ? { status: report.status } : {}),
          ...(report.ok
            ? {
                frames: report.frames.map(({ frame, probe }) => ({
                  frame: pageOf(frame),
                  ...(probe.ok
                    ? {
                        complete: (probe.observation as LoginObservation).complete,
                        ...(probe.gap ? { gap: probe.gap } : {}),
                      }
                    : { refused: probe.reason }),
                })),
              }
            : { error: report.error }),
        })),
        null,
        2,
      ),
    );
  }
} finally {
  await browser.close();
}

/**
 * Observes every corpus page again. A case whose label moves whole to the new observation
 * takes it, with today's date and this commit; any other keeps its old observation and is
 * reported for a person to relabel. It exits normally either way, so the task still
 * formats the corpus after a partial refresh.
 */
async function refresh(on: Browser) {
  const file = values.corpus ?? `${root}packages/inference/src/corpus/japanese.json`;
  const corpus = JSON.parse(await readFile(file, "utf8")) as {
    source: unknown;
    cases: JapanesePageCase[];
  };
  const results: Record<string, string> = {};
  for (const [index, entry] of corpus.cases.entries()) {
    const report = await observe(on, entry.source.url);
    if (!report.ok) {
      results[entry.id] = `load failed: ${report.error}`;
      continue;
    }
    const probe = report.frames.find(({ probe: result }) => {
      if (!result.ok) return false;
      const observation = result.observation as LoginObservation;
      return `${observation.origin}${observation.path}` === entry.source.url;
    })?.probe;
    if (!probe?.ok) {
      const main = report.frames[0]?.probe;
      results[entry.id] =
        `not observed at ${entry.source.url}: ${main?.ok ? "another page" : (main?.reason ?? "no frame")}`;
      continue;
    }
    const observation = probe.observation as LoginObservation;
    const carried = carryLabel(entry.observation, entry.expected, observation);
    if (!carried.ok) {
      results[entry.id] =
        `${carried.reason}${carried.candidate ? ` ${carried.candidate}` : ""}${probe.gap ? ` (${probe.gap})` : ""}`;
      continue;
    }
    corpus.cases[index] = {
      ...entry,
      source: { ...entry.source, observed, commit },
      observation,
      expected: carried.expected,
    };
    results[entry.id] = "refreshed";
  }
  if (Object.values(results).includes("refreshed"))
    await writeFile(file, `${JSON.stringify(corpus, null, 2)}\n`);
  console.log(JSON.stringify(results, null, 2));
}
