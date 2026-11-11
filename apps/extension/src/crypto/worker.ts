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
import {
  findStoredPasskeys,
  selectPasskeyItem,
  signStoredPasskey,
  storedPasskeyRpIds,
} from "./passkey";
import {
  commandSchema,
  type CustomDigests,
  type HostCommand,
  type HostSessionRef,
  type LoginUsernames,
  type PartialItem,
  type UnusableItem,
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
      /**
       * Each live login item's username, captured with its URI rules so the popup can name
       * matching accounts without decrypting them again (ADR 0080). Nothing else is kept.
       */
      loginUsernames: Map<string, string>;
      /** Per partly readable item, the field IDs that did not decrypt and are not offered. */
      unreadableFields: Map<string, Set<string>>;
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
/**
 * A received item that failed strict decryption, named by its ID, the check that refused it
 * and its server revision date; all three are secret-free. It is left out of the session
 * instead of failing the snapshot (ADR 0006).
 */
/** The field IDs of the snapshot that a repaired item's unreadable paths stand for. */
function unreadableFieldIds(paths: readonly string[], snapshotId: string): Set<string> {
  const ids = new Set<string>();
  for (const path of paths) {
    const [group, name, part] = path.split(".");
    if (path === "notes") ids.add("notes");
    else if (path === "login.totp") ids.add("login.totp-code");
    else if (group === "fields" && part) ids.add(`custom.${snapshotId}.${name}`);
    else if (group === "login" && (name === "username" || name === "password")) ids.add(path);
    else if (group === "card") ids.add(path);
    else if (group === "identity") {
      ids.add(path);
      // The full name is made from these parts.
      if (["title", "firstName", "middleName", "lastName"].includes(name ?? ""))
        ids.add("identity.fullName");
    }
  }
  return ids;
}
/** The snapshot's fields, without those of a partly readable item that did not decrypt
 * and the linked custom fields that would fill one of them. */
function offered<T extends { ref: { fieldId: string }; linkedFieldId?: string }>(
  fields: readonly T[],
  itemId: string,
): readonly T[] {
  const unreadable = owned?.unreadableFields.get(itemId.toLowerCase());
  return unreadable
    ? fields.filter(
        (field) =>
          !unreadable.has(field.ref.fieldId) &&
          !(field.linkedFieldId && unreadable.has(field.linkedFieldId)),
      )
    : fields;
}
function unusable(itemId: string, cipher: unknown, check: string | undefined): UnusableItem {
  const raw = cipher && typeof cipher === "object" ? (cipher as Record<string, unknown>) : {};
  const revised = typeof raw["revisionDate"] === "string" ? Date.parse(raw["revisionDate"]) : NaN;
  return {
    itemId,
    ...(check ? { check: check as UnusableItem["check"] } : {}),
    ...(Number.isSafeInteger(revised) && revised >= 0 ? { revised } : {}),
  };
}
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
      loginUsernames: new Map(),
      unreadableFields: new Map(),
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
    owned.loginUsernames.clear();
    owned.unreadableFields.clear();
    const partialItems: PartialItem[] = [];
    const loginUris = new Map<string, { uri: string | null; match: number | null }[]>();
    const loginUsernames = new Map<string, string>();
    const groups = await owned.session.decryptCatalogGroups(owned.metadataContext);
    if (!groups.ok) return groups;
    const items: LocalVaultMetadata["items"] = [];
    const unusableItems: UnusableItem[] = [];
    // Validate every received supported item, without building a plaintext field
    // cache or forwarding bulk CipherViews across the extension Port.
    for (const [receivedId, received] of owned.ciphers) {
      let cipher = received;
      // eslint-disable-next-line no-await-in-loop
      let checked = await owned.session.decryptCipher({
        connectionId: command.connectionId,
        cipher,
      });
      // An item some of whose fields do not decrypt is used without them (ADR 0006).
      if (
        !checked.ok &&
        (checked.error.check === "sdk-decrypt" || checked.error.check === "attachment")
      ) {
        // eslint-disable-next-line no-await-in-loop
        const repaired = await owned.session.repairCipher({
          connectionId: command.connectionId,
          cipher,
        });
        if (!repaired.ok && repaired.error.code !== "crypto-failed") return repaired;
        if (repaired.ok) {
          cipher = repaired.data.cipher;
          // eslint-disable-next-line no-await-in-loop
          checked = await owned.session.decryptCipher({
            connectionId: command.connectionId,
            cipher,
          });
          if (checked.ok) {
            owned.ciphers.set(receivedId, cipher);
            owned.unreadableFields.set(
              receivedId,
              unreadableFieldIds(repaired.data.unreadable, owned.ref.snapshotId),
            );
            // Values only another item type's object held are not shown, so not reported.
            if (repaired.data.unreadable.length)
              partialItems.push({ itemId: receivedId, fields: repaired.data.unreadable });
          }
        }
      }
      // One item strict decryption refuses is not used; the rest of the vault is (ADR 0006).
      // Any other failure, such as a locked session, still ends the verification.
      if (!checked.ok && checked.error.code !== "crypto-failed") return checked;
      if (!checked.ok || ![1, 2, 3, 4].includes(checked.data.type)) {
        unusableItems.push(
          unusable(receivedId, cipher, checked.ok ? "item-type" : checked.error.check),
        );
        continue;
      }
      // Pinned clients exclude deleted and archived items from URL matching.
      if (checked.data.type === 1 && !checked.data.deletedDate && !checked.data.archivedDate) {
        // Same identifier form as the catalog item, so settings eligibility applies.
        const itemId = String(checked.data.id);
        loginUris.set(
          itemId,
          (checked.data.login?.uris ?? []).map((entry) => ({
            uri: entry.uri ?? null,
            match: entry.match ?? null,
          })),
        );
        const username = checked.data.login?.username;
        if (username) loginUsernames.set(itemId.toLowerCase(), username.slice(0, 1024));
      }
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
          ...(checked.data.deletedDate || checked.data.archivedDate
            ? { inactive: true as const }
            : {}),
          groupIds: [
            ...new Set([
              ...(checked.data.folderId ? [String(checked.data.folderId)] : []),
              ...checked.data.collectionIds.map(String),
            ]),
          ],
          // Bitwarden's master password re-prompt; a site's settings decide whether it is asked.
          ...(checked.data.reprompt === 1 ? { reprompt: true as const } : {}),
          fields: offered(snapshot.data.list(), receivedId).map((field) => ({
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
    // A fault in the SDK partway through, such as running out of memory, reads like every
    // later item failing. So once an item is refused, one that verified must still decrypt,
    // and a vault none of whose items verify is refused whole: either keeps the open vault
    // instead of replacing it with a nearly empty one. A repaired item also starts this
    // check, since such a fault may refuse only an item's larger values; the item checked
    // again is one that verified whole when there is one. An item refused for its
    // organization was refused before any SDK call, so it cannot be such a fault.
    if (
      owned.unreadableFields.size > 0 ||
      unusableItems.some(
        (item) => item.check !== "organization-key" && item.check !== "unknown-organization",
      )
    ) {
      const refused = new Set(unusableItems.map((item) => item.itemId));
      const repairedIds = owned.unreadableFields;
      const usable = [...owned.ciphers.keys()].filter((id) => !refused.has(id));
      const verifiedId = usable.find((id) => !repairedIds.has(id)) ?? usable[0];
      const again =
        verifiedId === undefined
          ? undefined
          : await owned.session.decryptCipher({
              connectionId: command.connectionId,
              cipher: owned.ciphers.get(verifiedId),
            });
      if (!again?.ok) return fail("crypto-failed");
    }
    // An unusable item is gone from this session, so no later request decrypts it and a
    // site's settings that name it find no field instead of locking the session.
    for (const item of unusableItems) {
      owned.ciphers.delete(item.itemId);
      owned.unreadableFields.delete(item.itemId);
    }
    owned.catalog = catalog.output;
    owned.loginUris = loginUris;
    owned.loginUsernames = loginUsernames;
    owned.verified = true;
    return {
      ok: true as const,
      data: {
        verifiedCipherCount: owned.ciphers.size,
        unusableItems,
        partialItems: partialItems.filter(
          (item) => !unusableItems.some((refused) => refused.itemId === item.itemId),
        ),
      },
    };
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
  if (op.kind === "login-usernames") {
    if (!owned.verified) return fail("invalid-request");
    const usernames: LoginUsernames["usernames"] = {};
    // Item identifiers match case-insensitively, as in the other operations.
    for (const itemId of op.itemIds)
      usernames[itemId] = owned.loginUsernames.get(itemId.toLowerCase()) ?? null;
    return { ok: true as const, data: { usernames } };
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
      // A custom field that did not decrypt is not known to be unchanged.
      const unreadable = owned.unreadableFields.get(itemId.toLowerCase());
      if (!cipher || [...(unreadable ?? [])].some((id) => id.startsWith("custom."))) continue;
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
  if (op.kind === "passkey-find" || op.kind === "passkey-rp-ids" || op.kind === "passkey-sign") {
    const binding = {
      connectionId: owned.ref.connectionId,
      userId: owned.ref.userId,
      snapshotId: owned.ref.snapshotId,
    };
    if (op.kind === "passkey-find")
      return findStoredPasskeys(owned.session, binding, owned, op.rpId);
    if (op.kind === "passkey-rp-ids")
      return storedPasskeyRpIds(owned.session, binding, owned, op.itemId);
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
    if (op.kind !== "resolve")
      return { ok: true as const, data: offered(snapshot.data.list(), itemId) };
    // A field that did not decrypt is not offered, so it is missing rather than empty.
    // So is a linked custom field that would fill one.
    const unreadable = owned.unreadableFields.get(itemId);
    const linked = unreadable
      ? snapshot.data.list().find((field) => field.ref.fieldId === op.ref.fieldId)?.linkedFieldId
      : undefined;
    if (unreadable?.has(op.ref.fieldId) || (linked && unreadable?.has(linked)))
      return fail("field-missing");
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
    .then(reply, () =>
      reply({ ok: false, error: { code: "crypto-failed", check: "worker-exception" } }),
    )
    .finally(() => {
      busy = false;
    });
};
