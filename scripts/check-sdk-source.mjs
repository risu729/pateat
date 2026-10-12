// Fails when the Corresponding Source records name a Bitwarden SDK other than the locked one.
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "..");
const records = [
  "docs/sdk-source.md",
  "apps/extension/public/THIRD-PARTY-NOTICES.md",
  "apps/extension/public/legal.html",
];
// Upstream revision of the public synthetic vectors, attributed separately in the notices.
const fixtureRevision = "7de8f13a14b56068167160f88d55231f916cf16a";
const read = (file) => readFileSync(path.join(root, file), "utf8");

const locked = /"@bitwarden\/sdk-internal": \["@bitwarden\/sdk-internal@([^"]+)"/.exec(
  read("bun.lock"),
)?.[1];
if (!locked) throw new Error("bun.lock has no @bitwarden/sdk-internal package entry");
// The packaged VERSION file names the upstream source commit; bun.lock does not record it.
const installed = path.dirname(
  createRequire(path.join(root, "packages/bitwarden/package.json")).resolve(
    "@bitwarden/sdk-internal/package.json",
  ),
);
const { version } = JSON.parse(readFileSync(path.join(installed, "package.json"), "utf8"));
if (version !== locked) {
  throw new Error(`Installed SDK ${version} differs from bun.lock ${locked}; run mise run install`);
}
const revision = readFileSync(path.join(installed, "VERSION"), "utf8").trim();
if (!/^[0-9a-f]{40}$/.test(revision)) throw new Error(`Unexpected SDK VERSION: ${revision}`);

const failures = new Set();
for (const file of records) {
  const source = read(file);
  if (!source.includes(locked)) failures.add(`${file}: does not name ${locked}`);
  if (!source.includes(revision)) failures.add(`${file}: does not name ${revision}`);
  for (const [stale] of source.matchAll(/\b\d+\.\d+\.\d+-main\.\d+\b/g)) {
    if (stale !== locked) failures.add(`${file}: names SDK ${stale}, locked is ${locked}`);
  }
  for (const [named] of source.matchAll(/\b[0-9a-f]{40}\b/gi)) {
    if (named !== revision && named !== fixtureRevision) {
      failures.add(`${file}: names revision ${named}, SDK source is ${revision}`);
    }
  }
}
if (failures.size) {
  console.error([...failures].join("\n"));
  process.exitCode = 1;
} else {
  console.log(`SDK source records match ${locked} (${revision}).`);
}
