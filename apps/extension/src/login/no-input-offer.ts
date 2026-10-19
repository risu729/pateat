import { extractPasskeyObservation } from "../observation/extract";
import { observedPath } from "../observation/path";
import {
  accountEntries,
  accountEntryMiss,
  accountNames,
  besideEmails,
  otherAccountMiss,
  type EntryMiss,
  type OtherMiss,
} from "../page/account-list";
import { identifierInput } from "../page/identifier-field";

/** Whether the page lists an account by its email, masked or not (ADR 0028). */
export function listsAccounts(document: Document): boolean {
  return accountEntries(document).length > 0 || besideEmails(document).length > 0;
}

/**
 * What a page offers as a list of accounts (ADR 0028): its path once it lists an account
 * by email, or else the short texts that may name one by a username that is not an email;
 * and whether it shows a control to sign in with another account.
 */
export type ListedAccounts = {
  path: string;
  names?: string[];
  other?: true;
  otherMiss?: OtherMiss;
  missed?: EntryMiss;
};

export function listedAccounts(document: Document): ListedAccounts | undefined {
  const path = observedPath(document.location.pathname);
  // A list by email may be sent without an email username only for its control to sign
  // in with another account (ADR 0028).
  if (listsAccounts(document))
    return {
      path,
      ...(otherAccountMiss(document) === undefined ? { other: true as const } : {}),
    };
  const names = accountNames(document);
  // Why a shown email address is not an entry, so a list missed is logged (ADR 0028).
  const missed = accountEntryMiss(document);
  if (!names.length && !missed) return undefined;
  // A control to sign in with another account lets a list of names that name no item be
  // sent too (ADR 0028).
  const otherMiss = names.length > 0 ? otherAccountMiss(document, names) : "no-other";
  return {
    path,
    ...(names.length ? { names } : {}),
    ...(otherMiss === undefined ? { other: true as const } : {}),
    // Why no such control counts, for the log, when the words show at all.
    ...(otherMiss && otherMiss !== "no-other" ? { otherMiss } : {}),
    ...(missed ? { missed } : {}),
  };
}

/**
 * What a page that shows no sign-in input at the end of the shared no-input page wait is
 * offered as: a page that shows only a passkey button (ADR 0053), one that asks for an
 * account identifier alone (ADR 0016), or a list of accounts (ADR 0028) and the site's
 * sign-in entry (ADR 0031), the two of which may go together. `undefined` when it offers
 * nothing. `entryWanted` says the page's URL names another path of its site and its entry
 * was not offered yet.
 */
export type NoInputOffer =
  | { kind: "passkey" }
  | { kind: "identifier" }
  | { kind: "list"; accounts?: ListedAccounts; entry: boolean };

export function noInputOffer(document: Document, entryWanted: boolean): NoInputOffer | undefined {
  const accounts = listedAccounts(document);
  // Only a list by email (no names, nothing missed) goes before an identifier input or a
  // passkey button. A list by names only, or one announced only for the log, is dropped for
  // them: a heading or a support address beside a button reads as such a list.
  const emailList = accounts !== undefined && !accounts.names && !accounts.missed;
  // A page asking for an account identifier alone is offered as a sign-in page (ADR 0016);
  // an entry goes first unless the input is the page's only text input, so a newsletter
  // field does not hide it.
  const identifier = emailList ? undefined : identifierInput(document);
  // A page that shows only a button to sign in with a passkey (ADR 0053).
  const passkey = !emailList && !identifier && extractPasskeyObservation(document).ok;
  const entry = entryWanted && identifier !== "sole";
  // A page with both a passkey button and a sign-in entry is offered as the passkey page.
  // Which should win is open with the owner (ADR 0053); these two lines alone decide it.
  const offerPasskey = passkey;
  const offerEntry = entry && !offerPasskey;
  if (offerPasskey) return { kind: "passkey" };
  if (identifier && !offerEntry) return { kind: "identifier" };
  if (accounts || offerEntry)
    return { kind: "list", ...(accounts ? { accounts } : {}), entry: offerEntry };
  return undefined;
}
