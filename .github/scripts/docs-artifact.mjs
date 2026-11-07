import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { cp, lstat, mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { inventory } from "./server-artifact.mjs";

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
  assert.equal(worker.entrypoint, undefined, "The docs Worker must contain only assets");
  assert.equal(Object.keys(worker.env ?? {}).length, 0, "The docs Worker has no bindings");
  assert.equal(worker.assets?.basePath, "/docs");
  assert.equal(worker.assets?.notFoundHandling, "404-page");
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
    resolve(root, "apps/docs/.vitepress/dist/revision.json"),
    JSON.stringify({ revision: value }) + "\n",
  );
}

async function pack() {
  assert.equal(process.env.GITHUB_EVENT_NAME, "push");
  assert.equal(process.env.GITHUB_REF, "refs/heads/main");
  assert.equal(process.env.GITHUB_WORKFLOW, "CI");
  assert.equal(process.env.PATEAT_REVISION, process.env.GITHUB_SHA);
  await verifyDocsBuild(build);
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
  assert.match(process.env.CLOUDFLARE_ACCOUNT_ID ?? "", /^[0-9a-f]{32}$/u);
  await assert.rejects(lstat(build), { code: "ENOENT" }, "Docs output already exists");
  await mkdir(resolve(build, ".."), { recursive: true });
  await cp(output, build, { recursive: true });
  assert.deepEqual(await inventory(build), manifest.files);
}

async function smoke() {
  const url = "https://pateat.takuk.me/docs/";
  const response = await fetch(url + "revision.json", { signal: AbortSignal.timeout(10_000) });
  assert.equal(response.status, 200, "Public docs revision must be readable without Access");
  assert.equal((await response.json()).revision, process.env.GITHUB_SHA);
  for (const [page, language] of [
    ["installation", "en"],
    ["ja/installation", "ja"],
  ]) {
    // eslint-disable-next-line no-await-in-loop
    const result = await fetch(url + page, { signal: AbortSignal.timeout(10_000) });
    assert.equal(result.status, 200);
    // eslint-disable-next-line no-await-in-loop
    assert((await result.text()).includes(`lang="${language}"`));
  }
}

if (process.argv[1] && resolve(process.argv[1]) === import.meta.filename) {
  const tasks = { check: () => verifyDocsBuild(build), revision, pack, restore, smoke };
  const task = tasks[process.argv[2]];
  assert(task, "Expected check, revision, pack, restore or smoke");
  await task();
}
