import * as v from "valibot";
import {
  getItemEligibility,
  isSiteAllowed,
  isSiteExcluded,
  detailFieldFormat,
  detailFieldInputs,
  customFieldReference,
  resolveDetailSourceField,
  detailLinkSchema,
  loginDetailSchema,
  type DetailLink,
  type LoginFieldTarget,
  type LoginDetail,
  type LocalSettings,
  type VaultCatalog,
} from "@pateat/contracts";
import { browser } from "wxt/browser";
import { observationSchema, type AskedQuestion } from "../wire";
import { loginUsernameFieldId } from "../vault";
import {
  cardGuessFields,
  cardLast4,
  detailCandidates,
  detailFieldLabel,
  detailFieldValues,
  detailValue,
  isCardDetail,
  MAX_CARD_GUESS_READS,
  MAX_DETAIL_CANDIDATES,
  rankCards,
  savedDetailLinks,
  type CardFacts,
  waitsForMasterPassword,
} from "../details";
import { cardBrandOf, cardBrands, MAX_CARD_LAST_4 } from "../../page/card-hints";
import {
  detailFillRequestSchema,
  type DetailFillResponse,
  type DetailRemoveResponse,
  type DetailResponse,
} from "../detail-wire";
import { type DetailOffer } from "./session-schemas";
import { frameKey, sourceFieldKey, sameInputs } from "./steps";
import { tabAttempt, recordFor } from "./hold";
import { type LiveDocument } from "./types";
import {
  detailOwner,
  confirmedQuestion,
  askOf,
  askedSource,
  sameLink,
  readDetail,
  sameQuestion,
  writeDetailLinks,
} from "./detail-fill";
import { detailSite, askDetailPassword } from "./master-password";
import { send, saveSession } from "./attempt";
import { quietly } from "./session-store";
import type { Runtime } from "./state";

/** The tab's page, when it is an HTTP(S) page the popup has a section for. */
export async function popupPage(_rt: Runtime, tabId: number) {
  const tab = await browser.tabs.get(tabId).catch(() => undefined);
  const page = tab?.url ? (URL.parse(tab.url) ?? undefined) : undefined;
  return page?.protocol === "https:" || page?.protocol === "http:"
    ? { url: page, title: tab?.title }
    : undefined;
}

/** The tab's offer while the tab still shows its document on the page's origin. */
export function shownOffer(
  rt: Runtime,
  tabId: number,
  pageOrigin: string,
): DetailOffer | undefined {
  const offer = rt.detailOffers.get(tabId);
  const live = offer && rt.documents.get(frameKey(offer.document));
  // An offer belongs to the tab's login that stopped at it, not to a later one.
  return offer &&
    offer.account.origin === pageOrigin &&
    live?.document.documentId === offer.document.documentId &&
    tabAttempt(rt, tabId)?.id === offer.attemptId
    ? offer
    : undefined;
}

/** The login item whose links the popup shows for the tab: its offer's, or its login's. */
export function detailAccount(rt: Runtime, tabId: number, pageOrigin: string) {
  return shownOffer(rt, tabId, pageOrigin)?.account ?? recordFor(rt, tabId, pageOrigin)?.account;
}

/**
 * Which of `candidates`, the login item's answer fields, the popup offers for an answer
 * input (ADR 0061), with what the page must show beside it for the fill (`askOf`): the
 * field whose name, or whose confirmed question, the page shows there; or else the field
 * the judge paired with the input, while the page still shows the paired question there
 * as one whole question, with that question for the owner to confirm and as the page
 * showed it (`shown`).
 */
export async function answerCandidate<T extends { itemId: string; fieldId: string }>(
  rt: Runtime,
  live: LiveDocument,
  path: string,
  field: Extract<DetailOffer["fields"][number], { target: LoginFieldTarget }>,
  found: NonNullable<ReturnType<typeof detailOwner>>,
  policy: Pick<LocalSettings, "detailLinks">,
  candidates: readonly T[],
): Promise<{ candidate: T; ask: AskedQuestion; question?: string; shown?: string } | undefined> {
  const item = found.connection.items.find((entry) => entry.id === found.owner.itemId);
  if (!item) return undefined;
  const named = candidates.flatMap((candidate) => {
    const name =
      candidate.itemId === item.id
        ? item.fields.find((entry) => entry.id === candidate.fieldId)?.name
        : undefined;
    const question = name
      ? confirmedQuestion(rt, policy, found.owner, item, candidate.fieldId)
      : undefined;
    return name ? [{ candidate, ask: askOf(rt, name, question) }] : [];
  });
  const asked = await askedSource(rt, live, path, field.target, named);
  if (asked) return { candidate: asked.candidate, ask: asked.ask };
  const { paired } = field;
  const pairing =
    paired &&
    named.find((entry) => {
      const reference = customFieldReference(item.fields, entry.candidate.fieldId);
      return reference && sourceFieldKey(reference) === sourceFieldKey(paired.field);
    });
  if (!paired || !pairing) return undefined;
  // Nothing fuzzy: the question the judge copied must be one whole question beside the
  // input, never a part of one, such as its label.
  const ask = { question: paired.question };
  const shown = await askedSource(rt, live, path, field.target, [{ ask }]);
  return shown
    ? { candidate: pairing.candidate, ask, question: paired.question, shown: paired.shown }
    : undefined;
}

/**
 * The popup's card candidates in the order of `rankCards` (ADR 0061, owner 2026-10-23
 * 12:26 UTC): the document answers which last four digits and brand it shows beside
 * `target` (the digits in its title too), then each candidate card's number and brand,
 * the first `MAX_CARD_GUESS_READS` cards, are read one at a time, as a fill reads them,
 * and only their last four digits and brand are kept until the ranking. Neither the
 * page's answer nor a value is sent or logged. The site and the login item must still be
 * allowed, as for a fill. A page that shows nothing reads nothing; a field without a
 * value is unknown; a read that throws, or a vault that locks or changes during the
 * reads, keeps the order by name. The result is kept for the offer's input as its order
 * of item IDs and whether it selects, so the popup's polls read the vault again only
 * when the page's answer, the settings or the vault change, and an answer that fails
 * keeps the last result.
 */
export async function guessCard<T extends { itemId: string }>(
  rt: Runtime,
  live: LiveDocument,
  offer: DetailOffer,
  target: LoginFieldTarget,
  snapshot: { settings: LocalSettings; revision: number },
  catalog: VaultCatalog,
  candidates: T[],
): Promise<{ candidates: T[]; preselect: boolean }> {
  const policy = snapshot.settings;
  let byName = { candidates, preselect: true };
  const connection = catalog.connections.find((entry) => entry.id === offer.account.connectionId);
  if (
    !connection ||
    (connection.state !== "ready" && connection.state !== "review-required") ||
    isSiteExcluded(policy, offer.account.origin) ||
    !isSiteAllowed(policy, offer.account.origin) ||
    !getItemEligibility(policy, catalog, connection.id, offer.account.itemId).eligible
  )
    return byName;
  const items = [...new Set(candidates.map((entry) => entry.itemId))];
  // A card with Bitwarden's re-prompt is never read for the guess while the login does not
  // hold the master password: it stays a candidate, not read, so the guess selects none,
  // even by name, and its Fill asks (owner, 2026-10-23 21:50 UTC).
  const site = detailSite(rt, offer.attemptId, connection.id, live.url);
  const readable = items.filter((itemId) => {
    const item = connection.items.find((entry) => entry.id === itemId);
    return !item || !waitsForMasterPassword(policy, item, offer.account.itemId, site);
  });
  if (readable.length < items.length) byName = { candidates, preselect: false };
  const slot = `${offer.attemptId} ${offer.document.documentId} ${JSON.stringify(target)}`;
  // Whether the login holds the master password changes which cards are read.
  const holds = rt.repromptTyped.get(offer.attemptId) === connection.id;
  const vault = `${snapshot.revision} ${connection.snapshotId ?? ""} ${items.join(",")} ${holds}`;
  const kept = rt.cardGuesses.get(slot);
  const apply = (guess: { order: readonly string[]; preselect: boolean }) => ({
    candidates: [
      ...guess.order.flatMap((id) => candidates.filter((entry) => entry.itemId === id)),
      ...candidates.filter((entry) => !guess.order.includes(entry.itemId)),
    ],
    preselect: guess.preselect,
  });
  const answer = v.safeParse(
    v.object({
      ok: v.literal(true),
      last4: v.pipe(v.array(v.pipe(v.string(), v.regex(/^\d{4}$/u))), v.maxLength(MAX_CARD_LAST_4)),
      brands: v.pipe(v.array(v.picklist(cardBrands)), v.maxLength(cardBrands.length)),
    }),
    await send(rt, live, { type: "login.detail.card", path: offer.path, target }).catch(
      () => undefined,
    ),
  );
  // The page did not answer: the last result for this input, while the vault is the same.
  if (!answer.success) return kept?.vault === vault ? apply(kept) : byName;
  const hints = answer.output;
  // Only a digest of the page's answer is kept, never its digits.
  const digest = new Uint8Array(
    await crypto.subtle.digest(
      "SHA-256",
      new TextEncoder().encode(JSON.stringify([[...hints.last4].sort(), hints.brands])),
    ),
  );
  const key = `${vault} ${[...digest].map((byte) => byte.toString(16).padStart(2, "0")).join("")}`;
  if (kept?.key === key) {
    hints.last4.fill("");
    return apply(kept);
  }
  const keepGuess = (guess: { candidates: T[]; preselect: boolean }) => {
    rt.cardGuesses.delete(slot);
    // A few inputs' results at most; the oldest goes first.
    if (rt.cardGuesses.size >= 32) rt.cardGuesses.delete(rt.cardGuesses.keys().next().value!);
    rt.cardGuesses.set(slot, {
      key,
      vault,
      order: guess.candidates.map((entry) => entry.itemId),
      preselect: guess.preselect,
    });
    return guess;
  };
  if (!hints.last4.length && !hints.brands.length) return keepGuess(byName);
  const facts = new Map<string, CardFacts>();
  let gave = false;
  try {
    for (const itemId of readable.slice(0, MAX_CARD_GUESS_READS)) {
      const held: CardFacts = {};
      for (const fieldId of cardGuessFields(policy, catalog, connection, itemId)) {
        let value: string | undefined;
        try {
          // Serial reads through the shared vault host, as for a fill.
          // eslint-disable-next-line no-await-in-loop
          value = await rt.fields({ account: { ...offer.account, itemId }, connection, fieldId });
        } catch {
          return byName;
        }
        // A card without a number or a brand gives nothing for that field.
        gave ||= value !== undefined;
        if (value !== undefined && fieldId === "card.number") held.last4 = cardLast4(value);
        else if (value !== undefined) held.brand = cardBrandOf(value);
        value = "";
      }
      facts.set(itemId, held);
    }
    // A read gives nothing too when the vault is locked or changed meanwhile, which is no
    // field without a value: no read giving a value reads as a locked vault, and the
    // guess is kept only while the vault is still the same.
    if (!gave) return byName;
    const after = await rt.settings
      .handle({ version: 1, type: "settings.get" })
      .catch(() => undefined);
    const now = after?.ok
      ? after.catalog.connections.find((entry) => entry.id === connection.id)
      : undefined;
    if (
      !after?.ok ||
      after.snapshot.revision !== snapshot.revision ||
      !now ||
      now.state !== connection.state ||
      now.snapshotId !== connection.snapshotId
    )
      return byName;
    return keepGuess(rankCards(candidates, facts, hints));
  } finally {
    facts.clear();
    hints.last4.fill("");
  }
}

/**
 * What the popup shows about a page's personal details (ADR 0061): the handler the tab's
 * login stopped at with the fields that could give each detail, and the site's links for
 * the login item, by their names in the device's catalog only.
 */
export async function popupDetail(rt: Runtime, tabId: number): Promise<DetailResponse> {
  const page = await popupPage(rt, tabId);
  if (!page) return { ok: false, reason: "no-page" };
  const pageOrigin = page.url.origin;
  await rt.vars.sessionLoaded;
  const login = detailAccount(rt, tabId, pageOrigin);
  const snapshot = await rt.settings
    .handle({ version: 1, type: "settings.get" })
    .catch(() => undefined);
  const found = login && snapshot?.ok ? detailOwner(rt, login, snapshot.catalog) : undefined;
  if (!found || !snapshot?.ok) return { ok: true, origin: pageOrigin, links: [] };
  const policy = snapshot.snapshot.settings;
  const { catalog } = snapshot;
  const offer = shownOffer(rt, tabId, pageOrigin);
  const live = offer && rt.documents.get(frameKey(offer.document));
  const details = [];
  for (const [at, field] of (offer?.fields ?? []).entries()) {
    if (offer!.fields.findIndex((other) => other.detail === field.detail) !== at) continue;
    // Every card is ranked, so one past the popup's list counts against a selection.
    let candidates = detailCandidates(
      policy,
      catalog,
      found.connection,
      field.detail,
      { host: page.url.hostname, title: page.title, loginItemId: found.owner.itemId },
      isCardDetail(field.detail) ? Infinity : MAX_DETAIL_CANDIDATES,
    );
    // A secret question's answer is offered only from the field named as the page's
    // question, or confirmed for it, which the document finds; or from the field the
    // judge paired with it, with the question for the owner to confirm.
    let question: string | undefined;
    if (field.detail === "secret-answer") {
      const asked =
        live &&
        !("parts" in field) &&
        // eslint-disable-next-line no-await-in-loop
        (await answerCandidate(rt, live, offer!.path, field, found, policy, candidates));
      candidates = asked ? [asked.candidate] : [];
      // The popup shows the question as the page showed it.
      question = asked ? asked.shown : undefined;
    }
    // A card is guessed from the last digits and brand the page shows too, beside a split
    // value's first input.
    let preselect = field.detail !== "member-id";
    if (live && isCardDetail(field.detail) && candidates.length > 1) {
      // eslint-disable-next-line no-await-in-loop
      const guess = await guessCard(
        rt,
        live,
        offer!,
        "parts" in field ? field.parts[0]!.target : field.target,
        snapshot.snapshot,
        catalog,
        candidates,
      );
      ({ candidates } = guess);
      preselect &&= guess.preselect;
    }
    candidates = candidates.slice(0, MAX_DETAIL_CANDIDATES);
    // A split birth date is named as the one input it reads as (ADR 0061).
    const format = detailFieldFormat(field);
    if (candidates.length)
      details.push({
        detail: field.detail,
        ...(format ? { format } : {}),
        candidates: candidates as [(typeof candidates)[number], ...typeof candidates],
        // A member ID's fields' names say little, and two cards may show the same last
        // digits, so none is chosen for the owner.
        ...(preselect ? {} : { preselect: false as const }),
        ...(question ? { question } : {}),
      });
  }
  const kept = rt.pendingDetails.get(tabId) ?? [];
  const label = (detail: LoginDetail, itemId: string, field: DetailLink["source"]["field"]) => {
    const item = found.connection.items.find((entry) => entry.id === itemId);
    const fieldId = item && resolveDetailSourceField(field, item.fields);
    return {
      itemLabel: item?.label ?? "An item no longer in the vault",
      fieldLabel:
        item && fieldId ? detailFieldLabel(detail, fieldId, item) : "A field no longer in the item",
    };
  };
  // One row per detail; a secret question's answers, one link per question, share one.
  const links = loginDetailSchema.options.flatMap((detail) => {
    const waiting = kept
      .filter((entry) => sameLink(rt, entry.link, found.owner, detail))
      .map((entry) => entry.link);
    const all = [
      ...waiting,
      ...savedDetailLinks(policy, found.owner, detail).filter(
        (link) => !waiting.some((other) => sameLink(rt, link, other, detail, other.source.field)),
      ),
    ];
    const first = all[0];
    if (!first) return [];
    return [
      {
        detail,
        ...label(detail, first.source.itemId, first.source.field),
        ...(all.length > 1 ? { fieldLabel: `${all.length} questions` } : {}),
        ...(waiting.length ? { pending: true as const } : {}),
      },
    ];
  });
  return {
    ok: true,
    origin: pageOrigin,
    ...(offer && details.length
      ? {
          offer: {
            documentId: offer.document.documentId,
            details: details as [(typeof details)[number], ...typeof details],
          },
        }
      : {}),
    links,
  };
}

/**
 * The popup's **Fill** (ADR 0061): fills the offer's input with the value made from the
 * chosen field, after its choosing radio, without pressing the button, and keeps the link
 * for the tab until its login is confirmed.
 */
export async function popupDetailFill(
  rt: Runtime,
  request: v.InferOutput<typeof detailFillRequestSchema>,
  /**
   * `asked` once the window asked for the master password; `targets` for the fill after
   * a login's own ask, which names the field it stopped at among those of the detail.
   */
  within: { asked?: boolean; targets?: LoginFieldTarget[] } = {},
): Promise<DetailFillResponse> {
  await rt.vars.sessionLoaded;
  const offer = rt.detailOffers.get(request.tabId);
  const live = offer && rt.documents.get(frameKey(offer.document));
  if (
    !offer ||
    offer.document.documentId !== request.documentId ||
    live?.document.documentId !== offer.document.documentId ||
    tabAttempt(rt, request.tabId)?.id !== offer.attemptId
  )
    return { ok: false, reason: "document-gone" };
  const field = offer.fields.find(
    (entry) =>
      entry.detail === request.detail &&
      (within.targets === undefined ||
        sameInputs(
          detailFieldInputs(entry).map((input) => input.target),
          within.targets,
        )),
  );
  if (!field) return { ok: false, reason: "not-a-candidate" };
  const snapshot = await rt.settings
    .handle({ version: 1, type: "settings.get" })
    .catch(() => undefined);
  if (!snapshot?.ok) return { ok: false, reason: "unavailable" };
  // The site and the login item may have been excluded since the login stopped.
  if (
    isSiteExcluded(snapshot.snapshot.settings, offer.account.origin) ||
    !isSiteAllowed(snapshot.snapshot.settings, offer.account.origin) ||
    !getItemEligibility(
      snapshot.snapshot.settings,
      snapshot.catalog,
      offer.account.connectionId,
      offer.account.itemId,
    ).eligible
  )
    return { ok: false, reason: "unavailable" };
  const found = detailOwner(rt, offer.account, snapshot.catalog);
  if (!found || found.connection.id !== request.connectionId)
    return { ok: false, reason: "not-a-candidate" };
  const offered = detailCandidates(
    snapshot.snapshot.settings,
    snapshot.catalog,
    found.connection,
    field.detail,
    { host: new URL(offer.account.origin).hostname, loginItemId: offer.account.itemId },
    Infinity,
  );
  const chosen = offered.find(
    (entry) => entry.itemId === request.itemId && entry.fieldId === request.fieldId,
  );
  if (!chosen) return { ok: false, reason: "not-a-candidate" };
  // An item with Bitwarden's re-prompt is read only once the login holds the master
  // password; the window asks first, and then every check above is made again (owner,
  // 2026-10-23 21:50 UTC).
  const chosenItem = found.connection.items.find((entry) => entry.id === request.itemId);
  if (
    chosenItem &&
    waitsForMasterPassword(
      snapshot.snapshot.settings,
      chosenItem,
      offer.account.itemId,
      detailSite(rt, offer.attemptId, found.connection.id, live.url),
    )
  ) {
    if (within.asked || !(await askDetailPassword(rt, offer, found.connection, chosenItem)))
      return { ok: false, reason: "no-master-password" };
    return popupDetailFill(rt, request, { ...within, asked: true });
  }
  // A secret question's answer goes only under the page's own question: its field's name
  // or the question confirmed for it, or, confirmed by this Fill, the question the judge
  // paired with the field (ADR 0061).
  const answer =
    field.detail === "secret-answer" && !("parts" in field)
      ? await answerCandidate(rt, live, offer.path, field, found, snapshot.snapshot.settings, [
          chosen,
        ])
      : undefined;
  if (field.detail === "secret-answer" && !answer) return { ok: false, reason: "not-a-candidate" };
  const item = found.connection.items.find((entry) => entry.id === request.itemId);
  const reference = request.fieldId.startsWith("custom.")
    ? item && customFieldReference(item.fields, request.fieldId)
    : request.fieldId;
  const source = v.safeParse(detailLinkSchema.entries.source.entries.field, reference);
  if (!source.success) return { ok: false, reason: "not-a-candidate" };
  // The page must still show the handler: its inputs writable, a split date's selects
  // choosable (ADR 0061), and its button shown.
  const targets = detailFieldInputs(field).map((input) => input.target);
  const observed = v.safeParse(
    observationSchema,
    await send(rt, live, {
      type: "login.observe",
      path: offer.path,
      targets: [...targets, offer.target],
      require: [...targets.map(() => "settable" as const), "shown"],
    }).catch(() => undefined),
  );
  if (
    !observed.success ||
    observed.output.path !== offer.path ||
    observed.output.targets.some((state) => state !== "unique")
  )
    return { ok: false, reason: "document-gone" };
  // The value goes only to the login item's account when the page shows one, as a login's
  // fill does (owner decision, 2026-10-11); the page compares it in the content script.
  const usernameField = loginUsernameFieldId(found.connection, offer.account.itemId);
  let username: string | undefined;
  if (usernameField)
    try {
      username = await rt.fields({
        account: offer.account,
        connection: found.connection,
        fieldId: usernameField,
      });
    } catch {
      username = undefined;
    }
  const own = username ? { username } : undefined;
  username = "";
  const read = await readDetail(
    rt,
    offer.account,
    found.connection,
    field.detail,
    request.itemId,
    request.fieldId,
  );
  if (read === undefined) return { ok: false, reason: "unavailable" };
  // An answer goes only with its question; every other value, a split one's parts
  // included, is made here right after the read.
  const values =
    field.detail === "secret-answer" && !("parts" in field)
      ? ((value) =>
          value === undefined || !answer
            ? undefined
            : [{ value, secret: "answer" as const, question: answer.ask }])(
          detailValue(field.detail, field.format, read[0]),
        )
      : detailFieldValues(field, read[0], read[1]);
  read.fill("");
  if (values === undefined || values === "unfit") return { ok: false, reason: "unreadable" };
  const command = {
    type: "login.detail.fill",
    path: offer.path,
    fields: values.map((entry, at) => ({ ...entry, target: targets[at]! })),
    ...(own ? { account: own } : {}),
  };
  const response = await send(rt, live, command).catch(() => undefined);
  for (const entry of [...values, ...command.fields]) entry.value = "";
  if (own) own.username = "";
  if (
    v.safeParse(v.object({ ok: v.literal(false), reason: v.literal("other-account") }), response)
      .success
  )
    return { ok: false, reason: "other-account" };
  if (!v.safeParse(v.object({ ok: v.literal(true) }), response).success)
    return { ok: false, reason: "not-filled" };
  const link: DetailLink = {
    ...found.owner,
    detail: field.detail,
    source: { itemId: request.itemId, field: source.output },
    // The owner confirmed the judge's pairing: later logins look for the stored question.
    ...(answer?.question ? { question: answer.question } : {}),
  };
  rt.pendingDetails.set(request.tabId, [
    // One link per handler: a second Fill, as after choosing another radio, replaces
    // the first, so only the value last filled is saved; a secret question's answers,
    // one per question.
    ...(rt.pendingDetails.get(request.tabId) ?? []).filter(
      (entry) =>
        !sameLink(rt, entry.link, found.owner, field.detail, link.source.field) &&
        !sameQuestion(rt, entry.link, link) &&
        !(
          entry.attemptId === offer.attemptId &&
          entry.handler === offer.handler &&
          field.detail !== "secret-answer"
        ),
    ),
    {
      tabId: request.tabId,
      attemptId: offer.attemptId,
      handler: offer.handler,
      connectionId: found.connection.id,
      link,
    },
  ]);
  await quietly(rt, () => saveSession(rt));
  return { ok: true };
}

/** The popup's **Remove** (ADR 0061): drops the site's link for a detail, kept or saved. */
export async function popupDetailRemove(
  rt: Runtime,
  tabId: number,
  detail: LoginDetail,
): Promise<DetailRemoveResponse> {
  const page = await popupPage(rt, tabId);
  await rt.vars.sessionLoaded;
  // The write checks the stored logins (`loginElsewhere`).
  await rt.vars.loaded;
  const login = page && detailAccount(rt, tabId, page.url.origin);
  const snapshot = await rt.settings
    .handle({ version: 1, type: "settings.get" })
    .catch(() => undefined);
  const found = login && snapshot?.ok ? detailOwner(rt, login, snapshot.catalog) : undefined;
  if (!found || !snapshot?.ok) return { ok: false, reason: "no-link" };
  const kept = rt.pendingDetails.get(tabId) ?? [];
  const rest = kept.filter((entry) => !sameLink(rt, entry.link, found.owner, detail));
  if (rest.length !== kept.length) {
    if (rest.length) rt.pendingDetails.set(tabId, rest);
    else rt.pendingDetails.delete(tabId);
    await quietly(rt, () => saveSession(rt));
    return { ok: true };
  }
  // A secret question's answers go together, as the popup shows them in one row.
  if (!savedDetailLinks(snapshot.snapshot.settings, found.owner, detail).length)
    return { ok: false, reason: "no-link" };
  const written = await writeDetailLinks(rt, undefined, (links) =>
    links.filter((link) => !sameLink(rt, link, found.owner, detail)),
  );
  return written === "saved" || written === "unchanged"
    ? { ok: true }
    : { ok: false, reason: "not-saved" };
}
