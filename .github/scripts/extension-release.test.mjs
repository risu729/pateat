import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  parseBunLock,
  releaseNotes,
  releaseTag,
  runtimePackages,
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

test("runtime packages follow Bun's layout and skip what the extension never installs", () => {
  const lock = {
    workspaces: {
      "apps/extension": {
        name: "@pateat/extension",
        dependencies: { "@pateat/contracts": "workspace:*", react: "19.0.0", lib: "1.0.0" },
        devDependencies: { wxt: "0.21.4" },
      },
      "packages/contracts": { name: "@pateat/contracts", dependencies: { valibot: "1.5.0" } },
      "services/api": { name: "@pateat/api", dependencies: { hono: "4.0.0" } },
    },
    packages: {
      "@pateat/contracts": ["@pateat/contracts@workspace:packages/contracts"],
      react: ["react@19.0.0", "", {}, integrity("react")],
      "react-dom": ["react-dom@19.0.0", "", { peerDependencies: { react: "*" } }, integrity("rd")],
      lib: [
        "lib@1.0.0",
        "",
        {
          dependencies: { "@scope/dep": "^2" },
          peerDependencies: { "react-dom": "*", typescript: ">=5" },
          optionalPeers: ["typescript"],
          optionalDependencies: { "lib-linux-x64": "1.0.0", missing: "1.0.0" },
        },
        integrity("lib"),
      ],
      // Hoisted 1.x is someone else's; lib gets its own nested 2.x.
      "@scope/dep": ["@scope/dep@1.0.0", "", {}, integrity("dep1")],
      "lib/@scope/dep": [
        "@scope/dep@2.0.0",
        "https://registry.example/",
        { dependencies: { leaf: "1" } },
        integrity("dep2"),
      ],
      leaf: ["leaf@1.0.0", "", {}, integrity("leaf")],
      "lib-linux-x64": ["lib-linux-x64@1.0.0", "", { os: "linux", cpu: "x64" }, integrity("x")],
      valibot: ["valibot@1.5.0", "", {}, integrity("valibot")],
      typescript: ["typescript@7.0.2", "", {}, integrity("ts")],
      wxt: ["wxt@0.21.4", "", {}, integrity("wxt")],
      hono: ["hono@4.0.0", "", {}, integrity("hono")],
    },
  };
  const packages = runtimePackages(lock, ["apps/extension"]);
  assert.deepEqual(
    packages.map(({ name, version }) => `${name}@${version}`),
    [
      "@scope/dep@2.0.0",
      "leaf@1.0.0",
      "lib@1.0.0",
      "react@19.0.0",
      "react-dom@19.0.0",
      "valibot@1.5.0",
    ],
  );
  assert.equal(packages[0].registry, "https://registry.example/");
  // A required dependency that bun.lock cannot resolve stops the release.
  lock.packages.lib[2].dependencies.absent = "1";
  assert.throws(() => runtimePackages(lock, ["apps/extension"]), /does not resolve absent/u);
  delete lock.packages.lib[2].dependencies.absent;
  lock.packages.leaf[3] = "sha1-abc";
  assert.throws(() => runtimePackages(lock, ["apps/extension"]), /sha512/u);
});

test("the extension's packages resolve from the committed bun.lock", async () => {
  const packages = runtimePackages(parseBunLock(await readFile("bun.lock", "utf8")));
  const names = new Set(packages.map(({ name }) => name));
  for (const name of ["@bitwarden/sdk-internal", "react", "react-dom", "valibot"])
    assert(names.has(name), `${name} is bundled`);
  // Build tools and the compiler are not part of the extension.
  for (const name of ["wxt", "vite", "typescript", "@types/react"])
    assert(!names.has(name), `${name} is not bundled`);
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
