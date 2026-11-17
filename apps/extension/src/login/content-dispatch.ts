import * as v from "valibot";
import { ssoBridged } from "./content-sso-bridge";
import { browser } from "wxt/browser";
import { formAccounts, showsOtherAccount } from "../page/accounts";
import { findLogoutTargets, safeLogoutControl, shownLayers } from "../page/logout-controls";
import { pressElement } from "../page/script-url-click";
import { formOf, readingPage } from "../page/shadow";
import { keyable, targetCheck, targetState, writable } from "../page/target-state";
import { identifierInput } from "../page/identifier-field";
import { findKeypad, keypadField } from "../page/keypad";
import { visible } from "../page/code-submission";
import {
  clickDestinations,
  formDestinations,
  submitterDestinations,
} from "../page/form-destination";
import { nextFrame } from "../page/frames";
import { pageChange } from "../page/page-change";
import { awaitFillChange } from "./sign-in-fill-page";
import { documentLoaded, navigationStatus } from "../page/document-load";
import { settled } from "../page/quiet";
import {
  extractAccountListObservation,
  extractEntryObservation,
  extractLocalLogout,
  extractLogoutObservation,
  extractLoginObservation,
  extractPasskeyObservation,
  extractSignedInObservation,
  fieldsMissDetail,
} from "../observation/extract";
import { listChoice } from "../page/account-list";
import { listedAccounts, listsAccounts, logOnly } from "./no-input-offer";
import { entryElementRefusal, entryHosts, showsSignUp } from "../page/entry";
import { pageSigns } from "../page/sign-in-state";
import { sendMessage } from "../messaging/protocol";
import { acceptsSecret, maskedSecret } from "./inputs";
import { chooseFor } from "../page/choice-radio";
import { askedQuestion } from "../page/question";
import { cardHints } from "../page/card-hints";
import { siteValueChoice, stopSiteValues } from "../page/site-values";
import { commandSchema, LOGIN_STEP_WAIT_MS, reconnectSchema } from "./wire";
import type { ContentSession } from "./content-session";
import {
  accountQuietMs,
  accountWaitMs,
  ready,
  pagePath,
  matches,
  takes,
  type Control,
  stillAsks,
  fitsControl,
  isOnly,
  enter,
  showsSignIn,
  revealsPassword,
  readinessMiss,
  checkGapMs,
  pause,
  credentialInputs,
} from "./content-dom";
import { executeNative } from "./content-execute";
import { codePageDigest } from "../page/code-page";

/** Answers the worker's commands for this document. */
export function createContentListener(context: ContentSession) {
  /**
   * After an account switch this document may change in place, as a single-page app shows
   * its form for another account (Duolingo, 2026-10-23): once it has settled, it is
   * announced as a new page, so a recipe that starts there starts a new attempt and a page
   * without one may be offered for generation once more (ADR 0078). Only a page that
   * no longer shows the switch changed in place: one that still does is waiting for the
   * next document, which announces itself.
   */
  async function switchedInPlace(element: HTMLElement): Promise<void> {
    await settled(document, accountQuietMs, Date.now() + accountWaitMs);
    if (context.cancelled || (element.isConnected && visible(element))) return;
    context.ended = false;
    context.announced = false;
    context.retries = 0;
    context.offered = false;
    // The new page's window offers its input; a late look would offer it twice.
    context.lateWatch?.();
    void context.announce(false, false, undefined, false, true).catch(() => undefined);
  }
  const listener: Parameters<typeof browser.runtime.onMessage.addListener>[0] = (
    message,
    sender,
    respond,
  ) => {
    if (sender.id !== browser.runtime.id || sender.tab) return false;
    const reconnect = v.safeParse(reconnectSchema, message);
    if (reconnect.success) {
      // A default chosen for this tab (ADR 0021, amended 2026-11-04): the page counts as
      // a new one, so its form, also one shown only after a click, is offered once more.
      const fresh = reconnect.output.fresh === true && !context.cancelled;
      if (fresh) {
        context.ended = false;
        context.announced = false;
        context.retries = 0;
        context.offered = false;
        context.entryOffered = false;
        context.offeredPaths.clear();
        context.lateWatch?.();
        // The answer opens the window again; until then nothing is offered.
        context.generate = false;
        context.clearOffer();
        context.urlWatch?.();
      }
      // A restarted worker forgot earlier refusals; a ready form may start again. A fresh
      // announcement, like one after a URL change, keeps a login the document carries.
      void context
        .announce(context.starts.some(ready), false, undefined, false, false, fresh)
        .then(respond, () => respond({ ok: false }));
      return true;
    }
    const parsed = v.safeParse(commandSchema, message);
    if (!parsed.success || parsed.output.token !== context.token) return false;
    const command = parsed.output;
    if (ssoBridged(command)) return context.sso.handle(command, respond);
    if (command.type === "login.detail.question") {
      const found = context.cancelled || pagePath() !== command.path ? [] : matches(command.target);
      const input = found.length === 1 ? found[0] : undefined;
      const index = writable(input) ? askedQuestion(input, command.names) : undefined;
      respond(index === undefined ? { ok: true } : { ok: true, index });
      return false;
    }
    if (command.type === "login.detail.card") {
      // Only the hint tokens leave this handler, never the page's text (ADR 0061).
      const found = context.cancelled || pagePath() !== command.path ? [] : matches(command.target);
      const input = found.length === 1 ? found[0] : undefined;
      respond(
        writable(input)
          ? { ok: true, ...cardHints(input, document.title) }
          : { ok: true, last4: [], brands: [] },
      );
      return false;
    }
    if (command.type === "login.detail.fill") {
      // The popup's fill of a personal detail (ADR 0061): its input, or every input of a
      // split value, each checked before any is filled, a radio first, and nothing
      // pressed. The values and the username never leave this handler.
      // What the page sets in its inputs from now on may be Pateat's own filling.
      stopSiteValues(window);
      const fields = command.fields.map((field) => ({ ...field }));
      for (const field of command.fields) field.value = "";
      const username = command.account?.username;
      if (command.account) command.account.username = "";
      const clear = () => {
        for (const field of fields) field.value = "";
      };
      void (async () => {
        const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
        const controls = fields.map((field) => {
          const found = matches(field.target);
          return found.length === 1 ? found[0] : undefined;
        });
        const usable = (control: Element | undefined, field: (typeof fields)[number]) =>
          takes(control, field.secret) &&
          acceptsSecret(control as Control, field.secret) &&
          stillAsks(control as Control, field.question) &&
          fitsControl(control as Control, field);
        if (
          context.cancelled ||
          pagePath() !== command.path ||
          !setter ||
          fields.some((field, position) => !usable(controls[position], field))
        )
          return { ok: false };
        // Every part is in one form, or every part outside any form, as a login's fill
        // requires (`fields-split`).
        const form = formOf(controls[0] as Control);
        if (controls.some((control) => formOf(control as Control) !== form)) return { ok: false };
        if (new Set(controls).size !== controls.length) return { ok: false };
        // A popup fill leaves submission to the person, so check every control that can
        // submit the form too, the shown button and the default button a pressed Enter
        // uses with their overrides, before putting any value into the form (ADR 0051).
        const buttons = matches(command.submit);
        const button = buttons.length === 1 ? buttons[0] : undefined;
        if (!button || targetState(document, command.submit, "shown") !== "unique")
          return { ok: false };
        const destinations = () => [
          ...controls.flatMap((control) => formDestinations(control as Control, "fill")),
          ...submitterDestinations(controls as Control[]),
          ...clickDestinations(button),
        ];
        const before = destinations();
        if (before.some((entry) => entry.kind === "refused")) return { ok: false };
        const unchanged = () =>
          !context.cancelled &&
          command.origin === self.origin &&
          pagePath() === command.path &&
          Date.now() < command.expiresAt &&
          isOnly(matches(command.submit), button) &&
          targetState(document, command.submit, "shown") === "unique" &&
          fields.every(
            (field, position) =>
              isOnly(matches(field.target), controls[position]!) &&
              usable(controls[position], field) &&
              formOf(controls[position] as Control) === form,
          ) &&
          JSON.stringify(destinations()) === JSON.stringify(before);
        if (!unchanged()) return { ok: false };
        const authorized: unknown = await sendMessage("login", {
          version: 1,
          type: "login.detail.authorize",
          token: context.token,
          fillId: command.fillId,
          destinations: [
            ...new Set(
              before.flatMap((entry) => (entry.kind === "other-origin" ? [entry.url] : [])),
            ),
          ],
        }).catch(() => undefined);
        if (authorized !== true || !unchanged()) return { ok: false };
        // A value goes only to the login item's account when the page shows one, as a
        // login's fill does (owner decision, 2026-10-11).
        if (
          username !== undefined &&
          showsOtherAccount(formAccounts(document, form), username, {
            masked: fields.some((field) => maskedSecret(field.secret)),
          })
        )
          return { ok: false, reason: "other-account" };
        for (const [position, field] of fields.entries()) {
          const control = controls[position] as Control;
          // The page's handlers for the previous input run first.
          // eslint-disable-next-line no-await-in-loop
          if (position > 0) await nextFrame();
          // The radio's click may change the input, so its checks run again.
          if (!unchanged() || !chooseFor(control) || !unchanged()) return { ok: false };
          // eslint-disable-next-line no-await-in-loop
          const stopped = await enter(control, field, setter, {
            between: () => (!unchanged() ? "field-changed" : undefined),
          });
          if (stopped !== undefined || !unchanged()) return { ok: false };
        }
        return { ok: true };
      })()
        .finally(clear)
        .then(respond, () => respond({ ok: false }));
      return true;
    }
    if (command.type === "login.cancel") {
      context.cancelled = true;
      context.lateWatch?.();
      context.describedWatch?.abort();
      context.codeWatch?.abort();
      if (context.deferredAccount) context.deferredAccount.username = "";
      context.deferredAccount = undefined;
      context.waits.abort();
      context.unwatch();
      context.followConfirmPath(undefined);
      respond({ ok: true });
      return false;
    }
    if (command.type === "login.choose") {
      const choice =
        context.cancelled || pagePath() !== command.path || showsSignIn()
          ? undefined
          : listChoice(document, command.list);
      command.list.username = "";
      command.list.others.fill("");
      respond(
        !choice
          ? { ok: false }
          : choice.click === "none"
            ? { ok: true, click: "none", miss: choice.miss }
            : { ok: true, click: choice.click },
      );
      return false;
    }
    if (command.type === "login.site.account") {
      // Answered once per document, once its inputs are there to compare, so a page
      // cannot try one value after another to learn which accounts the vault holds (ADR
      // 0028 amendment of 2026-10-23).
      const inputs =
        context.siteAccountAsked || context.cancelled || pagePath() !== command.path
          ? []
          : command.targets.map((target) => {
              const found = matches(target);
              return found.length === 1 ? found[0]! : undefined;
            });
      const compared = inputs.length > 0 && inputs.every(Boolean);
      const index = compared
        ? siteValueChoice(window, inputs as Element[], command.usernames)
        : undefined;
      if (compared) context.siteAccountAsked = true;
      command.usernames.fill("");
      respond(
        index !== undefined
          ? { ok: true, index }
          : context.siteAccountAsked
            ? { ok: false, spent: true }
            : { ok: false },
      );
      return false;
    }
    if (command.type === "login.switch") {
      const pending = context.pendingSwitch;
      context.pendingSwitch = undefined;
      // The page may have changed since the fill; click only the same, still unique element.
      const click =
        !context.cancelled &&
        pending?.operationId === command.operationId &&
        Date.now() < pending.expiresAt &&
        pagePath() === pending.path &&
        isOnly(pending.find(), pending.element);
      if (!click) {
        respond({ ok: false });
        return false;
      }
      // The switch is withdrawn only when the page got no press: one the page stopped after
      // `pointerdown` may already have switched.
      const pressing = () =>
        !context.sso.cancelled(pending.attemptId) && pagePath() === pending.path;
      void pressElement(pending.element, pressing).then(
        (pressed) => {
          respond({ ok: pressed !== "missed" });
          if (pressed !== "missed") void switchedInPlace(pending.element);
          return undefined;
        },
        () => respond({ ok: true }),
      );
      return true;
    }
    if (command.type === "login.fill.change") {
      void awaitFillChange(document, command, {
        ready,
        path: pagePath,
        cancelled: () => context.cancelled,
        signal: context.waits.signal,
      }).then(respond, () => respond({ ok: false }));
      return true;
    }
    if (command.type === "login.await") {
      // Checks the current DOM serially, again at each change of the page, until the step's
      // elements are ready; never mutates.
      void (async () => {
        const until = Date.now() + command.timeoutMs;
        // Cancellation is set by the independent background message listener.
        while (!context.cancelled && !ready(command.readiness)) {
          if (command.readiness.revealed && readingPage(() => revealsPassword(command.readiness)))
            return { ok: false, reason: "revealed" };
          if (Date.now() >= until) {
            const miss = readingPage(() => readinessMiss(command.readiness));
            return { ok: false, reason: "timeout", ...(miss ? { miss } : {}) };
          }
          // eslint-disable-next-line no-await-in-loop
          await pageChange(document, until, context.waits.signal);
        }
        return context.cancelled ? { ok: false, reason: "cancelled" } : { ok: true };
      })().then(respond, () => respond({ ok: false, reason: "cancelled" }));
      return true;
    }
    if (command.type === "login.status") {
      // Pages are untrusted; only the synthetic probe fixture observes attempt status.
      if (context.probeStatus)
        window.postMessage(
          {
            type: "pateat.login.probe.status",
            status: {
              state: command.state,
              stepIndex: command.stepIndex,
              ...(command.outcome ? { outcome: command.outcome } : {}),
            },
          },
          location.origin,
        );
      respond({ ok: true });
      context.carrying = !["denied", "generating", "authenticated", "blocked"].includes(
        command.state,
      );
      // A finished login keeps watching: its first step showing again logs in again.
      // A new login in this document, as after a pick, watches for its own end.
      if (command.state === "executing") context.ended = false;
      if (!context.ended && (command.state === "authenticated" || command.state === "blocked")) {
        context.ended = true;
        // An ended login reads no page again here (ADR 0027 amendment of 2026-11-04).
        context.describedWatch?.abort();
        context.codeWatch?.abort();
        context.rejected = command.outcome === "credential-rejected";
        void context.announce(false).catch(() => undefined);
      }
      return false;
    }
    if (command.type === "login.entry.hosts") {
      respond(context.cancelled ? { ok: false } : { ok: true, hosts: entryHosts(document) });
      return false;
    }
    if (command.type === "login.entry.inspect") {
      // Checks the current DOM, again at each change of the page, until the target names one
      // shown element; never mutates.
      void (async () => {
        const until = Date.now() + command.timeoutMs;
        const find = () => matches(command.target, true);
        let found = find();
        // A link still rendering, or not shown yet, gets the step wait. Cancellation is set
        // by the independent background message listener.
        for (;;) {
          const waiting =
            found.length === 0 ||
            (found.length === 1 && entryElementRefusal(found[0]!) === "hidden");
          if (context.cancelled || Date.now() >= until || !waiting) break;
          // eslint-disable-next-line no-await-in-loop
          await pageChange(document, until, context.waits.signal);
          found = find();
        }
        if (context.cancelled) return { ok: false };
        const url = location.href;
        if (found.length > 1) return { ok: true, state: "ambiguous", url };
        if (!found.length) {
          // What shows instead, for the entry's repair (ADR 0041).
          const status = navigationStatus();
          const shows = showsSignIn()
            ? "sign-in"
            : listsAccounts(document)
              ? "accounts"
              : identifierInput(document) === "sole"
                ? "sign-in"
                : undefined;
          return {
            ok: true,
            state: "missing",
            url,
            ...(shows ? { shows } : {}),
            ...(status ? { status } : {}),
          };
        }
        const element = found[0]!;
        const refusal = entryElementRefusal(element);
        return {
          ok: true,
          state: "unique",
          url,
          ...(refusal ? { refusal } : {}),
          ...(element instanceof HTMLAnchorElement ? { href: element.href } : {}),
        };
      })().then(respond, () => respond({ ok: false }));
      return true;
    }
    if (command.type === "login.entry.press") {
      // Pressed only as the worker checked it: the same URL, one link, the same `href`.
      const found = matches(command.target, true);
      const element = found.length === 1 ? found[0] : undefined;
      const reason = context.cancelled
        ? "cancelled"
        : location.href !== command.url
          ? "page-changed"
          : !(element instanceof HTMLAnchorElement) ||
              entryElementRefusal(element) !== undefined ||
              element.href !== command.href
            ? "target-changed"
            : undefined;
      if (reason || !(element instanceof HTMLAnchorElement)) {
        respond({ ok: false, reason: reason ?? "target-changed" });
        return false;
      }
      watchPressedUrl();
      // A press the page stopped after `pointerdown` is answered as made, so the link is not
      // pressed again; one that never reached `pointerdown` did not press it.
      void pressElement(element, () => !context.cancelled && location.href === command.url).then(
        (pressed) =>
          respond(
            pressed !== "missed"
              ? { ok: true }
              : {
                  ok: false,
                  reason: context.cancelled
                    ? "cancelled"
                    : location.href === command.url
                      ? "target-changed"
                      : "page-changed",
                },
          ),
        () => respond({ ok: true }),
      );
      return true;
    }
    if (command.type === "login.logout.click") {
      // An account switch's click (ADR 0063): waits for the control to show, as a menu's
      // item does once the menu opens, then presses it as the executor presses a button.
      const url = location.href;
      void (async () => {
        const until = Date.now() + command.timeoutMs;
        const find = () =>
          findLogoutTargets(document, command.target).filter(
            (element): element is HTMLElement => element instanceof HTMLElement && visible(element),
          );
        let found = find();
        for (;;) {
          if (context.cancelled || found.length > 0 || Date.now() >= until) break;
          // eslint-disable-next-line no-await-in-loop
          await pageChange(document, until, context.waits.signal);
          found = find();
        }
        if (context.cancelled) return { ok: false, reason: "cancelled" };
        if (location.href !== url) return { ok: false, reason: "page-changed" };
        if (found.length !== 1)
          return { ok: false, reason: found.length ? "ambiguous" : "missing" };
        const control = found[0]!;
        // A control that logs out everywhere or ends the account is never pressed, whoever
        // named it: a stored recipe, the model or the control's words (ADR 0063).
        if (!safeLogoutControl(control, command.purpose)) return { ok: false, reason: "unsafe" };
        const before = shownLayers(document);
        const pressed = await pressElement(
          control,
          () => !context.cancelled && location.href === url,
        );
        if (pressed === "missed")
          return { ok: false, reason: context.cancelled ? "cancelled" : "page-changed" };
        if (command.watchMs === undefined) return { ok: true };
        // How the page reacts to a control found by its words (ADR 0063): a page that
        // navigates away ends this script, which the worker reads as navigated.
        const watchUntil = Date.now() + command.watchMs;
        for (;;) {
          if (context.cancelled) return { ok: false, reason: "cancelled" };
          if (location.href !== url) return { ok: true, reacted: "navigated" };
          if (shownLayers(document) > before) return { ok: true, reacted: "dialog" };
          if (!control.isConnected || !visible(control)) return { ok: true, reacted: "changed" };
          if (Date.now() >= watchUntil) return { ok: true, reacted: "none" };
          // eslint-disable-next-line no-await-in-loop
          await pageChange(document, watchUntil, context.waits.signal);
        }
      })().then(respond, () => respond({ ok: false, reason: "missing" }));
      return true;
    }
    if (command.type === "login.logout.local") {
      try {
        const onSite = new Set(command.onSite);
        respond(extractLocalLogout(document, (url) => onSite.has(url.hostname)));
      } catch {
        respond({ ok: false, reason: "none" });
      }
      return true;
    }
    if (command.type === "login.entry.check") {
      // The page after an entry press: checks, again at each change of the page, until a
      // sign-in input, an input that asks for an account identifier alone (ADR 0016), or a
      // first step shows.
      void (async () => {
        const until = Date.now() + command.timeoutMs;
        for (;;) {
          if (context.cancelled) return { ok: false };
          const signIn = showsSignIn() || identifierInput(document) !== undefined;
          const start = command.starts.some(ready);
          if (signIn || start || Date.now() >= until) {
            const list = signIn ? undefined : listedAccounts(document);
            return {
              ok: true,
              signIn,
              start,
              signUp: showsSignUp(document),
              ...(list && !logOnly(list)
                ? {
                    list: {
                      ...(list.names ? { names: list.names } : {}),
                      ...(list.other ? { other: list.other } : {}),
                    },
                  }
                : {}),
            };
          }
          // eslint-disable-next-line no-await-in-loop
          await pageChange(document, until, context.waits.signal);
        }
      })().then(respond, () => respond({ ok: false }));
      return true;
    }
    if (command.type === "login.extract") {
      if (context.cancelled) {
        respond({ ok: false, reason: "cancelled" });
        return false;
      }
      // A page to send goes only from a frame that shows in the tab's page (ADR 0086).
      if (command.shown && !context.inTab.shown()) {
        respond({ ok: false, reason: "frame-hidden" });
        return false;
      }
      let result: unknown;
      try {
        const onSite = new Set(command.onSite ?? []);
        result =
          command.page === "passkey"
            ? extractPasskeyObservation(document)
            : command.page === "login"
              ? extractLoginObservation(document, command.known)
              : command.page === "accounts"
                ? extractAccountListObservation(document, command.names)
                : command.page === "entry"
                  ? extractEntryObservation(document, (url) => onSite.has(url.hostname))
                  : command.page === "logout"
                    ? extractLogoutObservation(document)
                    : extractSignedInObservation();
        // A page described without a field says why, for the log (ADR 0019).
        if (
          command.page !== "entry" &&
          command.page !== "signed-in" &&
          command.page !== "logout" &&
          (result as { reason?: unknown }).reason === "no-candidates"
        )
          result = {
            ok: false,
            reason: "no-candidates",
            detail: fieldsMissDetail(document).slice(0, 64),
          };
      } catch {
        // A page the extractor cannot read still gets an answer the log can name.
        result = { ok: false, reason: "extract-error" };
      }
      respond(result);
      return false;
    }
    if (command.type === "login.extract.watch") {
      // Reads the page at once and again at each change of it (ADR 0082), at most once per
      // `checkGapMs` as the page watch does, until a page after the sign-in would describe
      // something there; then says so once (ADR 0027 amendment of 2026-11-04).
      context.describedWatch?.abort();
      const watching = new AbortController();
      context.describedWatch = watching;
      const until = Date.now() + command.timeoutMs;
      const stopped = () => context.cancelled || watching.signal.aborted;
      void (async () => {
        // Each reading waits for the change before it, as the other waits here do.
        /* eslint-disable no-await-in-loop */
        for (;;) {
          if (stopped()) return;
          const checked = Date.now();
          let empty = true;
          try {
            const result = extractSignedInObservation(document) as { reason?: unknown };
            empty = result.reason === "no-candidates";
          } catch {
            // A page the extractor cannot read is not reported.
          }
          if (stopped()) return;
          if (!empty) {
            await sendMessage("login", {
              version: 1,
              type: "login.document.described",
              token: context.token,
            });
            return;
          }
          if (Date.now() >= until) return;
          await pageChange(document, until, watching.signal);
          const gap = checked + checkGapMs - Date.now();
          if (gap > 0 && !stopped()) await pause(gap);
        }
        /* eslint-enable no-await-in-loop */
      })()
        .catch(() => undefined)
        .finally(() => {
          if (context.describedWatch === watching) context.describedWatch = undefined;
        });
      respond({ ok: true });
      return false;
    }
    if (command.type === "login.code.watch") {
      // Answers the code field's digest now, then reads it again at each change of the page
      // (ADR 0082), at most once per `checkGapMs`, until it differs from the baseline; then
      // says so once (ADR 0027 amendment of 2026-11-17).
      context.codeWatch?.abort();
      const watching = new AbortController();
      context.codeWatch = watching;
      const until = Date.now() + command.timeoutMs;
      const stopped = () => context.cancelled || watching.signal.aborted;
      void (async () => {
        const now = await codePageDigest(document);
        respond({ ok: true, digest: now });
        const baseline = command.baseline ?? now;
        /* eslint-disable no-await-in-loop */
        for (let digest = now; ; digest = await codePageDigest(document)) {
          if (stopped()) return;
          if (digest !== baseline) {
            await sendMessage("login", {
              version: 1,
              type: "login.document.code-changed",
              token: context.token,
            });
            return;
          }
          const checked = Date.now();
          if (checked >= until) return;
          await pageChange(document, until, watching.signal);
          const gap = checked + checkGapMs - Date.now();
          if (gap > 0 && !stopped()) await pause(gap);
        }
        /* eslint-enable no-await-in-loop */
      })()
        .catch(() => respond({ ok: false }))
        .finally(() => {
          if (context.codeWatch === watching) context.codeWatch = undefined;
        });
      return true;
    }
    if (command.type === "login.state") {
      const username = command.account?.username;
      if (command.account) command.account.username = "";
      // The sign-in form shown again in a new document: its inputs each target names alone,
      // read-only ones when entered on the page's keypad (ADR 0067).
      // They are found when the page is read, after any wait for its load below.
      const read = () => {
        if (context.cancelled) return { ok: false };
        const keyed = new Set<HTMLInputElement>();
        const reshown = command.fields?.flatMap((target) => {
          const found = matches(target);
          if (found.length !== 1) return [];
          if (writable(found[0])) return [found[0]];
          if (!keyable(found[0]) || !keypadField(found[0], findKeypad(document, found[0])))
            return [];
          keyed.add(found[0]);
          return [found[0]];
        });
        return {
          ok: true,
          signs: pageSigns(document, {
            ...(reshown
              ? { reshown, keyed }
              : context.submitted
                ? { submitted: context.submitted }
                : {}),
            ...(username === undefined ? {} : { username }),
          }),
          loaded: document.readyState === "complete",
        };
      };
      if (command.loadWithinMs === undefined || document.readyState === "complete") {
        respond(read());
        return false;
      }
      // A document still loading is read once it loaded (ADR 0029, amended 2026-11-03).
      void documentLoaded(document, Date.now() + command.loadWithinMs, context.waits.signal)
        .then(read)
        .then(respond, () => respond({ ok: false }));
      return true;
    }
    if (command.type === "login.observe") {
      if (context.cancelled) {
        respond({ ok: false, reason: "cancelled" });
        return false;
      }
      const observeOptions = (index: number) => ({
        links: command.links?.[index] === true,
        hidden: command.hidden?.[index] === true,
      });
      // One read of the page: each element's closed root and each shadow tree's hosts are
      // looked up once (ADR 0070).
      respond(
        readingPage(() => ({
          path: pagePath(),
          targets: command.targets.map((target, index) =>
            targetState(document, target, command.require?.[index], observeOptions(index)),
          ),
          ...(command.signIn
            ? {
                signIn: {
                  loaded: document.readyState === "complete",
                  ...credentialInputs(command.targets),
                },
              }
            : {}),
          ...(command.explain
            ? {
                checks: command.targets.map((target, index) =>
                  targetCheck(document, target, command.require?.[index], observeOptions(index)),
                ),
              }
            : {}),
        })),
      );
      return false;
    }
    executeNative(context, command, respond);
    return true;
  };
  /**
   * After an entry press, a same-document URL change within the step wait is the next page
   * (ADR 0031): the document announces again so the worker checks it. A press that leads to
   * a new document needs nothing here; that document announces itself.
   */
  function watchPressedUrl(): void {
    const from = location.href;
    const listening = new AbortController();
    const options = { signal: listening.signal };
    // Every same-document URL change sends one of these (ADR 0082).
    const look = () => {
      if (context.cancelled) return stop();
      if (location.href === from) return;
      stop();
      void context.announce(false).catch(() => undefined);
    };
    const end = setTimeout(stop, LOGIN_STEP_WAIT_MS);
    function stop(): void {
      listening.abort();
      clearTimeout(end);
    }
    addEventListener("popstate", look, options);
    addEventListener("hashchange", look, options);
    context.navigation?.addEventListener("currententrychange", look, options);
    context.waits.signal.addEventListener("abort", stop, options);
  }
  return listener;
}
