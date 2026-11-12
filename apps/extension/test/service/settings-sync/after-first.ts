import type { LocalSettings } from "@pateat/contracts";
import type { AfterFirstContext } from "./context";

export function registerAfterFirst({
  it,
  setup,
  agreed,
  localConnection,
  state,
  baseOf,
  expect,
  CONNECTION,
  never,
  account,
  binding,
  settingsOf,
  syncedSettings,
  mergeSyncedSettings,
  site,
  vi,
  MAX_SETTINGS_SYNC_ATTEMPTS,
  PROFILE,
  MAX_SETTINGS_DEFER_MS,
}: AfterFirstContext) {
  it("changes nothing when neither side changed", async () => {
    const {
      sync,
      transport,
      local: after,
      applied,
    } = setup({
      local: { ...agreed, connections: [localConnection] },
      service: state(4, agreed),
      base: baseOf(4, agreed),
    });
    expect(await sync.run(CONNECTION, never)).toBe("synced");
    expect(transport.saveSettings).not.toHaveBeenCalled();
    // No revision bump, so running login attempts are not stopped.
    expect(after()?.revision).toBe(7);
    expect(applied).not.toHaveBeenCalled();
  });

  it("uploads local changes and applies service changes in one merge", async () => {
    const {
      sync,
      service,
      local: after,
      base,
    } = setup({
      local: {
        ...agreed,
        // Added on this device, for example by an automatic account choice.
        siteDefaults: [...agreed.siteDefaults, account("https://shop.example")],
      },
      service: state(5, {
        ...agreed,
        // Removed on the service.
        excludedSites: [],
        repromptSites: [],
        passkeyBrowserSites: [],
        bindings: [...agreed.bindings, binding("https://shop.example")],
      }),
      base: baseOf(4, agreed),
    });
    expect(await sync.run(CONNECTION, never)).toBe("synced");
    const merged = settingsOf({
      excludedSites: [],
      repromptSites: [],
      passkeyBrowserSites: [],
      siteDefaults: [account("https://bank.example"), account("https://shop.example")],
      bindings: [binding("https://bank.example"), binding("https://shop.example")],
    });
    expect(service().revision).toBe(6);
    expect(syncedSettings(service().settings!)).toEqual(syncedSettings(merged));
    expect(syncedSettings(after()!.settings)).toEqual(syncedSettings(merged));
    expect(base()).toMatchObject({ revision: 6 });
  });

  it("lets the service win when both sides changed one entry", () => {
    const base = syncedSettings(agreed);
    const local = syncedSettings({
      ...agreed,
      siteDefaults: [account("https://bank.example", "item-local")],
      bindings: [],
    });
    const service = syncedSettings({
      ...agreed,
      siteDefaults: [account("https://bank.example", "item-service")],
      bindings: [binding("https://bank.example", "totp")],
    });
    expect(mergeSyncedSettings({ service: base, local: base }, local, service)).toEqual({
      accountPolicies: [],
      itemPolicies: [],
      customFieldReviews: [],
      excludedSites: [site("intranet.example")],
      passkeyBrowserSites: [],
      repromptSites: [],
      allowedSites: [],
      allowedSitesEnabled: false,
      siteDefaults: [account("https://bank.example", "item-service")],
      bindings: [binding("https://bank.example", "totp")],
      detailLinks: [],
      popupPageSection: true,
    });
  });

  it("syncs automatic login in private windows as one value (ADR 0062)", async () => {
    const on = { ...agreed, loginInPrivateWindows: true as const };
    const merge = (base: LocalSettings, local: LocalSettings, service: LocalSettings) =>
      mergeSyncedSettings(
        { service: syncedSettings(base), local: syncedSettings(base) },
        syncedSettings(local),
        syncedSettings(service),
      ).loginInPrivateWindows;
    // A change on either side wins over the base; the service's wins over a local one.
    expect(merge(agreed, on, agreed)).toBe(true);
    expect(merge(on, agreed, on)).toBeUndefined();
    expect(merge(agreed, agreed, on)).toBe(true);
    expect(merge(on, on, agreed)).toBeUndefined();
    // Turned on here, it is uploaded; turned off on the service, it goes here as well.
    const up = setup({ local: on, service: state(4, agreed), base: baseOf(4, agreed) });
    expect(await up.sync.run(CONNECTION, never)).toBe("synced");
    expect(up.service().settings).toMatchObject({ loginInPrivateWindows: true });
    const down = setup({ local: on, service: state(5, agreed), base: baseOf(4, on) });
    expect(await down.sync.run(CONNECTION, never)).toBe("synced");
    expect(down.local()?.settings).not.toHaveProperty("loginInPrivateWindows");
    expect(down.transport.saveSettings).not.toHaveBeenCalled();
  });

  it("syncs the switches, the timeout, language, theme and limits as one value each (ADR 0024)", async () => {
    const changed = {
      ...agreed,
      serviceReports: { send: false, since: 1_000 },
      passkeyPolicy: { presence: "activation", verification: "never" } as const,
      vaultTimeout: { timeout: 15, action: "log-out" } as const,
      language: "ja" as const,
      theme: "dark" as const,
      modelSpendLimits: { dailyUsd: 1, monthlyUsd: 20 },
    };
    const keys = [
      "serviceReports",
      "passkeyPolicy",
      "vaultTimeout",
      "language",
      "theme",
      "modelSpendLimits",
    ] as const;
    const merge = (base: LocalSettings, local: LocalSettings, service: LocalSettings) => {
      const merged = mergeSyncedSettings(
        { service: syncedSettings(base), local: syncedSettings(base) },
        syncedSettings(local),
        syncedSettings(service),
      );
      return keys.map((key) => merged[key]);
    };
    const values = keys.map((key) => changed[key]);
    const none = keys.map(() => undefined);
    expect(merge(agreed, changed, agreed)).toEqual(values);
    expect(merge(changed, agreed, changed)).toEqual(none);
    expect(merge(agreed, agreed, changed)).toEqual(values);
    expect(merge(changed, changed, agreed)).toEqual(none);
    // Changed here, they are uploaded; back to the default on the service, they go here too.
    const up = setup({ local: changed, service: state(4, agreed), base: baseOf(4, agreed) });
    expect(await up.sync.run(CONNECTION, never)).toBe("synced");
    expect(up.service().settings).toMatchObject(
      Object.fromEntries(keys.map((key) => [key, changed[key]])),
    );
    const down = setup({ local: changed, service: state(5, agreed), base: baseOf(4, changed) });
    expect(await down.sync.run(CONNECTION, never)).toBe("synced");
    for (const key of keys) expect(down.local()?.settings).not.toHaveProperty(key);
  });

  it("merges the sites that ask for the master password per site, like exclusions", () => {
    const base = syncedSettings({ ...agreed, repromptSites: [site("bank.example")] });
    // This device stopped asking on bank.example and started on shop.example; the service
    // started on mail.example.
    const local = syncedSettings({ ...agreed, repromptSites: [site("shop.example")] });
    const service = syncedSettings({
      ...agreed,
      repromptSites: [site("bank.example"), site("mail.example")],
    });
    expect(
      mergeSyncedSettings({ service: base, local: base }, local, service).repromptSites,
    ).toEqual([site("mail.example"), site("shop.example")]);
  });

  it("merges the popup's This page choice like one entry", () => {
    const shown = syncedSettings(agreed);
    const hidden = syncedSettings({ ...agreed, popupPageSection: false });
    // A document without the choice shows the section.
    expect(shown.popupPageSection).toBe(true);
    const merge = (base: typeof shown, local: typeof shown, service: typeof shown) =>
      mergeSyncedSettings({ service: base, local: base }, local, service).popupPageSection;
    // Hidden on this device only: uploaded.
    expect(merge(shown, hidden, shown)).toBe(false);
    // Hidden on another device: applied here.
    expect(merge(shown, shown, hidden)).toBe(false);
    // Shown again on another device while this one kept it hidden: the service wins.
    expect(merge(hidden, hidden, shown)).toBe(true);
    // Shown again on this device: uploaded.
    expect(merge(hidden, shown, hidden)).toBe(true);
  });

  it("uploads the popup's This page choice made on this device", async () => {
    const {
      sync,
      service,
      local: after,
    } = setup({
      local: { ...agreed, popupPageSection: false },
      service: state(4, agreed),
      base: baseOf(4, agreed),
    });
    expect(await sync.run(CONNECTION, never)).toBe("synced");
    expect(service()).toMatchObject({ revision: 5, settings: { popupPageSection: false } });
    expect(after()!.settings.popupPageSection).toBe(false);
  });

  it("applies a default that differs only in its item name once, then stays settled", async () => {
    const named = { ...account("https://bank.example"), itemName: "Example Bank" };
    const serviceSettings = { ...agreed, siteDefaults: [named] };
    const {
      sync,
      transport,
      local: after,
    } = setup({
      local: agreed,
      service: state(5, serviceSettings),
      base: baseOf(4, agreed),
    });
    expect(await sync.run(CONNECTION, never)).toBe("synced");
    expect(transport.saveSettings).not.toHaveBeenCalled();
    expect(after()!.settings.siteDefaults).toEqual([named]);
    const revision = after()!.revision;
    expect(await sync.run(CONNECTION, never)).toBe("synced");
    expect(transport.saveSettings).not.toHaveBeenCalled();
    expect(after()!.revision).toBe(revision);
  });

  it("syncs the sites whose passkey requests go to the browser, per hostname", async () => {
    const withSites = {
      ...agreed,
      passkeyBrowserSites: [{ hostname: "bank.example" }, { hostname: "shop.example" }],
    };
    const {
      sync,
      service,
      local: after,
    } = setup({
      // Added on this device by "Always for this site", and one removed in its settings.
      local: { ...withSites, passkeyBrowserSites: [{ hostname: "new.example" }] },
      // Another device added one meanwhile.
      service: state(5, {
        ...withSites,
        passkeyBrowserSites: [...withSites.passkeyBrowserSites, { hostname: "other.example" }],
      }),
      base: baseOf(4, withSites),
    });
    expect(await sync.run(CONNECTION, never)).toBe("synced");
    const sorted = (sites: { hostname: string }[] | undefined) =>
      sites?.map((entry) => entry.hostname).sort();
    expect(sorted(service().settings?.passkeyBrowserSites)).toEqual([
      "new.example",
      "other.example",
    ]);
    expect(sorted(after()?.settings.passkeyBrowserSites)).toEqual(["new.example", "other.example"]);
  });

  it("removes an entry deleted on this device from the service", async () => {
    const { sync, service } = setup({
      local: { ...agreed, excludedSites: [] },
      service: state(4, agreed),
      base: baseOf(4, agreed),
    });
    await sync.run(CONNECTION, never);
    expect(service().settings?.excludedSites).toEqual([]);
  });

  it("merges again when the service changed during the write", async () => {
    const { sync, transport, service, setService } = setup({
      local: { ...agreed, excludedSites: [] },
      service: state(4, agreed),
      base: baseOf(4, agreed),
    });
    transport.settings.mockImplementationOnce(async () => {
      const read = { kind: "state" as const, state: state(4, agreed) };
      setService(state(5, { ...agreed, bindings: [] }));
      return read;
    });
    expect(await sync.run(CONNECTION, never)).toBe("synced");
    expect(transport.saveSettings).toHaveBeenCalledTimes(2);
    expect(service()).toEqual(
      state(6, { ...agreed, excludedSites: [], repromptSites: [], bindings: [] }),
    );
  });

  it("merges again when local settings changed during the sync", async () => {
    const {
      sync,
      store,
      transport,
      local: after,
    } = setup({
      local: agreed,
      service: state(5, { ...agreed, excludedSites: [] }),
      base: baseOf(4, agreed),
    });
    transport.settings.mockImplementationOnce(async () => {
      // An automatic account choice saved while the service was being read.
      await store.update(undefined, "account-choice", (snapshot) => ({
        ...snapshot,
        settings: {
          ...snapshot.settings,
          siteDefaults: [...snapshot.settings.siteDefaults, account("https://shop.example")],
        },
      }));
      return { kind: "state", state: state(5, { ...agreed, excludedSites: [] }) };
    });
    expect(await sync.run(CONNECTION, never)).toBe("synced");
    expect(after()?.settings.excludedSites).toEqual([]);
    expect(after()?.settings.siteDefaults).toContainEqual(account("https://shop.example"));
  });

  it("writes nothing for a device disconnected during the sync", async () => {
    let gone = false;
    const {
      sync,
      transport,
      storage,
      local: after,
    } = setup({
      local: agreed,
      service: state(5, { ...agreed, excludedSites: [] }),
      base: baseOf(4, agreed),
    });
    transport.settings.mockImplementationOnce(async () => {
      gone = true;
      return { kind: "state", state: state(5, { ...agreed, excludedSites: [] }) };
    });
    expect(await sync.run(CONNECTION, () => gone)).toBe("busy");
    expect(after()?.revision).toBe(7);
    expect(storage.write).not.toHaveBeenCalled();
  });

  it.each([
    [{ kind: "rejected" } as const, "rejected"],
    [{ kind: "failed", error: "unreachable" } as const, "unreachable"],
  ])("reports %o without changing anything", async (result, outcome) => {
    const { sync, transport, local: after } = setup({ local: agreed, base: baseOf(4, agreed) });
    transport.settings.mockResolvedValueOnce(result);
    expect(await sync.run(CONNECTION, never)).toBe(outcome);
    expect(after()?.revision).toBe(7);
  });

  it("treats a reordered copy as unchanged", async () => {
    const reordered = settingsOf({
      excludedSites: [site("b.example"), site("a.example")],
    });
    const {
      sync,
      transport,
      local: after,
    } = setup({
      local: reordered,
      service: state(4, settingsOf({ excludedSites: [site("a.example"), site("b.example")] })),
      base: baseOf(4, settingsOf({ excludedSites: [site("a.example"), site("b.example")] })),
    });
    expect(await sync.run(CONNECTION, never)).toBe("synced");
    expect(transport.saveSettings).not.toHaveBeenCalled();
    expect(after()?.revision).toBe(7);
  });

  it("merges a local edit made between reading and writing local settings", async () => {
    const {
      sync,
      store,
      local: after,
    } = setup({
      local: agreed,
      service: state(5, { ...agreed, excludedSites: [] }),
      base: baseOf(4, agreed),
    });
    const read = store.read.bind(store);
    vi.spyOn(store, "read").mockImplementationOnce(async () => {
      const snapshot = await read();
      await store.update(undefined, "settings-save", (current) => ({
        ...current,
        settings: { ...current.settings, siteDefaults: [] },
      }));
      return snapshot;
    });
    expect(await sync.run(CONNECTION, never)).toBe("synced");
    expect(after()?.settings.excludedSites).toEqual([]);
    expect(after()?.settings.siteDefaults).toEqual([]);
  });

  it("does not restore a service removal when the local write must merge again", async () => {
    const {
      sync,
      store,
      transport,
      service,
      local: after,
    } = setup({
      local: { ...agreed, siteDefaults: [] },
      service: state(5, { ...agreed, excludedSites: [] }),
      base: baseOf(4, agreed),
    });
    const save = transport.saveSettings.getMockImplementation()!;
    transport.saveSettings.mockImplementationOnce(async (...args) => {
      const result = await save(...args);
      // An unrelated local edit after the upload makes the local write conflict.
      await store.update(undefined, "settings-save", (current) => ({
        ...current,
        settings: { ...current.settings, bindings: [] },
      }));
      return result;
    });
    expect(await sync.run(CONNECTION, never)).toBe("synced");
    expect(after()?.settings.excludedSites).toEqual([]);
    expect(service().settings?.excludedSites).toEqual([]);
    expect(after()?.settings.bindings).toEqual([]);
    expect(service().settings?.bindings).toEqual([]);
  });

  it("keeps a local edit to an entry made while its upload was in flight", async () => {
    const {
      sync,
      store,
      transport,
      service,
      local: after,
    } = setup({
      local: { ...agreed, siteDefaults: [account("https://bank.example", "item-b")] },
      service: state(5, { ...agreed, excludedSites: [] }),
      base: baseOf(4, agreed),
    });
    const save = transport.saveSettings.getMockImplementation()!;
    transport.saveSettings.mockImplementationOnce(async (...args) => {
      const result = await save(...args);
      await store.update(undefined, "settings-save", (current) => ({
        ...current,
        settings: {
          ...current.settings,
          siteDefaults: [account("https://bank.example", "item-c")],
        },
      }));
      return result;
    });
    expect(await sync.run(CONNECTION, never)).toBe("synced");
    expect(after()?.settings.siteDefaults).toEqual([account("https://bank.example", "item-c")]);
    expect(after()?.settings.excludedSites).toEqual([]);
    expect(service().settings?.siteDefaults).toEqual([account("https://bank.example", "item-c")]);
  });

  it("starts over when the service holds other settings at the same revision", async () => {
    const { sync, local: after } = setup({
      local: agreed,
      // Restored from elsewhere: same revision, without the entries this base has.
      service: state(4, settingsOf()),
      base: baseOf(4, agreed),
    });
    expect(await sync.run(CONNECTION, never)).toBe("synced");
    expect(syncedSettings(after()!.settings)).toEqual(syncedSettings(agreed));
  });

  it("gives up after repeated conflicts", async () => {
    const { sync, transport } = setup({
      local: { ...agreed, excludedSites: [] },
      service: state(4, agreed),
      base: baseOf(4, agreed),
    });
    transport.saveSettings.mockResolvedValue({ kind: "conflict", current: state(4, agreed) });
    expect(await sync.run(CONNECTION, never)).toBe("busy");
    expect(transport.saveSettings).toHaveBeenCalledTimes(MAX_SETTINGS_SYNC_ATTEMPTS);
  });

  it.each([
    [{ kind: "rejected" } as const, "rejected"],
    [{ kind: "failed", error: "rate-limited" } as const, "rate-limited"],
    [{ kind: "limited" } as const, "settings-limit"],
  ])("stops when the write answers %o", async (result, outcome) => {
    const {
      sync,
      transport,
      local: after,
      storage,
      base,
    } = setup({
      local: { ...agreed, excludedSites: [] },
      service: state(4, agreed),
      base: baseOf(4, agreed),
    });
    transport.saveSettings.mockResolvedValueOnce(result);
    expect(await sync.run(CONNECTION, never)).toBe(outcome);
    expect(after()?.revision).toBe(7);
    // Only the upload was recorded, as pending, beside the unchanged base.
    expect(storage.write).toHaveBeenCalledOnce();
    expect(base()).toEqual({
      ...baseOf(4, agreed),
      pending: {
        writeId: expect.any(String),
        profileId: PROFILE,
        revision: 5,
        settings: settingsOf({ ...agreed, excludedSites: [] }),
        local: settingsOf({ ...agreed, excludedSites: [] }),
      },
    });
  });

  it("keeps pending edits across a composed-size failure and worker restart, then syncs later edits on recovery", async () => {
    const local = { ...agreed, excludedSites: [] };
    const h = setup({ local, service: state(4, agreed), base: baseOf(4, agreed) });
    h.transport.saveSettings.mockResolvedValueOnce({ kind: "limited" });
    expect(await h.sync.run(CONNECTION, never)).toBe("settings-limit");
    expect(h.local()?.settings).toEqual(local);
    expect(h.service()).toEqual(state(4, agreed));
    expect(h.base()).toMatchObject({ revision: 4, settings: agreed, pending: { settings: local } });
    expect(h.applied).not.toHaveBeenCalled();
    await h.store.update(undefined, "settings-save", (snapshot) => ({
      ...snapshot,
      settings: { ...snapshot.settings, language: "ja" },
    }));
    expect(await h.restart().run(CONNECTION, never)).toBe("synced");
    expect(h.local()?.settings).toMatchObject({ excludedSites: [], language: "ja" });
    expect(h.service().settings).toMatchObject({ excludedSites: [], language: "ja" });
    expect(h.base()).not.toHaveProperty("pending");
  });

  it("changes neither side when the merge exceeds the entry limits", async () => {
    const sites = (prefix: string) =>
      Array.from({ length: 600 }, (_, index) => site(`${prefix}-${index}.example`));
    const {
      sync,
      transport,
      local: after,
    } = setup({
      local: settingsOf({ excludedSites: sites("local") }),
      service: state(4, settingsOf({ excludedSites: sites("service") })),
      base: baseOf(3, settingsOf()),
    });
    expect(await sync.run(CONNECTION, never)).toBe("too-large");
    expect(transport.saveSettings).not.toHaveBeenCalled();
    expect(after()?.revision).toBe(7);
  });

  it("refuses an upload over the service's body limit", async () => {
    const long = "x".repeat(150);
    const bindings = Array.from({ length: 400 }, (_, index) => ({
      ...binding(`https://site-${index}.example`),
      itemName: long,
      slots: [{ slot: "password", field: { custom: long } }],
    }));
    const { sync, transport } = setup({ local: settingsOf({ bindings }) });
    expect(await sync.run(CONNECTION, never)).toBe("too-large");
    expect(transport.saveSettings).not.toHaveBeenCalled();
  });

  it("applies a service document over the upload limit when nothing needs uploading", async () => {
    const long = "x".repeat(150);
    const bindings = Array.from({ length: 400 }, (_, index) => ({
      ...binding(`https://site-${index}.example`),
      itemName: long,
      slots: [{ slot: "password", field: { custom: long } }],
    }));
    const {
      sync,
      transport,
      local: after,
    } = setup({
      local: settingsOf(),
      service: state(4, settingsOf({ bindings })),
    });
    expect(await sync.run(CONNECTION, never)).toBe("synced");
    expect(transport.saveSettings).not.toHaveBeenCalled();
    expect(after()?.settings.bindings).toHaveLength(400);
  });

  it("waits to change local settings while a login is running", async () => {
    let running = true;
    const {
      sync,
      service,
      local: after,
      applied,
    } = setup({
      local: { ...agreed, siteDefaults: [] },
      service: state(5, { ...agreed, excludedSites: [] }),
      base: baseOf(4, agreed),
      deferred: () => running,
    });
    expect(await sync.run(CONNECTION, never)).toBe("busy");
    // The local removal still reaches the service; only the local write waits.
    expect(service().settings?.siteDefaults).toEqual([]);
    expect(after()?.revision).toBe(7);
    expect(applied).not.toHaveBeenCalled();
    running = false;
    expect(await sync.run(CONNECTION, never)).toBe("synced");
    expect(after()?.settings.excludedSites).toEqual([]);
    expect(after()?.settings.siteDefaults).toEqual([]);
  });

  it("keeps a local edit made while a merge waited for a login", async () => {
    let running = true;
    const {
      sync,
      store,
      service,
      local: after,
    } = setup({
      local: { ...agreed, siteDefaults: [account("https://bank.example", "item-b")] },
      service: state(5, { ...agreed, excludedSites: [] }),
      base: baseOf(4, agreed),
      deferred: () => running,
    });
    expect(await sync.run(CONNECTION, never)).toBe("busy");
    await store.update(undefined, "settings-save", (current) => ({
      ...current,
      settings: { ...current.settings, siteDefaults: [account("https://bank.example", "item-c")] },
    }));
    running = false;
    expect(await sync.run(CONNECTION, never)).toBe("synced");
    expect(after()?.settings.siteDefaults).toEqual([account("https://bank.example", "item-c")]);
    expect(after()?.settings.excludedSites).toEqual([]);
    expect(service().settings?.siteDefaults).toEqual([account("https://bank.example", "item-c")]);
  });

  it("keeps a local edit to an entry the service changed while the write waited", async () => {
    let running = true;
    const {
      sync,
      store,
      service,
      base,
      local: after,
    } = setup({
      local: { ...agreed, excludedSites: [] },
      service: state(5, { ...agreed, siteDefaults: [account("https://bank.example", "item-s")] }),
      base: baseOf(4, agreed),
      deferred: () => running,
    });
    expect(await sync.run(CONNECTION, never)).toBe("busy");
    expect(base()).toMatchObject({ revision: 6 });
    expect(service().settings?.siteDefaults).toEqual([account("https://bank.example", "item-s")]);
    await store.update(undefined, "settings-save", (current) => ({
      ...current,
      settings: { ...current.settings, siteDefaults: [account("https://bank.example", "item-c")] },
    }));
    running = false;
    expect(await sync.run(CONNECTION, never)).toBe("synced");
    expect(after()?.settings.siteDefaults).toEqual([account("https://bank.example", "item-c")]);
    expect(service().settings?.siteDefaults).toEqual([account("https://bank.example", "item-c")]);
    expect(service().settings?.excludedSites).toEqual([]);
  });

  it("stops waiting for a login left unfinished", async () => {
    let time = 0;
    const { sync, local: after } = setup({
      local: agreed,
      service: state(5, { ...agreed, excludedSites: [] }),
      base: baseOf(4, agreed),
      deferred: () => true,
      now: () => time,
    });
    expect(await sync.run(CONNECTION, never)).toBe("busy");
    time += MAX_SETTINGS_DEFER_MS;
    expect(await sync.run(CONNECTION, never)).toBe("synced");
    expect(after()?.settings.excludedSites).toEqual([]);
  });

  it("counts the wait for a login across service worker restarts", async () => {
    let time = 0;
    const { restart, local: after } = setup({
      local: agreed,
      service: state(5, { ...agreed, excludedSites: [] }),
      base: baseOf(4, agreed),
      deferred: () => true,
      now: () => time,
    });
    expect(await restart().run(CONNECTION, never)).toBe("busy");
    time += MAX_SETTINGS_DEFER_MS / 2;
    expect(await restart().run(CONNECTION, never)).toBe("busy");
    time += MAX_SETTINGS_DEFER_MS / 2;
    expect(await restart().run(CONNECTION, never)).toBe("synced");
    expect(after()?.settings.excludedSites).toEqual([]);
  });

  it("starts the wait again when the stored start is in the future", async () => {
    const { sync, hold } = setup({
      local: agreed,
      service: state(5, { ...agreed, excludedSites: [] }),
      base: baseOf(4, agreed),
      deferred: () => true,
      now: () => 1000,
    });
    await hold.write(1000 + MAX_SETTINGS_DEFER_MS * 10);
    expect(await sync.run(CONNECTION, never)).toBe("busy");
    expect(await hold.read()).toBe(1000);
  });

  it.each(["read", "write"] as const)(
    "writes local settings when the stored wait fails to %s",
    async (method) => {
      const {
        sync,
        hold,
        local: after,
      } = setup({
        local: agreed,
        service: state(5, { ...agreed, excludedSites: [] }),
        base: baseOf(4, agreed),
        deferred: () => true,
      });
      hold[method].mockRejectedValue(new Error("synthetic storage failure"));
      expect(await sync.run(CONNECTION, never)).toBe("synced");
      expect(after()?.settings.excludedSites).toEqual([]);
    },
  );

  it("forgets the wait on disconnect", async () => {
    const { sync, hold } = setup({
      local: agreed,
      service: state(5, { ...agreed, excludedSites: [] }),
      base: baseOf(4, agreed),
      deferred: () => true,
    });
    expect(await sync.run(CONNECTION, never)).toBe("busy");
    expect(await hold.read()).toBeTypeOf("number");
    await sync.clear();
    expect(await hold.read()).toBeUndefined();
  });

  it("forgets the wait once the local write is done", async () => {
    // Running when the first sync starts and decides; the second sync sees the login
    // still running at its start but finished when it writes.
    const answers = [true, true, true, false];
    const { sync, hold } = setup({
      local: agreed,
      service: state(5, { ...agreed, excludedSites: [] }),
      base: baseOf(4, agreed),
      deferred: () => answers.shift() ?? false,
    });
    expect(await sync.run(CONNECTION, never)).toBe("busy");
    expect(await hold.read()).toBeTypeOf("number");
    expect(await sync.run(CONNECTION, never)).toBe("synced");
    expect(await hold.read()).toBeUndefined();
  });

  it("waits the full time again for a later login", async () => {
    let time = 0;
    let running = true;
    const {
      sync,
      transport,
      local: after,
    } = setup({
      local: agreed,
      service: state(5, { ...agreed, excludedSites: [] }),
      base: baseOf(4, agreed),
      deferred: () => running,
      now: () => time,
    });
    expect(await sync.run(CONNECTION, never)).toBe("busy");
    // The login ends, but the next sync cannot reach the service.
    running = false;
    transport.settings.mockResolvedValueOnce({ kind: "failed", error: "unreachable" });
    expect(await sync.run(CONNECTION, never)).toBe("unreachable");
    time += MAX_SETTINGS_DEFER_MS;
    running = true;
    expect(await sync.run(CONNECTION, never)).toBe("busy");
    expect(after()?.revision).toBe(7);
  });

  it.each([
    ["the login ends", true],
    ["the login keeps running", false],
  ])(
    "writes nothing locally after a disconnect while checking whether %s",
    async (_name, ended) => {
      let gone = false;
      let calls = 0;
      const {
        sync,
        hold,
        local: after,
      } = setup({
        local: agreed,
        service: state(5, { ...agreed, excludedSites: [] }),
        base: baseOf(4, agreed),
        // Running when the sync starts; the device is disconnected during the second check.
        deferred: () => {
          calls += 1;
          if (calls === 1) return true;
          gone = true;
          return !ended;
        },
      });
      expect(await sync.run(CONNECTION, () => gone)).toBe("busy");
      expect(hold.write).not.toHaveBeenCalled();
      expect(after()?.revision).toBe(7);
    },
  );

  it("does not upload for a device disconnected before the merge", async () => {
    const { sync, transport } = setup({
      local: { ...agreed, excludedSites: [] },
      service: state(4, agreed),
      base: baseOf(4, agreed),
    });
    expect(await sync.run(CONNECTION, () => true)).toBe("busy");
    expect(transport.saveSettings).not.toHaveBeenCalled();
  });

  it("forgets the base on disconnect", async () => {
    const { sync, base } = setup({ base: baseOf(4, agreed) });
    await sync.clear();
    expect(base()).toBeUndefined();
  });
}
