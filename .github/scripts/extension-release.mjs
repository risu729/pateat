import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { appendFile, copyFile, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { basename, resolve } from "node:path";
import { readBitwardenSdkSource } from "../../apps/extension/sdk-source.ts";

/* oxlint-disable no-await-in-loop -- Downloads run one after another to stay gentle on the registry. */

const extensionPath = "apps/extension";
const outputPath = `${extensionPath}/.output`;
const releasePath = "work/extension-release";
const stagingPath = "work/extension-release-source";
const sdkRepository = "https://github.com/bitwarden/sdk-internal";
const defaultRegistry = "https://registry.npmjs.org/";
const defaultRepository = "risu729/pateat";

/** Chrome accepts up to four dot-separated integers; the release tag needs exactly three. */
export function releaseTag(version) {
  assert.match(version ?? "", /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/u, "Version is x.y.z");
  return `v${version}`;
}

/** Only the production build is released: it has the fixed key and no probe host access. */
export function verifyManifest(manifest, version) {
  assert.equal(manifest.manifest_version, 3);
  assert.equal(manifest.version, version, "The built manifest has another version");
  assert.equal(typeof manifest.key, "string", "Release only the production build");
  assert.deepEqual(manifest.host_permissions, ["https://*/*"], "Release only the production build");
}

/** bun.lock is JSON with trailing commas. */
export function parseBunLock(text) {
  return JSON.parse(text.replaceAll(/,(\s*[}\]])/gu, "$1"));
}

/**
 * The bun.lock entries of the packages the build recorded as bundled
 * (`apps/extension/bundled-packages.ts`). Every one must be a pinned registry package.
 */
export function lockedPackages(lock, bundled) {
  const entries = new Map();
  for (const [id, registry, , integrity] of Object.values(lock.packages)) {
    if (!entries.has(id)) entries.set(id, { registry, integrity });
  }
  assert(bundled.length > 0, "The build recorded no bundled packages");
  return bundled
    .map(({ name, version }) => {
      const entry = entries.get(`${name}@${version}`);
      assert(entry, `bun.lock does not pin bundled ${name}@${version}`);
      assert.match(
        entry.integrity ?? "",
        /^sha512-/u,
        `${name}@${version} has no sha512 integrity`,
      );
      return { name, version, registry: entry.registry, integrity: entry.integrity };
    })
    .sort((a, b) => a.name.localeCompare(b.name, "en") || a.version.localeCompare(b.version, "en"));
}

export function tarballUrl({ name, version, registry }) {
  const base = registry || defaultRegistry;
  return new URL(
    `${name}/-/${basename(name)}-${version}.tgz`,
    base.endsWith("/") ? base : `${base}/`,
  ).href;
}

/** The file name a package's tarball gets inside the source archive. */
export function tarballName({ name, version }) {
  return `${name.replace(/^@/u, "").replace("/", "__")}-${version}.tgz`;
}

export function verifyIntegrity(contents, integrity) {
  const expected = integrity.slice("sha512-".length);
  const actual = createHash("sha512").update(contents).digest("base64");
  assert.equal(actual, expected, "Package tarball differs from bun.lock");
}

export function sha256(contents) {
  return createHash("sha256").update(contents).digest("hex");
}

async function download(url, fetcher) {
  const response = await fetcher(url, { redirect: "follow", signal: AbortSignal.timeout(120_000) });
  assert(response.ok, `GET ${url} answered ${response.status}`);
  return Buffer.from(await response.arrayBuffer());
}

export function sourceReadme({ version, revision, repository, sdk, packages }) {
  return `# Pateat ${version} source archive

This archive is the source provided with the Pateat ${version} Chrome extension
release. The directory above this one is the Pateat repository at revision
${revision} of https://github.com/${repository}, unmodified.
docs/sdk-source.md in it says how to build, install and modify the extension, and
LICENSING.md which license covers which part.

This directory adds the source of what the extension bundles from outside the
repository:

- bitwarden-sdk-internal-${sdk.revision}.tar.gz: the official Bitwarden SDK
  (${sdk.package}@${sdk.version}) source at commit ${sdk.revision}, as
  ${sdkRepository}/archive/${sdk.revision}.tar.gz served it when this release
  was packed.
- npm/: the registry tarball of each third-party package that the production
  build recorded as bundled (its modules, or a stylesheet that keeps the package's
  license banner), as bun.lock pins it; each matched bun.lock's integrity hash.
  index.json lists them.

Packages: ${packages.length}.
`;
}

export function releaseNotes({ version, revision, repository, run, sdk, assets }) {
  const repo = `https://github.com/${repository}`;
  const rows = assets.map(({ name, sha256: digest }) => `| \`${name}\` | \`${digest}\` |`);
  return `Pateat ${version} for Chrome, built from [\`${revision.slice(0, 12)}\`](${repo}/commit/${revision}) by [workflow run ${run.id}](${run.url}).

- \`pateat-${version}-chrome.zip\`: the extension. Unzip it and load the folder with Load
  unpacked on \`chrome://extensions\` in developer mode.
- \`pateat-${version}-source.tar.gz\`: its source: the Pateat repository at that revision, the [Bitwarden SDK source](${sdkRepository}/tree/${sdk.revision}) of the
  bundled \`${sdk.package}@${sdk.version}\`, and the registry tarballs of the other bundled
  packages. See [building from source](${repo}/blob/${revision}/docs/sdk-source.md#build-and-installation).
- \`release.json\`: what was packed, from which revision and run, with each file's digest.
- \`SHA256SUMS\`: the digests below.

The extension is licensed under GPL-3.0-only; see
[LICENSING.md](${repo}/blob/${revision}/LICENSING.md).

| File | SHA-256 |
| ---- | ------- |
${rows.join("\n")}

Check the downloads with \`sha256sum --check SHA256SUMS\`.
`;
}

function git(args) {
  return execFileSync("git", args, { encoding: "utf8" }).trim();
}

/** Pack the built extension and the source provided with it for a draft release. */
export async function pack({ fetcher = fetch, env = process.env } = {}) {
  const revision = git(["rev-parse", "HEAD"]);
  if (env.PATEAT_REVISION) assert.equal(env.PATEAT_REVISION, revision, "Build another revision");
  assert.equal(git(["status", "--porcelain"]), "", "The checkout must be clean");
  const { version } = JSON.parse(await readFile(`${extensionPath}/package.json`, "utf8"));
  const tag = releaseTag(version);
  verifyManifest(
    JSON.parse(await readFile(`${outputPath}/chrome-mv3/manifest.json`, "utf8")),
    version,
  );
  const zipName = `pateat-${version}-chrome.zip`;
  const sourceName = `pateat-${version}-source.tar.gz`;
  const { version: sdkVersion, revision: sdkRevision } = readBitwardenSdkSource();
  const sdk = { package: "@bitwarden/sdk-internal", version: sdkVersion, revision: sdkRevision };
  const manifestPath = `${outputPath}/chrome-mv3/manifest.json`;
  const zipPath = `${outputPath}/${zipName}`;
  const packagesPath = `${outputPath}/chrome-mv3.packages.json`;
  const built = (await stat(manifestPath)).mtimeMs;
  for (const file of [zipPath, packagesPath])
    assert(
      (await stat(file)).mtimeMs >= built,
      `${file} is older than the build; run mise run //apps/extension:zip`,
    );
  const packages = lockedPackages(
    parseBunLock(await readFile("bun.lock", "utf8")),
    JSON.parse(await readFile(packagesPath, "utf8")),
  );
  assert(
    packages.some(({ name, version: pinned }) => name === sdk.package && pinned === sdk.version),
    "The SDK must be among the bundled packages",
  );

  // Never merge an earlier release into this one.
  await mkdir("work", { recursive: true });
  await mkdir(releasePath, { recursive: false }).catch((error) => {
    throw new Error(`Remove ${releasePath} from an earlier pack first`, { cause: error });
  });
  await rm(stagingPath, { recursive: true, force: true });
  await mkdir(`${stagingPath}/npm`, { recursive: true });
  await copyFile(zipPath, `${releasePath}/${zipName}`);

  const sdkName = `bitwarden-sdk-internal-${sdk.revision}.tar.gz`;
  const sdkArchive = await download(`${sdkRepository}/archive/${sdk.revision}.tar.gz`, fetcher);
  await writeFile(`${stagingPath}/${sdkName}`, sdkArchive);
  const index = [];
  for (const entry of packages) {
    const url = tarballUrl(entry);
    const contents = await download(url, fetcher);
    verifyIntegrity(contents, entry.integrity);
    const file = tarballName(entry);
    await writeFile(`${stagingPath}/npm/${file}`, contents);
    index.push({ name: entry.name, version: entry.version, file, url, integrity: entry.integrity });
  }
  await writeFile(`${stagingPath}/npm/index.json`, `${JSON.stringify(index, null, 2)}\n`);
  const repository = env.GITHUB_REPOSITORY ?? defaultRepository;
  const record = { version, revision, repository, sdk, packages: index };
  await writeFile(`${stagingPath}/README.md`, sourceReadme(record));

  // git archive takes each added file under the --prefix given before it, and the tree
  // under the last one; its gzip output depends only on the commit and these files.
  const root = `pateat-${version}/`;
  execFileSync("git", [
    "archive",
    "--format=tar.gz",
    `--output=${releasePath}/${sourceName}`,
    `--prefix=${root}third-party-source/npm/`,
    ...[...index.map(({ file }) => file), "index.json"].map(
      (file) => `--add-file=${stagingPath}/npm/${file}`,
    ),
    `--prefix=${root}third-party-source/`,
    `--add-file=${stagingPath}/${sdkName}`,
    `--add-file=${stagingPath}/README.md`,
    `--prefix=${root}`,
    revision,
  ]);
  await rm(stagingPath, { recursive: true });

  const assets = [];
  for (const name of [zipName, sourceName]) {
    const contents = await readFile(`${releasePath}/${name}`);
    assets.push({ name, bytes: contents.length, sha256: sha256(contents) });
  }
  // A local dry run has no workflow run to name.
  const run = env.GITHUB_RUN_ID
    ? {
        id: env.GITHUB_RUN_ID,
        attempt: env.GITHUB_RUN_ATTEMPT,
        url: `${env.GITHUB_SERVER_URL}/${repository}/actions/runs/${env.GITHUB_RUN_ID}`,
      }
    : { id: "local", attempt: "1", url: "" };
  const manifest = {
    schema: 1,
    repository,
    revision,
    version,
    tag,
    event: env.GITHUB_EVENT_NAME ?? "local",
    ref: env.GITHUB_REF ?? "",
    run,
    sdk: { ...sdk, source: `${sdkRepository}/archive/${sdk.revision}.tar.gz` },
    sdkSourceSha256: sha256(sdkArchive),
    packages: index.map(({ name, version: pinned, integrity }) => ({
      name,
      version: pinned,
      integrity,
    })),
    assets,
  };
  await writeFile(`${releasePath}/release.json`, `${JSON.stringify(manifest, null, 2)}\n`);
  const releaseJson = await readFile(`${releasePath}/release.json`);
  const sums = [...assets, { name: "release.json", sha256: sha256(releaseJson) }];
  await writeFile(
    `${releasePath}/SHA256SUMS`,
    sums.map(({ name, sha256: digest }) => `${digest}  ${name}\n`).join(""),
  );
  await writeFile(`${releasePath}/notes.md`, releaseNotes({ ...manifest, assets: sums }));
  for (const { name, bytes } of assets)
    assert((await stat(`${releasePath}/${name}`)).size === bytes);
  if (env.GITHUB_OUTPUT)
    await appendFile(env.GITHUB_OUTPUT, `version=${version}\ntag=${tag}\n`, "utf8");
  return manifest;
}

if (process.argv[1] && resolve(process.argv[1]) === import.meta.filename) {
  assert.equal(process.argv[2], "pack", "Expected pack");
  const manifest = await pack();
  console.log(
    `Packed Pateat ${manifest.version} (${manifest.revision}) with ${manifest.packages.length} packages and SDK ${manifest.sdk.revision}.`,
  );
}
