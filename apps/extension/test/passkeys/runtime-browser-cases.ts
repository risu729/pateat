import { expect, it, vi } from "vitest";
import {
  createPasskeyRuntime,
  type ConditionalDecision,
  type PasskeyChoice,
  type PasskeyChooser,
  type PasskeySource,
} from "../../src/passkeys/runtime";
import type { RuntimeFixtures, RuntimeGet } from "./runtime-context";

export function registerReverificationCases({
  extensionId,
  origin,
  sender,
  get,
  source,
  named,
}: Pick<RuntimeFixtures, "extensionId" | "origin" | "sender" | "get" | "source"> & {
  named: () => Omit<RuntimeGet, "request"> & {
    request: Omit<RuntimeFixtures["request"], "allowCredentials"> & {
      allowCredentials: { type: string; id: string }[];
    };
  };
}) {
  it("hands a request naming its credentials on in the tab whose login signed in", async () => {
    const backing = source();
    const report = vi.fn();
    const reverification = vi.fn(
      async (tabId: number, page: string, rpId: string) =>
        tabId === 7 && page === origin && rpId === "example.com",
    );
    const runtime = createPasskeyRuntime(backing, { extensionId, reverification, report });
    expect(await runtime.handle(named(), sender())).toEqual({
      kind: "delegate",
      reason: "confirm-fill",
    });
    expect(backing.candidates).not.toHaveBeenCalled();
    expect(backing.sign).not.toHaveBeenCalled();
    await vi.waitFor(() =>
      expect(report).toHaveBeenCalledWith(
        expect.objectContaining({
          outcome: "delegate",
          reason: "confirm-fill",
          allowCredentials: 1,
        }),
      ),
    );
    // A username-less request there, as a sign-in after a logout, and a named one in
    // another tab are answered as before.
    expect(await runtime.handle(get(), sender())).toMatchObject({ kind: "assertion" });
    expect(await runtime.handle(named(), sender({ tab: { id: 8 } }))).toMatchObject({
      kind: "assertion",
    });
    expect(reverification).toHaveBeenCalledTimes(2);
  });

  it("delegates when the lookup fails, and answers as before without a login", async () => {
    const failing = createPasskeyRuntime(source(), {
      extensionId,
      reverification: async () => {
        throw new Error("synthetic");
      },
    });
    expect(await failing.handle(named(), sender())).toMatchObject({
      kind: "delegate",
      reason: "assertion-failed",
    });
    const none = createPasskeyRuntime(source(), {
      extensionId,
      reverification: async () => false,
    });
    expect(await none.handle(named(), sender())).toMatchObject({ kind: "assertion" });
  });
}

export function registerBrowserSiteCases({
  extensionId,
  origin,
  sender,
  get,
  source,
  several,
  withRequest,
}: Pick<RuntimeFixtures, "extensionId" | "origin" | "sender" | "get" | "source"> & {
  several: () => PasskeySource;
  withRequest: (overrides: Record<string, unknown>, userActivation?: boolean) => RuntimeGet;
}) {
  it.each([
    ["a modal request", withRequest({})],
    ["a required-mediation request", withRequest({ mediation: "required" })],
    ["a conditional request", withRequest({ mediation: "conditional" }, false)],
    ["an Immediate UI request", withRequest({ uiMode: "immediate" })],
    [
      "a request naming its credentials",
      withRequest({ allowCredentials: [{ type: "public-key", id: "AQID" }] }),
    ],
  ])("hands %s on, never signing, choosing or waiting for a login", async (_name, message) => {
    const backing = several();
    const choose = vi.fn<PasskeyChooser["choose"]>();
    const conditional = vi.fn<() => Promise<ConditionalDecision>>();
    const loginAccount = vi.fn(() => ({ connectionId: "personal", itemId: "login-item" }));
    const reverification = vi.fn(async () => true);
    const hold = vi.fn(async () => () => {});
    const report = vi.fn();
    const browserSite = vi.fn(async () => true);
    const runtime = createPasskeyRuntime(backing, {
      extensionId,
      chooser: { choose },
      conditional,
      loginAccount,
      reverification,
      hold,
      report,
      browserSite,
    });
    expect(await runtime.handle(message, sender())).toEqual({
      kind: "delegate",
      reason: "browser-site",
    });
    expect(browserSite).toHaveBeenCalledWith(origin);
    expect(backing.sign).not.toHaveBeenCalled();
    expect(choose).not.toHaveBeenCalled();
    expect(conditional).not.toHaveBeenCalled();
    await vi.waitFor(() =>
      expect(report).toHaveBeenCalledWith(
        expect.objectContaining({ outcome: "delegate", reason: "browser-site" }),
      ),
    );
  });

  it("answers as before on a site that is not listed", async () => {
    const browserSite = vi.fn(async () => false);
    const runtime = createPasskeyRuntime(source(), { extensionId, browserSite });
    expect(await runtime.handle(get(), sender())).toMatchObject({ kind: "assertion" });
    expect(browserSite).toHaveBeenCalledWith(origin);
  });

  it("hands the request on when the list cannot be read, naming that step", async () => {
    const backing = source();
    const report = vi.fn();
    const runtime = createPasskeyRuntime(backing, {
      extensionId,
      report,
      browserSite: async () => Promise.reject(new Error("storage-unavailable")),
    });
    expect(await runtime.handle(get(), sender())).toEqual({
      kind: "delegate",
      reason: "assertion-failed",
    });
    expect(backing.sign).not.toHaveBeenCalled();
    await vi.waitFor(() =>
      expect(report).toHaveBeenCalledWith(
        expect.objectContaining({ reason: "assertion-failed", cause: "browser-site-lookup" }),
      ),
    );
  });

  it.each([
    ["signs once the list shows no such site", false, { kind: "assertion" }],
    ["hands on once the list shows the site", true, { kind: "delegate", reason: "browser-site" }],
  ])("looks the passkey up while the list is read, and %s", async (_name, isListed, outcome) => {
    // The request's deadline runs as without the list: the lookup does not wait for it.
    const backing = source();
    const { promise: list, resolve } = Promise.withResolvers<boolean>();
    const runtime = createPasskeyRuntime(backing, { extensionId, browserSite: () => list });
    const pending = runtime.handle(get(), sender());
    await vi.waitFor(() => expect(backing.candidates).toHaveBeenCalled());
    await new Promise((done) => setTimeout(done, 10));
    expect(backing.sign).not.toHaveBeenCalled();
    resolve(isListed);
    expect(await pending).toMatchObject(outcome);
    expect(backing.sign).toHaveBeenCalledTimes(isListed ? 0 : 1);
  });

  it("hands on a listed site's request whose lookup failed", async () => {
    const runtime = createPasskeyRuntime(
      source({ candidates: vi.fn(async () => Promise.reject(new Error("vault"))) }),
      { extensionId, browserSite: async () => true },
    );
    expect(await runtime.handle(get(), sender())).toEqual({
      kind: "delegate",
      reason: "browser-site",
    });
  });

  it("adds the site after handing the request on when the person chooses always", async () => {
    const backing = several();
    const report = vi.fn();
    const addBrowserSite = vi.fn(async () => {});
    const runtime = createPasskeyRuntime(backing, {
      extensionId,
      report,
      chooser: { choose: vi.fn(async (): Promise<PasskeyChoice> => ({ kind: "browser-site" })) },
      browserSite: async () => false,
      addBrowserSite,
    });
    expect(await runtime.handle(get(), sender())).toEqual({
      kind: "delegate",
      reason: "chooser-browser-site",
    });
    expect(backing.sign).not.toHaveBeenCalled();
    // A settings save cancels pending requests, so it waits until the reply is on its way.
    expect(addBrowserSite).not.toHaveBeenCalled();
    await vi.waitFor(() => expect(addBrowserSite).toHaveBeenCalledWith(origin));
    expect(addBrowserSite).toHaveBeenCalledOnce();
    await vi.waitFor(() =>
      expect(report).toHaveBeenCalledWith(
        expect.objectContaining({ chooser: "browser-site", reason: "chooser-browser-site" }),
      ),
    );
  });

  it("adds nothing when the person hands on just once", async () => {
    const addBrowserSite = vi.fn(async () => {});
    const runtime = createPasskeyRuntime(several(), {
      extensionId,
      chooser: { choose: vi.fn(async (): Promise<PasskeyChoice> => ({ kind: "browser" })) },
      addBrowserSite,
    });
    expect(await runtime.handle(get(), sender())).toEqual({
      kind: "delegate",
      reason: "chooser-browser",
    });
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(addBrowserSite).not.toHaveBeenCalled();
  });

  it("follows the list as it is when each request comes in", async () => {
    let listed = true;
    const runtime = createPasskeyRuntime(source(), {
      extensionId,
      browserSite: async () => listed,
    });
    expect(await runtime.handle(get(), sender())).toEqual({
      kind: "delegate",
      reason: "browser-site",
    });
    // Removed on the settings page: the next request is answered again.
    listed = false;
    expect(await runtime.handle(get(), sender())).toMatchObject({ kind: "assertion" });
  });
}
