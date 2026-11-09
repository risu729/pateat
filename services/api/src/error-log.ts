import type { Context } from "hono";
import { matchedRoutes } from "hono/route";

/**
 * The error the app logs for a failure it did not handle (docs/operations.md#server-errors):
 * the error's class name and the `at` lines of its stack, never its message. A message can
 * quote input: a drizzle-orm `DrizzleQueryError` reads `Failed query: <sql>` and then
 * `params: <values>`.
 */
export function unhandledError(error: unknown): Error {
  const logged = new Error(UNHANDLED);
  logged.name = className(error);
  const frames = error instanceof Error ? stackFrames(error) : [];
  logged.stack = [`${logged.name}: ${UNHANDLED}`, ...frames].join("\n");
  return logged;
}

/**
 * The route of the request's handler as registered (`/v1/recipes/:recipeId`), never the
 * path, which can hold IDs. Middleware and catch-all routes register as `ALL` and match
 * after a handler, such as the 405 route `/v1/recipes/:recipeId` after
 * `POST /v1/recipes/generate`, so the last other route is the handler's; a request no
 * handler matched names the last route that did, such as `/v1/*`.
 */
export function handlerRoute(c: Context) {
  const routes = matchedRoutes(c);
  return (routes.findLast((route) => route.method !== "ALL") ?? routes.at(-1))?.path ?? "";
}

const UNHANDLED = "Unhandled API error";

/** The constructor's name, such as `DrizzleQueryError`, which `name` often leaves as `Error`. */
function className(error: unknown) {
  if (!(error instanceof Error)) return "unknown";
  const name: unknown = error.constructor?.name;
  return typeof name === "string" && /^[A-Za-z_$][\w$]{0,63}$/.test(name) ? name : "Error";
}

/**
 * The stack's frames. V8 starts `stack` with `<name>: <message>`, and the message may hold
 * line breaks and lines that look like frames, so that header is cut off as a whole and a
 * stack that does not start with it yields no frames. Only lines that end in a source
 * position are kept, and V8's `[as <key>]`, the property a function was called through,
 * is dropped.
 */
function stackFrames(error: Error) {
  const { stack } = error;
  if (typeof stack !== "string") return [];
  const header = error.message ? `${error.name}: ${error.message}` : error.name;
  if (!stack.startsWith(header)) return [];
  return stack
    .slice(header.length)
    .split("\n")
    .filter((line) => /^\s+at \S.*:\d+:\d+\)?$/.test(line))
    .map((line) => line.replace(/ \[as .*\](?= \(|$)/, ""));
}
