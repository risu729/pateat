import {
  isStepTarget,
  namesPasskey,
  registersPasskey,
  sameLoginTarget,
  targetValues,
  type LoginObservation,
  type LoginTarget,
} from "@pateat/contracts";
import { accountText, isActionRole } from "./plan";

// The generation role's answer for a page that lists accounts (ADR 0028), and the passkey
// button beside the list (ADR 0079).

/**
 * The generation role's answer that a page lists accounts to choose from (ADR 0028):
 * the control that continues without a listed account (`other`) and the one that
 * continues with the one account shown beside it (`continue`), as candidate IDs. The
 * model never picks an account.
 */
export type GeneratedAccountList = {
  other?: string | undefined;
  continue?: string | undefined;
  /** The button beside the list that signs in with a passkey instead (ADR 0079). */
  passkeyButton?: string | undefined;
};
/** A list control the extension clicks, with the locator the chooser recipe stores. */
type ListControl = {
  candidate: string;
  target: Exclude<
    LoginTarget,
    { by: "autocomplete" | "label" | "accessible-name" | "password-form-name" }
  >;
};
/** An account list whose named controls passed {@link validateAccountList}. */
export type ValidatedAccountList = {
  accountList: true;
  other?: ListControl;
  continue?: ListControl;
  /** The passkey button beside the list (ADR 0079), with the locator its route clicks. */
  passkey?: { candidate: string; target: LoginTarget };
};
export type AccountListRejection =
  /** The page lists no accounts, or lists some and the answer is a form plan. */
  | "unexpected-account-list"
  | "unexpected-plan"
  | "unknown-candidate"
  | "duplicate-candidate"
  | "incompatible-role"
  /** A control's text holds an email address, a masked value or a long number. */
  | "account-text"
  /**
   * No control is named, and no listed account is an entry Pateat can click, so the list
   * could never lead on.
   */
  | "no-list-control";

/**
 * Validates an account-list answer (ADR 0028): the page must list accounts, and each named
 * control must be a button or link of the page, not hold account text and not be the
 * other control. A list whose accounts are all shown beside buttons needs a named
 * control. Its locator is never `autocomplete` or `label`, which name only inputs, nor
 * `accessible-name`, which names only a `password` handler's button or a route step's click.
 */
export function validateAccountList(
  observation: LoginObservation,
  draft: GeneratedAccountList,
): { ok: true; list: ValidatedAccountList } | { ok: false; reason: AccountListRejection } {
  if (!observation.accounts) return { ok: false, reason: "unexpected-account-list" };
  const control = (id: string | undefined): ListControl | AccountListRejection | undefined => {
    if (id === undefined) return undefined;
    const candidate = observation.candidates.find((entry) => entry.id === id);
    if (!candidate) return "unknown-candidate";
    const { target } = candidate;
    if (
      (!isActionRole(candidate.role) && candidate.role !== "link") ||
      !isStepTarget(target) ||
      target.by === "autocomplete" ||
      target.by === "label" ||
      target.by === "password-form-name"
    )
      return "incompatible-role";
    if (
      [candidate.label, ...targetValues(target)].some(
        (text) => text !== undefined && accountText.test(text),
      )
    )
      return "account-text";
    return { candidate: candidate.id, target };
  };
  const other = control(draft.other);
  const shown = control(draft.continue);
  for (const result of [other, shown])
    if (typeof result === "string") return { ok: false, reason: result };
  const named = [other, shown].filter((entry): entry is ListControl => typeof entry === "object");
  // Without an entry to click, only a named control leads on from the list.
  if (named.length === 0 && observation.accountEntries === 0)
    return { ok: false, reason: "no-list-control" };
  if (
    named.length === 2 &&
    (named[0]!.candidate === named[1]!.candidate ||
      sameLoginTarget(named[0]!.target, named[1]!.target))
  )
    return { ok: false, reason: "duplicate-candidate" };
  const passkey = listPasskeyButton(observation, named, draft.passkeyButton);
  return {
    ok: true,
    list: {
      accountList: true,
      ...(typeof other === "object" ? { other } : {}),
      ...(typeof shown === "object" ? { continue: shown } : {}),
      ...(passkey ? { passkey } : {}),
    },
  };
}

/**
 * The passkey button an account-list answer named (ADR 0079), kept only when it is a
 * button of the page whose label or locator names a passkey or security key and not its
 * registration, holds no account text and is neither list control; anything else is dropped without failing the
 * list, as a form plan's passkey button is (`passkeyButtonOf`).
 */
function listPasskeyButton(
  observation: LoginObservation,
  named: readonly ListControl[],
  candidateId: string | undefined,
): { candidate: string; target: LoginTarget } | undefined {
  if (candidateId === undefined) return undefined;
  const button = observation.candidates.find((candidate) => candidate.id === candidateId);
  if (
    !button ||
    button.role !== "button" ||
    !isStepTarget(button.target) ||
    !namesPasskey(button) ||
    registersPasskey(button) ||
    // A button per account, as one naming an address, is no button beside the list.
    [button.label, ...targetValues(button.target)].some(
      (text) => text !== undefined && accountText.test(text),
    ) ||
    named.some(
      (control) =>
        control.candidate === button.id || sameLoginTarget(control.target, button.target),
    )
  )
    return undefined;
  return { candidate: button.id, target: button.target };
}

/** An account-list answer reduced to references the request holds, for the request log. */
export function redactAccountList(
  observation: Pick<LoginObservation, "candidates">,
  draft: GeneratedAccountList,
): GeneratedAccountList {
  const candidate = (id: string) =>
    observation.candidates.some((entry) => entry.id === id) ? id : "?";
  return {
    ...(draft.other === undefined ? {} : { other: candidate(draft.other) }),
    ...(draft.continue === undefined ? {} : { continue: candidate(draft.continue) }),
    ...(draft.passkeyButton === undefined ? {} : { passkeyButton: candidate(draft.passkeyButton) }),
  };
}
