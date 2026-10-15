// Exercise the same installed-metadata-to-notice path used by production and probe builds.
import { bitwardenSdkSourceAssets, readBitwardenSdkSource } from "../apps/extension/sdk-source.ts";

const { version, revision } = readBitwardenSdkSource();
const records = bitwardenSdkSourceAssets();
for (const { relativeDest, contents } of records) {
  if (!contents.includes(version) || !contents.includes(revision) || /__PATEAT_/.test(contents))
    throw new Error(`${relativeDest}: incomplete Bitwarden SDK source notice`);
}
console.log(`SDK source notices render from installed ${version} (${revision}).`);
