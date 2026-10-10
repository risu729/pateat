import * as v from "valibot";
import type { LoginTarget } from "@pateat/contracts";
import { browser } from "wxt/browser";
import { commandSchema, reconnectSchema } from "./wire";

/** Fixed locators deliberately reject duplicates rather than taking the first match. */
function matches(target: LoginTarget): Element[] {
  const attribute = target.by === "test-id" ? "data-testid" : target.by;
  return [...document.querySelectorAll(`[${attribute}]`)].filter(
    (element) => element.getAttribute(attribute) === target.value,
  );
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
    !["hidden", "file", "submit", "button", "checkbox", "radio"].includes(element.type)
  );
}

function tokens(input: HTMLInputElement): string[] {
  return input.autocomplete.toLowerCase().split(/\s+/u);
}
/**
 * Secret values go only where a login form expects them, so a recipe cannot place a
 * password in a search box or comment field. A TOTP code may also use a short numeric field.
 */
function accepts(input: HTMLInputElement, secret: "password" | "otp" | undefined): boolean {
  if (secret === "password")
    return input.type === "password" || tokens(input).includes("current-password");
  if (secret === "otp")
    return (
      tokens(input).includes("one-time-code") ||
      ((input.inputMode === "numeric" || input.type === "tel" || input.type === "number") &&
        input.maxLength >= 1 &&
        input.maxLength <= 10)
    );
  return true;
}

export interface LoginContentOptions {
  /** Echo attempt status to the page; only the synthetic probe fixture page may see it. */
  readonly probeStatus?: boolean;
}

export function installLoginContent({ probeStatus = false }: LoginContentOptions = {}): () => void {
  const token = crypto.randomUUID();
  let cancelled = false;
  const used = new Set<string>();
  const listener: Parameters<typeof browser.runtime.onMessage.addListener>[0] = (
    message,
    sender,
    respond,
  ) => {
    if (sender.id !== browser.runtime.id || sender.tab) return false;
    if (v.safeParse(reconnectSchema, message).success) {
      void browser.runtime
        .sendMessage({ version: 1, type: "login.document.ready", token })
        .then(respond, () => respond({ ok: false }));
      return true;
    }
    const parsed = v.safeParse(commandSchema, message);
    if (!parsed.success || parsed.output.token !== token) return false;
    const command = parsed.output;
    if (command.type === "login.cancel") {
      cancelled = true;
      respond({ ok: true });
      return false;
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
      const fail = (reason: "structural-mismatch" | "timeout" | "cancelled") => ({
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
              !accepts(
                writableInputs[index]!,
                command.values.find((entry) => entry.slot === field.slot)!.secret,
              ),
          )
        )
          return fail("structural-mismatch");
        const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
        if (!setter) return fail("structural-mismatch");
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
            !accepts(input, value.secret)
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
        return { ok: true, mutation: "possible" };
      }
      if (command.values.length) return fail("structural-mismatch");
      if (step.kind === "click") {
        const found = matches(step.target);
        const element = found.length === 1 ? found[0] : undefined;
        if (
          !(
            element instanceof HTMLButtonElement ||
            (element instanceof HTMLInputElement && ["submit", "button"].includes(element.type))
          ) ||
          !visible(element) ||
          element.disabled
        )
          return fail("structural-mismatch");
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
        await new Promise<void>((resolve) => setTimeout(resolve, 50));
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
      });
    return true;
  };
  browser.runtime.onMessage.addListener(listener);
  void browser.runtime
    .sendMessage({ version: 1, type: "login.document.ready", token })
    .catch(() => undefined);
  return () => {
    cancelled = true;
    browser.runtime.onMessage.removeListener(listener);
  };
}
