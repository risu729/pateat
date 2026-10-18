import { describe, expect, it } from "vitest";
import { secureOrigin } from "./rp-id";

describe("secureOrigin (ADR 0050)", () => {
  it.each([
    ["https://login.example", true],
    ["http://localhost:8080", true],
    ["http://app.localhost", true],
    ["http://127.0.0.1:3847", true],
    ["http://[::1]:8080", true],
    ["http://router.example", false],
    ["http://192.168.1.1", false],
    ["http://127.example", false],
    ["ftp://files.example", false],
    ["not a url", false],
  ])("%s is %s", (origin, expected) => {
    expect(secureOrigin(origin)).toBe(expected);
  });
});
