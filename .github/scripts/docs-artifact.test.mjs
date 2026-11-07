import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import test from "node:test";
import { htmlLanguage, verifyDocsBuild, verifyDocsProvenance } from "./docs-artifact.mjs";

/* oxlint-disable no-await-in-loop -- The cases change the same build directory in turn. */

test("docs provenance accepts only the same trusted main run", () => {
  const expected = { repository: "risu729/pateat", revision: "a".repeat(40), runId: "1" };
  const manifest = {
    schema: 1,
    ...expected,
    event: "push",
    ref: "refs/heads/main",
    mode: "production",
    worker: "pateat-docs",
    files: [{ path: "config.json" }],
  };
  verifyDocsProvenance(manifest, expected);
  for (const changed of [
    { event: "pull_request" },
    { ref: "refs/heads/feature" },
    { runId: "2" },
    { revision: "b".repeat(40) },
    { worker: "pateat-api" },
    { mode: "preview" },
  ])
    assert.throws(() => verifyDocsProvenance({ ...manifest, ...changed }, expected));
});

test("docs output refuses executable Workers, bundled modules, bindings, wrong routes, root assets and preview output", async () => {
  const directory = await mkdtemp(resolve(tmpdir(), "pateat-docs-output-"));
  try {
    const assets = resolve(directory, "workers/default/assets");
    await mkdir(resolve(assets, "docs"), { recursive: true });
    await writeFile(resolve(assets, "docs/index.html"), "<html></html>");
    await writeFile(resolve(assets, "docs/404.html"), "<html></html>");
    await writeFile(
      resolve(assets, "docs/revision.json"),
      JSON.stringify({ revision: "a".repeat(40) }),
    );
    const config = { buildContext: { mode: "production", isPreview: false } };
    const worker = {
      name: "pateat-docs",
      assets: { notFoundHandling: "404-page" },
      workersDev: false,
      previewUrls: false,
      triggers: [
        { pattern: "pateat.takuk.me/docs", zone: "takuk.me" },
        { pattern: "pateat.takuk.me/docs/*", zone: "takuk.me" },
      ],
    };
    const put = (value) =>
      writeFile(resolve(directory, "workers/default/worker.config.json"), JSON.stringify(value));
    await writeFile(resolve(directory, "config.json"), JSON.stringify(config));
    await put(worker);
    await verifyDocsBuild(directory);
    for (const [changed, reason] of [
      [{ entrypoint: "index.js" }, /only assets/u],
      [{ main: "index.js" }, /only assets/u],
      [{ mainModule: "index.js" }, /only assets/u],
      [{ env: { API: { type: "service" } } }, /no bindings/u],
      [{ triggers: [{ pattern: "pateat.takuk.me/*", zone: "takuk.me" }] }, /docs routes/u],
      [{ assets: { basePath: "/docs", notFoundHandling: "404-page" } }, /base path/u],
      [{ assets: { notFoundHandling: "single-page-application" } }, /404 page/u],
      [{ assets: { notFoundHandling: "404-page", runWorkerFirst: true } }, /runs first/u],
      [{ workersDev: true }, /workers\.dev/u],
      [{ previewUrls: true }, /preview addresses/u],
    ]) {
      await put({ ...worker, ...changed });
      await assert.rejects(verifyDocsBuild(directory), reason);
    }
    await put(worker);
    await writeFile(resolve(directory, "workers/default/index.js"), "export default {};");
    await assert.rejects(verifyDocsBuild(directory), /no bundled module/u);
    await rm(resolve(directory, "workers/default/index.js"));
    await put(worker);
    await writeFile(
      resolve(directory, "config.json"),
      JSON.stringify({ buildContext: { mode: "production", isPreview: true } }),
    );
    await assert.rejects(verifyDocsBuild(directory), /production build/u);
    await writeFile(resolve(directory, "config.json"), JSON.stringify(config));
    await writeFile(resolve(assets, "index.html"), "<html></html>");
    await assert.rejects(verifyDocsBuild(directory), /under \/docs\//u);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("the page language is read from the html tag only", () => {
  assert(htmlLanguage('<!doctype html><html lang="ja" dir="ltr"><head>', "ja"));
  assert(htmlLanguage("<html lang=en>", "en"));
  assert(!htmlLanguage('<html lang="en"><a lang="ja">', "ja"));
  assert(!htmlLanguage('<html lang="ja-JP">', "ja"));
  assert(!htmlLanguage('<p>lang="ja"</p>', "ja"));
  assert(htmlLanguage('<HTML LANG = "ja">', "ja"));
  assert(htmlLanguage('<html lang="ja"/>', "ja"));
  assert(!htmlLanguage('<html data-x="a lang=ja b" lang="en">', "ja"));
  assert(!htmlLanguage('<!-- <html lang="ja"> --><html lang="en">', "ja"));
  assert(!htmlLanguage('<html-page lang="ja"></html-page><html lang="en">', "ja"));
});
