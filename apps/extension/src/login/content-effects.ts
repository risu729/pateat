import * as v from "valibot";
import { type LoginTarget } from "@pateat/contracts";
import { containsAcross, formOf, inputsOf, queryAll } from "../page/shadow";
import { writable } from "../page/target-state";
import { unreadyForm } from "../page/fill-checks";
import {
  clickDestinations,
  formDestinations,
  type FormDestination,
} from "../page/form-destination";
import { nodeProperty } from "../page/form-native";
import { passedCaptcha, showsCaptcha, submittedPage } from "../page/sign-in-state";
import { sendMessage } from "../messaging/protocol";
import { destinationAnswerSchema, type ExecutionDetail } from "./wire";
import type { ContentState } from "./content-state";
import type { ExecuteCommand } from "./content-command";
import { pagePath, matches, submitButton } from "./content-dom";

export interface EffectChecks {
  nativeCancelled: () => boolean;
  fail: (
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
  ) => {
    ok: boolean;
    reason: string;
    detail?: ExecutionDetail;
    fieldIndex?: number;
    mutation: string;
  };
  destinationRefusal: (read: () => FormDestination[]) => Promise<ExecutionDetail | undefined>;
  deferredLoad: () => Promise<ReturnType<EffectChecks["fail"]> | undefined>;
  deferredOther: (submit: boolean) => ReturnType<EffectChecks["fail"]> | undefined;
  measureNext: () => void;
  markMutated: () => void;
}
export function createDestinationCheck(
  state: Pick<ContentState, "token">,
  operation: ExecuteCommand["operation"],
  nativeCancelled: EffectChecks["nativeCancelled"],
) {
  return async (read: () => FormDestination[]): Promise<ExecutionDetail | undefined> => {
    const destinations = read();
    if (destinations.some((entry) => entry.kind === "refused")) return "form-off-origin";
    const answers = await Promise.all(
      destinations.flatMap((entry) =>
        entry.kind === "other-origin"
          ? [
              sendMessage("login", {
                version: 1,
                type: "login.destination.check",
                token: state.token,
                attemptId: operation.attemptId,
                operationId: operation.operationId,
                destination: entry.url,
              })
                // A worker that cannot answer, as while it restarts, leaves it unchecked.
                .catch(() => undefined)
                .then((answer) => v.safeParse(destinationAnswerSchema, answer)),
            ]
          : [],
      ),
    );
    if (nativeCancelled()) return "document-cancelled";
    if (Date.now() >= operation.expiresAt) return "operation-expired";
    if (answers.some((answer) => !answer.success)) return "form-destination-unchecked";
    const refusals = answers.flatMap((answer) =>
      answer.success && !answer.output.ok ? [answer.output.reason] : [],
    );
    if (refusals.some((reason) => reason !== "unchecked")) return "form-off-origin";
    if (refusals.length) return "form-destination-unchecked";
    if (JSON.stringify(read()) !== JSON.stringify(destinations)) return "form-changed";
    return undefined;
  };
}
export function createEnterPress(
  state: Pick<ContentState, "filled" | "shownBefore" | "submitsBefore" | "submitted">,
  step: ExecuteCommand["operation"]["step"],
  {
    deferredLoad,
    fail,
    destinationRefusal,
    deferredOther,
    measureNext,
    markMutated,
  }: Pick<
    EffectChecks,
    "deferredLoad" | "fail" | "destinationRefusal" | "deferredOther" | "measureNext" | "markMutated"
  >,
) {
  return async (target: LoginTarget, submit: boolean) => {
    const waited = await deferredLoad();
    if (waited) return waited;
    const found = matches(target);
    const field = found.length === 1 ? found[0] : undefined;
    const form = writable(field) ? formOf(field) : null;
    if (!writable(field) || !state.filled.has(field) || !form)
      return fail("structural-mismatch", "target-missing");
    // The first submit button of the form (`formOf`, a component's across its host) in
    // composed order; `form.elements` leaves out image inputs and components' buttons.
    const defaultButton = () =>
      queryAll(document, "button, input").find(
        (element): element is HTMLButtonElement | HTMLInputElement =>
          submitButton(element) && formOf(element) === form,
      );
    const button = defaultButton();
    if (
      button &&
      (button.matches(":disabled") ||
        state.submitsBefore.has(button) ||
        !containsAcross(form, button))
    )
      return fail("structural-mismatch", "target-missing");
    // Named controls hide a form's own members, inherited ones too (`form-native.ts`).
    if (
      !Element.prototype.hasAttribute.call(form, "novalidate") &&
      !button?.formNoValidate &&
      !HTMLFormElement.prototype.checkValidity.call(form)
    )
      return fail("fill-rejected", "form-invalid");
    const refused = await destinationRefusal(() =>
      button ? clickDestinations(button) : formDestinations(field, "fill"),
    );
    if (refused === "document-cancelled" || refused === "operation-expired")
      return fail("cancelled", refused);
    if (refused) return fail("structural-mismatch", refused);
    if (pagePath() !== step.path) return fail("cancelled", "page-changed");
    // The page may have changed the form while the background answered.
    if (
      !nodeProperty(form, "isConnected") ||
      formOf(field) !== form ||
      defaultButton() !== button ||
      button?.matches(":disabled")
    )
      return fail("structural-mismatch", "form-changed");
    const formInputs = inputsOf(form, document);
    const fills = state.filled;
    const passwordsBefore = state.shownBefore;
    state.filled = new WeakSet();
    state.shownBefore = undefined;
    if (
      unreadyForm(formInputs, {
        filled: (input) => fills.has(input),
        shownBefore: (input) => passwordsBefore?.has(input) === true,
        writable,
        submit,
      })
    )
      return fail("structural-mismatch", "form-changed");
    const other = deferredOther(submit);
    if (other) return other;
    measureNext();
    state.submitted = submittedPage(document, formInputs.filter(writable));
    if (showsCaptcha(document) && !passedCaptcha(document)) return fail("captcha");
    markMutated();
    if (button) button.click();
    else HTMLFormElement.prototype.requestSubmit.call(form);
    return { ok: true, mutation: "possible" } as const;
  };
}
