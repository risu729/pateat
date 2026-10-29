/**
 * A message to a login document that went unanswered, mostly because the document is gone:
 * a submit or a redirect replaced it, or its tab closed. Its replacement resumes the login.
 * `reason` keeps what the browser said: no listener was left, or the page went into the
 * back/forward cache (`no-receiver`), the listener did not answer, as when the document
 * unloads while it handles the message or a content script fault leaves it unanswered
 * (`port-closed`), or anything else (`send-failed`).
 */
export class DocumentGone extends Error {
  override name = "DocumentGone";
  readonly reason: "no-receiver" | "port-closed" | "send-failed";
  constructor(cause: unknown) {
    super("document-gone");
    const message = cause instanceof Error ? cause.message : "";
    this.reason = /Receiving end does not exist|back\/forward cache/u.test(message)
      ? "no-receiver"
      : /message (?:port|channel) closed/u.test(message)
        ? "port-closed"
        : "send-failed";
  }
}
