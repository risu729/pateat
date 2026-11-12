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
import { send, publish, report } from "./attempt";
import { claimConfirm, type ConfirmWork } from "./confirm-state";
import { confirmCurrent, confirmPlan, confirmAccount, confirmReprompt } from "./confirm-scope";
import { accountDestinationRefusal } from "./plan";
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
    !sender.url ||
    work.live.token !== request.token ||
    operation.operationId !== request.operationId ||
    !sameLoginDocument(operation.document, {
      tabId: sender.tab!.id!,
      frameId: sender.frameId,
      documentId: sender.documentId,
      origin: senderDocumentOrigin(sender)!,
    }) ||
    sender.url !== work.live.url ||
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

// Variants are alternatives; reads and claims must stop before another can act.
/* eslint-disable no-await-in-loop */
export async function fillConfirmation(rt: Runtime, work: ConfirmWork, recipe: LoginRecipe) {
  work.recipe = recipe;
  work.live.state = "watching";
  work.live.reason = "confirm-fill-stopped";
  const found = await confirmAccount(rt, work);
  if (!found || !(await confirmReprompt(rt, work, found))) return;
  work.reprompted = true;
  if (found.scope !== undefined) work.scopeMark = found.scope;
  work.policyRevision = found.snapshot.snapshot.revision;
  if (found.connection.snapshotId !== undefined) work.snapshotId = found.connection.snapshotId;
  for (const { step, index } of confirmationSteps(recipe, work.live.path)) {
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
    const claim = JSON.stringify([
      work.parent.id,
      work.live.document,
      work.live.path,
      recipe.id,
      index,
    ]);
    if (!(await claimConfirm(rt, work, claim))) return;
    const operation: LoginOperation = {
      version: 1,
      attemptId: "confirm:" + work.parent.id,
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
        if (!reference) return;
        const secret = loginSecretKind(plan.connection, plan.account.itemId, reference.fieldId);
        if (secret === "otp") return;
        const value = await rt.fields({
          account: plan.account,
          connection: plan.connection,
          fieldId: reference.fieldId,
        });
        if (!value || !confirmCurrent(rt, work)) return;
        values.push({ slot: field.slot, value, ...(secret ? { secret } : {}) });
      }
      const username = loginUsernameFieldId(plan.connection, plan.account.itemId);
      if (username) {
        const value = await rt.fields({
          account: plan.account,
          connection: plan.connection,
          fieldId: username,
        });
        if (!confirmCurrent(rt, work)) return;
        if (value) account = { username: value };
      }
      const latest = await confirmPlan(rt, work, recipe, slots);
      if (
        !latest ||
        JSON.stringify(latest) !== JSON.stringify(plan) ||
        !latest.fence() ||
        !plan.fence()
      )
        return;
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
      if (!confirmCurrent(rt, work)) return;
      const ok =
        response.success &&
        response.output.ok &&
        response.output.operationId === operation.operationId &&
        response.output.documentId === work.live.document.documentId;
      work.live.reason = ok ? "confirm-fill" : "confirm-fill-stopped";
      work.live.state = "watching";
      await publish(rt, work.live);
      report(rt, work.live.document, {
        type: "refused",
        tabId: work.live.document.tabId,
        origin: recipe.origin,
        reason: "not-started",
        detail: work.live.reason,
        recipeId: recipe.id,
        recipeRevision: recipe.revision,
        pageKind: recipe.pageKind,
      });
      return;
    } finally {
      for (const value of values) value.value = "";
      if (account) account.username = "";
      delete work.operation;
    }
  }
}

/* eslint-enable no-await-in-loop */
