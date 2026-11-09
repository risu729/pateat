import { describe, expect, it } from "vitest";
import { callClaude } from "../src/claude/calls";

describe("callClaude", () => {
  it("keeps a call that failed without a second rejection", async () => {
    const kept: Promise<unknown>[] = [];
    const failing = {
      prepare() {
        throw new Error("Failed query: params: owner-data");
      },
    } as unknown as D1Database;
    const call = { role: "generate" } as unknown as Parameters<typeof callClaude>[3];

    await expect(
      callClaude(
        { DB: failing },
        "owner-1",
        { startedAt: Date.now(), waitUntil: (p) => kept.push(p) },
        call,
      ),
    ).rejects.toThrow("Failed query");
    expect(kept).toHaveLength(1);
    await expect(kept[0]).resolves.toBeUndefined();
  });
});
