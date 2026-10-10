import { Hono, type Context } from "hono";
import { bodyLimit } from "hono/body-limit";
import { HTTPException } from "hono/http-exception";
import { requireDevice, type ApiEnv } from "./auth";
import { API_HEADERS, apiError } from "./http";
import { recipeRoutes } from "./routes/recipes";
import { settingsRoutes } from "./routes/settings";

const MAX_BODY_BYTES = 128 * 1024;

function methodNotAllowed(allow: string) {
  return (c: Context) => apiError(c, 405, { error: "method_not_allowed" }, { Allow: allow });
}

/** No CORS headers: cross-origin access is not authentication and is not offered. */
export const app = new Hono<ApiEnv>()
  .use(async (c, next) => {
    await next();
    for (const [name, value] of Object.entries(API_HEADERS)) c.header(name, value);
  })
  .on(["GET", "HEAD"], "/health", (c) => {
    const body = { status: "ok", service: "pateat-api", revision: PATEAT_BUILD_REVISION };
    return c.req.method === "HEAD"
      ? c.body(null, 200, { "Content-Type": "application/json; charset=utf-8" })
      : c.json(body);
  })
  .all("/health", methodNotAllowed("GET, HEAD"))
  // Authenticate before reading bodies; unauthenticated requests are never parsed.
  .use(
    "/v1/*",
    requireDevice,
    bodyLimit({
      maxSize: MAX_BODY_BYTES,
      onError: (c) => apiError(c, 413, { error: "payload_too_large" }),
    }),
  )
  .route("/v1/settings", settingsRoutes)
  .all("/v1/settings", methodNotAllowed("GET, PUT"))
  .route("/v1/recipes", recipeRoutes)
  .all("/v1/recipes", methodNotAllowed("GET"))
  .all("/v1/recipes/:recipeId", methodNotAllowed("PUT"))
  .notFound((c) => apiError(c, 404, { error: "not_found" }))
  .onError((error, c) => {
    if (error instanceof HTTPException && error.status === 400)
      return apiError(c, 400, { error: "bad_request" });
    console.error("Unhandled API error", error instanceof Error ? error.name : "unknown");
    return apiError(c, 500, { error: "internal_error" });
  });
