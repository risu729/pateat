import { configDefaults, defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // `*.browser.test.ts` suites need Chromium and run in Browser Mode
    // (`src/vitest.dom.config.ts`).
    exclude: [...configDefaults.exclude, "**/*.browser.test.ts"],
    // Set by CI's Verify job; `mise run coverage:summary` merges every area's result with
    // the Browser Mode suites'. Each test:<area> task names its own reports directory.
    coverage: {
      enabled: Boolean(process.env["PATEAT_COVERAGE"]),
      // TSX is measured by the Browser Mode suites, which compile it the way the build does.
      include: ["src/**/*.ts"],
      exclude: [
        "**/*.test.{ts,tsx}",
        "**/*.d.ts",
        "**/__fixtures__/**",
        "**/runtime-tests/**",
        "**/vitest.*.ts",
      ],
      reporter: ["json"],
      reportsDirectory: "../../coverage/extension",
    },
  },
});
