import { appendFileSync, existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import libCoverage from "istanbul-lib-coverage";

// Merges every Vitest run's coverage-final.json under coverage/ (written when
// PATEAT_COVERAGE is set) and prints one row per project. A file measured by several runs,
// such as extension code reached by both the unit and Browser Mode suites, counts once
// with the union of its hits.
const root = process.cwd();
const directory = path.join(root, "coverage");
const reports = existsSync(directory)
  ? readdirSync(directory)
      .map((name) => path.join(directory, name, "coverage-final.json"))
      .filter((file) => existsSync(file))
  : [];
if (!reports.length) {
  console.error("No coverage-final.json under coverage/; run the tests with PATEAT_COVERAGE=1.");
  process.exit(1);
}

const map = libCoverage.createCoverageMap({});
for (const file of reports) map.merge(JSON.parse(readFileSync(file, "utf8")));

const projects = [
  "apps/extension/src",
  "packages/bitwarden/src",
  "packages/contracts/src",
  "packages/inference/src",
  "services/api/src",
  "services/api/web",
  // Reached only when a config measures a folder not listed above; add it to the list.
  "Other",
];
const summaries = new Map(
  projects.map((project) => [project, libCoverage.createCoverageSummary()]),
);
const overall = libCoverage.createCoverageSummary();
for (const file of map.files()) {
  const relative = path.relative(root, file).split(path.sep).join("/");
  const project = projects.find((prefix) => relative.startsWith(`${prefix}/`)) ?? projects.at(-1);
  const summary = map.fileCoverageFor(file).toSummary();
  summaries.get(project).merge(summary);
  overall.merge(summary);
}

const metrics = ["Lines", "Branches", "Functions", "Statements"];
const cell = ({ covered, total }) =>
  total ? `${((100 * covered) / total).toFixed(1)}% (${covered}/${total})` : "-";
const rows = [
  `| Project | ${metrics.join(" | ")} |`,
  `| --- |${" --- |".repeat(metrics.length)}`,
  ...[...summaries, ["Total", overall]]
    .filter(([project, summary]) => project !== "Other" || summary.lines.total)
    .map(
      ([project, summary]) =>
        `| ${project} | ${metrics.map((m) => cell(summary[m.toLowerCase()])).join(" | ")} |`,
    ),
];
const markdown = [
  "## Coverage",
  "",
  ...rows,
  "",
  `Merged from ${reports.length} Vitest runs. The packaged-extension Playwright tests (tests/extension) are not measured.`,
  "",
].join("\n");

console.log(markdown);
if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, markdown);
