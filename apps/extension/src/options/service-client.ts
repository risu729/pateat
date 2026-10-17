import {
  parseServiceResponse,
  serviceOriginSchema,
  profilesSchema,
  syncSettingsStateSchema,
  type LocalSettings,
  type SyncSettingsState,
  type ServiceResponse,
} from "@pateat/contracts";
import * as v from "valibot";

export interface ServiceClient {
  get(): Promise<ServiceResponse>;
  profileEditor?: {
    list(origin: string): Promise<{ version: 1; profiles: { id: string; name: string }[] }>;
    read(origin: string, profileId: string): Promise<SyncSettingsState>;
    save(
      origin: string,
      profileId: string,
      revision: number,
      settings: LocalSettings,
    ): Promise<SyncSettingsState>;
  };
  /**
   * Asks Chrome for site access to the service origin, which the user may have withheld.
   * Call it first in a click handler: Chrome prompts only during a user gesture.
   */
  requestSiteAccess(origin: string): Promise<boolean>;
  /** Pairs in one request from the background with the browser's login session (ADR 0020). */
  pair(origin: string, label: string, profileId?: string): Promise<ServiceResponse>;
  disconnect(): Promise<ServiceResponse>;
  /** Forgets an unreadable local connection without contacting the service. */
  forget(): Promise<ServiceResponse>;
  /**
   * Opens the service's `/pair/signed-in` page in an ordinary tab, where the user signs
   * in. A browser without WARP can sign in there but not on `/manage` (ADR 0030).
   */
  openSignIn(origin: string): Promise<void>;
}

/** Only connection state crosses here; the credential stays in the background. */
export function createServiceClient(deps: {
  send: (message: unknown) => Promise<unknown>;
  openTab: (url: string) => Promise<unknown>;
  requestSiteAccess: (origin: string) => Promise<boolean>;
}): ServiceClient {
  const call = async (message: object) =>
    parseServiceResponse(await deps.send({ version: 1, ...message }));
  async function profileCall<T extends v.GenericSchema>(
    origin: string,
    path: string,
    schema: T,
    body?: unknown,
  ): Promise<v.InferOutput<T>> {
    const url = new URL(`/pair/profiles${path}`, v.parse(serviceOriginSchema, origin));
    const response = await fetch(url, {
      method: body ? "PUT" : "GET",
      credentials: "include",
      redirect: "error",
      cache: "no-store",
      referrerPolicy: "no-referrer",
      headers: { "Content-Type": "application/json", "X-Requested-With": "XMLHttpRequest" },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    if (!response.ok)
      throw new Error(
        response.status === 409
          ? "Settings changed elsewhere. Reload this profile before saving again."
          : "Profile access failed. Sign in to the service, then reload the profiles.",
      );
    return v.parse(schema, await response.json()) as v.InferOutput<T>;
  }
  return {
    profileEditor: {
      list: (origin) => profileCall(origin, "", profilesSchema),
      read: (origin, profileId) =>
        profileCall(origin, `/${encodeURIComponent(profileId)}/settings`, syncSettingsStateSchema),
      save: (origin, profileId, revision, settings) =>
        profileCall(origin, `/${encodeURIComponent(profileId)}/settings`, syncSettingsStateSchema, {
          version: 1,
          expectedRevision: revision,
          settings,
        }),
    },
    get: () => call({ type: "service.get" }),
    requestSiteAccess: (origin) => deps.requestSiteAccess(origin).catch(() => false),
    pair: (origin, label, profileId) =>
      call({ type: "service.pair", origin, label, ...(profileId ? { profileId } : {}) }),
    disconnect: () => call({ type: "service.disconnect" }),
    forget: () => call({ type: "service.forget" }),
    openSignIn: async (origin) => {
      // Built here from a validated origin, never from a URL another context supplied.
      await deps.openTab(new URL("/pair/signed-in", v.parse(serviceOriginSchema, origin)).href);
    },
  };
}
