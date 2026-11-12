import { type LoginTarget } from "@pateat/contracts";
import { comparableAccounts, formAccounts, showsOtherAccount } from "../page/accounts";
import { isButton } from "../page/text";
import { pressElement } from "../page/script-url-click";
import { findTargets } from "../page/targets";
import { closestAcross, formOf, inputsOf, queryAll } from "../page/shadow";
import {
  clickable,
  keyable,
  passwordChoice,
  targetState,
  writable,
  codeMarked,
} from "../page/target-state";
import { authenticatorChoice } from "../page/authenticator-choice";
import { unreadyForm, fillBaseline, fillRejection, inputValueMismatch } from "../page/fill-checks";
import {
  clickDestinations,
  formDestinations,
  submitterDestinations,
} from "../page/form-destination";
import { pageChange } from "../page/page-change";
import { accountSwitchControls, listChoice } from "../page/account-list";
import { passedCaptcha, showsCaptcha, submittedPage } from "../page/sign-in-state";
import { sendMessage } from "../messaging/protocol";
import { stopSiteValues } from "../page/site-values";
import { type ExecutionDetail, type TargetState, signInSlot } from "./wire";
import type { ContentState } from "./content-state";
import type { ExecuteCommand, Respond } from "./content-command";
import {
  pagePath,
  matches,
  submitButton,
  clearTyped,
  switchTimeoutMs,
  switchable,
  accountWaitMs,
  accountReserveMs,
  stillAsks,
  type Control,
  takes,
  fitsControl,
  enter,
  isOnly,
  pause,
  fillSettleMs,
  accountQuietMs,
} from "./content-dom";
import { besideKeypad, keypadCovers, keypadOpen, locateKeypad } from "../page/keypad";
import { typeOnKeypad } from "../page/keypad-typing";
import {
  CODE_SETTLE_MS,
  splitCodeInputs,
  unmarkedDigit,
  visible,
  watchCodeSubmission,
} from "../page/code-submission";
import { typeValue } from "../page/enter-value";
import { nextFrame } from "../page/frames";
import { settled } from "../page/quiet";
import { presence } from "../observation/extract";
import { acceptsSecret, maskedSecret } from "./inputs";
import { chooseFor } from "../page/choice-radio";
import { claimFill, fillUntouched, fillEditsReady } from "../page/fill-edits";
import { createDestinationCheck, createEnterPress } from "./content-effects";

type ExecutionState = Pick<
  ContentState,
  | "cancelled"
  | "cancelledNative"
  | "chosen"
  | "deferredAccount"
  | "filled"
  | "filledAttempt"
  | "pendingSwitch"
  | "shownBefore"
  | "submitsBefore"
  | "submitsTaken"
  | "submitted"
  | "token"
  | "used"
  | "waits"
>;

export function executeNative(
  state: ExecutionState,
  command: ExecuteCommand,
  respond: Respond,
): boolean {
  // An advance's next step as measured just before its effect, answered with the result.
  let before: TargetState[] | undefined;
  // And those of another layout's next step on the same path (ADR 0060).
  let siblingsBefore: TargetState[][] | undefined;
  void (async () => {
    const operation = command.operation;
    const nativeCancelled = () => state.cancelled || state.cancelledNative.has(operation.attemptId);
    let mutated = false;
    // A key of the page's keypad was pressed (ADR 0067).
    let keyPressed = false;
    const fail = (
      reason:
        | "structural-mismatch"
        | "timeout"
        | "cancelled"
        | "wrong-account"
        | "value-mismatch"
        | "fill-rejected"
        | "submitted"
        | "captcha",
      detail?: ExecutionDetail,
      fieldIndex?: number,
    ) => ({
      ok: false,
      reason,
      ...(fieldIndex === undefined ? {} : { fieldIndex }),
      // A stop after a key press leaves its characters in the field, which only the
      // page's own keys or a reload clear, so the person is told to reload it; a page
      // that may have submitted them is waited for instead (ADR 0067).
      ...(keyPressed && reason !== "submitted"
        ? { detail: "keypad-pressed" as const }
        : detail
          ? { detail }
          : {}),
      mutation: mutated ? "possible" : "none",
    });
    const authorized: unknown = await sendMessage("login", {
      version: 1,
      type: "login.operation.authorize",
      token: state.token,
      attemptId: operation.attemptId,
      operationId: operation.operationId,
    });
    if (authorized !== true) return fail("cancelled", "not-authorized");
    // What the page sets in its inputs from now on may be Pateat's own filling.
    stopSiteValues(window);
    /**
     * Why the step may not send its form where `read` says it goes: a destination the
     * page refuses, or one off the document's origin that the background does not allow
     * by the login's vault item (ADR 0051). The destinations are read again after the
     * answers, and one that changed meanwhile refuses the step as a changed form.
     */
    const destinationRefusal = createDestinationCheck(state, operation, nativeCancelled);
    if (nativeCancelled()) return fail("cancelled", "document-cancelled");
    if (state.used.has(operation.operationId)) return fail("cancelled", "operation-used");
    if (Date.now() >= operation.expiresAt) return fail("cancelled", "operation-expired");
    // The document's own origin, opaque ("null") in a sandboxed document whatever its URL.
    if (operation.document.origin !== self.origin || operation.step.path !== pagePath())
      return fail("cancelled", "page-changed");
    state.used.add(operation.operationId);
    const step = operation.step;
    if (
      operation.signInFill &&
      (step.kind === "click" ||
        command.code ||
        command.choose ||
        (step.kind === "fill" &&
          (step.effect !== "prepare" || step.fields.some((field) => field.keypad))))
    )
      return fail("cancelled", "not-authorized");
    // Another attempt in this document starts from nothing filled.
    if (operation.attemptId !== state.filledAttempt) {
      state.filled = new WeakSet();
      state.chosen = [];
      state.shownBefore = undefined;
      if (state.deferredAccount) state.deferredAccount.username = "";
      state.deferredAccount = undefined;
      state.filledAttempt = operation.attemptId;
    }
    // The page shows another account: its switch, the recipe's or the page's own (ADR
    // 0078), is clicked only by `login.switch`, once the background has recorded it.
    const otherAccount = (switches: {
      accountSwitch?: LoginTarget | undefined;
      otherSwitch?: true | undefined;
    }) => {
      const target = switches.accountSwitch;
      const find = target
        ? () => {
            const named = findTargets(document, target, { links: true });
            return named.length === 1 && switchable(named[0]) ? named : [];
          }
        : switches.otherSwitch
          ? () => accountSwitchControls(document)
          : undefined;
      const found = find?.() ?? [];
      const element = found.length === 1 ? found[0] : undefined;
      if (find && element instanceof HTMLElement) {
        state.pendingSwitch = {
          operationId: operation.operationId,
          attemptId: operation.attemptId,
          element,
          find,
          path: pagePath(),
          expiresAt: Date.now() + switchTimeoutMs,
        };
        return { ...fail("wrong-account"), switchable: true as const };
      }
      return fail("wrong-account");
    };
    const nothingShown = (deferred: NonNullable<typeof state.deferredAccount>) =>
      comparableAccounts(formAccounts(document, deferred.form), deferred.username, {
        masked: deferred.masked,
      })?.length === 0;
    /**
     * Before a click or Enter's own checks: while a fill left its account check to it
     * (`deferredAccount`) and the page still shows no identifier and has not loaded, waits
     * for `load`, at most `accountWaitMs` and until `accountReserveMs` before the operation
     * expires (ADR 0082), or the document's cancel. A wait that ran out goes on.
     */
    const deferredLoad = async () => {
      const deferred = state.deferredAccount;
      if (!deferred || document.readyState === "complete" || !nothingShown(deferred))
        return undefined;
      await new Promise<void>((resolve) => {
        const done = () => {
          clearTimeout(loadTimer);
          removeEventListener("load", done);
          state.waits.signal.removeEventListener("abort", done);
          resolve();
        };
        const loadTimer = setTimeout(
          done,
          Math.max(0, Math.min(accountWaitMs, operation.expiresAt - accountReserveMs - Date.now())),
        );
        addEventListener("load", done);
        state.waits.signal.addEventListener("abort", done);
      });
      if (nativeCancelled()) return fail("cancelled", "document-cancelled");
      if (Date.now() >= operation.expiresAt) return fail("cancelled", "operation-expired");
      if (step.path !== pagePath()) return fail("cancelled", "page-changed");
      return undefined;
    };
    /**
     * The check a fill left to this click or Enter, run with no wait just before the press:
     * on another account the values the fill typed are cleared and nothing is pressed. It
     * is used up by a submitting press or once the page shows an identifier; an advance
     * on a page that still shows none leaves it for the next press.
     */
    const deferredOther = (submit: boolean) => {
      const deferred = state.deferredAccount;
      if (!deferred) return undefined;
      if (!submit && nothingShown(deferred)) return undefined;
      state.deferredAccount = undefined;
      const other = showsOtherAccount(formAccounts(document, deferred.form), deferred.username, {
        masked: deferred.masked,
      });
      deferred.username = "";
      if (!other) return undefined;
      clearTyped(deferred.inputs);
      return otherAccount(deferred);
    };
    // With an advance whose next step is on its path, that step's elements just before
    // the click or the first input; the answer reports them (ADR 0013).
    const measureNext = () => {
      const next = command.next;
      if (next) before = next.targets.map((target) => targetState(document, target, next.require));
      siblingsBefore = command.siblings?.map((sibling) =>
        sibling.targets.map((target) => targetState(document, target, sibling.require)),
      );
    };
    /**
     * Submits the form of `target`, the field the fill just before typed last, as pressing
     * Enter there does (ADR 0064): a click on the form's default button, its first submit
     * button in tree order, or `requestSubmit()` when it has none, as the official
     * auto-submit falls back to. Enter on a disabled default button submits nothing, and
     * a default button that showed when a fill began (`submitsBefore`), which the
     * generation could have named, or one only associated with the form from outside it,
     * is never pressed. The
     * page's own validation must pass, and the checks of a click run first: the
     * destination (ADR 0051), the form still holding its fills, and a CAPTCHA left to the
     * person, who then presses Enter or the button.
     */
    const pressEnter = createEnterPress(state, step, {
      deferredLoad,
      fail,
      destinationRefusal,
      deferredOther,
      measureNext,
      markMutated: () => {
        mutated = true;
      },
    });
    if (step.kind === "fill") {
      const masked = command.values.some((entry) => maskedSecret(entry.secret));
      let deferLater = false;
      if (command.account) {
        const first = step.fields[0] ? matches(step.fields[0].target) : [];
        const form =
          first.length === 1 && first[0] instanceof HTMLInputElement ? formOf(first[0]) : null;
        const comparable = comparableAccounts(
          formAccounts(document, form),
          command.account.username,
          {
            masked,
          },
        );
        if (comparable?.length === 0 && command.accountAtPress) deferLater = true;
        else if (comparable?.length === 0) {
          await settled(
            document,
            accountQuietMs,
            Math.min(Date.now() + accountWaitMs, operation.expiresAt - accountReserveMs),
          );
          if (nativeCancelled()) return fail("cancelled", "document-cancelled");
          if (Date.now() >= operation.expiresAt) return fail("cancelled", "operation-expired");
          if (step.path !== pagePath()) return fail("cancelled", "page-changed");
        }
      }
      // Resolve every target first so a partial/ambiguous mapping never causes partial fill.
      const inputs = step.fields.map((field) => {
        const found = matches(field.target);
        return found.length === 1 ? found[0] : undefined;
      });
      // A field entered on the page's keypad may be read-only (ADR 0067); a split
      // date's part may be a select (ADR 0061); every other value goes into an input.
      const secretOf = (index: number) =>
        command.values.find((entry) => entry.slot === step.fields[index]!.slot)?.secret;
      // A username or password never goes into a code input (issue #1413).
      const usable = (input: Element | undefined, index: number) =>
        (step.fields[index]!.keypad ? keyable(input) : takes(input, secretOf(index))) &&
        !(signInSlot(step.fields[index]!.slot) && codeMarked(input)) &&
        !(operation.signInFill && codeMarked(input));
      if (inputs.some((input, index) => !usable(input, index)))
        return fail("structural-mismatch", "target-missing");
      // Each field's keypad, which holds the keys, shown or not yet.
      const keypadOf = (index: number) => {
        const field = step.fields[index]!;
        const input = inputs[index] as HTMLInputElement;
        const keypad = field.keypad && locateKeypad(document, field.keypad, input);
        return keypad && besideKeypad(keypad, input) ? keypad : undefined;
      };
      const keypads = step.fields.map((field, index) =>
        field.keypad ? (keypadOf(index) ?? null) : undefined,
      );
      if (keypads.includes(null)) return fail("structural-mismatch", "keypad-missing");
      // A split code's digits and an effectful fill's event never go through a keypad.
      if (keypads.some(Boolean) && (command.code || step.effect !== "prepare"))
        return fail("structural-mismatch", "unsupported-input");
      if (
        command.values.length !== step.fields.length ||
        step.fields.some(
          (field) => command.values.filter((entry) => entry.slot === field.slot).length !== 1,
        )
      )
        return fail("structural-mismatch", "unexpected-values");
      // Each field has its own input: two locators that name one input would leave only
      // the second value in it, and the form would be sent with the wrong value.
      if (new Set(inputs).size !== inputs.length)
        return fail("structural-mismatch", "fields-shared");
      // One step fills one form (or only inputs outside any form), and secrets only fit their inputs.
      const writableInputs = inputs as Control[];
      const form = formOf(writableInputs[0]!);
      if (writableInputs.some((input) => formOf(input) !== form))
        return fail("structural-mismatch", "fields-split");
      // The form sends its values only to this document's origin, or to a destination
      // the background allows (ADR 0051).
      // Passive fills leave submission to the person. Every submitter, including a
      // hidden/default button or an externally associated image input, can receive
      // these values through its formaction and must be checked before filling.
      const fillDestinations = () =>
        operation.signInFill
          ? [
              ...writableInputs.flatMap((input) => formDestinations(input, "fill")),
              ...submitterDestinations(writableInputs),
            ]
          : formDestinations(writableInputs[0]!, "fill");
      const destinationSnapshot = JSON.stringify(fillDestinations());
      const passiveDestinationsCurrent = () =>
        !operation.signInFill || JSON.stringify(fillDestinations()) === destinationSnapshot;
      const formRefused = await destinationRefusal(fillDestinations);
      if (formRefused === "document-cancelled" || formRefused === "operation-expired")
        return fail("cancelled", formRefused);
      if (formRefused) return fail("structural-mismatch", formRefused);
      if (
        step.fields.some(
          (field, index) =>
            !acceptsSecret(
              writableInputs[index]!,
              command.values.find((entry) => entry.slot === field.slot)!.secret,
            ),
        )
      )
        return fail("structural-mismatch", "secret-refused");
      // A secret goes only to the account the page shows, when it shows one (owner
      // decision, 2026-10-11). The comparison stays in this content script. A page that
      // showed no identifier yet is compared just before the next click instead
      // (`deferredAccount`, ADR 0049 amendment of 2026-11-03).
      if (command.account) {
        if (deferLater) {
          const earlier = state.deferredAccount;
          if (earlier) earlier.username = "";
          state.deferredAccount = {
            username: command.account.username,
            masked,
            form,
            inputs: [...(earlier?.inputs ?? []), ...writableInputs],
            ...(command.accountSwitch ? { accountSwitch: command.accountSwitch } : {}),
            ...(command.otherSwitch ? { otherSwitch: true as const } : {}),
          };
          command.account.username = "";
        } else {
          const other = showsOtherAccount(formAccounts(document, form), command.account.username, {
            masked,
          });
          command.account.username = "";
          if (other) return otherAccount(command);
        }
      }
      // A `totp` handler without a button types its code as the submission: the page
      // submits it once it is in (ADR 0027 amendment of 2026-10-23).
      const buttonless =
        command.code !== undefined &&
        command.code.submit === undefined &&
        step.effect === "submit" &&
        step.fields.length === 1;
      // A `totp` handler's code split into one input per digit goes in one digit per
      // input (ADR 0027, owner decision 2026-10-12 19:21 UTC). An input the page's
      // description leaves out, as a honeypot hidden from assistive technology, moved
      // off the screen, transparent or tiny, is not counted, as the service never saw it
      // (ADR 0027 amendment of 2026-11-07).
      const codeStep =
        command.code !== undefined &&
        (step.effect === "prepare" || buttonless) &&
        step.fields.length === 1;
      const described = (input: HTMLInputElement) =>
        writable(input) && presence(input) === "visible";
      const split = codeStep
        ? splitCodeInputs(
            writableInputs[0] as HTMLInputElement,
            command.values[0]!.value.length,
            described,
          )
        : undefined;
      // Nor is a code typed whole into the first of inputs that would split a code once
      // the form's other inputs are left out, or that split a code of another length, as
      // the item's code for a site that asks for more or fewer digits: that input keeps
      // one digit.
      if (
        codeStep &&
        !split &&
        [6, 7, 8].some((length) =>
          splitCodeInputs(
            writableInputs[0] as HTMLInputElement,
            length,
            (input) => described(input) && unmarkedDigit(input),
          ),
        )
      )
        return fail("value-mismatch");
      // Which shape its digits keep is decided once, from its inputs as found: one-digit
      // inputs the TOTP fill rule takes, or the shape without `maxlength`.
      const unmarked =
        split !== undefined &&
        !split.every((digit) => digit.maxLength === 1 && acceptsSecret(digit, "otp"));
      const fits = (input: Control, value: (typeof command.values)[number]) =>
        split
          ? split.every(
              (digit, index) => inputValueMismatch(digit, value.value[index]!) === undefined,
            )
          : fitsControl(input, value);
      // Every value must fit its input before anything is filled (ADR 0010).
      if (
        step.fields.some(
          (field, index) =>
            !fits(
              writableInputs[index]!,
              command.values.find((entry) => entry.slot === field.slot)!,
            ),
        )
      )
        return fail("value-mismatch");
      // A keypad that already shows its keys must show exactly one for each character of
      // its value before anything is typed, in any field (ADR 0067). One that
      // opens when its field is pressed is checked once it opens.
      if (
        step.fields.some((field, index) => {
          const keypad = keypads[index];
          const value = command.values.find((entry) => entry.slot === field.slot)!.value;
          return keypad && keypadOpen(keypad) && !keypadCovers(keypad, value);
        })
      )
        return fail("value-mismatch", "keypad-key-missing");
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
      if (!setter) return fail("structural-mismatch", "unsupported-input");
      // Messages already shown are not the page's answer to this fill.
      const baseline =
        step.effect === "prepare" ? fillBaseline(split ?? writableInputs) : undefined;
      // A code field fills alone; its watch starts before the code goes in (ADR 0027).
      const code =
        command.code?.submit && step.effect === "prepare" && step.fields.length === 1
          ? watchCodeSubmission(
              writableInputs[0] as HTMLInputElement,
              step.fields[0]!.target,
              command.code.submit,
              step.path,
            )
          : undefined;
      if (command.code && !code && !buttonless)
        return fail("structural-mismatch", "code-watch-failed");
      // Once the code's last character went in, the page has it: a page that then disables,
      // clears or removes the input, or leaves the path, has taken the code. A character the
      // page kept out of an input it still shows as it was refuses the code as before.
      let codeIn = false;
      const lastIn = () => {
        codeIn = true;
      };
      const taken = (input: Control, stopped: string) =>
        codeIn &&
        (stopped !== "refused" || !input.isConnected || !writable(input) || input.value === "");
      try {
        if (operation.signInFill) {
          // DOM/account readiness can await the page after the first authorization.
          // Recheck current authority and the full destination snapshot before mutation.
          const stillAuthorized: unknown = await sendMessage("login", {
            version: 1,
            type: "login.operation.authorize",
            token: state.token,
            attemptId: operation.attemptId,
            operationId: operation.operationId,
          }).catch(() => undefined);
          if (stillAuthorized !== true) return fail("cancelled", "not-authorized");
          if (!passiveDestinationsCurrent()) return fail("cancelled", "form-changed");
          if (!fillEditsReady(window)) return fail("cancelled", "document-cancelled");
        }
        for (const [index, field] of step.fields.entries()) {
          const input = inputs[index] as Control;
          // A preparing fill lets the page's handlers for the previous field run first.
          // eslint-disable-next-line no-await-in-loop
          if (index > 0 && step.effect === "prepare") await nextFrame();
          // Each mutation repeats scope/connected checks; events and the wait between
          // fields may change the page.
          const current = matches(field.target);
          const value = command.values.find((entry) => entry.slot === field.slot)!;
          if (!passiveDestinationsCurrent()) return fail("cancelled", "form-changed");
          if (
            nativeCancelled() ||
            pagePath() !== step.path ||
            current.length !== 1 ||
            current[0] !== input ||
            !usable(input, index) ||
            formOf(input) !== form ||
            !acceptsSecret(input, value.secret) ||
            !fits(input, value)
          )
            return fail(
              "cancelled",
              nativeCancelled()
                ? "document-cancelled"
                : pagePath() !== step.path
                  ? "page-changed"
                  : "field-changed",
            );
          if (
            operation.signInFill &&
            (input.value !== "" ||
              !claimFill(window, input, operation.attemptId, operation.stepIndex, field.slot))
          ) {
            value.value = "";
            continue;
          }
          // An advance's next step is measured in this task, just before its first input,
          // and so is what the page shows before an effect (ADR 0029).
          if (index === 0) {
            measureNext();
            if (step.effect !== "prepare")
              state.submitted = submittedPage(
                document,
                writableInputs.filter((entry) => entry instanceof HTMLInputElement),
              );
          }
          // Mark uncertainty before calling into DOM/page code, including a throwing setter.
          mutated = true;
          if (
            !state.shownBefore &&
            (!state.submitsTaken || writableInputs.every((other) => !other.value))
          ) {
            for (const other of queryAll(document, "button, input"))
              if (submitButton(other) && visible(other)) state.submitsBefore.add(other);
            state.submitsTaken = true;
          }
          state.shownBefore ??= new WeakSet(
            queryAll<HTMLInputElement>(document, "input").filter(
              (other) => other.type === "password" && writable(other),
            ),
          );
          if (split) {
            // As typed: the code is in with its last digit.
            for (const [place, digit] of split.entries()) {
              // eslint-disable-next-line no-await-in-loop
              if (place > 0) await nextFrame();
              // The page's handlers for an earlier digit may have changed this input; the
              // same checks run after each wait of the digit's own typing.
              const scope = () =>
                nativeCancelled()
                  ? "document-cancelled"
                  : pagePath() !== step.path
                    ? "page-changed"
                    : !writable(digit) ||
                        formOf(digit) !== form ||
                        !(unmarked
                          ? value.secret === "otp" && unmarkedDigit(digit)
                          : digit.maxLength === 1 && acceptsSecret(digit, value.secret)) ||
                        inputValueMismatch(digit, value.value[place]!) !== undefined
                      ? "field-changed"
                      : undefined;
              const changed = scope();
              if (changed) return fail("cancelled", changed);
              state.filled.add(digit);
              // eslint-disable-next-line no-await-in-loop
              const stopped = await typeValue(digit, value.value[place]!, setter, {
                beforeInput:
                  place === split.length - 1 ? (buttonless ? lastIn : code?.typed) : undefined,
                between: scope,
              });
              // A page that took the code with its last digit may change or clear its
              // form at once; the code watch says so first.
              if (stopped && code?.submitted()) return fail("submitted");
              if (stopped && taken(digit, stopped)) break;
              // A digit the page kept out is never followed by the rest.
              if (stopped === "refused") return fail("fill-rejected", "typed-refused", index);
              if (stopped) return fail("cancelled", stopped);
            }
          } else if (keypads[index]) {
            // One press per character on the page's keypad (ADR 0067); a stop is
            // never followed by another press. A keypad field passed `keyable`, so it is
            // an input, never a split date's select.
            const keyed = input as HTMLInputElement;
            state.filled.add(keyed);
            let pressed = false;
            // eslint-disable-next-line no-await-in-loop
            const stopped = await typeOnKeypad(keyed, value.value, () => keypadOf(index), {
              stop: state.waits.signal,
              // The background learns of the presses before the first one, so only a
              // page replaced after it may count as the page's own submission.
              beforePress: async () =>
                (await sendMessage("login", {
                  version: 1,
                  type: "login.keypad.press",
                  token: state.token,
                  attemptId: operation.attemptId,
                  operationId: operation.operationId,
                })) === true
                  ? undefined
                  : ("not-authorized" as const),
              onPress: () => {
                pressed = true;
                keyPressed = true;
              },
              // A keypad the page redrew is looked up again for each press; the field
              // must stay the same input.
              between: () => {
                if (nativeCancelled()) return "document-cancelled";
                if (pagePath() !== step.path) return "page-changed";
                if (!input.isConnected) return "field-gone";
                const now = matches(field.target);
                return now.length !== 1 ||
                  now[0] !== input ||
                  !keyable(input) ||
                  formOf(input) !== form
                  ? "field-changed"
                  : undefined;
              },
            });
            if (stopped === "refused") return fail("fill-rejected", "typed-refused", index);
            // The field was pressed to open its keypad before a key was missing, so even
            // without a key press the page may have changed (`mutated`).
            if (stopped === "key-missing" || stopped === "keypad-closed")
              return fail("structural-mismatch", "keypad-key-missing");
            // A page that moved, or took the field out of the document, after a press may
            // have taken the characters so far as the whole value and submitted them, as
            // a PIN pad that submits at its last digit: never a cancellation that could
            // type again. A field the page only redrew or hid is no submission; the stop
            // keeps `keypad-pressed`, and the person is told to reload.
            if (pressed && (stopped === "page-changed" || stopped === "field-gone"))
              return fail("submitted");
            if (stopped === "field-gone") return fail("cancelled", "field-changed");
            if (stopped) return fail("cancelled", stopped);
          } else if (step.effect === "prepare" || buttonless) {
            // A `detail` handler's input is chosen by its radio button first (ADR 0061);
            // the page's handlers for that click may change the form, so the checks run
            // again.
            if (
              command.choose &&
              (!chooseFor(input) ||
                nativeCancelled() ||
                pagePath() !== step.path ||
                !isOnly(matches(field.target), input) ||
                !takes(input, value.secret) ||
                !acceptsSecret(input, value.secret) ||
                !stillAsks(input, value.question))
            )
              return fail("cancelled", "field-changed");
            if (input instanceof HTMLInputElement) state.filled.add(input);
            // The code goes in now; the page's own reaction is measured from here. The
            // page may change between characters, so each one repeats the checks. A
            // split date's select gets its option instead (ADR 0061).
            // eslint-disable-next-line no-await-in-loop
            const stopped = await enter(
              input,
              value,
              setter,
              {
                beforeInput: buttonless ? lastIn : code?.typed,
                between: () => {
                  if (nativeCancelled()) return "document-cancelled";
                  if (!passiveDestinationsCurrent()) return "form-changed";
                  if (operation.signInFill && !fillUntouched(window, input)) return "field-changed";
                  if (pagePath() !== step.path) return "page-changed";
                  const now = matches(field.target);
                  return now.length !== 1 ||
                    now[0] !== input ||
                    !takes(input, value.secret) ||
                    formOf(input) !== form ||
                    !acceptsSecret(input, value.secret) ||
                    !fits(input, value)
                    ? "field-changed"
                    : undefined;
                },
              },
              (option) => state.chosen.push([input as HTMLSelectElement, option]),
            );
            if (stopped && code?.submitted()) return fail("submitted");
            // A value the page kept a character of out is never submitted.
            if (stopped && !taken(input, stopped)) {
              if (stopped === "refused") return fail("fill-rejected", "typed-refused", index);
              return fail("cancelled", stopped);
            }
          } else {
            // An advance or a submission through the page's own event gets that one event
            // alone, with no focus, keys or blur that could run its effect again.
            if (!(input instanceof HTMLInputElement))
              return fail("structural-mismatch", "unsupported-input");
            state.filled.add(input);
            setter.call(input, value.value);
            input.dispatchEvent(new Event(step.event!, { bubbles: true }));
          }
          value.value = "";
        }
        // A fill that submits through its own event ends what the next click checks.
        if (step.effect !== "prepare") {
          state.filled = new WeakSet();
          state.chosen = [];
          state.shownBefore = undefined;
        }
        // A code page that submits the code by itself must not get a click as well: the
        // button is clicked only when nothing showed a submission during the watch. Its
        // status regions may announce that submission, so only alerts and the field's own
        // marks reject the code (ADR 0027).
        if (code && baseline) {
          const until = Date.now() + CODE_SETTLE_MS;
          while (!nativeCancelled() && Date.now() < until) {
            if (code.submitted()) return fail("submitted");
            // eslint-disable-next-line no-await-in-loop
            await pause(50);
          }
          if (nativeCancelled()) return fail("cancelled", "document-cancelled");
          if (code.submitted()) return fail("submitted");
          const rejection = fillRejection(split ?? writableInputs, baseline, { statuses: false });
          if (rejection)
            return fail(
              "fill-rejected",
              rejection.detail,
              rejection.fieldIndex === undefined ? undefined : split ? 0 : rejection.fieldIndex,
            );
          return { ok: true, mutation: "possible" };
        }
        // A preparing fill is followed by a click; the page's own validation must accept
        // the values first. An effectful fill has already submitted through its event.
        if (baseline) {
          await pause(fillSettleMs);
          if (nativeCancelled()) return fail("cancelled", "document-cancelled");
          // The page replaced the form, perhaps signing in by itself; the background
          // observes the page instead of clicking.
          if (writableInputs.some((input) => !input.isConnected))
            return fail("structural-mismatch", "form-replaced");
          // A page that cleared a filled, still writable input changed its form. Repair
          // that structure before reading required/ARIA/feedback as a rejected value.
          if (
            writableInputs.some(
              (input) => input instanceof HTMLInputElement && input.value === "" && writable(input),
            )
          )
            return fail("structural-mismatch", "form-changed");
          const rejection = fillRejection(writableInputs, baseline);
          if (rejection) return fail("fill-rejected", rejection.detail, rejection.fieldIndex);
        }
        return { ok: true, mutation: "possible" };
      } finally {
        code?.stop();
      }
    }
    if (command.values.length) return fail("structural-mismatch", "unexpected-values");
    if (step.kind === "click" && step.press === "enter")
      return await pressEnter(step.target, step.purpose === "submit");
    if (step.kind === "click") {
      const waited = await deferredLoad();
      if (waited) return waited;
      let element: HTMLElement | undefined;
      if (command.list) {
        // A chooser's click on its list goes where the list's choice is now (ADR 0028).
        const choice = listChoice(document, command.list);
        command.list.username = "";
        command.list.others.fill("");
        element = choice.click === command.list.click ? choice.element : undefined;
        if (!element) return fail("structural-mismatch", "target-missing");
      } else {
        // A control named by its accessible name may be a link to a fragment of the page
        // only as a `password` handler's button (ADR 0048 amendment of 2026-10-19); a route
        // step's click by that name presses a native button alone (ADR 0048 amendment of
        // 2026-10-23).
        const named = step.target.by === "accessible-name";
        const fragment = named && command.passwordChoice === true;
        const found = matches(step.target);
        const only = found.length === 1 ? found[0] : undefined;
        if (!clickable(only, { fragment }) || (named && !command.passwordChoice && !isButton(only)))
          return fail("structural-mismatch", "target-missing");
        // A `password` handler's button whose text no longer names the password, as one
        // the page rendered again with other text, is never pressed (ADR 0048).
        if (command.passwordChoice && !passwordChoice(only, { fragment }))
          return fail("structural-mismatch", "target-missing");
        // Likewise an `authenticator` handler's button whose text no longer names an
        // authenticator app's code (ADR 0081).
        if (command.authenticatorChoice && !authenticatorChoice(only))
          return fail("structural-mismatch", "target-missing");
        element = only;
      }
      // A click that submits a form sends it, through the button's own `formaction` too,
      // only to this document's origin or a destination the background allows (ADR 0051),
      // also when the element sits inside the submit button or labels it. Any other click
      // submits no form.
      const clicked = element;
      const submitRefused = await destinationRefusal(() => clickDestinations(clicked));
      if (submitRefused === "document-cancelled" || submitRefused === "operation-expired")
        return fail("cancelled", submitRefused);
      if (submitRefused) return fail("structural-mismatch", submitRefused);
      // The click's form's inputs, or the page's for an element outside a form.
      const form = isButton(element)
        ? formOf(element)
        : (closestAcross(element, "form") as HTMLFormElement | null);
      const formInputs = form
        ? inputsOf(form, document)
        : queryAll<HTMLInputElement>(document, "input");
      const fills = state.filled;
      const choices = state.chosen;
      const passwordsBefore = state.shownBefore;
      // The next fills are checked against the next click.
      state.filled = new WeakSet();
      state.chosen = [];
      state.shownBefore = undefined;
      // A select a split date's part was chosen in must still show that option, which
      // the form-change check below cannot read (ADR 0061).
      if (
        choices.some(
          ([select, option]) => !select.isConnected || select.selectedOptions[0] !== option,
        )
      )
        return fail("cancelled", "field-changed");
      // A keypad field Pateat filled is read-only, and still a sign-in input of the form
      // (ADR 0067).
      const keyed = new Set(
        formInputs.filter((input) => !writable(input) && fills.has(input) && keyable(input)),
      );
      const signIn = (input: HTMLInputElement) => writable(input) || keyed.has(input);
      // The page changed the form under the fill: never send it without its values.
      if (
        unreadyForm(formInputs, {
          filled: (input) => fills.has(input),
          shownBefore: (input) => passwordsBefore?.has(input) === true,
          writable: signIn,
          submit: step.purpose === "submit",
        })
      )
        return fail("structural-mismatch", "form-changed");
      const other = deferredOther(step.purpose === "submit");
      if (other) return other;
      // An advance's next step is measured in this task, just before the click, and so
      // is what the page shows before it (ADR 0029).
      measureNext();
      state.submitted = submittedPage(document, formInputs.filter(signIn), keyed);
      // A CAPTCHA the page shows and that has not passed is left to the person, who
      // presses the button after solving it; the background reads the page as after a
      // click (ADR 0029, S4).
      if (!command.list && showsCaptcha(document) && !passedCaptcha(document))
        return fail("captcha");
      mutated = true;
      // The page may change between the press's events, as the fill's checks allow for:
      // a press the page stopped after `pointerdown` may have acted as the click, so it is
      // answered as made; one the moving events already stopped clicked nothing.
      const pressing = () =>
        !nativeCancelled() && pagePath() === step.path && Date.now() < operation.expiresAt;
      if ((await pressElement(element, pressing)) === "missed")
        return nativeCancelled()
          ? fail("cancelled", "document-cancelled")
          : pagePath() !== step.path
            ? fail("cancelled", "page-changed")
            : Date.now() >= operation.expiresAt
              ? fail("cancelled", "operation-expired")
              : fail("structural-mismatch", "target-missing");
      return { ok: true, mutation: "possible" };
    }
    // An element that must be missing counts every copy, hidden or not, as a marker's
    // `absent` element does (ADR 0037 amendment of 2026-10-22).
    const satisfied = () => {
      const count = findTargets(document, step.target, { hidden: !step.present }).length;
      return step.present ? count === 1 : count === 0;
    };
    if (step.kind === "assert")
      return satisfied()
        ? { ok: true, mutation: "none" }
        : fail("structural-mismatch", "assert-failed");
    const until = Math.min(operation.expiresAt, Date.now() + step.timeoutMs);
    // Cancellation is set by the independent background message listener.
    while (!nativeCancelled() && Date.now() < until && pagePath() === step.path) {
      if (satisfied()) return { ok: true, mutation: "none" };
      // Check the current DOM serially, again at each change of the page; parallel checks
      // cannot observe later render states.
      // eslint-disable-next-line no-await-in-loop
      await pageChange(document, until, state.waits.signal);
    }
    // The page moving to another path ends the wait early; that is not a timeout.
    return nativeCancelled()
      ? fail("cancelled", "document-cancelled")
      : pagePath() !== step.path
        ? fail("timeout", "page-changed")
        : fail("timeout");
  })()
    // A thrown execution may already have mutated the page. Never advertise a safe retry.
    .then(
      (result) =>
        respond({
          ...result,
          ...(before && (result.ok || ("reason" in result && result.reason === "captcha"))
            ? { before }
            : {}),
          ...(siblingsBefore && (result.ok || ("reason" in result && result.reason === "captcha"))
            ? { siblingsBefore }
            : {}),
          operationId: command.operation.operationId,
          documentId: command.operation.document.documentId,
        }),
      () =>
        respond({
          ok: false,
          reason: "cancelled",
          detail: "threw",
          mutation: "possible",
          operationId: command.operation.operationId,
          documentId: command.operation.document.documentId,
        }),
    )
    .finally(() => {
      for (const entry of command.values) entry.value = "";
      if (command.account) command.account.username = "";
      if (command.list) {
        command.list.username = "";
        command.list.others.fill("");
      }
    });
  return true;
}
