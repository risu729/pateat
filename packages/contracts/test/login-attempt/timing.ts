import { describe, expect, it } from "vitest";
import {
  addAttemptTime,
  attemptTimes,
  awaitPerson,
  followPage,
  personAnswered,
  createAttemptMetadata,
  parseAttemptMetadata,
  recoverLoginAttempt,
  transitionLoginAttempt,
} from "../../src/login-attempt";
import { type LoginDocument } from "../../src/login";
import type { LoginAttemptTestContext } from "./context";

export function registerAttemptTiming({
  facts,
  document,
  recipe,
  noTimeBefore,
  detected,
}: Pick<
  LoginAttemptTestContext,
  "facts" | "document" | "recipe" | "noTimeBefore" | "detected"
>): void {
  describe("a login's own times for the local log (ADR 0019)", () => {
    const top: LoginDocument = { ...document, frameId: 0, documentId: "top-one" };
    const timing = { since: 1_000, serviceMs: 3_000, networkMs: 400, personMs: 0, pageMs: 0 };
    /** A login whose click was sent at `at`, and that waits for the site's answer since then. */
    function submitted(
      at = 5_000,
      on: LoginDocument = top,
      route: "password" | "passkey" = "password",
    ) {
      let attempt = transitionLoginAttempt(
        createAttemptMetadata({
          id: "attempt-timed",
          recipe:
            route === "password"
              ? recipe
              : { ...recipe, passkey: { path: "/login", target: { by: "id", value: "passkey" } } },
          policyRevision: 3,
          account: { origin: document.origin, connectionId: "demo-personal", itemId: "primary" },
          choice: route === "password" ? { route, variant: 0 } : { route },
          facts: route === "password" ? facts : { ...facts, passkey: true },
          document: on,
          timing,
        }),
        { type: "RESOLVE" },
        at,
      );
      for (const event of [
        ...(route === "password"
          ? [
              { type: "PREPARE", operationId: "fill-one", kind: "fill" },
              { type: "MUTATION_INTENT", operationId: "fill-one" },
              { type: "OPERATION_OK", operationId: "fill-one" },
            ]
          : []),
        { type: "PREPARE", operationId: "click-one", kind: "click" },
        { type: "SUBMIT_INTENT", operationId: "click-one" },
        { type: "SUBMITTED", operationId: "click-one" },
      ])
        attempt = transitionLoginAttempt(attempt, event, at);
      return attempt;
    }
    const observed = (result: "authenticated" | "challenge" | "unknown") => ({
      type: "OBSERVED" as const,
      result,
      document: top,
    });
    const sum = (times: ReturnType<typeof attemptTimes>) =>
      times.serviceMs + times.personMs + times.pageMs + times.otherMs;

    it("starts with the time spent before the login, and waits for the site once it clicked", () => {
      expect(submitted().timing).toEqual({ ...timing, pageSince: 5_000 });
      expect(detected().timing).toEqual(noTimeBefore);
    });

    it("counts the wait for the site from a click until the login read its answer", () => {
      const done = transitionLoginAttempt(submitted(), observed("authenticated"), 8_000);
      expect(done.state).toBe("authenticated");
      expect(done.timing).toEqual({ ...timing, pageMs: 3_000 });
      const times = attemptTimes(done, 8_000);
      expect(times).toEqual({
        totalMs: 7_000,
        serviceMs: 3_000,
        networkMs: 400,
        personMs: 0,
        pageMs: 3_000,
        otherMs: 1_000,
      });
      expect(sum(times)).toBe(times.totalMs);
    });

    it("keeps waiting for the site across a new page and a worker restart", () => {
      // The click replaced the document: the restarted worker reads the record back, and
      // the next page resumes the login.
      const restored = recoverLoginAttempt(JSON.parse(JSON.stringify(submitted())));
      expect(restored.timing.pageSince).toBe(5_000);
      const next: LoginDocument = { ...top, documentId: "top-two" };
      const navigated = transitionLoginAttempt(
        restored,
        { type: "NAVIGATED", document: next },
        9_000,
      );
      expect(navigated).toMatchObject({ state: "reconciling", timing: { pageSince: 5_000 } });
      const done = transitionLoginAttempt(
        navigated,
        { type: "OBSERVED", result: "authenticated", document: next },
        11_000,
      );
      expect(attemptTimes(done, 11_000)).toMatchObject({ pageMs: 6_000, otherMs: 1_000 });
    });

    it("moves the wait for the site on by service time, so nothing counts twice", () => {
      const judged = addAttemptTime(submitted(), { serviceMs: 2_000, networkMs: 300 }, 9_000);
      expect(judged.timing.pageSince).toBe(7_000);
      const done = transitionLoginAttempt(judged, observed("authenticated"), 10_000);
      const times = attemptTimes(done, 10_000);
      expect(times).toEqual({
        totalMs: 9_000,
        serviceMs: 5_000,
        networkMs: 700,
        personMs: 0,
        pageMs: 3_000,
        otherMs: 1_000,
      });
      expect(sum(times)).toBe(times.totalMs);
    });

    it("ends the wait for the site while the person acts, and takes it up again after them", () => {
      const waiting = awaitPerson(submitted(), 6_000);
      expect(waiting.timing).toEqual({ ...timing, pageMs: 1_000, personSince: 6_000 });
      // A transition while the person acts starts no wait for the site.
      expect(
        transitionLoginAttempt(waiting, { type: "INTERRUPTED" }, 7_000).timing.pageSince,
      ).toBeUndefined();
      const pressed = followPage(personAnswered(waiting, 9_000), 9_000);
      expect(pressed.timing).toEqual({
        ...timing,
        pageMs: 1_000,
        personMs: 3_000,
        pageSince: 9_000,
      });
      const done = transitionLoginAttempt(pressed, observed("authenticated"), 10_000);
      const times = attemptTimes(done, 10_000);
      expect(times).toMatchObject({ personMs: 3_000, pageMs: 2_000, otherMs: 1_000 });
      expect(sum(times)).toBe(times.totalMs);
      // A login that is not waiting for a step's result waits for no site.
      const ready = transitionLoginAttempt(
        createAttemptMetadata({
          id: "attempt-ready",
          recipe,
          policyRevision: 3,
          account: { origin: document.origin, connectionId: "demo-personal", itemId: "primary" },
          choice: { route: "password", variant: 0 },
          facts,
          document: top,
          timing,
        }),
        { type: "RESOLVE" },
        2_000,
      );
      expect(followPage(ready, 3_000)).toBe(ready);
    });

    it("watches a passkey login's result settled as unknown, as a password login's", () => {
      const settled = transitionLoginAttempt(
        submitted(5_000, top, "passkey"),
        { type: "OBSERVED", result: "unknown", document: top },
        10_000,
      );
      expect(settled).toMatchObject({
        state: "reconciling",
        settled: true,
        watch: { since: 10_000 },
        timing: { pageMs: 5_000 },
      });
    });

    it("counts a watched login's wait as the person's, also across a worker restart", () => {
      const watching = transitionLoginAttempt(submitted(), observed("challenge"), 10_000);
      expect(watching).toMatchObject({
        state: "watching",
        timing: { pageMs: 5_000, personSince: 10_000 },
      });
      expect(watching.timing.pageSince).toBeUndefined();
      // A restarted worker reads the record back and keeps the running wait.
      const restored = recoverLoginAttempt(JSON.parse(JSON.stringify(watching)));
      expect(restored.timing).toEqual(watching.timing);
      expect(attemptTimes(restored, 25_000)).toEqual({
        totalMs: 24_000,
        serviceMs: 3_000,
        networkMs: 400,
        personMs: 15_000,
        pageMs: 5_000,
        otherMs: 1_000,
      });
      // The page that proves the sign-in ends the wait.
      const done = transitionLoginAttempt(restored, observed("authenticated"), 40_000);
      expect(done.state).toBe("authenticated");
      expect(done.timing).toEqual({ ...timing, personMs: 30_000, pageMs: 5_000 });
      expect(attemptTimes(done, 41_000)).toEqual({
        totalMs: 40_000,
        serviceMs: 3_000,
        networkMs: 400,
        personMs: 30_000,
        pageMs: 5_000,
        otherMs: 2_000,
      });
    });

    it("ends a watch that ran out with the person's time up to then", () => {
      const watching = transitionLoginAttempt(submitted(), observed("challenge"), 10_000);
      const ended = transitionLoginAttempt(watching, { type: "WATCH_ENDED" }, 70_000);
      expect(ended).toMatchObject({ state: "blocked", timing: { personMs: 60_000 } });
      expect(ended.timing.personSince).toBeUndefined();
    });

    it("counts the watch of a login whose result settled as unknown as the person's", () => {
      const settled = transitionLoginAttempt(submitted(), observed("unknown"), 10_000);
      expect(settled).toMatchObject({
        state: "reconciling",
        settled: true,
        timing: { pageMs: 5_000, personSince: 10_000 },
      });
      expect(settled.timing.pageSince).toBeUndefined();
      const ended = transitionLoginAttempt(settled, { type: "WATCH_ENDED" }, 70_000);
      expect(ended).toMatchObject({ state: "blocked", timing: { personMs: 60_000 } });
      expect(attemptTimes(ended, 70_000)).toEqual({
        totalMs: 69_000,
        serviceMs: 3_000,
        networkMs: 400,
        personMs: 60_000,
        pageMs: 5_000,
        otherMs: 1_000,
      });
    });

    it("moves a running wait for the person on by service time, so nothing counts twice", () => {
      const waiting = awaitPerson(submitted(), 10_000);
      expect(awaitPerson(waiting, 12_000)).toBe(waiting);
      const judged = addAttemptTime(waiting, { serviceMs: 2_000.4, networkMs: 300 }, 13_000);
      expect(judged.timing).toEqual({
        ...timing,
        serviceMs: 5_000,
        networkMs: 700,
        pageMs: 5_000,
        personSince: 12_000,
      });
      // Service time never moves the wait past now.
      expect(addAttemptTime(waiting, { serviceMs: 9_000 }, 11_000).timing.personSince).toBe(11_000);
      expect(personAnswered(judged, 20_000).timing).toEqual({
        ...timing,
        serviceMs: 5_000,
        networkMs: 700,
        pageMs: 5_000,
        personMs: 8_000,
      });
      const ready = transitionLoginAttempt(submitted(), observed("authenticated"), 6_000);
      expect(personAnswered(ready, 20_000)).toEqual(ready);
    });

    it("never reports a negative time, as after a clock that moved back", () => {
      const attempt = addAttemptTime(submitted(), { serviceMs: 9_000, personMs: -5 }, 5_000);
      expect(attemptTimes(attempt, 500)).toEqual({
        totalMs: 0,
        serviceMs: 12_000,
        networkMs: 400,
        personMs: 0,
        pageMs: 0,
        otherMs: 0,
      });
    });

    it("never lets the wait for the site make the parts more than the total", () => {
      const attempt = parseAttemptMetadata({
        ...submitted(),
        timing: { ...timing, pageMs: 50_000 },
      });
      const times = attemptTimes(attempt, 10_000);
      expect(times).toMatchObject({ totalMs: 9_000, pageMs: 6_000, otherMs: 0 });
      expect(sum(times)).toBe(times.totalMs);
    });
  });
}
