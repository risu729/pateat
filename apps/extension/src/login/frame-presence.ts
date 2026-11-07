import * as v from "valibot";
import { browser } from "wxt/browser";
import { framePresentSchema } from "./wire/messages";

/**
 * Answers the worker's `login.frame.present` in this document from its start, so a frame
 * that moved to its next document reads as still there before the login content script
 * runs in it (ADR 0086). Returns the listener's removal.
 */
export function answerFramePresence(): () => void {
  const listener: Parameters<typeof browser.runtime.onMessage.addListener>[0] = (
    message,
    sender,
    respond,
  ) => {
    if (sender.id !== browser.runtime.id || sender.tab) return false;
    if (!v.is(framePresentSchema, message)) return false;
    respond(true);
    return false;
  };
  browser.runtime.onMessage.addListener(listener);
  return () => browser.runtime.onMessage.removeListener(listener);
}
