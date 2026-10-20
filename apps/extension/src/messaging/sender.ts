/**
 * The origin of a message sender's document, from the browser-supplied sender only: its
 * `origin` when that is the origin of its `url`. A document whose origin is opaque, such
 * as a page served with a CSP `sandbox` header or a sandboxed frame, has none, whatever
 * its URL.
 */
export function senderDocumentOrigin(sender: {
  origin?: string | undefined;
  url?: string | undefined;
}): string | undefined {
  if (typeof sender.origin !== "string" || typeof sender.url !== "string") return undefined;
  // An opaque URL such as `data:` has the opaque origin too, so the comparison alone would
  // let it through.
  if (sender.origin === "null") return undefined;
  return URL.parse(sender.url)?.origin === sender.origin ? sender.origin : undefined;
}

/**
 * A sender's document URL without its fragment. Chrome reports the URL the document was
 * loaded with, so a settings page reloaded after a section link (`options.html#sync`)
 * keeps that fragment; it never changes which page runs, so page checks ignore it.
 */
export function senderPageUrl(sender: { url?: string | undefined }): string | undefined {
  return sender.url?.split("#", 1)[0];
}
