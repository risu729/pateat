import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
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

// The owner web UI is built into the Worker's static assets, all under /manage.
const assetsDirectory = join(workerDirectory, "assets");
const appFiles = await readdir(join(assetsDirectory, "manage", "assets"));
const appScripts = appFiles.filter((name) => name.endsWith(".js"));
assert.equal(appScripts.length, 1, "The web UI is one script bundle");
assert.ok(
  (await readFile(join(assetsDirectory, "manage", "index.html"), "utf8")).includes(
    `src="/manage/assets/${appScripts[0]}"`,
  ),
  "The app document loads the built script",
);
assert.match(
  await readFile(join(assetsDirectory, "manage", "assets", "licenses.md"), "utf8"),
  /react/,
);
assert.match(
  await readFile(join(assetsDirectory, "manage", "assets", "notices.md"), "utf8"),
  /shadcn/,
);
assert.equal(config.assets?.runWorkerFirst, true, "Assets must pass the Worker's Access check");

const runtime = new Miniflare({
  workers: [
    {
      config: {
        ...config,
        assets: { ...config.assets, directory: assetsDirectory, hasUserWorker: true },
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
  // Owner pages fail closed without Access settings, before fetching any keys.
  const manage = await runtime.dispatchFetch("https://pateat.invalid/manage", {
    headers: { "Cf-Access-Jwt-Assertion": "a.b.c" },
  });
  assert.equal(manage.status, 503);
  assert.equal(manage.headers.get("X-Frame-Options"), "DENY");
  // Built files are never served around that check.
  const assets = appFiles.map((name) => `/manage/assets/${name}`);
  const assetResponses = await Promise.all(
    assets.map((path) => runtime.dispatchFetch(`https://pateat.invalid${path}`)),
  );
  assert.deepEqual(
    assetResponses.map((asset) => asset.status),
    assets.map(() => 503),
  );
  const document = await runtime.dispatchFetch("https://pateat.invalid/manage/index.html");
  assert.equal(document.status, 404);
  console.log(`Production artifact smoke passed: pateat-api @ ${expectedRevision}`);
} finally {
  await runtime.dispose();
}
