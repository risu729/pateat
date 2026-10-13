import { describe, expect, it } from "vitest";
import { choiceReason, choiceResponseSchema } from "./choice-wire";
import * as v from "valibot";

describe("the popup's reason for asking (ADR 0021)", () => {
  it("names why the tab asks after a logout", () => {
    expect(choiceReason("this-tab", 2)).toBe("You logged out of this site in this tab");
    expect(choiceReason("other-tab", 2)).toBe("You logged out of this site in another tab");
    // The site did not accept this tab's last login (ADR 0021 D, 2026-10-13).
    expect(choiceReason("rejected", 3)).toBe("The site did not accept the last login in this tab");
    // A login that stopped after a submission, or a watched login that ended before it
    // signed in (ADR 0027), asks in this tab only.
    expect(choiceReason("stopped-login", 1)).toBe(
      "The last login on this site stopped in this tab",
    );
  });

  it("counts the matches outside a logout", () => {
    expect(choiceReason(undefined, 3)).toBe("3 accounts match this page");
  });

  it("carries the reason in the choice response", () => {
    const response = {
      ok: true,
      origin: "https://login.example",
      documentId: "synthetic-document",
      candidates: [{ connectionId: "connection", itemId: "item" }],
    };
    for (const logout of ["this-tab", "rejected", "other-tab", "stopped-login"])
      expect(v.parse(choiceResponseSchema, { ...response, logout })).toMatchObject({ logout });
    expect(v.safeParse(choiceResponseSchema, { ...response, logout: true }).success).toBe(false);
  });
});
