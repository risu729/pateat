import { afterEach, describe, expect, it } from "vitest";
import { accountText, showsOtherAccount, shownAccounts } from "./accounts";

afterEach(() => {
  document.body.innerHTML = "";
});

describe("shownAccounts", () => {
  it("finds plain and masked email addresses and masked IDs", () => {
    expect(shownAccounts("myaccount@example.com としてログイン")).toEqual([
      "myaccount@example.com",
    ]);
    expect(shownAccounts("Signed in as my2@example.com. Not you?")).toEqual(["my2@example.com"]);
    expect(shownAccounts("t***@gmail.com でログイン 口座番号 ****1234")).toEqual([
      "t***@gmail.com",
      "****1234",
    ]);
    expect(shownAccounts("ｍｙ２＠ｅｘａｍｐｌｅ．ｃｏｍ ●●●●5678 ab•••yz")).toEqual([
      "my2@example.com",
      "****5678",
      "ab***yz",
    ]);
  });

  it("ignores masks without an identifier and short runs", () => {
    expect(shownAccounts("パスワード ******** を入力 *必須 ** 2026年")).toEqual([]);
  });
});

describe("showsOtherAccount", () => {
  it("stops only when the shown identifiers of the username's kind all differ", () => {
    expect(showsOtherAccount(["myaccount@example.com"], "my2@example.com")).toBe(true);
    expect(showsOtherAccount(["my2@example.com"], "my2@example.com")).toBe(false);
    expect(showsOtherAccount(["MY2@Example.com"], "my2@example.com")).toBe(false);
    expect(showsOtherAccount([], "my2@example.com")).toBe(false);
    // A masked value consistent with the username cannot be told apart.
    expect(showsOtherAccount(["m***@example.com"], "my2@example.com")).toBe(false);
    expect(showsOtherAccount(["t***@example.com"], "my2@example.com")).toBe(true);
    expect(showsOtherAccount(["****1234"], "00001234")).toBe(false);
    expect(showsOtherAccount(["****9999"], "00001234")).toBe(true);
    // One fitting identifier is enough, as on a page listing a support address too.
    expect(showsOtherAccount(["help@example.com", "my2@example.com"], "my2@example.com")).toBe(
      false,
    );
    // Identifiers of another kind are not compared.
    expect(showsOtherAccount(["****9999"], "my2@example.com")).toBe(false);
    expect(showsOtherAccount(["help@example.com"], "00001234")).toBe(false);
    expect(showsOtherAccount(["myaccount@example.com"], "")).toBe(false);
  });

  it("treats regular-expression characters in a shown value literally", () => {
    expect(showsOtherAccount(["a.b***@example.com"], "axb1@example.com")).toBe(true);
    expect(showsOtherAccount(["a.b***@example.com"], "a.b1@example.com")).toBe(false);
  });
});

describe("accountText", () => {
  it("reads the login form's rendered text and headings, not input values or other forms", () => {
    document.body.innerHTML = `<h2>Welcome back</h2>
      <form id="other"><p>other@example.com</p></form>
      <form id="login"><p>my2@example.com</p><span hidden>hidden@example.com</span>
        <input value="typed@example.com"><input id="pw" type="password"></form>`;
    const form = document.getElementById("login") as HTMLFormElement;
    const text = accountText(document, form);
    expect(shownAccounts(text)).toEqual(["my2@example.com"]);
    expect(text).toContain("Welcome back");
    expect(shownAccounts(accountText(document, null))).toEqual([
      "other@example.com",
      "my2@example.com",
    ]);
  });

  it("keeps text after a block apart from the inline text that follows it", () => {
    document.body.innerHTML = `<p>Signed in as ****1234</p><label>Password<input type="password"></label>`;
    expect(shownAccounts(accountText(document, null))).toEqual(["****1234"]);
  });
});
