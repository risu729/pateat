import * as v from "valibot";
import {
  isFieldExcluded,
  languageDecides,
  layoutShown,
  rankLayouts,
  sameLoginTarget,
  valueShapeOf,
  type LoginDocument,
  type LoginObservation,
  type ListClick,
  type LayoutCandidate,
  type LoginChooserRecipe,
  type LoginRecipe,
  type LoginTarget,
  type SettingsResponse,
  type ValueShape,
} from "@pateat/contracts";
import {
  awaitResultSchema,
  extractResultSchema,
  observationSchema,
  stateResultSchema,
  chooseResultSchema,
  type ListMissReport as ListMiss,
  loginReadiness,
  type LoginReadiness,
} from "../wire";
import { emailUsername, namesUsername } from "../../page/account-list";
import { pathShowsUsername, withoutUsernames } from "../../observation/usernames";
import { loginUsernameFieldId } from "../vault";
import {
  type GenerationScope,
  type LiveDocument,
  type ConfirmVisit,
  type Execution,
} from "./types";
import { usernameReads, routesOf, generationSlotsFor } from "./generation-scope";
import { siteCandidates } from "./choice-save";
import { markerProof, frameKey, rawPath } from "./steps";
import { send, report } from "./attempt";
import { MAX_HINT_USERNAMES, SITE_MOVE_READINGS, SIGN_IN_RECHECK_MS } from "./constants";
import type { Runtime } from "./state";

/**
 * The shown texts that name a matching item's username that is not an email: the whole
 * text equals it, ignoring case and a leading `@` (ADR 0028, owner 2026-10-12 08:36
 * UTC); and whether the page's path holds a matching item's username, as a signed-in
 * page under the account's own name does, where the list is not read (owner
 * 2026-10-12 19:45 UTC). Usernames are read one at a time here and never kept or sent
 * to the page.
 */
export async function listedNames(
  rt: Runtime,
  pageOrigin: string,
  scope: GenerationScope,
  texts: readonly string[],
  path: string,
): Promise<{ names: string[]; inPath: boolean; email: boolean }> {
  const found = new Set<string>();
  let inPath = false;
  let email = false;
  for (const { connection, itemId, fieldId } of usernameReads(rt, scope)) {
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
    if (value) {
      for (const text of texts) if (namesUsername(text, value)) found.add(text);
      if (pathShowsUsername(path, [value])) inPath = true;
      if (emailUsername(value)) email = true;
    }
    value = "";
  }
  return { names: [...found], inPath, email };
}

/**
 * What a chooser login compares on its list (ADR 0028): the account's username and, for
 * an email username, the other matching items' usernames, one at a time through the
 * vault and never kept. The others are complete only when every matching item was read:
 * an item that cannot be read, or whose username the user excluded, or more than 32
 * items, leave them incomplete, and then no masked address fits. `undefined` when the
 * account's username cannot be read.
 */
export async function listUsernames(
  rt: Runtime,
  snapshot: Extract<SettingsResponse, { ok: true }>,
  live: LiveDocument,
  chosen: { connectionId: string; itemId: string },
): Promise<{ username: string; others: string[]; othersComplete: boolean } | undefined> {
  const settingsValue = snapshot.snapshot.settings;
  /** The item's username; `""` for an item without one, `undefined` when unknown. */
  const read = async (connectionId: string, itemId: string, excluded: boolean) => {
    const connection = snapshot.catalog.connections.find((entry) => entry.id === connectionId);
    if (!connection) return undefined;
    const fieldId = loginUsernameFieldId(connection, itemId);
    if (!fieldId) return "";
    if (excluded && isFieldExcluded(settingsValue, snapshot.catalog, connectionId, itemId, fieldId))
      return undefined;
    try {
      return await rt.fields({
        account: { origin: live.document.origin, connectionId, itemId },
        connection,
        fieldId,
      });
    } catch {
      return undefined;
    }
  };
  const username = await read(chosen.connectionId, chosen.itemId, false);
  if (!username) return undefined;
  const others: string[] = [];
  // Only an email username is compared with the others' (ADR 0028).
  if (!emailUsername(username)) return { username, others, othersComplete: true };
  const found = rt.uris
    ? await siteCandidates(rt, snapshot, live).catch(() => undefined)
    : undefined;
  const candidates = (found && "candidates" in found ? found.candidates : undefined)?.filter(
    (candidate) =>
      candidate.connectionId !== chosen.connectionId || candidate.itemId !== chosen.itemId,
  );
  let othersComplete = candidates !== undefined && candidates.length <= 32;
  for (const candidate of candidates?.slice(0, 32) ?? []) {
    // Serial reads through the shared vault host, as for a fill.
    // eslint-disable-next-line no-await-in-loop
    const value = await read(candidate.connectionId, candidate.itemId, true);
    if (value === undefined) othersComplete = false;
    else if (value) others.push(value);
  }
  return { username, others, othersComplete };
}

/**
 * Whether one of the recipe's signed-in markers proves a sign-in on the page as ADR 0029
 * reads it: a later step there is no start (ADR 0049).
 */
export async function showsMarker(
  rt: Runtime,
  live: LiveDocument,
  recipe: LoginRecipe,
): Promise<boolean> {
  const proof = markerProof(recipe);
  if (!proof.targets.length) return false;
  try {
    const parsed = v.safeParse(
      observationSchema,
      await send(rt, live, {
        type: "login.observe",
        path: live.path,
        targets: proof.targets,
        require: proof.shown,
        links: proof.links,
        hidden: proof.hidden,
      }),
    );
    // A page that cannot be read starts nothing either.
    return !parsed.success || proof.proves(parsed.output.targets);
  } catch {
    return true;
  }
}

/** Whether the document shows a signed-in marker of any layout of the recipe (ADR 0060). */
export async function showsAnyMarker(
  rt: Runtime,
  live: LiveDocument,
  recipe: LoginRecipe,
): Promise<boolean> {
  const layouts = await Promise.resolve(rt.recipes.layoutsOf?.(recipe.origin, recipe.id)).catch(
    () => undefined,
  );
  const all = [recipe, ...(layouts ?? []).filter((other) => other.layout !== recipe.layout)];
  for (const layout of all) if (await showsMarker(rt, live, layout)) return true;
  return false;
}

/**
 * Which of `targets` the document shows now, each as one visible element: `true` shown,
 * `false` not, `undefined` not asked. The wire takes at most 24, and a page that cannot be
 * asked answers none.
 */
export async function shownTargets(
  rt: Runtime,
  live: LiveDocument,
  targets: readonly LoginTarget[],
): Promise<(target: LoginTarget) => boolean | undefined> {
  const asked = targets.slice(0, 24);
  let states: readonly string[] = [];
  if (asked.length)
    try {
      const parsed = v.safeParse(
        observationSchema,
        await send(rt, live, {
          type: "login.observe",
          path: live.path,
          targets: asked,
          require: asked.map(() => "shown" as const),
        }),
      );
      if (parsed.success) states = parsed.output.targets;
    } catch {
      // Nothing is known of a page that could not be asked.
    }
  return (target) => {
    const at = asked.findIndex((other) => sameLoginTarget(other, target));
    return at === -1 || states[at] === undefined ? undefined : states[at] === "unique";
  };
}

/**
 * The page's language as its observation names it (ADR 0060), the same reading that gave
 * a layout its language when it was generated; `undefined` when the page cannot be
 * described. Read only when it decides between layouts.
 */
export async function observedLanguage(
  rt: Runtime,
  live: LiveDocument,
  page: "login" | "accounts",
): Promise<LoginObservation["language"] | undefined> {
  try {
    const extracted = v.safeParse(
      extractResultSchema,
      await send(rt, live, { type: "login.extract", page }),
    );
    if (!extracted.success || !extracted.output.ok) return undefined;
    const described = v.safeParse(
      v.object({ language: v.picklist(["ja", "en", "mixed"]) }),
      extracted.output.observation,
    );
    return described.success ? described.output.language : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Layouts of one recipe best first for a new login (ADR 0060): those one of whose first
 * steps (`firstStepsOf`) the document shows whole, then with the fewest of their start
 * page elements (`targetsOf`) missing, then the most shown; then the page's language, read
 * only when the best ones differ in it, and the newest (`rankLayouts`). The others drop
 * out.
 */
export async function rankedLayouts<Recipe>(
  rt: Runtime,
  live: LiveDocument,
  candidates: readonly LayoutCandidate<Recipe>[],
  targetsOf: (recipe: Recipe) => readonly LoginTarget[],
  firstStepsOf: (recipe: Recipe) => readonly (readonly LoginTarget[])[],
  page: "login" | "accounts",
): Promise<LayoutCandidate<Recipe>[]> {
  const all = candidates.flatMap((candidate) => targetsOf(candidate.recipe));
  const shows = await shownTargets(
    rt,
    live,
    all.filter(
      (target, index) => all.findIndex((other) => sameLoginTarget(other, target)) === index,
    ),
  );
  const shown = candidates.map((candidate) =>
    layoutShown(firstStepsOf(candidate.recipe), targetsOf(candidate.recipe), shows),
  );
  const ranked = rankLayouts(candidates, shown);
  return languageDecides(ranked)
    ? rankLayouts(candidates, shown, await observedLanguage(rt, live, page))
    : ranked;
}

/**
 * The `signedIn` hint of a page sent as a recipe's first page (ADR 0035): whether a
 * signed-in marker learned on its origin by any layout of the origin's recipes shows (ADR
 * 0060), as ADR 0029's E1 reads it, or one of `usernames`, the matching items', shows in
 * the page's header or navigation (E2). Markers past the wire's bound are left out. Only
 * the flag leaves the device; a page that cannot be read shows neither.
 */
export async function signedInHint(
  rt: Runtime,
  live: LiveDocument,
  usernames: readonly string[],
): Promise<boolean> {
  return (
    (await showsMarkers(
      rt,
      live,
      await markerProofs(rt, live.document.origin, live.document.origin),
    )) || (await showsUsername(rt, live, usernames))
  );
}

/**
 * The signed-in markers of every route recipe of `recipesOrigin` that a page of
 * `pageOrigin` may show (ADR 0029's E1), within the wire's bound of 24 targets.
 */
export async function markerProofs(
  rt: Runtime,
  recipesOrigin: string,
  pageOrigin: string,
): Promise<ReturnType<typeof markerProof>[]> {
  const proofs: ReturnType<typeof markerProof>[] = [];
  let bound = 24;
  for (const recipe of (await routesOf(rt, recipesOrigin)) ?? []) {
    const proof = markerProof(recipe, pageOrigin);
    if (!proof.targets.length || proof.targets.length > bound) continue;
    bound -= proof.targets.length;
    proofs.push(proof);
  }
  return proofs;
}

/** Whether the document shows one of `proofs`' markers (E1); one that cannot be read does not. */
export async function showsMarkers(
  rt: Runtime,
  live: LiveDocument,
  proofs: readonly ReturnType<typeof markerProof>[],
): Promise<boolean> {
  if (!proofs.length) return false;
  const parsed = v.safeParse(
    observationSchema,
    await send(rt, live, {
      type: "login.observe",
      path: live.path,
      targets: proofs.flatMap((proof) => proof.targets),
      require: proofs.flatMap((proof) => proof.shown),
      links: proofs.flatMap((proof) => proof.links),
      hidden: proofs.flatMap((proof) => proof.hidden),
    }).catch(() => undefined),
  );
  let offset = 0;
  for (const proof of proofs) {
    if (parsed.success && proof.proves(parsed.output.targets, offset)) return true;
    offset += proof.targets.length;
  }
  return false;
}

/**
 * Whether one of `usernames`, the matching items', shows in the document's header or
 * navigation (E2); one that cannot be read shows none. Only the flag is kept.
 */
export async function showsUsername(
  rt: Runtime,
  live: LiveDocument,
  usernames: readonly string[],
): Promise<boolean> {
  for (const username of usernames.slice(0, MAX_HINT_USERNAMES)) {
    if (!username) continue;
    // Serial reads of one page, as for a login's own check.
    const parsed = v.safeParse(
      stateResultSchema,
      // eslint-disable-next-line no-await-in-loop
      await send(rt, live, { type: "login.state", account: { username } }).catch(() => undefined),
    );
    if (parsed.success && parsed.output.ok && parsed.output.signs.username === true) return true;
  }
  return false;
}

/**
 * The tab's visit of its page `live`, on whose path `confirm`, a recipe generated as
 * `confirm` or `unclear`, starts (ADR 0035), logged when the tab leaves it. Admission
 * already left a visit of another document or path.
 */
export function confirmPage(rt: Runtime, live: LiveDocument, confirm: LoginRecipe): ConfirmVisit {
  const { tabId, documentId } = live.document;
  const kept = rt.confirmVisits.get(tabId);
  const visit = (kept?.document.documentId === documentId && kept.path === live.path
    ? kept
    : undefined) ?? {
    document: live.document,
    path: live.path,
    url: live.url,
    recipe: { id: confirm.id, revision: confirm.revision, pageKind: confirm.pageKind },
    first: loginReadiness(confirm.steps[0]!),
    submitted: false,
  };
  rt.confirmVisits.set(tabId, visit);
  return visit;
}

/**
 * What a page Pateat does not fill shows, for the evaluation of page kinds (ADR 0035),
 * never a value or page text: whether a signed-in marker of the origin's recipes shows (E1)
 * and whether a matching item's username shows in its header or navigation (E2, absent
 * when the vault matched nothing or a username could not be read), read as the `signedIn`
 * hint is, and the tab's previous page of the origin. A header rendered after the form is
 * waited for as on the next page: read a second apart at most `SITE_MOVE_READINGS` times
 * until either shows or the page goes, both from the last reading.
 */
export async function confirmSigns(
  rt: Runtime,
  live: LiveDocument,
): Promise<{ e1?: boolean; e2?: boolean; previousUrl?: string }> {
  const proofs = await markerProofs(rt, live.document.origin, live.document.origin);
  const scope = await generationSlotsFor(rt, live).catch(() => undefined);
  const usernames =
    scope && (await readUsernames(rt, live.document.origin, usernameReads(rt, scope)));
  // Unset until the page is read: one gone before its first reading shows neither.
  let e1: boolean | undefined;
  let e2: boolean | undefined;
  // Each reading waits for the one before, as the page goes on rendering.
  /* eslint-disable no-await-in-loop */
  for (let reading = 0; reading < SITE_MOVE_READINGS; reading++) {
    if (reading > 0) await new Promise<void>((resolve) => setTimeout(resolve, SIGN_IN_RECHECK_MS));
    const page = rt.documents.get(frameKey(live.document));
    if (page?.document.documentId !== live.document.documentId || page.path !== live.path) break;
    e1 = await showsMarkers(rt, page, proofs);
    e2 = usernames && (await showsUsername(rt, page, usernames));
    if (e1 || e2) break;
  }
  /* eslint-enable no-await-in-loop */
  usernames?.fill("");
  return {
    ...(e1 === undefined ? {} : { e1 }),
    ...(e2 === undefined ? {} : { e2 }),
    ...(live.previousUrl ? { previousUrl: live.previousUrl } : {}),
  };
}

/**
 * Logs the tab leaving `visit`'s page, once that page was logged (ADR 0035): whether the
 * person submitted its form and, when it showed neither E1 nor E2, whether `next`, the
 * tab's next page, shows E1. Without `next` (the tab closed, or its next page is not read)
 * that is left out.
 */
export function leaveConfirm(rt: Runtime, visit: ConfirmVisit, next?: LiveDocument): void {
  const { tabId, origin: visitOrigin } = visit.document;
  if (rt.confirmVisits.get(tabId) === visit) rt.confirmVisits.delete(tabId);
  void visit.logged
    ?.then(async (watchNext) => {
      const nextE1 = watchNext && next ? await nextShowsMarker(rt, visitOrigin, next) : undefined;
      report(
        rt,
        { frameId: 0 },
        {
          type: "confirm-left",
          tabId,
          origin: visitOrigin,
          recipeId: visit.recipe.id,
          recipeRevision: visit.recipe.revision,
          pageKind: visit.recipe.pageKind,
          personSubmitted: visit.submitted,
          ...(nextE1 === undefined ? {} : { nextE1 }),
          url: visit.url,
        },
      );
      return undefined;
    })
    .catch(() => undefined);
}

/**
 * Whether `next`, the tab's next top page after a page of `recipesOrigin` Pateat does not
 * fill, shows a signed-in marker of that origin's recipes (ADR 0035), read a second apart
 * at most `SITE_MOVE_READINGS` times while the document stays, as a page that renders its
 * header late does; undefined when it went before its first reading.
 */
export async function nextShowsMarker(
  rt: Runtime,
  recipesOrigin: string,
  next: LiveDocument,
): Promise<boolean | undefined> {
  const proofs = await markerProofs(rt, recipesOrigin, next.document.origin);
  if (!proofs.length) return false;
  const key = frameKey(next.document);
  // Each reading waits for the one before, as the page goes on rendering.
  /* eslint-disable no-await-in-loop */
  for (let reading = 0; reading < SITE_MOVE_READINGS; reading++) {
    if (reading > 0) await new Promise<void>((resolve) => setTimeout(resolve, SIGN_IN_RECHECK_MS));
    const nextLive = rt.documents.get(key);
    if (nextLive?.document.documentId !== next.document.documentId)
      return reading ? false : undefined;
    if (await showsMarkers(rt, nextLive, proofs)) return true;
  }
  /* eslint-enable no-await-in-loop */
  return false;
}

/**
 * The URL of the tab's previous page for its top `document`, newly announced on `path`,
 * for the log of a page Pateat does not fill (ADR 0035): `oldLive`, the tab's last read
 * top page, when it was another page of the same origin or this document before its path
 * changed in place, and what `oldLive` had when this is the same page again. A page of
 * another origin, or one Pateat did not admit in between, leaves it out.
 */
export function previousPage(
  _rt: Runtime,
  document: LoginDocument,
  oldLive: LiveDocument | undefined,
  sameDocument: boolean,
  path: string,
): string | undefined {
  if (document.frameId !== 0 || !oldLive) return undefined;
  if (sameDocument && oldLive.path === path) return oldLive.previousUrl;
  if (oldLive.leftUnread || oldLive.document.origin !== document.origin) return undefined;
  return oldLive.url;
}

/** Whether the document shows a step's elements now, without waiting for them. */
export async function showsNow(
  rt: Runtime,
  live: LiveDocument,
  readiness: LoginReadiness,
): Promise<boolean> {
  try {
    const parsed = v.safeParse(
      awaitResultSchema,
      await send(rt, live, { type: "login.await", readiness, timeoutMs: 0 }),
    );
    return parsed.success && parsed.output.ok;
  } catch {
    return false;
  }
}

/**
 * Whether a chooser login's first step is its click on the list (ADR 0028): not when it
 * started on the `other` branch's form already shown on the list's path, nor when it
 * pressed the passkey button beside the list (ADR 0079).
 */
export const listOf = (_rt: Runtime, run: Execution) =>
  run.chooser &&
  run.metadata.chooser &&
  run.metadata.chooser.click !== "other-shown" &&
  run.metadata.chooser.click !== "passkey"
    ? { chooser: run.chooser, click: run.metadata.chooser.click }
    : undefined;

/** A chooser's buttons and what its readiness waits for on its list (ADR 0028). */
export const listButtons = (_rt: Runtime, chooser: LoginChooserRecipe) => ({
  ...(chooser.chooser.other ? { other: chooser.chooser.other } : {}),
  ...(chooser.chooser.continue ? { continue: chooser.chooser.continue } : {}),
});

export const listReadiness = (_rt: Runtime, chooser: LoginChooserRecipe): LoginReadiness => ({
  path: chooser.chooser.path,
  require: "clickable",
  targets: [chooser.chooser.other, chooser.chooser.continue].filter(
    (target) => target !== undefined,
  ),
  accounts: true,
});

/**
 * What a new login on a chooser's list clicks for its account (ADR 0028), as the
 * document decides it now without clicking; when nothing fits, what the list showed
 * (`ListMiss`, for the log); `unreadable` when the account's username cannot be read,
 * and `undefined` when the document could not be asked or no longer shows the list.
 */
export async function listClick(
  rt: Runtime,
  snapshot: Extract<SettingsResponse, { ok: true }>,
  live: LiveDocument,
  chooser: LoginChooserRecipe,
  chosen: { connectionId: string; itemId: string },
): Promise<ListClick | ListMiss | "unreadable" | undefined> {
  const usernames = await listUsernames(rt, snapshot, live, chosen);
  if (!usernames) return "unreadable";
  const list = { ...usernames, ...listButtons(rt, chooser) };
  try {
    const parsed = v.safeParse(
      chooseResultSchema,
      await send(rt, live, { type: "login.choose", path: chooser.chooser.path, list }),
    );
    if (!parsed.success || !parsed.output.ok) return undefined;
    return parsed.output.miss ?? (parsed.output.click as ListClick);
  } catch {
    return undefined;
  } finally {
    list.username = "";
    list.others.fill("");
  }
}

/**
 * The shape the matching items' usernames share (ADR 0016), from the usernames
 * {@link readUsernames} read for the page: an item without a username, or whose username
 * the user excluded, does not count. A scope with items that could not be checked, or a
 * username too long to shape, sends no shape.
 */
export function usernameShape(
  _rt: Runtime,
  scope: Pick<GenerationScope, "complete">,
  usernames: readonly string[],
): ValueShape | undefined {
  if (!scope.complete) return undefined;
  let shape: ValueShape | undefined;
  for (const value of usernames) {
    const itemShape = valueShapeOf({ source: "username", value });
    // A value too long to shape cannot be compared.
    if (!itemShape) return undefined;
    if (shape && JSON.stringify(shape) !== JSON.stringify(itemShape)) return undefined;
    shape = itemShape;
  }
  return shape;
}

/**
 * Reads the given usernames one at a time, for the username's shape and for hiding them
 * from the page sent to the service, and never for anything else: they are never sent
 * or logged. An empty username does not count. `undefined` when one cannot be read, so
 * the page is not sent: a username that was not read cannot be hidden.
 */
export async function readUsernames(
  rt: Runtime,
  pageOrigin: string,
  reads: ReturnType<typeof usernameReads>,
): Promise<string[] | undefined> {
  const usernames: string[] = [];
  for (const { connection, itemId, fieldId } of reads) {
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
    if (value === undefined) {
      usernames.fill("");
      return undefined;
    }
    if (value) usernames.push(value);
    value = "";
  }
  return usernames;
}

/**
 * The page with the account's usernames hidden (`withoutUsernames`), or why it is not
 * sent: `username-unread` when one could not be read, `username-shown` when one shows
 * where it cannot be hidden, including in a segment of `live`'s raw path that the
 * observation carries as `[id]` (ADR 0039). The usernames are dropped once it is built.
 */
export function hideUsernames(
  _rt: Runtime,
  observation: LoginObservation,
  usernames: string[] | undefined,
  live: LiveDocument,
): { observation: LoginObservation } | { reason: string } {
  if (!usernames) return { reason: "username-unread" };
  const hidden = withoutUsernames(observation, usernames, rawPath(live));
  usernames.fill("");
  return hidden.ok ? { observation: hidden.observation } : { reason: hidden.reason };
}
