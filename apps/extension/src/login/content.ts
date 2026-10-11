import * as v from "valibot";
import type { LoginTarget } from "@pateat/contracts";
import { browser } from "wxt/browser";
import { accountText, showsOtherAccount, shownAccounts } from "../page/accounts";
import { isButton } from "../page/text";
import { findTargets } from "../page/targets";
import { inputValueMismatch, pageFeedback, rejectsFill } from "../page/fill-checks";
import { extractLoginObservation, extractSignedInObservation } from "../observation/extract";
import { acceptsSecret } from "./inputs";
import {
  commandSchema,
  LOGIN_STEP_WAIT_MS,
  readySchema,
  reconnectSchema,
  type LoginReadiness,
} from "./wire";

/** Fixed locators deliberately reject duplicates rather than taking the first match. */
function matches(target: LoginTarget): Element[] {
  return findTargets(document, target);
}
function visible(element: HTMLElement): boolean {
  const style = getComputedStyle(element);
  return (
    element.isConnected &&
    !element.hidden &&
    style.display !== "none" &&
    style.visibility !== "hidden" &&
    element.getClientRects().length > 0
  );
}
function writable(element: Element | undefined): element is HTMLInputElement {
  return (
    element instanceof HTMLInputElement &&
    visible(element) &&
    !element.disabled &&
    !element.readOnly &&
    !["hidden", "file", "submit", "button", "image", "reset", "checkbox", "radio"].includes(
      element.type,
    )
  );
}
function clickable(element: Element | undefined): element is HTMLElement {
  return element !== undefined && isButton(element) && visible(element) && !element.disabled;
}
function followable(element: Element | undefined): element is HTMLAnchorElement {
  return element instanceof HTMLAnchorElement && element.hasAttribute("href") && visible(element);
}
const isOnly = (found: readonly Element[], element: Element) =>
  found.length === 1 && found[0] === element;
/** How long after a `wrong-account` result its account switch may still be clicked. */
const switchTimeoutMs = 10_000;
/**
 * Whether `element` is an account switch the executor may click: a shown link, or a shown
 * button that does not submit a form (that would send the sign-in form instead).
 */
function switchable(element: Element | undefined): element is HTMLElement {
  if (followable(element)) return true;
  if (!clickable(element) || !isButton(element)) return false;
  const submits = element.type === "submit" || element.type === "image";
  return !(submits && element.form);
}
/** Whether a step's elements are ready now: the path matches and each target is unique and usable. */
function ready(readiness: LoginReadiness): boolean {
  if (location.pathname !== readiness.path) return false;
  return readiness.targets.every((target) => {
    const found = matches(target);
    if (found.length !== 1) return false;
    if (readiness.require === "writable") return writable(found[0]);
    if (readiness.require === "clickable") return clickable(found[0]);
    return true;
  });
}
/**
 * Whether the page shows a visible password input, or one marked for a username or a
 * one-time code: the only pages without a recipe that may be sent for generation
 * (ADR 0016).
 */
function showsSignIn(): boolean {
  return [...document.querySelectorAll("input")].some((input) => {
    const tokens = input.autocomplete.toLowerCase().split(/\s+/u);
    return (
      (input.type === "password" ||
        tokens.includes("username") ||
        tokens.includes("one-time-code")) &&
      writable(input)
    );
  });
}
const pause = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
/**
 * How long a preparing fill waits for the page's own input handlers before checking that
 * the page accepted the values (ADR 0010).
 */
const fillSettleMs = 500;

export interface LoginContentOptions {
  /** Echo attempt status to the page; only the synthetic probe fixture page may see it. */
  readonly probeStatus?: boolean;
}

export function installLoginContent({ probeStatus = false }: LoginContentOptions = {}): () => void {
  const token = crypto.randomUUID();
  let cancelled = false;
  const used = new Set<string>();
  // The account switch a `wrong-account` result reported, clicked only by `login.switch`.
  let pendingSwitch:
    | {
        operationId: string;
        element: HTMLElement;
        target: LoginTarget;
        path: string;
        expiresAt: number;
      }
    | undefined;
  // First steps of the origin's recipes. A new attempt starts only once one is ready on
  // the current path, including after a same-document URL change or a dialog opening.
  let starts: LoginReadiness[] = [];
  let announced = false;
  // The background may generate a recipe for this page if it shows a sign-in input soon
  // after loading; a form shown only later, for example after a click, is not sent.
  let generate = false;
  let offered = false;
  let offerTimer: ReturnType<typeof setTimeout> | undefined;
  let observer: MutationObserver | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const navigation = (globalThis as unknown as { navigation?: EventTarget }).navigation;
  const schedule = () => {
    timer ??= setTimeout(check, 100);
  };
  function unwatch(): void {
    clearTimeout(offerTimer);
    offerTimer = undefined;
    observer?.disconnect();
    observer = undefined;
    clearTimeout(timer);
    timer = undefined;
    removeEventListener("popstate", schedule);
    navigation?.removeEventListener("currententrychange", schedule);
  }
  function watch(list: LoginReadiness[], offer = false): void {
    starts = list;
    generate = offer && !offered;
    if (!generate) {
      clearTimeout(offerTimer);
      offerTimer = undefined;
    } else
      offerTimer ??= setTimeout(() => {
        offerTimer = undefined;
        offered = true;
        watch(starts);
      }, LOGIN_STEP_WAIT_MS);
    if ((!starts.length && !generate) || cancelled) {
      unwatch();
      return;
    }
    if (!observer) {
      observer = new MutationObserver(schedule);
      // Only attributes that can change whether a target matches, shows or accepts input.
      observer.observe(document, {
        subtree: true,
        childList: true,
        // Button text locators also depend on text, `value`, `alt` and hidden subtrees.
        characterData: true,
        attributes: true,
        attributeFilter: [
          "id",
          "name",
          "data-testid",
          "type",
          "autocomplete",
          "hidden",
          "style",
          "class",
          "open",
          "disabled",
          "readonly",
          "value",
          "alt",
          "aria-hidden",
          "inert",
        ],
      });
      addEventListener("popstate", schedule);
      navigation?.addEventListener("currententrychange", schedule);
    }
  }
  /**
   * Checks again shortly when a start could not be confirmed for a passing reason. Each
   * appearance of the form gets a few retries; after that it waits until the form goes.
   */
  let retries = 0;
  function retry(): void {
    if (!observer) return;
    retries += 1;
    if (retries > 3) return;
    announced = false;
    clearTimeout(timer);
    timer = setTimeout(check, 500);
  }
  // Announce once per appearance; a form that disappears and reappears announces again.
  function check(): void {
    clearTimeout(timer);
    timer = undefined;
    if (!observer) return;
    const startable = starts.some(ready);
    if (startable && !announced) void announce(true).catch(retry);
    else if (!startable) {
      announced = false;
      retries = 0;
      // Offered once per page; the background keeps its own daily limit as well.
      if (generate && !offered && showsSignIn()) {
        offered = true;
        void announce(false, true).catch(() => undefined);
      }
    }
  }
  async function announce(start: boolean, signIn = false): Promise<unknown> {
    announced = start;
    const result: unknown = await browser.runtime.sendMessage({
      version: 1,
      type: "login.document.ready",
      token,
      ...(start ? { start: { path: location.pathname } } : {}),
      ...(signIn ? { signIn: { path: location.pathname } } : {}),
    });
    const parsed = v.safeParse(readySchema, result);
    if (!parsed.success || parsed.output.ok) {
      unwatch();
    } else if (parsed.output.starts) {
      watch(parsed.output.starts, parsed.output.generate === true);
      // A refused start means the background did not see the form on this path yet, for
      // example while the tab still shows the previous URL.
      if (start) retry();
      else check();
    } else if (parsed.output.reason === "generating") {
      // The background announces a generated recipe with `login.reconnect`.
      unwatch();
    } else if (
      ["stale-document", "closed-tab", "runtime-unavailable"].includes(parsed.output.reason ?? "")
    ) {
      retry();
    } else {
      // A policy refusal (no account, another tab owns the site, ...) holds until the page
      // is loaded again; re-announcing on every re-render would only repeat it.
      unwatch();
    }
    return result;
  }
  const listener: Parameters<typeof browser.runtime.onMessage.addListener>[0] = (
    message,
    sender,
    respond,
  ) => {
    if (sender.id !== browser.runtime.id || sender.tab) return false;
    if (v.safeParse(reconnectSchema, message).success) {
      // A restarted worker forgot earlier refusals; a ready form may start again.
      void announce(starts.some(ready)).then(respond, () => respond({ ok: false }));
      return true;
    }
    const parsed = v.safeParse(commandSchema, message);
    if (!parsed.success || parsed.output.token !== token) return false;
    const command = parsed.output;
    if (command.type === "login.cancel") {
      cancelled = true;
      unwatch();
      respond({ ok: true });
      return false;
    }
    if (command.type === "login.switch") {
      const pending = pendingSwitch;
      pendingSwitch = undefined;
      // The page may have changed since the fill; click only the same, still unique element.
      const click =
        !cancelled &&
        pending?.operationId === command.operationId &&
        Date.now() < pending.expiresAt &&
        location.pathname === pending.path &&
        switchable(pending.element) &&
        isOnly(findTargets(document, pending.target, { links: true }), pending.element);
      if (click) pending.element.click();
      respond({ ok: click });
      return false;
    }
    if (command.type === "login.await") {
      // Polls the current DOM serially until the step's elements are ready; never mutates.
      void (async () => {
        const until = Date.now() + command.timeoutMs;
        // Cancellation is set by the independent background message listener.
        // eslint-disable-next-line no-unmodified-loop-condition
        while (!cancelled && !ready(command.readiness)) {
          if (Date.now() >= until) return { ok: false, reason: "timeout" };
          // eslint-disable-next-line no-await-in-loop
          await pause(50);
        }
        return cancelled ? { ok: false, reason: "cancelled" } : { ok: true };
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
      return false;
    }
    if (command.type === "login.extract") {
      if (cancelled) {
        respond({ ok: false, reason: "cancelled" });
        return false;
      }
      const result =
        command.page === "login" ? extractLoginObservation() : extractSignedInObservation();
      respond(result);
      return false;
    }
    if (command.type === "login.observe") {
      if (cancelled) {
        respond({ ok: false, reason: "cancelled" });
        return false;
      }
      respond({
        path: location.pathname,
        targets: command.targets.map((target) => {
          const count = matches(target).length;
          return count === 0 ? "missing" : count === 1 ? "unique" : "ambiguous";
        }),
      });
      return false;
    }
    void (async () => {
      const operation = command.operation;
      let mutated = false;
      const fail = (
        reason:
          | "structural-mismatch"
          | "timeout"
          | "cancelled"
          | "wrong-account"
          | "value-mismatch"
          | "fill-rejected",
      ) => ({
        ok: false,
        reason,
        mutation: mutated ? "possible" : "none",
      });
      const authorized: unknown = await browser.runtime.sendMessage({
        version: 1,
        type: "login.operation.authorize",
        token,
        attemptId: operation.attemptId,
        operationId: operation.operationId,
      });
      if (
        authorized !== true ||
        cancelled ||
        used.has(operation.operationId) ||
        Date.now() >= operation.expiresAt ||
        operation.document.origin !== location.origin ||
        operation.step.path !== location.pathname
      )
        return fail("cancelled");
      used.add(operation.operationId);
      const step = operation.step;
      if (step.kind === "fill") {
        // Resolve every target first so a partial/ambiguous mapping never causes partial fill.
        const inputs = step.fields.map((field) => {
          const found = matches(field.target);
          return found.length === 1 ? found[0] : undefined;
        });
        if (inputs.some((input) => !writable(input))) return fail("structural-mismatch");
        if (
          command.values.length !== step.fields.length ||
          step.fields.some(
            (field) => command.values.filter((entry) => entry.slot === field.slot).length !== 1,
          )
        )
          return fail("structural-mismatch");
        // One step fills one form (or only inputs outside any form), and secrets only fit their inputs.
        const writableInputs = inputs as HTMLInputElement[];
        const form = writableInputs[0]!.form;
        if (
          writableInputs.some((input) => input.form !== form) ||
          step.fields.some(
            (field, index) =>
              !acceptsSecret(
                writableInputs[index]!,
                command.values.find((entry) => entry.slot === field.slot)!.secret,
              ),
          )
        )
          return fail("structural-mismatch");
        // A secret goes only to the account the page shows, when it shows one (owner
        // decision, 2026-10-11). The comparison stays in this content script.
        if (command.account) {
          const other = showsOtherAccount(
            shownAccounts(accountText(document, form)),
            command.account.username,
            {
              masked: command.values.some(
                (entry) => entry.secret === "password" || entry.secret === "hidden",
              ),
            },
          );
          command.account.username = "";
          if (other) {
            // The recipe's account switch is clicked once the background has recorded the
            // switch, so a recipe that starts on the page it leads to can log in.
            const found = command.accountSwitch
              ? findTargets(document, command.accountSwitch, { links: true })
              : [];
            const element = found.length === 1 ? found[0] : undefined;
            if (command.accountSwitch && switchable(element)) {
              pendingSwitch = {
                operationId: operation.operationId,
                element,
                target: command.accountSwitch,
                path: location.pathname,
                expiresAt: Date.now() + switchTimeoutMs,
              };
              return { ...fail("wrong-account"), switchable: true as const };
            }
            return fail("wrong-account");
          }
        }
        // Every value must fit its input before anything is filled (ADR 0010).
        if (
          step.fields.some(
            (field, index) =>
              inputValueMismatch(
                writableInputs[index]!,
                command.values.find((entry) => entry.slot === field.slot)!.value,
              ) !== undefined,
          )
        )
          return fail("value-mismatch");
        const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
        if (!setter) return fail("structural-mismatch");
        // Messages already shown are not the page's answer to this fill.
        const feedback = step.effect === "prepare" ? pageFeedback(document) : undefined;
        for (const [index, field] of step.fields.entries()) {
          const input = inputs[index] as HTMLInputElement;
          // Each mutation repeats scope/connected checks; events may synchronously change the page.
          const current = matches(field.target);
          const value = command.values.find((entry) => entry.slot === field.slot)!;
          if (
            cancelled ||
            location.pathname !== step.path ||
            current.length !== 1 ||
            current[0] !== input ||
            !writable(input) ||
            input.form !== form ||
            !acceptsSecret(input, value.secret)
          )
            return fail("cancelled");
          // Mark uncertainty before calling into DOM/page code, including a throwing setter.
          mutated = true;
          setter.call(input, value.value);
          if (step.effect === "prepare") {
            input.dispatchEvent(new Event("input", { bubbles: true }));
            input.dispatchEvent(new Event("change", { bubbles: true }));
          } else {
            input.dispatchEvent(new Event(step.event!, { bubbles: true }));
          }
          value.value = "";
        }
        // A preparing fill is followed by a click; the page's own validation must accept
        // the values first. An effectful fill has already submitted through its event.
        if (feedback) {
          await pause(fillSettleMs);
          if (cancelled) return fail("cancelled");
          if (rejectsFill(writableInputs, feedback, document)) return fail("fill-rejected");
        }
        return { ok: true, mutation: "possible" };
      }
      if (command.values.length) return fail("structural-mismatch");
      if (step.kind === "click") {
        const found = matches(step.target);
        const element = found.length === 1 ? found[0] : undefined;
        if (!clickable(element)) return fail("structural-mismatch");
        mutated = true;
        element.click();
        return { ok: true, mutation: "possible" };
      }
      const satisfied = () => {
        const count = matches(step.target).length;
        return step.present ? count === 1 : count === 0;
      };
      if (step.kind === "assert")
        return satisfied() ? { ok: true, mutation: "none" } : fail("structural-mismatch");
      const until = Math.min(operation.expiresAt, Date.now() + step.timeoutMs);
      // Cancellation is set by the independent background message listener.
      // eslint-disable-next-line no-unmodified-loop-condition
      while (!cancelled && Date.now() < until && location.pathname === step.path) {
        if (satisfied()) return { ok: true, mutation: "none" };
        // Poll the current DOM serially; parallel polls cannot observe later render states.
        // eslint-disable-next-line no-await-in-loop
        await pause(50);
      }
      return fail(cancelled ? "cancelled" : "timeout");
    })()
      // A thrown execution may already have mutated the page. Never advertise a safe retry.
      .then(
        (result) =>
          respond({
            ...result,
            operationId: command.operation.operationId,
            documentId: command.operation.document.documentId,
          }),
        () =>
          respond({
            ok: false,
            reason: "cancelled",
            mutation: "possible",
            operationId: command.operation.operationId,
            documentId: command.operation.document.documentId,
          }),
      )
      .finally(() => {
        for (const entry of command.values) entry.value = "";
        if (command.account) command.account.username = "";
      });
    return true;
  };
  browser.runtime.onMessage.addListener(listener);
  void announce(false).catch(() => undefined);
  return () => {
    cancelled = true;
    unwatch();
    browser.runtime.onMessage.removeListener(listener);
  };
}
