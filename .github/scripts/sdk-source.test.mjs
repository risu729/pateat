import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  bitwardenSdkSourceAssets,
  readBitwardenSdkSource,
} from "../../apps/extension/sdk-source.ts";

const initialVersion = "0.2.0-main.9000";
const initialRevision = "a".repeat(40);
const noticeNames = ["THIRD-PARTY-NOTICES.md", "legal.html"];

async function fixture(t, overrides = {}) {
  const root = await mkdtemp(join(tmpdir(), "pateat-sdk-source-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const installed = join(root, "node_modules/@bitwarden/sdk-internal");
  const publicDirectory = join(root, "apps/extension/public");
  await Promise.all([
    mkdir(installed, { recursive: true }),
    mkdir(publicDirectory, { recursive: true }),
    mkdir(join(root, "packages/bitwarden"), { recursive: true }),
  ]);
  const metadata = async ({
    manifestVersion = initialVersion,
    lockedVersion = initialVersion,
    installedVersion = initialVersion,
    revision = initialRevision,
  } = {}) => {
    await Promise.all([
      writeFile(
        join(root, "packages/bitwarden/package.json"),
        JSON.stringify({ dependencies: { "@bitwarden/sdk-internal": manifestVersion } }),
      ),
      writeFile(
        join(root, "bun.lock"),
        `{
  "packages": {
    "@bitwarden/sdk-internal": ${JSON.stringify([`@bitwarden/sdk-internal@${lockedVersion}`])}
  }
}`,
      ),
      writeFile(
        join(installed, "package.json"),
        JSON.stringify({ name: "@bitwarden/sdk-internal", version: installedVersion }),
      ),
      writeFile(join(installed, "VERSION"), `${revision}\n`),
    ]);
  };
  await metadata(overrides);
  await Promise.all(
    noticeNames.map(async (name) => {
      const template = await readFile(
        new URL(`../../apps/extension/public/${name}`, import.meta.url),
        "utf8",
      );
      await writeFile(join(publicDirectory, name), template);
    }),
  );
  return { root, metadata, publicDirectory };
}

test("SDK source notices follow a dependency upgrade without editing templates", async (t) => {
  const { root, metadata, publicDirectory } = await fixture(t);
  const templates = await Promise.all(
    noticeNames.map((name) => readFile(join(publicDirectory, name), "utf8")),
  );
  assert.deepEqual(readBitwardenSdkSource(root), {
    version: initialVersion,
    revision: initialRevision,
  });
  const before = bitwardenSdkSourceAssets(root);
  const nextVersion = "0.2.0-main.9001";
  const nextRevision = "b".repeat(40);
  await metadata({
    manifestVersion: nextVersion,
    lockedVersion: nextVersion,
    installedVersion: nextVersion,
    revision: nextRevision,
  });
  assert.deepEqual(readBitwardenSdkSource(root), { version: nextVersion, revision: nextRevision });
  const after = bitwardenSdkSourceAssets(root);
  assert.deepEqual(
    after.map(({ relativeDest }) => relativeDest),
    noticeNames,
  );
  for (const [index, { contents }] of after.entries()) {
    assert(before[index].contents.includes(initialVersion));
    assert(contents.includes(nextVersion));
    assert(
      contents.includes(`https://github.com/bitwarden/sdk-internal/archive/${nextRevision}.tar.gz`),
    );
    assert(
      contents.includes(
        `https://github.com/bitwarden/sdk-internal/blob/${nextRevision}/crates/bitwarden-wasm-internal/README.md`,
      ),
    );
    assert(!contents.includes(initialVersion));
    assert(!contents.includes(initialRevision));
    assert(!contents.includes("__PATEAT_BITWARDEN_SDK_"));
  }
  assert.deepEqual(
    await Promise.all(noticeNames.map((name) => readFile(join(publicDirectory, name), "utf8"))),
    templates,
  );
});

for (const [description, metadata, expected] of [
  [
    "manifest differs from the lock",
    { manifestVersion: "0.2.0-main.9001" },
    /manifest and bun.lock/u,
  ],
  [
    "manifest uses an unpinned range",
    { manifestVersion: `^${initialVersion}` },
    /manifest and bun.lock/u,
  ],
  [
    "installed package differs from the lock",
    { installedVersion: "0.2.0-main.9001" },
    /Installed SDK differs/u,
  ],
  ["installed package has no version", { installedVersion: null }, /Installed SDK differs/u],
  ["VERSION is empty", { revision: "" }, /Unexpected Bitwarden SDK VERSION/u],
  ["VERSION is abbreviated", { revision: "abcdef1" }, /Unexpected Bitwarden SDK VERSION/u],
  [
    "VERSION has non-hexadecimal characters",
    { revision: "g".repeat(40) },
    /Unexpected Bitwarden SDK VERSION/u,
  ],
  [
    "VERSION contains extra lines",
    { revision: `${initialRevision}\nunexpected` },
    /Unexpected Bitwarden SDK VERSION/u,
  ],
]) {
  test(`SDK source metadata rejects when ${description}`, async (t) => {
    const { root } = await fixture(t, metadata);
    assert.throws(() => readBitwardenSdkSource(root), expected);
    assert.throws(() => bitwardenSdkSourceAssets(root), expected);
  });
}

test("SDK source metadata rejects a missing locked package", async (t) => {
  const { root } = await fixture(t);
  await writeFile(join(root, "bun.lock"), JSON.stringify({ packages: {} }));
  assert.throws(() => readBitwardenSdkSource(root), /manifest and bun.lock/u);
});

test("SDK notices reject a template missing either source marker", async (t) => {
  const { root, publicDirectory } = await fixture(t);
  await writeFile(join(publicDirectory, "legal.html"), "<p>__PATEAT_BITWARDEN_SDK_VERSION__</p>");
  assert.throws(() => bitwardenSdkSourceAssets(root), /legal.html: missing/u);
  await writeFile(join(publicDirectory, "legal.html"), "<p>__PATEAT_BITWARDEN_SDK_REVISION__</p>");
  assert.throws(() => bitwardenSdkSourceAssets(root), /legal.html: missing/u);
});
