import { describe, expect, it } from "vitest";
import { createPseudonyms } from "./pseudonym";

// Runs in Chromium (vitest browser mode) for IndexedDB and WebCrypto.
describe("pseudonyms", () => {
  it("are stable across instances that share the stored key", async () => {
    const databaseName = `pseudonym-test-${crypto.randomUUID()}`;
    const first = createPseudonyms({ databaseName });
    // Concurrent first use stores one key.
    const [a, b] = await Promise.all([
      first("connection", "one", 6),
      createPseudonyms({ databaseName })("connection", "one", 6),
    ]);
    expect(a).toMatch(/^[0-9a-f]{6}$/u);
    expect(b).toBe(a);
    expect(await createPseudonyms({ databaseName })("connection", "one", 6)).toBe(a);
    expect(await first("connection", "two", 6)).not.toBe(a);
    expect(await first("item", "one", 6)).not.toBe(a);
  });

  it("differ under another key", async () => {
    const one = createPseudonyms({ databaseName: `pseudonym-test-${crypto.randomUUID()}` });
    const two = createPseudonyms({ databaseName: `pseudonym-test-${crypto.randomUUID()}` });
    const values = await Promise.all([one("connection", "x", 16), two("connection", "x", 16)]);
    expect(values[0]).not.toBe(values[1]);
  });
});
