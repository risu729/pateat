import { expect, it, vi } from "vitest";
import { createLoginGeneration, GENERATION_SENDING_MS } from "../../../src/service/generation";
import type { Requests2Context } from "./context";

export function registerRequests2(context: Requests2Context) {
  const { connection, observation, request, KEY, storedOf, route, recipeChange, setup, freed } =
    context;

  it.each(freed)("may send the page again after %s", async (_name, answer, outcome, reason) => {
    const h = setup(answer);
    expect(await h.generation.generate(request)).toEqual({ outcome, reason, retry: true });
    expect(await h.generation.available(observation.origin, "/login")).toBe(true);
    expect(await h.generation.generate(request)).toEqual({ outcome, reason, retry: true });
    expect(h.transport.generateRecipe).toHaveBeenCalledTimes(2);
  });

  it("frees a page whose request threw or never answered", async () => {
    const h = setup();
    h.transport.generateRecipe.mockRejectedValueOnce(new Error("transport"));
    await expect(h.generation.generate(request)).rejects.toThrow("transport");
    expect(await h.generation.available(observation.origin, "/login")).toBe(true);

    // A worker stopped or reloaded mid-request never runs its answer's code: the claim
    // holds only while the request could still be in flight.
    h.transport.generateRecipe.mockReturnValueOnce(new Promise(() => undefined));
    void h.generation.generate(request);
    await vi.waitFor(() => expect(h.transport.generateRecipe).toHaveBeenCalledTimes(2));
    const restarted = createLoginGeneration({
      service: h.service,
      transport: h.transport,
      storage: h.storage,
      slotStorage: { read: async () => undefined, write: async () => undefined },
      sync: h.sync,
      refresh: h.refresh,
      now: h.now,
    });
    expect(await restarted.available(observation.origin, "/login")).toBe("sending");
    h.advance(GENERATION_SENDING_MS);
    expect(await restarted.available(observation.origin, "/login")).toBe(true);
  });

  it("keeps other pages' claims when storage cannot be read", async () => {
    const h = setup();
    expect(await h.generation.generate(request)).toMatchObject({ outcome: "recipe" });
    h.storage.read.mockRejectedValueOnce(new Error("read"));
    expect(
      await h.generation.generate({ ...request, observation: { ...observation, path: "/other" } }),
    ).toEqual({ outcome: "skipped", reason: "storage-unavailable", retry: true });
    expect(await h.generation.available(observation.origin, "/login")).toBe("sent");
    expect(h.transport.generateRecipe).toHaveBeenCalledTimes(1);
  });

  it("treats a claims record it cannot parse as holding no claims", async () => {
    const h = setup();
    await h.storage.write({
      version: 1,
      attempts: [{ origin: observation.origin, path: "/login", at: h.now() }],
    });
    expect(await h.generation.available(observation.origin, "/login")).toBe(true);
    // Sending goes through the claim write, which has no fallback of its own.
    expect(await h.generation.generate(request)).toMatchObject({ outcome: "recipe" });
    expect(h.storage.write).toHaveBeenLastCalledWith({
      version: 1,
      attempts: [
        { origin: observation.origin, path: "/login", state: "sent", at: expect.any(Number) },
      ],
    });
  });

  it("sends nothing without a paired, accepted device or when it cannot remember", async () => {
    const h = setup();
    h.service.connection.mockResolvedValueOnce(undefined);
    expect(await h.generation.available(observation.origin, "/login")).toBe("not-connected");
    h.service.connection.mockResolvedValueOnce({ ...connection, rejected: true });
    expect(await h.generation.generate(request)).toEqual({
      outcome: "skipped",
      reason: "not-connected",
      retry: true,
    });
    h.storage.write.mockRejectedValueOnce(new Error("quota"));
    expect(await h.generation.generate(request)).toEqual({
      outcome: "skipped",
      reason: "storage-unavailable",
      retry: true,
    });
    expect(h.transport.generateRecipe).not.toHaveBeenCalled();
  });

  it("sends no judgement for a login without a layout (ADR 0060)", async () => {
    const h = setup();
    const home = { ...observation, path: "/home" };
    // The service judges the route of the layout the login ran.
    expect(await h.raw.judge(recipeChange.recipeId, 1, "password", home)).toEqual({
      verdict: "unclear",
      reason: "no-layout",
    });
    expect(
      await h.raw.judge(recipeChange.recipeId, 1, "password", home, undefined, "account"),
    ).toEqual({ verdict: "unclear", reason: "no-layout" });
    expect(h.transport.judgeCompletion).not.toHaveBeenCalled();
  });

  it("maps the completion judgement and refreshes the cache after a sign-in", async () => {
    const h = setup();
    h.transport.judgeCompletion.mockResolvedValueOnce({
      kind: "result",
      result: {
        version: 1,
        status: "signed-in",
        change: {
          ...recipeChange,
          revision: 2,
          recipe: storedOf({
            ...route,
            revision: 2,
            completion: [{ target: { by: "id" as const, value: "logout" } }],
          }),
        },
      },
    });
    const home = { ...observation, path: "/home" };
    expect(await h.generation.judge(recipeChange.recipeId, 1, "password", home)).toEqual({
      verdict: "signed-in",
    });
    expect(h.transport.judgeCompletion).toHaveBeenCalledWith(
      connection.origin,
      connection.credential,
      recipeChange.recipeId,
      { version: 1, revision: 1, route: "password", branch: KEY, observation: home, slots: [] },
    );
    await vi.waitFor(() => expect(h.refresh).toHaveBeenCalledTimes(1));
    h.transport.judgeCompletion.mockResolvedValueOnce({
      kind: "result",
      result: { version: 1, status: "challenge" },
    });
    expect(await h.generation.judge(recipeChange.recipeId, 1, "password", home)).toEqual({
      verdict: "challenge",
    });
    h.transport.judgeCompletion.mockResolvedValueOnce({
      kind: "result",
      result: { version: 1, status: "failed", error: "invalid-output" },
    });
    expect(await h.generation.judge(recipeChange.recipeId, 1, "password", home)).toEqual({
      verdict: "unclear",
      reason: "invalid-output",
    });
    // An unreachable service is a temporary refusal, so the page is given back.
    expect(await h.generation.judge(recipeChange.recipeId, 1, "password", home)).toEqual({
      verdict: "retry",
      reason: "unreachable",
    });
    // A description that left out a disabled field says so (ADR 0029).
    h.transport.judgeCompletion.mockResolvedValueOnce({
      kind: "result",
      result: { version: 1, status: "unclear" },
    });
    await h.generation.judge(
      recipeChange.recipeId,
      1,
      "password",
      home,
      undefined,
      undefined,
      true,
    );
    expect(h.transport.judgeCompletion).toHaveBeenLastCalledWith(
      connection.origin,
      connection.credential,
      recipeChange.recipeId,
      {
        version: 1,
        revision: 1,
        route: "password",
        branch: KEY,
        observation: home,
        slots: [],
        partial: true,
      },
    );
    // A page at a login's stop before its item's missing password says so (ADR 0036).
    h.transport.judgeCompletion.mockResolvedValueOnce({
      kind: "result",
      result: { version: 1, status: "unclear" },
    });
    await h.generation.judge(
      recipeChange.recipeId,
      1,
      "password",
      home,
      undefined,
      undefined,
      undefined,
      true,
    );
    expect(h.transport.judgeCompletion).toHaveBeenLastCalledWith(
      connection.origin,
      connection.credential,
      recipeChange.recipeId,
      {
        version: 1,
        revision: 1,
        route: "password",
        branch: KEY,
        observation: home,
        slots: [],
        stop: true,
      },
    );
    // So does a page beside the sign-in form (ADR 0061).
    h.transport.judgeCompletion.mockResolvedValueOnce({
      kind: "result",
      result: { version: 1, status: "unclear" },
    });
    await h.generation.judge(
      recipeChange.recipeId,
      1,
      "password",
      home,
      undefined,
      undefined,
      undefined,
      undefined,
      [],
      true,
    );
    expect(h.transport.judgeCompletion).toHaveBeenLastCalledWith(
      connection.origin,
      connection.credential,
      recipeChange.recipeId,
      {
        version: 1,
        revision: 1,
        route: "password",
        branch: KEY,
        observation: home,
        slots: [],
        beside: true,
      },
    );
  });
}
