import * as v from "valibot";
import { newId } from "@pateat/contracts/ids";
import {
  getItemEligibility,
  isSiteAllowed,
  isSiteExcluded,
  type LoginAccount,
  type LoginDocument,
  type SettingsResponse,
} from "@pateat/contracts";
import type { VaultSsoSource } from "./sso-vault";
import {
  createSsoMappingStore,
  goneFrom,
  mappingKey,
  SsoMappingLimitError,
  type SsoMapping,
  type SsoMappingStore,
} from "./sso-mapping-store";
import {
  ssoEntriesSchema,
  type SsoActionResponse,
  type SsoChooseRequest,
  type SsoResponse,
} from "./sso-wire";
import {
  candidate,
  candidates,
  hopRefusal,
  identity,
  portable,
  resolveAccount,
  shown,
  type Method,
  type Offer,
  type Saved,
  type SsoChoiceInput,
  type SsoChoiceOutcome,
  type SsoResolvedChoice,
} from "./sso-choice-model";

export type { SsoChoiceInput, SsoChoiceOutcome, SsoResolvedChoice } from "./sso-choice-model";
type Receipt = { offer: Offer; selection: SsoResolvedChoice };
type Refusal = { reason: string; field?: string };
type SsoSelection = Extract<SsoChooseRequest["selection"], { kind: "sso" }>;
const failure = (reason: string): { ok: false; reason: string } => ({ ok: false, reason });
const refusal = (found: { reason: string; field?: string }): Refusal => ({
  reason: found.reason,
  ...(found.field ? { field: found.field } : {}),
});
const OFFER_MS = 600_000;

/**
 * Local choice and mapping only. Neither a popup answer nor a consumed receipt authorizes
 * a click or credential release. The executor must keep its own document/origin fences.
 * Offers and receipts are memory-only: a worker restart withdraws them, never restores authority.
 */
export function createSsoChoiceController(options: {
  source: VaultSsoSource;
  readSettings: () => Promise<SettingsResponse>;
  /** The live path of the exact document, or undefined once it is gone. */
  currentDocument: (document: LoginDocument) => string | undefined;
  store?: SsoMappingStore;
}) {
  const offers = new Map<number, Offer>();
  const receipts = new Map<string, Receipt>();
  /** Requests still reading settings, by tab; an invalidation marks them with its reason. */
  const pending = new Map<number, { frameId: number; reason?: string }>();
  const store = options.store ?? createSsoMappingStore();
  let pruned: string | undefined;
  function retained(offer: Offer) {
    return (
      offers.get(offer.input.document.tabId) === offer &&
      Date.now() < offer.expiresAt &&
      !offer.input.signal?.aborted &&
      options.currentDocument(offer.input.document) === offer.path
    );
  }
  function finish(offer: Offer, outcome: SsoChoiceOutcome) {
    offer.settled = true;
    offer.done(outcome);
  }
  function invalidateTab(tabId: number, reason = "scope-changed") {
    const request = pending.get(tabId);
    if (request) {
      request.reason = reason;
      pending.delete(tabId);
    }
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
  const selectedOf = (method: Method) =>
    method.candidates.find((entry) => entry.id === method.selectedId);
  const methodOf = (offer: Offer, number: number) =>
    offer.methods.find((entry) => entry.method.number === number);
  /** Another method whose mapping names the same IdP account. */
  function duplicate(offer: Offer, method: Method, chosen: Method["candidates"][number]) {
    const own = identity(offer.saved, chosen.selected.account);
    return offer.methods.some((other) => {
      const theirs = other !== method && selectedOf(other);
      return theirs && identity(offer.saved, theirs.selected.account) === own;
    });
  }
  /**
   * Validates one SSO method for a route of it: its mapping, no other mapped method on the
   * same IdP account, and a fresh vault check. Native routes never need this.
   */
  async function validateSso(offer: Offer, method: Method): Promise<Refusal | undefined> {
    if (!(await current(offer))) return { reason: "scope-changed" };
    const chosen = selectedOf(method);
    if (!chosen) return { reason: method.reason ?? "mapping-required" };
    const hop = hopRefusal(offer, chosen.selected);
    if (hop) return { reason: hop };
    if (duplicate(offer, method, chosen)) return { reason: "duplicate-idp" };
    const checked = await options.source.validate(
      method.source,
      chosen.selected,
      offer.input.signal,
    );
    if (!retained(offer)) return { reason: "scope-changed" };
    if (!checked.ok) return refusal(checked);
    return (await current(offer)) ? undefined : { reason: "scope-changed" };
  }
  function resolve(offer: Offer, selection: SsoResolvedChoice) {
    if (!retained(offer) || offer.settled) return failure("offer-gone");
    const choiceId = newId();
    receipts.set(choiceId, { offer, selection });
    finish(offer, { ok: true, choiceId });
    return { ok: true as const };
  }
  /** Lists the saved IdP accounts and origins a method may use; keeps a chosen one. */
  async function discover(offer: Offer, method: Method): Promise<Refusal | undefined> {
    const found = await options.source.candidates(method.source, offer.input.signal);
    if (!retained(offer)) return { reason: "scope-changed" };
    if (!found.ok) return refusal(found);
    const listed = candidates(offer, found.data.candidates);
    if (listed.length > 2000) return { reason: "candidate-limit" };
    const chosen = selectedOf(method);
    const same = (entry: Method["candidates"][number]) =>
      chosen !== undefined &&
      entry.selected.origin === chosen.selected.origin &&
      identity(offer.saved, entry.selected.account) ===
        identity(offer.saved, chosen.selected.account);
    method.candidates = chosen ? [chosen, ...listed.filter((entry) => !same(entry))] : listed;
    method.discovered = true;
    return undefined;
  }
  async function mapping(offer: Offer, method: Method, candidateId: string) {
    const chosen = method.candidates.find((entry) => entry.id === candidateId);
    if (!chosen) return "not-a-candidate";
    const hop = hopRefusal(offer, chosen.selected);
    if (hop) return hop;
    if (duplicate(offer, method, chosen)) return "duplicate-idp";
    const checked = await options.source.validate(
      method.source,
      chosen.selected,
      offer.input.signal,
    );
    if (!retained(offer)) return "scope-changed";
    if (!checked.ok) {
      if (checked.field) method.field = checked.field;
      return checked.reason;
    }
    if (!(await current(offer))) return "scope-changed";
    const site = portable(offer.saved, offer.input.account);
    const idp = portable(offer.saved, chosen.selected.account);
    if (!site || !idp) return "vault-unavailable";
    const record: SsoMapping = {
      source: { ...site, method: method.method, sourceEvidence: method.source.sourceEvidence },
      selected: { ...idp, origin: chosen.selected.origin },
    };
    let written: boolean;
    try {
      written = await store.save(record, () => retained(offer), goneFrom(offer.saved.catalog));
    } catch (error) {
      if (!retained(offer)) return "scope-changed";
      return error instanceof SsoMappingLimitError ? "mapping-limit" : "mapping-store-unavailable";
    }
    if (!written || !(await current(offer))) return "scope-changed";
    method.selectedId = chosen.id;
    delete method.reason;
    delete method.field;
    // The offer's own explanation came from a method that was missing its mapping.
    delete offer.reason;
    delete offer.field;
    return undefined;
  }
  async function unmap(offer: Offer, method: Method) {
    const site = portable(offer.saved, offer.input.account);
    if (!site) return "vault-unavailable";
    const removed = await store
      .remove(
        { ...site, method: method.method, sourceEvidence: method.source.sourceEvidence },
        () => retained(offer),
        goneFrom(offer.saved.catalog),
      )
      .catch(() => false);
    if (!removed || !(await current(offer))) return "scope-changed";
    method.candidates = method.candidates.filter((entry) => entry.id !== method.selectedId);
    delete method.selectedId;
    method.reason = "mapping-required";
    if (method.discovered) return undefined;
    const refused = await discover(offer, method);
    if (refused?.reason === "scope-changed") return "scope-changed";
    if (refused) Object.assign(method, refused);
    return undefined;
  }
  async function chooseSso(
    offer: Offer,
    method: Method,
    selection: SsoSelection,
  ): Promise<SsoActionResponse> {
    // Only a URL-form method names an observed entry; a bracket method has its label.
    if (method.form !== "url" && selection.entryId) return failure("entry-unexpected");
    if (selection.candidateId !== method.selectedId) {
      const refused = await mapping(offer, method, selection.candidateId);
      if (refused) return failure(refused);
    }
    const refused = await validateSso(offer, method);
    if (refused) {
      if (refused.field) method.field = refused.field;
      return failure(refused.reason);
    }
    const chosen = selectedOf(method)!.selected;
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
      selected: chosen,
      ...(label ? { label } : {}),
      ...(selection.entryId ? { entryId: selection.entryId } : {}),
    });
  }
  async function choose(request: SsoChooseRequest): Promise<SsoActionResponse> {
    const offer = offers.get(request.tabId);
    if (!offer || offer.id !== request.offerId || offer.choosing || offer.settled || !offer.ready)
      return failure("offer-gone");
    offer.choosing = true;
    try {
      if (!(await current(offer))) return failure("scope-changed");
      const selection = request.selection;
      // A native route needs no SSO method to be mapped or valid (ADR 0085).
      if (selection.kind === "native") {
        if (!offer.input.native[selection.route]) return failure("method-unavailable");
        return resolve(offer, selection);
      }
      const method = methodOf(offer, selection.method.number);
      if (!method) return failure("method-unavailable");
      if (selection.kind === "unmap") {
        const refused = await unmap(offer, method);
        return refused ? failure(refused) : { ok: true };
      }
      if (selection.kind === "discover") {
        const refused = await discover(offer, method);
        return refused ? failure(refused.reason) : { ok: true };
      }
      if (selection.kind === "mapping") {
        const refused = await mapping(offer, method, selection.candidateId);
        return refused ? failure(refused) : { ok: true };
      }
      return await chooseSso(offer, method, selection);
    } catch {
      return failure("unavailable");
    } finally {
      offer.choosing = false;
    }
  }
  /**
   * One method: a saved mapping is validated directly and needs no discovery, so another
   * item's state cannot hold it back; a method without one lists the person's choices.
   */
  async function prepare(offer: Offer, method: Method, saved: SsoMapping | undefined) {
    if (saved) {
      const account = resolveAccount(offer.saved, saved.selected);
      const choice = account && { account, origin: saved.selected.origin };
      const hop = choice ? hopRefusal(offer, choice) : "mapping-unresolved";
      const checked =
        choice && !hop
          ? await options.source.validate(method.source, choice, offer.input.signal)
          : { ok: false as const, reason: hop ?? "mapping-unresolved" };
      if (!retained(offer)) return false;
      if (checked.ok && choice) {
        const entry = candidate(offer.saved, choice);
        method.candidates = [entry];
        method.selectedId = entry.id;
        return true;
      }
      // A saved IdP that no longer qualifies says why, as one that signs in with SSO.
      if (!checked.ok) Object.assign(method, refusal(checked));
    }
    const refused = await discover(offer, method);
    if (refused?.reason === "scope-changed") return false;
    if (refused && !method.reason) Object.assign(method, refused);
    method.reason ??= "mapping-required";
    return true;
  }
  /** The automatic route: passkey, then the preferred SSO method, then the password. */
  async function automatic(offer: Offer): Promise<Refusal | undefined> {
    if (offer.input.native.passkey) {
      if (await current(offer)) resolve(offer, { kind: "native", route: "passkey" });
      return undefined;
    }
    const preferred = offer.methods.find((entry) => entry.automatic);
    if (!preferred) {
      if (!offer.input.native.password) offer.reason = "method-unavailable";
      else if (await current(offer)) resolve(offer, { kind: "native", route: "password" });
      return undefined;
    }
    if (preferred.form === "url") {
      offer.reason = "entry-required";
      return undefined;
    }
    // An unresolved preferred method waits for the person; it never falls back.
    if (!selectedOf(preferred)) {
      offer.reason = preferred.reason ?? "mapping-required";
      if (preferred.field) offer.field = preferred.field;
      return undefined;
    }
    const refused = await validateSso(offer, preferred);
    if (refused) return refused;
    resolve(offer, {
      kind: "sso",
      source: preferred.source,
      selected: selectedOf(preferred)!.selected,
      ...(preferred.label ? { label: preferred.label } : {}),
    });
    return undefined;
  }
  async function build(offer: Offer): Promise<Refusal | undefined> {
    const { input } = offer;
    if (!(await current(offer))) return { reason: "scope-changed" };
    const described = await options.source.describe(input.account, input.signal);
    if (!retained(offer)) return { reason: "scope-changed" };
    if (!described.ok) return refusal(described);
    if (described.data.methods.some((method) => method.form === "url"))
      offer.input = { ...input, native: { ...input.native, password: false } };
    const site = portable(offer.saved, input.account);
    if (!site) return { reason: "vault-unavailable" };
    const mappings = await store.read().catch(() => undefined);
    if (!retained(offer)) return { reason: "scope-changed" };
    for (const method of input.asIdentityProvider ? [] : described.data.methods) {
      const entry: Method = {
        ...method,
        source: {
          account: { connectionId: input.account.connectionId, itemId: input.account.itemId },
          method: method.method,
          sourceEvidence: described.data.sourceEvidence,
        },
        candidates: [],
      };
      offer.methods.push(entry);
      if (!mappings) {
        entry.reason = "mapping-store-unavailable";
        continue;
      }
      const key = mappingKey({ ...site, method: method.method });
      const saved = mappings.find(
        (record) =>
          mappingKey(record.source) === key &&
          record.source.sourceEvidence === described.data.sourceEvidence,
      );
      // oxlint-disable-next-line no-await-in-loop -- vault discovery shares a single native lane
      if (!(await prepare(offer, entry, saved))) return { reason: "scope-changed" };
    }
    if (!(await current(offer))) return { reason: "scope-changed" };
    return input.automatic ? automatic(offer) : undefined;
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
      const { tabId, frameId } = input.document;
      const early = (reason: string) => ({
        offerId: "",
        result: Promise.resolve<SsoChoiceOutcome>({ ok: false, reason }),
      });
      invalidateTab(tabId, "replaced");
      const request: { frameId: number; reason?: string } = { frameId };
      pending.set(tabId, request);
      const saved = await options.readSettings().catch(() => undefined);
      // The invalidation that ended this request names why, as a settings change.
      if (pending.get(tabId) !== request) return early(request.reason ?? "replaced");
      pending.delete(tabId);
      if (!saved) return early("unavailable");
      if (!saved.ok) return early("settings-unavailable");
      if (input.entries && !v.safeParse(ssoEntriesSchema, input.entries).success)
        return early("entry-invalid");
      const path = options.currentDocument(input.document);
      if (path === undefined) return early("document-gone");
      let done!: Offer["done"];
      const result = new Promise<SsoChoiceOutcome>((complete) => {
        done = complete;
      });
      const offer: Offer = {
        id: newId(),
        input,
        saved,
        path,
        methods: [],
        choosing: false,
        expiresAt: Date.now() + OFFER_MS,
        done,
        releaseAbort: () => undefined,
      };
      offers.set(tabId, offer);
      const abort = () => invalidateTab(tabId, "cancelled");
      input.signal?.addEventListener("abort", abort, { once: true });
      const expiry = setTimeout(() => invalidateTab(tabId, "expired"), OFFER_MS);
      offer.releaseAbort = () => {
        clearTimeout(expiry);
        input.signal?.removeEventListener("abort", abort);
      };
      const refused = await build(offer).catch((): Refusal => ({ reason: "unavailable" }));
      if (refused && !offer.settled) {
        if (refused.field) offer.field = refused.field;
        offer.reason = refused.reason;
        finish(offer, { ok: false, reason: refused.reason });
      }
      // Ready only after the automatic decision, so no popup choice races it.
      offer.ready = true;
      return { offerId: offer.id, result };
    },
    async get(tabId: number): Promise<SsoResponse> {
      const offer = offers.get(tabId);
      if (!offer || !offer.ready || (offer.settled && !offer.reason)) return { ok: true };
      if (!(await current(offer)) || !retained(offer)) {
        if (offers.get(tabId) === offer) invalidateTab(tabId);
        return failure("scope-changed");
      }
      return { ok: true, offer: shown(offer) };
    },
    choose,
    cancel(tabId: number, offerId: string): SsoActionResponse {
      if (offers.get(tabId)?.id !== offerId) return failure("offer-gone");
      invalidateTab(tabId, "cancelled");
      return { ok: true };
    },
    invalidateTab,
    /**
     * A document of the tab went away or moved to another path: withdraws the offer only
     * when it is the offer's own frame, or the top frame of a framed offer.
     */
    documentChanged(document: { tabId: number; frameId: number }, reason: string) {
      const frameId =
        offers.get(document.tabId)?.input.document.frameId ?? pending.get(document.tabId)?.frameId;
      if (frameId !== undefined && (document.frameId === frameId || document.frameId === 0))
        invalidateTab(document.tabId, reason);
    },
    invalidateAll(reason = "scope-changed") {
      for (const tabId of new Set([...offers.keys(), ...pending.keys()]))
        invalidateTab(tabId, reason);
      receipts.clear();
    },
    /**
     * The vaults may have changed: withdraws only the offers whose catalog really changed,
     * as a status read changes nothing, and drops the mappings of accounts that are gone.
     */
    async vaultStateMayChange() {
      const saved = await options.readSettings().catch(() => undefined);
      for (const [tabId, offer] of [...offers])
        if (!saved?.ok || !matching(saved, offer)) invalidateTab(tabId, "vault-changed");
      if (!saved?.ok) return;
      const accounts = JSON.stringify(
        saved.catalog.connections.map((entry) => [
          entry.provider,
          entry.server,
          entry.userId ?? entry.lockedUserId,
          entry.snapshotId,
          entry.items.map((item) => item.id),
        ]),
      );
      if (accounts === pruned) return;
      pruned = accounts;
      await store.prune(goneFrom(saved.catalog)).catch(() => undefined);
    },
    /** Rechecks the route and the exact observed URL entry; one use, even on refusal. */
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
      if (selection.kind === "native") {
        if (!(await current(offer))) return failure("scope-changed");
      } else {
        const method = methodOf(offer, selection.source.method.number);
        if (!method) return failure("method-unavailable");
        const refused = await validateSso(offer, method);
        if (refused) return failure(refused.reason);
        if (
          selection.entryId &&
          (!offer.input.entryCurrent ||
            !(await offer.input.entryCurrent(selection.entryId)) ||
            !(await current(offer)))
        )
          return failure("entry-changed");
      }
      if (!retained(offer)) return failure("scope-changed");
      invalidateTab(offer.input.document.tabId, "consumed");
      return { ok: true, document: offer.input.document, account: offer.input.account, selection };
    },
  };
}
export type SsoChoiceController = ReturnType<typeof createSsoChoiceController>;
