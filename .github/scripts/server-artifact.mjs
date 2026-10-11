import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { cp, lstat, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

const buildPath = "services/api/.cloudflare/output/v0";
const migrationsPath = "services/api/migrations";
const releasePath = "work/server-release";
const databaseName = "pateat";
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;
export const migrationNamePattern = /^\d{4}_[a-z0-9_]+\.sql$/u;

async function toolVersions() {
  return {
    node: process.version,
    bun: execFileSync("bun", ["--version"], { encoding: "utf8" }).trim(),
    mise: execFileSync("mise", ["--version"], { encoding: "utf8" }).trim(),
    cf: JSON.parse(await readFile("node_modules/cf/package.json", "utf8")).version,
  };
}

export async function inventory(directory, prefix = "") {
  const entries = await readdir(resolve(directory, prefix), { withFileTypes: true });
  const groups = await Promise.all(
    entries
      .sort((a, b) => a.name.localeCompare(b.name, "en"))
      .map(async (entry) => {
        const name = prefix ? `${prefix}/${entry.name}` : entry.name;
        assert(!entry.isSymbolicLink(), `Symlinks are not release files: ${name}`);
        if (entry.isDirectory()) return inventory(directory, name);
        assert(entry.isFile(), `Unsupported release file: ${name}`);
        const contents = await readFile(resolve(directory, name));
        return [
          {
            path: name,
            bytes: contents.length,
            sha256: createHash("sha256").update(contents).digest("hex"),
          },
        ];
      }),
  );
  return groups.flat();
}

export function verifyProvenance(manifest, expected) {
  assert.equal(manifest.schema, 1);
  assert.equal(manifest.repository, expected.repository);
  assert.equal(manifest.revision, expected.revision);
  assert.match(manifest.revision, /^[0-9a-f]{40}$/u);
  assert.equal(manifest.runId, expected.runId);
  assert.equal(manifest.runAttempt, expected.runAttempt);
  assert.equal(manifest.workflow, "CI");
  assert.equal(manifest.event, "push");
  assert.equal(manifest.ref, "refs/heads/main");
  assert.equal(manifest.mode, "production");
  assert.equal(manifest.worker, "pateat-api");
  assert.equal(manifest.tools.node, process.version);
  assert(Array.isArray(manifest.files) && manifest.files.length > 0);
  assert(Array.isArray(manifest.migrations) && manifest.migrations.length > 0);
  assert(
    manifest.migrations.every(({ path }) => migrationNamePattern.test(path)),
    "Migrations are flat numbered SQL files",
  );
  assert.match(manifest.database ?? "", uuidPattern);
}

/** The SQL files cf applies by default: `<dir>/*.sql`, in numeric order. */
export async function copyMigrations(from, to) {
  await mkdir(to, { recursive: false });
  const names = (await readdir(from, { withFileTypes: true }))
    .filter((entry) => entry.isFile() && entry.name.endsWith(".sql"))
    .map((entry) => entry.name);
  assert(names.length > 0, "No migrations to release");
  await Promise.all(names.map((name) => cp(`${from}/${name}`, `${to}/${name}`)));
}

export async function verifyBuild(directory) {
  const config = JSON.parse(await readFile(`${directory}/config.json`, "utf8"));
  assert.equal(config.buildContext?.mode, "production");
  assert.equal(config.buildContext?.isPreview, false);
  const worker = JSON.parse(
    await readFile(`${directory}/workers/default/worker.config.json`, "utf8"),
  );
  assert.equal(worker.name, "pateat-api");
  // A D1 binding without an ID makes cf deploy provision a new database.
  assert.equal(worker.env?.DB?.type, "d1");
  assert.equal(worker.env.DB.name, databaseName);
  assert.match(worker.env.DB.id ?? "", uuidPattern, "Record the bootstrapped D1 database ID");
  return { database: worker.env.DB.id, domains: worker.domains ?? [] };
}

async function pack() {
  assert.equal(process.env.GITHUB_EVENT_NAME, "push");
  assert.equal(process.env.GITHUB_REF, "refs/heads/main");
  assert.equal(process.env.GITHUB_WORKFLOW, "CI");
  assert.equal(process.env.PATEAT_REVISION, process.env.GITHUB_SHA);
  // Never merge a previous output tree into a new release.
  await mkdir(resolve(releasePath, ".."), { recursive: true });
  await mkdir(releasePath, { recursive: false });
  await cp(buildPath, `${releasePath}/output`, { recursive: true, errorOnExist: true });
  const { database } = await verifyBuild(`${releasePath}/output`);
  await copyMigrations(migrationsPath, `${releasePath}/migrations`);
  const manifest = {
    schema: 1,
    repository: process.env.GITHUB_REPOSITORY,
    revision: process.env.GITHUB_SHA,
    runId: process.env.GITHUB_RUN_ID,
    runAttempt: process.env.GITHUB_RUN_ATTEMPT,
    workflow: process.env.GITHUB_WORKFLOW,
    event: process.env.GITHUB_EVENT_NAME,
    ref: process.env.GITHUB_REF,
    mode: "production",
    worker: "pateat-api",
    tools: await toolVersions(),
    files: await inventory(`${releasePath}/output`),
    database,
    migrations: await inventory(`${releasePath}/migrations`),
  };
  verifyProvenance(manifest, {
    repository: process.env.GITHUB_REPOSITORY,
    revision: process.env.GITHUB_SHA,
    runId: process.env.GITHUB_RUN_ID,
    runAttempt: process.env.GITHUB_RUN_ATTEMPT,
  });
  await writeFile(`${releasePath}/manifest.json`, `${JSON.stringify(manifest, null, 2)}\n`);
}

async function restore() {
  const manifest = JSON.parse(await readFile(`${releasePath}/manifest.json`, "utf8"));
  verifyProvenance(manifest, {
    repository: process.env.GITHUB_REPOSITORY,
    revision: process.env.RELEASE_REVISION,
    runId: process.env.RELEASE_RUN_ID,
    runAttempt: process.env.RELEASE_RUN_ATTEMPT,
  });
  assert.deepEqual(await toolVersions(), manifest.tools, "Deployment tool versions differ");
  assert.deepEqual(
    await inventory(`${releasePath}/output`),
    manifest.files,
    "Release file digests differ",
  );
  const { database, domains } = await verifyBuild(`${releasePath}/output`);
  assert.equal(database, manifest.database, "Release database differs from its build");
  assert.deepEqual(
    await inventory(`${releasePath}/migrations`),
    manifest.migrations,
    "Release migration digests differ",
  );
  // The checkout is the same revision; its migrations must be the released ones.
  assert.deepEqual(
    (await inventory(migrationsPath)).filter(({ path }) => /^[^/]+\.sql$/u.test(path)),
    manifest.migrations,
    "Migrations differ from source",
  );
  assert.match(
    process.env.CLOUDFLARE_ACCOUNT_ID ?? "",
    /^[0-9a-f]{32}$/u,
    "Configure the exact account ID",
  );
  assert.equal(process.env.SERVER_WORKER, manifest.worker, "Configure the exact Worker name");
  const healthUrl = new URL(process.env.SERVER_HEALTH_URL ?? "");
  assert.equal(healthUrl.protocol, "https:");
  assert.equal(healthUrl.pathname, "/health");
  assert.equal(healthUrl.username + healthUrl.password + healthUrl.search + healthUrl.hash, "");
  assert(domains.includes(healthUrl.host), "The health URL must use the Worker's Custom Domain");
  // A fresh checkout must have no pre-existing output or implicit rebuild.
  await assert.rejects(lstat(buildPath), { code: "ENOENT" });
  await mkdir(resolve(buildPath, ".."), { recursive: true });
  await cp(`${releasePath}/output`, buildPath, { recursive: true, errorOnExist: true });
  assert.deepEqual(await inventory(buildPath), manifest.files);
  if (process.env.GITHUB_OUTPUT)
    await writeFile(process.env.GITHUB_OUTPUT, `database=${manifest.database}\n`, { flag: "a" });
}

if (process.argv[1] && resolve(process.argv[1]) === import.meta.filename) {
  assert(["pack", "restore"].includes(process.argv[2]), "Expected pack or restore");
  await (process.argv[2] === "pack" ? pack() : restore());
}
