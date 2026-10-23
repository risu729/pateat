import * as v from "valibot";
import {
  admitBitwardenUriMatchContext,
  createBitwardenUriMatcher,
  type BitwardenUriMatchContext,
  createLocalCryptoSession,
  createLocalFieldSnapshot,
  derivePasswordAuthentication,
  type LocalCryptoSession,
  type PreparedBitwardenAccount,
  type LocalVaultMetadata,
  vaultDisplayLabel,
  vaultFieldName,
  localVaultMetadataSchema,
} from "@pateat/bitwarden";
import { loadBrowserCryptoSdk } from "@pateat/bitwarden/browser-sdk";
import { customFieldsDigest, importDigestKey } from "./custom-digest";
import { countsOnHttpPage, pageMatches } from "./http-page";
import { createRegexRunner } from "./regex";
import { findStoredPasskeys, selectPasskeyItem, signStoredPasskey } from "./passkey";
import {
  commandSchema,
  type CustomDigests,
  type HostCommand,
  type HostSessionRef,
  type UriCandidates,
} from "./wire";
import { newId } from "@pateat/contracts/ids";

// Native SDK panic/log output can contain decrypted input. The host emits only typed results.
for (const method of ["log", "info", "warn", "error", "debug", "trace"] as const)
  console[method] = () => {};
const sdkPromise = (async () => {
  const sdk = await loadBrowserCryptoSdk();
  // The one permitted load is the bundled WASM above. No high-level SDK network API is used.
  globalThis.fetch = () => Promise.reject(new Error("Network disabled in crypto host"));
  sdk.init_sdk(sdk.LogLevel.Error, sdk.LogLevel.Error, 0);
  return sdk;
})();
void sdkPromise.catch(() => {}); // The typed execute result owns initialization failures.
let owned:
  | {
      ref: HostSessionRef;
      session: LocalCryptoSession;
      ciphers: Map<string, unknown>;
      verified: boolean;
      metadataContext: PreparedBitwardenAccount["encryptedMetadata"];
      /** The account's encrypted master-password unlock data, for re-prompt checks. */
      masterPasswordUnlock: PreparedBitwardenAccount["masterPasswordUnlock"];
      catalog?: LocalVaultMetadata;
      uriContext?: BitwardenUriMatchContext;
      /**
       * Decrypted login URI rules captured during verification. They stay in this Worker,
       * except that Regex patterns run in the nested Regex Worker it owns (ADR 0056).
       */
      loginUris: Map<string, { uri: string | null; match: number | null }[]>;
    }
  | undefined;
let busy = false;
// Started on the first Regex URI and terminated with this Worker, as on lock.
const regexRunner = createRegexRunner();
const fail = (
  code:
    | "crypto-failed"
    | "invalid-request"
    | "account-mismatch"
    | "crypto-locked"
    | "field-missing"
    | "resource-limit"
    | "invalid-uri-input"
    | "uri-context-unavailable",
) => ({ ok: false as const, error: { code } });
function exactSession(ref: HostSessionRef) {
  return (
    owned &&
    Object.entries(owned.ref).every(([key, value]) => ref[key as keyof HostSessionRef] === value)
  );
}
async function execute(command: HostCommand) {
  const sdk = await sdkPromise;
  const op = command.operation;
  if (op.kind === "derive-auth") {
    if (
      !op.input ||
      typeof op.input !== "object" ||
      !("connectionId" in op.input) ||
      op.input.connectionId !== command.connectionId
    )
      return fail("account-mismatch");
    return derivePasswordAuthentication(op.input, sdk);
  }
  if (op.kind === "open") {
    if (owned) return fail("invalid-request");
    // This boundary is called by the trusted mapper consumer, not by a page.
    const prepared = op.prepared as PreparedBitwardenAccount;
    if (
      !prepared?.binding ||
      prepared.coverage !== "received-envelope" ||
      !Array.isArray(prepared.ciphers) ||
      prepared.ciphers.length > 10_000
    )
      return fail("invalid-request");
    if (prepared.binding.profile.connectionId !== command.connectionId)
      return fail("account-mismatch");
    const ciphers = new Map<string, unknown>();
    for (const cipher of prepared.ciphers) {
      const id: unknown = cipher?.id;
      if (
        typeof id !== "string" ||
        !v.safeParse(v.pipe(v.string(), v.uuid()), id).success ||
        ciphers.has(id.toLowerCase())
      )
        return fail("invalid-request");
      ciphers.set(id.toLowerCase(), cipher);
    }
    // Retained with this snapshot only. A missing or unreadmittable context cannot match URIs.
    const uriContext =
      prepared.uriMatchContext === undefined
        ? undefined
        : admitBitwardenUriMatchContext(prepared.uriMatchContext);
    const unlock =
      op.unlock.kind === "password"
        ? { ...op.unlock, masterPasswordUnlock: prepared.masterPasswordUnlock }
        : op.unlock;
    const session = await createLocalCryptoSession(
      {
        connectionId: command.connectionId,
        userId: prepared.binding.userId,
        email: prepared.binding.email,
        kdf: prepared.kdf,
        accountCryptographicState: prepared.accountCryptographicState,
        organizationKeys: prepared.organizationKeys,
        minimumSecurityVersion: prepared.minimumSecurityVersion,
        unlock,
      },
      sdk,
    );
    if (!session.ok) return session;
    if (session.data.metadata.accountVersion !== prepared.binding.accountVersion) {
      session.data.dispose();
      return fail("account-mismatch");
    }
    const ref = {
      brokerGeneration: command.generation,
      connectionId: command.connectionId,
      userId: prepared.binding.userId,
      sessionId: newId(),
      snapshotId: op.snapshotId,
    };
    owned = {
      ref,
      session: session.data,
      ciphers,
      verified: false,
      metadataContext: prepared.encryptedMetadata,
      masterPasswordUnlock: prepared.masterPasswordUnlock,
      ...(uriContext ? { uriContext } : {}),
      loginUris: new Map(),
    };
    return { ok: true as const, data: { session: ref, metadata: session.data.metadata } };
  }
  if (op.kind === "close") return fail("invalid-request"); // Supervisor handles termination.
  if (!exactSession(op.session) || !owned || command.connectionId !== owned.ref.connectionId)
    return fail("crypto-locked");
  if (op.kind === "lock") return fail("invalid-request");
  if (op.kind === "verify-received-ciphers") {
    owned.verified = false;
    delete owned.catalog;
    owned.loginUris.clear();
    const loginUris = new Map<string, { uri: string | null; match: number | null }[]>();
    const groups = await owned.session.decryptCatalogGroups(owned.metadataContext);
    if (!groups.ok) return groups;
    const items: LocalVaultMetadata["items"] = [];
    // Validate every received supported item, without building a plaintext field
    // cache or forwarding bulk CipherViews across the extension Port.
    for (const cipher of owned.ciphers.values()) {
      // eslint-disable-next-line no-await-in-loop
      const checked = await owned.session.decryptCipher({
        connectionId: command.connectionId,
        cipher,
      });
      if (!checked.ok) return checked;
      if (![1, 2, 3, 4].includes(checked.data.type)) return fail("crypto-failed");
      // Pinned clients exclude deleted and archived items from URL matching.
      if (checked.data.type === 1 && !checked.data.deletedDate && !checked.data.archivedDate)
        loginUris.set(
          // Same identifier form as the catalog item, so settings eligibility applies.
          String(checked.data.id),
          (checked.data.login?.uris ?? []).map((entry) => ({
            uri: entry.uri ?? null,
            match: entry.match ?? null,
          })),
        );
      const snapshot = createLocalFieldSnapshot({
        connectionId: command.connectionId,
        userId: owned.ref.userId,
        snapshotId: owned.ref.snapshotId,
        item: checked.data,
      });
      if (!snapshot.ok) return snapshot;
      try {
        items.push({
          id: String(checked.data.id),
          label: vaultDisplayLabel(checked.data.name, String(checked.data.id)),
          type: checked.data.type as 1 | 2 | 3 | 4,
          groupIds: [
            ...new Set([
              ...(checked.data.folderId ? [String(checked.data.folderId)] : []),
              ...checked.data.collectionIds.map(String),
            ]),
          ],
          fields: snapshot.data.list().map((field) => ({
            id: field.ref.fieldId,
            label: vaultDisplayLabel(field.label, field.ref.fieldId),
            name: vaultFieldName(field.name),
            kind: field.kind,
            ...(field.linkedFieldId ? { linkedFieldId: field.linkedFieldId } : {}),
            ...(field.empty ? { empty: true as const } : {}),
            ...(field.totpSeed ? { totpSeed: true as const } : {}),
          })),
        });
      } finally {
        snapshot.data.dispose();
      }
    }
    const catalog = v.safeParse(localVaultMetadataSchema, {
      connectionId: command.connectionId,
      userId: owned.ref.userId,
      snapshotId: owned.ref.snapshotId,
      groups: groups.data,
      items,
    });
    if (!catalog.success) return fail("resource-limit");
    owned.catalog = catalog.output;
    owned.loginUris = loginUris;
    owned.verified = true;
    return { ok: true as const, data: { verifiedCipherCount: owned.ciphers.size } };
  }
  if (op.kind === "export-unlock") {
    if (!owned.verified) return fail("invalid-request");
    return owned.session.exportUnlockMaterial();
  }
  if (op.kind === "verify-password")
    return owned.session.verifyMasterPassword({
      password: op.password,
      masterPasswordUnlock: owned.masterPasswordUnlock,
    });
  if (op.kind === "catalog")
    return owned.verified && owned.catalog
      ? { ok: true as const, data: owned.catalog }
      : fail("invalid-request");
  if (op.kind === "match-uris") {
    if (!owned.verified) return fail("invalid-request");
    if (!owned.uriContext) return fail("uri-context-unavailable");
    // Admit the context and target once; each item then costs only its own URI rules.
    // Regex URIs are answered from `regexResults`. A first pass collects the patterns not
    // answered yet, they run together in the Regex Worker, and only the items that had
    // one are evaluated again with the results.
    const regexResults = new Map<string, boolean>();
    const regexPending = new Set<string>();
    let httpPage = false;
    let waiting = false;
    const matcher = createBitwardenUriMatcher(op.targetUrl, owned.uriContext, (pattern) => {
      const answer = regexResults.get(pattern);
      // On an `http:` page a pattern not saved with `http://` would not count (ADR 0050).
      if (answer === undefined && (!httpPage || countsOnHttpPage(pattern))) {
        regexPending.add(pattern);
        waiting = true;
      }
      return answer;
    });
    if (!matcher.ok || matcher.data.targetOrigin.length > 8192) return fail("invalid-uri-input");
    httpPage = matcher.data.targetOrigin.startsWith("http://");
    const evaluations = new Map<string, ReturnType<typeof matcher.data.evaluate>>();
    const waitingItems = new Set<string>();
    for (const [itemId, uris] of owned.loginUris) {
      waiting = false;
      evaluations.set(itemId, matcher.data.evaluate(uris));
      if (waiting) waitingItems.add(itemId);
    }
    if (regexPending.size > 0) {
      for (const [pattern, matched] of await regexRunner.run([...regexPending], op.targetUrl))
        regexResults.set(pattern, matched);
      for (const itemId of waitingItems)
        evaluations.set(itemId, matcher.data.evaluate(owned.loginUris.get(itemId)));
    }
    const result: UriCandidates = {
      connectionId: command.connectionId,
      userId: owned.ref.userId,
      snapshotId: owned.ref.snapshotId,
      targetOrigin: matcher.data.targetOrigin,
      candidates: [],
      unavailableUris: [],
      unavailableItemIds: [],
    };
    for (const [itemId, uris] of owned.loginUris) {
      const evaluated = evaluations.get(itemId)!;
      // A single oversized item is reported without hiding unrelated candidates.
      if (!evaluated.ok) {
        result.unavailableItemIds.push(itemId);
        continue;
      }
      const matches = pageMatches(result.targetOrigin, evaluated.data.matches, uris);
      if (matches.length) result.candidates.push({ itemId, matches });
      for (const entry of pageMatches(result.targetOrigin, evaluated.data.unavailableUris, uris))
        result.unavailableUris.push({ itemId, ...entry });
      if (result.unavailableUris.length > 100_000) return fail("resource-limit");
    }
    return { ok: true as const, data: result };
  }
  if (op.kind === "custom-digest") {
    if (!owned.verified) return fail("invalid-request");
    const key = await importDigestKey(op.key);
    // Not crypto-failed: a comparison that cannot run must not lock the session.
    if (!key) return fail("invalid-request");
    const digests: CustomDigests["digests"] = {};
    for (const itemId of op.itemIds) {
      const cipher = owned.ciphers.get(itemId.toLowerCase());
      digests[itemId] = null;
      if (!cipher) continue;
      try {
        // eslint-disable-next-line no-await-in-loop
        const decrypted = await owned.session.decryptCipher({
          connectionId: command.connectionId,
          cipher,
        });
        if (!decrypted.ok) continue;
        // eslint-disable-next-line no-await-in-loop
        digests[itemId] = await customFieldsDigest(decrypted.data.fields, key);
      } catch {
        // An item that cannot be digested compares as different; the session stays open.
      }
    }
    return { ok: true as const, data: { digests } };
  }
  if (op.kind === "passkey-find" || op.kind === "passkey-sign") {
    const binding = {
      connectionId: owned.ref.connectionId,
      userId: owned.ref.userId,
      snapshotId: owned.ref.snapshotId,
    };
    if (op.kind === "passkey-find")
      return findStoredPasskeys(owned.session, binding, owned, op.rpId);
    const item = selectPasskeyItem(owned, op.itemId);
    if (!item.ok) return item;
    return signStoredPasskey(owned.session, binding, item.data.itemId, item.data.cipher, op);
  }
  if (op.kind !== "resolve" && !("itemId" in op)) return fail("invalid-request");
  const itemId = (op.kind === "resolve" ? op.ref.itemId : op.itemId).toLowerCase();
  const cipher = owned.ciphers.get(itemId);
  if (!cipher) return fail("field-missing");
  if (op.kind === "decrypt")
    return owned.session.decryptCipher({ connectionId: command.connectionId, cipher });
  if (op.kind !== "list" && op.kind !== "resolve") return fail("invalid-request");
  // No decrypted item outlives the request that reads it: each request decrypts its own
  // copy and disposes it before replying, so only the listing or the one value asked for
  // leaves this function.
  const decrypted = await owned.session.decryptCipher({
    connectionId: command.connectionId,
    cipher,
  });
  if (!decrypted.ok) return decrypted;
  const snapshot = createLocalFieldSnapshot({
    connectionId: command.connectionId,
    userId: owned.ref.userId,
    snapshotId: owned.ref.snapshotId,
    item: decrypted.data,
  });
  if (!snapshot.ok) return snapshot;
  try {
    if (op.kind !== "resolve") return { ok: true as const, data: snapshot.data.list() };
    return snapshot.data.resolve(op.ref, {
      allowedFieldIds: op.allowedFieldIds,
      ...(op.nowMs === undefined ? {} : { nowMs: () => op.nowMs! }),
      ...(op.code ? { code: true as const } : {}),
    });
  } finally {
    snapshot.data.dispose();
  }
}
self.onmessage = (event: MessageEvent<unknown>) => {
  const parsed = v.safeParse(commandSchema, event.data);
  if (!parsed.success) return;
  const command = parsed.output;
  const reply = (result: unknown) =>
    self.postMessage({
      version: 1,
      type: "crypto.result",
      generation: command.generation,
      requestId: command.requestId,
      connectionId: command.connectionId,
      result,
    });
  if (busy) {
    reply(fail("resource-limit"));
    return;
  }
  busy = true;
  void execute(command)
    .then(reply, () => reply(fail("crypto-failed")))
    .finally(() => {
      busy = false;
    });
};
