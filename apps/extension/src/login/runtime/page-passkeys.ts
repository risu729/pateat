import {
  nextLoginOperation,
  passkeyAnswersRequest,
  routeSteps,
  sameLoginDocument,
  validateLoginOperation,
  type LoginDocument,
} from "@pateat/contracts";
import type { ConditionalDecision, PasskeyItem } from "../../passkeys/runtime";
import { newId } from "@pateat/contracts/ids";
import {
  choiceKey,
  type ChoicePasskeys,
  type Execution,
  frameKey,
  idle,
  type ParkedRequest,
  type PendingChoice,
  recordKey,
  REQUEST_PARK_MS,
  REQUEST_START_WAIT_MS,
  REQUEST_WAIT_MS,
  terminal,
} from "./model";
import type { RuntimeContext } from "./context";
import type { RuntimeState } from "./state";

/**
 * A page's own conditional passkey requests (ADR 0034): parking them while a login or a
 * popup choice may answer them, and answering them with the login's item.
 */
export function createPagePasskeys(shared: RuntimeState) {
  const runtime = shared as RuntimeContext;
  const {
    parkedRequests,
    attempts,
    pending,
    picked,
    logouts,
    stoppedAsks,
    choicePasskeys,
    options,
    documents,
    effects,
    passkeyAnswers,
  } = shared;
  let reviewTimer: ReturnType<typeof setInterval> | undefined;
  /** The newest conditional request of a top document still waiting (ADR 0034). */
  function parkedFor(document: { tabId: number; documentId: string }): ParkedRequest | undefined {
    let found: ParkedRequest | undefined;
    for (const parked of parkedRequests)
      if (parked.tabId === document.tabId && parked.documentId === document.documentId)
        found = parked;
    return found;
  }
  /**
   * A top document's own `conditional` passkey request (ADR 0034). It waits for the login
   * of its document: that login's `passkey` route answers it; once the login ends, it is
   * withheld if the login signed in and handed on otherwise. While the tab asks for an
   * account after a logout, or offers its document a popup choice in which an item holds a
   * discoverable passkey, the login the pick starts answers it. A request of an origin
   * without a recipe is handed on at once, and one whose document starts no login within
   * `REQUEST_START_WAIT_MS` then.
   */
  async function conditionalRequest(input: {
    tabId: number;
    origin: string;
    documentId: string;
    signal: AbortSignal;
  }): Promise<ConditionalDecision> {
    await runtime.loaded;
    await runtime.sessionLoaded;
    const run = attempts.get(input.tabId);
    if (run?.live.document.documentId !== input.documentId) {
      const starts = await runtime.startsFor(input.origin).catch(() => []);
      if (!starts.length) return { kind: "delegate", reason: "no-recipe" };
    }
    if (input.signal.aborted) return { kind: "delegate", reason: "cancelled" };
    return new Promise<ConditionalDecision>((resolve) => {
      const onAbort = () => parked.settle({ kind: "delegate", reason: "cancelled" });
      const parked: ParkedRequest = {
        tabId: input.tabId,
        origin: input.origin,
        documentId: input.documentId,
        since: Date.now(),
        settle(decision) {
          if (!parkedRequests.delete(parked)) return false;
          input.signal.removeEventListener("abort", onAbort);
          resolve(decision);
          return true;
        },
      };
      parkedRequests.add(parked);
      input.signal.addEventListener("abort", onAbort, { once: true });
      reviewRequests();
    });
  }
  /**
   * Whether the tab asks the request's document for an account after a logout (ADR 0021 D):
   * its choice waits in the popup, or the pick of a document asked so has not started a
   * login yet.
   */
  function askedFor(parked: ParkedRequest): boolean {
    const waiting = pending.get(parked.tabId);
    const pick = picked.get(parked.tabId);
    return (
      (waiting?.logout !== undefined &&
        waiting.document.frameId === 0 &&
        waiting.document.documentId === parked.documentId) ||
      (parked.asked === true &&
        pick !== undefined &&
        pick.attemptId === undefined &&
        pick.origin === parked.origin &&
        pick.documentId === parked.documentId)
    );
  }
  /** Whether a tab still asks for an account of the origin after a logout (ADR 0021 D). */
  function asksAfterLogout(tabId: number, siteOrigin: string): boolean {
    const key = recordKey(tabId, siteOrigin);
    return (
      !runtime.recordFor(tabId, siteOrigin) &&
      (logouts.has(key) || stoppedAsks.has(key) || runtime.askedElsewhere(tabId, siteOrigin))
    );
  }
  /**
   * Records the popup choice a refused top document was offered, and whether the page's own
   * conditional request may wait for its pick: only outside a logout, on a recipe without a
   * passkey button (ADR 0034). The same choice offered again keeps its check.
   */
  function noteChoice(
    document: LoginDocument,
    candidates: PendingChoice["candidates"],
    applies: boolean,
  ): void {
    if (!applies) {
      choicePasskeys.delete(document.tabId);
      return;
    }
    const key = choiceKey({ document, candidates });
    const known = choicePasskeys.get(document.tabId);
    // The same choice offered again keeps a passkey found or a check running; one that found
    // none, as with a locked vault, or that a default ended, is checked again.
    if (known?.key !== key || known.defaulted || (!known.checking && known.holds !== true))
      choicePasskeys.set(document.tabId, { key, documentId: document.documentId });
    // A request already waiting has its choice checked at once.
    if (parkedFor(document)) reviewRequests();
  }
  /**
   * Looks up once whether an item of a popup choice holds a discoverable, usable passkey
   * (ADR 0034), holding vault replacement off meanwhile. A locked vault, a search that
   * could not finish or a failed lookup count as none.
   */
  function checkChoice(entry: ChoicePasskeys, waiting: PendingChoice): void {
    if (entry.checking || entry.holds !== undefined) return;
    const lookup = options.passkeyItems;
    if (!lookup) {
      entry.holds = false;
      return;
    }
    entry.checking = true;
    void (async () => {
      // A default saved before the choice was noted ends it too.
      await runtime.choiceDefaults();
      let held: readonly PasskeyItem[] = [];
      const leave = await options.vault?.enter(false).catch(() => undefined);
      try {
        held = await lookup(waiting.document.origin);
      } catch {
        held = [];
      } finally {
        leave?.();
      }
      entry.holds = waiting.candidates.some((candidate) =>
        held.some(
          (item) =>
            item.connectionId === candidate.connectionId && item.itemId === candidate.itemId,
        ),
      );
      delete entry.checking;
      reviewRequests();
    })();
  }
  /**
   * Whether the request's document waits for a pick in a popup choice outside a logout
   * (ADR 0034): `waits` while that choice is offered and one of its items holds a
   * discoverable passkey, or while its pick has not started a login yet; `checking` while
   * the choice's items are looked up, which starts the lookup once per choice.
   */
  function choiceWaits(parked: ParkedRequest): "waits" | "checking" | "none" {
    const waiting = pending.get(parked.tabId);
    const entry = choicePasskeys.get(parked.tabId);
    // As the popup sees it: a document that announced again and started a login, or
    // another document of the frame, no longer offers it.
    const live = waiting && documents.get(frameKey(waiting.document));
    if (
      waiting &&
      entry &&
      !waiting.logout &&
      !entry.defaulted &&
      waiting.document.frameId === 0 &&
      waiting.document.documentId === parked.documentId &&
      waiting.document.origin === parked.origin &&
      entry.key === choiceKey(waiting) &&
      (!live || sameLoginDocument(live.document, waiting.document)) &&
      runtime.recordFor(parked.tabId, parked.origin) === undefined
    ) {
      checkChoice(entry, waiting);
      if (entry.holds === undefined) return "checking";
      if (entry.holds) return "waits";
    }
    // The pick clears the choice; until its login starts, the request waits for it too.
    const pick = picked.get(parked.tabId);
    if (
      pick === undefined ||
      pick.attemptId !== undefined ||
      pick.origin !== parked.origin ||
      pick.documentId !== parked.documentId
    )
      return "none";
    if (parked.picking) return "waits";
    // Picked while its choice was still being checked.
    if (entry?.documentId !== parked.documentId || entry.defaulted) return "none";
    if (entry.checking) return "checking";
    return entry.holds ? "waits" : "none";
  }
  /**
   * Decides every waiting conditional request whose login ended or never started, and
   * checks again each second while one waits (ADR 0034). The `passkey` route answers its
   * own page's request itself. A request whose document the tab asks for an account after
   * a logout, or fills only, waits for the login the pick starts; so does one whose
   * document is offered a popup choice in which an item holds a passkey, for up to four
   * minutes.
   */
  function reviewRequests(): void {
    const now = Date.now();
    for (const parked of [...parkedRequests]) {
      const run = attempts.get(parked.tabId);
      const own =
        run &&
        run.live.document.frameId === 0 &&
        run.live.document.documentId === parked.documentId &&
        run.metadata.account.origin === parked.origin
          ? run.metadata
          : undefined;
      const ended = own && (terminal(own) || idle(own));
      const running = own !== undefined && !ended;
      if (running) parked.during = true;
      const offered = !running && askedFor(parked);
      if (offered) delete parked.dropped;
      if (running ? own.fillOnly : offered) parked.asked = true;
      // A choice still offered decides alone: another tab's login can end the logout this
      // tab asks for, while its choice stays. A dropped pick leaves it a moment to be
      // offered again.
      const asks = running
        ? own.fillOnly === true
        : offered ||
          (parked.asked === true &&
            asksAfterLogout(parked.tabId, parked.origin) &&
            (parked.dropped === undefined || now - parked.dropped < REQUEST_START_WAIT_MS));
      // A popup choice outside a logout keeps the request while it offers an item with a
      // passkey, or while that is being checked. Once the choice goes, the request waits a
      // moment for it to be offered again. A login of its document, once seen, decides.
      const free = !parked.during && !asks;
      const choice = free ? choiceWaits(parked) : "none";
      if (choice === "waits") {
        parked.picking = true;
        delete parked.dropped;
      } else if (free && parked.picking && parked.dropped === undefined) parked.dropped = now;
      const choosing =
        free &&
        (choice !== "none" ||
          (parked.picking === true &&
            parked.dropped !== undefined &&
            now - parked.dropped < REQUEST_START_WAIT_MS));
      if (asks) {
        if (now - parked.since >= REQUEST_PARK_MS) parked.settle({ kind: "withhold" });
      } else if (choosing) {
        // Handed on, not withheld: the browser ends the message that carries it after five
        // minutes, so there is time to.
        if (now - parked.since >= REQUEST_PARK_MS)
          parked.settle({ kind: "delegate", reason: "no-pick" });
      } else if (!own || (ended && !parked.during)) {
        // A login of another document, or one that ended before the request came, does
        // not decide it.
        if (now - parked.since >= REQUEST_START_WAIT_MS)
          parked.settle({ kind: "delegate", reason: own ? "login-ended" : "no-login" });
      } else if (own.state === "authenticated") parked.settle({ kind: "withhold" });
      else if (ended) parked.settle({ kind: "delegate", reason: "login-ended" });
      else if (now - parked.since >= REQUEST_PARK_MS) parked.settle({ kind: "withhold" });
    }
    if (parkedRequests.size && reviewTimer === undefined)
      reviewTimer = setInterval(reviewRequests, 1000);
    else if (!parkedRequests.size && reviewTimer !== undefined) {
      clearInterval(reviewTimer);
      reviewTimer = undefined;
    }
  }
  /**
   * Whether a login takes the `passkey` route because its page asked for a passkey by
   * itself (ADR 0034): only before anything was submitted, so a chooser login only before
   * its click on the list, on a recipe without a passkey
   * button, for an item that held a discoverable passkey when the login started. Fields
   * already filled stay as they are.
   */
  async function switchToPasskey(run: Execution): Promise<boolean> {
    const { metadata } = run;
    if (
      metadata.route !== "password" ||
      !passkeyAnswersRequest(run.recipe) ||
      run.passkeyFailed ||
      metadata.fillOnly ||
      !metadata.facts.discoverablePasskey ||
      metadata.submissions > 0 ||
      metadata.handlers.length > 0 ||
      metadata.operationId !== undefined ||
      !parkedFor(run.live.document)
    )
      return false;
    await runtime.change(
      run,
      {
        type: "ROUTE",
        route: "passkey",
        steps: routeSteps(run.recipe, { route: "passkey" }).length,
      },
      undefined,
      undefined,
      "page-request",
    );
    return runtime.current(run) && run.metadata.route === "passkey";
  }
  /**
   * The `passkey` route's one step on a recipe without a passkey button (ADR 0034): the
   * page's own conditional request is answered with the login's item. The answer counts as
   * a submission, recorded before it goes out. Without a request, or when the item cannot
   * answer it, the login falls back to its password variant.
   */
  async function answerRequest(run: Execution): Promise<void> {
    const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
    let parked = parkedFor(run.live.document);
    // A page may cancel its request and ask again, as when its form renders once more.
    for (const until = Date.now() + REQUEST_WAIT_MS; !parked && Date.now() < until;) {
      // eslint-disable-next-line no-await-in-loop
      await sleep(100);
      if (!runtime.current(run) || run.metadata.state !== "ready") return;
      parked = parkedFor(run.live.document);
    }
    if (!parked) {
      await runtime.fallBack(run, "request-missing");
      return;
    }
    if (!(await runtime.allowed(run))) return;
    const operation = nextLoginOperation(run.metadata, run.recipe, run.live.document, newId());
    if (!operation) {
      await runtime.change(
        run,
        { type: "FAILED", reason: "structural-mismatch" },
        undefined,
        "no-operation",
      );
      return;
    }
    run.operation = operation;
    run.delivered = false;
    await runtime.change(run, {
      type: "PREPARE",
      operationId: operation.operationId,
      kind: "click",
      effect: "submit",
    });
    await runtime.change(run, { type: "SUBMIT_INTENT", operationId: operation.operationId });
    if (!runtime.current(run) || run.metadata.state !== "submit-intent") return;
    const authorized = await runtime.allowed(run);
    if (!authorized) return;
    if (
      !validateLoginOperation(
        operation,
        run.metadata,
        run.live.document,
        run.metadata.policyRevision,
      )
    ) {
      await runtime.change(
        run,
        { type: "FAILED", reason: "timeout" },
        undefined,
        "operation-invalid",
      );
      return;
    }
    const { tabId } = run.live.document;
    run.delivered = true;
    effects.set(tabId, {
      attemptId: run.metadata.id,
      at: Date.now(),
      document: run.live.document,
      submits: false,
      passkey: true,
    });
    const item = {
      connectionId: run.metadata.account.connectionId,
      itemId: run.metadata.account.itemId,
    };
    const target = parked;
    // The bridge says whether the assertion went back; a request that went away meanwhile
    // was never answered.
    let gone = false;
    const signed = await new Promise<boolean>((resolve) => {
      gone = !target.settle({ kind: "answer", item, answered: resolve });
      if (gone) resolve(false);
    });
    delete run.operation;
    if (!runtime.current(run) || run.metadata.state !== "submit-intent") return;
    if (signed) {
      run.answeredAt = Date.now();
      await runtime.change(run, { type: "SUBMITTED", operationId: operation.operationId });
      // A WebAuthn exchange is observed with the usual budget, held while the form shows.
      await runtime.reconcileBounded(run);
      return;
    }
    run.passkeyFailed = true;
    await runtime.change(
      run,
      {
        type: "FAILED",
        reason: "timeout",
        mutation: "none",
        operationId: operation.operationId,
        document: run.live.document,
      },
      undefined,
      gone ? undefined : "answer-failed",
    );
    // A request that went away before the answer was never answered.
    await runtime.fallBack(run, gone ? "request-missing" : "answer-failed");
  }
  /**
   * When the passkey bridge last returned an assertion to the login's page since its last
   * effect step (ADR 0027), if it did: a request that showed a prompt, answered with the
   * login's item.
   */
  function bridgeAnswer(run: Execution): number | undefined {
    const { tabId, origin: pageOrigin } = run.live.document;
    const answer = passkeyAnswers.get(`${tabId} ${pageOrigin}`);
    const effect = effects.get(tabId);
    return answer && effect?.attemptId === run.metadata.id && answer.at >= effect.at
      ? answer.at
      : undefined;
  }
  return {
    reviewRequests,
    parkedFor,
    bridgeAnswer,
    switchToPasskey,
    answerRequest,
    noteChoice,
    conditionalRequest,
  };
}
