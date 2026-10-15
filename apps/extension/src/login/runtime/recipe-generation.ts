import * as v from "valibot";
import {
  getItemEligibility,
  valueShapeOf,
  type LoginObservation,
  type ChooserClick,
  type LoginChooserRecipe,
  type SemanticSlot,
  type SettingsResponse,
  type ValueShape,
  type VaultConnectionMetadata,
} from "@pateat/contracts";
import { browser } from "wxt/browser";
import {
  extractResultSchema,
  chooseResultSchema,
  type ListMissReport as ListMiss,
  loginReadiness,
  type LoginReadiness,
} from "../wire";
import { probeStarts } from "../dummy";
import { findLiveSiteCandidates } from "../../vault/site-candidates";
import { customFieldOffers } from "../generation-slots";
import { emailUsername, namesUsername } from "../../page/account-list";
import { pathShowsUsername, withoutUsernames } from "../../observation/usernames";
import { loginUsernameFieldId } from "../vault";
import {
  DocumentGone,
  EXTRACT_READS,
  EXTRACT_RETRY_MS,
  frameKey,
  type GenerationMiss,
  type GenerationScope,
  type LiveDocument,
  logCode,
  MAX_CUSTOM_SHAPE_READS,
  probeMode,
  terminal,
} from "./model";
import {
  acceptedObservation,
  type GenerationHold,
  type GenerationOutcome,
  generationSlots,
  offersGenerationField,
  outcomeFields,
} from "./recipes";
import type { RuntimeContext } from "./context";
import type { RuntimeState } from "./state";

/**
 * Pages without a recipe: whether they are offered for generation, the slots and vault
 * matches they are sent with, and reading their lists of accounts.
 */
export function createRecipeGeneration(shared: RuntimeState) {
  const runtime = shared as RuntimeContext;
  const {
    recipes,
    generation,
    uris,
    settings,
    fields,
    send,
    report,
    documents,
    spinning,
    attempts,
    options,
  } = shared;
  /* eslint-enable no-await-in-loop */
  /**
   * First steps a document watches for: every route's and variant's of each recipe,
   * deduplicated and bounded for the wire. A path where several recipes start is left out,
   * because such a page cannot start (ADR 0013); several variants of one recipe starting
   * there do not (ADR 0027).
   */
  async function startsFor(documentOrigin: string): Promise<LoginReadiness[]> {
    const all =
      probeMode && documentOrigin === runtime.origin
        ? probeStarts(runtime.origin)
        : await recipes.starts(documentOrigin).catch(() => []);
    // A chooser's list is ready once one of its buttons or a listed account shows (ADR 0028).
    const readiness = all
      .filter((start) => all.filter((other) => other.path === start.path).length === 1)
      .flatMap((start): LoginReadiness[] =>
        start.list
          ? [{ path: start.path, require: "clickable", targets: start.list, accounts: true }]
          : start.steps.map(loginReadiness),
      );
    const unique = new Map(readiness.map((entry) => [JSON.stringify(entry), entry]));
    return [...unique.values()].slice(0, 32);
  }
  /**
   * Whether this document may be sent for generation once it shows a sign-in input: a
   * top-level page on whose path no cached recipe of its origin starts (several starting
   * there count too), and whose path was not sent within the retry window (ADR 0016). An
   * entry recipe's path counts as a start (ADR 0031); it is added here only, since
   * `startsFor` leaves out a path several starts share.
   */
  async function offersGeneration(live: LiveDocument): Promise<true | GenerationHold | undefined> {
    if (!generation || !uris || live.document.frameId !== 0 || live.topUrl) return undefined;
    if (probeMode && live.document.origin === runtime.origin) return undefined;
    const starts = await recipes.starts(live.document.origin).catch(() => undefined);
    if (starts === undefined || starts.some((start) => start.path === live.path)) return undefined;
    const entries = await recipes.entries(live.document.origin).catch(() => undefined);
    if (entries === undefined || entries.some((entry) => entry.entry.path === live.path))
      return undefined;
    return generation.available(live.document.origin, live.path).catch(() => undefined);
  }
  /**
   * The slots to generate for when a vault item's URI matches the page, with the
   * matching items. No field value is read here. Without them, `miss` hears why, for the
   * log: `no-vault-match` when no item fits, or why the vault could not tell.
   */
  async function generationSlotsFor(
    live: LiveDocument,
    miss: (reason: GenerationMiss, detail?: string) => void = () => undefined,
  ): Promise<GenerationScope | undefined> {
    if (!uris) return undefined;
    const snapshot = await settings.handle({ version: 1, type: "settings.get" });
    if (!snapshot.ok) {
      miss("vault-unavailable", "settings");
      return undefined;
    }
    // The URL the page shows now: a same-document URL change (history.pushState) since the
    // document announced shows only in the tab's committed URL.
    let url = live.url;
    try {
      const tab = await browser.tabs.get(live.document.tabId);
      if (
        live.document.frameId === 0 &&
        tab.url &&
        new URL(tab.url).origin === live.document.origin
      )
        url = tab.url;
    } catch {
      miss("vault-unavailable", "tab");
      return undefined;
    }
    const scope = await findLiveSiteCandidates({
      settings: snapshot.snapshot.settings,
      catalog: snapshot.catalog,
      url,
      match: uris,
    });
    if (!scope.ok) {
      miss("no-vault-match", scope.reason);
      return undefined;
    }
    const items = scope.candidates.flatMap((candidate) => {
      const connection = snapshot.catalog.connections.find(
        (entry) => entry.id === candidate.connectionId,
      );
      const item = connection?.items.find((entry) => entry.id === candidate.itemId);
      return connection && item ? [{ connection, item }] : [];
    });
    // Only slots a matching item can fill; built-in fields keep these IDs on every device.
    const slots = generationSlots.filter(({ fieldId }) =>
      items.some(({ connection, item }) =>
        offersGenerationField(
          snapshot.snapshot.settings,
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
    if (!slots.length && !offers.length) {
      const enabled = snapshot.catalog.connections.some(
        (connection) =>
          snapshot.snapshot.settings.connections.find(
            (entry) => entry.connectionId === connection.id,
          )?.enabled,
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
    return {
      slots: slots.map(({ slot }) => slot),
      offers,
      items,
      settings: snapshot.snapshot.settings,
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
  async function sharedShape(
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
        value = await fields({
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
  function usernameReads(scope: Pick<GenerationScope, "items" | "settings">) {
    return scope.items.flatMap(({ connection, item }) => {
      const excluded = scope.settings.connections
        .find((entry) => entry.connectionId === connection.id)
        ?.excludedFields.some(
          (field) => field.itemId === item.id && field.fieldId === "login.username",
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
   * The shown texts that name a matching item's username that is not an email: the whole
   * text equals it, ignoring case and a leading `@` (ADR 0028, owner 2026-10-12 08:36
   * UTC); and whether the page's path holds a matching item's username, as a signed-in
   * page under the account's own name does, where the list is not read (owner
   * 2026-10-12 19:45 UTC). Usernames are read one at a time here and never kept or sent
   * to the page.
   */
  async function listedNames(
    pageOrigin: string,
    scope: GenerationScope,
    texts: readonly string[],
    path: string,
  ): Promise<{ names: string[]; inPath: boolean; email: boolean }> {
    const found = new Set<string>();
    let inPath = false;
    let email = false;
    for (const { connection, itemId, fieldId } of usernameReads(scope)) {
      let value: string | undefined;
      try {
        // Serial reads through the shared vault host, as for a fill.
        // eslint-disable-next-line no-await-in-loop
        value = await fields({
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
  async function listUsernames(
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
      if (
        excluded &&
        settingsValue.connections
          .find((entry) => entry.connectionId === connectionId)
          ?.excludedFields.some((field) => field.itemId === itemId && field.fieldId === fieldId)
      )
        return undefined;
      try {
        return await fields({
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
    const found = uris
      ? await runtime.siteCandidates(snapshot, live).catch(() => undefined)
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
  /** A chooser's buttons and what its readiness waits for on its list (ADR 0028). */
  const listButtons = (chooser: LoginChooserRecipe) => ({
    ...(chooser.chooser.other ? { other: chooser.chooser.other } : {}),
    ...(chooser.chooser.continue ? { continue: chooser.chooser.continue } : {}),
  });
  const listReadiness = (chooser: LoginChooserRecipe): LoginReadiness => ({
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
  async function listClick(
    snapshot: Extract<SettingsResponse, { ok: true }>,
    live: LiveDocument,
    chooser: LoginChooserRecipe,
    chosen: { connectionId: string; itemId: string },
  ): Promise<ChooserClick | ListMiss | "unreadable" | undefined> {
    const usernames = await listUsernames(snapshot, live, chosen);
    if (!usernames) return "unreadable";
    const list = { ...usernames, ...listButtons(chooser) };
    try {
      const parsed = v.safeParse(
        chooseResultSchema,
        await send(live, { type: "login.choose", path: chooser.chooser.path, list }),
      );
      if (!parsed.success || !parsed.output.ok) return undefined;
      return parsed.output.miss ?? (parsed.output.click as ChooserClick);
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
  function usernameShape(
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
  async function readUsernames(
    pageOrigin: string,
    reads: ReturnType<typeof usernameReads>,
  ): Promise<string[] | undefined> {
    const usernames: string[] = [];
    for (const { connection, itemId, fieldId } of reads) {
      let value: string | undefined;
      try {
        // Serial reads through the shared vault host, as for a fill.
        // eslint-disable-next-line no-await-in-loop
        value = await fields({
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
   * where it cannot be hidden. The usernames are dropped once it is built.
   */
  function hideUsernames(
    observation: LoginObservation,
    usernames: string[] | undefined,
  ): { observation: LoginObservation } | { reason: string } {
    if (!usernames) return { reason: "username-unread" };
    const hidden = withoutUsernames(observation, usernames);
    usernames.fill("");
    return hidden.ok ? { observation: hidden.observation } : { reason: hidden.reason };
  }
  /**
   * The custom-field slots with the shapes their fields share (ADR 0027): only for Text
   * fields and Linked fields that read the username or a Text field, never for Hidden
   * fields or the password, and within a bound on the values read per request.
   */
  async function customSlots(pageOrigin: string, scope: GenerationScope) {
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
        shape = await sharedShape(pageOrigin, scope, reads);
      }
      slots.push(shape ? { ...offer.slot, valueShape: shape } : offer.slot);
    }
    return slots;
  }
  /** Logs once per document and reason why it was not sent for generation. */
  function skipGeneration(
    live: LiveDocument,
    reason: string,
    page?: "entry",
    /** A code that tells more, such as why a vault could not tell (ADR 0019). */
    detail?: string,
  ): void {
    if (live.generationSkip === reason) return;
    live.generationSkip = reason;
    report(live.document, {
      type: "generation",
      tabId: live.document.tabId,
      origin: live.document.origin,
      outcome: "skipped",
      reason,
      ...(page ? { page } : {}),
      ...(detail ? { detail } : {}),
    });
  }
  /**
   * Sends this page's observation for generation. A returned recipe is in the recipe
   * cache by then; the document announces again and starts it once its first step is
   * ready (ADR 0018).
   */
  async function generateFor(
    live: LiveDocument,
    scope: GenerationScope,
    /** For a list of accounts (ADR 0028): the shown texts to hide as `[account]`. */
    list?: { names: string[] },
  ): Promise<void> {
    if (!generation) return;
    const page = list ? ({ page: "accounts" } as const) : {};
    const key = frameKey(live.document);
    let sent = false;
    try {
      let observation: LoginObservation | undefined;
      // A page that renders its form in steps may offer itself before the form is whole,
      // so a page that cannot be described yet is read again (Vpass, 2026-10-12).
      for (let read = 1; ; read += 1) {
        const extracted = v.safeParse(
          extractResultSchema,
          // eslint-disable-next-line no-await-in-loop
          await send(
            live,
            list
              ? {
                  type: "login.extract",
                  page: "accounts",
                  ...(list.names.length ? { names: list.names } : {}),
                }
              : { type: "login.extract", page: "login" },
          ),
        );
        if (documents.get(key) !== live) return;
        // The content script's refusal, such as `no-locator` or `extract-error`;
        // `extract-failed` for an answer that fails its check or never came.
        let unsent =
          extracted.success && !extracted.output.ok ? extracted.output.reason : "extract-failed";
        // Why a described page is not sent, for the log (ADR 0019).
        let detail: string | undefined;
        if (extracted.success && extracted.output.ok) {
          // An incomplete observation is not sent (ADR 0016). A list is sent as one, and
          // only a page announced as one is.
          const accepted = acceptedObservation(extracted.output, {
            origin: live.document.origin,
            path: live.path,
            list: list !== undefined,
          });
          if ("observation" in accepted) {
            observation = accepted.observation;
            break;
          }
          unsent = "incomplete-observation";
          detail = accepted.detail;
        }
        if (unsent === "cancelled" || read >= EXTRACT_READS) {
          skipGeneration(live, unsent, undefined, detail);
          return;
        }
        // eslint-disable-next-line no-await-in-loop
        await new Promise((resolve) => setTimeout(resolve, EXTRACT_RETRY_MS));
        if (documents.get(key) !== live) return;
      }
      const usernames = await readUsernames(live.document.origin, usernameReads(scope));
      const shape = usernames && usernameShape(scope, usernames);
      // The account's own usernames never reach the service.
      const hidden = hideUsernames(observation, usernames);
      if (documents.get(key) !== live) return;
      if ("reason" in hidden) {
        skipGeneration(live, hidden.reason);
        return;
      }
      const custom = await customSlots(live.document.origin, scope);
      if (documents.get(key) !== live) return;
      const spin = spinning(live.document.tabId);
      const result = await generation
        .generate(
          {
            version: 1,
            observation: hidden.observation,
            slots: [
              ...scope.slots.map((slot) =>
                slot.id === "username" && shape ? { ...slot, valueShape: shape } : slot,
              ),
              ...custom,
            ],
          },
          spin.sent(() =>
            report(live.document, {
              type: "generation",
              tabId: live.document.tabId,
              origin: live.document.origin,
              outcome: "sent",
              ...page,
            }),
          ),
        )
        .finally(spin.stop)
        .catch((): GenerationOutcome => ({ outcome: "failed", reason: "error" }));
      sent = true;
      report(live.document, {
        type: "generation",
        tabId: live.document.tabId,
        origin: live.document.origin,
        ...outcomeFields(result),
        ...page,
      });
      if (result.outcome !== "recipe") return;
      // Every tab's page still tracked on this origin and path that holds no login announces
      // again and starts the recipe: this document, and one refused for want of a recipe
      // while the request was in flight, such as a page that replaced this one or the same
      // page in another tab.
      const pages = [...documents.values()].filter((other) => {
        const running = runtime.tabAttempt(other.document.tabId);
        return (
          other.document.frameId === 0 &&
          other.document.origin === live.document.origin &&
          other.path === live.path &&
          attempts.get(other.document.tabId)?.live !== other &&
          !(running && !terminal(running))
        );
      });
      await Promise.all(
        pages.map(async (other) => {
          try {
            await browser.tabs.sendMessage(
              other.document.tabId,
              { version: 1, type: "login.reconnect" },
              { documentId: other.document.documentId, frameId: other.document.frameId },
            );
          } catch {
            // The page starts nothing until it announces again (ADR 0019). A tab that no
            // longer shows it has moved on, which is not worth more than a debug line.
            if (documents.get(frameKey(other.document)) !== other) return;
            const tab = await browser.tabs.get(other.document.tabId).catch(() => undefined);
            const url = tab?.url ? new URL(tab.url) : undefined;
            const shown = url?.origin === other.document.origin && url.pathname === other.path;
            runtime.note(other.document, other.url, "reconnect-failed", undefined, !shown);
          }
        }),
      );
    } catch (error) {
      // The document went away or did not answer (`unreachable`, with how), or reading the
      // vault threw; nothing was started. Only a page still tracked is worth the reason
      // (ADR 0019).
      if (!sent && documents.get(key) === live)
        if (error instanceof DocumentGone)
          skipGeneration(live, "unreachable", undefined, error.reason);
        else skipGeneration(live, "exception");
    }
  }
  /**
   * After a refusal because no vault item matches, a vault check may bring the item from
   * another device. Once a check applied a new snapshot in time, only the refused document
   * is asked to announce again, and only while it is still that refused document.
   */
  function retryAfterSync(live: LiveDocument, reason: string): void {
    // A document replaced while the refusal was published could never be reconnected.
    if (documents.get(frameKey(live.document)) !== live) return;
    let synced: Promise<boolean> | undefined;
    try {
      synced = options.vault?.checkAfterMiss?.();
    } catch {
      return;
    }
    void synced
      ?.then(async (applied) => {
        if (
          !applied ||
          documents.get(frameKey(live.document)) !== live ||
          live.state !== "denied" ||
          live.reason !== reason
        )
          return undefined;
        await browser.tabs.sendMessage(
          live.document.tabId,
          { version: 1, type: "login.reconnect" },
          { frameId: live.document.frameId, documentId: live.document.documentId },
        );
        return undefined;
      })
      .catch(() => undefined);
  }
  return {
    listReadiness,
    generationSlotsFor,
    usernameReads,
    readUsernames,
    hideUsernames,
    usernameShape,
    customSlots,
    listUsernames,
    listButtons,
    startsFor,
    offersGeneration,
    skipGeneration,
    listedNames,
    generateFor,
    retryAfterSync,
    listClick,
  };
}
