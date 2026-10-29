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

/** Why a profile editor request failed; the editor words each one. */
export type ProfileEditorFailure =
  /** No WARP sign-in reached the service: a redirect, a `401` or a body that is not JSON. */
  | "sign-in-needed"
  /** The service refused the sign-in, for example from a browser without WARP. */
  | "forbidden"
  /** The service does not list this extension's ID in `PAIRING_EXTENSION_IDS`. */
  | "extension-not-allowed"
  /** Another save changed the owner's settings first. */
  | "conflict"
  /** The profile was deleted meanwhile. */
  | "not-found"
  | "unreachable"
  | "unexpected-response";

export class ProfileEditorError extends Error {
  readonly reason: ProfileEditorFailure;
  constructor(reason: ProfileEditorFailure) {
    super(reason);
    this.reason = reason;
  }
}

/**
 * Edits profiles other than this device's on the service's WARP application, with the
 * browser's sign-in there (ADR 0076). Each call throws a `ProfileEditorError`.
 */
export interface ProfileEditorClient {
  list(origin: string): Promise<{ version: 1; profiles: { id: string; name: string }[] }>;
  read(origin: string, profileId: string): Promise<SyncSettingsState>;
  save(
    origin: string,
    profileId: string,
    revision: number,
    settings: LocalSettings,
  ): Promise<SyncSettingsState>;
  /** Opens the service's `/extension/signed-in` page, where the user signs in. */
  openSignIn(origin: string): Promise<void>;
}

export interface ServiceClient {
  get(): Promise<ServiceResponse>;
  profileEditor?: ProfileEditorClient;
  /**
   * Asks Chrome for site access to the service origin, which the user may have withheld.
   * Call it first in a click handler: Chrome prompts only during a user gesture.
   */
  requestSiteAccess(origin: string): Promise<boolean>;
  /**
   * Pairs in one request from the background with the browser's login session (ADR 0020).
   * `profile` is the existing profile the device takes, or the name of a new one.
   */
  pair(
    origin: string,
    label: string,
    profile?: { profileId: string } | { newProfile: string },
  ): Promise<ServiceResponse>;
  /** Disconnects; `keepRecipes` keeps the synced recipes as this device's own (ADR 0040). */
  disconnect(keepRecipes: boolean): Promise<ServiceResponse>;
  /** Deletes the recipes this device holds as its own (ADR 0040). */
  deleteRecipes(): Promise<ServiceResponse>;
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
    const url = new URL(`/extension/profiles${path}`, v.parse(serviceOriginSchema, origin));
    let response: Response;
    try {
      response = await fetch(url, {
        method: body ? "PUT" : "GET",
        credentials: "include",
        // An expired sign-in redirects to the login page; that is a sign-in, not a failure.
        redirect: "manual",
        cache: "no-store",
        referrerPolicy: "no-referrer",
        // Asks Access to answer an expired session with a 401 instead of a redirect.
        headers: { "Content-Type": "application/json", "X-Requested-With": "XMLHttpRequest" },
        ...(body ? { body: JSON.stringify(body) } : {}),
      });
    } catch {
      throw new ProfileEditorError("unreachable");
    }
    if (response.type === "opaqueredirect" || response.status === 401)
      throw new ProfileEditorError("sign-in-needed");
    if (response.status === 403) {
      // Access answers a refused sign-in with its own page; the Worker names its reason.
      const answer: unknown = await response.json().catch(() => undefined);
      const code = v.safeParse(v.object({ error: v.string() }), answer);
      throw new ProfileEditorError(
        code.success && code.output.error === "extension_not_allowed"
          ? "extension-not-allowed"
          : "forbidden",
      );
    }
    if (response.status === 409) throw new ProfileEditorError("conflict");
    if (response.status === 404) throw new ProfileEditorError("not-found");
    if (!response.ok) throw new ProfileEditorError("unexpected-response");
    let json: unknown;
    try {
      json = await response.json();
    } catch {
      // Access's login page answers some expired sessions with HTML and a 200.
      throw new ProfileEditorError("sign-in-needed");
    }
    const parsed = v.safeParse(schema, json);
    if (!parsed.success) throw new ProfileEditorError("unexpected-response");
    return parsed.output as v.InferOutput<T>;
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
      openSignIn: async (origin) => {
        await deps.openTab(
          new URL("/extension/signed-in", v.parse(serviceOriginSchema, origin)).href,
        );
      },
    },
    get: () => call({ type: "service.get" }),
    requestSiteAccess: (origin) => deps.requestSiteAccess(origin).catch(() => false),
    pair: (origin, label, profile) => call({ type: "service.pair", origin, label, ...profile }),
    disconnect: (keepRecipes) => call({ type: "service.disconnect", keepRecipes }),
    deleteRecipes: () => call({ type: "service.delete-recipes" }),
    forget: () => call({ type: "service.forget" }),
    openSignIn: async (origin) => {
      // Built here from a validated origin, never from a URL another context supplied.
      await deps.openTab(new URL("/pair/signed-in", v.parse(serviceOriginSchema, origin)).href);
    },
  };
}
