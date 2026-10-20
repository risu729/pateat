// Reads Vaultwarden's two-step emails from Mailpit's HTTP API (ADR 0059 decision 6).
import * as v from "valibot";

/** Subject of Vaultwarden 1.37.4's `email/twofactor_email` template. */
export const twoStepSubject = "Vaultwarden Login Verification Code";

const searchSchema = v.object({
  messages: v.array(v.object({ ID: v.string(), Subject: v.string() })),
});
const messageSchema = v.object({ Text: v.string() });

async function request(url: string, init?: RequestInit) {
  const response = await fetch(url, { ...init, signal: AbortSignal.timeout(5000) });
  if (!response.ok) throw new Error(`Mailpit answered ${response.status} for ${url}`);
  return response;
}
async function json(url: string) {
  return (await (await request(url)).json()) as unknown;
}

/**
 * Waits for the newest two-step code sent to `address`, then deletes that message so the next
 * call waits for a newer one. Searching by recipient keeps parallel tests apart.
 */
export async function readTwoStepCode(
  mailpitUrl: string,
  address: string,
  options: { timeoutMs?: number } = {},
): Promise<string> {
  const query = new URLSearchParams({ query: `to:"${address}" subject:"${twoStepSubject}"` });
  const deadline = Date.now() + (options.timeoutMs ?? 15_000);
  for (;;) {
    // eslint-disable-next-line no-await-in-loop
    const found = v.parse(searchSchema, await json(`${mailpitUrl}/api/v1/search?${query}`));
    // Search answers newest first; the subject filter also matches longer subjects.
    const newest = found.messages.find((message) => message.Subject === twoStepSubject);
    if (newest) {
      const message = v.parse(
        messageSchema,
        // eslint-disable-next-line no-await-in-loop
        await json(`${mailpitUrl}/api/v1/message/${encodeURIComponent(newest.ID)}`),
      );
      const code = /Your two-step verification code is: (\S+)/.exec(message.Text)?.[1];
      if (!code) throw new Error("The two-step email holds no code");
      // eslint-disable-next-line no-await-in-loop
      const deleted = await request(`${mailpitUrl}/api/v1/messages`, {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ IDs: [newest.ID] }),
      });
      // eslint-disable-next-line no-await-in-loop
      await deleted.body?.cancel();
      return code;
    }
    if (Date.now() > deadline) throw new Error(`No "${twoStepSubject}" email reached ${address}`);
    // eslint-disable-next-line no-await-in-loop
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
}
