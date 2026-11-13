import {
  getPagePermissionDefaults,
  resolvePagePermission,
  type LocalSettings,
  type PagePermissionKind,
  type PagePermissionResolution,
} from "@pateat/contracts";
import { terminal } from "./attempt-state";
import { recordFor } from "./hold";
import type { Runtime } from "./state";

/**
 * How far Pateat goes on a page of `kind` (ADR 0035). A URL whose hostname no site rule can
 * name, such as one with an underscore, takes the profile's default, as every page no rule
 * covers does, so it never turns an `auto` login into filling only or a page off.
 */
export function pagePermission<K extends PagePermissionKind>(
  settings: Pick<LocalSettings, "pagePermissionDefaults" | "sitePagePermissions">,
  url: string,
  kind: K,
): PagePermissionResolution<K> {
  return (
    resolvePagePermission(settings, url, kind) ?? {
      permission: getPagePermissionDefaults(settings)[kind],
      source: "default",
    }
  );
}

/**
 * The `sign-in` permission of a document: filling only when its own site or its tab's
 * site says so. The popup edits the tab's hostname, and a pause covers a frame by either
 * site too, so a framed sign-in form follows the rule of the page around it.
 */
export function signInPermission(
  settings: Pick<LocalSettings, "pagePermissionDefaults" | "sitePagePermissions">,
  live: { url: string; topUrl?: string | undefined },
): PagePermissionResolution<"sign-in"> {
  const own = pagePermission(settings, live.url, "sign-in");
  if (own.permission === "fill" || live.topUrl === undefined) return own;
  const top = pagePermission(settings, live.topUrl, "sign-in");
  return top.permission === "fill" ? top : own;
}

/**
 * Whether the person picked an account in the popup for this document, or for a login
 * that pick started and that still runs as a normal login: only then does a page set to
 * fill only log in with presses (ADR 0035). Stale popup state grants nothing.
 */
export function explicitlyPicked(
  rt: Runtime,
  document: { tabId: number; origin: string; documentId: string },
): boolean {
  const pick = rt.picked.get(document.tabId);
  if (!pick || pick.site || pick.origin !== document.origin) return false;
  if (pick.attemptId === undefined) return pick.documentId === document.documentId;
  const record = recordFor(rt, document.tabId, document.origin);
  return record?.id === pick.attemptId && !record.signInFill && !terminal(record);
}
