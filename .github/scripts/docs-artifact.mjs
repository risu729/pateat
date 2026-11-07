import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { appendFile, cp, lstat, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { setTimeout } from "node:timers/promises";
import { inventory } from "./server-artifact.mjs";

/* oxlint-disable no-await-in-loop -- Pages are checked and propagation retried in order. */

const root = resolve(import.meta.dirname, "../..");
const build = resolve(root, "apps/docs/.cloudflare/output/v0");
const release = resolve(root, "work/docs-release");
const workerName = "pateat-docs";

export async function verifyDocsBuild(directory) {
  const config = JSON.parse(await readFile(resolve(directory, "config.json"), "utf8"));
  assert.equal(config.buildContext?.mode, "production");
  assert.equal(config.buildContext?.isPreview, false);
  const worker = JSON.parse(
    await readFile(resolve(directory, "workers/default/worker.config.json"), "utf8"),
  );
  assert.equal(worker.name, workerName);
  for (const key of ["entrypoint", "main", "mainModule"])
    assert.equal(worker[key], undefined, "The docs Worker must contain only assets");
  assert.deepEqual(
    (await readdir(resolve(directory, "workers/default"))).toSorted(),
    ["assets", "worker.config.json"],
    "The docs Worker must have no bundled module",
  );
  assert.equal(Object.keys(worker.env ?? {}).length, 0, "The docs Worker has no bindings");
  // The pages are nested under the assets' docs/ directory instead (cloudflare.config.ts).
  assert.equal(worker.assets?.basePath, undefined, "The account offers no asset base path");
  assert.equal(worker.assets?.notFoundHandling, "404-page");
  const assets = resolve(directory, "workers/default/assets");
  assert.deepEqual(await readdir(assets), ["docs"], "Every docs asset must be under /docs/");
  assert((await lstat(resolve(assets, "docs/index.html"))).isFile());
  assert((await lstat(resolve(assets, "docs/404.html"))).isFile());
  assert.match(
    JSON.parse(await readFile(resolve(assets, "docs/revision.json"), "utf8")).revision,
    /^[0-9a-f]{40}$/u,
  );
  assert.notEqual(worker.assets?.runWorkerFirst, true);
  assert.equal(worker.workersDev, false);
  assert.equal(worker.previewUrls, false);
  assert.deepEqual(
    (worker.triggers ?? []).map(({ pattern, zone }) => ({ pattern, zone })),
    [
      { pattern: "pateat.takuk.me/docs", zone: "takuk.me" },
      { pattern: "pateat.takuk.me/docs/*", zone: "takuk.me" },
    ],
  );
}

export function verifyDocsProvenance(manifest, expected) {
  assert.equal(manifest.schema, 1);
  assert.equal(manifest.repository, expected.repository);
  assert.equal(manifest.revision, expected.revision);
  assert.match(manifest.revision, /^[0-9a-f]{40}$/u);
  assert.equal(manifest.runId, expected.runId);
  assert.equal(manifest.event, "push");
  assert.equal(manifest.ref, "refs/heads/main");
  assert.equal(manifest.mode, "production");
  assert.equal(manifest.worker, workerName);
  assert(Array.isArray(manifest.files) && manifest.files.length > 0);
}

/** The revision the built pages publish, which must be the revision being released. */
async function verifyDocsRevision(directory, expected) {
  const path = resolve(directory, "workers/default/assets/docs/revision.json");
  const { revision: built } = JSON.parse(await readFile(path, "utf8"));
  assert.equal(built, expected, "The docs were built from another revision");
}

const provenance = () => ({
  repository: process.env.GITHUB_REPOSITORY,
  revision: process.env.GITHUB_SHA,
  runId: process.env.GITHUB_RUN_ID,
});

async function revision() {
  const value =
    process.env.PATEAT_REVISION ??
    execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim();
  assert(/^[0-9a-f]{40}$/u.test(value), "Invalid source revision");
  await writeFile(
    resolve(root, "apps/docs/.vitepress/dist/docs/revision.json"),
    JSON.stringify({ revision: value }) + "\n",
  );
}

async function pack() {
  assert.equal(process.env.GITHUB_EVENT_NAME, "push");
  assert.equal(process.env.GITHUB_REF, "refs/heads/main");
  assert.equal(process.env.GITHUB_WORKFLOW, "CI");
  assert.equal(process.env.PATEAT_REVISION, process.env.GITHUB_SHA);
  await verifyDocsBuild(build);
  await verifyDocsRevision(build, process.env.GITHUB_SHA);
  await mkdir(resolve(release, ".."), { recursive: true });
  await mkdir(release, { recursive: false });
  await cp(build, resolve(release, "output"), { recursive: true, errorOnExist: true });
  const manifest = {
    schema: 1,
    ...provenance(),
    event: process.env.GITHUB_EVENT_NAME,
    ref: process.env.GITHUB_REF,
    mode: "production",
    worker: workerName,
    files: await inventory(resolve(release, "output")),
  };
  verifyDocsProvenance(manifest, provenance());
  await writeFile(resolve(release, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n");
}

async function restore() {
  const manifest = JSON.parse(await readFile(resolve(release, "manifest.json"), "utf8"));
  verifyDocsProvenance(manifest, provenance());
  const output = resolve(release, "output");
  assert.deepEqual(await inventory(output), manifest.files, "Docs artifact digests differ");
  await verifyDocsBuild(output);
  await verifyDocsRevision(output, process.env.GITHUB_SHA);
  assert.match(process.env.CLOUDFLARE_ACCOUNT_ID ?? "", /^[0-9a-f]{32}$/u);
  await assert.rejects(lstat(build), { code: "ENOENT" }, "Docs output already exists");
  await mkdir(resolve(build, ".."), { recursive: true });
  await cp(output, build, { recursive: true });
  assert.deepEqual(await inventory(build), manifest.files);
}

/** Whether a page's `<html>` tag names the language. */
export function htmlLanguage(html, language) {
  const tag = /<html\b[^>]*>/iu.exec(html)?.[0] ?? "";
  return new RegExp(String.raw`\slang=(["']?)${language}\1[\s>]`, "u").test(tag);
}

async function smoke() {
  // The action's readback of the deployment it created.
  assert.match(process.env.DEPLOYMENT_ID ?? "", /^[0-9a-f-]{36}$/u, "No verified deployment ID");
  assert.match(process.env.VERSION_ID ?? "", /^[0-9a-f-]{36}$/u, "No version ID");
  const url = "https://pateat.takuk.me/docs/";
  const get = (path) =>
    fetch(url + path, {
      redirect: "error",
      signal: AbortSignal.timeout(5000),
      headers: { "Cache-Control": "no-cache" },
    });
  // A new version can take more than ten seconds to reach every edge, as for the server.
  const attempts = 30;
  let failure;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      const response = await get("revision.json");
      assert.equal(response.status, 200, "Public docs revision must be readable without Access");
      assert.equal((await response.json()).revision, process.env.GITHUB_SHA);
      failure = undefined;
      break;
    } catch (error) {
      failure = error;
      if (attempt < attempts - 1) await setTimeout(2000);
    }
  }
  if (failure) throw failure;
  for (const [page, language] of [
    ["installation", "en"],
    ["ja/installation", "ja"],
  ]) {
    const result = await get(page);
    assert.equal(result.status, 200);
    assert(htmlLanguage(await result.text(), language), `${page} is not in ${language}`);
  }
  await appendFile(
    process.env.GITHUB_STEP_SUMMARY,
    [
      "## Docs release verified",
      `- Revision: ${process.env.GITHUB_SHA}`,
      `- Version: ${process.env.VERSION_ID}`,
      `- Deployment: ${process.env.DEPLOYMENT_ID}`,
      "- The public revision and the English and Japanese pages were served.",
      "",
    ].join("\n"),
  );
}

if (process.argv[1] && resolve(process.argv[1]) === import.meta.filename) {
  const tasks = { check: () => verifyDocsBuild(build), revision, pack, restore, smoke };
  const task = tasks[process.argv[2]];
  assert(task, "Expected check, revision, pack, restore or smoke");
  await task();
}
