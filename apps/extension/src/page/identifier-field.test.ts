import { afterEach, describe, expect, it } from "vitest";
import { showsIdentifierOnly } from "./identifier-field";

afterEach(() => {
  document.body.innerHTML = "";
});

const shows = (html: string) => {
  document.body.innerHTML = html;
  return showsIdentifierOnly(document);
};

describe("showsIdentifierOnly", () => {
  it("takes an email input by its type or autocomplete", () => {
    expect(shows('<form><input type="email" name="email"><button>Next</button></form>')).toBe(true);
    // Beside another text input, as an email input is an identifier by its type.
    expect(shows('<input name="company"><input autocomplete="email" name="x">')).toBe(true);
  });

  it("takes the only text input when a word of it names an identifier", () => {
    // Grafana Cloud's first page, 2026-10-12.
    expect(shows('<label>Email or username<input type="text" name="login"></label>')).toBe(true);
    expect(shows('<input name="loginId">')).toBe(true);
    expect(shows('<input placeholder="ログインＩＤ">')).toBe(true);
    expect(shows('<input aria-label="E-mail">')).toBe(true);
    expect(shows('<input id="account" autocomplete="off">')).toBe(true);
  });

  it("leaves out search, newsletter and other fields", () => {
    expect(shows('<input type="search" name="email">')).toBe(false);
    expect(shows('<form role="search"><input name="user"></form>')).toBe(false);
    expect(shows('<input name="userSearch">')).toBe(false);
    expect(shows('<input type="email" name="newsletter-email">')).toBe(false);
    expect(shows('<label>メールマガジン登録<input type="email"></label>')).toBe(false);
    expect(shows('<input placeholder="Order ID">')).toBe(false);
    expect(shows('<input name="hidden-field">')).toBe(false);
    expect(shows('<input name="q">')).toBe(false);
  });

  it("needs the identifier input to be the only text input, unmarked and not for sign-up", () => {
    expect(shows('<input name="login"><input name="company">')).toBe(false);
    expect(shows('<input name="login" autocomplete="given-name">')).toBe(false);
    expect(shows('<input name="login" readonly>')).toBe(false);
    expect(shows('<input name="login" style="display: none">')).toBe(false);
    expect(
      shows('<form><input type="email"><input type="password" autocomplete="new-password"></form>'),
    ).toBe(false);
    // A search box beside it does not hide it.
    expect(shows('<input type="search" name="q"><input name="login">')).toBe(true);
  });
});
