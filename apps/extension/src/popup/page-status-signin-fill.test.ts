import { describe, expect, it, vi } from "vitest";
import * as v from "valibot";
import { i18n } from "../i18n";
import { statusResponseSchema, type StatusResponse } from "../login/choice-wire";
import { createLoginBadge, memoryBadgeStorage } from "../login/badge";
import { pageStatusLines } from "./page-status";
vi.mock("wxt/browser", () => ({ browser: { action: {} } }));

type Status = Extract<StatusResponse, { ok: true }>;
const origin = "https://login.example";
const status = (login: Status["login"]): Status =>
  v.parse(statusResponseSchema, { ok: true, origin, recipe: "page", login }) as Status;
const line = (value: Status, language = "en") =>
  pageStatusLines(value, i18n.getFixedT(language)).find((entry) => entry.id === "login");

describe("autofill page status and badge persistence", () => {
  it.each([
    [
      "en",
      "Autofill only: Pateat may fill sign-in fields and presses nothing. Continue the site's steps yourself.",
      "Autofill stopped after 10 minutes. Reload the page or choose an account to continue.",
    ],
    [
      "ja",
      "自動入力のみ：Pateat はログイン欄に入力する場合がありますが、ボタンは押しません。サイトの手順はご自身で進めてください。",
      "10 分が経過したため自動入力を停止しました。続けるには、ページを再読み込みするかアカウントを選んでください。",
    ],
  ])(
    "names active autofill and expiry in %s without claiming a completed login",
    (language, active, expired) => {
      expect(line(status({ state: "ready", signInFill: true }), language)).toEqual({
        id: "login",
        tone: "idle",
        text: active,
      });
      expect(
        line(
          status({ state: "blocked", outcome: "cancelled", signInFill: true, fillExpired: true }),
          language,
        ),
      ).toEqual({ id: "login", tone: "idle", text: expired });
    },
  );

  it("keeps naming autofill only once the last field is filled, not a stopped login", () => {
    expect(
      line(status({ state: "blocked", outcome: "cancelled", signInFill: true, fillDone: true }))
        ?.text,
    ).toBe(
      "Autofill only: Pateat may fill sign-in fields and presses nothing. Continue the site's steps yourself.",
    );
  });

  it("distinguishes profile autofill from the existing logout fill status", () => {
    expect(line(status({ state: "blocked", outcome: "cancelled", signInFill: true }))?.text).toBe(
      "Autofill stopped: the login was cancelled. Nothing was pressed.",
    );
    const logout = line(status({ state: "blocked", outcome: "cancelled", fillOnly: true }));
    expect(logout?.text).not.toContain("Autofill only:");
    expect(logout?.text).not.toContain("10 minutes");
  });

  it.each(["en", "ja"])(
    "explains page-off in %s without exposing its internal code",
    (language) => {
      const value: Status = {
        ok: true,
        origin,
        recipe: "page",
        page: { state: "denied", reason: "page-off" },
      };
      const text = line(value, language)?.text;
      expect(text).toContain(
        language === "en"
          ? "verification filling is turned off for this site or profile"
          : "このサイトまたはプロファイルでは、再確認ページへの入力がオフです",
      );
      expect(text).not.toContain("page-off");
    },
  );

  it("preserves the active mode and expired state in badge storage across worker recreation", async () => {
    const storage = memoryBadgeStorage();
    const badge = createLoginBadge({ storage, setBadge: async () => undefined });
    badge.observe({
      type: "start",
      tabId: 7,
      origin,
      recipeId: "synthetic",
      recipeRevision: 1,
      route: "password",
      fillOnly: true,
      fillMode: "sign-in-fill",
      permissionSource: "site",
    });
    expect(badge.status(7)?.login).toEqual({ state: "started", signInFill: true });
    badge.observe({
      type: "attempt",
      tabId: 7,
      origin,
      recipeId: "synthetic",
      recipeRevision: 1,
      route: "password",
      state: "blocked",
      stepIndex: 1,
      stepCount: 2,
      reason: "fill-only",
      fillMode: "sign-in-fill",
      permissionSource: "site",
      fillExpired: true,
      outcome: "cancelled",
    });
    await vi.waitFor(async () =>
      expect(JSON.stringify(await storage.getValue())).toContain('"fillExpired":true'),
    );
    const restored = createLoginBadge({ storage, setBadge: async () => undefined });
    await restored.restore();
    expect(restored.status(7)?.login).toMatchObject({
      state: "blocked",
      signInFill: true,
      fillExpired: true,
      fillOnly: true,
    });
    expect(line(status(restored.status(7)!.login))?.text).toContain(
      "Autofill stopped after 10 minutes",
    );
  });
});
