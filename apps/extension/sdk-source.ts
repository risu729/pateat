import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";

const repositoryRoot = path.resolve(import.meta.dirname, "../..");
const versionMarker = "__PATEAT_BITWARDEN_SDK_VERSION__";
const revisionMarker = "__PATEAT_BITWARDEN_SDK_REVISION__";
const records = ["THIRD-PARTY-NOTICES.md", "legal.html"];

/** Read the exact installed SDK, refusing a stale install before producing source notices. */
export function readBitwardenSdkSource(root = repositoryRoot): {
  version: string;
  revision: string;
} {
  const read = (file: string) => readFileSync(path.join(root, file), "utf8");
  const manifestPath = path.join(root, "packages/bitwarden/package.json");
  const requested: unknown = JSON.parse(readFileSync(manifestPath, "utf8"));
  const pinned = (requested as { dependencies?: Record<string, string> }).dependencies?.[
    "@bitwarden/sdk-internal"
  ];
  const locked = /"@bitwarden\/sdk-internal": \["@bitwarden\/sdk-internal@([^"]+)"/.exec(
    read("bun.lock"),
  )?.[1];
  if (!locked || pinned !== locked)
    throw new Error("Bitwarden SDK manifest and bun.lock must pin the same version");
  const installed = path.dirname(
    createRequire(manifestPath).resolve("@bitwarden/sdk-internal/package.json"),
  );
  const { version } = JSON.parse(readFileSync(path.join(installed, "package.json"), "utf8")) as {
    version: unknown;
  };
  if (version !== locked || !/^[0-9A-Za-z.+-]+$/.test(locked))
    throw new Error(`Installed SDK differs from bun.lock ${locked}; run mise run install`);
  const revision = readFileSync(path.join(installed, "VERSION"), "utf8").trim();
  if (!/^[0-9a-f]{40}$/.test(revision)) throw new Error("Unexpected Bitwarden SDK VERSION");
  return { version: locked, revision };
}

/** WXT writes these resolved records into each build; the tracked files remain templates. */
export function bitwardenSdkSourceAssets(root = repositoryRoot) {
  const { version, revision } = readBitwardenSdkSource(root);
  return records.map((relativeDest) => {
    const template = readFileSync(path.join(root, "apps/extension/public", relativeDest), "utf8");
    if (!template.includes(versionMarker) || !template.includes(revisionMarker))
      throw new Error(`${relativeDest}: missing Bitwarden SDK source markers`);
    return {
      relativeDest,
      contents: template.replaceAll(versionMarker, version).replaceAll(revisionMarker, revision),
    };
  });
}
