import * as v from "valibot";
import { browser } from "wxt/browser";
import { senderDocumentOrigin } from "../../messaging/sender";
import {
  fillOnlyStep,
  passwordVariants,
  routeSteps,
  type LoginRecipe,
  type LoginOperation,
  type LoginStep,
  sameLoginDocument,
} from "@pateat/contracts";
import { newId } from "@pateat/contracts/ids";
import {
  awaitResultSchema,
  executionResultSchema,
  loginReadiness,
  LOGIN_STEP_WAIT_MS,
} from "../wire";
import { loginSecretKind, loginUsernameFieldId } from "../vault";
import { send } from "./attempt";
import { claimConfirm, hasConfirmClaim, type ConfirmWork } from "./confirm-state";
import {
  confirmCurrent,
  confirmPlan,
  confirmAccount,
  confirmReprompt,
  sameAuthority,
} from "./confirm-scope";
import { accountDestinationRefusal } from "./plan";
import { CONFIRM_ATTEMPT_PREFIX } from "../sign-in-fill-page";
import type { Runtime } from "./state";
import type { Sender } from "./types";

type Fill = Extract<LoginStep, { kind: "fill" }>;
/** A safe fill on this path; no button, keypad, code or effectful input is executable. */
export function confirmationSteps(
  recipe: LoginRecipe,
  path: string,
): { step: Fill; index: number }[] {
  return passwordVariants(recipe).flatMap((_, variant) => {
    const steps = routeSteps(recipe, { route: "password", variant });
    const index = steps.findIndex((step) => step.path === path && step.kind === "fill");
    const first = steps[index];
    const step = first && fillOnlyStep(first);
    return step?.kind === "fill" && step.effect === "prepare" ? [{ step, index }] : [];
  });
}

const slotsOf = (operation: LoginOperation) =>
  operation.step.kind === "fill" ? operation.step.fields.map((field) => field.slot) : [];

/** The document may ask about only the currently delivered confirmation operation. */
export async function authorizeConfirmation(
  rt: Runtime,
  request: { token: string; attemptId: string; operationId: string },
  sender: Sender,
  destination?: URL,
): Promise<boolean | undefined> {
  const work = sender.tab?.id === undefined ? undefined : rt.confirmFill.work.get(sender.tab.id);
  const operation = work?.operation;
  if (!work || !operation || operation.attemptId !== request.attemptId) return undefined;
  if (sender.id !== browser.runtime.id) return false;
  if (
    senderDocumentOrigin(sender) === undefined ||
    !sender.documentId ||
    sender.frameId === undefined ||
    // `sender.url` keeps the URL the document loaded with, while a single-page site's
    // route to its verification shows only in the tab's URL; the account check reads that.
    work.live.token !== request.token ||
    operation.operationId !== request.operationId ||
    !sameLoginDocument(operation.document, {
      tabId: sender.tab!.id!,
      frameId: sender.frameId,
      documentId: sender.documentId,
      origin: senderDocumentOrigin(sender)!,
    }) ||
    Date.now() >= operation.expiresAt ||
    operation.step.kind !== "fill" ||
    operation.step.effect !== "prepare" ||
    operation.step.fields.some((field) => field.keypad || field.slot === "totp")
  )
    return false;
  const recipe = work.recipe;
  if (!work.reprompted || !recipe || !(await confirmPlan(rt, work, recipe, slotsOf(operation))))
    return false;
  if (
    destination &&
    (await accountDestinationRefusal(
      rt,
      {
        origin: work.live.document.origin,
        account: work.parent.account,
        policyRevision: operation.policyRevision,
      },
      destination,
    ))
  )
    return false;
  const latest = await confirmPlan(rt, work, recipe, slotsOf(operation));
  return (
    latest !== undefined &&
    latest.fence() &&
    work.operation === operation &&
    Date.now() < operation.expiresAt
  );
}

/**
 * How a confirmation fill ended: `filled` or `kept` when the page took the operation,
 * having changed a field or kept every value it found; `stopped` when it could not go on;
 * `asked` while its master password window is open; `claimed` when this document's fill
 * on this path already ran, as before a worker restart, and is never repeated.
 */
export type ConfirmFillEnd = "filled" | "kept" | "stopped" | "asked" | "claimed";

const claimOf = (work: ConfirmWork, recipe: LoginRecipe, index: number) =>
  JSON.stringify([work.parent.id, work.live.document, work.live.path, recipe.id, index]);

// Variants are alternatives; reads and claims must stop before another can act.
/* eslint-disable no-await-in-loop */
export async function fillConfirmation(
  rt: Runtime,
  work: ConfirmWork,
  recipe: LoginRecipe,
): Promise<ConfirmFillEnd> {
  work.recipe = recipe;
  work.live.state = "watching";
  work.live.reason = "confirm-fill";
  const steps = confirmationSteps(recipe, work.live.path);
  if (steps.some(({ index }) => hasConfirmClaim(rt, claimOf(work, recipe, index))))
    return "claimed";
  const found = await confirmAccount(rt, work);
  if (!found) return "stopped";
  const reprompted = await confirmReprompt(rt, work, found);
  if (reprompted !== true) return reprompted || "stopped";
  work.reprompted = true;
  if (found.scope !== undefined) work.scopeMark = found.scope;
  work.policyRevision = found.snapshot.snapshot.revision;
  if (found.connection.snapshotId !== undefined) work.snapshotId = found.connection.snapshotId;
  for (const { step, index } of steps) {
    const slots = step.fields.map((field) => field.slot);
    const plan = await confirmPlan(rt, work, recipe, slots);
    if (!plan) continue;
    const ready = v.safeParse(
      awaitResultSchema,
      await send(rt, work.live, {
        type: "login.await",
        readiness: loginReadiness(step),
        timeoutMs: LOGIN_STEP_WAIT_MS,
      }).catch(() => undefined),
    );
    if (!ready.success || !ready.output.ok || !confirmCurrent(rt, work)) continue;
    if (!(await claimConfirm(rt, work, claimOf(work, recipe, index)))) return "stopped";
    const operation: LoginOperation = {
      version: 1,
      attemptId: CONFIRM_ATTEMPT_PREFIX + work.parent.id,
      operationId: newId(),
      document: work.live.document,
      policyRevision: work.policyRevision,
      stepIndex: index,
      step,
      signInFill: true,
      expiresAt: Date.now() + 15000,
    };
    const values: { slot: string; value: string; secret?: ReturnType<typeof loginSecretKind> }[] =
      [];
    let account: { username: string } | undefined;
    try {
      for (const field of step.fields) {
        const reference = plan.binding.slots.find((entry) => entry.slot === field.slot);
        if (!reference) return "stopped";
        const secret = loginSecretKind(plan.connection, plan.account.itemId, reference.fieldId);
        if (secret === "otp") return "stopped";
        const value = await rt.fields({
          account: plan.account,
          connection: plan.connection,
          fieldId: reference.fieldId,
        });
        if (!value || !confirmCurrent(rt, work)) return "stopped";
        values.push({ slot: field.slot, value, ...(secret ? { secret } : {}) });
      }
      const username = loginUsernameFieldId(plan.connection, plan.account.itemId);
      if (username) {
        const value = await rt.fields({
          account: plan.account,
          connection: plan.connection,
          fieldId: username,
        });
        if (!confirmCurrent(rt, work)) return "stopped";
        if (value) account = { username: value };
      }
      const latest = await confirmPlan(rt, work, recipe, slots);
      if (!latest || !sameAuthority(plan, latest) || !latest.fence() || !plan.fence())
        return "stopped";
      work.operation = operation;
      const response = v.safeParse(
        executionResultSchema,
        await send(rt, work.live, {
          type: "login.execute",
          operation,
          values,
          ...(account ? { account } : {}),
        }).catch(() => undefined),
      );
      if (!confirmCurrent(rt, work)) return "stopped";
      const ok =
        response.success &&
        response.output.ok &&
        response.output.operationId === operation.operationId &&
        response.output.documentId === work.live.document.documentId;
      // The evaluation row is logged once, with the page's fields, by the admission.
      if (!ok) return "stopped";
      return response.output.mutation === "none" ? "kept" : "filled";
    } finally {
      for (const value of values) value.value = "";
      if (account) account.username = "";
      delete work.operation;
    }
  }
  return "stopped";
}

/* eslint-enable no-await-in-loop */
