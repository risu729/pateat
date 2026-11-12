import { expect, it, type Mock, vi } from "vitest";
import {
  createPasskeyRuntime,
  type PasskeyChoice,
  type PasskeyChooser,
  type PasskeyItem,
  type PasskeySource,
} from "../../src/passkeys/runtime";
import type { RuntimeFixtures } from "./runtime-context";

type Stored = (RuntimeFixtures["candidate"] & { preferred?: boolean }) & { item: string };

export function registerDuringLoginCases({
  extensionId,
  origin,
  sender,
  candidate,
  get,
  loginItem,
  siteDefault,
  ofLogin,
  vault,
  chooser,
}: Pick<RuntimeFixtures, "extensionId" | "origin" | "sender" | "candidate" | "get"> & {
  loginItem: PasskeyItem;
  siteDefault: Stored;
  ofLogin: Stored;
  vault: (stored: Stored[], complete?: boolean) => PasskeySource;
  chooser: () => { choose: Mock<() => Promise<PasskeyChoice>> };
}) {
  it("signs with the login's item even when the site default is another item", async () => {
    const backing = vault([siteDefault, ofLogin]);
    const loginAccount = vi.fn(() => loginItem);
    const remember = vi.fn(async () => {});
    const runtime = createPasskeyRuntime(backing, { extensionId, loginAccount, remember });
    expect(await runtime.handle(get(), sender())).toMatchObject({
      kind: "assertion",
      assertion: { credentialId: "CCCC" },
    });
    expect(loginAccount).toHaveBeenCalledWith(7, origin);
    expect(backing.candidates).toHaveBeenCalledWith(
      origin,
      "example.com",
      expect.any(AbortSignal),
      loginItem,
    );
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(remember).not.toHaveBeenCalled();
  });

  it("opens no chooser while a login runs, whatever the vault holds", async () => {
    const choose = chooser();
    const other: Stored = { ...candidate, credentialId: "DDDD", item: "other-item" };
    // Without the login, two items would make a choice; with it, its item answers alone.
    const several = createPasskeyRuntime(vault([other, ofLogin]), {
      extensionId,
      chooser: choose,
      loginAccount: async () => loginItem,
    });
    expect(await several.handle(get(), sender())).toMatchObject({
      assertion: { credentialId: "CCCC" },
    });
    // Two passkeys of the login's own item are never offered as a choice.
    const twice = createPasskeyRuntime(vault([ofLogin, { ...ofLogin, credentialId: "EEEE" }]), {
      extensionId,
      chooser: choose,
      loginAccount: async () => loginItem,
    });
    expect(await twice.handle(get(), sender())).toEqual({
      kind: "delegate",
      reason: "login-item-ambiguous-credential",
    });
    expect(choose.choose).not.toHaveBeenCalled();
  });

  it.each<[string, Stored[], boolean, string]>([
    ["the login's item has no passkey", [siteDefault], true, "login-item-no-credential"],
    ["the item's search is incomplete", [ofLogin], false, "login-item-vault-incomplete"],
    [
      "the item's passkey has a counter",
      [{ ...ofLogin, counter: 5 }],
      true,
      "login-item-unsupported-counter",
    ],
  ])("delegates to the browser when %s", async (_label, stored, complete, reason) => {
    const backing = vault(stored, complete);
    const choose = chooser();
    const runtime = createPasskeyRuntime(backing, {
      extensionId,
      chooser: choose,
      loginAccount: () => loginItem,
    });
    expect(await runtime.handle(get(), sender())).toEqual({ kind: "delegate", reason });
    expect(backing.sign).not.toHaveBeenCalled();
    expect(choose.choose).not.toHaveBeenCalled();
  });

  it("delegates when the login lookup fails", async () => {
    const backing = vault([siteDefault, ofLogin]);
    const runtime = createPasskeyRuntime(backing, {
      extensionId,
      loginAccount: async () => {
        throw new Error("storage unavailable");
      },
    });
    expect(await runtime.handle(get(), sender())).toMatchObject({ kind: "delegate" });
    expect(backing.sign).not.toHaveBeenCalled();
  });

  it("answers as before once the login has ended", async () => {
    const backing = vault([siteDefault, ofLogin]);
    const runtime = createPasskeyRuntime(backing, {
      extensionId,
      loginAccount: async () => undefined,
    });
    expect(await runtime.handle(get(), sender())).toMatchObject({
      kind: "assertion",
      assertion: { credentialId: "BBBB" },
    });
    expect(backing.candidates).toHaveBeenCalledWith(origin, "example.com", expect.any(AbortSignal));
    const choose = chooser();
    const other: Stored = { ...candidate, credentialId: "DDDD", item: "other-item" };
    const ended = createPasskeyRuntime(vault([other, ofLogin]), {
      extensionId,
      chooser: choose,
      loginAccount: () => undefined,
    });
    expect(await ended.handle(get(), sender())).toEqual({
      kind: "delegate",
      reason: "chooser-closed",
    });
    expect(choose.choose).toHaveBeenCalledTimes(1);
  });
}

export function registerAfterLoginCases({
  extensionId,
  sender,
  get,
  source,
  withDefault,
}: Pick<RuntimeFixtures, "extensionId" | "sender" | "get" | "source"> & {
  withDefault: (RuntimeFixtures["candidate"] & {
    preferred?: boolean;
    display: { item: string };
  })[];
}) {
  it("signs a single match again in that tab without asking, as after a logout", async () => {
    const choose = vi.fn<PasskeyChooser["choose"]>();
    const report = vi.fn();
    const runtime = createPasskeyRuntime(source(), {
      extensionId,
      chooser: { choose },
      report,
    });
    // The tab's first request signs, and so does the next one after a logout.
    const signed = { kind: "assertion", assertion: { credentialId: "AQID" } };
    expect(await runtime.handle(get(), sender())).toMatchObject(signed);
    expect(await runtime.handle(get(), sender())).toMatchObject(signed);
    expect(choose).not.toHaveBeenCalled();
    expect(report.mock.lastCall?.[0]).not.toHaveProperty("chooser");
  });

  it("signs with the site default again without asking when several match", async () => {
    const choose = vi.fn<PasskeyChooser["choose"]>();
    const runtime = createPasskeyRuntime(
      source({
        candidates: vi.fn(async () => ({
          candidates: withDefault,
          complete: true,
          siteDefault: "searched" as const,
        })),
      }),
      { extensionId, chooser: { choose } },
    );
    // The tab's first request signs, and so does the next one after a logout.
    const signed = { kind: "assertion", assertion: { credentialId: "AQID" } };
    expect(await runtime.handle(get(), sender())).toMatchObject(signed);
    expect(await runtime.handle(get(), sender())).toMatchObject(signed);
    expect(choose).not.toHaveBeenCalled();
  });
}
