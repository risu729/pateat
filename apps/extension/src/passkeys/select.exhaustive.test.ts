import { describe, expect, it } from "vitest";
import { matchingPasskeys, selectPasskey, type PasskeyCandidate } from "./select";

// Every vault of up to two passkeys, each varying in every field selection reads, against
// every request scope, checked against ADR 0007's item selection. The table tests in
// passkeys/ and the login tests check single cases; this checks the rules hold for all.

const RP = "example.com";
const flags = [false, true];
const kinds: PasskeyCandidate[] = ["a", "b"].flatMap((credentialId) =>
  [RP, "other.example"].flatMap((rpId) =>
    [null, "user"].flatMap((userHandle) =>
      flags.flatMap((discoverable) =>
        [0, 1].flatMap((counter) =>
          flags.map((preferred) => ({
            credentialId,
            rpId,
            userHandle,
            discoverable,
            counter,
            preferred,
          })),
        ),
      ),
    ),
  ),
);
const vaults: PasskeyCandidate[][] = [
  [],
  ...kinds.map((one) => [one]),
  ...kinds.flatMap((one) => kinds.map((two) => [one, two])),
];
const scopes = [[], ["a"], ["a", "b"]].map((allowCredentialIds) => ({
  rpId: RP,
  allowCredentialIds,
}));

const all = vaults.flatMap((candidates) =>
  scopes.flatMap((request) =>
    flags.map((complete) => {
      const vault = { candidates, complete };
      return {
        request,
        vault,
        matching: matchingPasskeys(request, candidates),
        selection: selectPasskey(request, vault),
      };
    }),
  ),
);
type Case = (typeof all)[number];

/** The cases that break `rule`, at most five, for a readable failure. */
function broken(rule: (o: Case) => boolean) {
  return all.filter((o) => !rule(o)).slice(0, 5);
}

const chosen = (o: Case) =>
  o.selection.kind === "credential" ? o.selection.credential : undefined;

describe("passkey item selection, over every vault of up to two passkeys (ADR 0007)", () => {
  it("walks every case, and each outcome occurs", () => {
    expect(all.length).toBeGreaterThan(20_000);
    expect(
      new Set(
        all.map((o) => (o.selection.kind === "credential" ? "credential" : o.selection.reason)),
      ),
    ).toEqual(
      new Set([
        "credential",
        "no-credential",
        "ambiguous-credential",
        "vault-incomplete",
        "unsupported-counter",
      ]),
    );
  });

  it("matches only the request's RP ID, listed IDs, or discoverable passkeys with a user handle", () => {
    expect(
      broken((o) =>
        o.vault.candidates.every(
          (c) =>
            o.matching.includes(c) ===
            (c.rpId === o.request.rpId &&
              (o.request.allowCredentialIds.length > 0
                ? o.request.allowCredentialIds.includes(c.credentialId)
                : c.discoverable && c.userHandle !== null)),
        ),
      ),
    ).toEqual([]);
  });

  it("signs only with a match whose counter is zero", () => {
    expect(
      broken((o) => {
        const c = chosen(o);
        return c === undefined || (o.matching.includes(c) && c.counter === 0);
      }),
    ).toEqual([]);
  });

  it("never chooses among several matches, nor uses a single one while the vault is incomplete, unless it is the default", () => {
    expect(
      broken((o) => {
        const c = chosen(o);
        return (
          c === undefined ||
          (o.vault.complete && o.matching.length === 1) ||
          (c.preferred === true && o.matching.filter((m) => m.preferred).length === 1)
        );
      }),
    ).toEqual([]);
  });

  it("uses the only default among the matches, or the only match of a complete vault, unless its counter is not zero", () => {
    expect(
      broken((o) => {
        const defaults = o.matching.filter((m) => m.preferred);
        const expected =
          defaults.length === 1
            ? defaults[0]
            : o.vault.complete && o.matching.length === 1
              ? o.matching[0]
              : undefined;
        return expected === undefined || expected.counter !== 0 || chosen(o) === expected;
      }),
    ).toEqual([]);
  });

  it("does not depend on the order of the vault's passkeys", () => {
    expect(
      broken((o) => {
        const reversed = selectPasskey(o.request, {
          ...o.vault,
          candidates: o.vault.candidates.toReversed(),
        });
        return JSON.stringify(reversed) === JSON.stringify(o.selection);
      }),
    ).toEqual([]);
  });
});
