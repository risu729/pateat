import { manageDevicesSchema, manageErrorSchema, type ManageErrorCode } from "@pateat/contracts";
import * as v from "valibot";

/** A failed API call; `code` is `network` when no answer arrived. */
export class ManageApiError extends Error {
  readonly code: ManageErrorCode | "network" | "unexpected-response";
  constructor(code: ManageApiError["code"]) {
    super(code);
    this.code = code;
  }
}

export type ManageFetch = (input: string, init?: RequestInit) => Promise<Response>;

/**
 * Calls the same-origin `/manage/api`. An expired Access session answers with a
 * redirect to the sign-in page, which a `fetch` cannot follow across origins, so it
 * surfaces as `network`.
 */
async function call(fetcher: ManageFetch, path: string, init?: RequestInit) {
  let response: Response;
  try {
    response = await fetcher(`/manage/api${path}`, {
      ...init,
      credentials: "same-origin",
      redirect: "error",
    });
  } catch {
    throw new ManageApiError("network");
  }
  if (response.ok) return response;
  const error = v.safeParse(manageErrorSchema, await response.json().catch(() => undefined));
  throw new ManageApiError(error.success ? error.output.error : "unexpected-response");
}

async function read<TSchema extends v.GenericSchema>(response: Response, schema: TSchema) {
  const parsed = v.safeParse(schema, await response.json().catch(() => undefined));
  if (!parsed.success) throw new ManageApiError("unexpected-response");
  return parsed.output as v.InferOutput<TSchema>;
}

export function createManageClient(fetcher: ManageFetch = (input, init) => fetch(input, init)) {
  return {
    async devices() {
      return read(await call(fetcher, "/devices"), manageDevicesSchema);
    },
    async revokeDevice(deviceId: string) {
      await call(fetcher, `/devices/${encodeURIComponent(deviceId)}/revoke`, { method: "POST" });
    },
  };
}

export type ManageClient = ReturnType<typeof createManageClient>;

export function describeError(error: unknown): string {
  const code = error instanceof ManageApiError ? error.code : "unexpected-response";
  switch (code) {
    case "network":
    case "unauthorized":
      return "Your sign-in may have expired. Reload the page to sign in again.";
    case "forbidden":
      return "Your sign-in could not be verified. Reload the page to sign in again.";
    case "access_unavailable":
      return "Owner sign-in is not configured for this service.";
    case "not_found":
      return "It no longer exists. Reload the page.";
    default:
      return "Something went wrong. Try again later.";
  }
}
