import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { appendFile, copyFile, mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { readBitwardenSdkSource } from "../../apps/extension/sdk-source.ts";

const extensionPath = "apps/extension";
const outputPath = `${extensionPath}/.output`;
const releasePath = "work/extension-release";
const sdkRepository = "https://github.com/bitwarden/sdk-internal";
const defaultRepository = "risu729/pateat";

/** Chrome accepts up to four dot-separated integers; the release tag needs exactly three. */
export function releaseTag(version) {
  assert.match(version ?? "", /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/u, "Version is x.y.z");
  return `v${version}`;
}

/**
 * Only the production build is released: it has the fixed key and the HTTP(S) host access of
 * ADR 0050, not the probe build's local fixture host.
 */
export function verifyManifest(manifest, version) {
  assert.equal(manifest.manifest_version, 3);
  assert.equal(manifest.version, version, "The built manifest has another version");
  assert.equal(typeof manifest.key, "string", "Release only the production build");
  assert.deepEqual(
    manifest.host_permissions,
    ["https://*/*", "http://*/*"],
    "Release only the production build",
  );
}

export function sha256(contents) {
  return createHash("sha256").update(contents).digest("hex");
}

/**
 * The release text after release-please's changelog. The source is the tag's own GitHub
 * archive ("Source code" on the release page) and the SDK's upstream archive at the
 * commit the bundled package names (docs/sdk-source.md#release-source).
 */
export function releaseNotes({ version, revision, tag, repository, run, sdk, zip }) {
  const repo = `https://github.com/${repository}`;
  return `Pateat ${version} for Chrome, built from [\`${revision.slice(0, 12)}\`](${repo}/commit/${revision}) by [workflow run ${run.id}](${run.url}).

- \`${zip.name}\`: the extension. Unzip it and load the folder with Load unpacked on
  \`chrome://extensions\` in developer mode.
- Source: "Source code" below is the repository at \`${tag}\`, with its lockfiles and
  [build instructions](${repo}/blob/${revision}/docs/sdk-source.md#build-and-installation).
  The bundled \`${sdk.package}@${sdk.version}\` is built from
  [bitwarden/sdk-internal at \`${sdk.revision.slice(0, 12)}\`](${sdkRepository}/tree/${sdk.revision})
  ([archive](${sdkRepository}/archive/${sdk.revision}.tar.gz)); the other packages are
  the versions \`bun.lock\` pins.

The extension is licensed under GPL-3.0-only; see
[LICENSING.md](${repo}/blob/${revision}/LICENSING.md).

| File | SHA-256 |
| ---- | ------- |
| \`${zip.name}\` | \`${zip.sha256}\` |

Check the download with \`sha256sum --check SHA256SUMS\`.
`;
}

function git(args) {
  return execFileSync("git", args, { encoding: "utf8" }).trim();
}

/** Pack the built extension ZIP, its digest and the release text. */
export async function pack({ env = process.env } = {}) {
  const revision = git(["rev-parse", "HEAD"]);
  if (env.PATEAT_REVISION) assert.equal(env.PATEAT_REVISION, revision, "Build another revision");
  assert.equal(git(["status", "--porcelain"]), "", "The checkout must be clean");
  const { version } = JSON.parse(await readFile(`${extensionPath}/package.json`, "utf8"));
  const tag = releaseTag(version);
  const manifestPath = `${outputPath}/chrome-mv3/manifest.json`;
  verifyManifest(JSON.parse(await readFile(manifestPath, "utf8")), version);
  const zipName = `pateat-${version}-chrome.zip`;
  const zipPath = `${outputPath}/${zipName}`;
  assert(
    (await stat(zipPath)).mtimeMs >= (await stat(manifestPath)).mtimeMs,
    `${zipPath} is older than the build; run mise run //apps/extension:zip`,
  );
  const { version: sdkVersion, revision: sdkRevision } = readBitwardenSdkSource();
  const sdk = { package: "@bitwarden/sdk-internal", version: sdkVersion, revision: sdkRevision };

  // Never merge an earlier release into this one.
  await mkdir("work", { recursive: true });
  await mkdir(releasePath, { recursive: false }).catch((error) => {
    throw new Error(`Remove ${releasePath} from an earlier pack first`, { cause: error });
  });
  await copyFile(zipPath, `${releasePath}/${zipName}`);
  const zip = { name: zipName, sha256: sha256(await readFile(`${releasePath}/${zipName}`)) };
  const repository = env.GITHUB_REPOSITORY ?? defaultRepository;
  // A local dry run has no workflow run to name.
  const run = env.GITHUB_RUN_ID
    ? {
        id: env.GITHUB_RUN_ID,
        url: `${env.GITHUB_SERVER_URL}/${repository}/actions/runs/${env.GITHUB_RUN_ID}`,
      }
    : { id: "local", url: "" };
  await writeFile(`${releasePath}/SHA256SUMS`, `${zip.sha256}  ${zip.name}\n`);
  await writeFile(
    `${releasePath}/notes.md`,
    releaseNotes({ version, revision, tag, repository, run, sdk, zip }),
  );
  if (env.GITHUB_OUTPUT)
    await appendFile(env.GITHUB_OUTPUT, `version=${version}\ntag=${tag}\n`, "utf8");
  return { version, revision, tag, sdk, zip };
}

if (process.argv[1] && resolve(process.argv[1]) === import.meta.filename) {
  assert.equal(process.argv[2], "pack", "Expected pack");
  const packed = await pack();
  console.log(`Packed Pateat ${packed.version} (${packed.revision}): ${packed.zip.sha256}.`);
}
