import type { Reporter, Suite, TestCase } from "@playwright/test/reporter";

type PreprocessParams = Parameters<NonNullable<Reporter["preprocess"]>>[0];

// Playwright keeps the tests under a `serial` or `default` mode suite in one worker; the
// reporter API does not expose the mode, so this reads the field the runner itself groups by.
function modeOf(suite: Suite): string {
  const mode: unknown = Reflect.get(suite, "_parallelMode");
  if (typeof mode !== "string") {
    throw new TypeError(
      "Playwright no longer exposes Suite._parallelMode; update shard-reporter.ts",
    );
  }
  return mode;
}

// The tests that must share a shard: the outermost `serial` or `default` suite, else the test.
function unitOf(test: TestCase): Suite | TestCase {
  let unit: Suite | TestCase = test;
  for (let suite: Suite | undefined = test.parent; suite; suite = suite.parent) {
    const mode = suite.type === "root" ? "none" : modeOf(suite);
    if (mode === "serial" || mode === "default") {
      unit = suite;
    }
  }
  return unit;
}

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
    const units = new Map<Suite | TestCase, number>();
    for (const test of suite.allTests()) {
      const unit = unitOf(test);
      let index = units.get(unit);
      if (index === undefined) {
        index = units.size;
        units.set(unit, index);
      }
      if (index % shard.total !== shard.current - 1) {
        testRun.exclude(test);
      }
    }
  }

  printsToStdio(): boolean {
    return false;
  }
}
