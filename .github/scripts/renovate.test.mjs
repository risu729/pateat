import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const config = JSON.parse(await readFile(".github/renovate.json", "utf8"));
const manifest = JSON.parse(await readFile("package.json", "utf8"));
const plugin = "@cloudflare/vite-plugin";
const rules = config.packageRules.filter((rule) => rule.matchPackageNames?.includes(plugin));

test("Vite plugin betas use ordered candidates without the hash rollback workaround", () => {
  assert.equal(rules.length, 1);
  const [rule] = rules;
  assert.equal(rule.ignoreUnstable, false);
  assert.equal(rule.respectLatest, false);
  assert.equal(rule.allowedVersions, "/^2\\.0\\.0-beta\\.v\\.[0-9]+$/");
  assert.equal(rule.followTag, undefined);
  assert.equal(rule.rollbackPrs, undefined);
  assert.equal(rule.matchUpdateTypes, undefined);
  assert.equal(rule.commitMessageAction, undefined);
  // Keep release age and candidate filtering owned by the shared preset.
  assert.equal(rule.minimumReleaseAge, undefined);
  assert.equal(rule.internalChecksFilter, undefined);
});

test("the Vite plugin series accepts numeric betas and the committed pin only", () => {
  const pattern = new RegExp(rules[0].allowedVersions.slice(1, -1));
  for (const version of [
    "2.0.0-beta.v.0",
    "2.0.0-beta.v.9",
    "2.0.0-beta.v.10",
    "2.0.0-beta.v.100",
    manifest.devDependencies[plugin],
  ])
    assert.equal(pattern.test(version), true, version);
  for (const version of [
    "2.0.0-beta.sha-ffffffff",
    "2.0.0-beta.v.10-extra",
    "2.0.0-beta.v.10.1",
    "2.0.0-beta.v.x",
    "2.0.0-rc.1",
    "2.0.0",
    "2.1.0-beta.v.1",
    "3.0.0-beta.v.1",
    "12.0.0-beta.v.1",
    "2x0x0-beta.v.1",
  ])
    assert.equal(pattern.test(version), false, version);
});
