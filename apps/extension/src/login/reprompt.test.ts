import { describe, expect, it, vi } from "vitest";
import type { VaultConnectionMetadata, VaultItemMetadata } from "@pateat/contracts";
import type { PasskeyChooser } from "../passkeys/runtime";
import { createLoginReprompt, createVaultPasswordCheck } from "./reprompt";

const connection = {
  id: "connection-1",
  label: "Personal",
  snapshotId: "snapshot-1",
} as VaultConnectionMetadata;
const item = { id: "item-1", label: "Bank", reprompt: true } as VaultItemMetadata;
const account = { connectionId: "connection-1", itemId: "item-1" } as Parameters<
  ReturnType<typeof createLoginReprompt>
>[0]["account"];

function setup(
  answer: Awaited<ReturnType<PasskeyChooser["choose"]>>,
  tab = {
    active: true,
    focused: true,
    incognito: false,
  },
) {
  const choose = vi.fn<PasskeyChooser["choose"]>(async () => answer);
  const check = vi.fn(
    async (_connection: VaultConnectionMetadata, password: string) => password === "right",
  );
  const ask = createLoginReprompt({
    chooser: () => ({ choose }),
    check,
    tab: async () => tab,
  });
  const input = {
    tabId: 7,
    origin: "https://bank.example",
    account,
    connection,
    item,
    signal: new AbortController().signal,
  };
  return { choose, check, ask, input };
}

describe("login master password re-prompt", () => {
  it("asks in the chooser window for the login's one item and checks the password", async () => {
    const { choose, check, ask, input } = setup({ kind: "chosen", index: 0, makeDefault: false });
    expect(await ask(input)).toBe("verified");
    expect(choose).toHaveBeenCalledOnce();
    const asked = choose.mock.calls[0]![0];
    expect(asked).toMatchObject({
      tabId: 7,
      origin: "https://bank.example",
      rpId: "bank.example",
      entries: [{ item: "Bank", account: "Personal", reprompt: true }],
      purpose: "login",
      again: false,
    });
    expect(await asked.verify!(0, "right")).toBe(true);
    expect(await asked.verify!(0, "wrong")).toBe(false);
    expect(check).toHaveBeenCalledWith(connection, "right");
  });

  it.each([
    ["closed", { kind: "closed" }],
    ["unavailable", { kind: "unavailable" }],
    ["closed", { kind: "browser" }],
  ] as const)("answers %s for a window that answered %j", async (expected, answer) => {
    const { ask, input } = setup(answer as Awaited<ReturnType<PasskeyChooser["choose"]>>);
    expect(await ask(input)).toBe(expected);
  });

  it.each([
    { active: false, focused: true, incognito: false },
    { active: true, focused: false, incognito: false },
    { active: true, focused: true, incognito: true },
  ])("opens no window for a tab %j", async (tab) => {
    const { choose, ask, input } = setup({ kind: "chosen", index: 0, makeDefault: false }, tab);
    expect(await ask(input)).toBe("unavailable");
    expect(choose).not.toHaveBeenCalled();
  });
});

describe("vault master password check for a login", () => {
  function connections(snapshotId: string | undefined, matches: boolean | "error") {
    const verifyMasterPassword = vi.fn(async () =>
      matches === "error"
        ? ({ ok: false, error: { code: "crypto-locked" } } as const)
        : ({ ok: true, data: { matches } } as const),
    );
    const handle = snapshotId === undefined ? undefined : { snapshotId };
    return {
      verifyMasterPassword,
      runtime: {
        registry: { get: vi.fn(async () => ({ profile: { connectionId: "connection-1" } })) },
        vaultFor: () => ({ manager: { status: () => ({ handle }), verifyMasterPassword } }),
      } as unknown as Parameters<typeof createVaultPasswordCheck>[0],
    };
  }

  it("checks against the snapshot the login's settings described", async () => {
    const { runtime, verifyMasterPassword } = connections("snapshot-1", true);
    expect(await createVaultPasswordCheck(runtime)(connection, "right")).toBe(true);
    expect(verifyMasterPassword).toHaveBeenCalledWith({ snapshotId: "snapshot-1" }, "right");
  });

  it("tells a wrong password apart from a vault that cannot answer", async () => {
    expect(
      await createVaultPasswordCheck(connections("snapshot-1", false).runtime)(connection, "x"),
    ).toBe(false);
    await expect(
      createVaultPasswordCheck(connections("snapshot-1", "error").runtime)(connection, "x"),
    ).rejects.toThrow("vault-unavailable");
    // A vault that synced or locked since is not the one the login chose from.
    await expect(
      createVaultPasswordCheck(connections("snapshot-2", true).runtime)(connection, "x"),
    ).rejects.toThrow("vault-unavailable");
    await expect(
      createVaultPasswordCheck(connections(undefined, true).runtime)(connection, "x"),
    ).rejects.toThrow("vault-unavailable");
  });
});
