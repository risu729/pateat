import { expect, it } from "vitest";
import { type ServiceTransport } from "../../../src/service/transport";
import type { Requests3Context } from "./context";

export function registerRequests3(context: Requests3Context) {
  const { observation, recipeChange, setup, unavailable, failure } = context;

  it.each([
    // Temporary refusals before any model call give the page back.
    ["a busy service", unavailable("busy"), "retry", "busy"],
    [
      "the service's own request limit",
      { kind: "failed", error: "rate-limited" },
      "retry",
      "rate-limited",
    ],
    ["an unreachable service", { kind: "failed", error: "unreachable" }, "retry", "unreachable"],
    ["a rejected device", { kind: "rejected" }, "retry", "device-rejected"],
    ...(["incomplete-observation", "invalid-request", "input-too-large"] as const).map((error) => [
      `a request that failed before the model (${error})`,
      failure(error),
      "retry",
      error,
    ]),
    // Permanent refusals and anything that may follow a model call spend it.
    ...(
      [
        "already-judged",
        "not-judgeable",
        "recipe-conflict",
        "recipe-revoked",
        "judgement-limit",
        "daily-limit",
        "monthly-limit",
        "credentials-not-configured",
        "token-exchange-failed",
      ] as const
    ).map((reason) => [`the permanent refusal ${reason}`, unavailable(reason), "unclear", reason]),
    ["the provider's rate limit", failure("rate-limited"), "unclear", "rate-limited"],
    [
      "a model that abstained",
      { kind: "result", result: { version: 1, status: "unclear" } },
      "unclear",
      undefined,
    ],
    ["a failure after the model call", failure("truncated"), "unclear", "truncated"],
    [
      "a timeout, which may follow a model call",
      { kind: "failed", error: "timeout" },
      "unclear",
      "timeout",
    ],
    [
      "an unexpected answer",
      { kind: "failed", error: "unexpected-response" },
      "unclear",
      "unexpected-response",
    ],
  ] as [
    string,
    Awaited<ReturnType<ServiceTransport["judgeCompletion"]>>,
    string,
    string | undefined,
  ][])(
    "gives a judged page back only after a temporary refusal, naming its code: %s",
    async (_name, answer, verdict, reason) => {
      const h = setup();
      h.transport.judgeCompletion.mockResolvedValueOnce(answer);
      expect(
        await h.generation.judge(recipeChange.recipeId, 1, "password", {
          ...observation,
          path: "/home",
        }),
      ).toEqual({ verdict, ...(reason ? { reason } : {}) });
    },
  );
}
