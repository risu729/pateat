import { serviceTiming } from "./service-timing";

const MAX_RESPONSE_BYTES = 16 * 1024;

/** Reads at most the byte limit, cancelling the stream instead of buffering more. */
async function readBounded(response: Response, limit: number): Promise<string | undefined> {
  if (!response.body) return "";
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    // oxlint-disable-next-line no-await-in-loop -- stream chunks arrive in order
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > limit) {
      void reader.cancel().catch(() => undefined);
      return undefined;
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return undefined;
  }
}

/** Per-call options; only pairing sends the browser's login session. */
type CallOptions = {
  limit?: number;
  timeout?: number;
  /**
   * Sends the browser's cookies for the service and leaves redirects unfollowed.
   * A redirect or a body that is not JSON then means the login front-end answered
   * instead of the Worker, so the caller is told to sign in. A non-JSON 429 or 5xx is
   * an edge error page, such as Cloudflare's rate-limit or server error pages, and is
   * reported as rate limiting or an unexpected response instead.
   */
  session?: boolean;
};

function isJson(response: Response) {
  const type = response.headers.get("Content-Type") ?? "";
  return type.split(";")[0]!.trim().toLowerCase() === "application/json";
}

/** Fetches bounded JSON with the service's cookie, redirect and timeout rules. */
export function createServiceCall(options: {
  fetch?: typeof fetch;
  timeoutMs?: number;
  now?: () => number;
}) {
  const fetchResponse = options.fetch ?? globalThis.fetch.bind(globalThis);
  const now = options.now ?? Date.now;
  const timeoutMs = options.timeoutMs ?? 15_000;

  async function call(
    origin: string,
    path: string,
    init: RequestInit,
    { limit = MAX_RESPONSE_BYTES, timeout = timeoutMs, session = false }: CallOptions = {},
  ) {
    const url = new URL(path, origin).href;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeout);
    // Measured from just before the request leaves until its body is read or it fails.
    const sentAt = now();
    let headers: Headers | undefined;
    const timing = () => serviceTiming(now() - sentAt, headers?.get("Server-Timing"));
    try {
      const response = await fetchResponse(url, {
        ...init,
        signal: controller.signal,
        redirect: session ? "manual" : "error",
        credentials: session ? "include" : "omit",
        cache: "no-store",
        referrerPolicy: "no-referrer",
      });
      headers = response.headers;
      // Decided before reading the body: a login or edge error page is never parsed.
      // Status 0 falls through to "unexpected-response" for any caller that ignores
      // `signIn`.
      if (session && (response.type === "opaqueredirect" || !isJson(response))) {
        void response.body?.cancel().catch(() => undefined);
        if (response.type !== "opaqueredirect" && response.status === 429)
          return { failed: "rate-limited" as const, timing: timing() };
        if (response.type !== "opaqueredirect" && response.status >= 500)
          return { failed: "unexpected-response" as const, timing: timing() };
        return { status: 0, body: undefined, signIn: true as const, timing: timing() };
      }
      if (response.redirected || (response.url && response.url !== url)) {
        void response.body?.cancel().catch(() => undefined);
        return { failed: "unexpected-response" as const, timing: timing() };
      }
      // Every caller reads a 429 as "slow down" without its body, which may be an edge
      // page that is not JSON, such as Cloudflare's rate-limit page.
      if (response.status === 429) {
        void response.body?.cancel().catch(() => undefined);
        const retryAfter = response.headers.get("Retry-After");
        return {
          status: 429,
          body: undefined,
          timing: timing(),
          ...(retryAfter && /^\d{1,6}$/u.test(retryAfter)
            ? { retryAfterMs: Number(retryAfter) * 1000 }
            : {}),
        };
      }
      const text = await readBounded(response, limit);
      if (text === undefined) return { failed: "unexpected-response" as const, timing: timing() };
      let body: unknown;
      try {
        body = text ? JSON.parse(text) : undefined;
      } catch {
        return { failed: "unexpected-response" as const, timing: timing() };
      }
      return { status: response.status, body, timing: timing() };
    } catch {
      return {
        failed: "unreachable" as const,
        ...(controller.signal.aborted ? { timedOut: true as const } : {}),
        timing: timing(),
      };
    } finally {
      clearTimeout(timer);
    }
  }

  return call;
}
