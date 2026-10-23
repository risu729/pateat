import { createMiddleware } from "hono/factory";
import { setMetric } from "hono/timing";
import type { ApiEnv } from "./auth";
import { keepServerTime, type RequestTrace } from "./claude/calls";

/**
 * Starts the request's trace, which a Claude call and a request answered without a call
 * record themselves on, and reports them once the route answered: `token` and `model` in
 * `Server-Timing` beside the `total` of `timing()`, which must run before this, and the
 * server time on the request log row the request wrote (ADR 0012), with or without a
 * model call. The row is updated after the response is sent, so it never delays it.
 */
export const traceRequest = createMiddleware<ApiEnv>(async (c, next) => {
  const trace: RequestTrace = {
    startedAt: Date.now(),
    waitUntil: (promise) => c.executionCtx.waitUntil(promise),
  };
  c.set("trace", trace);
  await next();
  const serverMs = Date.now() - trace.startedAt;
  const { call, logId } = trace;
  // A call left to the device (ADR 0040) ran nothing here to time.
  if (call && call.status !== "device-call") {
    // `token` once the credential step ran, whatever it answered; `model` once a request
    // was sent, which a role's local refusal never does.
    const tokenMs = call.status === "called" ? call.timings.tokenMs : call.tokenMs;
    if (tokenMs !== undefined) setMetric(c, "token", tokenMs);
    if (call.status === "called" && call.outcome.calls > 0)
      setMetric(c, "model", call.timings.modelMs);
  }
  if (logId !== undefined)
    c.executionCtx.waitUntil(keepServerTime(c.env.DB, c.get("scope").ownerId, logId, serverMs));
});
