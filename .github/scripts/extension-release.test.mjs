import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  bundledPackagesPlugin,
  owningPackage,
  resetBundledPackages,
  writeBundledPackages,
} from "../../apps/extension/bundled-packages.ts";
import {
  lockedPackages,
  parseBunLock,
  releaseNotes,
  releaseTag,
  tarballName,
  tarballUrl,
  verifyIntegrity,
  verifyManifest,
} from "./extension-release.mjs";

const integrity = (text) => `sha512-${createHash("sha512").update(text).digest("base64")}`;

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
    host_permissions: ["https://*/*"],
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

test("bun.lock's trailing commas parse", () => {
  assert.deepEqual(parseBunLock('{\n  "a": [1, 2,],\n  "b": { "c": "d", },\n}'), {
    a: [1, 2],
    b: { c: "d" },
  });
});

test("bundled packages map to their bun.lock entries", () => {
  const lock = {
    packages: {
      "@pateat/contracts": ["@pateat/contracts@workspace:packages/contracts"],
      react: ["react@19.0.0", "", {}, integrity("react")],
      "@scope/dep": ["@scope/dep@1.0.0", "", {}, integrity("dep1")],
      "lib/@scope/dep": ["@scope/dep@2.0.0", "https://registry.example/", {}, integrity("dep2")],
      legacy: ["legacy@1.0.0", "", {}, "sha1-abc"],
    },
  };
  const packages = lockedPackages(lock, [
    { name: "react", version: "19.0.0" },
    { name: "@scope/dep", version: "2.0.0" },
  ]);
  assert.deepEqual(
    packages.map(({ name, version, registry }) => `${name}@${version} ${registry}`),
    ["@scope/dep@2.0.0 https://registry.example/", "react@19.0.0 "],
  );
  assert.equal(packages[1].integrity, integrity("react"));
  // A bundled package bun.lock does not pin, or pins without sha512, stops the release.
  assert.throws(() => lockedPackages(lock, [{ name: "react", version: "18.0.0" }]), /18\.0\.0/u);
  assert.throws(() => lockedPackages(lock, [{ name: "legacy", version: "1.0.0" }]), /sha512/u);
  assert.throws(() => lockedPackages(lock, []), /no bundled packages/u);
});

test("the build records bundled packages from modules and CSS license banners", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "pateat-bundled-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const installed = join(root, "node_modules/.store/lib@1.0.0/node_modules/@scope/lib");
  await mkdir(join(installed, "dist/esm"), { recursive: true });
  await writeFile(
    join(installed, "package.json"),
    JSON.stringify({ name: "@scope/lib", version: "1.0.0" }),
  );
  // A nested package.json without a name, as some packages ship for module type.
  await writeFile(join(installed, "dist/esm/package.json"), JSON.stringify({ type: "module" }));
  await writeFile(join(installed, "dist/esm/index.js"), "");
  assert.deepEqual(owningPackage(join(installed, "dist/esm/index.js")), {
    name: "@scope/lib",
    version: "1.0.0",
  });
  // Repository code, such as a linked workspace package, is not a third-party package.
  assert.equal(owningPackage(join(root, "packages/contracts/src/index.ts")), undefined);

  resetBundledPackages();
  const plugin = bundledPackagesPlugin();
  plugin.generateBundle.call(
    {},
    {},
    {
      "a.js": {
        type: "chunk",
        fileName: "a.js",
        moduleIds: ["\0virtual", `${join(installed, "dist/esm/index.js")}?url`, "/repo/src/a.ts"],
      },
      "a.css": {
        type: "asset",
        fileName: "a.css",
        source: "/*! tailwindcss v4.3.3 | MIT License | https://tailwindcss.com */\n.a{}",
      },
    },
  );
  const outDir = join(root, "chrome-mv3");
  writeBundledPackages(outDir);
  assert.deepEqual(JSON.parse(await readFile(`${outDir}.packages.json`, "utf8")), [
    { name: "@scope/lib", version: "1.0.0" },
    { name: "tailwindcss", version: "4.3.3" },
  ]);
  resetBundledPackages();
});

test("tarball URLs and names", () => {
  assert.equal(
    tarballUrl({ name: "@scope/pkg", version: "1.2.3", registry: "" }),
    "https://registry.npmjs.org/@scope/pkg/-/pkg-1.2.3.tgz",
  );
  assert.equal(
    tarballUrl({ name: "pkg", version: "1.0.0", registry: "https://registry.example/npm" }),
    "https://registry.example/npm/pkg/-/pkg-1.0.0.tgz",
  );
  assert.equal(tarballName({ name: "@scope/pkg", version: "1.2.3" }), "scope__pkg-1.2.3.tgz");
  assert.equal(tarballName({ name: "pkg", version: "1.0.0" }), "pkg-1.0.0.tgz");
});

test("a tarball must match bun.lock's integrity", () => {
  verifyIntegrity(Buffer.from("react"), integrity("react"));
  assert.throws(() => verifyIntegrity(Buffer.from("tampered"), integrity("react")));
});

test("release notes link the revision, run and SDK source and list every digest", () => {
  const revision = "a".repeat(40);
  const notes = releaseNotes({
    version: "0.1.0",
    revision,
    repository: "owner/repo",
    run: { id: "42", url: "https://github.com/owner/repo/actions/runs/42" },
    sdk: { package: "@bitwarden/sdk-internal", version: "0.2.0", revision: "b".repeat(40) },
    assets: [
      { name: "pateat-0.1.0-chrome.zip", sha256: "c".repeat(64) },
      { name: "pateat-0.1.0-source.tar.gz", sha256: "d".repeat(64) },
    ],
  });
  assert(notes.includes(`https://github.com/owner/repo/commit/${revision}`));
  assert(notes.includes("(https://github.com/owner/repo/actions/runs/42)"));
  assert(notes.includes(`https://github.com/bitwarden/sdk-internal/tree/${"b".repeat(40)}`));
  assert(notes.includes(`| \`pateat-0.1.0-chrome.zip\` | \`${"c".repeat(64)}\` |`));
  assert(notes.includes(`| \`pateat-0.1.0-source.tar.gz\` | \`${"d".repeat(64)}\` |`));
});
