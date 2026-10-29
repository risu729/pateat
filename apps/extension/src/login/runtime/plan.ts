import {
  bindingGaps,
  chooseLoginRoute,
  defaultLoginBinding,
  fillLoginBinding,
  findLoginBinding,
  heldRouteMissing,
  loginFieldFacts,
  loginFieldSource,
  loginDisplayNames,
  passkeyAnswersRequest,
  passwordStopOrMiss,
  passwordVariants,
  recipeHasRoute,
  resolveBindingFields,
  resolveLoginPlan,
  routeSlots,
  templateLoginBinding,
  TOTP_HANDLER_SLOT,
  totpFieldMismatch,
  type LoginBindingTemplate,
  type LoginAccountBinding,
  type LoginChoiceAccount,
  type LoginItemFacts,
  type LoginRecipe,
  type LoginRouteChoice,
  type SavedLoginBinding,
  type SettingsResponse,
  type SettingsSnapshot,
  type VaultCatalog,
  type VaultConnectionMetadata,
} from "@pateat/contracts";
import { type DestinationAnswer } from "../wire";
import { grantProbeOrigin, probeBinding } from "../dummy";
import { findLiveSiteCandidates } from "../../vault/site-candidates";
import { passkeyScriptsRun } from "../../passkeys/rp-id";
import { type LiveDocument, type Execution, type Choice, type UnsavedChoice } from "./types";
import { withItemOrigin, sameSiteAs, accountTargetsOn, codeFieldOf, passwordMiss } from "./steps";
import { probeDocument } from "./messages";
import { probeMode } from "./constants";
import { choose } from "./choice-save";
import { listedBrowserSite } from "./pause";
import type { Runtime } from "./state";

/**
 * Origin scope for the chosen account of this document. A live provider URI match for
 * the document's own URL satisfies the item origin check for that document only; it is
 * never saved as `allowedOrigins`. Only the chosen account's connection is asked, and a
 * match is reused while that connection's snapshot is unchanged.
 */
export async function liveScope(
  rt: Runtime,
  snapshot: Extract<SettingsResponse, { ok: true }>,
  live: LiveDocument,
  selected: { connectionId: string; itemId: string },
): Promise<
  | { catalog: VaultCatalog }
  | { reason: "vault-unavailable" | "item-uri-unevaluated" | "url-too-long" }
> {
  const { catalog } = snapshot;
  const connection = catalog.connections.find((entry) => entry.id === selected.connectionId);
  const item = connection?.items.find((entry) => entry.id === selected.itemId);
  if (!rt.uris || !connection?.snapshotId || connection.provider !== "bitwarden")
    return { catalog };
  if (!item || item.allowedOrigins.includes(live.document.origin)) return { catalog };
  // An item awaiting field review is unavailable; do not report it as a URI mismatch.
  if (connection.quarantinedItemIds?.includes(item.id)) return { reason: "vault-unavailable" };
  const cached = live.uriMatch;
  if (
    !cached ||
    cached.connectionId !== selected.connectionId ||
    cached.itemId !== selected.itemId ||
    cached.snapshotId !== connection.snapshotId
  ) {
    delete live.uriMatch;
    const scope = await findLiveSiteCandidates({
      settings: snapshot.snapshot.settings,
      catalog: { ...catalog, connections: [connection] },
      url: live.url,
      match: rt.uris,
    });
    if (!scope.ok) return scope.reason === "url-too-long" ? { reason: scope.reason } : { catalog };
    const matched = scope.candidates.some(
      (entry) => entry.itemId === selected.itemId && entry.snapshotId === connection.snapshotId,
    );
    if (!matched) {
      // Unevaluated rules may still cover this page; never treat them as a mismatch.
      if (scope.unavailableConnections.length > 0) return { reason: "vault-unavailable" };
      return scope.incompleteItems.some((entry) => entry.itemId === selected.itemId)
        ? { reason: "item-uri-unevaluated" }
        : { catalog };
    }
    live.uriMatch = {
      connectionId: selected.connectionId,
      itemId: selected.itemId,
      snapshotId: connection.snapshotId,
    };
  }
  return { catalog: withItemOrigin(catalog, selected, live.document.origin) };
}

/**
 * Whether the chosen item matches `url`: by its static `allowedOrigins` in `granted`, or
 * by a live provider URI match of the full URL, which needs a Bitwarden connection with a
 * snapshot. `vault-unavailable` and `item-uri-unevaluated` when rules that could match
 * were not evaluated, and the matcher's own reason when it could not run.
 */
export async function itemMatchesUrl(
  rt: Runtime,
  snapshot: Extract<SettingsResponse, { ok: true }>,
  selected: { connectionId: string; itemId: string },
  url: string,
  granted: VaultCatalog,
): Promise<{ snapshotId?: string } | { reason: string }> {
  const item = granted.connections
    .find((entry) => entry.id === selected.connectionId)
    ?.items.find((entry) => entry.id === selected.itemId);
  if (item?.allowedOrigins.includes(new URL(url).origin)) return {};
  const connection = snapshot.catalog.connections.find(
    (entry) => entry.id === selected.connectionId,
  );
  if (!rt.uris || !connection?.snapshotId || connection.provider !== "bitwarden")
    return { reason: "mismatch" };
  const scope = await findLiveSiteCandidates({
    settings: snapshot.snapshot.settings,
    catalog: { ...snapshot.catalog, connections: [connection] },
    url,
    match: rt.uris,
  });
  if (!scope.ok) return { reason: scope.reason };
  if (
    scope.candidates.some(
      (entry) => entry.itemId === selected.itemId && entry.snapshotId === connection.snapshotId,
    )
  )
    return { snapshotId: connection.snapshotId };
  if (scope.unavailableConnections.length > 0) return { reason: "vault-unavailable" };
  if (scope.incompleteItems.some((entry) => entry.itemId === selected.itemId))
    return { reason: "item-uri-unevaluated" };
  return { reason: "mismatch" };
}

/**
 * For a document in a frame inside the page, the chosen item must also match the tab's
 * URL, as the official Bitwarden client requires before it fills a frame (ADR 0017).
 * `granted` is the catalog whose static `allowedOrigins` count; a live provider URI
 * match is reused while that connection's snapshot is unchanged.
 */
export async function topScope(
  rt: Runtime,
  snapshot: Extract<SettingsResponse, { ok: true }>,
  live: LiveDocument,
  selected: { connectionId: string; itemId: string },
  granted: VaultCatalog,
): Promise<{ reason: string } | undefined> {
  if (!live.topUrl) return undefined;
  const connection = snapshot.catalog.connections.find(
    (entry) => entry.id === selected.connectionId,
  );
  const cached = live.topMatch;
  if (
    cached?.connectionId === selected.connectionId &&
    cached.itemId === selected.itemId &&
    cached.snapshotId === connection?.snapshotId
  )
    return undefined;
  delete live.topMatch;
  const matched = await itemMatchesUrl(rt, snapshot, selected, live.topUrl, granted);
  if ("reason" in matched)
    return { reason: matched.reason === "mismatch" ? "frame-top-mismatch" : matched.reason };
  if (matched.snapshotId)
    live.topMatch = {
      connectionId: selected.connectionId,
      itemId: selected.itemId,
      snapshotId: matched.snapshotId,
    };
  return undefined;
}

/**
 * Why a step's form may not submit to `destination`, an HTTP(S) URL off the document's
 * origin (ADR 0051): it must be on the document's site, with no credentials in the URL
 * (`cross-site`), through HTTPS
 * unless the document itself is HTTP (`insecure`), at a site Pateat may act on
 * (`no-site-access`, also for an excluded site), and matched by the login's item under
 * its URI match detection (`item-mismatch`). `unchecked` when the settings changed or the
 * item's rules could not be evaluated now.
 */
export async function destinationRefusal(
  rt: Runtime,
  run: Execution,
  destination: URL,
): Promise<Exclude<DestinationAnswer, { ok: true }>["reason"] | undefined> {
  const page = new URL(run.live.document.origin);
  // HTTPS, or HTTP from an HTTP document (ADR 0050); the content script sends no other.
  if (
    destination.protocol !== "https:" &&
    (destination.protocol !== "http:" || page.protocol !== "http:")
  )
    return "insecure";
  if (destination.username || destination.password || !sameSiteAs(page.origin)(destination))
    return "cross-site";
  const admission = probeDocument(rt, destination)
    ? "admitted"
    : await rt.sites?.admission(destination).catch(() => "settings-unavailable" as const);
  if (admission === "settings-unavailable") return "unchecked";
  if (admission !== "admitted") return "no-site-access";
  const snapshot = await rt.settings
    .handle({ version: 1, type: "settings.get" })
    .catch(() => undefined);
  if (!snapshot?.ok || snapshot.snapshot.revision !== run.metadata.policyRevision)
    return "unchecked";
  const matched = await itemMatchesUrl(
    rt,
    snapshot,
    run.metadata.account,
    destination.href,
    snapshot.catalog,
  );
  if (!("reason" in matched)) return undefined;
  // A Bitwarden connection without a snapshot is one whose vault is not readable now.
  const connection = snapshot.catalog.connections.find(
    (entry) => entry.id === run.metadata.account.connectionId,
  );
  const unreadable = connection?.provider === "bitwarden" && !connection.snapshotId;
  return matched.reason === "mismatch" && !unreadable ? "item-mismatch" : "unchecked";
}

/**
 * The chosen item's binding for one route's `slots` (ADR 0027): the synced binding, else
 * the automatic one for built-in slots, else one built from a template: another item's
 * saved binding of the recipe, then the slot map of a recipe generated from this device.
 * The synced binding's entries are used as they are, and its entries for other slots are
 * ignored. With `fillGaps`, the slots it holds no entry for are filled as for an item
 * without one (amended 2026-10-19, `fillLoginBinding`), and the widened binding counts as
 * unsaved, so it is saved after `authenticated`; without, such a binding refuses
 * `binding-slots-mismatch`. It is mapped to this device's field IDs by the catalog's raw
 * field names. A binding that would fill a field holding a TOTP key as text, or make the
 * code from a custom field holding none, refuses `totp-field-mismatch`
 * (`totpFieldMismatch`).
 */
export async function bindingFor(
  _rt: Runtime,
  catalog: VaultCatalog,
  settingsValue: SettingsSnapshot["settings"],
  recipe: LoginRecipe,
  choice: Choice,
  documentOrigin: string,
  slots: readonly string[],
  slotMap: () => Promise<LoginBindingTemplate | undefined>,
  fillGaps: boolean,
): Promise<
  | { ok: true; binding: LoginAccountBinding; synced: SavedLoginBinding; saved: boolean }
  | { ok: false; reason: string }
> {
  const connection = catalog.connections.find((entry) => entry.id === choice.connectionId);
  const item = connection?.items.find((entry) => entry.id === choice.itemId);
  if (!connection?.userId || !item) return { ok: false, reason: "vault-unavailable" };
  const owner = {
    provider: connection.provider,
    server: connection.server,
    userId: connection.userId,
    itemId: item.id,
  };
  const named = { ...owner, itemName: item.label, accountName: connection.label };
  // Names, and the flags that pick the `totp` slot's field (`totpFieldReference`).
  const fieldNames = item.fields.map(({ id, name, empty, totpSeed }) => ({
    id,
    name,
    ...(empty ? { empty } : {}),
    ...(totpSeed ? { totpSeed } : {}),
  }));
  // Sibling bindings were proven by an authenticated login, so they go first.
  const templates = async () => {
    const found: LoginBindingTemplate[] = settingsValue.bindings
      .filter((entry) => entry.recipeId === recipe.id && entry.origin === recipe.origin)
      .map((entry) => entry.slots);
    const generated = await slotMap();
    if (generated) found.push(generated);
    return found;
  };
  const saved = findLoginBinding(settingsValue.bindings, recipe, owner);
  let binding = saved ?? defaultLoginBinding(slots, recipe, named, fieldNames);
  let widened = false;
  if (saved && fillGaps && bindingGaps(saved, slots).length > 0) {
    const filled = fillLoginBinding(saved, slots, await templates(), fieldNames);
    if (!filled.ok) return { ok: false, reason: filled.reason };
    binding = filled.binding;
    widened = filled.widened;
  } else if (!binding) {
    const built = templateLoginBinding(slots, recipe, named, await templates(), fieldNames);
    if (!built.ok) return { ok: false, reason: built.reason };
    binding = built.binding;
  }
  const resolved = resolveBindingFields(binding, slots, fieldNames);
  if (!resolved.ok) return { ok: false, reason: resolved.reason };
  // A TOTP key is never filled as text and a code is made only from a key, so such a
  // binding is refused before any step runs (ADR 0027, owner 2026-10-23).
  if (
    resolved.slots.some(({ slot, fieldId }) =>
      totpFieldMismatch(
        slot,
        item.fields.find((field) => field.id === fieldId),
      ),
    )
  )
    return { ok: false, reason: "totp-field-mismatch" };
  return {
    ok: true,
    binding: {
      origin: documentOrigin,
      connectionId: connection.id,
      itemId: item.id,
      slots: resolved.slots,
    },
    // A default saved from a stored binding is named after this device's connection
    // too. The stored binding itself is only ever widened, keeping its entries.
    synced: saved ? { ...binding, accountName: connection.label } : binding,
    saved: saved !== undefined && !widened,
  };
}

/**
 * The item's facts for a new login (ADR 0027): its password and TOTP fields from the
 * catalog's value-free flags and the account's allowed fields, and its passkeys from one
 * vault search. Read once per login; never sent anywhere. Without `passkeys`, as on a site
 * whose passkey requests go to the browser (ADR 0007), the item holds no passkey here and
 * the vault is not searched.
 */
export async function itemFacts(
  rt: Runtime,
  connection: VaultConnectionMetadata,
  owner: { origin: string; connectionId: string; itemId: string; fieldIds: string[] },
  passkeys = true,
): Promise<LoginItemFacts> {
  const item = connection.items.find((entry) => entry.id === owner.itemId);
  const fieldFacts = item
    ? loginFieldFacts(item, owner.fieldIds)
    : { password: false, totp: false };
  // The synthetic probe item names its password field `password`; it holds a value.
  if (probeMode && owner.origin === rt.vars.origin && owner.fieldIds.includes("password"))
    fieldFacts.password = true;
  // Its synthetic `totp` field counts as a TOTP secret only when the probe says so.
  if (
    probeMode &&
    owner.origin === rt.vars.origin &&
    rt.vars.probeTotp &&
    owner.fieldIds.includes("totp")
  )
    fieldFacts.totp = true;
  if (!passkeys) return { ...fieldFacts, passkey: false, discoverablePasskey: false };
  // The synthetic item's configured passkey stands in for the vault search.
  if (probeMode && owner.origin === rt.vars.origin && rt.vars.probePasskey)
    return {
      ...fieldFacts,
      passkey: true,
      discoverablePasskey: rt.vars.probePasskey === "discoverable",
    };
  const held = await Promise.resolve(
    rt.options.passkeys?.({
      origin: owner.origin,
      connectionId: owner.connectionId,
      itemId: owner.itemId,
    }),
  ).catch(() => undefined);
  return {
    ...fieldFacts,
    passkey: held?.passkey === true,
    discoverablePasskey: held?.passkey === true && held.discoverable,
  };
}

/**
 * The chosen item named as a saved default names it, for a login whose route fills
 * nothing (ADR 0027); undefined when its connection or item cannot name it.
 */
export function choiceAccount(
  _rt: Runtime,
  catalog: VaultCatalog,
  choice: Choice,
  documentOrigin: string,
): LoginChoiceAccount | undefined {
  const connection = catalog.connections.find((entry) => entry.id === choice.connectionId);
  const item = connection?.items.find((entry) => entry.id === choice.itemId);
  if (!connection?.userId || !item) return undefined;
  return {
    origin: documentOrigin,
    provider: connection.provider,
    server: connection.server,
    userId: connection.userId,
    itemId: item.id,
    // Named as a binding built for the item is.
    ...loginDisplayNames(item.id, item.label, connection.label),
  };
}

/**
 * One account must resolve from a usable connection, and its item must not await review.
 * A new login reads the item's facts once and chooses its route in the owner's order
 * (ADR 0027): the `passkey` route when the recipe has it and the item holds a
 * discoverable passkey, whatever its bindings; otherwise the first password variant
 * whose binding resolves, whose fields are all allowed and whose bound password or TOTP
 * fields hold values. A recipe with one variant keeps that variant's own refusal, and
 * one with several refuses `no-route` with the first variant's reason as its detail. A
 * running or resumed login passes its recorded `route`, which is checked alone and never
 * reads the facts again. On a recipe without a passkey button, the `passkey` route is
 * chosen when the page asked for a passkey by itself (`pageRequest`), and its plan names
 * the password variant it falls back to, when one fits (ADR 0034).
 */
export async function planFor(
  rt: Runtime,
  snapshot: Extract<SettingsResponse, { ok: true }>,
  live: LiveDocument,
  recipe: LoginRecipe,
  request: {
    /** The tab asks for an account, refused with this reason unless a pick logs in. */
    asking?: "account-asked" | "relogin-limit";
    /** While the tab asks, the single account to use may fill the page (ADR 0021 D). */
    fill?: boolean;
    route?: LoginRouteChoice;
    /** Slots of the handlers a running login entered; `totp` reads the code field. */
    handlerSlots?: readonly string[];
    /** The document asked for a passkey by itself, with conditional mediation (ADR 0034). */
    pageRequest?: boolean;
    /**
     * The login starts at a later step (ADR 0049): the `passkey` route's button, on the
     * first page, is not there to click.
     */
    later?: boolean;
    /**
     * Automatic login of the page's site is paused (ADR 0062): only an account picked in
     * the popup logs in, once, on the password route.
     */
    paused?: boolean;
  } = {},
) {
  let catalog: VaultCatalog;
  let chosen: Choice | undefined;
  let savedDefault = false;
  if (probeMode && recipe.origin === rt.vars.origin) {
    // The tab asks, as `choose` answers it (ADR 0021 D); the probe has no list to offer. A
    // page to fill while the tab asks still logs in fully here, without production's
    // fill-only.
    if (request.paused) return { ok: false as const, reason: "paused" as const };
    if (request.asking && !request.fill)
      return { ok: false as const, reason: request.asking, ask: true as const };
    catalog = grantProbeOrigin(snapshot.catalog, rt.vars.origin, rt.vars.account);
    const top = await topScope(rt, snapshot, live, rt.vars.account, catalog);
    if (top) return { ok: false as const, reason: top.reason };
  } else {
    const found = await choose(
      rt,
      snapshot,
      live,
      request.asking,
      request.paused === true,
      request.fill === true,
      accountTargetsOn(recipe, live.path),
    );
    if ("reason" in found)
      return {
        ok: false as const,
        reason: found.reason,
        ...(found.candidates ? { candidates: found.candidates } : {}),
        ...(found.ask ? { ask: true as const } : {}),
        ...(found.paused ? { paused: true as const } : {}),
        ...(found.noUriMatch ? { noUriMatch: true as const } : {}),
      };
    chosen = found;
    savedDefault = found.saved;
    const scope = await liveScope(rt, snapshot, live, found);
    if ("reason" in scope) return { ok: false as const, reason: scope.reason };
    const top = await topScope(rt, snapshot, live, found, snapshot.catalog);
    if (top) return { ok: false as const, reason: top.reason };
    catalog = scope.catalog;
  }
  // The generated slot map is read at most once per plan.
  let generated: Promise<LoginBindingTemplate | undefined> | undefined;
  const slotMap = () =>
    (generated ??= Promise.resolve(rt.generation?.slotFields(recipe.id)).catch(() => undefined));
  /**
   * The plan for one route, or why it does not resolve. Without `fillGaps`, a saved binding
   * that holds no entry for one of the route's slots refuses `binding-slots-mismatch`
   * rather than having it filled (ADR 0027, amended 2026-10-19).
   */
  const resolveRoute = async (route: LoginRouteChoice, fillGaps = true) => {
    const slots = routeSlots(recipe, route);
    let policy = snapshot.snapshot;
    let binding: LoginAccountBinding;
    let choice: UnsavedChoice | undefined;
    if (!chosen) binding = probeBinding(recipe, rt.vars.account, slots);
    else {
      let named: SavedLoginBinding | LoginChoiceAccount;
      let unsaved: boolean;
      if (route.route === "passkey") {
        // The route fills nothing, so no binding is read, built or saved (ADR 0027).
        const owner = choiceAccount(rt, catalog, chosen, live.document.origin);
        if (!owner) return { ok: false as const, reason: "vault-unavailable" };
        binding = {
          origin: live.document.origin,
          connectionId: chosen.connectionId,
          itemId: chosen.itemId,
          slots: [],
        };
        named = owner;
        unsaved = !chosen.saved;
      } else {
        const bound = await bindingFor(
          rt,
          catalog,
          snapshot.snapshot.settings,
          recipe,
          chosen,
          live.document.origin,
          slots,
          slotMap,
          fillGaps,
        );
        if (!bound.ok) return { ok: false as const, reason: bound.reason };
        binding = bound.binding;
        named = bound.synced;
        unsaved = !chosen.saved || !bound.saved;
      }
      if (!chosen.saved) {
        // The automatic choice acts as this document's default in memory only, named by
        // the chosen item's provider account as a saved default would be. An account
        // connected more than once therefore stays ambiguous, as it would once saved.
        policy = structuredClone(policy);
        // A found account replaces a saved default for this document.
        policy.settings.siteDefaults = policy.settings.siteDefaults.filter(
          (entry) => entry.origin !== live.document.origin,
        );
        policy.settings.siteDefaults.push({
          origin: live.document.origin,
          provider: named.provider,
          server: named.server,
          userId: named.userId,
          itemId: named.itemId,
          itemName: named.itemName,
          ...(named.accountName ? { accountName: named.accountName } : {}),
        });
      }
      // A pick made for this login only is never saved, nor an account the page's own
      // value picked (ADR 0028 amendment of 2026-10-23).
      if (unsaved && chosen.source !== "site-value" && (!chosen.pick || chosen.pick.makeDefault))
        choice = {
          binding: named,
          connectionId: chosen.connectionId,
          // An account found to become the default replaces another saved one.
          ...(chosen.pick?.makeDefault ? { replace: true } : {}),
        };
    }
    // An entered `totp` handler makes its code from the item's code field (`codeFieldOf`,
    // ADR 0027), for this login only: the binding saved after it authenticates covers the
    // route's slots.
    let planSlots = slots;
    if (request.handlerSlots?.includes(TOTP_HANDLER_SLOT)) {
      const owner = catalog.connections.find((entry) => entry.id === binding.connectionId);
      const code =
        owner && codeFieldOf(owner, binding.itemId, snapshot.snapshot.settings.bindings, recipe);
      if (!code) return { ok: false as const, reason: "code-field-missing" as const };
      binding = {
        ...binding,
        slots: [...binding.slots, { slot: TOTP_HANDLER_SLOT, fieldId: code }],
      };
      planSlots = [...slots, TOTP_HANDLER_SLOT];
    }
    const plan = resolveLoginPlan(policy, catalog, live.url, recipe, binding, planSlots);
    // A saved default's item that no longer matches the page, as after its URI was edited
    // on another device, is also no matching item.
    if (!plan.ok && plan.reason === "item-origin-mismatch" && savedDefault)
      return { ...plan, noUriMatch: true as const };
    if (!plan.ok) return plan;
    const connection = catalog.connections.find((entry) => entry.id === plan.account.connectionId);
    if (
      !connection ||
      // Review blocks only the affected items; unrelated items in the connection stay usable.
      (connection.state !== undefined &&
        connection.state !== "ready" &&
        connection.state !== "review-required") ||
      connection.quarantinedItemIds?.includes(plan.account.itemId)
    )
      return { ok: false as const, reason: "vault-unavailable" as const };
    return {
      ...plan,
      connection,
      route,
      ...(chosen
        ? {
            chosen: {
              source: chosen.source,
              ...(chosen.candidates === undefined ? {} : { candidates: chosen.candidates }),
            },
          }
        : {}),
      ...(choice ? { choice } : {}),
      ...(chosen?.fillOnly ? { fillOnly: true as const, asked: chosen.asked ?? [] } : {}),
    };
  };
  // A running or resumed login checks its recorded route alone.
  if (request.route) return resolveRoute(request.route);
  let facts: LoginItemFacts | undefined;
  // Only a page the passkey scripts run on can answer a passkey request (ADR 0050), and
  // none on a site whose passkey requests go to the browser (ADR 0007): there the item
  // holds no passkey, so the login takes a password route or none.
  const passkeyScripts = passkeyScriptsRun(live.document.origin, probeMode);
  const browserSite =
    passkeyScripts && listedBrowserSite(rt, snapshot.snapshot.settings, live.document.origin);
  const passkeyPage = passkeyScripts && !browserSite;
  const factsOf = async (
    resolved: Extract<Awaited<ReturnType<typeof resolveRoute>>, { ok: true }>,
  ): Promise<LoginItemFacts> => {
    const read = await itemFacts(
      rt,
      resolved.connection,
      { ...resolved.account, origin: live.document.origin },
      passkeyPage,
    );
    // The `totp` fact describes the field a `totp` handler makes its code from: a custom
    // field the saved binding names, or the one flagged as holding a key when the built-in
    // TOTP holds no value, counts when the account may read it, and the built-in TOTP then
    // does not. A binding naming a field no code is made from leaves none.
    const code = codeFieldOf(
      resolved.connection,
      resolved.account.itemId,
      snapshot.snapshot.settings.bindings,
      recipe,
    );
    if (!code) return { ...read, totp: false };
    return code.startsWith("custom.")
      ? { ...read, totp: resolved.account.fieldIds.includes(code) }
      : read;
  };
  const pageRequest =
    request.pageRequest === true && !chosen?.fillOnly && passkeyAnswersRequest(recipe);
  const { passkey: _button, ...buttonless } = recipe;
  const routeRecipe: LoginRecipe = request.later ? buttonless : recipe;
  // A pick on a paused site logs in on the password route (ADR 0062).
  if (!request.paused && passkeyPage && (recipeHasRoute(routeRecipe, "passkey") || pageRequest)) {
    const resolved = await resolveRoute({ route: "passkey" });
    if (resolved.ok) {
      facts = await factsOf(resolved);
      // No binding matters on this route, so a password variant that does not fit never
      // refuses such a login.
      if (chooseLoginRoute(routeRecipe, facts, [], pageRequest)?.route === "passkey") {
        if (!pageRequest) return { ...resolved, facts };
        // Answering the page's request falls back to the variant that fits (ADR 0034),
        // never to one that stops before the password the item lacks (ADR 0036).
        const password = await passwordPlan();
        return {
          ...resolved,
          facts,
          ...(password.ok && password.route.route === "password" && !("stopAt" in password)
            ? { fallback: password.route.variant }
            : {}),
        };
      }
    }
    // Otherwise the password route decides, with its own refusals.
  }
  const password = await passwordPlan();
  // A paused site never hands a login on to the browser's passkey sign-in: an item
  // without a password stops before anything, pressing nothing (ADR 0062).
  if (request.paused && password.ok && "stopAt" in password)
    return { ok: false as const, reason: "no-route" as const, detail: "password-empty:paused" };
  return password;
  /**
   * The first password variant that fits, or why none does. A saved binding is first tried
   * as it is on every variant, so an item keeps the variant its binding fits even when an
   * earlier one could be filled; only when none fits are its gaps filled (ADR 0027,
   * amended 2026-10-19).
   */
  async function passwordPlan() {
    let gapped = false;
    const exact = await variantPlan(false, () => {
      gapped = true;
    });
    return exact.ok || !gapped ? exact : variantPlan(true);
  }
  /** The first password variant that fits, with or without filling a saved binding. */
  async function variantPlan(fillGaps: boolean, gap?: () => void) {
    const routes: LoginRouteChoice[] = passwordVariants(recipe).map((_, variant) => ({
      route: "password",
      variant,
    }));
    const fits: boolean[] = [];
    const refusals: (string | undefined)[] = [];
    /** For a `no-route` refusal, which fact was missing (never a value). */
    const missing: (string | undefined)[] = [];
    /**
     * An item without a password, but with a passkey, goes on up to the step that fills
     * its password, or to the end of a route that fills none, in the tab's own page (ADR
     * 0036), also on a chooser's route, whose click on the list advances to its branch
     * (owner, 2026-10-13 06:32 UTC). Its binding still names the empty password, so the
     * item signs in with its password once it has one. Undefined for a password the
     * account may not fill. Otherwise the stop, or why there is none, for a value-free
     * `password-empty:<why>` detail in the log. A route whose binding reads a password
     * from another field (`passwordField`) fills one, so it never stops at its end
     * (`password-field`).
     */
    const stopOrMiss = (
      route: LoginRouteChoice,
      miss: ReturnType<typeof passwordMiss>,
      known: LoginItemFacts,
      passwordSlots: readonly string[],
      lacking: readonly string[],
      passwordField = false,
    ) => {
      if (miss !== "password-empty") return undefined;
      if (live.document.frameId !== 0) return { miss: "frame" as const };
      const result = passwordStopOrMiss(recipe, route, known, passwordSlots, lacking);
      // The item's passkey is not used there, so the copy names the list (ADR 0007).
      if (browserSite && "miss" in result && result.miss === "no-passkey")
        return { miss: "passkey-browser-site" as const };
      return passwordField && ("stop" in result || result.miss === "no-password-step")
        ? { miss: "password-field" as const }
        : result;
    };
    // Variants are tried in recipe order and the first that fits stops the search, so the
    // facts and the generated map are read once.
    /* eslint-disable no-await-in-loop */
    for (const [index, route] of routes.entries()) {
      const resolved = await resolveRoute(route, fillGaps);
      if (!resolved.ok) {
        if (!rt.variantRefusals.has(resolved.reason)) return resolved;
        if (resolved.reason === "binding-slots-mismatch") gap?.();
        refusals[index] = resolved.reason;
        continue;
      }
      facts ??= await factsOf(resolved);
      // The password route needs every bound password or TOTP field, built in or Linked to
      // one, to hold a value the account may fill.
      const item = resolved.connection.items.find((entry) => entry.id === resolved.account.itemId);
      const known = facts;
      const lacking = resolved.binding.slots
        .map(({ slot, fieldId }) => ({
          slot,
          source: item ? loginFieldSource(item, fieldId) : fieldId,
        }))
        .filter(
          ({ source }) =>
            (source === "login.password" && !known.password) ||
            (source === "login.totp-code" && !known.totp),
        );
      const unheld = lacking[0]?.source;
      if (unheld) {
        const miss = passwordMiss(item, resolved.account.fieldIds);
        const passwordSlots = lacking
          .filter(({ source }) => source === "login.password")
          .map(({ slot }) => slot);
        const stop =
          passwordSlots.length === 0
            ? undefined
            : stopOrMiss(
                route,
                miss,
                known,
                passwordSlots,
                lacking.map(({ slot }) => slot),
              );
        if (stop && "stop" in stop) return { ...resolved, facts: known, stopAt: stop.stop };
        refusals[index] = "no-route";
        missing[index] =
          unheld !== "login.password" ? "no-totp" : stop ? `${miss}:${stop.miss}` : miss;
        continue;
      }
      fits[index] = true;
      const taken = chooseLoginRoute(routeRecipe, known, fits);
      if (taken?.route === "password" && taken.variant === index)
        return { ...resolved, facts: known };
      // The first variant that fits decides; without the item's password none is taken.
      // The passkey route, when the facts choose it here, did not resolve, so nothing is.
      refusals[index] = "no-route";
      if (taken?.route === "passkey") {
        missing[index] = "passkey-unresolved";
        break;
      }
      // A variant whose binding reads nothing from the empty password, as one whose page
      // after the identifier is not generated yet, stops at the end of its route, unless
      // a slot reads a password from another field: the `password` slot, the password
      // through a Linked field, or a concealed (hidden) custom field.
      const miss = passwordMiss(item, resolved.account.fieldIds);
      const passwordField = resolved.binding.slots.some(
        ({ slot, fieldId }) =>
          slot === "password" ||
          (item ? loginFieldSource(item, fieldId) : fieldId) === "login.password" ||
          item?.fields.find((field) => field.id === fieldId)?.kind === "hidden",
      );
      const stop = stopOrMiss(route, miss, known, [], [], passwordField);
      if (stop && "stop" in stop) return { ...resolved, facts: known, stopAt: stop.stop };
      missing[index] = stop ? `${miss}:${stop.miss}` : miss;
      break;
    }
    /* eslint-enable no-await-in-loop */
    const first = refusals[0] ?? "no-route";
    // A `no-route` names the fact the first variant missed, so the log tells an item
    // without a password from one without its TOTP secret.
    const detail = first === "no-route" ? missing[0] : first;
    // Every variant tried was refused for the item's facts, not for a binding or field it
    // names, and the item holds what another route needs, which the recipe lacks: a recipe
    // generated again for the page may have it (ADR 0058 A). The caller decides whether
    // that may happen.
    const unfit =
      facts && refusals.every((reason) => reason === "no-route")
        ? heldRouteMissing(recipe, facts, passkeyPage)
        : undefined;
    const marked = unfit ? { unfit } : {};
    return routes.length === 1
      ? {
          ok: false as const,
          reason: first,
          ...(detail && detail !== first ? { detail } : {}),
          ...marked,
        }
      : {
          ok: false as const,
          reason: "no-route" as const,
          ...(detail ? { detail } : {}),
          ...marked,
        };
  }
}
