import { expect, it, vi } from "vitest";
import type { ServiceGenerationTestContext } from "./context";
import type { ServiceTransport } from "../../../src/service/transport";
import { GENERATION_SENDING_MS } from "../../../src/service/generation";

export function registerContinuationClaimCases({
  observation,
  request,
  runs,
  setup,
  continuation,
  answerOf,
  sent,
}: Pick<
  ServiceGenerationTestContext,
  "observation" | "request" | "runs" | "setup" | "continuation" | "answerOf" | "sent"
>) {
  it("keeps a continuation's claim apart from the first page's on the same path", async () => {
    const h = setup(answerOf(2));
    // The continuation first: the path's first page is still free, and the reverse.
    expect(await h.generation.generate(continuation)).toMatchObject({ outcome: "recipe" });
    expect(await h.generation.available(observation.origin, "/login")).toBe(true);
    expect(await h.generation.generate(request)).toMatchObject({ outcome: "recipe" });
    expect(await h.generation.available(observation.origin, "/login")).toBe("sent");
    // Each claim holds on its own.
    expect(await h.generation.generate(continuation)).toEqual(sent);
    expect(await h.generation.generate(request)).toEqual(sent);
    expect(h.transport.generateRecipe).toHaveBeenCalledTimes(2);
  });

  it("returns the current recipe the service answers for a stale base, pulling recipes only", async () => {
    // Another device continued revision 1 first; the service answers with its revision 3.
    const h = setup(answerOf(3));
    const answer = await h.generation.generate(continuation);
    expect(answer).toEqual({ outcome: "recipe", recipe: { ...runs, revision: 3 } });
    expect(h.refresh).toHaveBeenCalledTimes(1);
    expect(h.sync).not.toHaveBeenCalled();
  });

  it("keys the claim by recipe as well as revision and path", async () => {
    const h = setup(answerOf(2));
    expect(await h.generation.generate(continuation)).toMatchObject({ outcome: "recipe" });
    const otherRecipe = {
      ...continuation,
      base: { recipeId: `gen-${"f".repeat(32)}`, revision: 1 },
    };
    expect(await h.generation.generate(otherRecipe)).toMatchObject({ outcome: "recipe" });
    const otherPath = {
      ...continuation,
      observation: { ...observation, path: "/login/password" },
    };
    expect(await h.generation.generate(otherPath)).toMatchObject({ outcome: "recipe" });
    expect(h.transport.generateRecipe).toHaveBeenCalledTimes(3);
  });

  it("frees only the continuation's claim, never the first page's", async () => {
    const h = setup();
    expect(await h.generation.generate(request)).toMatchObject({ outcome: "recipe" });
    h.transport.generateRecipe.mockResolvedValueOnce({
      kind: "result",
      result: { version: 1, status: "unavailable", reason: "busy" },
    });
    expect(await h.generation.generate(continuation)).toEqual({
      outcome: "unavailable",
      reason: "busy",
      retry: true,
    });
    expect(await h.generation.available(observation.origin, "/login")).toBe("sent");
    expect(await h.generation.generate(request)).toEqual(sent);
    expect(await h.generation.generate(continuation)).toMatchObject({ outcome: "recipe" });
    expect(h.transport.generateRecipe).toHaveBeenCalledTimes(3);
  });
}

export function registerContinuationAnswerCases({
  connection,
  observation,
  request,
  KEY,
  setup,
  base,
  continuation,
  answerOf,
  sent,
}: Pick<
  ServiceGenerationTestContext,
  | "connection"
  | "observation"
  | "request"
  | "KEY"
  | "setup"
  | "base"
  | "continuation"
  | "answerOf"
  | "sent"
>) {
  type Answer = Awaited<ReturnType<ServiceTransport["generateRecipe"]>>;
  // Nothing in these answers shows the model was called, so the claim is freed (#261).
  it.each<[string, Answer, string, string]>([
    [
      "an incomplete observation",
      { kind: "result", result: { version: 1, status: "failed", error: "incomplete-observation" } },
      "failed",
      "incomplete-observation",
    ],
    [
      "an invalid request",
      { kind: "result", result: { version: 1, status: "failed", error: "invalid-request" } },
      "failed",
      "invalid-request",
    ],
    [
      "an unexpected transport answer",
      { kind: "failed", error: "unexpected-response" },
      "failed",
      "unexpected-response",
    ],
    [
      "the service's request limit",
      { kind: "failed", error: "rate-limited" },
      "failed",
      "rate-limited",
    ],
    [
      "the monthly limit",
      { kind: "result", result: { version: 1, status: "unavailable", reason: "monthly-limit" } },
      "unavailable",
      "monthly-limit",
    ],
    [
      "the service's own recently-tried",
      { kind: "result", result: { version: 1, status: "unavailable", reason: "recently-tried" } },
      "unavailable",
      "recently-tried",
    ],
    ["a rejected device", { kind: "rejected" }, "failed", "device-rejected"],
    [
      "the daily limit",
      { kind: "result", result: { version: 1, status: "unavailable", reason: "daily-limit" } },
      "unavailable",
      "daily-limit",
    ],
  ])("frees the claim and asks for a retry after %s", async (_n, answer, outcome, reason) => {
    const h = setup(answer);
    expect(await h.generation.generate(continuation)).toEqual({ outcome, reason, retry: true });
    expect(await h.generation.generate(continuation)).toEqual({ outcome, reason, retry: true });
    expect(h.transport.generateRecipe).toHaveBeenCalledTimes(2);
    expect(h.sync).not.toHaveBeenCalled();
    expect(h.refresh).not.toHaveBeenCalled();
  });

  it("asks for a retry with a rejected device connection and claims nothing", async () => {
    const h = setup(answerOf(2));
    h.service.connection.mockResolvedValueOnce({ ...connection, rejected: true });
    expect(await h.generation.generate(continuation)).toEqual({
      outcome: "skipped",
      reason: "not-connected",
      retry: true,
    });
    expect(h.storage.write).not.toHaveBeenCalled();
    expect(await h.generation.generate(continuation)).toMatchObject({ outcome: "recipe" });
  });

  // These answers show the model was called: the claim is kept, with no retry.
  it.each<[string, Answer, string, string]>([
    [
      "the model refusing",
      { kind: "result", result: { version: 1, status: "failed", error: "refused" } },
      "failed",
      "refused",
    ],
    [
      "a truncated answer",
      { kind: "result", result: { version: 1, status: "failed", error: "truncated" } },
      "failed",
      "truncated",
    ],
    [
      "a provider error",
      { kind: "result", result: { version: 1, status: "failed", error: "provider-error" } },
      "failed",
      "provider-error",
    ],
    [
      "an invalid recipe",
      { kind: "result", result: { version: 1, status: "failed", error: "recipe-invalid" } },
      "failed",
      "recipe-invalid",
    ],
    [
      "an abstention",
      { kind: "result", result: { version: 1, status: "abstained", reason: "ambiguous" } },
      "abstained",
      "ambiguous",
    ],
  ])("keeps the claim after %s", async (_name, answer, outcome, reason) => {
    const h = setup(answer);
    expect(await h.generation.generate(continuation)).toEqual({ outcome, reason });
    expect(await h.generation.generate(continuation)).toEqual(sent);
    expect(h.transport.generateRecipe).toHaveBeenCalledTimes(1);
    expect(h.sync).not.toHaveBeenCalled();
    expect(h.refresh).not.toHaveBeenCalled();
  });

  it("never syncs for a continuation, and still answers when the refresh fails", async () => {
    const h = setup(answerOf(2));
    h.refresh.mockRejectedValueOnce(new Error("offline"));
    expect(await h.generation.generate(continuation)).toMatchObject({ outcome: "recipe" });
    for (const answer of [
      { kind: "failed", error: "unreachable" },
      { kind: "rejected" },
      { kind: "result", result: { version: 1, status: "abstained", reason: "ambiguous" } },
    ] as const) {
      h.transport.generateRecipe.mockResolvedValueOnce(answer);
      // One answer per request, in order.
      // eslint-disable-next-line no-await-in-loop
      await h.generation.generate({ ...continuation, base: { ...base, revision: 5 } });
    }
    expect(h.sync).not.toHaveBeenCalled();
    expect(h.refresh).toHaveBeenCalledTimes(1);
    // A first page still syncs in full.
    await h.generation.generate(request);
    expect(h.sync).toHaveBeenCalledTimes(1);
    expect(h.refresh).toHaveBeenCalledTimes(1);
  });

  it("stores the claim with its base, sending while in flight and sent once answered", async () => {
    const h = setup();
    let answer!: (value: Answer) => void;
    h.transport.generateRecipe.mockReturnValueOnce(
      new Promise<Answer>((resolve) => (answer = resolve)),
    );
    const pending = h.generation.generate(continuation);
    await vi.waitFor(() => expect(h.transport.generateRecipe).toHaveBeenCalledTimes(1));
    expect(h.storage.write).toHaveBeenLastCalledWith({
      version: 1,
      attempts: [
        {
          origin: observation.origin,
          path: "/login",
          base,
          branch: KEY,
          state: "sending",
          at: expect.any(Number),
        },
      ],
    });
    answer({ kind: "result", result: { version: 1, status: "abstained", reason: "ambiguous" } });
    expect(await pending).toEqual({ outcome: "abstained", reason: "ambiguous" });
    expect(h.storage.write).toHaveBeenLastCalledWith({
      version: 1,
      attempts: [
        {
          origin: observation.origin,
          path: "/login",
          base,
          branch: KEY,
          state: "sent",
          at: expect.any(Number),
        },
      ],
    });
  });

  it("frees a continuation claim whose request was lost after two minutes", async () => {
    const h = setup(answerOf(2));
    // The worker that sent it stopped: its request never answers.
    h.transport.generateRecipe.mockReturnValueOnce(new Promise(() => undefined));
    void h.generation.generate(continuation);
    await vi.waitFor(() => expect(h.transport.generateRecipe).toHaveBeenCalledTimes(1));
    h.advance(GENERATION_SENDING_MS - 1);
    expect(await h.generation.generate(continuation)).toEqual({
      outcome: "skipped",
      reason: "sending",
      retry: true,
    });
    h.advance(1);
    expect(await h.generation.generate(continuation)).toMatchObject({ outcome: "recipe" });
    expect(h.transport.generateRecipe).toHaveBeenCalledTimes(2);
  });
}
