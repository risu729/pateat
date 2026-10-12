// Fails when the Corresponding Source records name a Bitwarden SDK other than the locked one.
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";

const root = process.cwd();
const records = [
  "docs/sdk-source.md",
  "apps/extension/public/THIRD-PARTY-NOTICES.md",
  "apps/extension/public/legal.html",
];
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
  const links = /github\.com\/bitwarden\/sdk-internal\/(?:tree|blob|archive)\/([0-9a-f]{40})/g;
  for (const [, linked] of source.matchAll(links)) {
    if (linked !== revision) failures.add(`${file}: links SDK source ${linked}, not ${revision}`);
  }
}
if (failures.size) {
  console.error([...failures].join("\n"));
  process.exitCode = 1;
} else {
  console.log(`SDK source records match ${locked} (${revision}).`);
}
