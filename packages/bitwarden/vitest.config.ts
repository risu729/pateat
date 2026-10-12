import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // The real SDK's key derivation and corruption sweeps take seconds each, and on a loaded
    // CI runner they have run past Vitest's 5 s default.
    testTimeout: 30_000,
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
