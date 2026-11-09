import { describe, expect, it } from "vitest";
import { unhandledError } from "../src/error-log";

class StoreError extends Error {}

describe("unhandledError", () => {
  it("keeps the class name and frames, never the message", () => {
    const thrown = new StoreError(
      "Failed query: select 1\nparams: secret-value\n    at secret-frame",
    );
    const logged = unhandledError(thrown);
    expect(logged.name).toBe("StoreError");
    expect(logged.message).toBe("Unhandled API error");
    const lines = logged.stack?.split("\n") ?? [];
    expect(lines[0]).toBe("StoreError: Unhandled API error");
    expect(lines.length).toBeGreaterThan(1);
    expect(lines.slice(1).every((line) => /^\s+at /u.test(line))).toBe(true);
    expect(logged.stack).not.toContain("secret");
  });

  it("drops every frame of a stack that does not start with its own header", () => {
    const thrown = new Error("value");
    thrown.stack = "Error: other value\n    at somewhere (index.js:1:1)";
    expect(unhandledError(thrown).stack).toBe("Error: Unhandled API error");
  });

  it("names a thrown value that is not an error as unknown", () => {
    expect(unhandledError("secret").stack).toBe("unknown: Unhandled API error");
  });
});
