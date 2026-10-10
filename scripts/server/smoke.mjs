import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Miniflare } from "miniflare";

// Exercise the exact emitted bundle, independently of Vitest's source transforms.
const defaultProject = fileURLToPath(new URL("../../services/api/", import.meta.url));
const project = resolve(process.argv[2] ?? defaultProject);
const expectedRevision = process.argv[3] ?? process.env.PATEAT_REVISION ?? "development";
const output = join(project, ".cloudflare", "output", "v0");
const root = JSON.parse(await readFile(join(output, "config.json"), "utf8"));
assert.equal(
  root.buildContext?.mode,
  "production",
  "Only production output may pass release smoke",
);
assert.equal(root.buildContext?.isPreview, false, "Preview output is not a production release");

const workerDirectory = join(output, "workers", "default");
const config = JSON.parse(await readFile(join(workerDirectory, "worker.config.json"), "utf8"));
assert.equal(config.name, "pateat-api");
assert.equal(typeof config.manifest?.mainModule, "string");
assert.equal(Object.keys(config.manifest.modules).length, 0, "Review new non-JavaScript modules");
const bundleDirectory = join(workerDirectory, "bundle");
const scriptPath = resolve(bundleDirectory, config.manifest.mainModule);
const scriptRelativePath = relative(bundleDirectory, scriptPath);
assert.ok(
  scriptRelativePath && !scriptRelativePath.startsWith("..") && !isAbsolute(scriptRelativePath),
  "Worker entrypoint must stay inside the emitted bundle",
);

const runtime = new Miniflare({
  workers: [
    {
      config: {
        ...config,
        manifest: {
          mainModule: config.manifest.mainModule,
          modules: {
            [config.manifest.mainModule]: {
              type: "esm",
              contents: await readFile(scriptPath, "utf8"),
            },
          },
        },
      },
      dev: {
        outboundService: {
          type: "fetcher",
          handler() {
            throw new Error("The API Worker must not make outbound requests");
          },
        },
      },
    },
  ],
});

try {
  const health = await runtime.dispatchFetch("https://pateat.invalid/health");
  assert.equal(health.status, 200);
  assert.equal(health.headers.get("Cache-Control"), "no-store");
  assert.deepEqual(await health.json(), {
    status: "ok",
    service: "pateat-api",
    revision: expectedRevision,
  });

  const head = await runtime.dispatchFetch("https://pateat.invalid/health", { method: "HEAD" });
  assert.equal(head.status, 200);
  assert.equal(await head.text(), "");

  const mutation = await runtime.dispatchFetch("https://pateat.invalid/health", { method: "POST" });
  assert.equal(mutation.status, 405);
  assert.equal(mutation.headers.get("Allow"), "GET, HEAD");
  assert.deepEqual(await mutation.json(), { error: "method_not_allowed" });

  const missing = await runtime.dispatchFetch("https://pateat.invalid/recipes");
  assert.equal(missing.status, 404);
  assert.deepEqual(await missing.json(), { error: "not_found" });
  // Sync routes reject a missing device credential before any database access.
  const sync = await runtime.dispatchFetch("https://pateat.invalid/v1/settings");
  assert.equal(sync.status, 401);
  assert.equal(sync.headers.get("Access-Control-Allow-Origin"), null);
  assert.deepEqual(await sync.json(), { error: "unauthorized" });
  console.log(`Production artifact smoke passed: pateat-api @ ${expectedRevision}`);
} finally {
  await runtime.dispose();
}
