import * as v from "valibot";
import {
  attemptPlan,
  handlerSteps,
  manualDetails,
  sameLoginTarget,
  detailFieldInputs,
  resolveDetailSourceField,
  type DetailLink,
  type LoginFieldTarget,
  type LoginDetail,
  type LoginAccount,
  type LoginDocument,
  type LoginRecipe,
  type LocalSettings,
  type VaultCatalog,
  type VaultConnectionMetadata,
  type VaultItemMetadata,
} from "@pateat/contracts";
import { type LoginSecretKind, type AskedQuestion } from "../wire";
import {
  detailCandidates,
  detailFieldIds,
  detailFieldValues,
  detailValue,
  linkedField,
  savedDetailLink,
  savedDetailLinks,
  type DetailFillValue,
  type DetailOwner,
  waitsForMasterPassword,
} from "../details";
import {
  type DetailSourceField,
  type Execution,
  type DetailHandler,
  type DetailWait,
  type Authorized,
  type LiveDocument,
} from "./types";
import { sourceFieldKey } from "./steps";
import { type LoginReport } from "./report";
import { report, current, send, saveSession, loginElsewhere } from "./attempt";
import { allowed } from "./plan-2";
import { detailSite } from "./master-password";
import { observe } from "./reconcile";
import { quietly } from "./session-store";
import type { Runtime } from "./state";

// A secret question's answer has a link per question field; the other details one each.
export const refusalKey = (
  _rt: Runtime,
  owner: DetailOwner,
  detail: LoginDetail,
  field?: DetailSourceField,
) =>
  JSON.stringify([
    owner.origin,
    owner.provider,
    owner.userId,
    owner.itemId,
    detail,
    detail === "secret-answer" && field !== undefined ? sourceFieldKey(field) : null,
  ]);

/** The login item a run's links belong to, or none while its vault account is unknown. */
export function detailOwner(
  _rt: Runtime,
  login: Pick<LoginAccount, "connectionId" | "itemId" | "origin">,
  catalog: VaultCatalog,
): { owner: DetailOwner; connection: VaultConnectionMetadata } | undefined {
  const connection = catalog.connections.find((entry) => entry.id === login.connectionId);
  if (!connection?.userId) return undefined;
  return {
    owner: {
      origin: login.origin,
      provider: connection.provider,
      server: connection.server,
      userId: connection.userId,
      itemId: login.itemId,
    },
    connection,
  };
}

/** Reports a `login.handler` outcome about a `detail` handler (ADR 0061). */
export function reportDetail(
  rt: Runtime,
  document: LoginDocument,
  recipe: LoginRecipe,
  handler: number,
  outcome: Extract<Extract<LoginReport, { type: "handler" }>["outcome"], `detail-${string}`>,
): void {
  const entry = recipe.handlers?.[handler];
  report(rt, document, {
    type: "handler",
    tabId: document.tabId,
    origin: document.origin,
    recipeId: recipe.id,
    recipeRevision: recipe.revision,
    handler,
    kind: "detail",
    outcome,
    steps: entry ? handlerSteps(entry).length : 0,
  });
}

/**
 * Which input of a shown `detail` handler a login fills (ADR 0061): the first whose
 * detail Pateat fills, that has a saved link to a field the device may read, and that is
 * writable now. Undefined when none is.
 */
export async function detailInput(
  rt: Runtime,
  run: Execution,
  handler: DetailHandler,
  waiting?: (wait: DetailWait) => void,
): Promise<number | undefined> {
  const authorized = await allowed(rt, run);
  if (!authorized) return undefined;
  const found = detailOwner(rt, run.metadata.account, authorized.catalog);
  if (!found) return undefined;
  const answers = answerSources(rt, authorized, found);
  const site = detailSite(rt, run.metadata.id, found.connection.id, run.live.url);
  const linked = handler.fields.flatMap((field, index) => {
    if (manualDetails.includes(field.detail)) return [];
    // A value split over several inputs needs every one of them (ADR 0061).
    const targets = detailFieldInputs(field).map((input) => input.target);
    if (field.detail === "secret-answer")
      return answers.length ? [{ index, targets, answer: true }] : [];
    if (rt.refusedDetails.has(refusalKey(rt, found.owner, field.detail))) return [];
    const link = savedDetailLink(authorized.settings, found.owner, field.detail);
    const source =
      link && linkedField(authorized.settings, authorized.catalog, found.connection, link);
    if (!source) return [];
    // A linked item with Bitwarden's re-prompt is read only once this login holds the
    // master password (owner, 2026-10-23 21:50 UTC).
    const item = found.connection.items.find((entry) => entry.id === source.itemId);
    const wait =
      item && waitsForMasterPassword(authorized.settings, item, found.owner.itemId, site)
        ? { detail: field.detail, itemId: source.itemId, fieldId: source.fieldId, targets }
        : undefined;
    return [{ index, targets, answer: false, ...(wait ? { wait } : {}) }];
  });
  if (!linked.length) return undefined;
  const targets = linked.flatMap((entry) => entry.targets);
  const observed = await observe(
    rt,
    run,
    targets,
    targets.map(() => "settable" as const),
  );
  // The page's own path, as `enterHandler` matched it: a same-document URL change may
  // not have reached `run.live.path` yet.
  if (!observed || observed.path !== handler.path) return undefined;
  let first = 0;
  // The first input whose linked item waits for the master password, when no other fits.
  let waits: DetailWait | undefined;
  for (const entry of linked) {
    const states = observed.targets.slice(first, first + entry.targets.length);
    first += entry.targets.length;
    if (states.some((state) => state !== "unique")) continue;
    if (entry.wait) {
      waits ??= entry.wait;
      continue;
    }
    // An answer input needs one of the item's question fields to be the page's question.
    if (
      !entry.answer ||
      // eslint-disable-next-line no-await-in-loop
      (await askedSource(rt, run.live, handler.path, entry.targets[0]!, answers))
    )
      return entry.index;
    if (!current(rt, run)) return undefined;
  }
  if (waits) waiting?.(waits);
  return undefined;
}

/**
 * What the page must show beside an answer input for a field (ADR 0061): the question the
 * owner confirmed for it, as one whole question, when there is one; else its name.
 */
export const askOf = (_rt: Runtime, name: string, question: string | undefined): AskedQuestion =>
  question === undefined ? { name } : { question };

/**
 * The login item's saved links for secret questions' answers that the device may read
 * and the site has not refused, each with what the page must show beside its input
 * (`askOf`).
 */
export function answerSources(
  rt: Runtime,
  authorized: Pick<Authorized, "settings" | "catalog">,
  found: NonNullable<ReturnType<typeof detailOwner>>,
) {
  return savedDetailLinks(authorized.settings, found.owner, "secret-answer").flatMap((link) => {
    if (rt.refusedDetails.has(refusalKey(rt, found.owner, link.detail, link.source.field)))
      return [];
    const source = linkedField(authorized.settings, authorized.catalog, found.connection, link);
    return source?.name
      ? [
          {
            link,
            source,
            ask: askOf(rt, source.name, link.question),
          },
        ]
      : [];
  });
}

/**
 * The question the owner confirmed for the login item's answer field `fieldId`, saved
 * with its link (ADR 0061), or none.
 */
export function confirmedQuestion(
  _rt: Runtime,
  policy: Pick<LocalSettings, "detailLinks">,
  owner: DetailOwner,
  item: Pick<VaultItemMetadata, "fields">,
  fieldId: string,
): string | undefined {
  return savedDetailLinks(policy, owner, "secret-answer").find(
    (link) =>
      link.source.itemId === owner.itemId &&
      resolveDetailSourceField(link.source.field, item.fields) === fieldId,
  )?.question;
}

/**
 * Which of `sources` is the question the page asks beside `target` (ADR 0061), each by
 * what `askOf` gives, which the document compares with its own text, which never leaves
 * it.
 */
export async function askedSource<T extends { ask: AskedQuestion }>(
  rt: Runtime,
  live: LiveDocument,
  path: string,
  target: LoginFieldTarget,
  sources: readonly T[],
): Promise<T | undefined> {
  const named = sources
    .filter(({ ask }) => ("name" in ask ? ask.name : ask.question).length <= 200)
    .slice(0, 100);
  if (!named.length) return undefined;
  const answer = v.safeParse(
    v.object({
      ok: v.literal(true),
      index: v.optional(v.pipe(v.number(), v.integer(), v.minValue(0))),
    }),
    await send(rt, live, {
      type: "login.detail.question",
      path,
      target,
      names: named.map(({ ask }) => ask),
    }).catch(() => undefined),
  );
  return answer.success && answer.output.index !== undefined
    ? named[answer.output.index]
    : undefined;
}

/**
 * Whether the page now asks, beside an answer input of `handler`, another of the login
 * item's questions than the one whose answer this login filled (ADR 0061).
 */
export async function asksAnotherQuestion(
  rt: Runtime,
  run: Execution,
  handler: DetailHandler,
  answered: DetailSourceField,
): Promise<boolean> {
  const authorized = await allowed(rt, run);
  if (!authorized) return false;
  const found = detailOwner(rt, run.metadata.account, authorized.catalog);
  const item = found?.connection.items.find((entry) => entry.id === run.metadata.account.itemId);
  if (!found || !item) return false;
  const answeredId = resolveDetailSourceField(answered, item.fields);
  const questions = detailCandidates(
    authorized.settings,
    authorized.catalog,
    found.connection,
    "secret-answer",
    { host: new URL(run.metadata.account.origin).hostname, loginItemId: item.id },
    Infinity,
  ).flatMap((candidate) => {
    const name = item.fields.find((entry) => entry.id === candidate.fieldId)?.name;
    const question = confirmedQuestion(
      rt,
      authorized.settings,
      found.owner,
      item,
      candidate.fieldId,
    );
    return name ? [{ fieldId: candidate.fieldId, ask: askOf(rt, name, question) }] : [];
  });
  for (const field of handler.fields) {
    if (field.detail !== "secret-answer" || "parts" in field) continue;
    // eslint-disable-next-line no-await-in-loop
    const asked = await askedSource(rt, run.live, handler.path, field.target, questions);
    if (asked) return asked.fieldId !== answeredId;
  }
  return false;
}

/**
 * Keeps the `detail` handler a login stopped at for want of a link, so the popup can
 * propose vault fields for it while the tab shows this document (ADR 0061), with the
 * judge's pairing of each answer input with one of the item's fields, when this login's
 * judgement of the page made one.
 */
export async function offerDetails(
  rt: Runtime,
  run: Execution,
  handler: DetailHandler,
  index: number,
) {
  const paired = run.paired?.path === handler.path ? run.paired.questions : [];
  const asked = handler.fields
    .filter((field) => !manualDetails.includes(field.detail))
    .map((field) => {
      const pairing =
        field.detail === "secret-answer" && !("parts" in field)
          ? paired.find((entry) => sameLoginTarget(entry.target, field.target))
          : undefined;
      return pairing
        ? {
            ...field,
            paired: { field: pairing.field, question: pairing.question, shown: pairing.shown },
          }
        : field;
    });
  if (!asked.length) return;
  await rt.vars.sessionLoaded;
  rt.detailOffers.set(run.live.document.tabId, {
    document: run.live.document,
    // The handler's path, which the page showed: `run.live.path` may lag a same-document
    // URL change.
    path: handler.path,
    attemptId: run.metadata.id,
    handler: index,
    account: {
      connectionId: run.metadata.account.connectionId,
      itemId: run.metadata.account.itemId,
      origin: run.metadata.account.origin,
    },
    fields: asked,
    target: handler.target,
  });
  await quietly(rt, () => saveSession(rt));
}

/**
 * The saved link a login filled an entered `detail` handler's input from, by handler, for
 * removal once the site refused the value (ADR 0061).
 */
export function filledDetails(
  _rt: Runtime,
  run: Execution,
): { handler: number; detail: LoginDetail; field?: DetailSourceField }[] {
  return run.metadata.handlers.flatMap(
    (entry): { handler: number; detail: LoginDetail; field?: DetailSourceField }[] => {
      const handler = run.recipe.handlers?.[entry.index];
      if (handler?.kind !== "detail" || entry.field === undefined) return [];
      const field = handler.fields[entry.field];
      if (field?.detail !== "secret-answer")
        return field ? [{ handler: entry.index, detail: field.detail }] : [];
      // An answer is refused per question; one whose question is unknown here keeps it.
      const answered = run.answers?.get(entry.index);
      return answered === undefined
        ? []
        : [{ handler: entry.index, detail: field.detail, field: answered }];
    },
  );
}

/**
 * Writes `mutate` to the settings unless another login is in progress, whose policy
 * revision the write would bump (`loginElsewhere`). Returns whether it wrote.
 */
export async function writeDetailLinks(
  rt: Runtime,
  run: Execution | undefined,
  mutate: (links: DetailLink[]) => DetailLink[],
): Promise<"saved" | "unchanged" | "busy" | "failed"> {
  if (!rt.settings.update) return "failed";
  if (loginElsewhere(rt, run)) return "busy";
  // A login another tab is admitting waits for this write from here, before any await,
  // as for an account choice (see `admit`).
  const { promise: saving, resolve: finish } = Promise.withResolvers<void>();
  rt.savingChoices.add(saving);
  let writing = false;
  try {
    const latest = await rt.settings
      .handle({ version: 1, type: "settings.get" })
      .catch(() => undefined);
    if (!latest?.ok) return "failed";
    const before = latest.snapshot.settings.detailLinks ?? [];
    if (JSON.stringify(mutate(before)) === JSON.stringify(before)) return "unchanged";
    writing = true;
    return await rt.settings
      .update(latest.snapshot.revision, "detail-link", (snapshot) => ({
        ...snapshot,
        settings: {
          ...snapshot.settings,
          detailLinks: mutate(snapshot.settings.detailLinks ?? []),
        },
      }))
      .then(
        () => "saved" as const,
        () => "failed" as const,
      );
  } finally {
    if (writing) rt.vars.remembered += 1;
    rt.savingChoices.delete(saving);
    finish();
  }
}

/**
 * Whether `link` is the login item's link for `detail`; for a secret question's answer,
 * the one for `field`, or any of them without one.
 */
export const sameLink = (
  _rt: Runtime,
  link: DetailLink,
  owner: DetailOwner,
  detail: LoginDetail,
  field?: DetailSourceField,
) =>
  link.origin === owner.origin &&
  link.provider === owner.provider &&
  link.userId === owner.userId &&
  link.itemId === owner.itemId &&
  link.detail === detail &&
  (detail !== "secret-answer" ||
    field === undefined ||
    sourceFieldKey(link.source.field) === sourceFieldKey(field));

/** Whether two of a login item's answer links hold the same confirmed question. */
export const sameQuestion = (rt: Runtime, link: DetailLink, other: DetailLink) =>
  link.question !== undefined &&
  link.question === other.question &&
  sameLink(rt, link, other, "secret-answer");

/**
 * Removes the links whose values a login filled once the site refused them, as when the
 * handler's page showed again or the login was rejected, so the next login asks again
 * rather than submitting the same value (ADR 0061).
 */
export async function forgetDetail(
  rt: Runtime,
  run: Execution,
  kept: ReadonlySet<number> = new Set(),
) {
  if (run.detailsForgotten) return;
  const filled = filledDetails(rt, run).filter((entry) => !kept.has(entry.handler));
  if (!filled.length) return;
  run.detailsForgotten = true;
  const snapshot = await rt.settings
    .handle({ version: 1, type: "settings.get" })
    .catch(() => undefined);
  const found = snapshot?.ok ? detailOwner(rt, run.metadata.account, snapshot.catalog) : undefined;
  const { document } = run.live;
  if (!found) {
    for (const entry of filled)
      reportDetail(rt, document, run.recipe, entry.handler, "detail-kept");
    return;
  }
  // No login uses a refused link from here, even one the settings still hold.
  await rt.vars.sessionLoaded;
  for (const entry of filled)
    rt.refusedDetails.set(refusalKey(rt, found.owner, entry.detail, entry.field), {
      ...found.owner,
      detail: entry.detail,
      ...(entry.field === undefined ? {} : { field: entry.field }),
    });
  await quietly(rt, () => saveSession(rt));
  const written = await removeRefused(rt, run);
  for (const entry of filled)
    reportDetail(
      rt,
      document,
      run.recipe,
      entry.handler,
      written === "saved" || written === "unchanged" ? "detail-forgotten" : "detail-kept",
    );
}

/** Removes the refused links from the owner's settings, when no other login runs. */
export async function removeRefused(rt: Runtime, run?: Execution) {
  const refused = [...rt.refusedDetails.values()];
  if (!refused.length) return "unchanged" as const;
  const written = await writeDetailLinks(rt, run, (links) =>
    links.filter(
      (link) => !refused.some((entry) => sameLink(rt, link, entry, entry.detail, entry.field)),
    ),
  );
  if (written === "saved" || written === "unchanged") {
    for (const entry of refused)
      rt.refusedDetails.delete(refusalKey(rt, entry, entry.detail, entry.field));
    await quietly(rt, () => saveSession(rt));
  }
  return written;
}

/**
 * After a login is confirmed `authenticated`, saves the links its tab filled from the
 * popup (ADR 0061); after any other ending they are dropped, as an unconfirmed account
 * choice is (ADR 0023).
 */
export async function settleDetails(
  rt: Runtime,
  run: Execution,
  confirmed: boolean,
): Promise<void> {
  const { tabId } = run.live.document;
  await rt.vars.sessionLoaded;
  // The offer ends with its login, also when the person typed the value themselves and
  // the page stays in the same document.
  const offered = rt.detailOffers.get(tabId)?.attemptId === run.metadata.id;
  if (offered) rt.detailOffers.delete(tabId);
  const kept = rt.pendingDetails.get(tabId)?.filter((entry) => entry.attemptId === run.metadata.id);
  if (!kept?.length) {
    if (offered) await quietly(rt, () => saveSession(rt));
    return;
  }
  const rest = rt.pendingDetails.get(tabId)!.filter((entry) => entry.attemptId !== run.metadata.id);
  if (rest.length) rt.pendingDetails.set(tabId, rest);
  else rt.pendingDetails.delete(tabId);
  await quietly(rt, () => saveSession(rt));
  if (!confirmed) return;
  // A confirmed question replaces the link that held it, so one page's question never
  // matches two fields.
  const written = await writeDetailLinks(rt, run, (links) => [
    ...links.filter(
      (link) =>
        !kept.some(
          (entry) =>
            sameLink(rt, link, entry.link, entry.link.detail, entry.link.source.field) ||
            sameQuestion(rt, link, entry.link),
        ),
    ),
    ...kept.map((entry) => entry.link),
  ]);
  // A link the owner chose again replaces one refused before, once it is written: until
  // then the settings may still hold the refused one. The session keeps the refusals, so
  // a restarted worker does not bring a lifted one back.
  if (written === "saved" || written === "unchanged") {
    const lifted = kept.filter(({ link }) =>
      rt.refusedDetails.delete(refusalKey(rt, link, link.detail, link.source.field)),
    );
    if (lifted.length) await quietly(rt, () => saveSession(rt));
  }
  for (const entry of kept)
    reportDetail(
      rt,
      run.live.document,
      run.recipe,
      entry.handler,
      written === "saved" || written === "unchanged" ? "detail-saved" : "detail-not-saved",
    );
}

/**
 * The vault values a detail's value is made from (`detailFieldIds`), read one after
 * another from `itemId`; undefined when any read fails.
 */
export async function readDetail(
  rt: Runtime,
  login: LoginAccount,
  connection: VaultConnectionMetadata,
  detail: LoginDetail,
  itemId: string,
  fieldId: string,
): Promise<[string, ...string[]] | undefined> {
  const read: string[] = [];
  for (const id of detailFieldIds(detail, fieldId)) {
    let value: string | undefined;
    try {
      // eslint-disable-next-line no-await-in-loop
      value = await rt.fields({ account: { ...login, itemId }, connection, fieldId: id });
    } catch {
      value = undefined;
    }
    if (value === undefined) {
      read.fill("");
      return undefined;
    }
    read.push(value);
  }
  return read as [string, ...string[]];
}

/**
 * The value an entered `detail` handler's fill types (ADR 0061): read from the linked
 * field and made into what the input asks for, in this worker, so the whole phone number
 * never reaches the page, nor the whole card number except for a `card-number` input.
 * A card code fills only a password or short numeric input; a secret question's answer
 * only while the page still asks its field's question.
 */
export async function detailFill(
  rt: Runtime,
  run: Execution,
  authorized: Authorized,
  stepIndex: number,
): Promise<
  | (Omit<DetailFillValue, "secret"> & { secret?: LoginSecretKind; question?: AskedQuestion })[]
  | "unreadable"
  | "unavailable"
  | "unfit"
> {
  const index = attemptPlan(run.recipe, run.metadata)?.[stepIndex]?.handler;
  const handler = index === undefined ? undefined : run.recipe.handlers?.[index];
  const at = run.metadata.handlers.find((entry) => entry.index === index)?.field;
  const field = handler?.kind === "detail" && at !== undefined ? handler.fields[at] : undefined;
  const found = detailOwner(rt, run.metadata.account, authorized.catalog);
  if (!field || !found || index === undefined || handler?.kind !== "detail") return "unavailable";
  let source: { itemId: string; fieldId: string } | undefined;
  let question: { field: DetailSourceField; ask: AskedQuestion } | undefined;
  if (field.detail === "secret-answer") {
    if ("parts" in field) return "unavailable";
    const asked = await askedSource(
      rt,
      run.live,
      handler.path,
      field.target,
      answerSources(rt, authorized, found),
    );
    if (!current(rt, run)) return "unavailable";
    source = asked?.source;
    question = asked && { field: asked.link.source.field, ask: asked.ask };
  } else {
    const link = savedDetailLink(authorized.settings, found.owner, field.detail);
    source =
      link && !rt.refusedDetails.has(refusalKey(rt, found.owner, field.detail))
        ? linkedField(authorized.settings, authorized.catalog, found.connection, link)
        : undefined;
  }
  if (!source) return "unavailable";
  // Never a re-prompt item's value before the login holds the master password, which
  // `detailInput` asks for instead of choosing such an input.
  const sourceItem = found.connection.items.find((entry) => entry.id === source.itemId);
  if (
    sourceItem &&
    waitsForMasterPassword(
      authorized.settings,
      sourceItem,
      found.owner.itemId,
      detailSite(rt, run.metadata.id, found.connection.id, run.live.url),
    )
  )
    return "unavailable";
  const read = await readDetail(
    rt,
    run.metadata.account,
    authorized.connection,
    field.detail,
    source.itemId,
    source.fieldId,
  );
  if (read === undefined) return "unavailable";
  if (question && !("parts" in field)) {
    const value = detailValue(field.detail, field.format, read[0]);
    read.fill("");
    if (value === undefined) return "unreadable";
    // Refused, the answer's link is removed by its question field.
    (run.answers ??= new Map()).set(index, question.field);
    return [{ value, secret: "answer", question: question.ask }];
  }
  // An answer always goes with its question. A split value is made into all its parts
  // here, right after the read (ADR 0061).
  if (field.detail === "secret-answer") {
    read.fill("");
    return "unavailable";
  }
  const values = detailFieldValues(field, read[0], read[1]);
  read.fill("");
  return values ?? "unreadable";
}
