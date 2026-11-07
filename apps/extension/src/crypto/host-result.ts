import * as v from "valibot";
import { localVaultMetadataSchema, type LocalCryptoSession } from "@pateat/bitwarden";
import {
  customDigestsSchema,
  loginUsernamesSchema,
  uriCandidatesSchema,
  passkeyRpIdsSchema,
  passkeyMatchesSchema,
  passkeySignatureSchema,
  sessionSchema,
  type HostOperation,
  type HostSessionRef,
} from "./wire";
import { fromBase64Url } from "../passkeys/encoding";

export type OpenedHostSession = {
  session: HostSessionRef;
  metadata: {
    connectionId: string;
    userId: string;
    accountVersion: "v1" | "v2";
    securityVersion: 1 | 2;
  };
};

/** Item IDs are UUIDs, which may arrive in either case. */
export function unique(itemIds: readonly string[]): boolean {
  return new Set(itemIds.map((id) => id.toLowerCase())).size === itemIds.length;
}

function sameOrigin(targetUrl: string, origin: string): boolean {
  return URL.parse(targetUrl)?.origin === origin;
}

export const resultCodes = new Set([
  "invalid-profile",
  "invalid-options",
  "invalid-request",
  "connection-mismatch",
  "account-mismatch",
  "authentication-expired",
  "unsupported-unlock",
  "cancelled",
  "timeout",
  "network",
  "redirect",
  "http-error",
  "response-too-large",
  "invalid-response",
  "invalid-crypto-input",
  "crypto-failed",
  "unsupported-crypto",
  "security-downgrade",
  "crypto-locked",
  "resource-limit",
  "invalid-field-input",
  "stale-field-reference",
  "field-denied",
  "field-missing",
  "unsupported-field",
  "invalid-totp",
  "invalid-uri-input",
  "uri-context-unavailable",
]);

/** Validates a reply against the operation and account that requested it, without effects. */
export function validHostResult(
  connectionId: string,
  operation: HostOperation,
  data: unknown,
  generation: string,
): boolean {
  if (operation.kind === "verify-received-ciphers") {
    const checked = v.safeParse(
      v.strictObject({
        verifiedCipherCount: v.pipe(v.number(), v.integer(), v.minValue(0), v.maxValue(10_000)),
      }),
      data,
    );
    if (!checked.success) {
      return false;
    }
  }
  if (
    operation.kind === "verify-password" &&
    !v.safeParse(v.strictObject({ matches: v.boolean() }), data).success
  ) {
    return false;
  }
  if (operation.kind === "catalog") {
    const metadata = v.safeParse(localVaultMetadataSchema, data);
    if (
      !metadata.success ||
      metadata.output.connectionId !== connectionId ||
      metadata.output.userId !== operation.session.userId ||
      metadata.output.snapshotId !== operation.session.snapshotId
    ) {
      return false;
    }
  }
  if (operation.kind === "match-uris") {
    const candidates = v.safeParse(uriCandidatesSchema, data);
    if (
      !candidates.success ||
      candidates.output.connectionId !== connectionId ||
      candidates.output.userId !== operation.session.userId ||
      candidates.output.snapshotId !== operation.session.snapshotId ||
      !sameOrigin(operation.targetUrl, candidates.output.targetOrigin)
    ) {
      return false;
    }
  }
  if (operation.kind === "custom-digest") {
    const requested = operation.itemIds;
    const checked = v.safeParse(customDigestsSchema, data);
    if (
      !checked.success ||
      Object.keys(checked.output.digests).length !== requested.length ||
      !requested.every((id) => Object.hasOwn(checked.output.digests, id))
    ) {
      return false;
    }
  }
  if (operation.kind === "login-usernames") {
    const requested = operation.itemIds;
    const checked = v.safeParse(loginUsernamesSchema, data);
    if (
      !checked.success ||
      Object.keys(checked.output.usernames).length !== requested.length ||
      !requested.every((id) => Object.hasOwn(checked.output.usernames, id))
    ) {
      return false;
    }
  }
  if (operation.kind === "passkey-rp-ids") {
    const listed = v.safeParse(passkeyRpIdsSchema, data);
    if (
      !listed.success ||
      listed.output.connectionId !== connectionId ||
      listed.output.userId !== operation.session.userId ||
      listed.output.snapshotId !== operation.session.snapshotId ||
      listed.output.itemId !== operation.itemId.toLowerCase() ||
      !unique(listed.output.rpIds)
    ) {
      return false;
    }
  }
  if (operation.kind === "passkey-find" || operation.kind === "passkey-sign") {
    const bound = (entry: { connectionId: string; userId: string; snapshotId: string }) =>
      entry.connectionId === connectionId &&
      entry.userId === operation.session.userId &&
      entry.snapshotId === operation.session.snapshotId;
    let valid: boolean;
    if (operation.kind === "passkey-find") {
      const found = v.safeParse(passkeyMatchesSchema, data);
      valid =
        found.success &&
        bound(found.output) &&
        found.output.rpId === operation.rpId &&
        found.output.candidates.every(
          (candidate) => bound(candidate) && candidate.rpId === operation.rpId,
        ) &&
        unique([
          ...found.output.candidates.map((candidate) => candidate.itemId),
          ...found.output.unavailableItemIds,
        ]);
    } else {
      const signed = v.safeParse(passkeySignatureSchema, data);
      const der = signed.success ? fromBase64Url(signed.output.signature) : undefined;
      valid =
        signed.success &&
        bound(signed.output) &&
        signed.output.itemId === operation.itemId.toLowerCase() &&
        signed.output.credentialId === operation.credentialId &&
        der !== undefined &&
        der.length >= 8 &&
        der.length <= 72;
    }
    if (!valid) {
      return false;
    }
  }
  if (operation.kind === "export-unlock") {
    const exported = data as {
      userKey?: unknown;
      metadata?: LocalCryptoSession["metadata"];
    };
    if (
      typeof exported?.userKey !== "string" ||
      exported.userKey.length === 0 ||
      exported.userKey.length > 1_048_576 ||
      exported.metadata?.connectionId !== connectionId ||
      exported.metadata.userId !== operation.session.userId ||
      !["v1", "v2"].includes(exported.metadata.accountVersion) ||
      ![1, 2].includes(exported.metadata.securityVersion)
    ) {
      return false;
    }
  }
  if (operation.kind === "open") {
    const opened = data as OpenedHostSession;
    const ref = v.safeParse(sessionSchema, opened?.session);
    if (
      !ref.success ||
      ref.output.brokerGeneration !== generation ||
      ref.output.connectionId !== connectionId ||
      ref.output.userId !== operation.prepared.binding.userId ||
      ref.output.snapshotId !== operation.snapshotId ||
      opened.metadata?.userId !== ref.output.userId ||
      opened.metadata.connectionId !== connectionId ||
      opened.metadata.accountVersion !== operation.prepared.binding.accountVersion ||
      (opened.metadata.securityVersion !== 1 && opened.metadata.securityVersion !== 2) ||
      opened.metadata.securityVersion < operation.prepared.minimumSecurityVersion
    ) {
      return false;
    }
  }
  return true;
}
