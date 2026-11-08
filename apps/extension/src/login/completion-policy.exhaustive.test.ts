import type { LoginRoute } from "@pateat/contracts";
import { describe, expect, it } from "vitest";
import { judgedCompletionResult, settleCompletion, undecidedCandidate } from "./completion-policy";
import type { SignInDecision } from "./sign-in-state";

// Every combination of what decides a judged page's outcome, run through the three
// functions in the order the runtime calls them (runtime/judge.ts), checked against the
// rules of ADR 0027, ADR 0029, ADR 0036 and ADR 0065. The table tests next to this file
// check each function alone; these check what they give together.

const verdicts = ["signed-in", "rejected", "challenge", "optional", "unclear", "retry"] as const;
// One reason of each kind: none, judged before as undecided or signed in, a limit, judged
// before as a challenge or rejected, and a failure. Only an `unclear` or `retry` answer
// carries a reason (service/generation.ts).
const reasons = [
  undefined,
  "already-judged",
  "judged-signed-in",
  "daily-limit",
  "judged-challenge",
  "judged-rejected",
  "failed",
] as const;
const decisions: SignInDecision[] = ["rejected", "unknown", "continuing", "signed-in", "judge"];
const readings = [
  undefined,
  ...decisions.flatMap((decision) => [true, false].map((confirmed) => ({ decision, confirmed }))),
];
const routes: LoginRoute[] = ["password", "passkey"];
const flags = [false, true];
const PATH = "/account";
const rereadings = [
  undefined,
  ...decisions.flatMap((decision) =>
    flags.flatMap((loaded) => [PATH, "/elsewhere"].map((path) => ({ decision, loaded, path }))),
  ),
];

type Case = {
  verdict: (typeof verdicts)[number];
  reason: (typeof reasons)[number];
  reading: (typeof readings)[number];
  watched: boolean;
  route: LoginRoute;
  stopAt: number | undefined;
  sent: boolean;
  inputLeftOut: boolean;
  again: (typeof rereadings)[number];
  disabledLeftOut: boolean;
};

/** Every case with its outcome; the fresh reading only matters when it is taken. */
function* outcomes() {
  for (const verdict of verdicts)
    for (const reason of verdict === "unclear" || verdict === "retry" ? reasons : [undefined])
      for (const reading of readings)
        for (const watched of flags)
          for (const route of routes)
            for (const stopAt of [undefined, 0])
              for (const sent of flags)
                for (const inputLeftOut of flags) {
                  const candidate = undecidedCandidate({
                    verdict,
                    reason,
                    reading,
                    watched,
                    stopAt,
                    sent,
                    inputLeftOut,
                  });
                  for (const again of candidate.completes ? rereadings : [undefined])
                    for (const disabledLeftOut of flags) {
                      const settled = settleCompletion({
                        ...candidate,
                        again,
                        disabledLeftOut,
                        ...(verdict === "optional" ? { path: PATH } : {}),
                      });
                      const { result, confirmed } = judgedCompletionResult({
                        verdict,
                        reason,
                        reading,
                        completes: settled.completes,
                        stopHeld: candidate.stopHeld,
                        route,
                        stopAt,
                        sent,
                      });
                      const c: Case = {
                        verdict,
                        reason,
                        reading,
                        watched,
                        route,
                        stopAt,
                        sent,
                        inputLeftOut,
                        again,
                        disabledLeftOut,
                      };
                      yield { c, result, confirmed };
                    }
                }
}

const all = [...outcomes()];

/** The cases that break `rule`, at most five, for a readable failure. */
function broken(rule: (o: (typeof all)[number]) => boolean) {
  return all.filter((o) => !rule(o)).slice(0, 5);
}

const authenticated = (o: (typeof all)[number]) => o.result === "authenticated";

describe("a judged page's outcome, over every combination", () => {
  it("walks every case, and each verdict that can complete does", () => {
    expect(all.length).toBeGreaterThan(10_000);
    expect(new Set(all.filter(authenticated).map((o) => o.c.verdict))).toEqual(
      new Set(["signed-in", "optional", "unclear"]),
    );
  });

  it("authenticates a watched login only on the judge's signed-in or optional answer (ADR 0027, ADR 0065)", () => {
    expect(
      broken(
        (o) =>
          !(o.c.watched && authenticated(o)) || ["signed-in", "optional"].includes(o.c.verdict),
      ),
    ).toEqual([]);
  });

  it("authenticates an undecided or optional page only once read again, loaded and quiet (ADR 0029)", () => {
    expect(
      broken(
        (o) =>
          !authenticated(o) ||
          o.c.verdict === "signed-in" ||
          (o.c.again?.loaded === true &&
            (o.c.again.decision === "judge" || o.c.again.decision === "signed-in") &&
            !o.c.disabledLeftOut &&
            o.c.reading?.confirmed === true &&
            o.c.reading.decision === "judge"),
      ),
    ).toEqual([]);
  });

  it("authenticates a login stopped before a missing password only on a signed-in answer (ADR 0036)", () => {
    expect(
      broken(
        (o) =>
          !authenticated(o) ||
          o.c.stopAt === undefined ||
          o.c.verdict === "signed-in" ||
          (o.c.verdict === "unclear" && o.c.reason === "judged-signed-in"),
      ),
    ).toEqual([]);
  });

  it("authenticates an optional page only once sent, fully described, on its path, on any route (ADR 0065)", () => {
    expect(
      broken(
        (o) =>
          o.c.verdict !== "optional" ||
          !authenticated(o) ||
          (o.c.sent && !o.c.inputLeftOut && o.c.stopAt === undefined && o.c.again?.path === PATH),
      ),
    ).toEqual([]);
  });

  it("authenticates without a signed-in answer only once the credential went back, on any route (owner 2026-11-08)", () => {
    expect(
      broken(
        (o) =>
          !authenticated(o) ||
          o.c.verdict === "signed-in" ||
          o.c.sent ||
          (o.c.verdict === "unclear" && o.c.reason === "judged-signed-in"),
      ),
    ).toEqual([]);
  });

  it("decides the same on either route, but for a rejected answer (ADR 0027)", () => {
    const key = (o: (typeof all)[number]) =>
      JSON.stringify({ ...o.c, route: undefined, verdict: o.c.verdict });
    const byRoute = new Map<string, Partial<Record<LoginRoute, string>>>();
    for (const o of all)
      if (o.c.verdict !== "rejected")
        byRoute.set(key(o), { ...byRoute.get(key(o)), [o.c.route]: `${o.result} ${o.confirmed}` });
    expect([...byRoute.values()].filter((r) => r.password !== r.passkey).slice(0, 5)).toEqual([]);
  });

  it("rejects a credential only on the password route, and only on a rejected answer", () => {
    expect(
      broken(
        (o) =>
          (o.result === "credential-rejected") ===
          (o.c.verdict === "rejected" && o.c.route === "password"),
      ),
    ).toEqual([]);
  });

  it("gives an undecided page with a sign of another sign-in step to the person (ADR 0029)", () => {
    expect(
      broken(
        (o) =>
          o.c.verdict !== "unclear" ||
          o.c.reading?.confirmed !== true ||
          o.c.reading.decision !== "continuing" ||
          o.result === "challenge",
      ),
    ).toEqual([]);
  });

  it("never ends a stopped login as unknown, whatever the route (ADR 0036, owner 2026-11-08)", () => {
    expect(broken((o) => o.result !== "unknown" || o.c.stopAt === undefined)).toEqual([]);
  });

  it("confirms only an authenticated page", () => {
    expect(broken((o) => !o.confirmed || authenticated(o))).toEqual([]);
  });
});
