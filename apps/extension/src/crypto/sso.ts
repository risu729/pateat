import { isSsoFieldName, ssoMethodName } from "@pateat/contracts";
import type { LocalCryptoSession } from "@pateat/bitwarden";
import { toBase64Url } from "../passkeys/encoding";
import type { HostSessionRef } from "./wire";
import {
  SSO_METHOD_LIMIT,
  type SsoSourceInput,
  type SsoCandidateInput,
  type SsoMethods,
  type SsoCandidates,
} from "./sso-wire";

type Field = { name?: string | null; value?: string | null; type: number };
export type SsoWorkerState = {
  ref: HostSessionRef;
  session: LocalCryptoSession;
  ciphers: Map<string, unknown>;
  loginUsernames: Map<string, string>;
  loginUris: Map<string, { uri: string | null; match: number | null }[]>;
  unreadableFields: Map<string, Set<string>>;
  uriContext?: { defaultMatch: number | "unavailable" };
};
/** Username comparison follows ADR 0026; it does not rewrite the stored value. */
export const normalizeSsoUsername = (username: string) => username.trim().toLowerCase();
async function usernameProof(username: string, key: CryptoKey) {
  const data = new TextEncoder().encode(
    `pateat.sso.username.v1\0${normalizeSsoUsername(username)}`,
  );
  return toBase64Url(new Uint8Array(await crypto.subtle.sign("HMAC", key, data)));
}
async function encryptedEvidence(cipher: unknown) {
  return toBase64Url(
    new Uint8Array(
      await crypto.subtle.digest(
        "SHA-256",
        new TextEncoder().encode(JSON.stringify(cipher ?? null)),
      ),
    ),
  );
}
/** Controls, format characters such as bidirectional overrides and zero-width joiners, and line or paragraph separators. */
const hasControl = (value: string) => /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u.test(value);
const validUsername = (value: string) => value.isWellFormed() && !hasControl(value);

/**
 * Strict concrete HTTP(S) URI, never a guessed host or a Regex URI. Any `@` in the
 * authority refuses, as in the Bitwarden matcher. A trailing-dot host keeps its dot, so
 * it names a different origin from the host without it, as browsers treat it.
 */
export function ssoUriOrigin(value: string): string | undefined {
  if (
    !/^https?:\/\//iu.test(value) ||
    /[\\\s]/u.test(value) ||
    hasControl(value) ||
    !value.isWellFormed() ||
    /^https?:\/\/[^/?#]*@/iu.test(value)
  )
    return undefined;
  const parsed = URL.parse(value);
  return parsed &&
    ["https:", "http:"].includes(parsed.protocol) &&
    parsed.hostname &&
    !parsed.username &&
    !parsed.password
    ? parsed.origin
    : undefined;
}

/**
 * The origin an IdP item's own URI rule permits, or undefined for a rule that can never
 * match a web page: another scheme such as `androidapp:` or `iosapp:`, or a malformed URI,
 * which the native matcher ignores too. A bare host is read as `https://` for a Domain or
 * Host rule, which match it on any scheme; a StartsWith or Exact rule compares the raw
 * text, which never begins a page URL.
 */
function ownUriOrigin(stored: string, mode: 0 | 1 | 2 | 3): string | undefined {
  const value = stored.trim();
  const scheme = /^([a-z][a-z0-9+.-]*):/iu.exec(value)?.[1]?.toLowerCase();
  const bareHostPort = /^([^/?#:@]+):[0-9]+(?:[/?#]|$)/u.exec(value)?.[1]?.includes(".") === true;
  if (scheme && scheme !== "http" && scheme !== "https" && !bareHostPort) return undefined;
  if (!value.includes("://")) {
    const host = /^[^/?#]*/u.exec(value)?.[0] ?? "";
    if ((mode !== 0 && mode !== 1) || !host.includes(".")) return undefined;
    return ssoUriOrigin(`https://${host}`);
  }
  const authority = /^https?:\/\/[^/\\?#]*/iu.exec(value)?.[0];
  return authority ? ssoUriOrigin(authority) : undefined;
}

/** The canonical `SSO` or `SSO <n>` a refusal names, never the stored spelling. */
function reportedField(name: string): string | undefined {
  const parsed = ssoMethodName(name);
  if (parsed) return parsed.automatic ? "SSO" : `SSO ${parsed.number}`;
  const digits = /^sso\s+0*([0-9]{1,16})$/iu.exec(name.normalize("NFKC").trim())?.[1];
  return digits === undefined ? undefined : `SSO ${digits}`;
}

/** A request decrypts its source once. No custom-field value is retained in Worker state. */
export async function describeSsoMethods(
  state: SsoWorkerState,
  input: SsoSourceInput,
  key: CryptoKey,
): Promise<SsoMethods> {
  const itemId = input.itemId.toLowerCase();
  const cipher = state.ciphers.get(itemId);
  const base = {
    itemId,
    snapshotId: state.ref.snapshotId,
    sourceEvidence: await encryptedEvidence(cipher),
  };
  const refused = (
    reason: Extract<SsoMethods["result"], { status: "refused" }>["reason"],
    field?: string,
  ): SsoMethods => ({
    ...base,
    result: { status: "refused", reason, ...(field ? { field } : {}) },
  });
  if (!cipher) return refused("item-unavailable");
  const decrypted = await state.session.decryptCipher({
    connectionId: state.ref.connectionId,
    cipher,
  });
  if (
    !decrypted.ok ||
    decrypted.data.type !== 1 ||
    decrypted.data.deletedDate ||
    decrypted.data.archivedDate
  )
    return refused("item-unavailable");
  // A repaired encrypted item may have lost even a field name. Its unreadable custom
  // fields cannot safely establish that the preferred SSO method is absent.
  if ([...(state.unreadableFields.get(itemId) ?? [])].some((id) => id.startsWith("custom.")))
    return refused("field-unreadable");
  const fields = decrypted.data.fields ?? [];
  const allowed = new Set(input.allowedFieldIds);
  const active = fields
    .map((field, index) => ({
      field: field as Field,
      fieldId: `custom.${state.ref.snapshotId}.${index}`,
    }))
    .filter(({ field, fieldId }) => isSsoFieldName(field.name) && allowed.has(fieldId));
  if (active.length > SSO_METHOD_LIMIT) return refused("too-many-methods");
  // One item never mixes the forms; check before a URL value is refused as an alternative.
  const forms = new Set(
    active
      .map(({ field }) => field.value?.trim())
      .filter((value) => value)
      .map((value) => value!.startsWith("[")),
  );
  if (forms.size > 1) return refused("mixed-forms");
  const methods: Extract<SsoMethods["result"], { status: "ready" }>["methods"] = [];
  const seen = new Set<number>();
  for (const { field, fieldId } of active) {
    const name = reportedField(field.name ?? "SSO");
    if (state.unreadableFields.get(itemId)?.has(fieldId)) return refused("field-unreadable", name);
    const parsedName = ssoMethodName(field.name);
    if (!parsedName) return refused("field-name", name);
    if (seen.has(parsedName.number)) return refused("duplicate-method", name);
    seen.add(parsedName.number);
    if (field.type !== 0 && field.type !== 1) return refused("field-type", name);
    if (
      field.value &&
      (field.value.length > 4096 || hasControl(field.value) || !field.value.isWellFormed())
    )
      return refused("invalid-value", name);
    const value = field.value?.trim();
    if (!value) return refused("invalid-value", name);
    let label: string | undefined;
    let username: string;
    let origin: string | undefined;
    if (value.startsWith("[")) {
      const match = /^\[([^\]\r\n[]+)\]\s+([^\r\n]+)$/u.exec(value);
      label = match?.[1]?.trim();
      username = match?.[2]?.trim() ?? "";
      if (
        !label ||
        label.length > 128 ||
        !username ||
        username.length > 1024 ||
        (username + label).includes("[") ||
        (username + label).includes("]") ||
        !validUsername(username + label)
      )
        return refused("invalid-value", name);
    } else {
      origin = ssoUriOrigin(value);
      if (!origin || !parsedName.automatic || active.length !== 1)
        return refused("invalid-value", name);
      if (decrypted.data.login?.password) return refused("url-needs-empty-password", name);
      if (
        state.unreadableFields.get(itemId)?.has("login.password") ||
        state.unreadableFields.get(itemId)?.has("login.username")
      )
        return refused("field-unreadable", name);
      if (!allowed.has("login.username")) return refused("username-missing", name);
      username = decrypted.data.login?.username?.trim() ?? "";
      if (!username || username.length > 1024 || !validUsername(username))
        return refused("username-missing", name);
    }
    // oxlint-disable-next-line no-await-in-loop -- each bounded method is compared locally
    const proof = await usernameProof(username, key);
    methods.push({
      method: { number: parsedName.number },
      fieldId,
      automatic: parsedName.automatic,
      form: origin ? "url" : "bracket",
      ...(label ? { label } : {}),
      ...(origin ? { origin } : {}),
      usernameProof: proof,
    });
  }
  return { ...base, result: { status: "ready", methods } };
}

/** Eligibility is supplied by the trusted caller; the result is candidate evidence, not a release grant. */
export async function findSsoCandidates(
  state: SsoWorkerState,
  input: SsoCandidateInput,
  key: CryptoKey,
): Promise<SsoCandidates> {
  const candidates: SsoCandidates["candidates"] = [];
  for (const item of input.candidates) {
    const itemId = item.itemId.toLowerCase();
    if (!item.allowedFieldIds.includes("login.username")) continue;
    if (!state.ciphers.has(itemId) || state.unreadableFields.get(itemId)?.has("login.username")) {
      candidates.push({ itemId, origins: [], unavailable: "item-unavailable" });
      continue;
    }
    const username = state.loginUsernames.get(itemId);
    if (!username) continue;
    // oxlint-disable-next-line no-await-in-loop -- each native Worker has one execution lane
    if ((await usernameProof(username, key)) !== input.usernameProof) continue;
    const cipher = state.ciphers.get(itemId);
    // The existing username cache is truncated for display. Confirm a matching proof
    // against the full current username before it can identify a credential account.
    // oxlint-disable-next-line no-await-in-loop -- no decrypted target is retained
    const decrypted = await state.session.decryptCipher({
      connectionId: state.ref.connectionId,
      cipher,
    });
    if (
      !decrypted.ok ||
      decrypted.data.type !== 1 ||
      decrypted.data.deletedDate ||
      decrypted.data.archivedDate
    ) {
      candidates.push({ itemId, origins: [], unavailable: "item-unavailable" });
      continue;
    }
    const fullUsername = decrypted.data.login?.username;
    if (!fullUsername || fullUsername.length > 1024 || !validUsername(fullUsername)) {
      candidates.push({ itemId, origins: [], unavailable: "username-missing" });
      continue;
    }
    // oxlint-disable-next-line no-await-in-loop -- verify the complete value after the cache shortlist
    if ((await usernameProof(fullUsername, key)) !== input.usernameProof) continue;
    // An account that itself signs in through an IdP is never an IdP account (ADR 0026,
    // ADR 0085): any SSO field not in the bracket form, or an enabled one with no password.
    // Hidden custom fields could hold such a field, so they leave the account unknown.
    if ([...(state.unreadableFields.get(itemId) ?? [])].some((id) => id.startsWith("custom."))) {
      candidates.push({ itemId, origins: [], unavailable: "field-unreadable" });
      continue;
    }
    const allowed = new Set(item.allowedFieldIds);
    const nested = (decrypted.data.fields ?? []).some((raw, index) => {
      const field = raw as Field;
      if (!isSsoFieldName(field.name)) return false;
      if (!field.value?.trim().startsWith("[")) return true;
      return (
        allowed.has(`custom.${state.ref.snapshotId}.${index}`) && !decrypted.data.login?.password
      );
    });
    if (nested) {
      candidates.push({ itemId, origins: [], unavailable: "signs-in-with-sso" });
      continue;
    }
    const origins = new Set<string>();
    let unavailable = false;
    const uris = state.loginUris.get(itemId);
    if (!uris || uris.length > 1_000) unavailable = true;
    else
      for (const entry of uris) {
        const mode = entry.match ?? state.uriContext?.defaultMatch;
        if (mode === 5) continue;
        // A Regex rule, an unknown default and an unsupported mode are reported, never
        // treated as no match; a rule that can never match a web page is ignored.
        if (mode === 4 || mode === "unavailable" || mode === undefined || mode < 0 || mode > 5) {
          unavailable = true;
          continue;
        }
        const origin = entry.uri ? ownUriOrigin(entry.uri, mode as 0 | 1 | 2 | 3) : undefined;
        if (origin) origins.add(origin);
      }
    candidates.push({
      itemId,
      origins: [...origins].sort(),
      ...(unavailable ? { unavailable: "uri-unavailable" as const } : {}),
    });
  }
  return { snapshotId: state.ref.snapshotId, candidates };
}
