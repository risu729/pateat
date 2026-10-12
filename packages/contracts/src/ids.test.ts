import { describe, expect, it } from "vitest";
import { newId } from "./ids";

describe("newId", () => {
  it("creates RFC 9562 UUIDv7 values", () => {
    expect(newId()).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u,
    );
  });

  it("orders IDs by creation, also within one millisecond", () => {
    const ids = Array.from({ length: 1000 }, newId);
    expect(new Set(ids).size).toBe(ids.length);
    expect([...ids].sort()).toEqual(ids);
  });

  it("starts with the creation time in milliseconds", () => {
    const before = Date.now();
    const id = newId();
    const after = Date.now();
    const time = Number.parseInt(id.replaceAll("-", "").slice(0, 12), 16);
    expect(time).toBeGreaterThanOrEqual(before);
    expect(time).toBeLessThanOrEqual(after);
  });
});
