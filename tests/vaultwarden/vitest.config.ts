import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["*.test.ts"],
    // Each account derives PBKDF2 600000 several times in the SDK's WebAssembly.
    testTimeout: 60_000,
  },
});
