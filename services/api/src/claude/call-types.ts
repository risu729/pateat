import { type GenerationCallResult } from "@pateat/generation";
import { type WorkersAiBinding } from "@pateat/inference";

import { type DrizzleD1Database } from "drizzle-orm/d1";

export type Db = DrizzleD1Database<Record<string, never>>;
export type CallEnv = {
  DB: D1Database;
  INFERENCE_CREDENTIAL_KEY?: string;
  OIDC_ISSUER?: string;
  OIDC_SIGNING_KEYS?: string;
  /** The Workers AI binding Clef is called through (ADR 0083); absent, Claude answers alone. */
  AI?: WorkersAiBinding;
};
/**
 * One request's timing: when the Worker received it, the call `callClaude` made for it,
 * which the request's middleware reports in `Server-Timing`, and the request log row it
 * wrote (`logId`), by `callClaude` or, for a request answered without a call, by
 * `logUnsent`, which the middleware completes with the server time once the response is
 * out.
 */
export type RequestTrace = {
  startedAt: number;
  /**
   * Keeps a promise running after the response or a client disconnect (the request's
   * `waitUntil`), so a call already sent is still charged and logged.
   */
  waitUntil?: (promise: Promise<unknown>) => void;
  call?: GenerationCallResult<unknown>;
  logId?: string;
};
