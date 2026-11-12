import * as v from "valibot";
import { browser } from "wxt/browser";
import { pressElement } from "../page/script-url-click";
import { readingPage } from "../page/shadow";
import { pageChange } from "../page/page-change";
import { listChoice } from "../page/account-list";
import { siteValueChoice } from "../page/site-values";
import { commandSchema, reconnectSchema } from "./wire";
import type { ContentState } from "./content-state";
import type { ContentWatch } from "./content-watch";
import { handleDetailCommand } from "./content-detail";
import { handlePageCommand } from "./content-page";
import { executeNative } from "./content-execute";
import {
  pagePath,
  matches,
  isOnly,
  ready,
  readinessMiss,
  revealsPassword,
  showsSignIn,
} from "./content-dom";

export function createContentListener(
  state: ContentState,
  watch: ContentWatch,
  probeStatus: boolean,
) {
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
      const fresh = reconnect.output.fresh === true && !state.cancelled;
      if (fresh) {
        state.ended = false;
        state.announced = false;
        state.retries = 0;
        state.offered = false;
        state.entryOffered = false;
        state.offeredPaths.clear();
        state.lateWatch?.();
        // The answer opens the window again; until then nothing is offered.
        state.generate = false;
        watch.clearOffer();
        state.urlWatch?.();
      }
      // A restarted worker forgot earlier refusals; a ready form may start again. A fresh
      // announcement, like one after a URL change, keeps a login the document carries.
      void watch
        .announce(state.starts.some(ready), false, undefined, false, false, fresh)
        .then(respond, () => respond({ ok: false }));
      return true;
    }
    const parsed = v.safeParse(commandSchema, message);
    if (!parsed.success || parsed.output.token !== state.token) return false;
    const command = parsed.output;
    if (
      command.type === "login.sso.return" ||
      command.type === "login.sso.inspect" ||
      command.type === "login.sso.prepare" ||
      command.type === "login.sso.commit" ||
      command.type === "login.sso.idp"
    ) {
      if (command.type === "login.sso.idp") state.ssoCarrying = true;
      void state.ssoContent(command).then(respond, () => respond({ ok: false }));
      return true;
    }
    if (
      command.type === "login.detail.question" ||
      command.type === "login.detail.card" ||
      command.type === "login.detail.fill"
    )
      return handleDetailCommand(state, command, respond);

    if (command.type === "login.native.cancel") {
      if (!state.cancelledNative.has(command.attemptId) && state.cancelledNative.size >= 256) {
        respond({ ok: false });
        return false;
      }
      state.cancelledNative.add(command.attemptId);
      if (state.pendingSwitch?.attemptId === command.attemptId) state.pendingSwitch = undefined;
      if (state.filledAttempt === command.attemptId) {
        if (state.deferredAccount) state.deferredAccount.username = "";
        state.deferredAccount = undefined;
        state.filled = new WeakSet();
        state.chosen = [];
        state.shownBefore = undefined;
      }
      respond({ ok: true });
      return false;
    }
    if (command.type === "login.cancel") {
      state.cancelled = true;
      state.lateWatch?.();
      state.describedWatch?.abort();
      if (state.deferredAccount) state.deferredAccount.username = "";
      state.deferredAccount = undefined;
      state.waits.abort();
      watch.unwatch();
      watch.followConfirmPath(undefined);
      respond({ ok: true });
      return false;
    }
    if (command.type === "login.choose") {
      const choice =
        state.cancelled || pagePath() !== command.path || showsSignIn()
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
        state.siteAccountAsked || state.cancelled || pagePath() !== command.path
          ? []
          : command.targets.map((target) => {
              const found = matches(target);
              return found.length === 1 ? found[0]! : undefined;
            });
      const compared = inputs.length > 0 && inputs.every(Boolean);
      const index = compared
        ? siteValueChoice(window, inputs as Element[], command.usernames)
        : undefined;
      if (compared) state.siteAccountAsked = true;
      command.usernames.fill("");
      respond(
        index !== undefined
          ? { ok: true, index }
          : state.siteAccountAsked
            ? { ok: false, spent: true }
            : { ok: false },
      );
      return false;
    }
    if (command.type === "login.switch") {
      const pending = state.pendingSwitch;
      state.pendingSwitch = undefined;
      // The page may have changed since the fill; click only the same, still unique element.
      const click =
        !state.cancelled &&
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
        !state.cancelled &&
        !state.cancelledNative.has(pending.attemptId) &&
        pagePath() === pending.path;
      void pressElement(pending.element, pressing).then(
        (pressed) => {
          respond({ ok: pressed !== "missed" });
          if (pressed !== "missed") void watch.switchedInPlace(pending.element);
          return undefined;
        },
        () => respond({ ok: true }),
      );
      return true;
    }
    if (command.type === "login.fill.change") {
      void pageChange(document, Date.now() + command.timeoutMs, state.waits.signal).then(
        () => respond({ ok: !state.cancelled }),
        () => respond({ ok: false }),
      );
      return true;
    }
    if (command.type === "login.await") {
      // Checks the current DOM serially, again at each change of the page, until the step's
      // elements are ready; never mutates.
      void (async () => {
        const until = Date.now() + command.timeoutMs;
        // Cancellation is set by the independent background message listener.
        while (!state.cancelled && !ready(command.readiness)) {
          if (command.readiness.revealed && readingPage(() => revealsPassword(command.readiness)))
            return { ok: false, reason: "revealed" };
          if (Date.now() >= until) {
            const miss = readingPage(() => readinessMiss(command.readiness));
            return { ok: false, reason: "timeout", ...(miss ? { miss } : {}) };
          }
          // eslint-disable-next-line no-await-in-loop
          await pageChange(document, until, state.waits.signal);
        }
        return state.cancelled ? { ok: false, reason: "cancelled" } : { ok: true };
      })().then(respond, () => respond({ ok: false, reason: "cancelled" }));
      return true;
    }
    if (command.type === "login.status") {
      // Pages are untrusted; only the synthetic probe fixture observes attempt status.
      if (probeStatus)
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
      state.carrying = !["denied", "generating", "authenticated", "blocked"].includes(
        command.state,
      );
      // A finished login keeps watching: its first step showing again logs in again.
      // A new login in this document, as after a pick, watches for its own end.
      if (command.state === "executing") state.ended = false;
      if (!state.ended && (command.state === "authenticated" || command.state === "blocked")) {
        state.ended = true;
        // An ended login reads no page again here (ADR 0027 amendment of 2026-11-04).
        state.describedWatch?.abort();
        state.rejected = command.outcome === "credential-rejected";
        void watch.announce(false).catch(() => undefined);
      }
      return false;
    }
    if (
      command.type === "login.entry.hosts" ||
      command.type === "login.entry.inspect" ||
      command.type === "login.entry.press" ||
      command.type === "login.logout.click" ||
      command.type === "login.logout.local" ||
      command.type === "login.entry.check" ||
      command.type === "login.extract" ||
      command.type === "login.extract.watch" ||
      command.type === "login.state" ||
      command.type === "login.observe"
    )
      return handlePageCommand(state, watch, command, respond);

    return executeNative(state, command, respond);
  };
  return listener;
}
