import * as v from "valibot";
import {
  admitBitwardenUriMatchContext,
  createBitwardenUriMatcher,
  type BitwardenUriMatchContext,
  createLocalCryptoSession,
  createLocalFieldSnapshot,
  derivePasswordAuthentication,
  type LocalCryptoSession,
  type LocalFieldSnapshot,
  type PreparedBitwardenAccount,
  type LocalVaultMetadata,
  vaultDisplayLabel,
  localVaultMetadataSchema,
} from "@pateat/bitwarden";
import { loadBrowserCryptoSdk } from "@pateat/bitwarden/browser-sdk";
import { commandSchema, type HostCommand, type HostSessionRef, type UriCandidates } from "./wire";

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
      fields: Map<string, LocalFieldSnapshot>;
      verified: boolean;
      metadataContext: PreparedBitwardenAccount["encryptedMetadata"];
      catalog?: LocalVaultMetadata;
      uriContext?: BitwardenUriMatchContext;
      /** Decrypted login URI rules captured during verification; this Worker only. */
      loginUris: Map<string, { uri: string | null; match: number | null }[]>;
    }
  | undefined;
let busy = false;
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
      sessionId: crypto.randomUUID(),
      snapshotId: op.snapshotId,
    };
    owned = {
      ref,
      session: session.data,
      ciphers,
      fields: new Map(),
      verified: false,
      metadataContext: prepared.encryptedMetadata,
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
    const groups = await owned.session.decryptCatalogGroups(
      owned.metadataContext ?? { folders: [], collections: [] },
    );
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
            kind: field.kind,
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
  if (op.kind === "catalog")
    return owned.verified && owned.catalog
      ? { ok: true as const, data: owned.catalog }
      : fail("invalid-request");
  if (op.kind === "match-uris") {
    if (!owned.verified) return fail("invalid-request");
    if (!owned.uriContext) return fail("uri-context-unavailable");
    // Admit the context and target once; each item then costs only its own URI rules.
    const matcher = createBitwardenUriMatcher(op.targetUrl, owned.uriContext);
    if (!matcher.ok || matcher.data.targetOrigin.length > 8192) return fail("invalid-uri-input");
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
      const evaluated = matcher.data.evaluate(uris);
      // A single oversized item is reported without hiding unrelated candidates.
      if (!evaluated.ok) {
        result.unavailableItemIds.push(itemId);
        continue;
      }
      if (evaluated.data.matched)
        result.candidates.push({ itemId, matches: [...evaluated.data.matches] });
      for (const entry of evaluated.data.unavailableUris)
        result.unavailableUris.push({ itemId, ...entry });
      if (result.unavailableUris.length > 100_000) return fail("resource-limit");
    }
    return { ok: true as const, data: result };
  }
  if (op.kind !== "resolve" && !("itemId" in op)) return fail("invalid-request");
  const itemId = (op.kind === "resolve" ? op.ref.itemId : op.itemId).toLowerCase();
  const cipher = owned.ciphers.get(itemId);
  if (!cipher) return fail("field-missing");
  if (op.kind === "decrypt")
    return owned.session.decryptCipher({ connectionId: command.connectionId, cipher });
  let snapshot = owned.fields.get(itemId);
  if (!snapshot) {
    if (owned.fields.size >= 128) return fail("resource-limit");
    const decrypted = await owned.session.decryptCipher({
      connectionId: command.connectionId,
      cipher,
    });
    if (!decrypted.ok) return decrypted;
    const created = createLocalFieldSnapshot({
      connectionId: command.connectionId,
      userId: owned.ref.userId,
      snapshotId: owned.ref.snapshotId,
      item: decrypted.data,
    });
    if (!created.ok) return created;
    snapshot = created.data;
    owned.fields.set(itemId, snapshot);
  }
  if (op.kind === "list") return { ok: true as const, data: snapshot.list() };
  if (op.kind !== "resolve") return fail("invalid-request");
  return snapshot.resolve(op.ref, {
    allowedFieldIds: op.allowedFieldIds,
    ...(op.nowMs === undefined ? {} : { nowMs: () => op.nowMs! }),
  });
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
