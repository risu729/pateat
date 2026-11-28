import { describe, expect, it } from "vitest";
import { transitionLoginAttempt } from "../../src/login-attempt";
import { holdsOrigin } from "../../src/login-attempt-hold";
import { parseAttemptMetadata } from "../../src/login-attempt/metadata";
import { identifierOnly } from "../../src/login-attempt/policy";
import type { PasswordStopTestContext } from "./context";

/**
 * A hand-off: an SSO item's login that types its identifier and presses Next, stopping at
 * the step after (ADR 0036 amendment of 2026-11-28, #1847).
 */
export function registerHandoffStop({
  top,
  create,
  advanced,
  answer,
}: Pick<PasswordStopTestContext, "top" | "create" | "advanced" | "answer">): void {
  describe("a hand-off that stops after its identifier", () => {
    // An SSO item holds no password and no passkey.
    const sso = { password: false, totp: false, passkey: false, discoverablePasskey: false };
    const handoff = { ssoHandoff: true, identifierStop: true, facts: sso };
    const stopped = () =>
      transitionLoginAttempt(advanced(handoff), {
        type: "OBSERVED",
        result: "continue",
        document: top,
      });

    it("records the mark with its stop, and only with one", () => {
      expect(create(handoff)).toMatchObject({ ssoHandoff: true, stopAt: 2 });
      expect(create()).not.toHaveProperty("ssoHandoff");
      expect(() => create(handoff, null)).toThrow();
      expect(() => create({ ...handoff, identifierStop: false })).toThrow();
      expect(() => parseAttemptMetadata({ ...create(handoff), stopJudged: true })).toThrow();
    });

    it("ends `challenge` at its stop on the site, never watched", () => {
      const ended = transitionLoginAttempt(
        stopped(),
        { type: "OBSERVED", result: "challenge", document: top },
        1000,
      );
      expect(ended).toMatchObject({ state: "blocked", outcome: "challenge", stepIndex: 2 });
      expect(ended).not.toHaveProperty("watch");
      // Without the mark the same stop is watched, as before.
      const plain = transitionLoginAttempt(advanced(), {
        type: "OBSERVED",
        result: "continue",
        document: top,
      });
      expect(
        transitionLoginAttempt(plain, { type: "OBSERVED", result: "challenge", document: top }),
      ).toMatchObject({ state: "watching", outcome: "challenge" });
    });

    it("enters no handler, takes no other route, and answers or judges nothing", () => {
      const at = stopped();
      for (const event of [
        { type: "HANDLER", handler: 0, steps: 1, effects: 1, document: top },
        { type: "ROUTE", route: "passkey", steps: 1 },
        { type: "STOP_JUDGING" },
        answer,
      ])
        expect(transitionLoginAttempt(at, event)).toEqual(at);
    });

    it("ends `left-origin` when its tab leaves, holding nothing", () => {
      const away = { ...top, origin: "https://idp.elsewhere.example", documentId: "away" };
      const advancing = advanced({ ...handoff, facts: { ...sso, totp: true } });
      expect(identifierOnly(advancing)).toBe(true);
      const ended = transitionLoginAttempt(advancing, { type: "NAVIGATED", document: away });
      expect(ended).toMatchObject({ state: "blocked", outcome: "left-origin", ssoHandoff: true });
      expect(holdsOrigin(ended)).toBe(false);
    });
  });
}
