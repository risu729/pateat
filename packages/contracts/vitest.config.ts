import { configDefaults, defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // CI's Verify job sets PATEAT_SKIP_ORDERS: its `Event orders` job runs the walks over
    // every order of events (`test:orders`) beside it.
    exclude: [
      ...configDefaults.exclude,
      ...(process.env["PATEAT_SKIP_ORDERS"] ? ["src/**/*.orders-*.test.ts"] : []),
    ],
    // Set by CI's Verify job; `mise run coverage:summary` reports the result.
    coverage: {
      enabled: Boolean(process.env["PATEAT_COVERAGE"]),
      include: ["src/**/*.{ts,tsx}"],
      exclude: ["**/*.test.{ts,tsx}", "**/*.d.ts", "**/__fixtures__/**", "**/vitest.*.ts"],
      reporter: ["json"],
      reportsDirectory: "../../coverage/contracts",
    },
  },
});
