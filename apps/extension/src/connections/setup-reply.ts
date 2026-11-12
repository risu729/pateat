import type { SetupReply } from "./types";

export const error = (code: Extract<SetupReply, { ok: false }>["error"]["code"]): SetupReply => ({
  ok: false,
  error: { code },
});
/** The single reply boundary: a failure carries only its code, never a provider status or
 * value. An account mismatch also names the failed check, and a decryption failure the
 * strict check and the item's ID and revision date, so a real-account report is actionable. */
export const replyOf = (result: SetupReply): SetupReply => {
  if (result.ok) return result;
  const { code, check, item, revised } = result.error;
  if (code === "account-mismatch" && check) return { ok: false, error: { code, check } };
  if (code === "crypto-failed" && check)
    return {
      ok: false,
      error: {
        code,
        check,
        ...(item === undefined ? {} : { item }),
        ...(revised === undefined ? {} : { revised }),
      },
    };
  return error(code);
};
