import { QueryClientProvider } from "@tanstack/react-query";
import { afterEach, expect, test, vi } from "vitest";
import { cdp, page } from "vitest/browser";
import { cleanup, render } from "vitest-browser-react";
// oxlint-disable-next-line import/no-unassigned-import -- Apply the shared extension stylesheet.
import "../../apps/extension/entrypoints/options/style.css";
// oxlint-disable-next-line import/no-unassigned-import -- Apply the popup stylesheet.
import "../../apps/extension/entrypoints/popup/style.css";
import {
  createMetadataQueryClient,
  type SettingsClient,
} from "../../apps/extension/src/options/client";
import type { ChoiceClient } from "../../apps/extension/src/login/choice-wire";
import type { DetailClient, DetailResponse } from "../../apps/extension/src/login/detail-wire";
import { SiteApp } from "../../apps/extension/src/popup/site-app";
import { createDefaultSettings, DUMMY_VAULT_CATALOG } from "../../packages/contracts/src/index";

// Layout checks with the real stylesheets at the popup's 360px width. Synthetic settings
// and vault matches only.

const HOSTNAME =
  "a-rather-long-subdomain-name.accounts.an-unusually-long-bank-name-for-a-test.example";
const ORIGIN = `https://${HOSTNAME}`;

afterEach(async () => {
  await cleanup();
  await cdp().send("Emulation.setEmulatedMedia", { features: [] });
});

function noDetails(answer: DetailResponse = { ok: true, origin: ORIGIN, links: [] }) {
  return {
    get: vi.fn<DetailClient["get"]>().mockResolvedValue(answer),
    fill: vi.fn<DetailClient["fill"]>().mockResolvedValue({ ok: true }),
    remove: vi.fn<DetailClient["remove"]>().mockResolvedValue({ ok: true }),
  };
}

test("long hostnames and usernames wrap inside the 360px popup", async () => {
  await page.viewport(360, 800);
  const settings = createDefaultSettings();
  const client = {
    getSettings: vi.fn<SettingsClient["getSettings"]>().mockResolvedValue({
      version: 1,
      ok: true,
      snapshot: { version: 1, revision: 0, settings },
      catalog: DUMMY_VAULT_CATALOG,
    }),
    saveSettings: vi.fn<SettingsClient["saveSettings"]>(),
    findSiteAccounts: vi.fn<SettingsClient["findSiteAccounts"]>().mockResolvedValue({
      version: 1,
      ok: true,
      origin: ORIGIN,
      complete: false,
      accounts: [
        {
          connectionId: "demo-personal",
          itemId: "primary",
          uri: true,
          passkey: false,
          username: "a.very.long.username.without.spaces@an-unusually-long-mail-domain.example",
        },
        { connectionId: "demo-work", itemId: "primary", uri: true, passkey: false },
      ],
    }),
  };
  const choices = {
    get: vi.fn<ChoiceClient["get"]>().mockResolvedValue({
      ok: true,
      origin: ORIGIN,
      documentId: "refused-document",
      candidates: [
        { connectionId: "demo-personal", itemId: "primary" },
        { connectionId: "demo-work", itemId: "primary" },
      ],
      held: true,
    }),
    pick: vi.fn<ChoiceClient["pick"]>(),
    status: vi.fn<ChoiceClient["status"]>().mockResolvedValue({ ok: false, reason: "no-page" }),
  };
  await render(
    <QueryClientProvider client={createMetadataQueryClient()}>
      <SiteApp
        client={client}
        choices={choices}
        details={noDetails()}
        host={{
          currentTab: async () => ({ id: 7, url: `${ORIGIN}/login`, incognito: false }),
          openSettings: vi.fn(),
          openDiagnostics: vi.fn(),
          close: vi.fn(),
          watchSettings: () => () => {},
        }}
      />
    </QueryClientProvider>,
  );
  await expect.element(page.getByRole("heading", { name: "Choose an account" })).toBeVisible();
  await expect
    .element(page.getByText("Some vaults or items could not be checked", { exact: false }))
    .toBeVisible();
  const main = document.querySelector("main")!;
  expect(main.getBoundingClientRect().width).toBe(360);
  expect(main.scrollWidth).toBeLessThanOrEqual(main.clientWidth);
  expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(360);
  // The empty live region stays rendered, so its first message is announced.
  const message = document.querySelector("#popup-message")!;
  expect(message.textContent).toBe("");
  expect(getComputedStyle(message).display).not.toBe("none");
  // The switch keeps its size beside its label.
  const toggle = page.getByRole("switch", { name: "Pateat on this site" }).element();
  expect(toggle.getBoundingClientRect()).toMatchObject({ width: 36, height: 20 });
});

test("the page section's long log codes wrap inside the 360px popup", async () => {
  await page.viewport(360, 800);
  const settings = createDefaultSettings();
  const client = {
    getSettings: vi.fn<SettingsClient["getSettings"]>().mockResolvedValue({
      version: 1,
      ok: true,
      snapshot: { version: 1, revision: 0, settings },
      catalog: DUMMY_VAULT_CATALOG,
    }),
    saveSettings: vi.fn<SettingsClient["saveSettings"]>(),
    findSiteAccounts: vi.fn<SettingsClient["findSiteAccounts"]>().mockResolvedValue({
      version: 1,
      ok: true,
      origin: ORIGIN,
      complete: true,
      accounts: [{ connectionId: "demo-work", itemId: "primary", uri: true, passkey: false }],
    }),
  };
  const choices = {
    get: vi.fn<ChoiceClient["get"]>().mockResolvedValue({ ok: false, reason: "no-choice" }),
    pick: vi.fn<ChoiceClient["pick"]>(),
    status: vi.fn<ChoiceClient["status"]>().mockResolvedValue({
      ok: true,
      origin: ORIGIN,
      // Every line kind that carries a log code; the request in flight has none.
      recipe: "other-paths",
      page: { generationSkip: `incomplete-observation-${"unfillable-field-".repeat(6)}gap` },
      login: {
        state: "blocked",
        outcome: "structural-mismatch",
        cause: "elements-timeout",
      },
      refused: { reason: "no-route", detail: "password-not-allowed:no-passkey" },
      generation: {
        outcome: "failed",
        reason: `invalid-output:${"schema-check-refused-".repeat(5)}end`,
        page: "continuation",
      },
    }),
  };
  await render(
    <QueryClientProvider client={createMetadataQueryClient()}>
      <SiteApp
        client={client}
        choices={choices}
        details={noDetails()}
        host={{
          currentTab: async () => ({ id: 7, url: `${ORIGIN}/login`, incognito: false }),
          openSettings: vi.fn(),
          openDiagnostics: vi.fn(),
          close: vi.fn(),
          watchSettings: () => () => {},
        }}
      />
    </QueryClientProvider>,
  );
  await expect.element(page.getByRole("heading", { name: "This page" })).toBeVisible();
  await expect.element(page.getByText("Pateat did not log in", { exact: false })).toBeVisible();
  const lines = [...document.querySelectorAll("#popup-page-status > li")];
  expect(lines.map((line) => line.id)).toEqual([
    "popup-page-recipe",
    "popup-page-generation",
    "popup-page-generation-skip",
    "popup-page-login",
    "popup-page-login-recipe",
    "popup-page-refused",
  ]);
  const main = document.querySelector("main")!;
  expect(main.getBoundingClientRect().width).toBe(360);
  expect(main.scrollWidth).toBeLessThanOrEqual(main.clientWidth);
  expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(360);
  const section = document.querySelector("#popup-page-status")!;
  expect(section.scrollWidth).toBeLessThanOrEqual(section.clientWidth);
  const right = main.getBoundingClientRect().right;
  for (const line of lines) {
    expect(line.scrollWidth).toBeLessThanOrEqual(line.clientWidth);
    expect(line.getBoundingClientRect().right).toBeLessThanOrEqual(right);
    // Each line's icon keeps its size beside the wrapped text.
    expect(line.querySelector("svg")!.getBoundingClientRect()).toMatchObject({
      width: 16,
      height: 16,
    });
  }
  const link = document.querySelector("#popup-open-diagnostics")!;
  expect(link.getBoundingClientRect().right).toBeLessThanOrEqual(right);
});

test("long vault labels of a page's personal details wrap inside the 360px popup", async () => {
  await page.viewport(360, 800);
  const long = "an-unusually-long-vault-label-without-any-spaces-".repeat(3);
  const client = {
    getSettings: vi.fn<SettingsClient["getSettings"]>().mockResolvedValue({
      version: 1,
      ok: true,
      snapshot: { version: 1, revision: 0, settings: createDefaultSettings() },
      catalog: DUMMY_VAULT_CATALOG,
    }),
    saveSettings: vi.fn<SettingsClient["saveSettings"]>(),
    findSiteAccounts: vi.fn<SettingsClient["findSiteAccounts"]>().mockResolvedValue({
      version: 1,
      ok: true,
      origin: ORIGIN,
      complete: true,
      accounts: [],
    }),
  };
  const choices = {
    get: vi.fn<ChoiceClient["get"]>().mockResolvedValue({ ok: false, reason: "no-choice" }),
    pick: vi.fn<ChoiceClient["pick"]>(),
    status: vi.fn<ChoiceClient["status"]>().mockResolvedValue({ ok: false, reason: "no-page" }),
  };
  const source = {
    connectionId: "demo-personal",
    itemId: "identity",
    fieldId: "birth",
    itemLabel: long,
    fieldLabel: long,
  };
  await render(
    <QueryClientProvider client={createMetadataQueryClient()}>
      <SiteApp
        client={client}
        choices={choices}
        details={noDetails({
          ok: true,
          origin: ORIGIN,
          offer: {
            documentId: "detail-document",
            details: [{ detail: "birth-date", format: "yyyymm", candidates: [source] }],
          },
          links: [{ detail: "card-code", itemLabel: long, fieldLabel: long, pending: true }],
        })}
        host={{
          currentTab: async () => ({ id: 7, url: `${ORIGIN}/login`, incognito: false }),
          openSettings: vi.fn(),
          openDiagnostics: vi.fn(),
          close: vi.fn(),
          watchSettings: () => () => {},
        }}
      />
    </QueryClientProvider>,
  );
  await expect.element(page.getByRole("button", { name: "Fill" })).toBeVisible();
  await expect
    .element(page.getByRole("button", { name: "Remove the link for your card's security code" }))
    .toBeVisible();
  const main = document.querySelector("main")!;
  expect(main.getBoundingClientRect().width).toBe(360);
  expect(main.scrollWidth).toBeLessThanOrEqual(main.clientWidth);
  expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(360);
  const right = main.getBoundingClientRect().right;
  for (const element of document.querySelectorAll(
    ".popup-detail .popup-choice, #popup-detail-links > li, #popup-detail-remove-card-code",
  ))
    expect(element.getBoundingClientRect().right).toBeLessThanOrEqual(right);
  // The card's icon keeps its size beside the wrapped labels.
  expect(
    document.querySelector(".popup-detail .popup-avatar")!.getBoundingClientRect(),
  ).toMatchObject({ width: 32, height: 32 });
});

test("forced colors keep the selected account and the switch position visible", async () => {
  await page.viewport(360, 800);
  const settings = createDefaultSettings();
  settings.siteDefaults.push({
    origin: ORIGIN,
    provider: "dummy",
    userId: "demo-work-account",
    itemId: "primary",
    itemName: "Demo team account",
    accountName: "Demo work vault",
  });
  const client = {
    getSettings: vi.fn<SettingsClient["getSettings"]>().mockResolvedValue({
      version: 1,
      ok: true,
      snapshot: { version: 1, revision: 0, settings },
      catalog: DUMMY_VAULT_CATALOG,
    }),
    saveSettings: vi.fn<SettingsClient["saveSettings"]>(),
    findSiteAccounts: vi.fn<SettingsClient["findSiteAccounts"]>().mockResolvedValue({
      version: 1,
      ok: true,
      origin: ORIGIN,
      complete: true,
      accounts: [
        { connectionId: "demo-personal", itemId: "primary", uri: true, passkey: false },
        { connectionId: "demo-work", itemId: "primary", uri: true, passkey: false },
      ],
    }),
  };
  const choices = {
    get: vi.fn<ChoiceClient["get"]>().mockResolvedValue({ ok: false, reason: "no-choice" }),
    pick: vi.fn<ChoiceClient["pick"]>(),
    status: vi.fn<ChoiceClient["status"]>().mockResolvedValue({ ok: false, reason: "no-page" }),
  };
  await render(
    <QueryClientProvider client={createMetadataQueryClient()}>
      <SiteApp
        client={client}
        choices={choices}
        details={noDetails()}
        host={{
          currentTab: async () => ({ id: 7, url: `${ORIGIN}/login`, incognito: false }),
          openSettings: vi.fn(),
          openDiagnostics: vi.fn(),
          close: vi.fn(),
          watchSettings: () => () => {},
        }}
      />
    </QueryClientProvider>,
  );
  const radios = page.getByRole("group", { name: "Default account" }).getByRole("radio");
  await expect.element(radios).toHaveLength(2);
  const [unchecked, checked] = radios.elements().map((radio) => radio.closest("label")!);
  expect(checked!.querySelector("input")!.checked).toBe(true);
  const height = checked!.getBoundingClientRect().height;
  await cdp().send("Emulation.setEmulatedMedia", {
    features: [{ name: "forced-colors", value: "active" }],
  });
  expect(matchMedia("(forced-colors: active)").matches).toBe(true);
  // Forced colors replace the accent border, tint and inset shadow with the same system
  // colors on every card, so the selection needs a mark of its own.
  const look = (element: Element) => {
    const style = getComputedStyle(element);
    return [
      style.borderTopWidth,
      style.borderTopColor,
      style.outlineStyle,
      style.outlineWidth,
      style.outlineColor,
      style.backgroundColor,
    ].join(" ");
  };
  expect(look(checked!)).not.toBe(look(unchecked!));
  // The thicker border takes the place of padding, so the selected card keeps its size.
  expect(checked!.getBoundingClientRect().height).toBe(height);

  // The track and its knob both use background colors, which forced colors make Canvas.
  const toggle = page.getByRole("switch", { name: "Pateat on this site" }).element();
  if (!(toggle instanceof HTMLInputElement)) throw new Error("the switch is not an input");
  expect(toggle.checked).toBe(true);
  const track = getComputedStyle(toggle);
  const knob = getComputedStyle(toggle, "::after");
  // The switch's row has an opaque Canvas background; the page body has none.
  const canvas = getComputedStyle(toggle.parentElement!).backgroundColor;
  expect(Number.parseFloat(track.borderTopWidth)).toBeGreaterThan(0);
  expect(track.borderTopColor).not.toBe(canvas);
  const on = { track: track.backgroundColor, knob: knob.backgroundColor };
  expect(on.knob).not.toBe(on.track);
  // React owns the switch's checked state, so read the off and disabled looks from an
  // uncontrolled copy beside it.
  const probe = document.createElement("input");
  probe.type = "checkbox";
  probe.setAttribute("role", "switch");
  toggle.after(probe);
  const probeTrack = getComputedStyle(probe);
  const probeKnob = getComputedStyle(probe, "::after");
  const off = { track: probeTrack.backgroundColor, knob: probeKnob.backgroundColor };
  // Off, the track is Canvas like its row, so only its border outlines the switch.
  expect(Number.parseFloat(probeTrack.borderTopWidth)).toBeGreaterThan(0);
  expect(probeTrack.borderTopColor).not.toBe(canvas);
  expect(off.knob).not.toBe(off.track);
  expect(off.track).not.toBe(on.track);
  probe.disabled = true;
  const disabled = { track: probeTrack.backgroundColor, knob: probeKnob.backgroundColor };
  expect(disabled.knob).not.toBe(disabled.track);
  expect(disabled.knob).not.toBe(off.knob);
  expect(probeTrack.opacity).toBe("1");
  probe.remove();
  expect(toggle.getBoundingClientRect()).toMatchObject({ width: 36, height: 20 });
});
