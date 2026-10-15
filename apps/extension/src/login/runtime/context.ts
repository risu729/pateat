import type { RuntimeState } from "./state";
import type { createAttemptStore } from "./attempt-store";
import type { createAccountChoice } from "./account-choice";
import type { createAdmission } from "./admission";
import type { createLoginPlan } from "./login-plan";
import type { createSignInCheck } from "./sign-in-check";
import type { createContinuation } from "./continuation";
import type { createSteps } from "./steps";
import type { createRecipeGeneration } from "./recipe-generation";
import type { createEntryPages } from "./entry-pages";
import type { createSiteMoves } from "./site-moves";
import type { createPagePasskeys } from "./page-passkeys";
import type { createPasswordStop } from "./password-stop";

/**
 * The login runtime: its shared state and the functions of all its parts, which reach each
 * other through it. `createLoginRuntime` creates each part with the shared state and adds the
 * part's functions to it before any of them runs; a part reads it as this interface.
 * Typing the parts' parameter as this interface would make the interface depend on itself.
 */
export interface RuntimeContext
  extends
    RuntimeState,
    ReturnType<typeof createAttemptStore>,
    ReturnType<typeof createAccountChoice>,
    ReturnType<typeof createAdmission>,
    ReturnType<typeof createLoginPlan>,
    ReturnType<typeof createSignInCheck>,
    ReturnType<typeof createContinuation>,
    ReturnType<typeof createSteps>,
    ReturnType<typeof createRecipeGeneration>,
    ReturnType<typeof createEntryPages>,
    ReturnType<typeof createSiteMoves>,
    ReturnType<typeof createPagePasskeys>,
    ReturnType<typeof createPasswordStop> {}
