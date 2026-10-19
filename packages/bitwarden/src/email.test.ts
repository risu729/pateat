import { describe, expect, it } from "vitest";
import * as v from "valibot";
import { bitwardenEmail } from "./email";

const local64 = "a".repeat(64);
const label63 = "b".repeat(63);
// 64 + 1 + 63 + 1 + 63 + 1 + 61 = 254 characters.
const longest = `${local64}@${label63}.${label63}.${"c".repeat(61)}`;

describe("bitwardenEmail", () => {
  it.each([
    "user@example.com",
    "user+tag@example.co.jp",
    "first.last@example.com",
    "o'brien@example.com",
    "tom&jerry@example.com",
    "name@example.x",
    "user@localhost",
    "x@sub-domain.example.com",
    longest,
  ])("accepts %s like the official Bitwarden login", (email) => {
    expect(v.is(bitwardenEmail, email)).toBe(true);
  });

  it.each([
    "",
    "user",
    "@example.com",
    "user@",
    "a@@example.com",
    "first..last@example.com",
    ".first@example.com",
    "first.@example.com",
    "a b@example.com",
    " user@example.com",
    "user@example.com ",
    "user@example.com\n",
    '"quoted"@example.com',
    "名前@example.com",
    "user@例え.jp",
    "user@-example.com",
    "user@example-.com",
    "user@example.com.",
    "user@[127.0.0.1]",
    `${local64}a@example.com`,
    `user@${label63}b.com`,
    `${longest}c`,
  ])("refuses %j like the official Bitwarden login", (email) => {
    expect(v.is(bitwardenEmail, email)).toBe(false);
  });
});
