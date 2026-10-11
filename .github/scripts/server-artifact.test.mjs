import assert from "node:assert/strict";
import { mkdtemp, mkdir, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  copyMigrations,
  inventory,
  migrationNamePattern,
  verifyBuild,
  verifyProvenance,
} from "./server-artifact.mjs";

test("release provenance refuses a PR, a different revision, run, or attempt", () => {
  const expected = {
    repository: "owner/repo",
    revision: "a".repeat(40),
    runId: "123",
    runAttempt: "2",
  };
  const manifest = {
    schema: 1,
    ...expected,
    workflow: "CI",
    event: "push",
    ref: "refs/heads/main",
    mode: "production",
    worker: "pateat-api",
    tools: { node: process.version },
    files: [{}],
    database: "00000000-0000-4000-8000-000000000001",
    migrations: [{ path: "0000_init.sql" }],
  };
  verifyProvenance(manifest, expected);
  for (const [key, value] of Object.entries({
    event: "pull_request",
    revision: "b".repeat(40),
    runId: "124",
    runAttempt: "1",
    mode: "preview",
    database: "pateat",
    migrations: [],
  })) {
    assert.throws(() => verifyProvenance({ ...manifest, [key]: value }, expected));
  }
  assert.throws(() =>
    verifyProvenance({ ...manifest, migrations: [{ path: "meta/_journal.json" }] }, expected),
  );
});

test("committed migrations have names the release accepts", async () => {
  // Pack runs only on main; catch a name it would refuse in pull request CI.
  const names = (await readdir("services/api/migrations")).filter((name) => name.endsWith(".sql"));
  assert(names.length > 0);
  for (const name of names) assert.match(name, migrationNamePattern);
});

test("released migrations are the top-level SQL files only", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pateat-migrations-"));
  try {
    const source = join(directory, "source");
    await mkdir(join(source, "meta"), { recursive: true });
    await writeFile(join(source, "0000_init.sql"), "CREATE TABLE a (id TEXT);");
    await writeFile(join(source, "0001_next.sql"), "CREATE TABLE b (id TEXT);");
    await writeFile(join(source, "meta", "_journal.json"), "{}");
    await copyMigrations(source, join(directory, "release"));
    assert.deepEqual(
      (await inventory(join(directory, "release"))).map(({ path }) => path),
      ["0000_init.sql", "0001_next.sql"],
    );
    // Never merged into an earlier copy.
    await assert.rejects(copyMigrations(source, join(directory, "release")));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("release inventory detects changed bytes, extra files, and symlinks", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pateat-release-"));
  try {
    await mkdir(join(directory, "nested"));
    await writeFile(join(directory, "nested", "worker.js"), "original");
    const before = await inventory(directory);
    await writeFile(join(directory, "nested", "worker.js"), "modified");
    assert.notDeepEqual(await inventory(directory), before);
    await writeFile(join(directory, "extra"), "extra");
    assert.equal((await inventory(directory)).length, 2);
    if (process.platform !== "win32") {
      await symlink("extra", join(directory, "link"));
      await assert.rejects(inventory(directory), /Symlinks/u);
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("release output refuses preview mode and another Worker", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pateat-build-"));
  try {
    await mkdir(join(directory, "workers", "default"), { recursive: true });
    const configPath = join(directory, "config.json");
    const workerPath = join(directory, "workers", "default", "worker.config.json");
    await writeFile(
      configPath,
      JSON.stringify({ buildContext: { mode: "production", isPreview: false } }),
    );
    const database = "00000000-0000-4000-8000-000000000001";
    const worker = (env) => JSON.stringify({ name: "pateat-api", env });
    await writeFile(workerPath, worker({ DB: { type: "d1", name: "pateat", id: database } }));
    assert.deepEqual(await verifyBuild(directory), { database, domains: [] });
    // Without an ID, cf deploy would provision a new database.
    await writeFile(workerPath, worker({ DB: { type: "d1", name: "pateat" } }));
    await assert.rejects(verifyBuild(directory), /bootstrapped D1/u);
    await writeFile(workerPath, worker({ DB: { type: "d1", name: "other", id: database } }));
    await assert.rejects(verifyBuild(directory));
    await writeFile(workerPath, worker({ DB: { type: "d1", name: "pateat", id: database } }));
    await writeFile(
      configPath,
      JSON.stringify({ buildContext: { mode: "production", isPreview: true } }),
    );
    await assert.rejects(verifyBuild(directory));
    await writeFile(
      configPath,
      JSON.stringify({ buildContext: { mode: "production", isPreview: false } }),
    );
    await writeFile(workerPath, JSON.stringify({ name: "another-worker" }));
    await assert.rejects(verifyBuild(directory));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
