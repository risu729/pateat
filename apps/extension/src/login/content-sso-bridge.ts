import type * as v from "valibot";
import { sendMessage } from "../messaging/protocol";
import { createSsoContent } from "./content-sso";
import type { SsoContentCommand } from "./sso-operation-wire";
import type { commandSchema } from "./wire/commands";

type Command = v.InferOutput<typeof commandSchema>;

const ssoTypes = new Set<string>([
  "login.sso.return",
  "login.sso.inspect",
  "login.sso.prepare",
  "login.sso.commit",
  "login.sso.idp",
  "login.stay.prepare",
  "login.stay.commit",
]);
type BridgedCommand = Extract<Command, { type: SsoContentCommand["type"] | "login.native.cancel" }>;
const isSso = (command: BridgedCommand): command is BridgedCommand & SsoContentCommand =>
  ssoTypes.has(command.type);
/** Whether `command` is one `handle` answers: an SSO command or a native cancel. */
export const ssoBridged = (command: Command): command is BridgedCommand =>
  ssoTypes.has(command.type) || command.type === "login.native.cancel";
// Native attempts this document refuses after the SSO coordinator cancelled them.
const MAX_CANCELLED_NATIVE = 256;

/**
 * The login content script's side of the SSO coordinator (ADR 0085): the SSO click protocol,
 * which also presses a native login's stay-signed-in question (ADR 0065 amendment of
 * 2026-11-22), the native attempts the coordinator cancelled in this document, and whether
 * the SSO parent still carries this IdP document after its native child finished.
 */
export function createSsoBridge(
  document: Document,
  token: string,
  cancelled: () => boolean,
  /** Drops what this document holds for a cancelled native attempt. */
  forgetNative: (attemptId: string) => void,
) {
  const cancelledNative = new Set<string>();
  let carrying = false;
  const run = createSsoContent(document, {
    cancelled,
    authorize: async ({ flowId, operationId, handle, phase }) => {
      const answer: unknown = await sendMessage("login", {
        version: 1,
        type: "login.sso.authorize",
        phase,
        token,
        flowId,
        operationId,
        handle,
      });
      return answer !== null && typeof answer === "object" && "ok" in answer && answer.ok === true;
    },
    authorizeStay: async ({ attemptId, operationId, handle, phase }) => {
      const answer: unknown = await sendMessage("login", {
        version: 1,
        type: "login.stay.authorize",
        phase,
        token,
        attemptId,
        operationId,
        handle,
      });
      return answer !== null && typeof answer === "object" && "ok" in answer && answer.ok === true;
    },
    attemptCancelled: (attemptId) => cancelledNative.has(attemptId),
  });
  return {
    /** Whether a URL change of this document is reported for the SSO parent. */
    carrying: () => carrying,
    /** Whether the document or this native attempt in it was cancelled. */
    cancelled: (attemptId: string) => cancelled() || cancelledNative.has(attemptId),
    /** Answers an SSO or native-cancel command, returning whether the answer is asynchronous. */
    handle(command: BridgedCommand, respond: (answer: unknown) => void): boolean {
      if (isSso(command)) {
        if (command.type === "login.sso.idp") carrying = true;
        void run(command).then(respond, () => respond({ ok: false }));
        return true;
      }
      if (!cancelledNative.has(command.attemptId) && cancelledNative.size >= MAX_CANCELLED_NATIVE) {
        respond({ ok: false });
        return false;
      }
      cancelledNative.add(command.attemptId);
      forgetNative(command.attemptId);
      respond({ ok: true });
      return false;
    },
  };
}
