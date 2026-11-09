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

const UNHANDLED = "Unhandled API error";

/** The constructor's name, such as `DrizzleQueryError`, which `name` often leaves as `Error`. */
function className(error: unknown) {
  if (!(error instanceof Error)) return "unknown";
  const name: unknown = error.constructor?.name;
  return typeof name === "string" && /^[A-Za-z_$][\w$]{0,63}$/.test(name) ? name : "Error";
}

/**
 * The stack's `at` lines. V8 starts `stack` with `<name>: <message>`, and the message may
 * hold line breaks and lines that look like frames, so that header is cut off as a whole;
 * a stack that does not start with it yields no frames.
 */
function stackFrames(error: Error) {
  const { stack } = error;
  if (typeof stack !== "string") return [];
  const header = error.message ? `${error.name}: ${error.message}` : error.name;
  if (!stack.startsWith(header)) return [];
  return stack
    .slice(header.length)
    .split("\n")
    .filter((line) => /^\s+at /.test(line));
}
