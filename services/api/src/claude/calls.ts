import { type GenerationCall, type GenerationCallResult } from "@pateat/generation";

import { runCall } from "./call-execution";
import type { CallEnv, RequestTrace } from "./call-types";
export type { RequestTrace } from "./call-types";
export { CLAUDE_CALL_LIMITS, limitReached } from "./call-budget";
export {
  purgeExpiredLog,
  keepLogRevision,
  logUnsent,
  keepServerTime,
  logPageSample,
} from "./call-log";

/**
 * Makes one role call for the authenticated owner and records its result on `trace`.
 * `ownerId` must come from the request scope. Nothing is charged, logged or sent unless
 * every check passes; the route logs a call that was not sent with the answer it gives
 * (`logUnsent`).
 */
export async function callClaude<T>(
  env: CallEnv,
  ownerId: string,
  trace: RequestTrace,
  call: GenerationCall<T>,
): Promise<GenerationCallResult<T>> {
  // A client that disconnects mid-call must not end the Worker before the call is charged
  // (ADR 0014): nothing is reserved before it.
  const running = runCall(env, ownerId, call, trace.startedAt);
  trace.waitUntil?.(running);
  const result = await running;
  trace.call = result;
  if (result.status === "called" && result.logId !== undefined) trace.logId = result.logId;
  return result;
}
