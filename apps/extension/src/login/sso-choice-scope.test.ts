import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SettingsSnapshot, SsoMapping } from "@pateat/contracts";
import {
  idpOrigin,
  origin,
  sourceItem,
  ssoHarness,
  targetItem,
  type SsoHarness,
} from "./sso-choice-fixture";

// What an open SSO method offer reads from the settings (ADR 0085, amendment of
// 2026-11-17): a change of it ends the offer, any other change keeps it.

const fixtures: SsoHarness[] = [];
const start = (...args: Parameters<typeof ssoHarness>) => {
  const h = ssoHarness(...args);
  fixtures.push(h);
  return h;
};
beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(1_800_000_000_000);
});
afterEach(() => {
  for (const h of fixtures.splice(0)) h.controller.invalidateAll();
  vi.useRealTimers();
});
type Settings = SettingsSnapshot["settings"];
type Cause = NonNullable<SettingsSnapshot["changes"]>[number]["cause"];
const account = (userId: string, itemId: string) => ({
  provider: "bitwarden",
  server: "cloud-us",
  userId,
  itemId,
});
/** The fixture's site item's method 1 mapped to the fixture's IdP item. */
const mapping: SsoMapping = {
  ...account(sourceItem, sourceItem),
  method: 1,
  idp: { ...account(targetItem, targetItem), origin: idpOrigin },
};
/** A settings write of `cause`, as a sync or another tab makes it. */
const write = (h: SsoHarness, cause: Cause, change: (settings: Settings) => void) =>
  h.updateSettings(undefined, cause, (snapshot) => {
    const settings = structuredClone(snapshot.settings);
    change(settings);
    return { ...snapshot, settings };
  });
/** Another site's account choice and the theme. */
const unrelated = (settings: Settings) => {
  settings.siteDefaults.push({
    origin: "https://elsewhere.example.test",
    ...account(sourceItem, sourceItem),
  });
  settings.theme = "dark";
};
/** An offer with method 1 mapped to the IdP item, as the popup leaves it. */
async function mapped(h: SsoHarness, extra: Parameters<SsoHarness["request"]>[0] = {}) {
  const pending = await h.request(extra);
  expect(await h.choose("mapping")).toEqual({ ok: true });
  return pending;
}
async function kept(h: SsoHarness, pending: Awaited<ReturnType<SsoHarness["request"]>>) {
  await h.controller.settingsChanged();
  expect(await h.controller.get(7)).toMatchObject({ ok: true, offer: { id: pending.offerId } });
}
async function ended(h: SsoHarness, pending: Awaited<ReturnType<SsoHarness["request"]>>) {
  await h.controller.settingsChanged();
  expect(await pending.result).toEqual({ ok: false, reason: "settings-changed" });
  expect(await h.controller.get(7)).toEqual({ ok: true });
}

describe("an open SSO method offer over a settings change", () => {
  it.each([true, false])(
    "follows private-window logins being turned off only in a private window (%s)",
    async (incognito) => {
      const h = start();
      h.saved.snapshot.settings.loginInPrivateWindows = true;
      const pending = await mapped(h, { incognito });
      await write(h, "service-sync", (settings) => {
        delete settings.loginInPrivateWindows;
      });
      await (incognito ? ended : kept)(h, pending);
    },
  );
  it("keeps the offer over a passkey policy change, which only an assertion reads", async () => {
    const h = start();
    const pending = await mapped(h);
    await write(h, "service-sync", (settings) => {
      settings.passkeyPolicy = { presence: "activation", verification: "never" };
    });
    await kept(h, pending);
  });
  it.each([origin, idpOrigin])(
    "ends the offer when %s starts asking for the master password",
    async (page) => {
      const h = start();
      for (const connection of h.saved.catalog.connections)
        for (const item of connection.items) item.reprompt = true;
      const pending = await mapped(h);
      await write(h, "service-sync", (settings) => {
        settings.repromptSites.push({ hostname: new URL(page).hostname, includeSubdomains: false });
      });
      await ended(h, pending);
    },
  );
  it.each([
    ["ends", origin],
    ["ends", idpOrigin],
    ["keeps", "https://elsewhere.example.test"],
  ] as const)("%s the offer when %s is set to fill sign-in pages only", async (name, page) => {
    const h = start();
    const pending = await mapped(h);
    await write(h, "service-sync", (settings) => {
      settings.sitePagePermissions = [
        {
          hostname: new URL(page).hostname,
          includeSubdomains: false,
          permissions: { "sign-in": "fill" },
        },
      ];
    });
    await (name === "ends" ? ended : kept)(h, pending);
  });
  it.each(["account-choice", "service-sync"] as const)(
    "ends the offer when the IdP origin's default changes through %s, as the flow would",
    async (cause) => {
      const h = start();
      const pending = await mapped(h);
      await write(h, cause, (settings) => {
        settings.siteDefaults.push({ origin: idpOrigin, ...account(targetItem, targetItem) });
      });
      await ended(h, pending);
    },
  );
  it("ends the offer when a sync brings another device's mapping of its site item", async () => {
    const h = start();
    const pending = await h.request();
    await write(h, "service-sync", (settings) => {
      settings.ssoMappings = [mapping];
    });
    await ended(h, pending);
  });
  it("lets a receipt outlive an unrelated change and be consumed", async () => {
    const h = start();
    const pending = await mapped(h);
    expect(await h.choose("sso")).toEqual({ ok: true });
    const answer = await pending.result;
    if (!answer.ok) throw new Error(answer.reason);
    await write(h, "service-sync", unrelated);
    await h.controller.settingsChanged();
    expect(await h.controller.consume(answer.choiceId)).toMatchObject({
      ok: true,
      selection: { kind: "sso" },
    });
  });
  it("ends an offer whose saved mapping was refused once its IdP account's settings change", async () => {
    const h = start();
    h.setRecords([mapping]);
    const policies = h.saved.snapshot.settings.accountPolicies;
    for (const policy of policies) if (policy.userId === targetItem) policy.enabled = false;
    h.source.validate.mockResolvedValueOnce({ ok: false, reason: "account-disabled" });
    const pending = await h.request();
    const shown = (await h.offer()).methods[0]!;
    expect(shown).toMatchObject({ mapped: true, reason: "account-disabled" });
    expect(shown.selectedId).toBeUndefined();
    // The person turns the IdP account on again; a new offer then uses the mapping.
    await write(h, "service-sync", (settings) => {
      for (const policy of settings.accountPolicies)
        if (policy.userId === targetItem) policy.enabled = true;
    });
    await ended(h, pending);
  });
});

describe("a request against the settings its coordinator read", () => {
  const basis = (h: SsoHarness, change: (settings: Settings) => void) => {
    const read = structuredClone(h.saved);
    read.snapshot.revision -= 1;
    change(read.snapshot.settings);
    return read;
  };
  it("ends when the site's default changed since the coordinator's read", async () => {
    const h = start();
    const older = basis(h, (settings) => {
      settings.siteDefaults.push({ origin, ...account(targetItem, targetItem) });
    });
    const pending = await h.request({ basis: older });
    expect(await pending.result).toEqual({ ok: false, reason: "settings-changed" });
    expect(h.source.describe).not.toHaveBeenCalled();
  });
  it("opens its offer when only unrelated settings changed since then", async () => {
    const h = start();
    const pending = await h.request({ basis: basis(h, unrelated) });
    expect(await h.controller.get(7)).toMatchObject({ ok: true, offer: { id: pending.offerId } });
    expect(h.source.describe).toHaveBeenCalledWith(
      expect.objectContaining({ itemId: sourceItem }),
      undefined,
    );
  });
});
