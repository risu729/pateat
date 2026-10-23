/** Secret-free candidate metadata from a vault item. */
export interface PasskeyCandidate {
  readonly credentialId: string;
  readonly rpId: string;
  readonly userHandle: string | null;
  readonly discoverable: boolean;
  readonly counter: number;
  /** The item is the page origin's entry in `siteDefaults`. */
  readonly preferred?: boolean;
  /**
   * The item has Bitwarden's master password re-prompt and the page's site honours it, so
   * Pateat signs with it only after the master password is typed in its chooser window.
   */
  readonly reprompt?: boolean;
  /** What the chooser window shows for this passkey; never used for selection. */
  readonly display?: PasskeyDisplay;
}

/** Display-only names: the vault item, the account stored with the passkey, the connection. */
export interface PasskeyDisplay {
  /** Absent when the vault item has no name; the picker names it in the UI language. */
  readonly item?: string;
  readonly userName?: string;
  readonly account?: string;
}

/** Every eligible stored passkey for one RP ID, from all enabled connections. */
export interface PasskeyCandidates<TCandidate extends PasskeyCandidate = PasskeyCandidate> {
  readonly candidates: readonly TCandidate[];
  /** False when a connection or an eligible item could not be searched. */
  readonly complete: boolean;
  /**
   * Diagnostic only, never used for selection: whether the origin has a site default, and if so
   * whether it resolved to one connection and an eligible item in a searched connection.
   */
  readonly siteDefault?: "unset" | "unresolved" | "not-searched" | "searched";
}

export type Selection<TCandidate extends PasskeyCandidate> =
  | { readonly kind: "credential"; readonly credential: TCandidate }
  | {
      readonly kind: "delegate";
      readonly reason:
        | "no-credential"
        | "ambiguous-credential"
        | "vault-incomplete"
        | "unsupported-counter";
    };

export interface PasskeyRequestScope {
  readonly rpId: string;
  readonly allowCredentialIds: readonly string[];
}

/** Candidates the request accepts: listed IDs, or discoverable credentials when none are listed. */
export function matchingPasskeys<TCandidate extends PasskeyCandidate>(
  request: PasskeyRequestScope,
  candidates: readonly TCandidate[],
): TCandidate[] {
  const allowed = new Set(request.allowCredentialIds);
  return candidates.filter(
    (candidate) =>
      candidate.rpId === request.rpId &&
      (allowed.size > 0
        ? allowed.has(candidate.credentialId)
        : candidate.discoverable && candidate.userHandle !== null),
  );
}

/**
 * ADR 0007 item selection. Of the credentials the request accepts, use the site default's if
 * it is one of them; otherwise use the only one. Never choose among several, and never choose
 * a single match when an unsearched item might also hold one. A nonzero counter would require
 * a vault write and is refused.
 */
export function selectPasskey<TCandidate extends PasskeyCandidate>(
  request: PasskeyRequestScope,
  { candidates, complete }: PasskeyCandidates<TCandidate>,
): Selection<TCandidate> {
  const matching = matchingPasskeys(request, candidates);
  const preferred = matching.filter((candidate) => candidate.preferred === true);
  let credential: TCandidate;
  if (preferred.length === 1) credential = preferred[0]!;
  else if (!complete) return { kind: "delegate", reason: "vault-incomplete" };
  else if (matching.length === 0) return { kind: "delegate", reason: "no-credential" };
  else if (matching.length > 1) return { kind: "delegate", reason: "ambiguous-credential" };
  else credential = matching[0]!;
  if (credential.counter !== 0) return { kind: "delegate", reason: "unsupported-counter" };
  return { kind: "credential", credential };
}
