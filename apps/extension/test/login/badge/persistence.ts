import { expect, it, vi } from "vitest";
import { LOGIN_BADGE_KEY } from "../../../src/login/badge";
import type { BadgeTestFixtures } from "../../../src/login/badge.test";

export function registerPersistenceCases({
  harness,
  attempt,
  start,
  origin,
  tabId,
  NONE,
  FAILED,
  SUCCEEDED,
}: Pick<
  BadgeTestFixtures,
  "harness" | "attempt" | "start" | "origin" | "tabId" | "NONE" | "FAILED" | "SUCCEEDED"
>) {
  it("persists results and spinning tabs", async () => {
    const h = harness();
    expect(LOGIN_BADGE_KEY).toMatch(/^session:/);
    h.badge.observe(attempt({ outcome: "timeout", cause: "elements-timeout" }));
    const stop = h.badge.spin(8);
    await h.flush();
    expect(h.setValue).toHaveBeenLastCalledWith({
      results: [[tabId, { kind: "failed", origin, reason: "timeout: elements-timeout" }]],
      busy: [8],
      statuses: [
        [
          tabId,
          { origin, login: { state: "blocked", outcome: "timeout", cause: "elements-timeout" } },
        ],
      ],
    });
    stop();
    await h.flush();
    expect(h.setValue).toHaveBeenLastCalledWith({
      results: [[tabId, expect.objectContaining({ kind: "failed" })]],
      busy: [],
      statuses: [[tabId, expect.objectContaining({ origin })]],
    });
  });

  it("keeps that a login only filled the form while its tab asks for an account", async () => {
    const h = harness();
    h.badge.observe(attempt({ outcome: "cancelled", reason: "fill-only" }));
    await h.flush();
    expect(h.setValue).toHaveBeenLastCalledWith(
      expect.objectContaining({
        statuses: [
          [tabId, { origin, login: { state: "blocked", outcome: "cancelled", fillOnly: true } }],
        ],
      }),
    );
    // A later login of the tab that is not fill-only drops it.
    h.badge.observe(attempt({ state: "ready" }));
    await h.flush();
    expect(h.setValue).toHaveBeenLastCalledWith(
      expect.objectContaining({ statuses: [[tabId, { origin, login: { state: "ready" } }]] }),
    );
  });

  it("restores unexpired results and clears the spins a stopped worker left", async () => {
    const now = Date.now();
    const h = harness({
      stored: {
        results: [
          [1, { kind: "failed", origin, reason: "timeout" }],
          [2, { kind: "succeeded", origin, reason: "authenticated", until: now + 1000 }],
          [3, { kind: "unsettled", origin, reason: "left-origin", until: now - 1 }],
        ],
        busy: [4],
        statuses: [],
      },
    });
    await h.badge.restore();
    await h.flush();
    expect(h.view(1)).toMatchObject(FAILED);
    expect(h.view(2)).toMatchObject(SUCCEEDED);
    expect(h.view(3)).toMatchObject(NONE);
    expect(h.view(4)).toMatchObject(NONE);
    expect(await h.storage.getValue()).toEqual({
      results: [
        [1, { kind: "failed", origin, reason: "timeout" }],
        [2, { kind: "succeeded", origin, reason: "authenticated", until: now + 1000 }],
      ],
      busy: [],
      statuses: [],
    });
    await vi.advanceTimersByTimeAsync(1000);
    expect(h.view(2)).toMatchObject(NONE);
    expect(await h.storage.getValue()).toEqual({
      results: [[1, { kind: "failed", origin, reason: "timeout" }]],
      busy: [],
      statuses: [],
    });
  });

  it("keeps a result reported before the restore", async () => {
    const h = harness({
      stored: {
        results: [[tabId, { kind: "failed", origin, reason: "timeout" }]],
        busy: [],
        statuses: [],
      },
    });
    h.badge.observe(attempt({ state: "authenticated" }));
    await h.badge.restore();
    await h.flush();
    expect(h.view()).toMatchObject(SUCCEEDED);
  });

  it("does not bring back a stored result for a tab whose login started during the restore", async () => {
    const h = harness({
      stored: {
        results: [
          [tabId, { kind: "failed", origin, reason: "timeout" }],
          [8, { kind: "failed", origin, reason: "timeout" }],
          [9, { kind: "failed", origin, reason: "timeout" }],
        ],
        busy: [],
        statuses: [],
      },
    });
    const restoring = h.badge.restore();
    h.badge.observe(start());
    h.badge.removed(8);
    await restoring;
    await h.flush();
    expect(h.view(tabId)).toMatchObject(NONE);
    expect(h.view(9)).toMatchObject(FAILED);
    expect(await h.storage.getValue()).toEqual({
      results: [[9, { kind: "failed", origin, reason: "timeout" }]],
      busy: [],
      // The started login is the tab's page status now.
      statuses: [[tabId, { origin, login: { state: "started" } }]],
    });
  });

  it("does not bring back a stored result for a tab whose top origin changed during the restore", async () => {
    const h = harness({
      stored: {
        results: [[tabId, { kind: "failed", origin, reason: "timeout" }]],
        busy: [],
        statuses: [],
      },
    });
    h.badge.loaded(tabId, `${origin}/`);
    const restoring = h.badge.restore();
    h.badge.loaded(tabId, "https://other.example/");
    await restoring;
    await h.flush();
    expect(await h.storage.getValue()).toEqual({ results: [], busy: [], statuses: [] });
  });

  it("does not bring back a stored result for a tab that first loaded another origin during the restore", async () => {
    const h = harness({
      stored: {
        results: [[tabId, { kind: "failed", origin, reason: "timeout" }]],
        busy: [],
        statuses: [],
      },
    });
    const restoring = h.badge.restore();
    h.badge.loaded(tabId, "https://other.example/");
    await restoring;
    await h.flush();
    expect(h.calls.filter((call) => call.text === "!")).toEqual([]);
    expect(await h.storage.getValue()).toEqual({ results: [], busy: [], statuses: [] });
  });

  it("keeps a stored result for a tab that loaded its origin during the restore", async () => {
    const h = harness({
      stored: {
        results: [[tabId, { kind: "failed", origin, reason: "timeout" }]],
        busy: [],
        statuses: [],
      },
    });
    const restoring = h.badge.restore();
    h.badge.loaded(tabId, `${origin}/account`);
    await restoring;
    await h.flush();
    expect(h.view()).toMatchObject(FAILED);
  });

  it("clears a restored result when the tab's first load after the restore is another origin", async () => {
    const h = harness({
      stored: {
        results: [[tabId, { kind: "failed", origin, reason: "timeout" }]],
        busy: [],
        statuses: [],
      },
    });
    await h.badge.restore();
    await h.flush();
    expect(h.view()).toMatchObject(FAILED);
    h.badge.loaded(tabId, "https://other.example/");
    await h.flush();
    expect(await h.storage.getValue()).toEqual({ results: [], busy: [], statuses: [] });
  });

  it("keeps a restored result when the tab's first load after the restore is its origin", async () => {
    const h = harness({
      stored: {
        results: [[tabId, { kind: "failed", origin, reason: "timeout" }]],
        busy: [],
        statuses: [],
      },
    });
    await h.badge.restore();
    await h.flush();
    const count = h.calls.length;
    h.badge.loaded(tabId, `${origin}/account`);
    await h.flush();
    expect(h.calls.slice(count)).toEqual([{ tabId, ...FAILED, title: expect.any(String) }]);
    expect(await h.storage.getValue()).toMatchObject({ results: [[tabId, { kind: "failed" }]] });
  });

  it.each([
    ["nothing", undefined],
    [
      "a malformed value",
      { results: [[1, { kind: "lost", origin, reason: "x" }]], busy: [], statuses: [] },
    ],
    ["a fractional tab", { results: [], busy: [1.5], statuses: [] }],
    [
      "a value without statuses",
      { results: [[1, { kind: "failed", origin, reason: "timeout" }]], busy: [] },
    ],
    [
      "a malformed status",
      {
        results: [[1, { kind: "failed", origin, reason: "timeout" }]],
        busy: [],
        statuses: [[1, { origin, generation: { outcome: "sent", page: "other" } }]],
      },
    ],
    ["a string", "busy"],
  ])("ignores %s in storage", async (_name, stored) => {
    const h = harness(stored === undefined ? {} : { stored });
    await h.badge.restore();
    await h.flush();
    expect(h.calls).toEqual([]);
  });

  it("ignores storage that cannot be read", async () => {
    const h = harness();
    vi.spyOn(h.storage, "getValue").mockRejectedValue(new Error("storage"));
    await expect(h.badge.restore()).resolves.toBeUndefined();
    expect(h.calls).toEqual([]);
  });

  it("keeps drawing when storage cannot be written", async () => {
    const h = harness();
    h.setValue.mockRejectedValue(new Error("quota"));
    h.badge.observe(attempt({ outcome: "timeout" }));
    h.badge.observe(start());
    h.badge.observe(attempt({ state: "authenticated" }));
    await h.flush();
    expect(h.view()).toMatchObject(SUCCEEDED);
    expect(h.setValue).toHaveBeenCalledTimes(3);
  });
}
