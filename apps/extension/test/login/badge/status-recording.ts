import { expect, it } from "vitest";
import type { BadgeTestFixtures } from "../../../src/login/badge.test";
import type { LoginReport } from "../../../src/login/runtime/report";

type Generation = Extract<LoginReport, { type: "generation" }>;

export function registerStatusRecordingCases({
  harness,
  attempt,
  start,
  refused,
  origin,
  tabId,
  report,
}: Pick<BadgeTestFixtures, "harness" | "attempt" | "start" | "refused" | "origin" | "tabId"> & {
  report: (fields: Partial<Generation> & Pick<Generation, "outcome">) => Generation;
}) {
  it("records a login's start, then each state, outcome and cause", () => {
    const h = harness();
    expect(h.badge.status(tabId)).toBeUndefined();
    h.badge.observe(start());
    expect(h.badge.status(tabId)).toEqual({ origin, login: { state: "started" } });
    h.badge.observe(attempt({ state: "executing" }));
    expect(h.badge.status(tabId)).toEqual({ origin, login: { state: "executing" } });
    h.badge.observe(attempt({ outcome: "timeout", cause: "elements-timeout" }));
    expect(h.badge.status(tabId)).toEqual({
      origin,
      login: { state: "blocked", outcome: "timeout", cause: "elements-timeout" },
    });
    // A new login starts afresh: no outcome or cause of the one before stays.
    h.badge.observe(start());
    expect(h.badge.status(tabId)).toEqual({ origin, login: { state: "started" } });
    // Another tab keeps its own.
    h.badge.observe(attempt({ tabId: 8, state: "authenticated" }));
    expect(h.badge.status(8)).toEqual({ origin, login: { state: "authenticated" } });
    expect(h.badge.status(tabId)).toEqual({ origin, login: { state: "started" } });
  });

  it("ignores repeat attempts, ordinary refusals and choices", () => {
    const h = harness();
    h.badge.observe(attempt({ state: "executing" }));
    h.badge.observe(attempt({ state: "authenticated", repeat: true }));
    h.badge.observe(attempt({ outcome: "timeout", repeat: true }));
    h.badge.observe(refused("no-recipe"));
    h.badge.observe({ type: "choice", tabId, origin, outcome: "saved" });
    expect(h.badge.status(tabId)).toEqual({ origin, login: { state: "executing" } });
    h.badge.observe(refused("no-recipe"));
    expect(h.badge.status(8)).toBeUndefined();
  });

  it("records a model request and what came back, but not a skipped one", () => {
    const h = harness();
    h.badge.observe(report({ outcome: "skipped", reason: "sent" }));
    expect(h.badge.status(tabId)).toBeUndefined();
    h.badge.observe(report({ outcome: "sent" }));
    expect(h.badge.status(tabId)).toEqual({ origin, generation: { outcome: "sent" } });
    h.badge.observe(report({ outcome: "failed", reason: "invalid-output", check: "schema" }));
    expect(h.badge.status(tabId)).toEqual({
      origin,
      generation: { outcome: "failed", reason: "invalid-output" },
    });
    // A skip leaves the last request as it was.
    h.badge.observe(report({ outcome: "skipped", reason: "not-connected" }));
    expect(h.badge.status(tabId)).toEqual({
      origin,
      generation: { outcome: "failed", reason: "invalid-output" },
    });
  });

  it.each([
    ["a list of accounts", { page: "accounts" as const }, "accounts"],
    ["a sign-in entry", { page: "entry" as const }, "entry"],
    ["a continuation", { recipeId: "recipe", baseRevision: 1 }, "continuation"],
    [
      "a chooser's other branch page",
      { page: "other" as const, recipeId: "r", baseRevision: 1 },
      "continuation",
    ],
    ["a list of accounts after a recipe", { page: "accounts" as const, recipeId: "r" }, "accounts"],
    ["a sign-in page", {}, undefined],
  ])("tells %s apart", (_name, fields, page) => {
    const h = harness();
    h.badge.observe(report({ outcome: "recipe", ...fields }));
    expect(h.badge.status(tabId)).toEqual({
      origin,
      generation: page ? { outcome: "recipe", page } : { outcome: "recipe" },
    });
  });

  it("keeps a login and a model request of one origin together", () => {
    const h = harness();
    h.badge.observe(report({ outcome: "recipe" }));
    h.badge.observe(attempt({ state: "authenticated" }));
    expect(h.badge.status(tabId)).toEqual({
      origin,
      login: { state: "authenticated" },
      generation: { outcome: "recipe" },
    });
    h.badge.observe(start());
    expect(h.badge.status(tabId)).toEqual({
      origin,
      login: { state: "started" },
      generation: { outcome: "recipe" },
    });
  });

  it("starts afresh for a report of another origin before any load", () => {
    const h = harness();
    h.badge.observe(attempt({ state: "authenticated" }));
    h.badge.observe(report({ origin: "https://other.example", outcome: "sent" }));
    expect(h.badge.status(tabId)).toEqual({
      origin: "https://other.example",
      generation: { outcome: "sent" },
    });
  });

  it("gives a frame's reports the tab's top origin and keeps them together", () => {
    const h = harness();
    h.badge.loaded(tabId, "https://shop.example/checkout");
    h.badge.observe(report({ outcome: "sent" }));
    h.badge.observe(attempt({ origin: "https://frame.example", state: "executing" }));
    expect(h.badge.status(tabId)).toEqual({
      origin: "https://shop.example",
      login: { state: "executing" },
      generation: { outcome: "sent" },
    });
  });

  it("keeps the status on same-origin loads and drops it on a top-origin change", async () => {
    const h = harness();
    h.badge.loaded(tabId, `${origin}/signin`);
    h.badge.observe(attempt({ outcome: "credential-rejected" }));
    h.badge.loaded(tabId, `${origin}/again`);
    expect(h.badge.status(tabId)).toEqual({
      origin,
      login: { state: "blocked", outcome: "credential-rejected" },
    });
    h.badge.loaded(tabId, "https://other.example/");
    expect(h.badge.status(tabId)).toBeUndefined();
    await h.flush();
    expect(await h.storage.getValue()).toEqual({ results: [], busy: [], statuses: [] });

    // A status without a result is dropped and saved too.
    h.badge.observe(report({ origin: "https://other.example", outcome: "sent" }));
    await h.flush();
    expect(await h.storage.getValue()).toMatchObject({ statuses: [[tabId, expect.anything()]] });
    h.badge.loaded(tabId);
    expect(h.badge.status(tabId)).toBeUndefined();
    await h.flush();
    expect(await h.storage.getValue()).toEqual({ results: [], busy: [], statuses: [] });
  });

  it("starts afresh after a top-origin change and back", () => {
    const h = harness();
    h.badge.loaded(tabId, `${origin}/`);
    h.badge.observe(report({ outcome: "recipe" }));
    h.badge.loaded(tabId, "https://other.example/");
    h.badge.loaded(tabId, `${origin}/`);
    h.badge.observe(attempt({ state: "executing" }));
    expect(h.badge.status(tabId)).toEqual({ origin, login: { state: "executing" } });
  });

  it("drops a removed tab's status", async () => {
    const h = harness();
    h.badge.observe(report({ outcome: "sent" }));
    await h.flush();
    h.setValue.mockClear();
    h.badge.removed(tabId);
    expect(h.badge.status(tabId)).toBeUndefined();
    await h.flush();
    expect(h.setValue).toHaveBeenCalledTimes(1);
    expect(await h.storage.getValue()).toEqual({ results: [], busy: [], statuses: [] });
  });

  it("moves a replaced tab's status to its new ID", async () => {
    const h = harness();
    h.badge.loaded(tabId, `${origin}/`);
    h.badge.observe(report({ outcome: "abstained", reason: "no-form" }));
    h.badge.replaced(8, tabId);
    expect(h.badge.status(tabId)).toBeUndefined();
    expect(h.badge.status(8)).toEqual({
      origin,
      generation: { outcome: "abstained", reason: "no-form" },
    });
    await h.flush();
    expect(await h.storage.getValue()).toEqual({
      results: [],
      busy: [],
      statuses: [[8, { origin, generation: { outcome: "abstained", reason: "no-form" } }]],
    });
    // The new tab keeps the top origin: a later report merges, another origin drops it.
    h.badge.observe(attempt({ tabId: 8, origin: "https://frame.example", state: "executing" }));
    expect(h.badge.status(8)).toMatchObject({ origin, login: { state: "executing" } });
    h.badge.loaded(8, "https://other.example/");
    expect(h.badge.status(8)).toBeUndefined();
  });

  it("saves once per report, and not when the status stays", async () => {
    const h = harness();
    // A result and a status from one report share one save.
    h.badge.observe(attempt({ outcome: "timeout" }));
    await h.flush();
    expect(h.setValue).toHaveBeenCalledTimes(1);
    expect(h.setValue).toHaveBeenLastCalledWith({
      results: [[tabId, { kind: "failed", origin, reason: "timeout" }]],
      busy: [],
      statuses: [[tabId, { origin, login: { state: "blocked", outcome: "timeout" } }]],
    });
    // A start clears the result and records the start: one save.
    h.badge.observe(start());
    await h.flush();
    expect(h.setValue).toHaveBeenCalledTimes(2);
    expect(h.setValue).toHaveBeenLastCalledWith({
      results: [],
      busy: [],
      statuses: [[tabId, { origin, login: { state: "started" } }]],
    });
    // A second start changes nothing.
    h.badge.observe(start());
    await h.flush();
    expect(h.setValue).toHaveBeenCalledTimes(2);
    // A status change without a result change saves once.
    h.badge.observe(report({ outcome: "sent" }));
    await h.flush();
    expect(h.setValue).toHaveBeenCalledTimes(3);
    // The same request again, a skip, or a repeat changes nothing.
    h.badge.observe(report({ outcome: "sent" }));
    h.badge.observe(report({ outcome: "skipped", reason: "sent" }));
    h.badge.observe(attempt({ state: "executing", repeat: true }));
    await h.flush();
    expect(h.setValue).toHaveBeenCalledTimes(3);
    // A failed request sets both result and status: one save.
    h.badge.observe(report({ outcome: "failed", reason: "invalid-output" }));
    await h.flush();
    expect(h.setValue).toHaveBeenCalledTimes(4);
    expect(h.setValue).toHaveBeenLastCalledWith({
      results: [[tabId, { kind: "failed", origin, reason: "generation failed: invalid-output" }]],
      busy: [],
      statuses: [
        [
          tabId,
          {
            origin,
            login: { state: "started" },
            generation: { outcome: "failed", reason: "invalid-output" },
          },
        ],
      ],
    });
  });
}
