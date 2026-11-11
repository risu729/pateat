import * as v from "valibot";
import { describe, expect, it } from "vitest";
import { manageLoginHistoryQuerySchema, manageLoginHistorySchema } from "./manage-logins";

const ID = "00000000-0000-4000-8000-000000000001";

describe("login history contracts", () => {
  it("accepts an empty query and paired cursor boundaries", () => {
    expect(v.parse(manageLoginHistoryQuerySchema, {})).toEqual({});
    for (const beforeAt of ["0", "8640000000000000"]) {
      expect(v.parse(manageLoginHistoryQuerySchema, { beforeAt, beforeId: ID })).toEqual({
        beforeAt: Number(beforeAt),
        beforeId: ID,
      });
    }
    expect(
      v.parse(manageLoginHistoryQuerySchema, {
        origin: "http://localhost:8080",
        outcome: "timeout",
        beforeAt: "1",
        beforeId: ID,
      }),
    ).toEqual({ origin: "http://localhost:8080", outcome: "timeout", beforeAt: 1, beforeId: ID });
  });

  it.each([
    { beforeAt: "1" },
    { beforeId: ID },
    ...[
      "-1",
      "1.1",
      "1e3",
      " 1",
      "+1",
      "01",
      "",
      "NaN",
      "Infinity",
      "8640000000000001",
      "99999999999999999",
    ].map((beforeAt) => ({ beforeAt, beforeId: ID })),
    { beforeAt: 1, beforeId: ID },
    { beforeAt: "1", beforeId: "invalid" },
    { beforeAt: "1", beforeId: `${ID} ` },
    { limit: "100" },
    { ownerId: ID },
    { origin: "https://example.com/login" },
    { outcome: "success" },
  ])("rejects an invalid or over-broad query %j", (query) => {
    expect(v.safeParse(manageLoginHistoryQuerySchema, query).success).toBe(false);
  });

  it("refuses responses with raw data, oversized pages and malformed cursors", () => {
    const empty = { version: 1, entries: [], next: null };
    expect(v.parse(manageLoginHistorySchema, empty)).toEqual(empty);
    expect(v.safeParse(manageLoginHistorySchema, { ...empty, request: "private" }).success).toBe(
      false,
    );
    expect(
      v.safeParse(manageLoginHistorySchema, { ...empty, next: { at: -1, id: ID } }).success,
    ).toBe(false);
    const entry = {
      id: ID,
      at: 1,
      origin: "https://example.com",
      recipeId: "gen-synthetic",
      revision: 1,
      outcome: "authenticated",
      cause: null,
      extensionBuild: "development",
      totalMs: 100,
      personMs: 0,
      serviceMs: 0,
      networkMs: 0,
      pageMs: 0,
    };
    expect(v.safeParse(manageLoginHistorySchema, { ...empty, entries: [entry] }).success).toBe(
      true,
    );
    expect(
      v.safeParse(manageLoginHistorySchema, {
        ...empty,
        entries: [{ ...entry, account: "private" }],
      }).success,
    ).toBe(false);
    expect(
      v.safeParse(manageLoginHistorySchema, {
        ...empty,
        entries: Array.from({ length: 51 }, () => entry),
      }).success,
    ).toBe(false);
  });
});
