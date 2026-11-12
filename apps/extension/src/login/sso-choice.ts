import { newId } from "@pateat/contracts/ids";
import {
  getItemEligibility,
  isSiteAllowed,
  isSiteExcluded,
  type LoginAccount,
  type LoginDocument,
  type SettingsResponse,
  type VaultConnectionMetadata,
} from "@pateat/contracts";
import type { SafeSsoMethod, SsoIdpChoice, SsoSourceRef, VaultSsoSource } from "./sso-vault";
import { createSsoMappingStore, type SsoMapping, type SsoMappingStore } from "./sso-mapping-store";
import type { SsoActionResponse, SsoChooseRequest, SsoResponse } from "./sso-wire";

type Saved = Extract<SettingsResponse, { ok: true }>;
export type SsoChoiceInput = {
  /** The account is already chosen by the account chooser; methods never select an account. */
  document: LoginDocument;
  account: LoginAccount;
  native: { passkey: boolean; password: boolean };
  /** Explicit choices remain per offer; they never change a site or IdP default. */
  automatic?: boolean;
  /** An IdP hop can use only that account\u0027s native routes; never another SSO hop. */
  asIdentityProvider?: boolean;
  /** URL-form entries come from a local observation, never from a guessed provider label. */
  entries?: { id: string; label: string }[];
  entryCurrent?: (entryId: string) => Promise<boolean>;
  /** A fresh explicit HTTP destination matches this already selected origin; never a label guess. */
  entryOrigin?: (entryId: string, selectedOrigin: string) => Promise<boolean>;
  signal?: AbortSignal;
};
export type SsoResolvedChoice =
  | { kind: "native"; route: "passkey" | "password" }
  | { kind: "sso"; source: SsoSourceRef; selected: SsoIdpChoice; label?: string; entryId?: string };
export type SsoChoiceOutcome = { ok: true; choiceId: string } | { ok: false; reason: string };
type Method = SafeSsoMethod & {
  source: SsoSourceRef;
  candidates: { id: string; selected: SsoIdpChoice; itemLabel: string; connectionLabel: string }[];
  selectedId?: string;
};
type Offer = {
  id: string;
  input: SsoChoiceInput;
  saved: Saved;
  field?: string;
  methods: Method[];
  reason?: string;
  choosing: boolean;
  settled?: boolean;
  ready?: boolean;
  expiresAt: number;
  done: (outcome: SsoChoiceOutcome) => void;
  releaseAbort: () => void;
};
type Receipt = {
  offer: Offer;
  selection: SsoResolvedChoice;
  /** Only automatic URL choices require this exact destination again when consumed. */
  entryOrigin?: string;
};
const sameAccount = (a: SsoIdpChoice["account"], b: SsoIdpChoice["account"]) =>
  a.connectionId === b.connectionId && a.itemId === b.itemId;
const continuity = (connection: VaultConnectionMetadata | undefined) =>
  connection?.snapshotId && connection.userId
    ? {
        provider: connection.provider,
        server: connection.server,
        userId: connection.userId,
        snapshotId: connection.snapshotId,
      }
    : undefined;
const connectionFor = (saved: Saved, account: SsoIdpChoice["account"]) =>
  saved.catalog.connections.find((entry) => entry.id === account.connectionId);
const logicalAccount = (saved: Saved, account: SsoIdpChoice["account"]) => {
  const value = continuity(connectionFor(saved, account));
  return value
    ? JSON.stringify([value.provider, value.server, value.userId, account.itemId.toLowerCase()])
    : undefined;
};
const failure = (reason: string): { ok: false; reason: string } => ({ ok: false, reason });

/**
 * Local choice and mapping only. Neither a popup answer nor a consumed receipt authorizes
 * a click or credential release. The executor must keep its own document/origin fences.
 * Offers and receipts are memory-only: a worker restart withdraws them, never restores authority.
 */
export function createSsoChoiceController(options: {
  source: VaultSsoSource;
  readSettings: () => Promise<SettingsResponse>;
  currentDocument: (document: LoginDocument) => boolean;
  store?: SsoMappingStore;
}) {
  const offers = new Map<number, Offer>();
  const receipts = new Map<string, Receipt>();
  const epochs = new Map<number, string>();
  const store = options.store ?? createSsoMappingStore();
  function retained(offer: Offer) {
    return (
      offers.get(offer.input.document.tabId) === offer &&
      Date.now() < offer.expiresAt &&
      !offer.input.signal?.aborted &&
      options.currentDocument(offer.input.document)
    );
  }
  function finish(offer: Offer, outcome: SsoChoiceOutcome) {
    offer.settled = true;
    offer.done(outcome);
  }
  function invalidateTab(tabId: number, reason = "scope-changed") {
    epochs.set(tabId, newId());
    const offer = offers.get(tabId);
    offers.delete(tabId);
    if (offer) {
      offer.releaseAbort();
      finish(offer, { ok: false, reason });
    }
    for (const [id, receipt] of receipts)
      if (receipt.offer.input.document.tabId === tabId) receipts.delete(id);
  }
  function matching(saved: Saved, offer: Offer) {
    const { account, document } = offer.input;
    return (
      saved.snapshot.revision === offer.saved.snapshot.revision &&
      JSON.stringify(saved.catalog) === JSON.stringify(offer.saved.catalog) &&
      !saved.catalog.settingsSyncPending &&
      account.origin === document.origin &&
      !isSiteExcluded(saved.snapshot.settings, account.origin) &&
      isSiteAllowed(saved.snapshot.settings, account.origin) &&
      getItemEligibility(
        saved.snapshot.settings,
        saved.catalog,
        account.connectionId,
        account.itemId,
      ).eligible
    );
  }
  async function current(offer: Offer) {
    if (!retained(offer)) return false;
    const saved = await options.readSettings().catch(() => undefined);
    return retained(offer) && saved?.ok === true && matching(saved, offer);
  }
  async function validateAll(offer: Offer): Promise<string | undefined> {
    if (!(await current(offer))) return "scope-changed";
    const used = new Set<string>();
    for (const method of offer.methods) {
      const candidate = method.candidates.find((entry) => entry.id === method.selectedId);
      if (!candidate) return "mapping-required";
      if (
        candidate.selected.origin === offer.input.account.origin ||
        logicalAccount(offer.saved, candidate.selected.account) ===
          logicalAccount(offer.saved, offer.input.account)
      )
        return "unsafe-hop";
      // oxlint-disable-next-line no-await-in-loop -- each local vault validation must finish before the next
      const checked = await options.source.validate(method.source, candidate.selected);
      if (!retained(offer) || !checked.ok) return checked.ok ? "scope-changed" : checked.reason;
      const identity = logicalAccount(offer.saved, candidate.selected.account);
      if (!identity) return "vault-unavailable";
      if (used.has(identity)) return "duplicate-idp";
      used.add(identity);
    }
    return (await current(offer)) ? undefined : "scope-changed";
  }
  function resolve(offer: Offer, selection: SsoResolvedChoice, entryOrigin?: string) {
    if (!retained(offer) || offer.settled) return failure("offer-gone");
    const choiceId = newId();
    receipts.set(choiceId, { offer, selection, ...(entryOrigin ? { entryOrigin } : {}) });
    finish(offer, { ok: true, choiceId });
    return { ok: true as const };
  }
  async function automaticUrl(offer: Offer, method: Method): Promise<string | undefined> {
    if (offer.choosing || offer.settled) return undefined;
    offer.choosing = true;
    try {
      const { entryCurrent, entryOrigin, entries } = offer.input;
      const candidate = method.candidates.find((entry) => entry.id === method.selectedId);
      if (!candidate || !entryCurrent || !entryOrigin) return "entry-required";
      const selected = candidate.selected;
      const matches: { id: string; label: string }[] = [];
      for (const entry of entries ?? []) {
        // oxlint-disable-next-line no-await-in-loop -- inspect each local entry before resolving ambiguity
        const present = await entryCurrent(entry.id).catch(() => false);
        if (!retained(offer)) return "scope-changed";
        if (!present) continue;
        // oxlint-disable-next-line no-await-in-loop -- destination evidence belongs to this exact entry
        const matchesOrigin = await entryOrigin(entry.id, selected.origin).catch(() => false);
        if (!retained(offer)) return "scope-changed";
        if (matchesOrigin) matches.push(entry);
        if (matches.length > 1) return "entry-required";
      }
      const entry = matches.length === 1 ? matches[0] : undefined;
      if (!entry) return "entry-required";
      const refused = await validateAll(offer);
      if (refused) return refused;
      if (!retained(offer)) return "scope-changed";
      const resolved = resolve(
        offer,
        {
          kind: "sso",
          source: method.source,
          selected,
          entryId: entry.id,
          label: entry.label,
        },
        selected.origin,
      );
      return resolved.ok ? undefined : resolved.reason;
    } finally {
      offer.choosing = false;
    }
  }
  async function mapping(offer: Offer, method: Method, candidateId: string) {
    const candidate = method.candidates.find((entry) => entry.id === candidateId);
    if (!candidate) return "not-a-candidate";
    if (
      candidate.selected.origin === offer.input.account.origin ||
      logicalAccount(offer.saved, candidate.selected.account) ===
        logicalAccount(offer.saved, offer.input.account)
    )
      return "unsafe-hop";
    const checked = await options.source.validate(method.source, candidate.selected);
    if (!retained(offer) || !checked.ok) return checked.ok ? "scope-changed" : checked.reason;
    if (!(await current(offer))) return "scope-changed";
    const sourceContinuity = continuity(connectionFor(offer.saved, offer.input.account));
    const selectedContinuity = continuity(connectionFor(offer.saved, candidate.selected.account));
    if (!sourceContinuity || !selectedContinuity) return "vault-unavailable";
    const record: SsoMapping = {
      source: method.source,
      selected: candidate.selected,
      sourceContinuity,
      selectedContinuity,
    };
    const written = await store.save(record, () => retained(offer)).catch(() => false);
    if (!written || !(await current(offer))) return "scope-changed";
    method.selectedId = candidate.id;
    return undefined;
  }
  async function choose(request: SsoChooseRequest): Promise<SsoActionResponse> {
    const offer = offers.get(request.tabId);
    if (!offer || offer.id !== request.offerId || offer.choosing || offer.settled || !offer.ready)
      return failure("offer-gone");
    offer.choosing = true;
    try {
      if (!(await current(offer))) return failure("scope-changed");
      const selection = request.selection;
      if (selection.kind === "unmap") {
        const method = offer.methods.find(
          (entry) => entry.method.number === selection.method.number,
        );
        if (!method) return failure("method-unavailable");
        const removed = await store.remove(method.source, () => retained(offer)).catch(() => false);
        if (!removed || !(await current(offer))) return failure("scope-changed");
        delete method.selectedId;
        offer.reason = "mapping-required";
        return { ok: true };
      }
      if (selection.kind !== "native") {
        const method = offer.methods.find(
          (entry) => entry.method.number === selection.method.number,
        );
        if (!method) return failure("method-unavailable");
        const refused = await mapping(offer, method, selection.candidateId);
        if (refused) return failure(refused);
        if (selection.kind === "mapping") {
          const reason = await validateAll(offer);
          if (!retained(offer)) return failure("scope-changed");
          if (reason) offer.reason = reason;
          else delete offer.reason;
          return { ok: true };
        }
      }
      const refused = await validateAll(offer);
      if (refused) return failure(refused);
      if (selection.kind === "native") {
        if (!offer.input.native[selection.route]) return failure("method-unavailable");
        return resolve(offer, selection);
      }
      const method = offer.methods.find(
        (entry) => entry.method.number === selection.method.number,
      )!;
      const selected = method.candidates.find((entry) => entry.id === method.selectedId)!.selected;
      if (method.form === "url") {
        if (
          !selection.entryId ||
          !offer.input.entries?.some((entry) => entry.id === selection.entryId) ||
          !offer.input.entryCurrent
        )
          return failure("entry-required");
        if (!(await offer.input.entryCurrent(selection.entryId)) || !(await current(offer)))
          return failure("entry-changed");
      }
      const label =
        method.label ?? offer.input.entries?.find((entry) => entry.id === selection.entryId)?.label;
      return resolve(offer, {
        kind: "sso",
        source: method.source,
        selected,
        ...(label ? { label } : {}),
        ...(selection.entryId ? { entryId: selection.entryId } : {}),
      });
    } catch {
      return failure("unavailable");
    } finally {
      offer.choosing = false;
    }
  }
  return {
    /**
     * A coordinator awaits result, then consumes its opaque receipt immediately before
     * its own next operation. Automatic choice never falls back after an unresolved method.
     */
    async request(input: SsoChoiceInput): Promise<{
      offerId: string;
      result: Promise<SsoChoiceOutcome>;
    }> {
      invalidateTab(input.document.tabId, "replaced");
      const epoch = epochs.get(input.document.tabId);
      let done!: Offer["done"];
      const result = new Promise<SsoChoiceOutcome>((complete) => {
        done = complete;
      });
      const saved = await options.readSettings();
      if (epochs.get(input.document.tabId) !== epoch)
        return { offerId: "", result: Promise.resolve({ ok: false, reason: "replaced" }) };
      if (!saved.ok)
        return {
          offerId: "",
          result: Promise.resolve({ ok: false, reason: "settings-unavailable" }),
        };
      const offer: Offer = {
        id: newId(),
        input,
        saved,
        methods: [],
        choosing: false,
        expiresAt: Date.now() + 600_000,
        done,
        releaseAbort: () => undefined,
      };
      offers.set(input.document.tabId, offer);
      const abort = () => invalidateTab(input.document.tabId, "cancelled");
      input.signal?.addEventListener("abort", abort, { once: true });
      const expiry = setTimeout(() => invalidateTab(input.document.tabId, "expired"), 600_000);
      offer.releaseAbort = () => {
        clearTimeout(expiry);
        input.signal?.removeEventListener("abort", abort);
      };
      const refused = async (reason: string, field?: string) => {
        if (field) offer.field = field;
        offer.reason = reason;
        finish(offer, { ok: false, reason });
        return { offerId: offer.id, result };
      };
      if (!(await current(offer))) return refused("scope-changed");
      const described = await options.source.describe(input.account);
      if (!described.ok || !retained(offer))
        return refused(
          described.ok ? "scope-changed" : described.reason,
          described.ok ? undefined : described.field,
        );
      if (described.data.methods.some((method) => method.form === "url"))
        offer.input = { ...input, native: { ...input.native, password: false } };
      const mappings = await store.read().catch(() => undefined);
      if (!retained(offer)) return refused("scope-changed");
      if (!mappings) return refused("mapping-store-unavailable");
      for (const method of input.asIdentityProvider ? [] : described.data.methods) {
        const source = {
          account: { connectionId: input.account.connectionId, itemId: input.account.itemId },
          method: method.method,
          sourceEvidence: described.data.sourceEvidence,
        };
        // oxlint-disable-next-line no-await-in-loop -- vault discovery shares a single native lane
        const found = await options.source.candidates(source);
        if (!found.ok || !retained(offer))
          return refused(found.ok ? "scope-changed" : found.reason);
        const candidates = found.data.candidates.flatMap((candidate) => {
          const connection = connectionFor(saved, candidate.account);
          const item = connection?.items.find((entry) => entry.id === candidate.account.itemId);
          return candidate.origins
            .filter(
              (origin) =>
                origin !== input.account.origin &&
                logicalAccount(saved, candidate.account) !== logicalAccount(saved, input.account),
            )
            .map((origin) => ({
              id: newId(),
              selected: { account: candidate.account, origin },
              itemLabel: item?.label ?? candidate.account.itemId,
              connectionLabel: connection?.label ?? candidate.account.connectionId,
            }));
        });
        if (candidates.length > 2000) return refused("candidate-limit");
        const known = mappings.find(
          (entry) =>
            JSON.stringify(entry.source) === JSON.stringify(source) &&
            JSON.stringify(entry.sourceContinuity) ===
              JSON.stringify(continuity(connectionFor(saved, input.account))) &&
            JSON.stringify(entry.selectedContinuity) ===
              JSON.stringify(continuity(connectionFor(saved, entry.selected.account))),
        );
        const selected =
          known &&
          candidates.find(
            (entry) =>
              sameAccount(entry.selected.account, known.selected.account) &&
              entry.selected.origin === known.selected.origin,
          );
        offer.methods.push({
          ...method,
          source,
          candidates,
          ...(selected ? { selectedId: selected.id } : {}),
        });
      }
      if (!(await current(offer))) return refused("scope-changed");
      offer.ready = true;
      if (input.automatic) {
        const all = await validateAll(offer);
        if (all && all !== "mapping-required") return refused(all);
        if (!all) {
          if (input.native.passkey) resolve(offer, { kind: "native", route: "passkey" });
          else {
            const preferred = offer.methods.find((entry) => entry.automatic);
            if (preferred?.form === "bracket") {
              resolve(offer, {
                kind: "sso",
                source: preferred.source,
                selected: preferred.candidates.find((entry) => entry.id === preferred.selectedId)!
                  .selected,
                ...(preferred.label ? { label: preferred.label } : {}),
              });
            } else if (preferred?.form === "url") {
              const reason = await automaticUrl(offer, preferred);
              if (reason === "scope-changed") return refused(reason);
              if (reason) offer.reason = reason;
            } else if (!preferred && input.native.password)
              resolve(offer, { kind: "native", route: "password" });
            else offer.reason = preferred ? "entry-required" : "method-unavailable";
          }
        } else offer.reason = all;
      }
      return { offerId: offer.id, result };
    },
    async get(tabId: number): Promise<SsoResponse> {
      const offer = offers.get(tabId);
      if (!offer || (!offer.ready && !offer.settled) || (offer.settled && !offer.reason))
        return { ok: true };
      if (!(await current(offer)) || !retained(offer)) {
        if (offers.get(tabId) === offer) invalidateTab(tabId);
        return failure("scope-changed");
      }
      const connection = connectionFor(offer.saved, offer.input.account);
      return {
        ok: true,
        offer: {
          id: offer.id,
          origin: offer.input.account.origin,
          accountLabel:
            connection?.items.find((item) => item.id === offer.input.account.itemId)?.label ??
            offer.input.account.itemId,
          ...offer.input.native,
          methods: offer.methods.map(({ source: _source, candidates, ...method }) => ({
            ...method,
            candidates: candidates.map(({ selected, ...candidate }) => ({
              ...candidate,
              itemId: selected.account.itemId,
              origin: selected.origin,
            })),
          })),
          entries: offer.input.entries ?? [],
          ...(offer.reason ? { reason: offer.reason } : {}),
          ...(offer.field ? { field: offer.field } : {}),
          ...(offer.settled ? { blocked: true as const } : {}),
        },
      };
    },
    choose,
    cancel(tabId: number, offerId: string): SsoActionResponse {
      if (offers.get(tabId)?.id !== offerId) return failure("offer-gone");
      invalidateTab(tabId, "cancelled");
      return { ok: true };
    },
    invalidateTab,
    invalidateAll(reason = "scope-changed") {
      for (const tabId of epochs.keys()) invalidateTab(tabId, reason);
      receipts.clear();
    },
    /** Rechecks every method and the exact observed URL entry; one use, even on refusal. */
    async consume(
      choiceId: string,
    ): Promise<
      | { ok: true; document: LoginDocument; account: LoginAccount; selection: SsoResolvedChoice }
      | { ok: false; reason: string }
    > {
      const receipt = receipts.get(choiceId);
      receipts.delete(choiceId);
      if (!receipt) return failure("choice-gone");
      const { offer, selection } = receipt;
      const refused = await validateAll(offer);
      if (refused) return failure(refused);
      if (selection.kind === "sso" && selection.entryId) {
        if (
          !offer.input.entryCurrent ||
          !(await offer.input.entryCurrent(selection.entryId)) ||
          (receipt.entryOrigin !== undefined &&
            (!offer.input.entryOrigin ||
              !(await offer.input.entryOrigin(selection.entryId, receipt.entryOrigin)))) ||
          !(await current(offer))
        )
          return failure("entry-changed");
        const afterEntry = await validateAll(offer);
        if (afterEntry) return failure(afterEntry);
      }
      if (!retained(offer)) return failure("scope-changed");
      invalidateTab(offer.input.document.tabId, "consumed");
      return { ok: true, document: offer.input.document, account: offer.input.account, selection };
    },
  };
}
export type SsoChoiceController = ReturnType<typeof createSsoChoiceController>;
