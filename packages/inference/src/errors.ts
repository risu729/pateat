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

type SchemaNode = Record<string, unknown>;
const isNode = (value: unknown): value is SchemaNode =>
  value !== null && typeof value === "object" && !Array.isArray(value);

/**
 * The JSON Schema nodes that one step of an output path may lead to: an object key's
 * property schema or an array's item schema, looking through `anyOf`, `oneOf`, `allOf`
 * and local `$ref`s. Empty when the format does not define the step at that place.
 */
function step(root: unknown, nodes: readonly SchemaNode[], key: string | number): SchemaNode[] {
  const expand = (node: SchemaNode, seen: Set<SchemaNode>): SchemaNode[] => {
    if (seen.has(node)) return [];
    seen.add(node);
    const ref = node["$ref"];
    const target =
      typeof ref === "string" && ref.startsWith("#/")
        ? ref
            .slice(2)
            .split("/")
            .reduce<unknown>((at, part) => (isNode(at) ? at[part] : undefined), root)
        : undefined;
    return [
      node,
      ...(isNode(target) ? expand(target, seen) : []),
      ...["anyOf", "oneOf", "allOf"].flatMap((group) => {
        const options = node[group];
        return Array.isArray(options)
          ? options.filter(isNode).flatMap((option) => expand(option, seen))
          : [];
      }),
    ];
  };
  return nodes
    .flatMap((node) => expand(node, new Set()))
    .flatMap((node) => {
      const next =
        typeof key === "number"
          ? node["items"]
          : isNode(node["properties"]) && Object.hasOwn(node["properties"], key)
            ? node["properties"][key]
            : undefined;
      return isNode(next) ? [next] : [];
    });
}

const kebab = (value: string) =>
  value.replaceAll(/[A-Z]/gu, (letter) => `-${letter.toLowerCase()}`);

/**
 * Why the SDK's structured-output check refused the model's text: `json` when it was not
 * JSON, otherwise the type of the first Valibot issue and where it was. The path keeps
 * array indexes and the keys that `schema` (the output's JSON Schema) defines at each
 * place, in kebab case; it ends before any other key, which the model wrote, and the issue
 * is then `unknown-key`. The text, the issue's message and the value it received are never
 * read, since they may quote the output. `undefined` for any other error.
 */
export function outputSchemaIssue(error: unknown, schema: unknown): OutputSchemaIssue | undefined {
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
  let at: SchemaNode[] = isNode(schema) ? [schema] : [];
  for (const item of Array.isArray(issue.path) ? issue.path : []) {
    const key = (item as { key?: unknown } | null)?.key;
    const next =
      (typeof key === "number" && Number.isSafeInteger(key) && key >= 0) || typeof key === "string"
        ? step(schema, at, key)
        : [];
    if (!next.length) {
      unknownKey = true;
      break;
    }
    path.push(typeof key === "number" ? String(key) : kebab(key as string));
    at = next;
  }
  return {
    check: "schema",
    issue: unknownKey ? "unknown-key" : issue.type.replaceAll("_", "-"),
    path: path.join("."),
  };
}
