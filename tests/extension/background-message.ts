import type { Page } from "@playwright/test";
import type { BackgroundProtocol } from "../../apps/extension/src/messaging/protocol";

/** Keys of one request each; any other request goes under its `type` up to the first dot. */
const singleRequests: ReadonlySet<string> = new Set([
  "setup.probe",
  "vault.probe",
  "crypto.probe",
  "pateat.test.document",
]);

/** The `BackgroundProtocol` key a request is carried under. */
function backgroundArea(type: string): keyof BackgroundProtocol {
  return (singleRequests.has(type) ? type : type.split(".")[0]) as keyof BackgroundProtocol;
}

/**
 * The message `@webext-core/messaging` sends for `request`. A test builds it in the page,
 * which cannot import the library; the extension's own pages send the same shape.
 */
export function backgroundMessage<T extends { type: string }>(request: T) {
  return { id: 0, type: backgroundArea(request.type), data: request, timestamp: Date.now() };
}

/**
 * Sends `request` from `page` to the background as the extension's own pages do and
 * returns the answer: `undefined` when the background answered nothing, a rejection when
 * no listener took the message.
 */
export function sendToBackground<T extends { type: string }>(
  page: Page,
  request: T,
): Promise<unknown> {
  return page.evaluate(async (message) => {
    const { chrome } = globalThis as unknown as {
      chrome: { runtime: { sendMessage(message: unknown): Promise<unknown> } };
    };
    const reply = (await chrome.runtime.sendMessage(message)) as { res?: unknown } | undefined;
    return reply?.res;
  }, backgroundMessage(request));
}
