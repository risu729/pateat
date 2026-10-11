import type { Context } from "hono";
import type { ApiEnv } from "./auth";
import { message } from "./pages";

/**
 * The owner web UI is a script bundle from this origin only. It reads and writes
 * through `/manage/api` and cannot be framed.
 */
export const APP_HEADERS = {
  "Content-Security-Policy":
    "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
  "Referrer-Policy": "no-referrer",
  "X-Frame-Options": "DENY",
} as const;

const APP_DOCUMENT = "/manage/index.html";

/**
 * Serves a built file after the Access check. Assets are routed through the Worker
 * (`runWorkerFirst`), so no file is served without a verified owner token.
 */
async function fromAssets(c: Context<ApiEnv>, path: string) {
  const asset = await c.env.ASSETS.fetch(new URL(path, c.req.url));
  if (asset.status >= 500) return message(c, 500, "Server error", "The page could not be loaded.");
  if (!asset.ok) return message(c, 404, "Not found", "No such page.");
  const response = new Response(asset.body, asset);
  for (const [name, value] of Object.entries(APP_HEADERS)) response.headers.set(name, value);
  return response;
}

export const appPage = (c: Context<ApiEnv>) => fromAssets(c, APP_DOCUMENT);
/**
 * One flat file name under the asset directory. The raw path is checked because
 * the router's decoded path turns `%5c` into a backslash, which URL resolution
 * treats as a separator and could climb out of the directory with.
 */
const ASSET_PATH = /^\/manage\/assets\/[A-Za-z0-9][A-Za-z0-9._-]*$/;

export const appAsset = (c: Context<ApiEnv>) => {
  const { pathname } = new URL(c.req.url);
  if (!ASSET_PATH.test(pathname)) return message(c, 404, "Not found", "No such page.");
  return fromAssets(c, pathname);
};
