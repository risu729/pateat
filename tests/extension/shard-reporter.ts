import type { Reporter } from "@playwright/test/reporter";

type PreprocessParams = Parameters<NonNullable<Reporter["preprocess"]>>[0];

// Deals the tests out in turn (1st to shard 1, 2nd to shard 2, ...) instead of Playwright's
// contiguous ranges, which put all of a slow file in one shard: on 2026-10-22 shard 2 held
// all 21 login-generation tests and ran 4.3 minutes while shard 1 ran 1.1.
export default class RoundRobinShards implements Reporter {
  async preprocess({ config, suite, testRun }: PreprocessParams): Promise<void> {
    const { shard } = config;
    if (!shard) {
      return;
    }
    testRun.skipSharding();
    // The suite always holds every test in the same order, so the shards split it exactly.
    for (const [index, test] of suite.allTests().entries()) {
      if (index % shard.total !== shard.current - 1) {
        testRun.exclude(test);
      }
    }
  }

  printsToStdio(): boolean {
    return false;
  }
}
