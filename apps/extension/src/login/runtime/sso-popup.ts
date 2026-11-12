import * as v from "valibot";
import { ssoCancelRequestSchema, ssoChooseRequestSchema, ssoGetRequestSchema } from "../sso-wire";
import type { Runtime } from "./state";

/**
 * The popup's SSO method choice messages (ADR 0085), or undefined for any other message.
 * The sender is checked by the caller.
 */
export function ssoPopupMessage(rt: Runtime, message: unknown): Promise<unknown> | undefined {
  const get = v.safeParse(ssoGetRequestSchema, message);
  if (get.success) return Promise.resolve(rt.ssoChoices?.get(get.output.tabId) ?? { ok: true });
  const choose = v.safeParse(ssoChooseRequestSchema, message);
  if (choose.success)
    return Promise.resolve(
      rt.ssoChoices?.choose(choose.output) ?? { ok: false, reason: "unavailable" },
    );
  const cancel = v.safeParse(ssoCancelRequestSchema, message);
  if (cancel.success)
    return Promise.resolve(
      rt.ssoChoices?.cancel(cancel.output.tabId, cancel.output.offerId) ?? {
        ok: false,
        reason: "offer-gone",
      },
    );
  return undefined;
}
