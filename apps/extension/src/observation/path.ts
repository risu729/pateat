import { REDACTED_PATH_SEGMENT } from "@pateat/contracts";
import { redactPath, tokenSegment } from "./token-segment";

export { tokenSegment };

/**
 * A page's path as Pateat observes it on every page (ADR 0039): each whole segment that
 * may carry a token (`tokenSegment`) is replaced by `REDACTED_PATH_SEGMENT`, so
 * `/<tenant UUID>/oauth2/authorize` reads `/[id]/oauth2/authorize`. Observations carry it,
 * recipes are stored under it, and a live page is compared with a recipe, an observation
 * or another page only through it, so every tenant shares one recipe. A flagged segment
 * itself is not sent. Checks for a username in the path read the raw path instead.
 * The result is unchanged when redacted again.
 */
export const observedPath = (pathname: string): string =>
  redactPath(pathname, REDACTED_PATH_SEGMENT);

/** Whether `observedPath` replaces a segment of this path. */
export const redactsPath = (pathname: string): boolean => observedPath(pathname) !== pathname;
