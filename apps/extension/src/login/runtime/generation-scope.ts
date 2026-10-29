import {
  connectionEnabled,
  getItemEligibility,
  isFieldExcluded,
  recipeBranch,
  runsLogin,
  valueShapeOf,
  type LoginAccount,
  type LoginChooserRecipe,
  type LoginRecipe,
  type LoginRoute,
  type SemanticSlot,
  type ValueShape,
  type VaultConnectionMetadata,
} from "@pateat/contracts";
import { browser } from "wxt/browser";
import { loginReadiness, type LoginReadiness } from "../wire";
import { probeStarts } from "../dummy";
import { findLiveSiteCandidates } from "../../vault/site-candidates";
import { customFieldOffers, type CustomFieldOffer } from "../generation-slots";
import type { PasskeyItem } from "../../passkeys/runtime";
import { probeMode, MAX_CUSTOM_SHAPE_READS } from "./constants";
import { type LiveDocument, type GenerationMiss, type GenerationScope } from "./types";
import { type GenerationHold } from "./report";
import { catalogItems, generationSlots, offersGenerationField, logCode } from "./steps";
import { listedBrowserSite, pauseOf } from "./pause";
import { skipGeneration } from "./generation";
import { readUsernames, usernameShape } from "./markers";
import type { Runtime } from "./state";

/**
 * First steps a document watches for: every route's and variant's of each recipe,
 * deduplicated and bounded for the wire. A path where several recipes start is left out,
 * because such a page cannot start (ADR 0013); several variants of one recipe starting
 * there do not (ADR 0027).
 */
export async function startsFor(rt: Runtime, documentOrigin: string): Promise<LoginReadiness[]> {
  const all =
    probeMode && documentOrigin === rt.vars.origin
      ? probeStarts(rt.vars.origin)
      : await rt.recipes.starts(documentOrigin).catch(() => []);
  // A chooser's list is ready once one of its buttons or a listed account shows, and so
  // is its path once it shows the `other` branch's first step instead (ADR 0028).
  const readiness = all
    .filter((start) => all.filter((other) => other.path === start.path).length === 1)
    .flatMap((start): LoginReadiness[] => [
      ...(start.list
        ? [
            {
              path: start.path,
              require: "clickable" as const,
              targets: start.list,
              accounts: true as const,
            },
          ]
        : []),
      ...start.steps.map(loginReadiness),
    ]);
  // Later steps come after every first step, so the bound for the wire drops them first
  // (ADR 0049); a path several recipes start on keeps them, as another recipe may own them.
  const later = all.flatMap((start) => start.later ?? []);
  const unique = new Map([...readiness, ...later].map((entry) => [JSON.stringify(entry), entry]));
  return [...unique.values()].slice(0, 32);
}

/**
 * Whether this document may be sent for generation once it shows a sign-in input: a
 * top-level page on whose path no cached recipe of its origin starts (several starting
 * there count too), and whose path was not sent within the retry window (ADR 0016). An
 * entry recipe's path counts as a start (ADR 0031); it is added here only, since
 * `startsFor` leaves out a path several starts share. So does the first page of a recipe
 * generated as `confirm` or `unclear`, which never starts (ADR 0035). A frame is never
 * sent; one that would be offered as the tab's page is `frame`, asked to report a sign-in
 * input or a secret answer so that such pages are counted (ADR 0035).
 */
export async function offersGeneration(
  rt: Runtime,
  live: LiveDocument,
): Promise<true | "frame" | GenerationHold | undefined> {
  const framed = live.document.frameId !== 0;
  if (!rt.generation || !rt.uris || (!framed && live.topUrl)) return undefined;
  if (probeMode && live.document.origin === rt.vars.origin) return undefined;
  const starts = await rt.recipes.starts(live.document.origin).catch(() => undefined);
  if (starts === undefined || starts.some((start) => start.path === live.path)) return undefined;
  const entries = await rt.recipes.entries(live.document.origin).catch(() => undefined);
  if (entries === undefined || entries.some((entry) => entry.entry.path === live.path))
    return undefined;
  const routes = await routesOf(rt, live.document.origin);
  if (
    routes === undefined ||
    routes.some((recipe) => !runsLogin(recipe) && recipe.steps[0]?.path === live.path)
  )
    return undefined;
  const hold = await rt.generation
    .available(live.document.origin, live.path)
    .catch(() => undefined);
  // A frame counts only where its page would be sent now.
  if (framed) return hold === true ? "frame" : undefined;
  return hold;
}

/**
 * Every route recipe of the origin whatever its kind, and each chooser branch (ADR 0035),
 * or undefined unread.
 */
export async function routesOf(
  rt: Runtime,
  pageOrigin: string,
): Promise<LoginRecipe[] | undefined> {
  if (probeMode && pageOrigin === rt.vars.origin) return [];
  return Promise.resolve(rt.recipes.routes?.(pageOrigin) ?? []).catch(() => undefined);
}

/**
 * The origin's recipe generated as `confirm` or `unclear` whose first page is `path`
 * (ADR 0035): its page never starts a login.
 */
export async function confirmRecipeOn(
  rt: Runtime,
  pageOrigin: string,
  path: string,
): Promise<LoginRecipe | undefined> {
  return (await routesOf(rt, pageOrigin))?.find(
    (recipe) => !runsLogin(recipe) && recipe.steps[0]?.path === path,
  );
}

/**
 * Whether a chooser's path may be sent as its `other` branch's first page (ADR 0028):
 * `true`, why not, or `undefined` for a page that is never sent.
 */
export async function offersOther(
  rt: Runtime,
  live: LiveDocument,
  chooser: LoginChooserRecipe,
): Promise<true | GenerationHold | undefined> {
  if (!rt.generation || !rt.uris || live.document.frameId !== 0 || live.topUrl) return undefined;
  if (probeMode && live.document.origin === rt.vars.origin) return undefined;
  return rt.generation
    .available(
      live.document.origin,
      live.path,
      { recipeId: chooser.id, revision: chooser.revision },
      chooser.layout === undefined ? undefined : recipeBranch(chooser.layout, "other"),
    )
    .catch(() => undefined);
}

/**
 * The slots to generate for when a vault item's URI matches the page, with the
 * matching items. No field value is read here. Without them, `miss` hears why, for the
 * log: `no-vault-match` when no item fits, or why the vault could not tell. For a
 * passkey-only page (ADR 0053), `passkeyOnly` says whether `some` matching item or
 * `every` one must hold a discoverable passkey.
 */
export async function generationSlotsFor(
  rt: Runtime,
  live: LiveDocument,
  miss: (reason: GenerationMiss, detail?: string) => void = () => undefined,
  passkeyOnly: false | "some" | "every" = false,
): Promise<GenerationScope | undefined> {
  if (!rt.uris) return undefined;
  const snapshot = await rt.settings.handle({ version: 1, type: "settings.get" });
  if (!snapshot.ok) {
    miss("vault-unavailable", "settings");
    return undefined;
  }
  // The URL the page shows now: a same-document URL change (history.pushState) since the
  // document announced shows only in the tab's committed URL.
  let url = live.url;
  try {
    const tab = await browser.tabs.get(live.document.tabId);
    if (live.document.frameId === 0 && tab.url && new URL(tab.url).origin === live.document.origin)
      url = tab.url;
  } catch {
    miss("vault-unavailable", "tab");
    return undefined;
  }
  const scope = await findLiveSiteCandidates({
    settings: snapshot.snapshot.settings,
    catalog: snapshot.catalog,
    url,
    match: rt.uris,
  });
  if (!scope.ok) {
    miss("no-vault-match", scope.reason);
    return undefined;
  }
  const items = catalogItems(snapshot.catalog, scope.candidates);
  // Only slots a matching item can fill; built-in fields keep these IDs on every device.
  const slots = generationSlots.filter(({ fieldId }) =>
    items.some(({ connection, item }) =>
      offersGenerationField(
        snapshot.snapshot.settings,
        snapshot.catalog,
        { connectionId: connection.id, item },
        fieldId,
      ),
    ),
  );
  // Custom fields are offered by name only when the item allows them (ADR 0027).
  const offers = customFieldOffers(
    items.flatMap(({ connection, item }) => {
      const eligibility = getItemEligibility(
        snapshot.snapshot.settings,
        snapshot.catalog,
        connection.id,
        item.id,
      );
      return eligibility.eligible
        ? [{ connectionId: connection.id, item, allowedFieldIds: eligibility.fieldIds }]
        : [];
    }),
  );
  // A passkey-only page fills nothing, so it needs a matching item rather than a slot.
  if (passkeyOnly ? !items.length : !slots.length && !offers.length) {
    const enabled = snapshot.catalog.connections.some((connection) =>
      connectionEnabled(snapshot.snapshot.settings, snapshot.catalog, connection.id),
    );
    const unavailable = scope.unavailableConnections[0]?.reason;
    if (items.length) miss("no-vault-match", "no-slots");
    // A device without any vault connection is not a problem to log at info level.
    else if (!snapshot.catalog.connections.length) miss("no-vault-match", "no-connection");
    else if (!enabled) miss("connection-disabled");
    else if (unavailable) miss("vault-unavailable", logCode(unavailable));
    // An item whose URIs could not all be checked may still belong to the page.
    else if (scope.incompleteItems.length) miss("no-vault-match", "incomplete-item");
    else miss("no-vault-match", "no-item");
    return undefined;
  }
  // A passkey-only page also needs a usable discoverable passkey held by one of the
  // matching items (ADR 0053), looked up only once an item matched; passwords and
  // unrelated RP matches never authorize generation. On a site whose passkey requests go
  // to the browser no item holds one Pateat may use (ADR 0007).
  if (passkeyOnly) {
    const browserSite = listedBrowserSite(rt, snapshot.snapshot.settings, live.document.origin);
    const leave = browserSite
      ? undefined
      : await rt.options.vault?.enter(false).catch(() => undefined);
    let held: readonly PasskeyItem[] = [];
    try {
      if (!browserSite) held = (await rt.options.passkeyItems?.(live.document.origin)) ?? [];
    } catch {
      held = [];
    } finally {
      leave?.();
    }
    const holds = ({ connection, item }: (typeof items)[number]) =>
      held.some((key) => key.connectionId === connection.id && key.itemId === item.id);
    if (passkeyOnly === "every" ? !items.every(holds) : !items.some(holds)) {
      miss("no-vault-match", "no-passkey");
      return undefined;
    }
  }
  return {
    slots: slots.map(({ slot }) => slot),
    offers,
    items,
    settings: snapshot.snapshot.settings,
    catalog: snapshot.catalog,
    // An item that could not be checked might have another username.
    complete: !scope.unavailableConnections.length && !scope.incompleteItems.length,
  };
}

/**
 * The shape the given values share (ADR 0010), read locally just before the page is sent
 * (owner decision, 2026-10-11): only when every non-empty value gives the same length,
 * character classes and email form. An empty value does not count; a scope with items
 * that could not be checked, a read that fails, or a value too long to shape sends no
 * shape. Values are read one at a time and never kept.
 */
export async function sharedShape(
  rt: Runtime,
  pageOrigin: string,
  scope: GenerationScope,
  reads: readonly {
    connection: VaultConnectionMetadata;
    itemId: string;
    fieldId: string;
    source: "username" | "text";
  }[],
): Promise<ValueShape | undefined> {
  if (!scope.complete) return undefined;
  let shape: ValueShape | undefined;
  for (const { connection, itemId, fieldId, source } of reads) {
    let value: string | undefined;
    try {
      // Serial reads through the shared vault host, as for a fill.
      // eslint-disable-next-line no-await-in-loop
      value = await rt.fields({
        account: { origin: pageOrigin, connectionId: connection.id, itemId },
        connection,
        fieldId,
      });
    } catch {
      value = undefined;
    }
    if (value === undefined) return undefined;
    if (!value) continue;
    const itemShape = valueShapeOf({ source, value });
    value = "";
    // A value too long to shape cannot be compared.
    if (!itemShape) return undefined;
    if (shape && JSON.stringify(shape) !== JSON.stringify(itemShape)) return undefined;
    shape = itemShape;
  }
  return shape;
}

/**
 * The matching items' username reads: none for an item without one, with an empty one
 * (the catalog's value-free `empty` flag) or whose username the user excluded.
 */
export function usernameReads(
  _rt: Runtime,
  scope: Pick<GenerationScope, "items" | "settings" | "catalog">,
) {
  return scope.items.flatMap(({ connection, item }) => {
    const excluded = isFieldExcluded(
      scope.settings,
      scope.catalog,
      connection.id,
      item.id,
      "login.username",
    );
    return excluded ||
      !item.fields.some((field) => field.id === "login.username" && field.empty !== true)
      ? []
      : [
          {
            connection,
            itemId: item.id,
            fieldId: "login.username",
            source: "username" as const,
          },
        ];
  });
}

/**
 * The custom-field slots with the shapes their fields share (ADR 0027): only for Text
 * fields and Linked fields that read the username or a Text field, never for Hidden
 * fields or the password, and within a bound on the values read per request.
 */
export async function customSlots(rt: Runtime, pageOrigin: string, scope: GenerationScope) {
  let budget = MAX_CUSTOM_SHAPE_READS;
  const slots: SemanticSlot[] = [];
  for (const offer of scope.offers) {
    const reads = offer.members.flatMap(({ connectionId, itemId, fieldId, source }) => {
      const connection = scope.items.find(
        (entry) => entry.connection.id === connectionId,
      )?.connection;
      return connection && source ? [{ connection, itemId, fieldId, source }] : [];
    });
    let shape: ValueShape | undefined;
    if (
      scope.complete &&
      offer.shapeable &&
      reads.length === offer.members.length &&
      reads.length <= budget
    ) {
      budget -= reads.length;
      // eslint-disable-next-line no-await-in-loop
      shape = await sharedShape(rt, pageOrigin, scope, reads);
    }
    slots.push(shape ? { ...offer.slot, valueShape: shape } : offer.slot);
  }
  return slots;
}

/**
 * Whether a pause of the page's site started while the page was made ready to send for
 * generation (ADR 0062): it is then not sent, and the document is asked to announce
 * again, so it is refused as paused.
 */
export async function pausedMeanwhile(
  rt: Runtime,
  live: LiveDocument,
  page?: "entry" | "other",
): Promise<boolean> {
  if ((await pauseOf(rt, live)) === undefined) return false;
  skipGeneration(rt, live, "paused", page);
  void browser.tabs
    .sendMessage(
      live.document.tabId,
      { version: 1, type: "login.reconnect" },
      { frameId: live.document.frameId, documentId: live.document.documentId },
    )
    .catch(() => undefined);
  return true;
}

/**
 * The login account's slots for the judge (owner 2026-10-23: the same information goes to
 * every model call unless there is a sound reason), built as a generation request's are
 * but from the login's own item only: the built-in fields it can fill, one slot per
 * custom field it allows by name, the username's shape and the Text fields' shapes (ADR
 * 0010, ADR 0027). Never a value, an item name or a binding. `offers` names each custom
 * slot's field. None while the item cannot be read or may not be used. On the `passkey`
 * route, which reads no vault value (ADR 0027), the slots carry no shapes (`route`).
 * `known` gives the username's shape from a read the caller already made.
 */
export async function judgeSlots(
  rt: Runtime,
  pageOrigin: string,
  login: Pick<LoginAccount, "connectionId" | "itemId">,
  route: LoginRoute | undefined,
  known?: { usernameShape: ValueShape | undefined },
): Promise<{ slots: SemanticSlot[]; offers: CustomFieldOffer[] }> {
  const none = { slots: [], offers: [] };
  const snapshot = await rt.settings
    .handle({ version: 1, type: "settings.get" })
    .catch(() => undefined);
  if (!snapshot?.ok) return none;
  const policy = snapshot.snapshot.settings;
  const connection = snapshot.catalog.connections.find((entry) => entry.id === login.connectionId);
  const item = connection?.items.find((entry) => entry.id === login.itemId);
  const eligibility =
    connection && item
      ? getItemEligibility(policy, snapshot.catalog, connection.id, item.id)
      : undefined;
  if (!connection || !item || !eligibility?.eligible) return none;
  const scope: GenerationScope = {
    slots: generationSlots
      .filter(({ fieldId }) =>
        offersGenerationField(
          policy,
          snapshot.catalog,
          { connectionId: connection.id, item },
          fieldId,
        ),
      )
      .map(({ slot }) => slot),
    offers: customFieldOffers([
      { connectionId: connection.id, item, allowedFieldIds: eligibility.fieldIds },
    ]),
    items: [{ connection, item }],
    settings: policy,
    catalog: snapshot.catalog,
    complete: true,
  };
  const plain = () => scope.offers.map((offer) => offer.slot);
  if (route === "passkey") return { slots: [...scope.slots, ...plain()], offers: scope.offers };
  let shape = known?.usernameShape;
  if (!known) {
    const usernames = await readUsernames(rt, pageOrigin, usernameReads(rt, scope)).catch(
      () => undefined,
    );
    shape = usernames && usernameShape(rt, scope, usernames);
    usernames?.fill("");
  }
  const custom = await customSlots(rt, pageOrigin, scope).catch(plain);
  return {
    slots: [
      ...scope.slots.map((slot) =>
        slot.id === "username" && shape ? { ...slot, valueShape: shape } : slot,
      ),
      ...custom,
    ],
    offers: scope.offers,
  };
}
