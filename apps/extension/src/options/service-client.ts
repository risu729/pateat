import { parseServiceResponse, serviceOriginSchema, type ServiceResponse } from "@pateat/contracts";
import * as v from "valibot";

export interface ServiceClient {
  get(): Promise<ServiceResponse>;
  /**
   * Asks Chrome for site access to the service origin, which the user may have withheld.
   * Call it first in a click handler: Chrome prompts only during a user gesture.
   */
  requestSiteAccess(origin: string): Promise<boolean>;
  /** Pairs in one request from the background with the browser's login session (ADR 0020). */
  pair(origin: string, label: string): Promise<ServiceResponse>;
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
  return {
    get: () => call({ type: "service.get" }),
    requestSiteAccess: (origin) => deps.requestSiteAccess(origin).catch(() => false),
    pair: (origin, label) => call({ type: "service.pair", origin, label }),
    disconnect: () => call({ type: "service.disconnect" }),
    forget: () => call({ type: "service.forget" }),
    openSignIn: async (origin) => {
      // Built here from a validated origin, never from a URL another context supplied.
      await deps.openTab(new URL("/pair/signed-in", v.parse(serviceOriginSchema, origin)).href);
    },
  };
}
