import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Set by CI's Verify job; `mise run coverage:summary` reports the result.
    coverage: {
      enabled: Boolean(process.env["PATEAT_COVERAGE"]),
      include: ["src/**/*.{ts,tsx}"],
      exclude: ["**/*.test.{ts,tsx}", "**/*.d.ts", "**/__fixtures__/**", "**/vitest.*.ts"],
      reporter: ["json"],
      reportsDirectory: "../../coverage/bitwarden",
    },
  },
});
