import { formatLocale } from "../i18n";
import { localClockTime } from "../time";
import type { Message } from "./bitwarden-setup-types";

/**
 * Why a sign-in that waited for its code until `expiresAt` ended at `endedAt`: its 5 minutes
 * passed, or before that the worker holding it stopped (Chrome restarted or updated it). The
 * panel status says what happened; the sign-in form, where the password goes, says why.
 */
export function endedText(expiresAt: number, endedAt: number): { status: string; reason: Message } {
  return endedAt < expiresAt
    ? {
        status: "The sign-in ended before the code was entered.",
        reason: (translate) =>
          translate(
            "The sign-in ended early, by {{time}}, before its 5 minutes. This usually means Chrome stopped Pateat's background. Enter the master password to start again.",
            { time: localClockTime(endedAt, formatLocale()) },
          ),
      }
    : {
        status: "The sign-in timed out waiting for the code.",
        reason: (translate) =>
          translate(
            "The sign-in timed out at {{time}}: no code was entered within 5 minutes. Enter the master password to start again.",
            { time: localClockTime(expiresAt, formatLocale()) },
          ),
      };
}
export function errorMessage(code: string, check?: string): Message {
  if (code === "account-mismatch")
    return (translate) =>
      translate(
        "Bitwarden's sign-in and vault data did not agree{{check}}. Setup is incomplete; report this check name.",
        { check: check ? translate(" (check: {{check}})", { check }) : "" },
      );
  // A check names what refused the data, and refreshing would meet the same refusal. A
  // crypto-failed without one comes from the crypto host itself, which a refresh restarts.
  if (code === "crypto-failed" && check)
    return (translate) =>
      translate(
        "Pateat could not decrypt this vault's data (check: {{check}}). Report this check name.",
        { check },
      );
  const messages: Record<string, string> = {
    "provider-permission-required":
      "Pateat does not have access to the Bitwarden server. Connect or sync again, and allow access when Chrome asks.",
    "setup-reauthentication-required":
      "Sign in again to sync. The saved local vault can still unlock independently.",
    "auto-unlock-disabled":
      "This connection is logged out on this device. Sign in again to use and sync it.",
    "vault-locked": "The vault is locked. Unlock it with the master password first.",
    "crypto-locked": "The vault is locked. Refresh to check recovery options.",
    "resource-limit":
      "The operation reached a resource limit. Refresh to check the current vault status before trying again.",
    "cache-quota-exceeded":
      "The vault is larger than Pateat's local copy can hold. Refresh to check the current vault status.",
    "storage-uncertain":
      "Pateat could not confirm that the local vault copy was updated. Refresh and reload saved settings before using this vault.",
    "setup-expired": "This verification session expired. Start sign-in again.",
    "unsupported-crypto": "This account uses an unsupported vault format. Setup is incomplete.",
    "invalid-response": "Bitwarden's answer could not be accepted. Setup is incomplete.",
    "authentication-rejected":
      "Bitwarden did not accept this sign-in. Check the email and master password, then try again.",
    "authentication-expired": "The Bitwarden sign-in expired. Sign in again to sync.",
    "revision-conflict":
      "The saved settings changed. Reload saved settings and review the current fields, then try again.",
  };
  return Object.hasOwn(messages, code)
    ? messages[code]!
    : (translate) =>
        translate("The connection could not do this ({{code}}). Refresh, then try again.", {
          code,
        });
}
