import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import test from "node:test";
import { verifyDocsBuild, verifyDocsProvenance } from "./docs-artifact.mjs";

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

test("docs output refuses executable Workers, bindings, wrong routes and preview output", async () => {
  const directory = await mkdtemp(resolve(tmpdir(), "pateat-docs-output-"));
  try {
    await mkdir(resolve(directory, "workers/default"), { recursive: true });
    const config = { buildContext: { mode: "production", isPreview: false } };
    const worker = {
      name: "pateat-docs",
      assets: { basePath: "/docs", notFoundHandling: "404-page" },
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
    for (const changed of [
      { entrypoint: "index.js" },
      { env: { API: { type: "service" } } },
      { triggers: [{ pattern: "pateat.takuk.me/*", zone: "takuk.me" }] },
      { assets: { basePath: "/", notFoundHandling: "single-page-application" } },
      { previewUrls: true },
    ]) {
      // These cases intentionally mutate the same build directory in sequence.
      // eslint-disable-next-line no-await-in-loop
      await put({ ...worker, ...changed });
      // eslint-disable-next-line no-await-in-loop
      await assert.rejects(verifyDocsBuild(directory));
    }
    await put(worker);
    await writeFile(
      resolve(directory, "config.json"),
      JSON.stringify({ buildContext: { mode: "production", isPreview: true } }),
    );
    await assert.rejects(verifyDocsBuild(directory));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
