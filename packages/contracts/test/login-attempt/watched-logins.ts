import { describe, expect, it } from "vitest";
import {
  createAttemptMetadata,
  nextLoginOperation,
  parseAttemptMetadata,
  recoverLoginAttempt,
  pagesLeft,
  MAX_JUDGED_PAGES,
  transitionLoginAttempt,
} from "../../src/login-attempt";
import type { LoginDocument, LoginRecipe } from "../../src/login";
import type { LoginAttemptTestContext } from "./context";

export function registerChooserAttempts({
  facts,
  document,
  recipe,
  noTimeBefore,
}: Pick<LoginAttemptTestContext, "facts" | "document" | "recipe" | "noTimeBefore">): void {
  describe("a login on a chooser's list (ADR 0028)", () => {
    const listed = (chooser?: "entry" | "continue" | "other") =>
      transitionLoginAttempt(
        createAttemptMetadata({
          timing: noTimeBefore,
          id: "attempt-list",
          recipe,
          policyRevision: 3,
          account: { origin: document.origin, connectionId: "demo-personal", itemId: "primary" },
          choice: { route: "password", variant: 0 },
          facts,
          document,
          ...(chooser ? { chooser } : {}),
        }),
        { type: "RESOLVE" },
      );

    it("records its click, and ends account-not-listed before its first step", () => {
      const attempt = listed("other");
      expect(attempt.chooser).toEqual({ click: "other" });
      const ended = transitionLoginAttempt(attempt, { type: "NOT_LISTED" });
      expect(ended).toMatchObject({
        state: "blocked",
        outcome: "account-not-listed",
        submissions: 0,
      });
      expect(parseAttemptMetadata(ended)).toEqual(ended);
    });

    it("never ends a login that is not a chooser's, or that started its steps, that way", () => {
      expect(transitionLoginAttempt(listed(), { type: "NOT_LISTED" }).state).toBe("ready");
      const started = transitionLoginAttempt(listed("entry"), {
        type: "PREPARE",
        operationId: "fill-one",
        kind: "fill",
      });
      expect(transitionLoginAttempt(started, { type: "NOT_LISTED" })).toEqual(started);
      let filled = transitionLoginAttempt(started, {
        type: "MUTATION_INTENT",
        operationId: "fill-one",
      });
      filled = transitionLoginAttempt(filled, { type: "OPERATION_OK", operationId: "fill-one" });
      expect(filled).toMatchObject({ state: "ready", stepIndex: 1 });
      expect(transitionLoginAttempt(filled, { type: "NOT_LISTED" })).toEqual(filled);
    });
  });
}

export function registerWatchedAttempts({
  facts,
  document,
  recipe,
  noTimeBefore,
}: Pick<LoginAttemptTestContext, "facts" | "document" | "recipe" | "noTimeBefore">): void {
  describe("a login watched after a challenge or an unknown result (ADR 0027)", () => {
    const top: LoginDocument = { ...document, frameId: 0, documentId: "top-one" };
    const later: LoginDocument = { ...top, documentId: "top-two" };
    const withPasskey: LoginRecipe = {
      ...recipe,
      passkey: { path: "/login", target: { by: "id", value: "passkey-login" } },
    };
    function awaiting(at: LoginDocument = top, route: "password" | "passkey" = "password") {
      let attempt = transitionLoginAttempt(
        createAttemptMetadata({
          timing: noTimeBefore,
          id: "attempt-watched",
          recipe: withPasskey,
          policyRevision: 3,
          account: { origin: document.origin, connectionId: "demo-personal", itemId: "primary" },
          choice: route === "password" ? { route, variant: 0 } : { route },
          facts: { ...facts, passkey: true, discoverablePasskey: true },
          document: at,
        }),
        { type: "RESOLVE" },
      );
      if (route === "password") {
        attempt = transitionLoginAttempt(attempt, {
          type: "PREPARE",
          operationId: "fill-one",
          kind: "fill",
        });
        attempt = transitionLoginAttempt(attempt, {
          type: "MUTATION_INTENT",
          operationId: "fill-one",
        });
        attempt = transitionLoginAttempt(attempt, {
          type: "OPERATION_OK",
          operationId: "fill-one",
        });
      }
      attempt = transitionLoginAttempt(attempt, {
        type: "PREPARE",
        operationId: "click-one",
        kind: "click",
      });
      attempt = transitionLoginAttempt(attempt, {
        type: "SUBMIT_INTENT",
        operationId: "click-one",
      });
      return transitionLoginAttempt(attempt, { type: "SUBMITTED", operationId: "click-one" });
    }
    const observed = (
      result: "authenticated" | "credential-rejected" | "challenge" | "unknown",
      at = top,
    ) => ({ type: "OBSERVED" as const, result, document: at });

    it("completes a frame's login on its tab's new page only when the runtime confirmed it (ADR 0086)", () => {
      const frame = { ...top, frameId: 2, origin: document.origin, documentId: "frame-one" };
      const page = { ...top, origin: "https://portal.example", documentId: "page-two" };
      const submitted = awaiting(frame);
      expect(
        transitionLoginAttempt(submitted, { type: "NAVIGATED", document: page, signedIn: true }),
      ).toMatchObject({ state: "authenticated", outcome: "authenticated" });
      // Unconfirmed, the login ends without resubmitting, as before (ADR 0017).
      expect(
        transitionLoginAttempt(submitted, { type: "NAVIGATED", document: page }),
      ).toMatchObject({
        state: "blocked",
        outcome: "cancelled",
      });
      // A watched one ends where it stopped, or completes once confirmed.
      const watching = transitionLoginAttempt(submitted, observed("challenge", frame), 1000);
      expect(watching).toMatchObject({ state: "watching", watch: { documentId: "frame-one" } });
      const left = transitionLoginAttempt(watching, { type: "NAVIGATED", document: page });
      expect(left).toMatchObject({ state: "blocked", outcome: "challenge" });
      expect(left).not.toHaveProperty("watch");
      expect(
        transitionLoginAttempt(watching, { type: "NAVIGATED", document: page, signedIn: true }),
      ).toMatchObject({ state: "authenticated", outcome: "authenticated" });
      // Another frame of the tab is no new page around the login's frame.
      expect(
        transitionLoginAttempt(watching, {
          type: "NAVIGATED",
          document: { ...page, frameId: 3 },
          signedIn: true,
        }),
      ).toMatchObject({ state: "blocked", outcome: "cancelled" });
    });

    it("watches a top-level password login that stops at a challenge", () => {
      const watching = transitionLoginAttempt(awaiting(), observed("challenge"), 1000);
      expect(watching).toMatchObject({
        state: "watching",
        outcome: "challenge",
        watch: { since: 1000, documentId: "top-one", pages: 0 },
      });
      // A restart or a later page of the tab keeps the watch as it was.
      expect(recoverLoginAttempt(watching)).toEqual(watching);
      const moved = transitionLoginAttempt(watching, { type: "NAVIGATED", document: later }, 9000);
      expect(moved).toEqual({ ...watching, document: later });
      // It only reads: no step is issued or prepared.
      expect(nextLoginOperation(moved, withPasskey, later, "operation-two", 0)).toBeUndefined();
      expect(
        transitionLoginAttempt(moved, {
          type: "PREPARE",
          operationId: "operation-two",
          kind: "click",
        }),
      ).toEqual(moved);
      // A page that proves the sign-in completes it; a refused password ends it.
      const done = transitionLoginAttempt(moved, observed("authenticated", later));
      expect(done).toMatchObject({ state: "authenticated", outcome: "authenticated" });
      expect(done).not.toHaveProperty("watch");
      expect(transitionLoginAttempt(moved, observed("credential-rejected", later))).toMatchObject({
        state: "blocked",
        outcome: "credential-rejected",
      });
      // Anything else leaves it watched.
      for (const result of ["challenge", "unknown"] as const)
        expect(transitionLoginAttempt(moved, observed(result, later))).toEqual(moved);
      // The watch ends where the login stopped.
      const ended = transitionLoginAttempt(moved, { type: "WATCH_ENDED" });
      expect(ended).toMatchObject({ state: "blocked", outcome: "challenge" });
      expect(ended).not.toHaveProperty("watch");
      // The first step showing again before a sign-in abandons it (owner, 2026-10-13).
      const abandoned = transitionLoginAttempt(moved, { type: "WATCH_ENDED", abandoned: true });
      expect(abandoned).toMatchObject({ state: "blocked", outcome: "challenge-abandoned" });
      expect(abandoned).not.toHaveProperty("watch");
      // Leaving the origin ends it where it stopped, as the end of the watch does: it never
      // signed in (2026-10-13).
      const left = transitionLoginAttempt(moved, {
        type: "NAVIGATED",
        document: { ...later, origin: "https://elsewhere.example" },
      });
      expect(left).toMatchObject({ state: "blocked", outcome: "challenge" });
      expect(left).not.toHaveProperty("watch");
      const settled = transitionLoginAttempt(awaiting(), observed("unknown"), 1000);
      expect(settled).toMatchObject({ state: "reconciling", settled: true });
      expect(
        transitionLoginAttempt(settled, {
          type: "NAVIGATED",
          document: { ...later, origin: "https://elsewhere.example" },
        }),
      ).toMatchObject({ state: "blocked", outcome: "unknown-submit" });
    });

    it("takes newer settings over only while watched", () => {
      const watching = transitionLoginAttempt(awaiting(), observed("challenge"), 1000);
      const revised = {
        type: "POLICY_REVISED" as const,
        policyRevision: watching.policyRevision + 1,
      };
      expect(transitionLoginAttempt(watching, revised)).toEqual({
        ...watching,
        policyRevision: watching.policyRevision + 1,
      });
      // An older or the same revision changes nothing.
      for (const policyRevision of [watching.policyRevision, watching.policyRevision - 1])
        expect(
          transitionLoginAttempt(watching, { type: "POLICY_REVISED", policyRevision }),
        ).toEqual(watching);
      // A login that still issues steps is stopped by newer settings instead.
      const pending = awaiting();
      expect(transitionLoginAttempt(pending, { ...revised, policyRevision: 9 })).toEqual(pending);
    });

    it("watches a frame's challenge (ADR 0086) and the passkey route's (owner, 2026-11-08)", () => {
      expect(
        transitionLoginAttempt(
          awaiting({ ...top, frameId: 2 }),
          observed("challenge", { ...top, frameId: 2 }),
          1000,
        ),
      ).toMatchObject({ state: "watching", outcome: "challenge", watch: { since: 1000 } });
      const passkey = transitionLoginAttempt(awaiting(top, "passkey"), observed("challenge"), 1000);
      expect(passkey).toMatchObject({
        state: "watching",
        outcome: "challenge",
        watch: { since: 1000 },
      });
    });

    it("watches a result settled as unknown until the attempt moves on or the watch ends", () => {
      const unknown = transitionLoginAttempt(awaiting(), observed("unknown"), 2000);
      expect(unknown).toMatchObject({
        state: "reconciling",
        settled: true,
        watch: { since: 2000, documentId: "top-one", pages: 0 },
      });
      const moved = recoverLoginAttempt(
        transitionLoginAttempt(unknown, { type: "NAVIGATED", document: later }, 5000),
      );
      expect(moved.watch).toEqual(unknown.watch);
      // A challenge on a later page keeps the watch's start.
      expect(transitionLoginAttempt(moved, observed("challenge", later), 7000)).toMatchObject({
        state: "watching",
        watch: { since: 2000, documentId: "top-one" },
      });
      const ended = transitionLoginAttempt(moved, { type: "WATCH_ENDED" });
      expect(ended).toMatchObject({ state: "blocked", outcome: "unknown-submit" });
      expect(ended).not.toHaveProperty("watch");
      expect(transitionLoginAttempt(moved, { type: "WATCH_ENDED", abandoned: true })).toMatchObject(
        {
          state: "blocked",
          outcome: "watch-abandoned",
        },
      );
      // Only a watched login's watch ends.
      const pending = awaiting();
      for (const event of [{ type: "WATCH_ENDED" }, { type: "WATCH_ENDED", abandoned: true }])
        expect(transitionLoginAttempt(recoverLoginAttempt(pending), event)).toEqual(
          recoverLoginAttempt(pending),
        );
      // Moving on drops the watch with the settled result.
      const authenticated = transitionLoginAttempt(moved, observed("authenticated", later));
      expect(authenticated).not.toHaveProperty("watch");
    });

    it("judges at most two pages while watched, apart from the effect step's", () => {
      const judging = { type: "JUDGING" as const, operationId: "click-one" };
      const first = transitionLoginAttempt(awaiting(), judging);
      expect(first.judged).toEqual({ operationId: "click-one", pages: 1 });
      const watching = transitionLoginAttempt(first, observed("challenge"), 1000);
      expect(pagesLeft(watching, "click-one")).toBe(MAX_JUDGED_PAGES);
      const once = transitionLoginAttempt(watching, judging);
      const twice = transitionLoginAttempt(once, judging);
      expect(twice).toMatchObject({ judged: { pages: 1 }, watch: { pages: 2 } });
      expect(pagesLeft(twice, "click-one")).toBe(0);
      expect(transitionLoginAttempt(twice, judging)).toEqual(twice);
      // A page no model saw is given back to the watch.
      expect(
        transitionLoginAttempt(twice, { type: "UNJUDGED", operationId: "click-one" }),
      ).toMatchObject({ judged: { pages: 1 }, watch: { pages: 1 } });
      expect(
        transitionLoginAttempt(watching, { type: "UNJUDGED", operationId: "click-one" }),
      ).toEqual(watching);
    });

    it("refuses a watch on a login that is not watched, and a watched login without one", () => {
      const watching = transitionLoginAttempt(awaiting(), observed("challenge"), 1000);
      expect(() => parseAttemptMetadata({ ...watching, watch: undefined })).toThrow();
      expect(() => parseAttemptMetadata({ ...awaiting(), watch: watching.watch })).toThrow();
      expect(() =>
        parseAttemptMetadata({ ...watching, state: "awaiting-result", outcome: undefined }),
      ).toThrow();
    });
  });
}
