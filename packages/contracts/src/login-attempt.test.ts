import { describe } from "vitest";
import { createAttemptMetadata, transitionLoginAttempt } from "./login-attempt";
import { type LoginDocument, type LoginRecipe } from "./login";
import { registerAttemptIdentity } from "../test/login-attempt/identity";
import { registerSubmissionIntents } from "../test/login-attempt/submission-intents";
import { registerSubmissionResults } from "../test/login-attempt/submission-results";
import { registerSubmissionValues } from "../test/login-attempt/submission-values";
import {
  registerSecondFactorHandlers,
  registerTotpHandler,
  registerDetailHandler,
} from "../test/login-attempt/handlers";
import {
  registerPasswordVariants,
  registerPasskeyRoute,
  registerTotpContracts,
  registerPasskeyRouteChanges,
} from "../test/login-attempt/routes";
import {
  registerRecipeContinuations,
  registerContinuationGuards,
  registerReplacedAdvances,
} from "../test/login-attempt/continuations";
import {
  registerChooserAttempts,
  registerWatchedAttempts,
} from "../test/login-attempt/watched-logins";
import { registerPasswordStopGuards } from "../test/login-attempt/password-stop-guards";
import { registerPasswordStopPasskeys } from "../test/login-attempt/password-stop-passkeys";
import { registerPasswordStopContinuations } from "../test/login-attempt/password-stop-continuations";
import { registerLaterSteps } from "../test/login-attempt/later-steps";
import { registerAttemptTiming } from "../test/login-attempt/timing";
import { registerLayoutChanges } from "../test/login-attempt/layouts";

const facts = { password: true, totp: false, passkey: false, discoverablePasskey: false };
const document: LoginDocument = {
  origin: "https://bank.example",
  tabId: 7,
  frameId: 2,
  documentId: "document-one",
};
const recipe: LoginRecipe = {
  version: 1,
  id: "synthetic-login",
  revision: 2,
  origin: document.origin,
  pageKind: "sign-in",
  slots: ["password"],
  steps: [
    {
      kind: "fill",
      effect: "prepare",
      path: "/login",
      fields: [{ slot: "password", target: { by: "id", value: "password" } }],
    },
    { kind: "click", path: "/login", target: { by: "id", value: "login" }, purpose: "submit" },
  ],
  completion: [{ target: { by: "id", value: "authenticated" } }],
  rejection: { by: "id", value: "rejected" },
  maxSubmissions: 1,
};

/** A login that took no time before it started. */
const noTimeBefore = { since: 0, serviceMs: 0, networkMs: 0, personMs: 0, pageMs: 0 };

function detected(selected = recipe) {
  return createAttemptMetadata({
    timing: noTimeBefore,
    id: "attempt-one",
    recipe: selected,
    policyRevision: 3,
    account: { origin: document.origin, connectionId: "demo-personal", itemId: "primary" },
    choice: { route: "password", variant: 0 },
    facts,
    document,
  });
}

function readyToClick() {
  let attempt = transitionLoginAttempt(detected(), { type: "RESOLVE" });
  attempt = transitionLoginAttempt(attempt, {
    type: "PREPARE",
    operationId: "fill-one",
    kind: "fill",
  });
  attempt = transitionLoginAttempt(attempt, { type: "MUTATION_INTENT", operationId: "fill-one" });
  return transitionLoginAttempt(attempt, { type: "OPERATION_OK", operationId: "fill-one" });
}

function submitting() {
  let attempt = transitionLoginAttempt(readyToClick(), {
    type: "PREPARE",
    operationId: "click-one",
    kind: "click",
  });
  return transitionLoginAttempt(attempt, { type: "SUBMIT_INTENT", operationId: "click-one" });
}

registerAttemptIdentity({ document, recipe, detected, readyToClick });

describe("submission and failure reconciliation", () => {
  registerSubmissionIntents({ facts, document, recipe, noTimeBefore, detected, submitting });

  registerSubmissionResults({ facts, document, recipe, noTimeBefore, detected, submitting });

  registerSubmissionValues({ document, recipe, detected });
});

registerSecondFactorHandlers({ facts, document, recipe, noTimeBefore, detected });

registerTotpHandler({ document, recipe, detected });

registerDetailHandler({ document, recipe, detected });

registerPasswordVariants({ facts, document, recipe, noTimeBefore });

registerPasskeyRoute({ facts, document, recipe, noTimeBefore });

registerTotpContracts({ document, recipe, detected });

registerRecipeContinuations({ document, recipe, detected, submitting });

registerContinuationGuards({ document, recipe, detected });

registerReplacedAdvances({ document, recipe, detected });

registerChooserAttempts({ facts, document, recipe, noTimeBefore });

registerWatchedAttempts({ facts, document, recipe, noTimeBefore });

registerPasskeyRouteChanges({ facts, document, recipe, noTimeBefore, readyToClick, submitting });

describe("a login that stops before a missing password (ADR 0036)", () => {
  const top: LoginDocument = { ...document, frameId: 0, documentId: "top-stop" };
  const id = (value: string) => ({ by: "id" as const, value });
  /** An identifier-first form: the email, Next, then the password and its button. */
  const emailFirst: LoginRecipe = {
    version: 1,
    id: "synthetic-email-first",
    revision: 1,
    origin: document.origin,
    pageKind: "sign-in",
    slots: ["username", "password"],
    steps: [
      {
        kind: "fill",
        effect: "prepare",
        path: "/signin",
        fields: [{ slot: "username", target: id("email") }],
      },
      { kind: "click", path: "/signin", target: id("next"), purpose: "advance" },
      {
        kind: "fill",
        effect: "prepare",
        path: "/password",
        fields: [{ slot: "password", target: id("password") }],
      },
      { kind: "click", path: "/password", target: id("login"), purpose: "submit" },
    ],
    handlers: [{ kind: "passkey", path: "/verify", target: id("use-key") }],
    maxSubmissions: 2,
  };
  const keyOnly = { password: false, totp: false, passkey: true, discoverablePasskey: false };
  /** A login of the item, stopping at `stopAt` unless it is `null`. */
  const create = (
    change: Partial<Parameters<typeof createAttemptMetadata>[0]> = {},
    stopAt: number | null = 2,
  ) =>
    createAttemptMetadata({
      timing: noTimeBefore,
      id: "attempt-stop",
      recipe: emailFirst,
      policyRevision: 3,
      account: { origin: document.origin, connectionId: "demo-personal", itemId: "primary" },
      choice: { route: "password", variant: 0 },
      facts: keyOnly,
      document: top,
      ...(stopAt === null ? {} : { stopAt }),
      ...change,
    });
  /** The identifier filled and Next clicked, its result still awaited. */
  function advanced(change: Partial<Parameters<typeof createAttemptMetadata>[0]> = {}) {
    let attempt = transitionLoginAttempt(create(change), { type: "RESOLVE" });
    attempt = transitionLoginAttempt(attempt, {
      type: "PREPARE",
      operationId: "fill-one",
      kind: "fill",
    });
    attempt = transitionLoginAttempt(attempt, { type: "MUTATION_INTENT", operationId: "fill-one" });
    attempt = transitionLoginAttempt(attempt, { type: "OPERATION_OK", operationId: "fill-one" });
    attempt = transitionLoginAttempt(attempt, {
      type: "PREPARE",
      operationId: "next-one",
      kind: "click",
      effect: "advance",
    });
    attempt = transitionLoginAttempt(attempt, { type: "SUBMIT_INTENT", operationId: "next-one" });
    return transitionLoginAttempt(attempt, { type: "SUBMITTED", operationId: "next-one" });
  }
  /** The password page showed: the login stands at its stop. */
  const atStop = () =>
    transitionLoginAttempt(advanced(), { type: "OBSERVED", result: "continue", document: top });
  const answer = { type: "STOP_ANSWERED", operationId: "answer-one" } as const;

  registerPasswordStopGuards({ top, emailFirst, create, advanced, atStop, answer });

  registerPasswordStopPasskeys({ top, id, emailFirst, create, atStop, answer });

  registerPasswordStopContinuations({ document, top, id, emailFirst, create, answer });
});

registerLaterSteps({ facts, document, recipe, noTimeBefore });

registerAttemptTiming({ facts, document, recipe, noTimeBefore, detected });

registerLayoutChanges({ document, recipe, detected, readyToClick });
