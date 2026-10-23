import {
  createDefaultSettings,
  type SettingsChangeCause,
  type SettingsSnapshot,
} from "@pateat/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";
import { addPasskeyBrowserSite } from "./browser-sites";

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
