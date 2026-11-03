import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { releaseNotes, releaseTag, verifyManifest } from "./extension-release.mjs";

test("the release tag needs an x.y.z version", () => {
  assert.equal(releaseTag("0.1.0"), "v0.1.0");
  assert.equal(releaseTag("10.20.30"), "v10.20.30");
  for (const version of ["0.1", "0.1.0.1", "01.0.0", "0.1.0-beta", "", undefined])
    assert.throws(() => releaseTag(version));
});

test("the committed extension version can be released", async () => {
  // The workflow refuses another version; catch it in pull request CI.
  const { version } = JSON.parse(await readFile("apps/extension/package.json", "utf8"));
  releaseTag(version);
});

test("only the production manifest of the packaged version is released", () => {
  const manifest = {
    manifest_version: 3,
    version: "0.1.0",
    key: "MIIB",
    host_permissions: ["https://*/*", "http://*/*"],
  };
  verifyManifest(manifest, "0.1.0");
  assert.throws(() => verifyManifest(manifest, "0.2.0"), /another version/u);
  // The probe build has no fixed key and reaches the local fixture server.
  assert.throws(() => verifyManifest({ ...manifest, key: undefined }, "0.1.0"));
  assert.throws(() =>
    verifyManifest(
      { ...manifest, host_permissions: ["https://*/*", "http://127.0.0.1/*"] },
      "0.1.0",
    ),
  );
});

test("release notes link the revision, run, tag source and SDK source and the digest", () => {
  const revision = "a".repeat(40);
  const notes = releaseNotes({
    version: "0.1.0",
    revision,
    tag: "v0.1.0",
    repository: "owner/repo",
    run: { id: "42", url: "https://github.com/owner/repo/actions/runs/42" },
    sdk: { package: "@bitwarden/sdk-internal", version: "0.2.0", revision: "b".repeat(40) },
    zip: { name: "pateat-0.1.0-chrome.zip", sha256: "c".repeat(64) },
  });
  assert(notes.includes(`https://github.com/owner/repo/commit/${revision}`));
  assert(notes.includes("(https://github.com/owner/repo/actions/runs/42)"));
  assert(notes.includes("repository at `v0.1.0`"));
  assert(notes.includes(`https://github.com/bitwarden/sdk-internal/tree/${"b".repeat(40)}`));
  assert(
    notes.includes(`https://github.com/bitwarden/sdk-internal/archive/${"b".repeat(40)}.tar.gz`),
  );
  assert(notes.includes(`| \`pateat-0.1.0-chrome.zip\` | \`${"c".repeat(64)}\` |`));
});
