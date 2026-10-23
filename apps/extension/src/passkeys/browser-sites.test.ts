import {
  createDefaultSettings,
  type SettingsChangeCause,
  type SettingsSnapshot,
} from "@pateat/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";
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
  afterEach(() => vi.useRealTimers());

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

  it("waits for a running login, which the write would stop, up to its limit", async () => {
    vi.useFakeTimers();
    const { settings, current } = store();
    let active = true;
    const added = addPasskeyBrowserSite({
      settings,
      origin: "https://bank.example",
      loginActive: async () => active,
      maxWaitMs: 60_000,
    });
    await vi.advanceTimersByTimeAsync(5_000);
    expect(settings.update).not.toHaveBeenCalled();
    active = false;
    await vi.advanceTimersByTimeAsync(1_000);
    expect(await added).toBe(true);
    expect(current().settings.passkeyBrowserSites).toEqual([{ hostname: "bank.example" }]);

    // A login left unfinished does not hold the choice back for longer.
    const stuck = store();
    const late = addPasskeyBrowserSite({
      settings: stuck.settings,
      origin: "https://bank.example",
      loginActive: async () => true,
      maxWaitMs: 60_000,
    });
    await vi.advanceTimersByTimeAsync(59_000);
    expect(stuck.settings.update).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(2_000);
    expect(await late).toBe(true);
  });
});

function sessionValue(initial: unknown = null) {
  let value = initial;
  return {
    getValue: vi.fn(async () => structuredClone(value)),
    setValue: vi.fn(async (next: unknown) => {
      value = structuredClone(next);
    }),
    current: () => value,
  };
}

describe("the sites the passkey runtime hands on", () => {
  afterEach(() => vi.useRealTimers());

  it("holds a chosen hostname at once, while its write waits for a running login", async () => {
    vi.useFakeTimers();
    const { settings, current } = store();
    const pending = sessionValue();
    const added = vi.fn();
    let active = true;
    const sites = createPasskeyBrowserSites({
      settings,
      pending,
      loginActive: async () => active,
      maxWaitMs: 60_000,
      added,
    });
    expect(await sites.has("https://bank.example")).toBe(false);
    const chosenAt = Date.now();
    const adding = sites.add("https://bank.example:8443");
    // Written to storage.session before the wait, so it holds across a worker restart.
    await vi.waitFor(() =>
      expect(pending.current()).toEqual([{ hostname: "bank.example", at: chosenAt }]),
    );
    expect(await sites.has("https://bank.example/login")).toBe(true);
    // A login sees it too, so it takes no passkey route there.
    expect(sites.pending("https://bank.example")).toBe(true);
    expect(sites.pending("https://other.example")).toBe(false);
    expect(await sites.has("https://other.example")).toBe(false);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(settings.update).not.toHaveBeenCalled();
    active = false;
    await vi.advanceTimersByTimeAsync(1_000);
    await adding;
    expect(current().settings.passkeyBrowserSites).toEqual([{ hostname: "bank.example" }]);
    expect(added).toHaveBeenCalledOnce();
    // Forgotten once the synced write landed; the settings now list it.
    expect(pending.current()).toBeNull();
    expect(sites.pending("https://bank.example")).toBe(false);
    expect(await sites.has("https://bank.example")).toBe(true);
  });

  it("drops a pending hostname whose write was refused", async () => {
    const { settings } = store();
    settings.update.mockRejectedValueOnce(new Error("storage-unavailable"));
    const pending = sessionValue();
    const added = vi.fn();
    const sites = createPasskeyBrowserSites({ settings, pending, added });
    await expect(sites.add("https://bank.example")).rejects.toThrow("storage-unavailable");
    expect(pending.current()).toBeNull();
    expect(await sites.has("https://bank.example")).toBe(false);
    expect(added).not.toHaveBeenCalled();
  });

  it("resumes the waits a worker restart stopped, within the wait limit", async () => {
    const { settings, current } = store();
    const { promise: ended, resolve: end } = Promise.withResolvers<void>();
    const now = 1_000_000;
    const pending = sessionValue([
      { hostname: "bank.example", at: now - 30_000 },
      { hostname: "Not A Host", at: now - 30_000 },
    ]);
    const sites = createPasskeyBrowserSites({
      settings,
      pending,
      maxWaitMs: 120_000,
      now: () => now,
      loginActive: async () => {
        await ended;
        return false;
      },
    });
    expect(await sites.has("https://bank.example")).toBe(true);
    end();
    await vi.waitFor(() =>
      expect(current().settings.passkeyBrowserSites).toEqual([{ hostname: "bank.example" }]),
    );
    await vi.waitFor(() => expect(pending.current()).toBeNull());
    expect(await sites.has("https://bank.example")).toBe(true);
  });

  it("never writes again after a restart once a write started or the wait limit passed", async () => {
    // The write landed, then the site was removed on the settings page; the clear of the
    // pending copy was lost with the worker.
    const { settings } = store();
    const now = 1_000_000;
    const pending = sessionValue([
      { hostname: "removed.example", at: now - 10_000, writing: true },
      { hostname: "old.example", at: now - 120_000 },
    ]);
    const sites = createPasskeyBrowserSites({
      settings,
      pending,
      maxWaitMs: 120_000,
      now: () => now,
    });
    expect(await sites.has("https://removed.example")).toBe(false);
    expect(await sites.has("https://old.example")).toBe(false);
    await vi.waitFor(() => expect(pending.current()).toBeNull());
    await new Promise((done) => setTimeout(done, 10));
    expect(settings.update).not.toHaveBeenCalled();
  });

  it("marks a write as started before it writes", async () => {
    const { settings } = store();
    const pending = sessionValue();
    const seen: unknown[] = [];
    settings.update.mockImplementationOnce(async () => {
      seen.push(structuredClone(pending.current()));
      throw new Error("storage-unavailable");
    });
    const sites = createPasskeyBrowserSites({ settings, pending, now: () => 5 });
    await expect(sites.add("https://bank.example")).rejects.toThrow("storage-unavailable");
    expect(seen).toEqual([[{ hostname: "bank.example", at: 5, writing: true }]]);
  });

  it("reads the settings once until they change", async () => {
    const { settings } = store([{ hostname: "bank.example" }]);
    const sites = createPasskeyBrowserSites({ settings, pending: sessionValue() });
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

  it("reads again after a failed read, which hands on", async () => {
    const { settings } = store();
    // The read ahead of the first request fails, and so does the one it makes.
    settings.read
      .mockRejectedValueOnce(new Error("storage-unavailable"))
      .mockRejectedValueOnce(new Error("storage-unavailable"));
    const sites = createPasskeyBrowserSites({ settings, pending: sessionValue() });
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
