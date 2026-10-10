import { parseServiceResponse, type ServiceResponse } from "@pateat/contracts";

export interface ServiceClient {
  get(): Promise<ServiceResponse>;
  start(origin: string, label: string): Promise<ServiceResponse>;
  check(): Promise<ServiceResponse>;
  cancel(): Promise<ServiceResponse>;
  disconnect(): Promise<ServiceResponse>;
  /** Opens the service's approval page in an ordinary tab. */
  openApproval(url: string): Promise<void>;
}

/** Only connection state crosses here; the verifier and credential stay in the background. */
export function createServiceClient(
  send: (message: unknown) => Promise<unknown>,
  openTab: (url: string) => Promise<unknown>,
): ServiceClient {
  const call = async (message: object) =>
    parseServiceResponse(await send({ version: 1, ...message }));
  return {
    get: () => call({ type: "service.get" }),
    start: (origin, label) => call({ type: "service.pair.start", origin, label }),
    check: () => call({ type: "service.pair.check" }),
    cancel: () => call({ type: "service.pair.cancel" }),
    disconnect: () => call({ type: "service.disconnect" }),
    openApproval: async (url) => {
      await openTab(url);
    },
  };
}
