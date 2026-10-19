import { afterEach, describe, expect, it } from "vitest";
import { identifierInput } from "./identifier-field";

afterEach(() => {
  document.body.innerHTML = "";
});

const asks = (html: string) => {
  document.body.innerHTML = html;
  return identifierInput(document);
};

describe("identifierInput", () => {
  it("takes an email input by its type or autocomplete", () => {
    expect(asks('<form><input type="email" name="email"><button>Next</button></form>')).toBe(
      "sole",
    );
    // Beside another text input, as an email input is an identifier by its type.
    expect(asks('<input name="company"><input autocomplete="email" name="x">')).toBe("email");
  });

  it("takes the only text input when a word of it names an identifier", () => {
    // Grafana Cloud's first page, 2026-10-12.
    expect(asks('<label>Email or username<input type="text" name="login"></label>')).toBe("sole");
    expect(asks('<input name="loginId">')).toBe("sole");
    expect(asks('<input name="loginID">')).toBe("sole");
    expect(asks('<label for="f">ユーザー名</label><input id="f">')).toBe("sole");
    // Full-width letters fold first.
    expect(asks('<input placeholder="ｌｏｇｉｎ">')).toBe("sole");
    expect(asks('<input aria-label="E-mail">')).toBe("sole");
    expect(asks('<input id="account" autocomplete="off">')).toBe("sole");
  });

  it("leaves out search, newsletter and other fields", () => {
    expect(asks('<input type="search" name="email">')).toBeUndefined();
    expect(asks('<form role="search"><input name="user"></form>')).toBeUndefined();
    expect(asks('<input name="userSearch">')).toBeUndefined();
    expect(asks('<input type="email" name="newsletter-email">')).toBeUndefined();
    expect(asks('<label>メールマガジン登録<input type="email"></label>')).toBeUndefined();
    expect(asks('<input placeholder="Order ID">')).toBeUndefined();
    expect(asks('<input name="hidden-field">')).toBeUndefined();
    expect(asks('<input name="q">')).toBeUndefined();
  });

  it("needs the identifier input to be the only counted text input, unmarked and not for sign-up", () => {
    expect(asks('<input name="login"><input name="company">')).toBeUndefined();
    expect(asks('<input name="login" autocomplete="given-name">')).toBeUndefined();
    expect(asks('<input name="login" readonly>')).toBeUndefined();
    expect(asks('<input name="login" style="display: none">')).toBeUndefined();
    expect(
      asks('<form><input type="email"><input type="password" autocomplete="new-password"></form>'),
    ).toBeUndefined();
    // A search box or a field with an excluded word beside it is not counted.
    expect(asks('<input type="search" name="q"><input name="login">')).toBe("sole");
    expect(asks('<input name="login"><input name="zip">')).toBe("sole");
  });

  it("takes no identifier input whose content `content-visibility` skips", () => {
    expect(
      asks('<details><summary>Sign in</summary><input type="email" name="email"></details>'),
    ).toBeUndefined();
    expect(
      asks('<div hidden="until-found"><input type="email" name="email"></div>'),
    ).toBeUndefined();
    expect(
      asks('<div style="content-visibility: hidden"><input type="email" name="email"></div>'),
    ).toBeUndefined();
    expect(
      asks('<details open><summary>Sign in</summary><input type="email" name="email"></details>'),
    ).toBe("sole");
  });

  // Chromium's `autocomplete` property reads "" for a token list that is not a valid
  // autofill detail, so the rule reads the attribute's tokens.
  it("takes an email input among several autocomplete tokens", () => {
    expect(asks('<input name="company"><input autocomplete="username email" name="x">')).toBe(
      "email",
    );
  });

  it("leaves out an input marked for something else among several tokens", () => {
    expect(asks('<input name="login" autocomplete="off given-name">')).toBeUndefined();
  });

  it.each(["chrome-off", "false"])(
    "takes the sole input whose autocomplete %s names no autofill field",
    (value) => {
      expect(asks(`<input name="login" autocomplete="${value}">`)).toBe("sole");
    },
  );

  it("leaves out a sign-up form whose new password has several tokens", () => {
    expect(
      asks(
        '<form><input type="email"><input type="password" autocomplete="off new-password"></form>',
      ),
    ).toBeUndefined();
  });
});
