import { describe, expect, it } from "vitest";
import { isValidEmail, valueMismatch } from "./values";

describe("valueMismatch", () => {
  it("applies the browser's length, email and number rules", () => {
    expect(valueMismatch({ type: "text" }, undefined)).toBe("missing-value");
    expect(valueMismatch({ type: "password" }, "")).toBe("missing-value");
    expect(valueMismatch({ type: "text", maxLength: 3 }, "123")).toBeUndefined();
    expect(valueMismatch({ type: "text", maxLength: 3 }, "1234")).toBe("too-long");
    // Lengths count UTF-16 code units, as the browser does.
    expect(valueMismatch({ type: "text", maxLength: 1 }, "𠮷")).toBe("too-long");
    expect(valueMismatch({ type: "tel", minLength: 6 }, "12345")).toBe("too-short");
    expect(valueMismatch({ type: "number", maxLength: 3, minLength: 3 }, "12345")).toBeUndefined();
    expect(valueMismatch({ type: "number" }, "1.")).toBe("not-number");
    expect(valueMismatch({ type: "email" }, "sato-7")).toBe("not-email");
    expect(valueMismatch({ type: "email" }, "user@shop.example.test")).toBeUndefined();
    expect(isValidEmail("a@b")).toBe(true);
  });
});
