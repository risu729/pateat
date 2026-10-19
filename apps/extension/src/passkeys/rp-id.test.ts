import { describe, expect, it } from "vitest";
import { passkeyOrigin, passkeyScriptsRun, secureOrigin } from "./rp-id";

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

describe("passkeyOrigin (ADR 0050)", () => {
  it.each([
    ["https://login.example", true],
    ["http://localhost", true],
    ["http://localhost:8080", true],
    ["http://app.localhost", false],
    ["http://127.0.0.1:3847", false],
    ["http://[::1]:8080", false],
    ["http://router.example", false],
    ["not a url", false],
  ])("%s is %s", (origin, expected) => {
    expect(passkeyOrigin(origin)).toBe(expected);
  });
});

describe("passkeyScriptsRun (ADR 0050)", () => {
  it.each([
    ["https://login.example", false, true],
    ["http://localhost:8080", false, true],
    ["http://app.localhost", false, false],
    ["http://127.0.0.1:3847", false, false],
    ["http://127.0.0.1:3847", true, true],
    ["http://router.example", true, false],
    ["not a url", true, false],
  ])("%s with probe %s is %s", (origin, probe, expected) => {
    expect(passkeyScriptsRun(origin, probe)).toBe(expected);
  });
});
