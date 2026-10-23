import type { LoginAccount, VaultConnectionMetadata, VaultItemMetadata } from "@pateat/contracts";
import type { ConnectionRuntime } from "../connections/runtime";
import type { PasskeyChooser } from "../passkeys/runtime";
import { CHOOSER_MAX_WAIT_MS } from "../passkeys/wire";

export type MasterPasswordAnswer = "verified" | "closed" | "unavailable";

/**
 * Whether a master password is right for the open vault of a connection, checked offline
 * against the snapshot the login's settings described. Throws when the vault cannot tell.
 */
export function createVaultPasswordCheck(
  connections: Pick<ConnectionRuntime, "registry" | "vaultFor">,
) {
  return async (connection: VaultConnectionMetadata, password: string): Promise<boolean> => {
    const configuration = await connections.registry.get(connection.id);
    if (!configuration) throw new Error("vault-unavailable");
    const { manager } = connections.vaultFor(configuration.profile);
    const handle = manager.status().handle;
    if (!handle || handle.snapshotId !== connection.snapshotId)
      throw new Error("vault-unavailable");
    const checked = await manager.verifyMasterPassword(handle, password);
    if (!checked.ok) throw new Error("vault-unavailable");
    return checked.data.matches;
  };
}

/**
 * Asks for the master password of a login's re-prompt item in Pateat's chooser window
 * (ADR 0021), as for a passkey: only for an active tab in the focused window outside
 * incognito, so a page loading in the background never pulls a window to the front.
 */
export function createLoginReprompt(deps: {
  /** Read when asking, since the chooser is made after the login runtime. */
  chooser: () => PasskeyChooser;
  check: (connection: VaultConnectionMetadata, password: string) => Promise<boolean>;
  tab: (
    tabId: number,
  ) => Promise<{ active: boolean; focused: boolean; incognito: boolean } | undefined>;
}) {
  return async (input: {
    tabId: number;
    origin: string;
    account: LoginAccount;
    connection: VaultConnectionMetadata;
    item: VaultItemMetadata;
    signal: AbortSignal;
  }): Promise<MasterPasswordAnswer> => {
    const tab = await deps.tab(input.tabId).catch(() => undefined);
    if (!tab?.active || !tab.focused || tab.incognito) return "unavailable";
    const host = URL.parse(input.origin)?.hostname;
    if (!host) return "unavailable";
    const signal = AbortSignal.any([input.signal, AbortSignal.timeout(CHOOSER_MAX_WAIT_MS)]);
    const choice = await deps.chooser().choose({
      tabId: input.tabId,
      origin: input.origin,
      rpId: host,
      entries: [{ item: input.item.label, account: input.connection.label, reprompt: true }],
      verify: (_index, password) => deps.check(input.connection, password),
      replacesDefault: false,
      again: false,
      purpose: "login",
      signal,
    });
    if (choice.kind === "chosen") return "verified";
    return choice.kind === "unavailable" ? "unavailable" : "closed";
  };
}
