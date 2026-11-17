import { afterEach, describe, expect, it } from "vitest";
import {
  accountText,
  formAccounts,
  showsOtherAccount,
  shownAccounts,
  shownPasskeyAccount,
} from "./accounts";

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

describe("formAccounts", () => {
  it("adds the address a form keeps in a hidden or read-only identifier input, never a typed one", () => {
    document.body.innerHTML = `<form id="login"><h2>Welcome back</h2>
        <input type="hidden" name="email" value="kept@example.com">
        <input type="text" id="username" readonly value="shown@example.com">
        <input type="hidden" name="csrf" value="token@example.com">
        <input type="text" name="email-typed" value="typed@example.com">
        <input type="password" name="password" value="secret@example.com"></form>`;
    const form = document.getElementById("login") as HTMLFormElement;
    expect(formAccounts(document, form)).toEqual(["kept@example.com", "shown@example.com"]);
    // Such an address of another account stops a fill for the account (ADR 0049).
    expect(
      showsOtherAccount(formAccounts(document, form), "me@example.com", { masked: false }),
    ).toBe(true);
  });

  it("compares a member number shown read-only on a sign-in again with a digits username (#1676)", () => {
    // JAL's member re-login (2026-11-17): the number of the account signed in shows
    // read-only above the password, which a login fills alone.
    const page = (shown: string, attributes = `autocomplete="username" readonly`) => {
      document.body.innerHTML = `<form id="login"><label for="n">JMB会員番号</label>
        <input type="text" id="n" ${attributes} value="${shown}">
        <input type="password" id="p" autocomplete="current-password"></form>`;
      return formAccounts(document, document.getElementById("login") as HTMLFormElement);
    };
    const password = { masked: true };
    // Another account's number stops the password fill for this one.
    expect(page("1234567890")).toEqual(["1234567890"]);
    expect(showsOtherAccount(page("1234567890"), "9876543210", password)).toBe(true);
    // The account's own number, written with spaces or hyphens on either side, does not.
    expect(showsOtherAccount(page("1234567890"), "1234567890", password)).toBe(false);
    expect(showsOtherAccount(page("1234 5678 90"), "1234567890", password)).toBe(false);
    expect(showsOtherAccount(page("1234567890"), "1234-5678-90", password)).toBe(false);
    // Only on a password step, and never for an email or a letters username.
    expect(showsOtherAccount(page("1234567890"), "9876543210", { masked: false })).toBe(false);
    expect(showsOtherAccount(page("1234567890"), "me@example.com", password)).toBe(false);
    expect(showsOtherAccount(page("1234567890"), "taro99", password)).toBe(false);
    // A number in a hidden input, as a site's own user ID, or one not marked `username`, or
    // a value that is no number, adds nothing.
    expect(page("1234567890", `name="userId" readonly hidden`)).toEqual([]);
    document.body.innerHTML = `<form id="login"><input type="hidden" name="userId" value="1234567890">
      <input type="password" id="p"></form>`;
    expect(formAccounts(document, document.getElementById("login") as HTMLFormElement)).toEqual([]);
    expect(page("1234567890", `name="account" readonly`)).toEqual([]);
    expect(page("taro99")).toEqual([]);
    expect(page("123")).toEqual([]);
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

describe("shownPasskeyAccount (ADR 0028 amendment of 2026-11-17)", () => {
  const read = (html: string, focus?: string) => {
    document.body.innerHTML = html;
    if (focus) document.getElementById(focus)!.focus();
    return shownPasskeyAccount(document);
  };

  it("reads the one unmasked address of the clicked control's form and the headings", () => {
    expect(
      read(
        `<form><p>Signed in as <b>A@Example.com</b></p><button id="key">Passkey</button></form>
        <form><p>other@example.com</p></form>`,
        "key",
      ),
    ).toBe("A@Example.com");
    expect(read(`<h1>Welcome, a@example.com</h1><button id="key">Passkey</button>`, "key")).toBe(
      "a@example.com",
    );
    // The same address twice is one account.
    expect(read(`<h2>a@example.com</h2><form><p>A@EXAMPLE.COM</p></form>`)).toBe("a@example.com");
  });

  it("reads none for a masked address, two addresses or nothing shown yet", () => {
    expect(read(`<form><p>a***@example.com</p><button>Passkey</button></form>`)).toBeUndefined();
    expect(read(`<h1>a@example.com</h1><form><p>b@example.com</p></form>`)).toBeUndefined();
    expect(read(`<h1>a@example.com</h1><form><p>a***@example.com</p></form>`)).toBeUndefined();
    expect(read(`<form><p>Choose a method</p><button>Passkey</button></form>`)).toBeUndefined();
  });

  it("never reads the header, navigation, a live region, an output, a frame or an input value", () => {
    expect(
      read(`<header><h1>me@example.com</h1></header><nav><form><p>me@example.com</p></form></nav>
        <div role="banner"><h2>me@example.com</h2></div><h1>Choose a method</h1>`),
    ).toBeUndefined();
    expect(
      read(`<form><p aria-live="polite">me@example.com</p><output>me@example.com</output>
        <iframe srcdoc="<p>me@example.com</p>"></iframe>
        <input type="hidden" name="email" value="me@example.com"><button>Passkey</button></form>`),
    ).toBeUndefined();
  });

  it("reads nothing while the page shows a field the person types in, outside its header", () => {
    expect(
      read(`<form><h1>me@example.com</h1><input type="email"><button>Passkey</button></form>`),
    ).toBeUndefined();
    expect(read(`<h1>me@example.com</h1><div contenteditable>notes</div>`)).toBeUndefined();
    // A search box in the header, or a read-only identifier field, does not count.
    expect(
      read(`<header><input type="search"></header>
        <form><h1>me@example.com</h1><input type="email" readonly><button>Passkey</button></form>`),
    ).toBe("me@example.com");
  });

  it("reads no form when several show and none holds the focus", () => {
    expect(read(`<form><p>a@example.com</p></form><form><p>Other</p></form>`)).toBeUndefined();
  });
});
