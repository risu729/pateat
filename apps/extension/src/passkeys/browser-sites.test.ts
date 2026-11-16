import {
  createDefaultSettings,
  type SettingsChangeCause,
  type SettingsSnapshot,
} from "@pateat/contracts";
import { describe, expect, it, vi } from "vitest";
import {
  addPasskeyBrowserSite,
  createPasskeyBrowserSites,
  watchSettingsWrites,
} from "./browser-sites";

function store(passkeyBrowserSites: { hostname: string }[] = []) {
  let snapshot: SettingsSnapshot = {
    version: 1,
    revision: 3,
    settings: { ...createDefaultSettings({ connections: [] }), passkeyBrowserSites },
  };
  const settings = {
    read: vi.fn(async () => structuredClone(snapshot)),
    update: vi.fn(
      async (
        expectedRevision: number | undefined,
        _cause: SettingsChangeCause,
        mutate: (current: SettingsSnapshot) => SettingsSnapshot,
      ) => {
        if (expectedRevision !== undefined && expectedRevision !== snapshot.revision)
          throw new Error("revision-conflict");
        snapshot = { ...mutate(structuredClone(snapshot)), revision: snapshot.revision + 1 };
        return structuredClone(snapshot);
      },
    ),
  };
  return { settings, current: () => snapshot };
}

describe("adding a site whose passkey requests go to the browser", () => {
  it("adds the origin's exact hostname, without its scheme, port or subdomains", async () => {
    const { settings, current } = store([{ hostname: "other.example" }]);
    expect(
      await addPasskeyBrowserSite({ settings, origin: "https://Login.Bank.example:8443" }),
    ).toBe(true);
    expect(current().settings.passkeyBrowserSites).toEqual([
      { hostname: "other.example" },
      { hostname: "login.bank.example" },
    ]);
    expect(current().revision).toBe(4);
    // A save conflict on the settings page names this cause (ADR 0025).
    expect(settings.update).toHaveBeenCalledWith(
      undefined,
      "passkey-browser-site",
      expect.any(Function),
    );
  });

  it("writes nothing for a listed hostname, an invalid origin or a full list", async () => {
    const listed = store([{ hostname: "bank.example" }]);
    expect(
      await addPasskeyBrowserSite({ settings: listed.settings, origin: "https://bank.example" }),
    ).toBe(false);
    expect(
      await addPasskeyBrowserSite({
        settings: listed.settings,
        origin: "https://user@bank.example",
      }),
    ).toBe(false);
    expect(listed.settings.update).not.toHaveBeenCalled();
    const full = store(
      Array.from({ length: 1000 }, (_, index) => ({ hostname: `s${index}.example` })),
    );
    expect(
      await addPasskeyBrowserSite({ settings: full.settings, origin: "https://bank.example" }),
    ).toBe(false);
    expect(full.settings.update).not.toHaveBeenCalled();
  });
});

describe("the sites the passkey runtime hands on", () => {
  it("writes a chosen hostname at once and holds it while the write runs", async () => {
    const { settings, current } = store();
    const added = vi.fn();
    const sites = createPasskeyBrowserSites({ settings, added });
    expect(await sites.has("https://bank.example")).toBe(false);
    const { promise: landed, resolve: land } = Promise.withResolvers<void>();
    const update = settings.update.getMockImplementation()!;
    settings.update.mockImplementationOnce(async (...args) => {
      await landed;
      return update(...args);
    });
    const adding = sites.add("https://bank.example:8443");
    await vi.waitFor(() => expect(settings.update).toHaveBeenCalledOnce());
    // A running login need not end first: its revision is only this choice.
    expect(settings.update).toHaveBeenCalledWith(
      undefined,
      "passkey-browser-site",
      expect.any(Function),
    );
    expect(await sites.has("https://bank.example/login")).toBe(true);
    // A login sees it too, so it takes no passkey route there.
    expect(sites.pending("https://bank.example")).toBe(true);
    expect(sites.pending("https://other.example")).toBe(false);
    expect(await sites.has("https://other.example")).toBe(false);
    land();
    await adding;
    expect(current().settings.passkeyBrowserSites).toEqual([{ hostname: "bank.example" }]);
    expect(added).toHaveBeenCalledOnce();
    // Forgotten once the write landed; the settings now list it.
    expect(sites.pending("https://bank.example")).toBe(false);
    expect(await sites.has("https://bank.example")).toBe(true);
  });

  it("drops a pending hostname whose write was refused", async () => {
    const { settings } = store();
    settings.update.mockRejectedValueOnce(new Error("storage-unavailable"));
    const added = vi.fn();
    const sites = createPasskeyBrowserSites({ settings, added });
    await expect(sites.add("https://bank.example")).rejects.toThrow("storage-unavailable");
    expect(sites.pending("https://bank.example")).toBe(false);
    expect(await sites.has("https://bank.example")).toBe(false);
    expect(added).not.toHaveBeenCalled();
  });

  it("reads the settings once until they change", async () => {
    const { settings } = store([{ hostname: "bank.example" }]);
    const sites = createPasskeyBrowserSites({ settings });
    // Read ahead of the first request.
    expect(settings.read).toHaveBeenCalledOnce();
    expect(await sites.has("https://bank.example")).toBe(true);
    expect(await sites.has("https://other.example")).toBe(false);
    expect(settings.read).toHaveBeenCalledOnce();
    // Removed on the settings page.
    settings.read.mockResolvedValueOnce({
      version: 1,
      revision: 4,
      settings: createDefaultSettings({ connections: [] }),
    });
    sites.changed();
    expect(await sites.has("https://bank.example")).toBe(false);
    expect(settings.read).toHaveBeenCalledTimes(2);
  });

  it("lends its copy of the settings to the request's other reads, read again once changed", async () => {
    const { settings } = store([{ hostname: "bank.example" }]);
    const sites = createPasskeyBrowserSites({ settings });
    expect((await sites.settings()).passkeyBrowserSites).toEqual([{ hostname: "bank.example" }]);
    expect(settings.read).toHaveBeenCalledOnce();
    settings.read.mockResolvedValueOnce({
      version: 1,
      revision: 4,
      settings: createDefaultSettings({ connections: [] }),
    });
    sites.changed();
    expect((await sites.settings()).passkeyBrowserSites ?? []).toEqual([]);
    expect(settings.read).toHaveBeenCalledTimes(2);
  });

  it("reads again after a failed read, which hands on", async () => {
    const { settings } = store();
    // The read ahead of the first request fails, which that request hands on.
    settings.read.mockRejectedValueOnce(new Error("storage-unavailable"));
    const sites = createPasskeyBrowserSites({ settings });
    await expect(sites.has("https://bank.example")).rejects.toThrow("storage-unavailable");
    expect(await sites.has("https://bank.example")).toBe(false);
  });
});

describe("watching settings writes", () => {
  it("reads the list again on a write of the settings record only", () => {
    const listeners: ((changes: Record<string, unknown>) => void)[] = [];
    const changed = vi.fn();
    watchSettingsWrites(
      { addListener: (listener) => void listeners.push(listener) },
      "pateat.local-settings.v1",
      changed,
    );
    listeners[0]!({ "pateat.other.v1": { newValue: 1 } });
    expect(changed).not.toHaveBeenCalled();
    listeners[0]!({ "pateat.local-settings.v1": { newValue: {} } });
    expect(changed).toHaveBeenCalledOnce();
  });
});
