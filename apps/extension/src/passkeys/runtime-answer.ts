import { createPasskeyAssertion } from "./assertion";

import { matchingPasskeys, selectPasskey, type PasskeyCandidate } from "./select";
import { CHOOSER_MIN_REMAINING_MS, RUNTIME_TIMEOUT_MS, type RuntimeResult } from "./wire";

import type { AdmittedGetRequest } from "./request";
import {
  abortable,
  chooserWaitMs,
  ListedSite,
  type PasskeySource,
  type PasskeyRuntimeOptions,
  type Operation,
  type ReportDetail,
  type After,
  type PasskeyItem,
  type PasskeyStopCause,
} from "./runtime-shared";

export class PagePermissionRefusal extends Error {
  readonly reason: string;
  constructor(reason: string) {
    super(reason);
    this.reason = reason;
  }
}

/** Chooses and signs for one admitted request, preserving its caller-owned deadline and report. */
export function createPasskeyAnswer<TCandidate extends PasskeyCandidate>({
  source,
  options,
  request,
  origin,
  context,
  message,
  operation,
  detail,
  after,
  received,
  unlisted,
  setStep,
  resetTimer,
}: {
  source: PasskeySource<TCandidate>;
  options: PasskeyRuntimeOptions<TCandidate>;
  request: AdmittedGetRequest;
  origin: string;
  context: { documentId: string; tabId: number; incognito: boolean; active: boolean };
  message: { userActivation: boolean; focused: boolean };
  operation: Operation;
  detail: ReportDetail;
  after: After<TCandidate>;
  received: number;
  unlisted: (signal: AbortSignal) => Promise<void>;
  setStep: (step: PasskeyStopCause) => void;
  resetTimer: (remaining: () => number) => void;
}) {
  return async (login: PasskeyItem | undefined, signal: AbortSignal): Promise<RuntimeResult> => {
    setStep("passkey-lookup");
    // Whether the site treats its default as unset (ADR 0062, ADR 0063), read alongside the
    // lookup so the deadline runs as without it; asked only without a login, and a failed
    // read counts as not unset.
    const unsetRead =
      !login && options.defaultUnset !== undefined
        ? Promise.try(() => options.defaultUnset!(origin, context.incognito)).catch(
            () => false as const,
          )
        : Promise.resolve(false as const);
    const candidates = await abortable(
      login
        ? source.candidates(origin, request.rpId, signal, login)
        : source.candidates(origin, request.rpId, signal),
      signal,
    );
    if (!candidates) return { kind: "delegate", reason: "not-configured" };
    const accepted = matchingPasskeys(request, candidates.candidates);
    detail.stored = candidates.candidates.length;
    detail.accepted = accepted.length;
    detail.siteDefault = candidates.candidates.filter((entry) => entry.preferred === true).length;
    detail.siteDefaultAccepted = accepted.filter((entry) => entry.preferred === true).length;
    if (candidates.siteDefault) detail.siteDefaultItem = candidates.siteDefault;
    detail.complete = candidates.complete;
    // One match or the site default signs without asking, also after a logout in the tab
    // (ADR 0062); several matches ask. A running login never asks (ADR 0027).
    const found = selectPasskey(request, candidates);
    // A site that treats its default as unset asks for any passkey that fits: one that asks
    // every time (ADR 0063), or one whose automatic login is paused (ADR 0062). The stored
    // default stays as it is.
    const unsetBy =
      (found.kind === "credential" || found.reason === "ambiguous-credential") &&
      (await abortable(unsetRead, signal));
    const unset = unsetBy === true || unsetBy === "paused";
    const paused = unsetBy === "paused";
    if (unset) detail.defaultUnset = true;
    if (paused) detail.paused = true;
    const selection: typeof found = unset
      ? { kind: "delegate", reason: "ambiguous-credential" }
      : found;
    // The page's permission is read before signing, and again before an assertion leaves.
    const refused = async () => {
      const refusal = await abortable(
        Promise.try(() =>
          options.pagePermission?.({
            ...context,
            origin,
            conditional: request.conditional === true,
            userActivation: message.userActivation,
            allowCredentials: request.allowCredentialIds.length > 0,
          }),
        ).catch(() => "settings-unavailable"),
        signal,
      );
      signal.throwIfAborted();
      return refusal;
    };
    const signWith = async (candidate: TCandidate) => {
      await unlisted(signal);
      const refusal = await refused();
      if (refusal) throw new PagePermissionRefusal(refusal);
      setStep("signing");
      return abortable(
        createPasskeyAssertion(request, candidate, (data, hash) =>
          source.sign(candidate, data, hash, signal),
        ),
        signal,
      );
    };
    type Signed = { credential: TCandidate; assertion: Awaited<ReturnType<typeof signWith>> };
    // Looks the chosen passkey up under the current settings and signs with it. A lookup or
    // signing that throws, as when settings change meanwhile, gets one more try.
    const signCurrent = async (
      credentialId: string,
      retry: boolean,
    ): Promise<Signed | { reason: string }> => {
      try {
        setStep("passkey-lookup");
        const current = await abortable(source.candidates(origin, request.rpId, signal), signal);
        const same = current
          ? matchingPasskeys(request, current.candidates).filter(
              (entry) => entry.credentialId === credentialId && entry.counter === 0,
            )
          : [];
        if (same.length !== 1)
          return {
            reason: current?.complete === false ? "vault-incomplete" : "settings-changed",
          };
        const candidate = same[0]!;
        return { credential: candidate, assertion: await signWith(candidate) };
      } catch (error) {
        if (
          signal.aborted ||
          !retry ||
          error instanceof ListedSite ||
          error instanceof PagePermissionRefusal
        )
          throw error;
        return signCurrent(credentialId, false);
      }
    };
    let credential: TCandidate;
    let assertion: Signed["assertion"] | undefined;
    let makeDefault = false;
    // One passkey whose item has Bitwarden's re-prompt, on a site that honours it, signs only
    // after its master password is typed in the chooser window (owner, 2026-10-23 12:46 UTC).
    // A running login's item was asked for when that login started.
    const reprompt =
      !login && selection.kind === "credential" && selection.credential.reprompt === true;
    if (selection.kind === "credential" && !reprompt) {
      credential = selection.credential;
      // Signed with no login of the tab, no choice and no click of the person: a sign-in
      // the page started and Pateat made by itself, as a login page that asks on load
      // after each logout (ADR 0062 C). A request the person started is theirs.
      if (!login && !message.userActivation) after.silent = true;
    }
    // A login's item answers alone; otherwise the browser or Bitwarden does, so Pateat
    // never signs in as another account.
    else if (login && selection.kind === "delegate")
      return { kind: "delegate", reason: `login-item-${selection.reason}` };
    else {
      // Only passkeys Pateat can sign with are offered, the site default first. Fewer than
      // two is not a choice, except where the default counts as unset or the one asks for
      // the master password.
      const offered =
        reprompt && selection.kind === "credential"
          ? [selection.credential]
          : accepted
              .filter((entry) => entry.counter === 0)
              .sort((a, b) =>
                unset ? 0 : Number(b.preferred === true) - Number(a.preferred === true),
              );
      const asksPassword = offered.some((entry) => entry.reprompt === true);
      // A paused site is handed on rather than signed without a choice (ADR 0062).
      const declined = reprompt
        ? ({ kind: "delegate", reason: "master-password-reprompt" } as const)
        : unset
          ? ({ kind: "delegate", reason: paused ? "paused" : "default-unset" } as const)
          : ({ kind: "delegate", reason: "ambiguous-credential" } as const);
      if (selection.kind === "delegate") {
        if (unset ? offered.length === 0 : selection.reason !== "ambiguous-credential")
          return unset ? declined : selection;
        if (offered.length < 2 && !unset) return selection;
      }
      // An unsearched item might hold the passkey the person wants.
      if (!candidates.complete && !reprompt)
        return { kind: "delegate", reason: "vault-incomplete" };
      const verifier = source.verifyMasterPassword?.bind(source);
      const remaining = received + chooserWaitMs(request.timeoutMs) - Date.now();
      if (
        !options.chooser ||
        // An extension window would open outside the incognito window (ADR 0021).
        context.incognito ||
        // A background tab or a prerendered page never pulls a window to the front.
        !message.focused ||
        !context.active ||
        remaining < CHOOSER_MIN_REMAINING_MS ||
        (asksPassword && !verifier)
      )
        return declined;
      // The window waits for a person, so the lookup budget no longer applies.
      resetTimer(() => remaining);
      await unlisted(signal);
      operation.asked = true;
      operation.choosing = true;
      setStep("chooser");
      const choice = await abortable(
        options.chooser.choose({
          tabId: context.tabId,
          origin,
          rpId: request.rpId,
          entries: offered.map((entry, index) => ({
            ...(entry.display ?? { item: `Passkey ${index + 1}` }),
            ...(entry.preferred === true && !unset ? { preferred: true } : {}),
            ...(entry.reprompt === true ? { reprompt: true } : {}),
          })),
          // Not aborted with the request: a check cut off mid-way would lock the vault.
          ...(asksPassword && verifier
            ? { verify: (index: number, password: string) => verifier(offered[index]!, password) }
            : {}),
          replacesDefault:
            candidates.siteDefault !== undefined && candidates.siteDefault !== "unset",
          ...(paused ? { paused: true } : {}),
          signal,
        }),
        signal,
      );
      operation.choosing = false;
      detail.chooser = choice.kind;
      // The site's hostname is added once the request has been handed on.
      if (choice.kind === "browser-site") after.browserSite = true;
      if (choice.kind !== "chosen") return { kind: "delegate", reason: `chooser-${choice.kind}` };
      const chosen = offered[choice.index];
      if (!chosen) return { kind: "delegate", reason: "chooser-invalid" };
      // Signing gets its own budget, so a choice made near the deadline still answers.
      resetTimer(() => options.timeoutMs?.() ?? RUNTIME_TIMEOUT_MS);
      // Settings may have changed while the person decided, by a sync, a save or another
      // tab's login, and signing refuses a candidate from older settings. So the chosen
      // passkey is looked up again and used only if the current settings still offer it.
      const signed = await signCurrent(chosen.credentialId, true);
      if ("reason" in signed) return { kind: "delegate", reason: signed.reason };
      ({ credential, assertion } = signed);
      // The site default is saved already.
      makeDefault = choice.makeDefault && credential.preferred !== true;
    }
    assertion ??= await signWith(credential);
    if (signal.aborted) {
      if (operation.cancelledBy) detail.cause = operation.cancelledBy;
      return { kind: "cancelled" };
    }
    // A chooser stays open across settings changes. Recheck after asynchronous signing
    // as well, before any assertion or remembered choice can leave this request.
    const refusal = await refused();
    if (refusal) return { kind: "delegate", reason: refusal };
    if (makeDefault) after.remember = credential;
    after.signed = credential;
    return { kind: "assertion", assertion };
  };
}
