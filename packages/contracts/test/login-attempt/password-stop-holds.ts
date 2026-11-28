import { describe, expect, it } from "vitest";
import { transitionLoginAttempt } from "../../src/login-attempt";
import { finishedLogin, holdsOrigin } from "../../src/login-attempt-hold";
import { identifierOnly } from "../../src/login-attempt/policy";
import { identifierOnlyBefore } from "../../src/login/routes";
import type { LoginRecipe } from "../../src/login/route-schema";
import type { PasswordStopTestContext } from "./context";

/**
 * A login that sent its page nothing but its account identifier before its stop (ADR
 * 0036) holds nothing once its tab leaves the origin (#1847, widening the owner's rule of
 * 2026-11-09 that a login which submitted nothing holds nothing).
 */
export function registerPasswordStopHolds({
  top,
  emailFirst,
  create,
  advanced,
}: Pick<PasswordStopTestContext, "top" | "emailFirst" | "create" | "advanced">): void {
  describe("a stop the tab leaves after only the identifier", () => {
    const away = { ...top, origin: "https://idp.elsewhere.example", documentId: "away" };
    const left = (from: Parameters<typeof transitionLoginAttempt>[0], answered = false) =>
      transitionLoginAttempt(from, {
        type: "NAVIGATED",
        document: away,
        ...(answered ? { answered: true as const } : {}),
      });
    /** Its steps before the stop type only the identifier, as its binding reads them. */
    const marked = () => advanced({ identifierStop: true });
    const markedAtStop = () =>
      transitionLoginAttempt(marked(), { type: "OBSERVED", result: "continue", document: top });

    it("holds nothing when the tab leaves while Next is in flight", () => {
      const advancing = marked();
      expect(identifierOnly(advancing)).toBe(true);
      const ended = left(advancing);
      expect(ended).toMatchObject({ state: "blocked", outcome: "left-origin", submissions: 1 });
      expect(holdsOrigin(ended)).toBe(false);
      // Its first step showing again releases it, so the page logs in as on any visit.
      expect(finishedLogin(ended)).toBe(true);
    });

    it("holds nothing when the tab leaves its stop with nothing in flight", () => {
      const ended = left(markedAtStop());
      expect(ended).toMatchObject({ state: "blocked", outcome: "interrupted", submissions: 1 });
      expect(holdsOrigin(ended)).toBe(false);
      expect(finishedLogin(ended)).toBe(true);
    });

    it("holds when its steps before the stop may type more than the identifier", () => {
      // Unmarked: the binding reads another field, or nothing said what the steps type.
      const unmarked = advanced();
      expect(unmarked).not.toHaveProperty("identifierStop");
      expect(identifierOnly(unmarked)).toBe(false);
      expect(holdsOrigin(left(unmarked))).toBe(true);
      // The marker needs a stop.
      expect(create({ identifierStop: true }, null)).not.toHaveProperty("identifierStop");
    });

    it("holds after a passkey answered at the stop, or for it outside its steps", () => {
      const answered = transitionLoginAttempt(markedAtStop(), {
        type: "STOP_ANSWERED",
        operationId: "answer-one",
      });
      expect(identifierOnly(answered)).toBe(false);
      expect(holdsOrigin(left(answered))).toBe(true);
      // On its own page before the stop recorded it, on a page the tab moved to, or
      // unknown to a restarted worker: the move's end records it.
      for (const from of [marked(), markedAtStop()]) {
        const ended = left(from, true);
        expect(ended).toMatchObject({ maybeAnswered: true });
        expect(identifierOnly(ended)).toBe(false);
        expect(holdsOrigin(ended)).toBe(true);
      }
      const unreadable = transitionLoginAttempt(marked(), { type: "LEFT", answered: true });
      expect(unreadable).toMatchObject({ outcome: "left-origin", maybeAnswered: true });
      expect(holdsOrigin(unreadable)).toBe(true);
      expect(holdsOrigin(transitionLoginAttempt(marked(), { type: "LEFT" }))).toBe(false);
    });

    it("holds after a handler or a passkey route before it", () => {
      const stopped = markedAtStop();
      for (const more of [{ handlers: [{ index: 0, start: 2 }] }, { passkeyLeft: true as const }]) {
        const record = { ...stopped, ...more };
        expect(identifierOnly(record)).toBe(false);
        expect(holdsOrigin(left(record))).toBe(true);
      }
    });

    it("keeps holding for a login without a stop, or one the site answered", () => {
      // Without a stop, the steps before the password page say nothing about what they typed.
      const { stopAt: _stopAt, ...rest } = marked();
      expect(identifierOnly(rest)).toBe(false);
      expect(holdsOrigin(left(rest))).toBe(true);
      // A site's own answer after the identifier still holds, as a challenge watched at the
      // stop that ends when the tab leaves does.
      const watching = transitionLoginAttempt(
        markedAtStop(),
        { type: "OBSERVED", result: "challenge", document: top },
        1000,
      );
      expect(left(watching)).toMatchObject({ state: "blocked", outcome: "challenge" });
      expect(holdsOrigin(left(watching))).toBe(true);
      const refused = transitionLoginAttempt(marked(), {
        type: "OBSERVED",
        result: "credential-rejected",
        document: top,
      });
      expect(refused).toMatchObject({ state: "blocked", outcome: "credential-rejected" });
      expect(holdsOrigin(refused)).toBe(true);
    });

    it("records a possible answer only when one is named", () => {
      expect(create()).not.toHaveProperty("maybeAnswered");
      expect(left(markedAtStop())).not.toHaveProperty("maybeAnswered");
    });

    it("keeps the marker on a continuation only as named", () => {
      const { handlers: _handlers, ...base } = emailFirst;
      const identifier: LoginRecipe = {
        ...base,
        slots: ["username"],
        steps: emailFirst.steps.slice(0, 2),
      };
      const sent = transitionLoginAttempt(advanced({ recipe: identifier, identifierStop: true }), {
        type: "CONTINUING",
        operationId: "next-one",
      });
      const event = {
        type: "CONTINUED",
        recipeRevision: 2,
        steps: 2,
        effects: 1,
        document: top,
        stopAt: 2,
      } as const;
      expect(sent).toMatchObject({
        identifierStop: true,
        continuation: { operationId: "next-one" },
      });
      expect(transitionLoginAttempt(sent, { ...event, identifierStop: true })).toMatchObject({
        stopAt: 2,
        identifierStop: true,
      });
      // The continued steps fill a field the binding reads from elsewhere.
      expect(transitionLoginAttempt(sent, event)).toMatchObject({ stopAt: 2 });
      expect(transitionLoginAttempt(sent, event).identifierStop).toBeUndefined();
    });
  });

  describe("steps that type only the identifier before a stop (#1847)", () => {
    const choice = { route: "password", variant: 0 } as const;
    const username = { slot: "username", fieldId: "login.username" };
    const item = {
      fields: [
        { id: "login.username", kind: "text" },
        { id: "custom.pin", kind: "hidden" },
        { id: "custom.user", kind: "linked", linkedFieldId: "login.username" },
      ],
    } as unknown as Parameters<typeof identifierOnlyBefore>[4];
    const withPin: LoginRecipe = {
      ...emailFirst,
      slots: ["username", "pin", "password"],
      steps: [
        {
          ...emailFirst.steps[0]!,
          fields: [
            ...(emailFirst.steps[0] as Extract<LoginRecipe["steps"][number], { kind: "fill" }>)
              .fields,
            { slot: "pin", target: { by: "id", value: "pin" } },
          ],
        } as LoginRecipe["steps"][number],
        ...emailFirst.steps.slice(1),
      ],
    };

    it("counts a username slot read from the built-in username, itself or Linked", () => {
      expect(identifierOnlyBefore(emailFirst, choice, 2, [username], item)).toBe(true);
      expect(
        identifierOnlyBefore(
          emailFirst,
          choice,
          2,
          [{ slot: "username", fieldId: "custom.user" }],
          item,
        ),
      ).toBe(true);
    });

    it("refuses a slot read from another field, or one left unbound", () => {
      // The username slot bound to a hidden custom field.
      expect(
        identifierOnlyBefore(
          emailFirst,
          choice,
          2,
          [{ slot: "username", fieldId: "custom.pin" }],
          item,
        ),
      ).toBe(false);
      // A step before the stop also fills a PIN from a hidden field.
      expect(
        identifierOnlyBefore(
          withPin,
          choice,
          2,
          [username, { slot: "pin", fieldId: "custom.pin" }],
          item,
        ),
      ).toBe(false);
      expect(identifierOnlyBefore(withPin, choice, 2, [username], item)).toBe(false);
      // Steps from the stop on are never run, so they do not count.
      expect(identifierOnlyBefore(emailFirst, choice, 2, [username], item)).toBe(true);
      expect(identifierOnlyBefore(emailFirst, choice, 4, [username], item)).toBe(false);
    });
  });
}
