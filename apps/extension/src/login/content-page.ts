import { findLogoutTargets, safeLogoutControl, shownLayers } from "../page/logout-controls";
import { pressElement } from "../page/script-url-click";
import { readingPage } from "../page/shadow";
import { keyable, targetCheck, targetState, writable } from "../page/target-state";
import { identifierInput } from "../page/identifier-field";
import { findKeypad, keypadField } from "../page/keypad";
import { visible } from "../page/code-submission";
import { pageChange } from "../page/page-change";
import { documentLoaded } from "../page/document-load";
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
import { listedAccounts, listsAccounts, logOnly } from "./no-input-offer";
import { entryElementRefusal, entryHosts, showsSignUp } from "../page/entry";
import { pageSigns } from "../page/sign-in-state";
import { sendMessage } from "../messaging/protocol";
import type { ContentState } from "./content-state";
import type { ContentWatch } from "./content-watch";
import type { ContentCommand, Respond } from "./content-command";
import {
  pagePath,
  matches,
  ready,
  showsSignIn,
  navigationStatus,
  credentialInputs,
  pause,
  checkGapMs,
} from "./content-dom";

type PageState = Pick<
  ContentState,
  "cancelled" | "describedWatch" | "inTab" | "submitted" | "token" | "waits"
>;

export type PageCommand = Extract<
  ContentCommand,
  {
    type:
      | "login.entry.hosts"
      | "login.entry.inspect"
      | "login.entry.press"
      | "login.logout.click"
      | "login.logout.local"
      | "login.entry.check"
      | "login.extract"
      | "login.extract.watch"
      | "login.state"
      | "login.observe";
  }
>;
export function handlePageCommand(
  state: PageState,
  watch: ContentWatch,
  command: PageCommand,
  respond: Respond,
): boolean {
  if (command.type === "login.entry.hosts") {
    respond(state.cancelled ? { ok: false } : { ok: true, hosts: entryHosts(document) });
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
          found.length === 0 || (found.length === 1 && entryElementRefusal(found[0]!) === "hidden");
        if (state.cancelled || Date.now() >= until || !waiting) break;
        // eslint-disable-next-line no-await-in-loop
        await pageChange(document, until, state.waits.signal);
        found = find();
      }
      if (state.cancelled) return { ok: false };
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
    const reason = state.cancelled
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
    watch.watchPressedUrl();
    // A press the page stopped after `pointerdown` is answered as made, so the link is not
    // pressed again; one that never reached `pointerdown` did not press it.
    void pressElement(element, () => !state.cancelled && location.href === command.url).then(
      (pressed) =>
        respond(
          pressed !== "missed"
            ? { ok: true }
            : {
                ok: false,
                reason: state.cancelled
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
        if (state.cancelled || found.length > 0 || Date.now() >= until) break;
        // eslint-disable-next-line no-await-in-loop
        await pageChange(document, until, state.waits.signal);
        found = find();
      }
      if (state.cancelled) return { ok: false, reason: "cancelled" };
      if (location.href !== url) return { ok: false, reason: "page-changed" };
      if (found.length !== 1) return { ok: false, reason: found.length ? "ambiguous" : "missing" };
      const control = found[0]!;
      // A control that logs out everywhere or ends the account is never pressed, whoever
      // named it: a stored recipe, the model or the control's words (ADR 0063).
      if (!safeLogoutControl(control, command.purpose)) return { ok: false, reason: "unsafe" };
      const before = shownLayers(document);
      const pressed = await pressElement(control, () => !state.cancelled && location.href === url);
      if (pressed === "missed")
        return { ok: false, reason: state.cancelled ? "cancelled" : "page-changed" };
      if (command.watchMs === undefined) return { ok: true };
      // How the page reacts to a control found by its words (ADR 0063): a page that
      // navigates away ends this script, which the worker reads as navigated.
      const watchUntil = Date.now() + command.watchMs;
      for (;;) {
        if (state.cancelled) return { ok: false, reason: "cancelled" };
        if (location.href !== url) return { ok: true, reacted: "navigated" };
        if (shownLayers(document) > before) return { ok: true, reacted: "dialog" };
        if (!control.isConnected || !visible(control)) return { ok: true, reacted: "changed" };
        if (Date.now() >= watchUntil) return { ok: true, reacted: "none" };
        // eslint-disable-next-line no-await-in-loop
        await pageChange(document, watchUntil, state.waits.signal);
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
        if (state.cancelled) return { ok: false };
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
        await pageChange(document, until, state.waits.signal);
      }
    })().then(respond, () => respond({ ok: false }));
    return true;
  }
  if (command.type === "login.extract") {
    if (state.cancelled) {
      respond({ ok: false, reason: "cancelled" });
      return false;
    }
    // A page to send goes only from a frame that shows in the tab's page (ADR 0086).
    if (command.shown && !state.inTab.shown()) {
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
    state.describedWatch?.abort();
    const watching = new AbortController();
    state.describedWatch = watching;
    const until = Date.now() + command.timeoutMs;
    const stopped = () => state.cancelled || watching.signal.aborted;
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
            token: state.token,
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
        if (state.describedWatch === watching) state.describedWatch = undefined;
      });
    respond({ ok: true });
    return false;
  }
  if (command.type === "login.state") {
    const username = command.account?.username;
    if (command.account) command.account.username = "";
    // The sign-in form shown again in a new document: its inputs each target names alone,
    // read-only ones when entered on the page's keypad (ADR 0067).
    // They are found when the page is read, after any wait for its load below.
    const read = () => {
      if (state.cancelled) return { ok: false };
      const keyed = new Set<HTMLInputElement>();
      const reshown = command.fields?.flatMap((target) => {
        const found = matches(target);
        if (found.length !== 1) return [];
        if (writable(found[0])) return [found[0]];
        if (!keyable(found[0]) || !keypadField(found[0], findKeypad(document, found[0]))) return [];
        keyed.add(found[0]);
        return [found[0]];
      });
      return {
        ok: true,
        signs: pageSigns(document, {
          ...(reshown ? { reshown, keyed } : state.submitted ? { submitted: state.submitted } : {}),
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
    void documentLoaded(document, Date.now() + command.loadWithinMs, state.waits.signal)
      .then(read)
      .then(respond, () => respond({ ok: false }));
    return true;
  }
  if (command.type === "login.observe") {
    if (state.cancelled) {
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
  return false;
}
