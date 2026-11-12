import { expect, it, vi } from "vitest";
import { GENERATION_RETRY_MS } from "../../../src/service/generation";
import type { Requests1Context } from "./context";

export function registerRequests1(context: Requests1Context) {
  const {
    connection,
    observation,
    request,
    KEY,
    chooserOf,
    runs,
    recipeChange,
    entryChange,
    entryRequest,
    setup,
  } = context;

  it("sends a page once per retry window and refreshes the cache before reporting a recipe", async () => {
    const h = setup();
    expect(await h.generation.available(observation.origin, "/login")).toBe(true);
    expect(await h.generation.generate(request)).toMatchObject({ outcome: "recipe" });
    expect(h.transport.generateRecipe).toHaveBeenCalledWith(
      connection.origin,
      connection.credential,
      request,
    );
    expect(h.sync).toHaveBeenCalledTimes(1);
    // A generated recipe takes a full sync; only a judged page pulls recipes alone.
    expect(h.refresh).not.toHaveBeenCalled();

    // The same page is not sent again within the window; another path is.
    expect(await h.generation.available(observation.origin, "/login")).toBe("sent");
    expect(await h.generation.generate(request)).toEqual({ outcome: "skipped", reason: "sent" });
    expect(await h.generation.available(observation.origin, "/other")).toBe(true);
    expect(h.transport.generateRecipe).toHaveBeenCalledTimes(1);

    h.advance(GENERATION_RETRY_MS);
    expect(await h.generation.available(observation.origin, "/login")).toBe(true);
  });

  it("claims a page replacing a final advance click apart, keeping the other claims (ADR 0018)", async () => {
    const h = setup();
    expect(await h.generation.generate(request)).toMatchObject({ outcome: "recipe" });
    const base = { recipeId: recipeChange.recipeId, revision: 1 };
    const replacing = { ...request, base: { ...base, replacesLast: true as const }, branch: KEY };
    expect(await h.generation.generate(replacing)).toMatchObject({ outcome: "recipe" });
    // The store still reads: the first page's claim holds, and so does the replacement's.
    expect(await h.generation.available(observation.origin, "/login")).toBe("sent");
    expect(await h.generation.generate(request)).toEqual({ outcome: "skipped", reason: "sent" });
    expect(await h.generation.generate(replacing)).toEqual({ outcome: "skipped", reason: "sent" });
    // A continuation of the same revision is claimed apart from the replacement.
    expect(await h.generation.generate({ ...request, base, branch: KEY })).toMatchObject({
      outcome: "recipe",
    });
    expect(h.transport.generateRecipe).toHaveBeenCalledTimes(3);
  });

  it("takes a chooser recipe (ADR 0028) as the answer to a list of accounts only", async () => {
    const runsChooser = {
      version: 1 as const,
      id: recipeChange.recipeId,
      revision: 1,
      origin: observation.origin,
      chooser: { path: "/login", other: { by: "text" as const, value: "Use another" } },
    };
    const chooser = { ...recipeChange, recipe: chooserOf(runsChooser) };
    // A list is sent without slots (owner 2026-10-23 11:48 UTC), never skipped for that.
    const list = {
      ...request,
      observation: { ...observation, accounts: ["[email]"] },
      slots: [] as [],
    };
    const h = setup({ kind: "result", result: { version: 1, status: "recipe", change: chooser } });
    // The login runs the chooser's newest layout, which the list's page created (ADR 0060).
    expect(await h.generation.generate(list)).toEqual({
      outcome: "recipe",
      recipe: { ...runsChooser, layout: KEY },
    });
    expect(h.transport.generateRecipe).toHaveBeenCalledWith(
      connection.origin,
      connection.credential,
      list,
    );
    expect(h.sync).toHaveBeenCalled();
    // A route recipe never answers a list.
    const routed = setup({
      kind: "result",
      result: { version: 1, status: "recipe", change: recipeChange },
    });
    expect(await routed.generation.generate(list)).toEqual({
      outcome: "unavailable",
      reason: "recipe-conflict",
    });
  });

  it("takes a chooser recipe (ADR 0028) as the answer to a branch's page, claimed per branch", async () => {
    const runsChooser = {
      version: 1 as const,
      id: recipeChange.recipeId,
      revision: 2,
      origin: observation.origin,
      layout: KEY,
      chooser: {
        path: "/login",
        other: { by: "text" as const, value: "Use another" },
        afterAccount: { ...runs, revision: 2 },
      },
    };
    const chooser = { ...recipeChange, revision: 2, recipe: chooserOf(runsChooser) };
    const h = setup({ kind: "result", result: { version: 1, status: "recipe", change: chooser } });
    const base = { recipeId: recipeChange.recipeId, revision: 1 };
    // The branch names the chooser's layout it continues (ADR 0060).
    const account = { ...request, base, branch: `${KEY}:account` };
    expect(await h.generation.generate(account)).toEqual({
      outcome: "recipe",
      recipe: runsChooser,
    });
    expect(h.transport.generateRecipe).toHaveBeenCalledWith(
      connection.origin,
      connection.credential,
      account,
    );
    // A continuation pulls recipes alone, so its login is not stopped by settings.
    expect(h.refresh).toHaveBeenCalledTimes(1);
    expect(h.sync).not.toHaveBeenCalled();
    // The same page of the other branch is a request of its own, and so is its hold.
    expect(await h.generation.generate(account)).toEqual({ outcome: "skipped", reason: "sent" });
    expect(await h.generation.available(observation.origin, "/login", base, `${KEY}:account`)).toBe(
      "sent",
    );
    expect(await h.generation.available(observation.origin, "/login", base, `${KEY}:other`)).toBe(
      true,
    );
    expect(await h.generation.available(observation.origin, "/login")).toBe(true);
    expect(await h.generation.generate({ ...account, branch: `${KEY}:other` })).toMatchObject({
      outcome: "recipe",
    });
    expect(await h.generation.available(observation.origin, "/login", base, `${KEY}:other`)).toBe(
      "sent",
    );
    // A layout the chooser does not hold is no answer.
    const elsewhere = setup({
      kind: "result",
      result: { version: 1, status: "recipe", change: chooser },
    });
    expect(await elsewhere.generation.generate({ ...account, branch: "1:account" })).toEqual({
      outcome: "unavailable",
      reason: "recipe-conflict",
    });
    // A route recipe never answers a branch's page.
    const routed = setup();
    expect(await routed.generation.generate(account)).toEqual({
      outcome: "unavailable",
      reason: "recipe-conflict",
    });
  });

  it("takes no chooser recipe (ADR 0028) as the answer to a form page", async () => {
    const chooser = {
      ...recipeChange,
      recipe: chooserOf({
        version: 1 as const,
        id: recipeChange.recipeId,
        revision: 1,
        origin: observation.origin,
        chooser: { path: "/login" },
      }),
    };
    const h = setup({ kind: "result", result: { version: 1, status: "recipe", change: chooser } });
    expect(await h.generation.generate(request)).toEqual({
      outcome: "unavailable",
      reason: "recipe-conflict",
    });
    // The request reached the model, so the page is not sent again in the window.
    expect(await h.generation.available(observation.origin, "/login")).toBe("sent");
  });

  it("sends an entry page without slots and pulls its entry recipe (ADR 0031)", async () => {
    const h = setup();
    const sent = vi.fn();
    expect(await h.generation.generateEntry(entryRequest, sent)).toEqual({
      outcome: "recipe",
      recipe: entryChange.recipe,
    });
    expect(h.transport.generateEntry).toHaveBeenCalledWith(
      connection.origin,
      connection.credential,
      entryRequest,
    );
    expect(h.transport.generateRecipe).not.toHaveBeenCalled();
    expect(sent).toHaveBeenCalledTimes(1);
    // Cached through the full sync, as a first page's recipe is.
    expect(h.sync).toHaveBeenCalledTimes(1);
    expect(h.refresh).not.toHaveBeenCalled();
    // Claimed as any first page: the page is held for the retry window (ADR 0016).
    expect(await h.generation.available("https://shop.example", "/")).toBe("sent");
    expect(await h.generation.generateEntry(entryRequest, sent)).toEqual({
      outcome: "skipped",
      reason: "sent",
    });
    expect(h.transport.generateEntry).toHaveBeenCalledTimes(1);
  });

  it.each([
    [
      "an abstention",
      { kind: "result", result: { version: 1, status: "abstained", reason: "no-login-form" } },
      { outcome: "abstained", reason: "no-login-form" },
      "sent",
    ],
    [
      "an unreachable service",
      { kind: "failed", error: "unreachable" },
      { outcome: "failed", reason: "unreachable", retry: true },
      true,
    ],
  ] as const)(
    "answers an entry page's %s without syncing",
    async (_label, answer, outcome, held) => {
      const h = setup(undefined, answer);
      expect(await h.generation.generateEntry(entryRequest)).toEqual(outcome);
      expect(h.sync).not.toHaveBeenCalled();
      expect(await h.generation.available("https://shop.example", "/")).toBe(held);
    },
  );

  it("skips an entry page while no service is paired", async () => {
    const h = setup();
    h.service.connection.mockResolvedValue(undefined);
    expect(await h.generation.generateEntry(entryRequest)).toEqual({
      outcome: "skipped",
      reason: "not-connected",
      retry: true,
    });
    expect(h.transport.generateEntry).not.toHaveBeenCalled();
  });

  it("claims the page before sending, so two tabs send it once", async () => {
    const h = setup({
      kind: "result",
      result: { version: 1, status: "abstained", reason: "no-login-form" },
    });
    const sent = vi.fn();
    expect(
      await Promise.all([
        h.generation.generate(request, sent),
        h.generation.generate(request, sent),
      ]),
    ).toEqual([
      { outcome: "abstained", reason: "no-login-form" },
      { outcome: "skipped", reason: "sending", retry: true },
    ]);
    expect(h.transport.generateRecipe).toHaveBeenCalledTimes(1);
    // Only the request that left the device says it was sent (ADR 0019).
    expect(sent).toHaveBeenCalledTimes(1);
    expect(h.sync).not.toHaveBeenCalled();
  });

  it.each([
    [
      "an abstention",
      { kind: "result", result: { version: 1, status: "abstained", reason: "ambiguous" } },
      { outcome: "abstained", reason: "ambiguous" },
    ],
    [
      "a model failure",
      { kind: "result", result: { version: 1, status: "failed", error: "invalid-output" } },
      { outcome: "failed", reason: "invalid-output" },
    ],
    [
      "the model call's timeout",
      { kind: "result", result: { version: 1, status: "failed", error: "timeout" } },
      { outcome: "failed", reason: "timeout" },
    ],
    [
      "output the plan check refused",
      {
        kind: "result",
        result: {
          version: 1,
          status: "failed",
          error: "invalid-output",
          rejection: { check: "plan", reason: "incompatible-role" },
        },
      },
      { outcome: "failed", reason: "invalid-output", check: "plan", detail: "incompatible-role" },
    ],
    [
      "output the format refused",
      {
        kind: "result",
        result: {
          version: 1,
          status: "failed",
          error: "invalid-output",
          rejection: { check: "schema", issue: "max-length", path: "result.alternatives" },
        },
      },
      {
        outcome: "failed",
        reason: "invalid-output",
        check: "schema",
        detail: "max-length",
        path: "result.alternatives",
      },
    ],
    [
      "output the format refused at its top",
      {
        kind: "result",
        result: {
          version: 1,
          status: "failed",
          error: "invalid-output",
          rejection: { check: "schema", issue: "object", path: "" },
        },
      },
      { outcome: "failed", reason: "invalid-output", check: "schema", detail: "object" },
    ],
    [
      "output that was not JSON",
      {
        kind: "result",
        result: {
          version: 1,
          status: "failed",
          error: "invalid-output",
          rejection: { check: "json" },
        },
      },
      { outcome: "failed", reason: "invalid-output", check: "json" },
    ],
  ] as const)("keeps the page for the retry window after %s", async (_name, answer, outcome) => {
    const h = setup(answer);
    expect(await h.generation.generate(request)).toEqual(outcome);
    expect(await h.generation.available(observation.origin, "/login")).toBe("sent");
    h.advance(GENERATION_RETRY_MS - 1);
    expect(await h.generation.available(observation.origin, "/login")).toBe("sent");
  });
}
