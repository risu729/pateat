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

  it("finds an address holding format characters", () => {
    // A zero-width space or soft hyphen marks a line-break opportunity, not a word break.
    expect
      .soft(shownAccounts("taro.yamada@\u200Bexample.com"))
      .toEqual(["taro.yamada@example.com"]);
    expect
      .soft(shownAccounts("taro.yamada@example\u00AD.com"))
      .toEqual(["taro.yamada@example.com"]);
    expect
      .soft(shownAccounts("taro\u200B.yamada@example.com"))
      .toEqual(["taro.yamada@example.com"]);
  });

  it("ignores masks without an identifier and short runs", () => {
    expect(shownAccounts("パスワード ******** を入力 *必須 ** 2026年 Rated 5***")).toEqual([]);
  });

  it("ignores addresses that continue a word or a URL", () => {
    expect(shownAccounts("tarōx@example.com https://user@example.com/")).toEqual([]);
    expect(shownAccounts("メール：my2@example.com")).toEqual(["my2@example.com"]);
  });

  it("stays fast on long runs of letters", () => {
    const started = performance.now();
    expect(shownAccounts("a".repeat(16_000))).toEqual([]);
    expect(performance.now() - started).toBeLessThan(100);
  });
});

describe("showsOtherAccount", () => {
  const password = { masked: true };
  const oneTimeCode = { masked: false };
  it("stops only when the shown identifiers of the username's kind all differ", () => {
    expect(showsOtherAccount(["myaccount@example.com"], "my2@example.com", password)).toBe(true);
    expect(showsOtherAccount(["my2@example.com"], "my2@example.com", password)).toBe(false);
    expect(showsOtherAccount(["MY2@Example.com"], "my2@example.com", password)).toBe(false);
    expect(showsOtherAccount([], "my2@example.com", password)).toBe(false);
    // A masked value consistent with the username cannot be told apart.
    expect(showsOtherAccount(["m***@example.com"], "my2@example.com", password)).toBe(false);
    expect(showsOtherAccount(["t***@example.com"], "my2@example.com", password)).toBe(true);
    expect(showsOtherAccount(["****1234"], "00001234", password)).toBe(false);
    expect(showsOtherAccount(["****9999"], "00001234", password)).toBe(true);
    // One fitting identifier is enough, as on a page listing a support address too.
    expect(
      showsOtherAccount(["help@example.com", "my2@example.com"], "my2@example.com", password),
    ).toBe(false);
    // Identifiers of another kind are not compared.
    expect(showsOtherAccount(["****9999"], "my2@example.com", password)).toBe(false);
    expect(showsOtherAccount(["help@example.com"], "00001234", password)).toBe(false);
    expect(showsOtherAccount(["myaccount@example.com"], "", password)).toBe(false);
  });

  it("compares masked IDs only with a digits-only username on a password step", () => {
    // A one-time-code page shows the masked phone number the code went to.
    expect(showsOtherAccount(["******5678"], "00001234", oneTimeCode)).toBe(false);
    expect(showsOtherAccount(["m***@example.com"], "taro@example.com", oneTimeCode)).toBe(true);
    // A login ID with letters is not an account number a page would mask.
    expect(showsOtherAccount(["****1234"], "taro99", password)).toBe(false);
    expect(showsOtherAccount(["****9999"], "0000-1234", password)).toBe(true);
  });

  it("matches many masks in linear time", () => {
    const shown = `${"a*".repeat(40)}@example.com`;
    const started = performance.now();
    expect(showsOtherAccount([shown], `${"ab".repeat(60)}@example.org`, password)).toBe(true);
    expect(performance.now() - started).toBeLessThan(100);
    expect(showsOtherAccount(["a*b*c@example.com"], "axxbyc@example.com", password)).toBe(false);
    expect(showsOtherAccount(["a*b*c@example.com"], "abc@example.com", password)).toBe(true);
  });

  it("treats a * in the username as a character", () => {
    expect(showsOtherAccount(["a***@example.com"], "ab*c@example.com", password)).toBe(false);
  });

  it("treats regular-expression characters in a shown value literally", () => {
    expect(showsOtherAccount(["a.b***@example.com"], "axb1@example.com", password)).toBe(true);
    expect(showsOtherAccount(["a.b***@example.com"], "a.b1@example.com", password)).toBe(false);
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

  it("separates text at every element boundary", () => {
    document.body.innerHTML = `<div><span>my2@example.com</span><a href="/switch">Not you?</a></div>
      <div><span style="display:inline-block">Email</span><span>me@example.com</span></div>`;
    expect(shownAccounts(accountText(document, null))).toEqual([
      "my2@example.com",
      "me@example.com",
    ]);
    document.body.innerHTML = `<p>Signed in as ****1234</p><label>Password<input type="password"></label>`;
    expect(shownAccounts(accountText(document, null))).toEqual(["****1234"]);
  });

  it("reads an address split by <wbr> or a format character as one address", () => {
    document.body.innerHTML = `<form><p>Signed in as taro.yamada@<wbr>example.com</p>
      <input type="password"></form>`;
    expect
      .soft(shownAccounts(accountText(document, document.forms[0]!)))
      .toEqual(["taro.yamada@example.com"]);
    document.body.innerHTML = `<form><p>Signed in as taro.yamada@&#8203;example.com</p>
      <input type="password"></form>`;
    expect
      .soft(shownAccounts(accountText(document, document.forms[0]!)))
      .toEqual(["taro.yamada@example.com"]);
  });

  it("skips contact addresses and bounds what it reads", () => {
    document.body.innerHTML = `<footer><h3>footer-heading@example.com</h3></footer>
      ${"<h3>x</h3>".repeat(8)}<h3>late@example.com</h3>
      <form><p>Contact <a href="MAILTO:support@example.com">support@example.com</a></p>
      <address>help@example.com</address><footer>footer@example.com</footer></form>`;
    expect(shownAccounts(accountText(document, document.forms[0]!))).toEqual([]);
    document.body.innerHTML = `<p>${"a".repeat(100_000)}</p>`;
    expect(accountText(document, null).length).toBeLessThanOrEqual(4000);
  });
});
