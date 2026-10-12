import {
  APICallError,
  Experimental_DecisionRefusalError,
  InvalidResponseDataError,
  JSONParseError,
  NoObjectGeneratedError,
  NoOutputGeneratedError,
  RetryError,
  TypeValidationError,
} from "ai";
import type { InferenceErrorCode, OutputSchemaIssue } from "./outcome";

/**
 * Maps SDK and transport failures to local outcome codes. `signals` distinguish our
 * own timeout from caller cancellation, independent of how the SDK wraps aborts.
 */
export function classifyInferenceError(
  error: unknown,
  signals: { timeout: AbortSignal; caller?: AbortSignal | undefined },
): InferenceErrorCode {
  if (signals.caller?.aborted) return "cancelled";
  if (signals.timeout.aborted) return "timeout";
  const cause = RetryError.isInstance(error) ? error.lastError : error;
  if (Experimental_DecisionRefusalError.isInstance(cause)) return "refused";
  if (NoObjectGeneratedError.isInstance(cause)) {
    if (cause.finishReason === "length") return "truncated";
    if (cause.finishReason === "content-filter") return "refused";
    return "invalid-output";
  }
  if (
    NoOutputGeneratedError.isInstance(cause) ||
    InvalidResponseDataError.isInstance(cause) ||
    TypeValidationError.isInstance(cause) ||
    JSONParseError.isInstance(cause)
  )
    return "invalid-output";
  if (APICallError.isInstance(cause) && cause.statusCode === 429) return "rate-limited";
  return "provider-error";
}

/** The property names an output's JSON Schema defines anywhere in it. */
export function schemaKeys(schema: unknown): ReadonlySet<string> {
  const keys = new Set<string>();
  const visit = (node: unknown) => {
    if (Array.isArray(node)) node.forEach(visit);
    else if (node !== null && typeof node === "object") {
      const properties = (node as { properties?: unknown }).properties;
      if (properties !== null && typeof properties === "object")
        for (const key of Object.keys(properties)) keys.add(key);
      Object.values(node).forEach(visit);
    }
  };
  visit(schema);
  return keys;
}

const kebab = (value: string) =>
  value.replaceAll(/[A-Z]/gu, (letter) => `-${letter.toLowerCase()}`);

/**
 * Why the SDK's structured-output check refused the model's text: `json` when it was not
 * JSON, otherwise the type of the first Valibot issue and where it was. The path keeps
 * array indexes and the keys of `keys` (the output schema's), in kebab case; it ends before
 * any other key, which the model wrote, and the issue is then `unknown-key`. The text, the
 * issue's message and the value it received are never read, since they may quote the
 * output. `undefined` for any other error.
 */
export function outputSchemaIssue(
  error: unknown,
  keys: ReadonlySet<string>,
): OutputSchemaIssue | undefined {
  const cause = RetryError.isInstance(error) ? error.lastError : error;
  const failure = NoObjectGeneratedError.isInstance(cause) ? cause.cause : cause;
  if (JSONParseError.isInstance(failure)) return { check: "json" };
  if (!TypeValidationError.isInstance(failure)) return undefined;
  // `@ai-sdk/valibot` reports a `ValiError`, whose issues carry a type and a path.
  const issues = (failure.cause as { issues?: unknown } | undefined)?.issues;
  const issue = Array.isArray(issues)
    ? (issues[0] as { type?: unknown; path?: unknown } | undefined)
    : undefined;
  if (typeof issue?.type !== "string") return undefined;
  const path: string[] = [];
  let unknownKey = false;
  for (const item of Array.isArray(issue.path) ? issue.path : []) {
    const key = (item as { key?: unknown } | null)?.key;
    if (typeof key === "number" && Number.isSafeInteger(key) && key >= 0) path.push(String(key));
    else if (typeof key === "string" && keys.has(key)) path.push(kebab(key));
    else {
      unknownKey = true;
      break;
    }
  }
  return {
    check: "schema",
    issue: unknownKey ? "unknown-key" : issue.type.replaceAll("_", "-"),
    path: path.join("."),
  };
}
