import { defineConfig } from "@playwright/test";

// CI splits the suite across jobs: PATEAT_E2E_SHARD=<current>/<total> runs one share.
const shardEnv = process.env["PATEAT_E2E_SHARD"];
const shardMatch = shardEnv === undefined ? null : /^([1-9]\d*)\/([1-9]\d*)$/.exec(shardEnv);
if (shardEnv !== undefined && (!shardMatch || Number(shardMatch[1]) > Number(shardMatch[2]))) {
  throw new Error(`PATEAT_E2E_SHARD must look like 2/4, got "${shardEnv}"`);
}

export default defineConfig({
  testDir: ".",
  testMatch: "*.spec.ts",
  // Every test starts its own browser profile and server, so shards can split the suite by
  // test instead of by file; the one worker still runs its tests one at a time.
  fullyParallel: true,
  workers: 1,
  shard: shardMatch ? { current: Number(shardMatch[1]), total: Number(shardMatch[2]) } : null,
  forbidOnly: Boolean(process.env["CI"]),
  retries: 0,
  // shard-reporter.ts replaces the built-in split of `shard` with a round-robin one.
  reporter: [["list"], ["./shard-reporter.ts"]],
  outputDir: "../../test-results/extension",
  timeout: 30_000,
});
