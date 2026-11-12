import {
  customFieldReference,
  findLoginBinding,
  getItemEligibility,
  resolveBindingFields,
  sameLoginDocument,
  loginFieldSource,
  totpFieldMismatch,
  type LoginRecipe,
  type SettingsResponse,
  type SavedLoginBinding,
  type SettingsSnapshot,
} from "@pateat/contracts";
import { newId } from "@pateat/contracts/ids";
import { browser } from "wxt/browser";
import {
  type BindingRepairRequest,
  type BindingRepairResponse,
  type BindingReviewResponse,
} from "../binding-review-wire";
import { type BindingIssue, type BindingReviewState } from "./binding-review-state";
import { frameKey } from "./steps";
import { recordFor, heldElsewhere } from "./hold";
import { saveSession } from "./attempt";
import { quietly } from "./session-store";
import { type Execution, type LiveDocument } from "./types";
import type { Runtime } from "./state";

type Snapshot = Extract<SettingsResponse, { ok: true }>;
const same = (left: unknown, right: unknown) => JSON.stringify(left) === JSON.stringify(right);
const scopeOf = (rt: Runtime, snapshot: SettingsSnapshot) =>
  rt.options.bindingScope?.(snapshot) ?? Promise.resolve("local");
const customReasons = new Set(["field-missing", "field-ambiguous", "field-count-changed"]);

/** Every broken custom reference of this route; missing slots and built-ins are not repaired. */
export function brokenBindingSlots(
  issue: BindingIssue,
  fields: Parameters<typeof resolveBindingFields>[2],
) {
  const resolved = resolveBindingFields(issue.binding, issue.slots, fields);
  if (resolved.ok || resolved.reason === "binding-slots-mismatch") return [];
  if (
    issue.binding.slots.some((entry) => {
      if (!issue.slots.includes(entry.slot)) return false;
      const found = resolveBindingFields({ slots: [entry] }, [entry.slot], fields);
      return !found.ok && (typeof entry.field === "string" || !customReasons.has(found.reason));
    })
  )
    return [];
  return issue.binding.slots.flatMap((entry) => {
    if (!issue.slots.includes(entry.slot) || typeof entry.field === "string") return [];
    const found = resolveBindingFields({ slots: [entry] }, [entry.slot], fields);
    return !found.ok && customReasons.has(found.reason)
      ? [
          {
            slot: entry.slot,
            name: entry.field.custom,
            reason: found.reason as "field-missing" | "field-ambiguous" | "field-count-changed",
          },
        ]
      : [];
  });
}

/** Forget the offer and its override together; a lost session write never grants a fill. */
export function clearBindingReview(rt: Runtime, tabId: number) {
  if (!rt.bindingReviews.delete(tabId)) return;
  void quietly(rt, () => saveSession(rt));
}

/** Capture only a fresh start's final refusal, after route/layout alternatives were tried. */
export async function offerBindingReview(
  rt: Runtime,
  snapshot: Snapshot,
  live: LiveDocument,
  recipe: LoginRecipe,
  issue: BindingIssue,
) {
  const connection = snapshot.catalog.connections.find((entry) => entry.id === issue.connectionId);
  const item = connection?.items.find((entry) => entry.id === issue.binding.itemId);
  if (!connection?.snapshotId || !item || !brokenBindingSlots(issue, item.fields).length) return;
  const scope = await scopeOf(rt, snapshot.snapshot).catch(() => undefined);
  if (scope === undefined || rt.documents.get(frameKey(live.document)) !== live) return;
  const previous = rt.bindingReviews.get(live.document.tabId);
  // A periodic announcement keeps the popup's review identity and a chosen override.
  if (
    previous &&
    sameLoginDocument(previous.document, live.document) &&
    previous.policyRevision === snapshot.snapshot.revision &&
    previous.snapshotId === connection.snapshotId &&
    previous.recipeMark === JSON.stringify(recipe) &&
    same(previous.binding, issue.binding) &&
    previous.scope === scope
  )
    return;
  rt.bindingReviews.set(live.document.tabId, {
    id: newId(),
    document: live.document,
    path: live.path,
    url: live.url,
    ...(live.topUrl ? { topUrl: live.topUrl } : {}),
    connectionId: issue.connectionId,
    snapshotId: connection.snapshotId,
    policyRevision: snapshot.snapshot.revision,
    scope,
    recipeId: recipe.id,
    recipeRevision: recipe.revision,
    ...(recipe.layout ? { layout: recipe.layout } : {}),
    recipeMark: JSON.stringify(recipe),
    binding: issue.binding,
    slots: issue.slots,
  });
  await quietly(rt, () => saveSession(rt));
}

/** Freshness common to offers, execution overrides and the final settings write. */
async function currentReview(rt: Runtime, review: BindingReviewState, snapshot: Snapshot) {
  if (
    snapshot.snapshot.revision !== review.policyRevision ||
    (await scopeOf(rt, snapshot.snapshot).catch(() => undefined)) !== review.scope
  )
    return undefined;
  const connection = snapshot.catalog.connections.find((entry) => entry.id === review.connectionId);
  if (
    !connection ||
    connection.snapshotId !== review.snapshotId ||
    (connection.state !== "ready" &&
      connection.state !== "review-required" &&
      connection.state !== undefined)
  )
    return undefined;
  const eligible = getItemEligibility(
    snapshot.snapshot.settings,
    snapshot.catalog,
    connection.id,
    review.binding.itemId,
  );
  if (!eligible.eligible || connection.quarantinedItemIds?.includes(review.binding.itemId))
    return undefined;
  const saved = findLoginBinding(
    snapshot.snapshot.settings.bindings,
    { id: review.recipeId, origin: review.binding.origin },
    review.binding,
  );
  if (!same(saved, review.binding)) return undefined;
  const recipe = await rt.recipes
    .recipe(review.binding.origin, review.path, review.recipeId, review.layout)
    .catch(() => undefined);
  if (!recipe || JSON.stringify(recipe) !== review.recipeMark) return undefined;
  // Scope and recipe reads may yield to a vault or settings change. Re-read the catalog
  // after them; the caller's snapshot is never proof that it is still current.
  const latest = await rt.settings
    .handle({ version: 1, type: "settings.get" })
    .catch(() => undefined);
  const current =
    latest?.ok && latest.catalog.connections.find((entry) => entry.id === review.connectionId);
  if (
    !latest?.ok ||
    latest.snapshot.revision !== review.policyRevision ||
    !current ||
    current.snapshotId !== review.snapshotId ||
    !same(current, connection) ||
    !same(latest.snapshot.settings, snapshot.snapshot.settings)
  )
    return undefined;
  if ((await scopeOf(rt, latest.snapshot).catch(() => undefined)) !== review.scope)
    return undefined;
  return { connection, eligible, recipe };
}

/** The stopped document must still be the one shown, including a frame's top page. */
async function shownReview(rt: Runtime, review: BindingReviewState) {
  let live = rt.documents.get(frameKey(review.document));
  if (!live) {
    await browser.tabs
      .sendMessage(
        review.document.tabId,
        { version: 1, type: "login.reconnect" },
        { frameId: review.document.frameId, documentId: review.document.documentId },
      )
      .catch(() => undefined);
    await rt.admitting
      .get(`${review.document.tabId}:${review.document.frameId}`)
      ?.catch(() => undefined);
    live = rt.documents.get(frameKey(review.document));
  }
  if (
    !live ||
    !sameLoginDocument(live.document, review.document) ||
    live.path !== review.path ||
    live.url !== review.url ||
    live.topUrl !== review.topUrl
  )
    return undefined;
  const tab = await browser.tabs.get(review.document.tabId).catch(() => undefined);
  if (!tab?.url || new URL(tab.url).origin !== new URL(review.topUrl ?? review.url).origin)
    return undefined;
  return live;
}

/** Only names of referenceable, eligible text fields; reserved SSO fields never resolve. */
function reviewCandidates(
  review: BindingReviewState,
  found: NonNullable<Awaited<ReturnType<typeof currentReview>>>,
) {
  const { item, fieldIds } = found.eligible;
  return brokenBindingSlots(
    { binding: review.binding, slots: review.slots, connectionId: review.connectionId },
    item.fields,
  ).map((broken) => ({
    ...broken,
    candidates: item.fields.flatMap((field) => {
      const source =
        field.kind === "linked"
          ? item.fields.find((entry) => entry.id === loginFieldSource(item, field.id))
          : field;
      if (
        !fieldIds.includes(field.id) ||
        !source ||
        !fieldIds.includes(source.id) ||
        (source.kind !== "text" && source.kind !== "hidden") ||
        field.empty === true ||
        source.empty === true ||
        totpFieldMismatch(broken.slot, field) ||
        totpFieldMismatch(broken.slot, source)
      )
        return [];
      const reference = customFieldReference(item.fields, field.id);
      if (
        !reference ||
        !resolveBindingFields(
          { slots: [{ slot: broken.slot, field: reference }] },
          [broken.slot],
          item.fields,
        ).ok
      )
        return [];
      // Duplicate names are distinguished by position, never by their values.
      const name = reference.position
        ? `${reference.custom} (${reference.position}/${reference.count})`
        : reference.custom;
      return [{ fieldId: field.id, name }];
    }),
  }));
}

export async function popupBindingReview(
  rt: Runtime,
  tabId: number,
): Promise<BindingReviewResponse> {
  await rt.vars.sessionLoaded;
  const snapshot = await rt.settings
    .handle({ version: 1, type: "settings.get" })
    .catch(() => undefined);
  const blocked: BindingReviewResponse["blocked"] = [];
  if (!snapshot?.ok) return { ok: true, blocked };
  for (const connection of snapshot.catalog.connections)
    for (const item of connection.items) {
      const eligibility = getItemEligibility(
        snapshot.snapshot.settings,
        snapshot.catalog,
        connection.id,
        item.id,
      );
      if (
        (!eligibility.eligible && eligibility.reason === "review-required") ||
        connection.quarantinedItemIds?.includes(item.id)
      )
        blocked.push({
          id: JSON.stringify([connection.id, item.id]),
          connection: connection.label,
          item: item.label,
        });
    }
  const answer = { ok: true as const, blocked };
  const review = rt.bindingReviews.get(tabId);
  if (!review || review.replacement || review.attemptId) return answer;
  const found = await currentReview(rt, review, snapshot);
  const live = found && (await shownReview(rt, review));
  if (
    !found ||
    !live ||
    rt.bindingReviews.get(tabId) !== review ||
    recordFor(rt, tabId, review.document.origin)
  ) {
    if (rt.bindingReviews.get(tabId) === review) clearBindingReview(rt, tabId);
    return answer;
  }
  return {
    ...answer,
    repair: {
      reviewId: review.id,
      origin: review.document.origin,
      item: found.eligible.item.label,
      slots: reviewCandidates(review, found),
    },
  };
}

export async function pickBindingReview(
  rt: Runtime,
  request: BindingRepairRequest,
): Promise<BindingRepairResponse> {
  const leave = await rt.options.vault?.enter(false);
  try {
    return await pickReview(rt, request);
  } finally {
    leave?.();
  }
}

async function pickReview(
  rt: Runtime,
  request: BindingRepairRequest,
): Promise<BindingRepairResponse> {
  await rt.vars.sessionLoaded;
  const review = rt.bindingReviews.get(request.tabId);
  if (!review || review.id !== request.reviewId || review.replacement || review.attemptId)
    return { ok: false, reason: "stale-review" };
  const snapshot = await rt.settings
    .handle({ version: 1, type: "settings.get" })
    .catch(() => undefined);
  const found = snapshot?.ok ? await currentReview(rt, review, snapshot) : undefined;
  const live = found && (await shownReview(rt, review));
  if (
    !found ||
    !live ||
    rt.bindingReviews.get(request.tabId) !== review ||
    review.replacement ||
    review.attemptId ||
    recordFor(rt, request.tabId, review.document.origin)
  )
    return { ok: false, reason: "stale-review" };
  if (heldElsewhere(rt, request.tabId, review.document.origin))
    return { ok: false, reason: "unavailable" };
  const slots = reviewCandidates(review, found);
  if (
    slots.length !== request.picks.length ||
    new Set(request.picks.map((entry) => entry.slot)).size !== slots.length ||
    !slots.every((slot) =>
      slot.candidates.some((candidate) =>
        request.picks.some((pick) => pick.slot === slot.slot && pick.fieldId === candidate.fieldId),
      ),
    )
  )
    return { ok: false, reason: "not-a-candidate" };
  const replacement: SavedLoginBinding = structuredClone(review.binding);
  for (const pick of request.picks)
    replacement.slots.find((entry) => entry.slot === pick.slot)!.field = customFieldReference(
      found.eligible.item.fields,
      pick.fieldId,
    )!;
  review.replacement = replacement;
  rt.bindingActivating.add(request.tabId);
  try {
    // This write is required: an override never starts from an unrecorded choice.
    await saveSession(rt, review);
    rt.bindingActivating.delete(request.tabId);
    await browser.tabs.sendMessage(
      request.tabId,
      { version: 1, type: "login.reconnect" },
      { frameId: review.document.frameId, documentId: review.document.documentId },
    );
    await rt.admitting.get(`${request.tabId}:${review.document.frameId}`)?.catch(() => undefined);
    if (review.attemptId) return { ok: true };
  } catch {
    /* A failed session write or reconnect cannot authorize another document. */
  } finally {
    rt.bindingActivating.delete(request.tabId);
  }
  if (rt.bindingReviews.get(request.tabId) === review) clearBindingReview(rt, request.tabId);
  return { ok: false, reason: "unavailable" };
}

/** Apply the override only to its document, then to the attempt that document started. */
export async function bindingReviewSnapshot(
  rt: Runtime,
  snapshot: Snapshot,
  live: LiveDocument,
  recipe: LoginRecipe,
  continuing: boolean,
): Promise<Snapshot> {
  await rt.vars.sessionLoaded;
  const review = rt.bindingReviews.get(live.document.tabId);
  if (
    !review?.replacement ||
    rt.bindingActivating.has(live.document.tabId) ||
    review.recipeId !== recipe.id ||
    review.recipeRevision !== recipe.revision
  )
    return snapshot;
  const record = recordFor(rt, live.document.tabId, review.document.origin);
  const own = review.attemptId
    ? continuing &&
      record?.id === review.attemptId &&
      record.state !== "blocked" &&
      record.account.connectionId === review.connectionId &&
      record.account.itemId === review.binding.itemId
    : sameLoginDocument(review.document, live.document) &&
      live.path === review.path &&
      live.url === review.url;
  if (!own || !(await currentReview(rt, review, snapshot))) {
    clearBindingReview(rt, live.document.tabId);
    return snapshot;
  }
  return {
    ...snapshot,
    snapshot: {
      ...snapshot.snapshot,
      settings: {
        ...snapshot.snapshot.settings,
        bindings: snapshot.snapshot.settings.bindings.map((binding) =>
          same(binding, review.binding) ? review.replacement! : binding,
        ),
      },
    },
  };
}

/** Bind one override to the exact admitted attempt; ordinary choice saving stays separate. */
export function attachBindingReview(rt: Runtime, run: Execution) {
  const review = rt.bindingReviews.get(run.live.document.tabId);
  if (
    !review?.replacement ||
    review.recipeId !== run.recipe.id ||
    review.binding.itemId !== run.metadata.account.itemId ||
    review.connectionId !== run.metadata.account.connectionId
  )
    return false;
  if (
    review.attemptId
      ? review.attemptId !== run.metadata.id
      : !sameLoginDocument(review.document, run.live.document)
  )
    return false;
  review.attemptId = run.metadata.id;
  delete run.choice;
  return true;
}

/** A repaired binding becomes synced settings only after this attempt authenticates. */
export async function settleBindingReview(rt: Runtime, run: Execution) {
  const review = rt.bindingReviews.get(run.metadata.document.tabId);
  if (!review?.replacement || review.attemptId !== run.metadata.id) return;
  // No challenge, rejection, unknown outcome or fill-only result is authentication.
  if (run.metadata.state !== "authenticated" || run.metadata.unconfirmed || run.metadata.fillOnly) {
    if (run.metadata.state === "blocked") clearBindingReview(rt, run.metadata.document.tabId);
    return;
  }
  const leave = await rt.options.vault?.enter(false);
  const { promise: saving, resolve: finish } = Promise.withResolvers<void>();
  rt.savingChoices.add(saving);
  try {
    const snapshot = await rt.settings.handle({ version: 1, type: "settings.get" });
    if (
      !snapshot.ok ||
      !rt.settings.update ||
      !(await currentReview(rt, review, snapshot)) ||
      rt.bindingReviews.get(run.metadata.document.tabId) !== review ||
      run.metadata.account.connectionId !== review.connectionId ||
      run.metadata.account.itemId !== review.binding.itemId ||
      run.recipe.revision !== review.recipeRevision
    )
      return;
    await rt.settings.update(
      review.policyRevision,
      "account-choice",
      (value) => {
        const original = findLoginBinding(
          value.settings.bindings,
          { id: review.recipeId, origin: review.binding.origin },
          review.binding,
        );
        if (
          !same(original, review.binding) ||
          rt.bindingReviews.get(run.metadata.document.tabId) !== review
        )
          throw new Error("binding-review-stale");
        return {
          ...value,
          settings: {
            ...value.settings,
            bindings: value.settings.bindings.map((entry) =>
              same(entry, review.binding) ? review.replacement! : entry,
            ),
          },
        };
      },
      async (value, catalog) => {
        if ((await scopeOf(rt, value).catch(() => undefined)) !== review.scope) return false;
        const recipe = await rt.recipes
          .recipe(review.binding.origin, review.path, review.recipeId, review.layout)
          .catch(() => undefined);
        if (!recipe || JSON.stringify(recipe) !== review.recipeMark) return false;
        // Profile reads can yield; check again after the recipe and then read provider
        // metadata while the settings queue and the vault replacement hold are owned.
        if ((await scopeOf(rt, value).catch(() => undefined)) !== review.scope) return false;
        const liveCatalog = await catalog();
        const connection = liveCatalog.connections.find(
          (entry) => entry.id === review.connectionId,
        );
        const eligibility = getItemEligibility(
          value.settings,
          liveCatalog,
          review.connectionId,
          review.binding.itemId,
        );
        return (
          rt.bindingReviews.get(run.metadata.document.tabId) === review &&
          connection?.snapshotId === review.snapshotId &&
          (connection.state === undefined ||
            connection.state === "ready" ||
            connection.state === "review-required") &&
          !connection.quarantinedItemIds?.includes(review.binding.itemId) &&
          eligibility.eligible
        );
      },
    );
  } catch {
    /* A conflicting save leaves the old synced binding intact. */
  } finally {
    clearBindingReview(rt, run.metadata.document.tabId);
    rt.vars.remembered += 1;
    rt.savingChoices.delete(saving);
    finish();
    leave?.();
  }
}
