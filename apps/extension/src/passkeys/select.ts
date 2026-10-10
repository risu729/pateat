/** Secret-free candidate metadata from a configured vault item. */
export interface PasskeyCandidate {
  readonly credentialId: string;
  readonly rpId: string;
  readonly userHandle: string | null;
  readonly discoverable: boolean;
  readonly counter: number;
}

export type Selection<TCandidate extends PasskeyCandidate> =
  | { readonly kind: "credential"; readonly credential: TCandidate }
  | {
      readonly kind: "delegate";
      readonly reason: "no-credential" | "ambiguous-credential" | "unsupported-counter";
    };

/**
 * Select exactly one credential from the account the owner configured for this origin. Never
 * choose among several. A nonzero counter would require a vault write and is refused.
 */
export function selectPasskey<TCandidate extends PasskeyCandidate>(
  request: { readonly rpId: string; readonly allowCredentialIds: readonly string[] },
  candidates: readonly TCandidate[],
): Selection<TCandidate> {
  const allowed = new Set(request.allowCredentialIds);
  const matching = candidates.filter(
    (candidate) =>
      candidate.rpId === request.rpId &&
      (allowed.size > 0
        ? allowed.has(candidate.credentialId)
        : candidate.discoverable && candidate.userHandle !== null),
  );
  if (matching.length === 0) return { kind: "delegate", reason: "no-credential" };
  if (matching.length > 1) return { kind: "delegate", reason: "ambiguous-credential" };
  const credential = matching[0]!;
  if (credential.counter !== 0) return { kind: "delegate", reason: "unsupported-counter" };
  return { kind: "credential", credential };
}
