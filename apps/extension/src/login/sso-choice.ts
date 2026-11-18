import * as v from "valibot";
import { newId } from "@pateat/contracts/ids";
import {
  getItemEligibility,
  isSiteAllowed,
  isSiteExcluded,
  MAX_SETTINGS_DOCUMENT_BYTES,
  MAX_SSO_MAPPINGS,
  settingsDocumentBytes,
  ssoMappingKey,
  ssoMappingsSchema,
  type LoginAccount,
  type LoginDocument,
  type SettingsChangeCause,
  type SettingsResponse,
  type SettingsSnapshot,
  type SsoMapping,
} from "@pateat/contracts";
import { exportedSettings } from "../service/settings-sync";
import { ssoScopeDependencies } from "./sso-dependencies";
import type { VaultSsoSource } from "./sso-vault";
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
  type SsoPortableAccount,
  type SsoResolvedChoice,
} from "./sso-choice-model";

export type { SsoChoiceInput, SsoChoiceOutcome, SsoResolvedChoice } from "./sso-choice-model";
type Receipt = {
  offer: Offer;
  selection: SsoResolvedChoice;
  /** Only an automatic URL-form choice requires this exact destination again when consumed. */
  entryOrigin?: string;
  /** An automatic choice of a broker page's learned entry requires it again when consumed. */
  learned?: true;
};
type Refusal = { reason: string; field?: string };
type SsoSelection = Extract<SsoChooseRequest["selection"], { kind: "sso" }>;
const failure = (reason: string): { ok: false; reason: string } => ({ ok: false, reason });
const refusal = (found: { reason: string; field?: string }): Refusal => ({
  reason: found.reason,
  ...(found.field ? { field: found.field } : {}),
});
const OFFER_MS = 600_000;
/** The saved mappings of the site item `site`, in a stable form to compare. */
function siteMappings(
  settings: SettingsSnapshot["settings"],
  site: SsoPortableAccount | undefined,
) {
  if (!site) return "";
  const own = ssoMappingKey({ ...site, method: 0 });
  return JSON.stringify(
    (settings.ssoMappings ?? [])
      .filter((entry) => ssoMappingKey({ ...entry, method: 0 }) === own)
      .toSorted((left, right) => left.method - right.method),
  );
}
type UpdateSettings = (
  expectedRevision: number | undefined,
  cause: SettingsChangeCause,
  mutate: (snapshot: SettingsSnapshot) => SettingsSnapshot,
  authorize?: (snapshot: SettingsSnapshot) => Promise<boolean>,
) => Promise<SettingsSnapshot>;

/**
 * Method choice, and the SSO mappings it saves in the synced settings (ADR 0085). Neither
 * a popup answer nor a consumed receipt authorizes a click or credential release. The
 * executor must keep its own document/origin fences. Offers and receipts are memory-only:
 * a worker restart withdraws them, never restores authority.
 */
export function createSsoChoiceController(options: {
  source: VaultSsoSource;
  readSettings: () => Promise<SettingsResponse>;
  /** The live path of the exact document, or undefined once it is gone. */
  currentDocument: (document: LoginDocument) => string | undefined;
  /** The trusted settings mutation; without it a mapping cannot be saved. */
  updateSettings?: UpdateSettings;
}) {
  const offers = new Map<number, Offer>();
  const receipts = new Map<string, Receipt>();
  /**
   * Requests still reading settings, by tab; an invalidation marks them with its reason,
   * and a settings change marks them to read the settings again.
   */
  const pending = new Map<number, { frameId: number; reason?: string; reread?: boolean }>();
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
  const selectedOf = (method: Method) =>
    method.candidates.find((entry) => entry.id === method.selectedId);
  type Choice = Method["candidates"][number]["selected"];
  /**
   * What an offer or request reads from the settings: the site account and the IdP
   * accounts of `choices`, the site's and those IdP origins' rules and saved defaults,
   * and the private-window pausing, as an SSO flow reads them.
   */
  function dependencies(input: SsoChoiceInput, choices: Choice[], saved: Saved) {
    const { account, document, incognito } = input;
    const origins = choices.map((entry) => entry.origin);
    return ssoScopeDependencies(
      {
        accounts: [account, ...choices.map((entry) => entry.account)],
        pages: [document.origin, ...origins],
        origins: [account.origin, ...origins],
        incognito,
      },
      saved,
    );
  }
  /**
   * The IdP accounts and origins the offer's methods use: each selected one, and the one
   * each saved mapping named when the offer was made, so a mapping refused for its IdP
   * account's settings recovers once the person fixes them.
   */
  function offerChoices(offer: Offer): Choice[] {
    const site = portable(offer.saved, offer.input.account);
    const mappings = offer.saved.snapshot.settings.ssoMappings ?? [];
    return offer.methods.flatMap((method) => {
      const chosen = selectedOf(method)?.selected;
      const key = site && method.stored && ssoMappingKey({ ...site, method: method.method.number });
      const stored = key ? mappings.find((entry) => ssoMappingKey(entry) === key) : undefined;
      const account = stored && resolveAccount(offer.saved, stored.idp);
      return [
        ...(chosen ? [chosen] : []),
        ...(stored && account ? [{ account, origin: stored.idp.origin }] : []),
      ];
    });
  }
  /**
   * Whether `saved` keeps the offer's settings and catalog. A newer revision keeps it
   * while everything the offer reads is unchanged (`dependencies`), as a sync of
   * unrelated settings or another site's account choice leaves it, and the site item's
   * mappings are still the offer's own copy: a mapping another tab saved or removed for
   * this item withdraws it.
   */
  function matching(saved: Saved, offer: Offer) {
    const { account, document } = offer.input;
    return (
      siteMappings(saved.snapshot.settings, portable(offer.saved, account)) === offer.mappings &&
      dependencies(offer.input, offerChoices(offer), saved) ===
        dependencies(offer.input, offerChoices(offer), offer.saved) &&
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
  function resolve(
    offer: Offer,
    selection: SsoResolvedChoice,
    entryOrigin?: string,
    learned?: true,
  ) {
    if (!retained(offer) || offer.settled) return failure("offer-gone");
    const choiceId = newId();
    receipts.set(choiceId, {
      offer,
      selection,
      ...(entryOrigin ? { entryOrigin } : {}),
      ...(learned ? { learned } : {}),
    });
    finish(offer, { ok: true, choiceId });
    return { ok: true as const };
  }
  /**
   * A URL-form method has no label: it runs automatically only when exactly one observed
   * entry is present and its fresh, explicit destination is the mapped origin. Anything
   * else waits for the person to choose the entry; a label is never guessed.
   */
  async function automaticUrl(offer: Offer, method: Method): Promise<Refusal | undefined> {
    const found = await urlEntry(offer, method);
    if (found === "withdrawn") return { reason: "scope-changed" };
    if (!found) {
      offer.reason = "entry-required";
      return undefined;
    }
    // After the entries' own awaits, so a vault or document change during them refuses.
    const refused = await validateSso(offer, method);
    if (refused) return refused;
    resolveUrl(offer, method, found);
    return undefined;
  }
  type UrlEntry = { entry: { id: string; label: string }; exact: boolean };
  function resolveUrl(offer: Offer, method: Method, { entry, exact }: UrlEntry) {
    const selected = selectedOf(method)!.selected;
    resolve(
      offer,
      { kind: "sso", source: method.source, selected, entryId: entry.id, label: entry.label },
      exact ? selected.origin : undefined,
      exact ? undefined : true,
    );
  }
  /**
   * The one entry the automatic order presses for a mapped URL-form method: the one whose
   * own destination is the mapped origin, or, on a broker page where none is, the one the
   * page learned for that origin (owner, 2026-11-18, ADR 0085). Undefined when none or
   * several qualify.
   */
  async function urlEntry(
    offer: Offer,
    method: Method,
  ): Promise<UrlEntry | "withdrawn" | undefined> {
    const { entryCurrent, entryOrigin, entryLearned, entries } = offer.input;
    const origin = selectedOf(method)!.selected.origin;
    const matches: { id: string; label: string }[] = [];
    for (const entry of entryCurrent && entryOrigin ? (entries ?? []) : []) {
      // oxlint-disable-next-line no-await-in-loop -- each entry's evidence is its own
      const present = await entryCurrent?.(entry.id).catch(() => false);
      const same =
        present &&
        // oxlint-disable-next-line no-await-in-loop -- destination evidence belongs to this entry
        (await entryOrigin?.(entry.id, origin).catch(() => false));
      if (!retained(offer)) return "withdrawn";
      if (same) matches.push(entry);
      if (matches.length > 1) break;
    }
    if (matches.length)
      return matches.length === 1 ? { entry: matches[0]!, exact: true } : undefined;
    // On a broker page no entry names the mapped origin: its provider button submits to
    // the site, which sends the tab on.
    const learned: { id: string; label: string }[] = [];
    for (const entry of entryCurrent && entryLearned ? (entries ?? []) : []) {
      const known =
        // oxlint-disable-next-line no-await-in-loop -- each entry's evidence is its own
        (await entryCurrent?.(entry.id).catch(() => false)) &&
        // oxlint-disable-next-line no-await-in-loop -- what the page learned belongs to this entry
        (await entryLearned?.(entry.id, origin).catch(() => false));
      if (!retained(offer)) return "withdrawn";
      if (known) learned.push(entry);
      if (learned.length > 1) break;
    }
    return learned.length === 1 ? { entry: learned[0]!, exact: false } : undefined;
  }
  /**
   * **Log in now** (ADR 0088 amendment of 2026-11-18): it presses by itself only the SSO
   * method the automatic order decides, on an item with no numbered method and no passkey
   * the order would take first, where its hop is allowed. Anything else leaves the
   * explicit chooser open, as before.
   */
  async function automaticSso(offer: Offer): Promise<Refusal | undefined> {
    const { native, hopAllowed } = offer.input;
    const preferred = offer.methods.find((entry) => entry.automatic);
    const chosen = preferred && selectedOf(preferred);
    if (
      !preferred ||
      !chosen ||
      !hopAllowed ||
      native.passkey ||
      offer.methods.some((entry) => !entry.automatic)
    )
      return undefined;
    const found = preferred.form === "url" ? await urlEntry(offer, preferred) : undefined;
    if (found === "withdrawn") return { reason: "scope-changed" };
    if (preferred.form === "url" && !found) return undefined;
    const allowed = await hopAllowed(chosen.selected.origin).catch(() => false);
    if (!retained(offer)) return { reason: "scope-changed" };
    if (!allowed) return undefined;
    // A refusal the person would meet in the chooser leaves the chooser to show it.
    const refused = await validateSso(offer, preferred);
    if (refused) return refused.reason === "scope-changed" ? refused : undefined;
    if (found) resolveUrl(offer, preferred, found);
    else
      resolve(offer, {
        kind: "sso",
        source: preferred.source,
        selected: chosen.selected,
        ...(preferred.label ? { label: preferred.label } : {}),
      });
    return undefined;
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
    const refused = await write(offer, method, {
      ...site,
      method: method.method.number,
      idp: { ...idp, origin: chosen.selected.origin },
    });
    if (refused) return refused;
    method.stored = true;
    method.selectedId = chosen.id;
    delete method.reason;
    delete method.field;
    // The offer's own explanation came from a method that was missing its mapping.
    delete offer.reason;
    delete offer.field;
    return undefined;
  }
  /**
   * Saves a method's mapping, or removes it without `next`, in the synced settings at
   * once, with the `sso-mapping` cause that running logins and offers keep (ADR 0085).
   * Saving refuses a full list or settings document before it writes; removing never does.
   */
  async function write(
    offer: Offer,
    method: Method,
    next?: SsoMapping,
  ): Promise<string | undefined> {
    const site = portable(offer.saved, offer.input.account);
    if (!site) return "vault-unavailable";
    const key = ssoMappingKey({ ...site, method: method.method.number });
    let refused: string | undefined;
    const refuse = (reason: string) => {
      refused = reason;
      throw new Error(reason);
    };
    const same = (entry: SsoMapping) => ssoMappingKey(entry) === key;
    let written: string | undefined;
    try {
      if (!options.updateSettings) refuse("mapping-save-failed");
      await options.updateSettings!(
        undefined,
        "sso-mapping",
        (snapshot) => {
          // Another tab's mapping for this item since the offer was made withdraws it.
          if (siteMappings(snapshot.settings, site) !== offer.mappings) refuse("scope-changed");
          const stored = snapshot.settings.ssoMappings ?? [];
          const found = stored.find(same);
          // A mapping saved as it is already, or one already gone, writes nothing.
          if (next ? JSON.stringify(found) === JSON.stringify(next) : !found) refuse("unchanged");
          const rest = stored.filter((entry) => !same(entry));
          const ssoMappings = next ? [...rest, next] : rest;
          const settings = { ...snapshot.settings, ssoMappings };
          const full = ssoMappings.length > MAX_SSO_MAPPINGS;
          if (next && !v.is(ssoMappingsSchema, ssoMappings))
            refuse(full ? "mapping-limit" : "mapping-invalid");
          // The service document is what must fit; the vault connections stay here.
          if (
            next &&
            settingsDocumentBytes(exportedSettings(settings)) > MAX_SETTINGS_DOCUMENT_BYTES
          )
            refuse("mapping-limit");
          written = siteMappings(settings, site);
          return { ...snapshot, settings };
        },
        async () => retained(offer),
      );
      // The offer's own copy follows its own write.
      if (written !== undefined) offer.mappings = written;
    } catch {
      if (!retained(offer)) return "scope-changed";
      if (refused !== "unchanged") return refused ?? "mapping-save-failed";
    }
    return (await current(offer)) ? undefined : "scope-changed";
  }
  /** Removes a method's saved mapping, even one whose items this device cannot resolve. */
  async function unmap(offer: Offer, method: Method) {
    const refused = await write(offer, method);
    if (refused) return refused;
    delete method.stored;
    method.candidates = method.candidates.filter((entry) => entry.id !== method.selectedId);
    delete method.selectedId;
    method.reason = "mapping-required";
    if (method.discovered) return undefined;
    const listed = await discover(offer, method);
    if (listed?.reason === "scope-changed") return "scope-changed";
    if (listed) Object.assign(method, listed);
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
      const account = resolveAccount(offer.saved, saved.idp);
      const choice = account && { account, origin: saved.idp.origin };
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
    // An unresolved preferred method waits for the person; it never falls back.
    if (!selectedOf(preferred)) {
      offer.reason = preferred.reason ?? "mapping-required";
      if (preferred.field) offer.field = preferred.field;
      return undefined;
    }
    if (preferred.form === "url") return automaticUrl(offer, preferred);
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
    const mappings = offer.saved.snapshot.settings.ssoMappings ?? [];
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
      const key = ssoMappingKey({ ...site, method: method.method.number });
      const saved = mappings.find((record) => ssoMappingKey(record) === key);
      if (saved) entry.stored = true;
      // oxlint-disable-next-line no-await-in-loop -- vault discovery shares a single native lane
      if (!(await prepare(offer, entry, saved))) return { reason: "scope-changed" };
    }
    if (!(await current(offer))) return { reason: "scope-changed" };
    if (input.automatic === "sso") return automaticSso(offer);
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
      /** The offer is open and waits for the person's choice in the popup. */
      waiting?: true;
    }> {
      const { tabId, frameId } = input.document;
      const early = (reason: string) => ({
        offerId: "",
        result: Promise.resolve<SsoChoiceOutcome>({ ok: false, reason }),
      });
      invalidateTab(tabId, "replaced");
      const request: { frameId: number; reason?: string; reread?: boolean } = { frameId };
      pending.set(tabId, request);
      let saved = await options.readSettings().catch(() => undefined);
      // A settings change during the read may not be in it: a newer read that changes
      // what the request reads ends it, as it ends an open offer, and any other is used.
      while (request.reread && pending.get(tabId) === request) {
        request.reread = false;
        // oxlint-disable-next-line no-await-in-loop -- each read follows a settings change
        const next = await options.readSettings().catch(() => undefined);
        if (
          pending.get(tabId) === request &&
          (!saved?.ok ||
            !next?.ok ||
            dependencies(input, [], saved) !== dependencies(input, [], next))
        )
          invalidateTab(tabId, "settings-changed");
        saved = next;
      }
      // The invalidation that ended this request names why, as a settings change.
      if (pending.get(tabId) !== request) return early(request.reason ?? "replaced");
      pending.delete(tabId);
      if (!saved) return early("unavailable");
      if (!saved.ok) return early("settings-unavailable");
      // A change since the coordinator's own read, before this request began, ends it too.
      if (input.basis && dependencies(input, [], input.basis) !== dependencies(input, [], saved))
        return early("settings-changed");
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
        mappings: siteMappings(saved.snapshot.settings, portable(saved, input.account)),
        path,
        methods: [],
        choosing: false,
        expiresAt: Date.now() + OFFER_MS,
        done,
        releaseAbort: () => undefined,
      };
      // A request whose owner ended while the settings were read never fires `abort` again:
      // no offer is kept for it, nor a timer.
      if (input.signal?.aborted) return early("cancelled");
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
      return {
        offerId: offer.id,
        result,
        ...(offer.settled ? {} : { waiting: true as const }),
      };
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
    /**
     * The settings changed: withdraws only the offers whose own settings changed
     * (`matching`), as the vault notice below does, so a sync of unrelated settings or
     * another site's choice keeps an offer the person is still answering.
     */
    async settingsChanged() {
      for (const request of pending.values()) request.reread = true;
      const saved = await options.readSettings().catch(() => undefined);
      for (const [tabId, offer] of [...offers])
        if (offers.get(tabId) === offer && (!saved?.ok || !matching(saved, offer)))
          invalidateTab(tabId, "settings-changed");
    },
    invalidateAll(reason = "scope-changed") {
      for (const tabId of new Set([...offers.keys(), ...pending.keys()]))
        invalidateTab(tabId, reason);
      receipts.clear();
    },
    /**
     * The vaults may have changed: withdraws only the offers whose catalog really changed,
     * as a status read changes nothing. A vault sync drops the mappings of deleted items
     * from the settings itself (ADR 0085).
     */
    async vaultStateMayChange() {
      const saved = await options.readSettings().catch(() => undefined);
      for (const [tabId, offer] of [...offers])
        if (!saved?.ok || !matching(saved, offer)) invalidateTab(tabId, "vault-changed");
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
        if (selection.entryId) {
          const { entryCurrent, entryOrigin, entryLearned } = offer.input;
          if (
            !entryCurrent ||
            !(await entryCurrent(selection.entryId)) ||
            (receipt.entryOrigin !== undefined &&
              (!entryOrigin || !(await entryOrigin(selection.entryId, receipt.entryOrigin)))) ||
            (receipt.learned &&
              (!entryLearned ||
                !(await entryLearned(selection.entryId, selection.selected.origin))))
          )
            return failure("entry-changed");
          // The entry's own awaits may have outlived a vault, policy or document change.
          const again = await validateSso(offer, method);
          if (again) return failure(again.reason);
        }
      }
      if (!retained(offer)) return failure("scope-changed");
      invalidateTab(offer.input.document.tabId, "consumed");
      return { ok: true, document: offer.input.document, account: offer.input.account, selection };
    },
  };
}
export type SsoChoiceController = ReturnType<typeof createSsoChoiceController>;
