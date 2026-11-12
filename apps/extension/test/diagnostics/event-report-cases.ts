import { expect, it, vi } from "vitest";
import { createDiagnosticsLog } from "../../src/diagnostics/background";

export function registerEventReportCases() {
  it("logs what a sync changed, a judged page, a handler, what stopped a login and refused output", async () => {
    const recipeOrigin = "https://login.example";
    const log = createDiagnosticsLog({
      build: { version: "0.1.0", revision: "1c42ad3" },
      settings: async () => ({
        revision: 7,
        settings: {
          connections: [],
          accountPolicies: [],
          itemPolicies: [],
          customFieldReviews: [],
          excludedSites: [],
          passkeyBrowserSites: [],
          repromptSites: [],
          siteDefaults: [],
          bindings: [],
        },
      }),
      recipeCache: async () => ({ recipes: [{ origin: recipeOrigin }] }),
      connections: async () => ({ ok: true, kind: "status", connections: [] }),
      databaseName: `log-test-${crypto.randomUUID()}`,
      scope: { addEventListener: () => undefined } as never,
    });
    for (const level of ["debug", "info", "warn"] as const)
      vi.spyOn(console, level).mockImplementation(() => undefined);
    await log.logger.enableDebug();
    const unchanged = { scope: "full", added: 0, updated: 0, removed: 0 } as const;
    log.recipeSync("synced", unchanged);
    log.recipeSync("synced", { scope: "recipes", added: 0, updated: 1, removed: 0 });
    log.settingsChanged("synced");
    // The revision is read first, so the entry is awaited to keep the order.
    await vi.waitFor(async () =>
      expect((await log.logger.entries()).map((entry) => entry.event)).toContain(
        "settings.changed",
      ),
    );
    const page = {
      tabId: 3,
      origin: recipeOrigin,
      recipeId: "synthetic-recipe",
      recipeRevision: 1,
    };
    log.login({
      type: "judge",
      ...page,
      route: "password",
      verdict: "sent",
    });
    log.login({
      type: "judge",
      ...page,
      route: "password",
      verdict: "unclear",
      reason: "already-judged",
    });
    // An undecided answer that completed the login is a warning (ADR 0029).
    log.login({
      type: "judge",
      ...page,
      route: "password",
      verdict: "unclear",
      completed: true,
    });
    // So is one that did not complete it only because a disabled field was left out.
    log.login({
      type: "judge",
      ...page,
      route: "password",
      verdict: "unclear",
      disabledLeftOut: true,
      notCompleted: "disabled-left-out",
    });
    for (const reason of ["unreachable", "not-connected"])
      log.login({
        type: "judge",
        ...page,
        route: "password",
        verdict: "retry",
        reason,
      });
    // A continuation names the revision it continued and whether the login took it over.
    log.login({
      type: "generation",
      tabId: 3,
      origin: recipeOrigin,
      outcome: "recipe",
      recipeId: "synthetic-recipe",
      baseRevision: 1,
      takenOver: true,
    });
    // One not taken over says why, as a code (ADR 0027, amended 2026-10-19).
    log.login({
      type: "generation",
      tabId: 3,
      origin: recipeOrigin,
      outcome: "recipe",
      recipeId: "synthetic-recipe",
      baseRevision: 1,
      takenOver: false,
      notTakenOver: "binding-slots-mismatch",
    });
    log.login({
      type: "handler",
      ...page,
      handler: 0,
      kind: "passkey",
      outcome: "entered",
      steps: 1,
    });
    // A handler the page did not show, with why, as on VRChat's code page (#1381).
    log.login({
      type: "handler",
      ...page,
      handler: 1,
      kind: "totp",
      outcome: "not-shown",
      steps: 2,
      why: "ok.missing",
    });
    // ADR 0029's sign-in state: only the signs that show are written.
    const signs = { s1: true, s2: true, s3: false, s4: false, s5: false, f1: false, f2: true };
    log.login({
      type: "state",
      ...page,
      route: "password",
      ...signs,
      ...{ e1: false, e2: false, e3: false },
      // Read on the sign-in form shown again in a new document (ADR 0029).
      reshown: true,
      decision: "rejected",
    });
    // Why the form was not read as shown again, or no alert beside it counted: codes only.
    log.login({
      type: "state",
      ...page,
      route: "password",
      ...{ ...signs, s2: false, f2: false, e1: false, e2: false, e3: false },
      decision: "unknown",
      reshownMiss: "later-document",
    });
    log.login({
      type: "state",
      ...page,
      route: "password",
      ...{ ...signs, s2: false, f2: false, e1: false, e2: false, e3: false },
      reshown: true,
      decision: "unknown",
      alertMiss: "other-form",
    });
    // A result that settled while the sign-in form still showed says so.
    log.login({
      type: "attempt",
      ...page,
      route: "password",
      state: "reconciling",
      stepIndex: 2,
      stepCount: 2,
      outcome: "unknown-submit",
      cause: "sign-in-shown",
      settled: true,
    });
    log.login({
      type: "attempt",
      ...page,
      route: "password",
      variant: 1,
      state: "blocked",
      stepIndex: 2,
      stepCount: 3,
      operation: "click",
      effect: "submit",
      handler: 0,
      outcome: "policy-changed",
      cause: "settings-synced",
    });
    log.login({
      type: "attempt",
      ...page,
      route: "password",
      state: "authenticated",
      stepIndex: 2,
      stepCount: 2,
      outcome: "authenticated",
      unconfirmed: true,
    });
    // A recipe with several password variants names its first variant's refusal (ADR 0027).
    log.login({
      type: "refused",
      tabId: 3,
      origin: recipeOrigin,
      reason: "no-route",
      detail: "binding-not-found",
    });
    // Model output the service refused names the check, without the output.
    log.login({
      type: "generation",
      tabId: 3,
      origin: recipeOrigin,
      outcome: "failed",
      reason: "invalid-output",
      check: "schema",
      detail: "max-length",
      path: "result.alternatives",
    });
    log.login({
      type: "generation",
      tabId: 3,
      origin: recipeOrigin,
      outcome: "failed",
      reason: "invalid-output",
      check: "plan",
      detail: "incompatible-role",
    });
    // A page not sent names why its description was incomplete, as a code.
    log.login({
      type: "generation",
      tabId: 3,
      origin: recipeOrigin,
      outcome: "skipped",
      reason: "incomplete-observation",
      detail: "unlocated-button",
    });
    await vi.waitFor(async () => expect(await log.logger.entries()).toHaveLength(24));
    const entries = (await log.logger.entries()).filter((entry) => entry.event !== "log.debug");
    // Every entry the page caused names its tab; those the worker caused name none.
    expect(entries.map((entry) => entry.fields["tab"])).toEqual([
      undefined,
      undefined,
      undefined,
      ...Array.from({ length: 20 }, () => 3),
    ]);
    expect(
      entries.map(({ event, level, fields: { tab: _tab, ...fields } }) => [event, level, fields]),
    ).toEqual([
      // An unchanged sync is a debug entry; one that changed a recipe is info.
      ["service.sync", "debug", { outcome: "synced", scope: "full" }],
      ["service.sync", "info", { outcome: "synced", scope: "recipes", updated: 1 }],
      ["settings.changed", "info", { source: "synced", revision: 7 }],
      // A judgement request is info: it is all that is left when no answer comes.
      [
        "recipe.judge",
        "info",
        {
          origin: recipeOrigin,
          recipe: expect.any(String),
          recipeRevision: 1,
          route: "password",
          verdict: "sent",
        },
      ],
      [
        "recipe.judge",
        "info",
        {
          origin: recipeOrigin,
          recipe: expect.any(String),
          recipeRevision: 1,
          route: "password",
          verdict: "unclear",
          reason: "already-judged",
        },
      ],
      [
        "recipe.judge",
        "warn",
        {
          origin: recipeOrigin,
          recipe: expect.any(String),
          recipeRevision: 1,
          route: "password",
          verdict: "unclear",
          completed: true,
        },
      ],
      [
        "recipe.judge",
        "warn",
        {
          origin: recipeOrigin,
          recipe: expect.any(String),
          recipeRevision: 1,
          route: "password",
          verdict: "unclear",
          disabledLeftOut: true,
          notCompleted: "disabled-left-out",
        },
      ],
      // A request that failed is a problem; with no paired service nothing was sent.
      [
        "recipe.judge",
        "warn",
        {
          origin: recipeOrigin,
          recipe: expect.any(String),
          recipeRevision: 1,
          route: "password",
          verdict: "retry",
          reason: "unreachable",
        },
      ],
      [
        "recipe.judge",
        "info",
        {
          origin: recipeOrigin,
          recipe: expect.any(String),
          recipeRevision: 1,
          route: "password",
          verdict: "retry",
          reason: "not-connected",
        },
      ],
      [
        "recipe.generate",
        "info",
        {
          origin: recipeOrigin,
          outcome: "recipe",
          recipe: expect.any(String),
          baseRevision: 1,
          takenOver: true,
        },
      ],
      [
        "recipe.generate",
        "info",
        {
          origin: recipeOrigin,
          outcome: "recipe",
          recipe: expect.any(String),
          baseRevision: 1,
          takenOver: false,
          notTakenOver: "binding-slots-mismatch",
        },
      ],
      [
        "login.handler",
        "info",
        {
          origin: recipeOrigin,
          recipe: expect.any(String),
          recipeRevision: 1,
          handler: 0,
          kind: "passkey",
          outcome: "entered",
          steps: 1,
        },
      ],
      [
        "login.handler",
        "info",
        {
          origin: recipeOrigin,
          recipe: expect.any(String),
          recipeRevision: 1,
          handler: 1,
          kind: "totp",
          outcome: "not-shown",
          steps: 2,
          why: "ok.missing",
        },
      ],
      [
        "login.state",
        "info",
        {
          origin: recipeOrigin,
          recipe: expect.any(String),
          recipeRevision: 1,
          route: "password",
          decision: "rejected",
          s1: true,
          s2: true,
          f2: true,
          reshown: true,
        },
      ],
      [
        "login.state",
        "info",
        {
          origin: recipeOrigin,
          recipe: expect.any(String),
          recipeRevision: 1,
          route: "password",
          decision: "unknown",
          s1: true,
          reshownMiss: "later-document",
        },
      ],
      [
        "login.state",
        "info",
        {
          origin: recipeOrigin,
          recipe: expect.any(String),
          recipeRevision: 1,
          route: "password",
          decision: "unknown",
          s1: true,
          reshown: true,
          alertMiss: "other-form",
        },
      ],
      [
        "login.attempt",
        "warn",
        {
          origin: recipeOrigin,
          recipe: expect.any(String),
          recipeRevision: 1,
          route: "password",
          state: "reconciling",
          step: 2,
          steps: 2,
          outcome: "unknown-submit",
          cause: "sign-in-shown",
          settled: true,
        },
      ],
      [
        "login.attempt",
        "warn",
        {
          origin: recipeOrigin,
          recipe: expect.any(String),
          recipeRevision: 1,
          route: "password",
          variant: 1,
          state: "blocked",
          step: 2,
          steps: 3,
          operation: "click",
          effect: "submit",
          handler: 0,
          outcome: "policy-changed",
          cause: "settings-synced",
        },
      ],
      [
        "login.attempt",
        "info",
        {
          origin: recipeOrigin,
          recipe: expect.any(String),
          recipeRevision: 1,
          route: "password",
          state: "authenticated",
          step: 2,
          steps: 2,
          outcome: "authenticated",
          unconfirmed: true,
        },
      ],
      [
        "login.refused",
        "info",
        { origin: recipeOrigin, reason: "no-route", detail: "binding-not-found" },
      ],
      [
        "recipe.generate",
        "warn",
        {
          origin: recipeOrigin,
          outcome: "failed",
          reason: "invalid-output",
          check: "schema",
          detail: "max-length",
          path: "result.alternatives",
        },
      ],
      [
        "recipe.generate",
        "warn",
        {
          origin: recipeOrigin,
          outcome: "failed",
          reason: "invalid-output",
          check: "plan",
          detail: "incompatible-role",
        },
      ],
      [
        "recipe.generate",
        "info",
        {
          origin: recipeOrigin,
          outcome: "skipped",
          reason: "incomplete-observation",
          detail: "unlocated-button",
        },
      ],
    ]);
    vi.restoreAllMocks();
  });
}
