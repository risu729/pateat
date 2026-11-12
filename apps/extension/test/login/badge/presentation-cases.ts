import { expect, it, onTestFinished, vi } from "vitest";
import { i18n } from "../../../src/i18n";
import {
  BUSY_FRAMES,
  BUSY_FRAME_MS,
  BUSY_LIMIT_MS,
  NOTICE_MS,
  PAUSED_TEXT,
} from "../../../src/login/badge";
import { localClock } from "../../../src/time";
import type { PresentationContext } from "./context";

export function registerPresentationCases({
  harness,
  attempt,
  start,
  origin,
  tabId,
  NONE,
  choose,
  CHOICE,
  BUSY,
  FAILED,
  SUCCEEDED,
  UNSETTLED,
}: PresentationContext) {
  it("writes its tooltips in the extension's language, again when it changes (ADR 0043)", async () => {
    const h = harness();
    h.badge.choice(tabId, { count: 2 });
    h.badge.note(
      8,
      "Pateat: another tab's login to this site is running or did not succeed. Close that tab, or wait up to 10 minutes and reload this page, to log in here.",
    );
    await h.flush();
    expect(h.view()).toMatchObject({ text: "2", title: choose(2) });
    await i18n.changeLanguage("ja");
    onTestFinished(async () => {
      await i18n.changeLanguage("en");
    });
    h.badge.relabel();
    await h.flush();
    expect(h.view()).toMatchObject({
      text: "2",
      title: "Pateat：2 件のアカウントがこのページに一致します。クリックして選んでください。",
    });
    expect(h.view(8).title).toBe(
      "Pateat：別のタブでこのサイトへのログインが進行中か、成功していません。ここでログインするには、そのタブを閉じるか、最大 10 分待ってからこのページを再読み込みしてください。",
    );
    // An outcome code stays as the log names it inside the translated text.
    h.badge.choice(tabId, undefined);
    h.badge.observe(attempt({ outcome: "credential-rejected" }));
    await h.flush();
    expect(h.view().title).toBe(
      "Pateat：ログインに成功しませんでした（credential-rejected）。詳しくはクリックしてください。",
    );
  });

  it("shows the waiting account choice over a spin, a spin over a result, and a note otherwise", async () => {
    const h = harness();
    h.badge.note(tabId, "Pateat: held.");
    await h.flush();
    expect(h.view()).toMatchObject({ text: "", title: "Pateat: held." });

    h.badge.observe(attempt({ outcome: "credential-rejected" }));
    await h.flush();
    expect(h.view()).toMatchObject(FAILED);
    expect(h.view().title).toContain("credential-rejected");

    const stop = h.badge.spin(tabId);
    await h.flush();
    expect(h.view()).toMatchObject({ text: BUSY_FRAMES[0], ...BUSY });

    h.badge.choice(tabId, { count: 3, ask: "stopped-login" });
    await h.flush();
    expect(h.view()).toEqual({
      text: "3",
      ...CHOICE,
      title: "Pateat: the last login on this site stopped in this tab. Click to choose an account.",
    });
    // After a pick that did not make its account the default (ADR 0063).
    h.badge.choice(tabId, { count: 2, ask: "one-time-pick" });
    await h.flush();
    expect(h.view().title).toBe(
      "Pateat: you chose an account here without making it the default, so Pateat asks until an account is made the default. Click to choose an account.",
    );

    h.badge.choice(tabId, undefined);
    await h.flush();
    expect(h.view()).toMatchObject({ text: BUSY_FRAMES[0], ...BUSY });

    stop();
    await h.flush();
    // A failure stays.
    await vi.advanceTimersByTimeAsync(60_000);
    expect(h.view()).toMatchObject(FAILED);

    h.badge.observe(start());
    await h.flush();
    expect(h.view()).toMatchObject({ text: "", title: "Pateat: held." });
    h.badge.note(tabId, undefined);
    await h.flush();
    expect(h.view()).toMatchObject(NONE);
  });

  it("shows a paused site's gray II until the pause ends, under a waiting choice (ADR 0062)", async () => {
    const h = harness();
    const until = Date.now() + 60 * 60_000;
    const PAUSED = {
      text: PAUSED_TEXT,
      color: "#6b7280",
      textColor: "#ffffff",
      title: `Pateat: automatic login is paused on this site until ${localClock(until)}.`,
    };
    h.badge.observe(attempt({ outcome: "credential-rejected" }));
    h.badge.paused(tabId, { until });
    await h.flush();
    // A pause shows over a result, and a waiting choice's amber count over a pause.
    expect(h.view()).toEqual(PAUSED);
    h.badge.choice(tabId, { count: 1, paused: true });
    await h.flush();
    expect(h.view()).toEqual({
      text: "1",
      ...CHOICE,
      title: "Pateat: automatic login is paused on this site. Click to choose an account.",
    });
    h.badge.choice(tabId, undefined);
    await h.flush();
    expect(h.view()).toEqual(PAUSED);
    // Another tab of the site shows it too; the pause ends by itself.
    h.badge.paused(8, { until });
    await vi.advanceTimersByTimeAsync(60 * 60_000 - 1);
    expect(h.view(8)).toMatchObject({ text: PAUSED_TEXT });
    await vi.advanceTimersByTimeAsync(1);
    expect(h.view()).toMatchObject(FAILED);
    expect(h.view(8)).toMatchObject({ text: "" });
  });

  it("drops a pause when the tab loads another site, or when it is resumed (ADR 0062)", async () => {
    const h = harness();
    const until = Date.now() + 60_000;
    h.badge.loaded(tabId, `${origin}/signin`);
    h.badge.paused(tabId, { until });
    await h.flush();
    expect(h.view()).toMatchObject({ text: PAUSED_TEXT });
    // Another origin of the same registrable site keeps the pause, through any redraw.
    h.badge.loaded(tabId, `https://www.${new URL(origin).host}/account`);
    h.badge.note(tabId, "Pateat: held.");
    await h.flush();
    expect(h.view()).toMatchObject({ text: PAUSED_TEXT });
    h.badge.note(tabId, undefined);
    // Chrome resets the badge for another site's page; the runtime sets that site's pause,
    // if any, once it read it, so nothing draws the old one back meanwhile.
    h.badge.loaded(tabId, "https://other.example/");
    h.badge.note(tabId, "Pateat: held.");
    await h.flush();
    expect(h.view()).toMatchObject({ text: "", title: "Pateat: held." });
    h.badge.note(tabId, undefined);
    h.badge.paused(tabId, { until });
    await h.flush();
    expect(h.view()).toMatchObject({ text: PAUSED_TEXT });
    h.badge.replaced(9, tabId);
    await h.flush();
    expect(h.view(9)).toMatchObject({ text: PAUSED_TEXT });
    h.badge.paused(9, undefined);
    await h.flush();
    expect(h.view(9)).toMatchObject(NONE);
    // An end already past shows nothing.
    h.badge.paused(9, { until: Date.now() });
    await h.flush();
    expect(h.view(9)).toMatchObject(NONE);
  });

  it("shows II for a site the allowed sites leave out, and says why (ADR 0077)", async () => {
    const h = harness();
    h.badge.paused(tabId, { rule: true, notAllowed: true });
    await h.flush();
    expect(h.view()).toEqual({
      text: PAUSED_TEXT,
      color: "#6b7280",
      textColor: "#ffffff",
      title: "Pateat: automatic login is paused here, as this is not an allowed site.",
    });
  });

  it("shows II until turned back on for a site an exclusion rule pauses (ADR 0062)", async () => {
    const h = harness();
    h.badge.paused(tabId, { rule: true });
    await h.flush();
    expect(h.view()).toEqual({
      text: PAUSED_TEXT,
      color: "#6b7280",
      textColor: "#ffffff",
      title: "Pateat: automatic login is paused on this site until turned back on.",
    });
    // It has no end of its own.
    await vi.advanceTimersByTimeAsync(24 * 60 * 60_000);
    expect(h.view()).toMatchObject({ text: PAUSED_TEXT });
    h.badge.paused(tabId, undefined);
    await h.flush();
    expect(h.view()).toMatchObject(NONE);
  });

  it("shows II in a private window while automatic login is off there (ADR 0062)", async () => {
    const h = harness();
    h.badge.paused(tabId, { private: true });
    await h.flush();
    expect(h.view()).toEqual({
      text: PAUSED_TEXT,
      color: "#6b7280",
      textColor: "#ffffff",
      title: "Pateat: automatic login is off in private windows.",
    });
    await vi.advanceTimersByTimeAsync(24 * 60 * 60_000);
    expect(h.view()).toMatchObject({ text: PAUSED_TEXT });
    h.badge.paused(tabId, undefined);
    await h.flush();
    expect(h.view()).toMatchObject(NONE);
  });

  it("says automatic login is off in private windows over a private tab's choice (ADR 0062)", async () => {
    const h = harness();
    h.badge.paused(tabId, { private: true });
    h.badge.choice(tabId, { count: 2, paused: true });
    await h.flush();
    expect(h.view()).toEqual({
      text: "2",
      ...CHOICE,
      title: "Pateat: automatic login is off in private windows. Click to choose an account.",
    });
  });

  it("says Pateat logged in twice when the guard against repeated logins asks (ADR 0062 C)", async () => {
    const h = harness();
    h.badge.choice(tabId, { count: 1, ask: "relogin-limit" });
    await h.flush();
    expect(h.view()).toMatchObject({
      text: "1",
      title: "Pateat logged in to this site twice in 10 minutes. Click to choose an account.",
    });
  });

  it("shows II when the paused sites could not be read (ADR 0062)", async () => {
    const h = harness();
    h.badge.paused(tabId, { unreadable: true });
    await h.flush();
    expect(h.view()).toEqual({
      text: PAUSED_TEXT,
      color: "#6b7280",
      textColor: "#ffffff",
      title: "Pateat: the paused sites could not be read, so automatic login is paused.",
    });
  });

  it("clears a pause's II left by a stopped worker, and ends a restored pause on time (ADR 0062)", async () => {
    // The worker that set `II` stopped; Chrome still shows it on both tabs.
    const h = harness();
    await h.badge.restore();
    const until = Date.now() + 10 * 60_000;
    // The startup reads each tab's pause again: one ended meanwhile, one still runs.
    h.badge.paused(8, undefined);
    h.badge.paused(tabId, { until });
    await h.flush();
    expect(h.view(8)).toMatchObject(NONE);
    expect(h.view()).toMatchObject({ text: PAUSED_TEXT });
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    expect(h.view()).toMatchObject(NONE);
    // Once drawn, an unchanged pause writes nothing again.
    const writes = h.calls.length;
    h.badge.paused(8, undefined);
    await h.flush();
    expect(h.calls).toHaveLength(writes);
  });

  it("keeps the tab's badge through an unfit recipe's report (ADR 0058 A)", async () => {
    const h = harness();
    h.badge.observe(attempt({ outcome: "credential-rejected" }));
    await h.flush();
    const before = h.view();
    expect(before).toMatchObject(FAILED);
    for (const outcome of ["claimed", "not-sent"] as const)
      h.badge.observe({
        type: "unfit",
        tabId,
        origin: "https://login.example",
        recipeId: "gen-0123456789abcdef0123456789abcdef",
        recipeRevision: 3,
        route: "passkey",
        outcome,
        detail: "password-empty:no-advance",
      });
    await h.flush();
    expect(h.view()).toEqual(before);
  });

  it("spins a braille frame every 100 ms and stops with the last overlapping spin", async () => {
    const h = harness();
    const first = h.badge.spin(tabId);
    const second = h.badge.spin(tabId);
    await h.flush();
    expect(h.calls).toEqual([
      { tabId, text: BUSY_FRAMES[0], ...BUSY, title: "Pateat: asking the AI…" },
    ]);
    await vi.advanceTimersByTimeAsync(BUSY_FRAME_MS * BUSY_FRAMES.length);
    expect(h.calls.slice(1).map((call) => call.text)).toEqual([
      ...BUSY_FRAMES.slice(1),
      BUSY_FRAMES[0],
    ]);
    // Each frame writes only the text.
    expect(h.calls.slice(1).every((call) => Object.keys(call).join() === "tabId,text")).toBe(true);

    first();
    await vi.advanceTimersByTimeAsync(BUSY_FRAME_MS);
    expect(h.view().color).toBe(BUSY.color);
    second();
    await h.flush();
    // Colours stay; only the text and title clear.
    expect(h.calls.at(-1)).toEqual({ tabId, ...NONE });
    const count = h.calls.length;
    await vi.advanceTimersByTimeAsync(BUSY_FRAME_MS * 5);
    expect(h.calls).toHaveLength(count);
    // A second stop does nothing.
    second();
    await h.flush();
    expect(h.calls).toHaveLength(count);
  });

  it("stops a spin on its own after two minutes", async () => {
    const h = harness();
    h.badge.spin(tabId);
    await vi.advanceTimersByTimeAsync(BUSY_LIMIT_MS - BUSY_FRAME_MS);
    expect(h.view().color).toBe(BUSY.color);
    expect(h.view().text).not.toBe("");
    await vi.advanceTimersByTimeAsync(BUSY_FRAME_MS);
    expect(h.view()).toMatchObject(NONE);
    const count = h.calls.length;
    await vi.advanceTimersByTimeAsync(BUSY_FRAME_MS * 3);
    expect(h.calls).toHaveLength(count);
  });

  it("shows a success and an unsettled result for four seconds", async () => {
    const h = harness();
    h.badge.observe(attempt({ state: "authenticated" }));
    await h.flush();
    expect(h.view()).toEqual({ ...SUCCEEDED, title: "Pateat: logged in." });
    await vi.advanceTimersByTimeAsync(NOTICE_MS - 1);
    expect(h.view()).toMatchObject(SUCCEEDED);
    await vi.advanceTimersByTimeAsync(1);
    expect(h.view()).toMatchObject(NONE);

    h.badge.observe(attempt({ outcome: "watch-abandoned" }));
    await h.flush();
    expect(h.view()).toMatchObject(UNSETTLED);
    expect(h.view().title).toContain("watch-abandoned");
    await vi.advanceTimersByTimeAsync(NOTICE_MS);
    expect(h.view()).toMatchObject(NONE);
  });
}
