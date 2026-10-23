import { describe, expect, it } from "vitest";
import { i18n } from "../i18n";
import { choiceReason, choiceResponseSchema, pickFailure } from "./choice-wire";
import * as v from "valibot";

const en = i18n.getFixedT("en");
const ja = i18n.getFixedT("ja");

describe("the popup's reason for asking (ADR 0021)", () => {
  it("names why the tab asks after a logout", () => {
    expect(choiceReason("this-tab", 2, en)).toBe("You logged out of this site in this tab");
    expect(choiceReason("other-tab", 2, en)).toBe("You logged out of this site in another tab");
    // The site did not accept this tab's last login (ADR 0021 D, 2026-10-13).
    expect(choiceReason("rejected", 3, en)).toBe(
      "The site did not accept the last login in this tab",
    );
    // A login that stopped after a submission, or a watched login that ended before it
    // signed in (ADR 0027), asks in this tab only.
    expect(choiceReason("stopped-login", 1, en)).toBe(
      "The last login on this site stopped in this tab",
    );
  });

  it("says a failed pick saved no default when it was to be one (ADR 0021)", () => {
    expect(pickFailure("not-started", "taro@example.com", true, en)).toBe(
      "Pateat could not log in with taro@example.com on this page. taro@example.com was not made the default. Reload the page to choose again.",
    );
    expect(pickFailure("not-started", "taro@example.com", false, en)).toBe(
      "Pateat could not log in with taro@example.com on this page. Reload the page to choose again.",
    );
    expect(pickFailure("document-gone", "Example", true, en)).toBe(
      "The page changed, so nothing was started. Example was not made the default. Reload it to choose again.",
    );
    expect(pickFailure("origin-busy", "Example", false, en)).toBe(
      "Another tab's login to this site is running or did not succeed, so Pateat did not log in here. Close that tab or wait up to 5 minutes, then choose again.",
    );
    expect(pickFailure("no-choice", "Example", false, en)).toBe(
      "This page is no longer waiting for a choice",
    );
    expect(pickFailure("not-a-candidate", "Example", true, en)).toBe(
      "This page is no longer waiting for a choice. Example was not made the default.",
    );
  });

  it("counts the matches outside a logout", () => {
    expect(choiceReason(undefined, 3, en)).toBe("3 accounts match this page");
    expect(choiceReason(undefined, 1, en)).toBe("1 account matches this page");
  });

  it("says the same in Japanese, with the account name kept as written", () => {
    expect(choiceReason("rejected", 3, ja)).toBe(
      "このタブでの前回のログインはサイトに受け付けられませんでした",
    );
    expect(choiceReason(undefined, 3, ja)).toBe("3 件のアカウントがこのページに一致します");
    expect(pickFailure("document-gone", "<b>Example</b>", true, ja)).toBe(
      "ページが変わったため、ログインを開始しませんでした。<b>Example</b> は既定のアカウントになっていません。もう一度選ぶには、ページを再読み込みしてください。",
    );
    expect(pickFailure("no-choice", "Example", false, ja)).toBe(
      "このページはアカウントの選択を待っていません",
    );
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
