import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { inventory, verifyBuild, verifyProvenance } from "./server-artifact.mjs";

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
  };
  verifyProvenance(manifest, expected);
  for (const [key, value] of Object.entries({
    event: "pull_request",
    revision: "b".repeat(40),
    runId: "124",
    runAttempt: "1",
    mode: "preview",
  })) {
    assert.throws(() => verifyProvenance({ ...manifest, [key]: value }, expected));
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
    await writeFile(workerPath, JSON.stringify({ name: "pateat-api" }));
    await verifyBuild(directory);
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
