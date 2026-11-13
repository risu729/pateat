import { describe, expect, it } from "vitest";
import * as v from "valibot";
import { LOCAL_ONLY_FIELDS, problemEntrySchema } from "@pateat/contracts";
import { problemLine, type LogEntry } from "./log";

describe("page permission diagnostics transport boundary", () => {
  it.each(["login.start", "login.attempt", "login.exception", "login.refused"] as const)(
    "keeps local page policy metadata out of %s problem reports",
    (event) => {
      const entry: LogEntry = {
        time: 1_000,
        level: "warn",
        event,
        fields: {
          origin: "https://login.example",
          recipe: "synthetic",
          recipeRevision: 1,
          state: "blocked",
          reason: "page-off",
          permissionSource: "site",
          ...(event === "login.refused" ? {} : { fillMode: "sign-in-fill", fillExpired: true }),
        },
      };
      const original = structuredClone(entry);
      const line = problemLine(entry);
      expect(line).toBeDefined();
      expect(entry).toEqual(original);
      for (const field of LOCAL_ONLY_FIELDS[event]) expect(line?.fields).not.toHaveProperty(field);
      expect(v.is(problemEntrySchema, { seq: 1, ...line })).toBe(true);
    },
  );

  it("retains the existing local-only flag for every passive fill line, including warnings", () => {
    for (const event of ["login.start", "login.attempt", "login.exception"] as const) {
      expect(
        problemLine({
          time: 1_000,
          level: "warn",
          event,
          fields: {
            origin: "https://login.example",
            fillOnly: true,
            fillMode: "sign-in-fill",
            fillExpired: true,
            permissionSource: "site",
          },
        }),
      ).toBeUndefined();
    }
  });
});
