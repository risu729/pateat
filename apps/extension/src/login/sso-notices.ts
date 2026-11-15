/**
 * Hands the connection runtime's vault notices to the login runtime, which the background
 * creates after it: a notice before then has no offer to withdraw.
 */
export function ssoVaultNotices() {
  let login: { vaultStateMayChange(): Promise<unknown> } | undefined;
  return {
    notify(): void {
      void login?.vaultStateMayChange().catch(() => undefined);
    },
    attach(target: { vaultStateMayChange(): Promise<unknown> }): void {
      login = target;
    },
  };
}
