// The popup's **Fill** on a verification page (ADR 0035, amended 2026-11-17): it replaces
// **Log in now** on a fill target, sends the exact offered page with the chosen account,
// and says how the press went, in English and Japanese.
import { QueryClientProvider } from "@tanstack/react-query";
import { afterEach, expect, test, vi } from "vitest";
import { page, userEvent } from "vitest/browser";
import { cleanup, render } from "vitest-browser-react";
import {
  createDefaultSettings,
  DUMMY_VAULT_CATALOG,
  type SettingsResponse,
} from "../../packages/contracts/src/index";
import { createMetadataQueryClient } from "../../apps/extension/src/options/client";
import type {
  ConfirmFillStatus,
  ManualClient,
  ManualOfferResponse,
} from "../../apps/extension/src/login/manual-wire";
import { i18n } from "../../apps/extension/src/i18n";
import { ManualLogin } from "../../apps/extension/src/popup/manual-login";

const origin = "https://bank.example";
const primary = { connectionId: "demo-personal", itemId: "primary" };
const secondary = { connectionId: "demo-personal", itemId: "secondary" };
const target = (candidates = [primary, secondary]) => ({
  document: { origin, tabId: 7, frameId: 0, documentId: "document-0" },
  scope: "scope-0",
  fill: true as const,
  candidates,
});
const saved = (): Extract<SettingsResponse, { ok: true }> => ({
  version: 1,
  ok: true,
  snapshot: { version: 1, revision: 1, settings: createDefaultSettings() },
  catalog: structuredClone(DUMMY_VAULT_CATALOG),
});
async function mount(initial: ManualOfferResponse = { ok: true, targets: [target()] }) {
  const client = {
    get: vi.fn<ManualClient["get"]>().mockResolvedValue(initial),
    start: vi.fn<ManualClient["start"]>().mockResolvedValue({ ok: true, state: "evaluating" }),
    cancel: vi.fn<ManualClient["cancel"]>().mockResolvedValue({ ok: true }),
    fill: vi.fn<ManualClient["fill"]>().mockResolvedValue({ ok: true, state: "preparing" }),
  };
  const onStarted = vi.fn();
  const query = createMetadataQueryClient();
  await render(
    <QueryClientProvider client={query}>
      <ManualLogin
        client={client}
        tabId={7}
        saved={saved()}
        disabled={false}
        onStarted={onStarted}
        onBusy={vi.fn()}
        onReprompt={vi.fn()}
      />
    </QueryClientProvider>,
  );
  const update = (answer: ManualOfferResponse) => {
    client.get.mockResolvedValue(answer);
    query.setQueryData(["popup", "manual", 7, 1], answer);
  };
  return { client, onStarted, update };
}
/** Presses **Fill** with the second account and returns the request it sent. */
async function pressed(h: Awaited<ReturnType<typeof mount>>, label = "Fill") {
  await page
    .getByRole("combobox")
    .selectOptions(JSON.stringify([secondary.connectionId, secondary.itemId]));
  await userEvent.click(page.getByRole("button", { name: label, exact: true }));
  await expect.poll(() => h.client.fill).toHaveBeenCalledTimes(1);
  return h.client.fill.mock.calls[0]![0];
}
afterEach(async () => {
  cleanup();
  await i18n.changeLanguage("en");
});

test("a verification page offers Fill in place of Log in now", async () => {
  await mount();
  await expect.element(page.getByRole("heading", { name: "Fill", exact: true })).toBeVisible();
  await expect
    .element(page.getByRole("button", { name: "Log in now", exact: true }))
    .not.toBeInTheDocument();
  await expect
    .element(
      page.getByText(
        "This page asks you to verify while signed in. Fill enters the chosen account's password once, or its secret answer when the page asks for one; Pateat presses no button.",
      ),
    )
    .toBeVisible();
  // Two matching accounts: none is chosen for the person.
  await expect.element(page.getByRole("button", { name: "Fill", exact: true })).toBeDisabled();
  await expect.element(page.getByRole("combobox", { name: "Account to fill" })).toBeVisible();
});

test("a press sends the exact offered page and the chosen account, and never a login", async () => {
  const h = await mount();
  const request = await pressed(h);
  expect(request).toEqual({
    requestId: expect.any(String),
    document: target().document,
    scope: "scope-0",
    ...secondary,
  });
  expect(h.client.start).not.toHaveBeenCalled();
  h.update({
    ok: true,
    targets: [target()],
    fill: { requestId: request.requestId, state: "preparing" },
  });
  await expect.element(page.getByText("Filling this page…")).toBeVisible();
  await expect.element(page.getByRole("button", { name: "Fill", exact: true })).toBeDisabled();
});

test("a sign-in page next to it still offers Log in now", async () => {
  const { fill: _fill, ...signIn } = target([primary]);
  await mount({ ok: true, targets: [signIn] });
  await expect
    .element(page.getByRole("heading", { name: "Log in now", exact: true }))
    .toBeVisible();
  await expect.element(page.getByRole("button", { name: "Log in now", exact: true })).toBeEnabled();
});

const texts: Record<"en" | "ja", Record<string, string>> = {
  en: {
    Fill: "Fill",
    asked: "Enter the master password in Pateat's window to fill this page.",
    filled: "Filled. Review the page and press its button yourself.",
    closed: "The master password window was closed. Try again when you are ready.",
    "timed-out": "Filling took too long, so nothing was filled. Press Fill again.",
    refused: "This page was not recognized as a verification page, so nothing was filled.",
    other: "Nothing was filled. Check Diagnostics for the reason, then try again.",
  },
  ja: {
    Fill: "入力",
    asked: "このページに入力するには、Pateat のウィンドウでマスターパスワードを入力してください。",
    filled: "入力しました。内容を確認して、ページのボタンはご自身で押してください。",
    closed:
      "マスターパスワードのウィンドウが閉じられました。準備ができたら、もう一度お試しください。",
    "timed-out":
      "入力に時間がかかりすぎたため、何も入力しませんでした。もう一度「入力」を押してください。",
    refused: "このページは本人確認のページと判定されなかったため、何も入力しませんでした。",
    other: "何も入力しませんでした。診断で理由を確認してから、もう一度お試しください。",
  },
};

test.each(["en", "ja"] as const)("says how a press goes (%s)", async (language) => {
  await i18n.changeLanguage(language);
  const text = texts[language];
  const h = await mount();
  const { requestId } = await pressed(h, text["Fill"]);
  const status = (fill: ConfirmFillStatus) =>
    h.update({ ok: true, targets: [], fill: { ...fill, requestId } });
  status({ requestId, state: "asked" });
  await expect.element(page.getByText(text["asked"]!)).toBeVisible();
  for (const reason of ["closed", "timed-out", "other"]) {
    status({ requestId, state: "blocked", reason: reason === "other" ? "unavailable" : reason });
    // oxlint-disable-next-line no-await-in-loop -- each status follows the last
    await expect.element(page.getByText(text[reason]!)).toBeVisible();
  }
  expect(h.onStarted).not.toHaveBeenCalled();
  status({ requestId, state: "filled" });
  await expect.element(page.getByText(text["filled"]!)).toBeVisible();
  // The popup closes once the page is filled.
  await expect.poll(() => h.onStarted).toHaveBeenCalled();
});

test.each(["en", "ja"] as const)("says why a press was refused (%s)", async (language) => {
  await i18n.changeLanguage(language);
  const text = texts[language];
  const h = await mount();
  h.client.fill.mockResolvedValue({ ok: false, reason: "not-a-verification-page" });
  await pressed(h, text["Fill"]);
  await expect.element(page.getByText(text["refused"]!)).toBeVisible();
  expect(h.onStarted).not.toHaveBeenCalled();
});
