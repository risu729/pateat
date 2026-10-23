import { describe, expect, it } from "vitest";
import { i18n } from "../i18n";
import {
  choiceReason,
  choiceResponseSchema,
  pickFailure,
  statusResponseSchema,
  switchRefusal,
  switchRefusalSchema,
  switchRequestSchema,
  switchResponseSchema,
  switchStatus,
} from "./choice-wire";
import * as v from "valibot";

const en = i18n.getFixedT("en");
const ja = i18n.getFixedT("ja");

describe("the popup's reason for asking (ADR 0021)", () => {
  it("names why the tab asks", () => {
    // The site did not accept this tab's last login (ADR 0021 D, 2026-10-13), or another
    // tab's of the origin, which shares the session.
    expect(choiceReason("rejected", 3, en)).toBe(
      "The site did not accept the last login in this tab",
    );
    expect(choiceReason("rejected-elsewhere", 2, en)).toBe(
      "The site did not accept the last login in another tab",
    );
    // A login that stopped after a submission, or a watched login that ended before it
    // signed in (ADR 0027), asks in this tab only.
    expect(choiceReason("stopped-login", 1, en)).toBe(
      "The last login on this site stopped in this tab",
    );
    // Two automatic logins of the site signed in within 10 minutes (ADR 0062).
    expect(choiceReason("relogin-limit", 1, en)).toBe(
      "Pateat logged in to this site twice in the last 10 minutes, so it waits for you to choose",
    );
    // An account picked without making it the default (ADR 0063).
    expect(choiceReason("one-time-pick", 2, en)).toBe(
      "You chose an account here without making it the default, so Pateat asks each time until an account is made the default",
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
      "Another tab's login to this site is running or did not succeed, so Pateat did not log in here. Close that tab or wait up to 10 minutes, then choose again.",
    );
    expect(pickFailure("no-choice", "Example", false, en)).toBe(
      "This page is no longer waiting for a choice",
    );
    expect(pickFailure("not-a-candidate", "Example", true, en)).toBe(
      "This page is no longer waiting for a choice. Example was not made the default.",
    );
  });

  it("counts the matches outside an ask, and names a paused site", () => {
    expect(choiceReason(undefined, 3, en)).toBe("3 accounts match this page");
    expect(choiceReason(undefined, 1, en)).toBe("1 account matches this page");
    expect(choiceReason("rejected", 3, en, true)).toBe("Automatic login is paused on this site");
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
    for (const ask of ["rejected", "rejected-elsewhere", "stopped-login", "relogin-limit"])
      expect(v.parse(choiceResponseSchema, { ...response, ask })).toMatchObject({ ask });
    expect(v.safeParse(choiceResponseSchema, { ...response, ask: true }).success).toBe(false);
    // A logout no longer makes a tab ask (ADR 0062).
    expect(v.safeParse(choiceResponseSchema, { ...response, ask: "this-tab" }).success).toBe(false);
  });
});

describe("the popup's account switch (ADR 0063)", () => {
  it("says why a switch did not start", () => {
    expect(switchRefusal("not-a-candidate", "taro@example.com", en)).toBe(
      "taro@example.com does not match this page.",
    );
    expect(switchRefusal("site-held", "Example", en)).toBe(
      "Another tab's login or account switch on this site is running or waits for a code. Finish or close it, then try again.",
    );
    // A paused site is no refusal: the switch is the person's pick.
    expect(switchRefusalSchema.options).not.toContain("paused");
    for (const reason of switchRefusalSchema.options)
      expect(switchRefusal(reason, "Example", en)).not.toBe("");
  });

  it("follows the switch from logging out to the login, or says why it stopped", () => {
    expect(switchStatus("running", undefined, "Example", en)).toBe(
      "Logging out to switch to Example…",
    );
    expect(switchStatus("signed-out", undefined, "Example", en)).toBe(
      "Logged out. Pateat logs in with Example on this site's login page in this tab",
    );
    expect(switchStatus("failed", "no-logout-control", "Example", en)).toBe(
      "Pateat found no way to log out on this page, so it did not switch to Example. Log out yourself, then choose the account",
    );
    expect(switchStatus("failed", "unsafe-control", "Example", en)).toBe(
      "The only control Pateat found to log out may also log out other devices or close the account, so it did not switch to Example. Log out yourself, then choose the account",
    );
    expect(switchStatus("failed", "interrupted", "Example", en)).toBe(
      "Pateat stopped while logging out, so it did not switch to Example. Check whether you are logged out, then choose the account",
    );
    expect(switchStatus("failed", "still-signed-in", "Example", en)).toBe(
      "The site still shows you logged in after 3 tries, so Pateat did not switch to Example. Log out yourself, then choose the account",
    );
    expect(switchStatus("failed", "service-unavailable", "Example", en)).toBe(
      "Pateat could not log out to switch to Example. Log out yourself, then choose the account",
    );
  });

  it("parses the switch's request, answer and status", () => {
    const request = {
      version: 1,
      type: "login.switch.start",
      tabId: 1,
      connectionId: "connection",
      itemId: "item",
      makeDefault: false,
    };
    expect(v.parse(switchRequestSchema, request)).toEqual(request);
    expect(v.safeParse(switchRequestSchema, { ...request, documentId: "d" }).success).toBe(false);
    expect(v.parse(switchResponseSchema, { ok: false, reason: "site-held" })).toEqual({
      ok: false,
      reason: "site-held",
    });
    expect(v.safeParse(switchResponseSchema, { ok: false, reason: "other" }).success).toBe(false);
    expect(v.safeParse(switchResponseSchema, { ok: false, reason: "paused" }).success).toBe(false);
    const status = {
      ok: true,
      origin: "https://login.example",
      recipe: "page",
      used: { connectionId: "connection", itemId: "item" },
      switch: { state: "failed", reason: "still-signed-in", connectionId: "c", itemId: "i" },
    };
    expect(v.parse(statusResponseSchema, status)).toEqual(status);
  });
});
