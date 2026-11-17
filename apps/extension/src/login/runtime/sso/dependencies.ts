import type { SettingsResponse } from "@pateat/contracts";
import { ssoScopeDependencies, type SsoDependencyScope } from "../../sso-dependencies";
import type { SsoWork } from "../sso-state";

type Saved = Extract<SettingsResponse, { ok: true }>;

/** An SSO flow's both accounts, the RP and IdP pages and the two origins. */
const flowScope = (work: SsoWork): SsoDependencyScope => ({
  accounts: [work.source.account, work.selected.account],
  pages: [work.rpLive.url, work.live.url, work.selected.origin],
  origins: [work.account.origin, work.selected.origin],
  incognito: work.rpLive.incognito,
});

/**
 * Whether `next` keeps everything the flow depends on from `before`. A newer revision
 * that changes none of it, as another site's account choice or a sync of unrelated
 * settings, keeps the flow; one that changes any of it ends the flow.
 */
export const ssoDependenciesKept = (work: SsoWork, before: Saved, next: Saved): boolean =>
  ssoScopeDependencies(flowScope(work), before) === ssoScopeDependencies(flowScope(work), next);
