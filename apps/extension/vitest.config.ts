import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Set by CI's Verify job; `mise run coverage:summary` merges every area's result with
    // the Browser Mode suites'. Each test:<area> task names its own reports directory.
    coverage: {
      enabled: Boolean(process.env["PATEAT_COVERAGE"]),
      // TSX is measured by the Browser Mode suites, which compile it the way the build does.
      include: ["src/**/*.ts"],
      exclude: ["**/*.test.{ts,tsx}", "**/*.d.ts", "**/__fixtures__/**", "**/vitest.*.ts"],
      reporter: ["json"],
      reportsDirectory: "../../coverage/extension",
    },
  },
});
