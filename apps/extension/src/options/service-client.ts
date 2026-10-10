import { parseServiceResponse, type ServiceResponse } from "@pateat/contracts";

export interface ServiceClient {
  get(): Promise<ServiceResponse>;
  /**
   * Asks Chrome for site access to the service origin, which the user may have withheld.
   * Call it first in a click handler: Chrome prompts only during a user gesture.
   */
  requestSiteAccess(origin: string): Promise<boolean>;
  start(origin: string, label: string): Promise<ServiceResponse>;
  check(): Promise<ServiceResponse>;
  cancel(): Promise<ServiceResponse>;
  disconnect(): Promise<ServiceResponse>;
  /** Forgets an unreadable local connection without contacting the service. */
  forget(): Promise<ServiceResponse>;
  /** Opens the service's approval page in an ordinary tab. */
  openApproval(url: string): Promise<void>;
}

/** Only connection state crosses here; the verifier and credential stay in the background. */
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
    start: (origin, label) => call({ type: "service.pair.start", origin, label }),
    check: () => call({ type: "service.pair.check" }),
    cancel: () => call({ type: "service.pair.cancel" }),
    disconnect: () => call({ type: "service.disconnect" }),
    forget: () => call({ type: "service.forget" }),
    openApproval: async (url) => {
      await deps.openTab(url);
    },
  };
}
