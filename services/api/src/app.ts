import { devicePairRequestSchema } from "@pateat/contracts";
import { Hono, type Context } from "hono";
import { bodyLimit } from "hono/body-limit";
import { csrf } from "hono/csrf";
import { HTTPException } from "hono/http-exception";
import { requireAccess, requireAccessApi, requirePairingOrigin, requireSameOrigin } from "./access";
import { requireDevice, type ApiEnv } from "./auth";
import { API_HEADERS, apiError } from "./http";
import { limitIdentity, limitOwner } from "./limits";
import { message } from "./pages";
import { deviceRoutes } from "./routes/device";
import { enrollRoutes } from "./routes/enroll";
import { manageApiRoutes } from "./routes/manage-api";
import { manageClaudeRoutes } from "./routes/manage-claude";
import { oidcRoutes } from "./routes/oidc";
import { createPairedDevice, pairLimit } from "./routes/pair";
import { recipeRoutes } from "./routes/recipes";
import { redeemRoutes } from "./routes/redeem";
import { settingsRoutes } from "./routes/settings";
import { jsonBody, requireJsonBody } from "./validation";
import { appAsset, appPage } from "./web-app";

const MAX_BODY_BYTES = 128 * 1024;
const MAX_FORM_BYTES = 4 * 1024;

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
  // Anonymous issuer metadata for Anthropic's Workload Identity Federation (ADR 0015).
  .route("/.well-known", oidcRoutes)
  .all("/.well-known/openid-configuration", methodNotAllowed("GET, HEAD"))
  .all("/.well-known/jwks.json", methodNotAllowed("GET, HEAD"))
  // Owner pages sit behind one Access application; the Worker still verifies its
  // token itself. Forms are same-origin only, and Access runs before any body read.
  .use(
    "/enroll",
    requireAccess,
    csrf(),
    bodyLimit({
      maxSize: MAX_FORM_BYTES,
      onError: (c) => message(c, 413, "Too large", "The form was too large."),
    }),
  )
  .route("/enroll", enrollRoutes)
  .all("/enroll", methodNotAllowed("GET, POST"))
  // The owner web UI: its JSON API, its pages and its built assets all need Access.
  // The API answers its own pages only; Access and the per-identity request limit run
  // before any body read.
  .use(
    "/manage/api/*",
    requireAccessApi,
    limitIdentity,
    requireSameOrigin,
    bodyLimit({
      maxSize: MAX_BODY_BYTES,
      onError: (c) => apiError(c, 413, { error: "payload_too_large" }),
    }),
  )
  .route("/manage/api", manageApiRoutes)
  .all("/manage/api/devices", methodNotAllowed("GET"))
  .all("/manage/api/settings", methodNotAllowed("GET, PUT"))
  .all("/manage/api/devices/:deviceId/revoke", methodNotAllowed("POST"))
  .all("/manage/api/recipes", methodNotAllowed("GET"))
  .all("/manage/api/recipes/:recipeId/revoke", methodNotAllowed("POST"))
  .get("/manage/assets/*", requireAccess, appAsset)
  // Each page the app renders; any other path under /manage is not found.
  .get("/manage", requireAccess, appPage)
  // The temporary WIF page guards itself (Access, same-origin forms, body limit).
  .route("/manage/claude", manageClaudeRoutes)
  .all("/manage/claude", methodNotAllowed("GET, POST"))
  .all("/manage/claude/test", methodNotAllowed("POST"))
  .all("/manage", methodNotAllowed("GET"))
  .get("/manage/sites", requireAccess, appPage)
  .all("/manage/sites", methodNotAllowed("GET"))
  .get("/manage/bindings", requireAccess, appPage)
  .all("/manage/bindings", methodNotAllowed("GET"))
  .get("/manage/recipes", requireAccess, appPage)
  .all("/manage/recipes", methodNotAllowed("GET"))
  // Direct pairing from an allowed extension with the owner's login session (ADR 0020).
  // Access and the Origin check run before the per-identity limit and any body read.
  // No CORS headers: extension contexts with host access skip CORS; pages cannot read it.
  .post(
    "/pair",
    requireAccessApi,
    requirePairingOrigin,
    pairLimit,
    bodyLimit({
      maxSize: MAX_FORM_BYTES,
      onError: (c) => apiError(c, 413, { error: "payload_too_large" }),
    }),
    requireJsonBody,
    jsonBody(devicePairRequestSchema),
    createPairedDevice,
  )
  .all("/pair", methodNotAllowed("POST"))
  // Redemption is the only anonymous write; it is rate limited and body-bounded.
  .use(
    "/redeem",
    bodyLimit({
      maxSize: MAX_FORM_BYTES,
      onError: (c) => apiError(c, 413, { error: "payload_too_large" }),
    }),
  )
  .route("/redeem", redeemRoutes)
  .all("/redeem", methodNotAllowed("POST"))
  // Authenticate and count the request against its owner before reading bodies;
  // unauthenticated requests are never parsed.
  .use(
    "/v1/*",
    requireDevice,
    limitOwner,
    bodyLimit({
      maxSize: MAX_BODY_BYTES,
      onError: (c) => apiError(c, 413, { error: "payload_too_large" }),
    }),
  )
  .route("/v1/device", deviceRoutes)
  .all("/v1/device", methodNotAllowed("GET, DELETE"))
  .route("/v1/settings", settingsRoutes)
  .all("/v1/settings", methodNotAllowed("GET, PUT"))
  .route("/v1/recipes", recipeRoutes)
  .all("/v1/recipes", methodNotAllowed("GET"))
  .all("/v1/recipes/generate", methodNotAllowed("POST"))
  .all("/v1/recipes/:recipeId", methodNotAllowed("PUT"))
  .all("/v1/recipes/:recipeId/completion", methodNotAllowed("POST"))
  .notFound((c) => apiError(c, 404, { error: "not_found" }))
  .onError((error, c) => {
    const ownerPage =
      /^\/(?:enroll|manage)(?:\/|$)/.test(c.req.path) && !/^\/manage\/api(?:\/|$)/.test(c.req.path);
    if (error instanceof HTTPException && error.status === 400)
      return ownerPage
        ? message(c, 400, "Invalid request", "Start again from Pateat's settings.")
        : apiError(c, 400, { error: "bad_request" });
    // CSRF rejections from owner pages.
    if (ownerPage && error instanceof HTTPException && error.status === 403)
      return message(c, 403, "Request refused", "Submit this form from its own page.");
    console.error("Unhandled API error", error instanceof Error ? error.name : "unknown");
    return ownerPage
      ? message(c, 500, "Something went wrong", "Try again later.")
      : apiError(c, 500, { error: "internal_error" });
  });
