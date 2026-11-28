import { describe, expect, it } from "vitest";
import { transitionLoginAttempt } from "../../src/login-attempt";
import { finishedLogin, holdsOrigin } from "../../src/login-attempt-hold";
import { identifierOnly } from "../../src/login-attempt/policy";
import type { PasswordStopTestContext } from "./context";

/**
 * A login that sent its page nothing but its account identifier before its stop (ADR
 * 0036) holds nothing once its tab leaves the origin (#1847, widening the owner's rule of
 * 2026-11-09 that a login which submitted nothing holds nothing).
 */
export function registerPasswordStopHolds({
  top,
  create,
  advanced,
  atStop,
  answer,
}: Pick<PasswordStopTestContext, "top" | "create" | "advanced" | "atStop" | "answer">): void {
  describe("a stop the tab leaves after only the identifier", () => {
    const away = { ...top, origin: "https://idp.elsewhere.example", documentId: "away" };
    const left = (from: Parameters<typeof transitionLoginAttempt>[0], answered = false) =>
      transitionLoginAttempt(from, {
        type: "NAVIGATED",
        document: away,
        ...(answered ? { answered: true as const } : {}),
      });

    it("holds nothing when the tab leaves while Next is in flight", () => {
      const advancing = advanced();
      expect(identifierOnly(advancing)).toBe(true);
      const ended = left(advancing);
      expect(ended).toMatchObject({ state: "blocked", outcome: "left-origin", submissions: 1 });
      expect(holdsOrigin(ended)).toBe(false);
      // Its first step showing again releases it, so the page logs in as on any visit.
      expect(finishedLogin(ended)).toBe(true);
    });

    it("holds nothing when the tab leaves its stop with nothing in flight", () => {
      const ended = left(atStop());
      expect(ended).toMatchObject({ state: "blocked", outcome: "interrupted", submissions: 1 });
      expect(holdsOrigin(ended)).toBe(false);
      expect(finishedLogin(ended)).toBe(true);
    });

    it("holds after a passkey answered at the stop, or on the page the tab moved to", () => {
      const answered = transitionLoginAttempt(atStop(), answer);
      expect(identifierOnly(answered)).toBe(false);
      expect(holdsOrigin(left(answered))).toBe(true);
      const elsewhere = left(atStop(), true);
      expect(elsewhere).toMatchObject({ outcome: "interrupted", answeredAway: true });
      expect(identifierOnly(elsewhere)).toBe(false);
      expect(holdsOrigin(elsewhere)).toBe(true);
    });

    it("holds after a handler, a passkey route before it or an item's TOTP code", () => {
      const stopped = atStop();
      for (const more of [
        { handlers: [{ index: 0, start: 2 }] },
        { passkeyLeft: true as const },
        { facts: { ...stopped.facts, totp: true } },
      ]) {
        const record = { ...stopped, ...more };
        expect(identifierOnly(record)).toBe(false);
        expect(holdsOrigin(left(record))).toBe(true);
      }
    });

    it("keeps holding for a login without a stop, or one the site answered", () => {
      // Without a stop, the steps before the password page say nothing about what they typed.
      const unstopped = advanced();
      const { stopAt: _stopAt, ...rest } = unstopped;
      expect(identifierOnly(rest)).toBe(false);
      expect(holdsOrigin(left(rest))).toBe(true);
      // A site's own answer after the identifier still holds, as a challenge watched at the
      // stop that ends when the tab leaves does.
      const watching = transitionLoginAttempt(
        atStop(),
        { type: "OBSERVED", result: "challenge", document: top },
        1000,
      );
      expect(left(watching)).toMatchObject({ state: "blocked", outcome: "challenge" });
      expect(holdsOrigin(left(watching))).toBe(true);
      const refused = transitionLoginAttempt(advanced(), {
        type: "OBSERVED",
        result: "credential-rejected",
        document: top,
      });
      expect(refused).toMatchObject({ state: "blocked", outcome: "credential-rejected" });
      expect(holdsOrigin(refused)).toBe(true);
    });

    it("records an answer away only on a move", () => {
      expect(create()).not.toHaveProperty("answeredAway");
      expect(left(atStop())).not.toHaveProperty("answeredAway");
    });
  });
}
