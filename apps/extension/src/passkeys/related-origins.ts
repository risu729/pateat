import { parse } from "tldts";
import { resolveRpId } from "./rp-id";

/**
 * How many registrable origin labels one RP's list may name before further labels are
 * skipped, as Chrome and Bitwarden allow (WebAuthn "maxLabels").
 */
export const RELATED_ORIGIN_MAX_LABELS = 5;
/** The bound on one fetch of an RP's list, as Bitwarden's (`ROR_FETCH_TIMEOUT_MS`). */
export const RELATED_ORIGIN_FETCH_MS = 5000;
/** A list larger than this many bytes is refused; the read stops there. */
const MAX_LIST_BYTES = 64 * 1024;
/** How long a fetched list is reused, and how long a failed fetch is. */
const LIST_TTL_MS = 10 * 60 * 1000;
const FAILURE_TTL_MS = 60 * 1000;
/** RP IDs whose lists are kept in memory at once. */
const MAX_CACHED = 64;

const suffixOptions = { allowPrivateDomains: true } as const;

/**
 * Whether the `origins` of an RP's `.well-known/webauthn` document list `callerOrigin`, by
 * the WebAuthn related origins validation procedure: entries that are no URL or have no
 * registrable origin label are skipped, and once `RELATED_ORIGIN_MAX_LABELS` labels were
 * seen, entries of further labels are too. A document of another shape lists nothing.
 */
export function relatedOriginListed(callerOrigin: string, document: unknown): boolean {
  if (typeof document !== "object" || document === null || Array.isArray(document)) return false;
  const { origins } = document as { origins?: unknown };
  if (!Array.isArray(origins) || !origins.every((entry) => typeof entry === "string")) return false;
  const labelsSeen = new Set<string>();
  for (const entry of origins as string[]) {
    const url = URL.parse(entry);
    if (!url?.hostname) continue;
    const label = parse(url.hostname, suffixOptions).domainWithoutSuffix;
    if (!label) continue;
    if (labelsSeen.size >= RELATED_ORIGIN_MAX_LABELS && !labelsSeen.has(label)) continue;
    if (url.origin === callerOrigin) return true;
    labelsSeen.add(label);
  }
  return false;
}

/**
 * Whether a related origins check applies to `rpId` on a page of `callerOrigin`: an HTTPS
 * page, and an RP ID that is a canonical registrable domain or a name under one, but
 * neither the page's host nor a registrable suffix of it. An RP ID the page may use anyway, or one that is no valid
 * domain, never needs one.
 */
export function needsRelatedOrigins(callerOrigin: string, rpId: string): boolean {
  if (!callerOrigin.startsWith("https://")) return false;
  // A public suffix, such as `com` or `github.io`, has no list to read.
  if (!parse(rpId, suffixOptions).domain) return false;
  const resolved = resolveRpId(callerOrigin, rpId);
  return !resolved.ok && resolved.reason === "rp-id-mismatch";
}

export interface RelatedOrigins {
  /**
   * Whether a page of `callerOrigin` may use `rpId` because the RP lists that origin at
   * `https://<rpId>/.well-known/webauthn` (WebAuthn related origin requests). False for an
   * RP ID that needs no such list, and whenever the list cannot be read.
   */
  allows(callerOrigin: string, rpId: string): Promise<boolean>;
}

type Cached = { until: number; document: Promise<unknown> };

/** The body as text, read only up to `MAX_LIST_BYTES`; anything longer throws. */
async function boundedText(response: Response): Promise<string> {
  if (Number(response.headers.get("content-length")) > MAX_LIST_BYTES)
    throw new Error("list-too-large");
  const reader = response.body?.getReader();
  if (!reader) return "";
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    // Chunks arrive one after another; the fetch's own bound ends a slow body.
    // eslint-disable-next-line no-await-in-loop
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > MAX_LIST_BYTES) {
      // eslint-disable-next-line no-await-in-loop -- the loop ends here
      await reader.cancel().catch(() => undefined);
      throw new Error("list-too-large");
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(bytes);
}

/**
 * Reads RP lists as Chrome and Bitwarden do: without credentials or a referrer, a `200`
 * answer with a JSON content type, within `RELATED_ORIGIN_FETCH_MS`, and at most
 * `MAX_LIST_BYTES`. Redirects are followed, as `amazon.com` redirects to `www.amazon.com`,
 * but an answer that came over anything but HTTPS is refused. A list is kept in memory for
 * ten minutes and any failed read for one, so the logins and passkey requests of a site
 * share one fetch. Nothing is stored.
 */
export function createRelatedOrigins(
  options: { fetch?: typeof fetch; now?: () => number } = {},
): RelatedOrigins {
  const fetchList = options.fetch ?? ((...input) => globalThis.fetch(...input));
  const now = options.now ?? Date.now;
  const cache = new Map<string, Cached>();
  const read = async (rpId: string): Promise<unknown> => {
    const response = await fetchList(`https://${rpId}/.well-known/webauthn`, {
      credentials: "omit",
      referrerPolicy: "no-referrer",
      signal: AbortSignal.timeout(RELATED_ORIGIN_FETCH_MS),
    });
    const type = response.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase();
    if (
      response.status !== 200 ||
      type !== "application/json" ||
      (response.url !== "" && !response.url.startsWith("https://"))
    ) {
      await response.body?.cancel().catch(() => undefined);
      throw new Error("list-refused");
    }
    return JSON.parse(await boundedText(response));
  };
  const document = (rpId: string) => {
    const at = now();
    const cached = cache.get(rpId);
    if (cached && cached.until > at) return cached.document;
    const entry: Cached = { until: at + LIST_TTL_MS, document: Promise.resolve(undefined) };
    entry.document = read(rpId).catch(() => {
      // A failed read is tried again sooner than a list is.
      entry.until = Math.min(entry.until, now() + FAILURE_TTL_MS);
      return undefined;
    });
    cache.delete(rpId);
    cache.set(rpId, entry);
    // The oldest list goes first once too many are kept.
    for (const key of cache.keys()) {
      if (cache.size <= MAX_CACHED) break;
      cache.delete(key);
    }
    return entry.document;
  };
  return {
    async allows(callerOrigin, rpId) {
      if (!needsRelatedOrigins(callerOrigin, rpId)) return false;
      return relatedOriginListed(callerOrigin, await document(rpId));
    },
  };
}
