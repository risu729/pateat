import * as v from "valibot";
import { toBase64Url } from "./encoding";
import { credentialDescriptorSchema, MAX_ALLOW_CREDENTIALS } from "./request";
import { resolveRpId } from "./rp-id";
import { abortable, senderOrigin, type PasskeySource, type Sender } from "./runtime";
import { matchingPasskeys, type PasskeyCandidate } from "./select";
import type { SignIns } from "./sign-ins";
import { RUNTIME_TIMEOUT_MS, createMessageSchema, type CreateResult } from "./wire";

/** How long after Pateat signed a tab in it refuses a registration there (ADR 0007). */
export const CREATE_AFTER_SIGN_IN_MS = 5 * 60_000;
/** `create` checks in flight at once; any further one is handed on unchecked. */
const MAX_CREATE_CHECKS = 16;

/**
 * Bounded, page-supplied snapshot of `navigator.credentials.create({ publicKey })` options:
 * only what the check reads. The bridge relays only requests with a non-empty
 * `excludeCredentials`.
 */
export const bridgedCreateRequestSchema = v.strictObject({
  rpId: v.optional(v.pipe(v.string(), v.maxLength(253))),
  excludeCredentials: v.pipe(
    v.array(credentialDescriptorSchema),
    v.minLength(1),
    v.maxLength(MAX_ALLOW_CREDENTIALS),
  ),
  mediation: v.optional(v.pipe(v.string(), v.maxLength(64))),
});
export type BridgedCreateRequest = v.InferInput<typeof bridgedCreateRequestSchema>;

/**
 * Value-free account of one checked `create` request, for the local log only: the outcome,
 * why it was handed on, and how many credentials it excluded. Credential IDs, user details
 * and item IDs are never included.
 */
export interface PasskeyCreateReport {
  /** The requesting tab, which paces how many reports one page can cause. */
  readonly tabId: number;
  readonly origin: string;
  readonly outcome: "declined" | "delegate";
  readonly reason?: string;
  readonly rpId?: string;
  /** `conditional` for the browser's automatic passkey upgrade, `other` for any other. */
  readonly mediation?: "conditional" | "other";
  readonly excludeCredentials?: number;
  /** The request excluded a passkey Pateat could sign with for its RP ID. */
  readonly listed?: boolean;
  /** Whole seconds since Pateat's latest sign-in to this RP ID in the tab. */
  readonly sinceSignIn?: number;
}
type CreateDetail = {
  -readonly [
    K in Exclude<keyof PasskeyCreateReport, "tabId" | "origin" | "outcome" | "reason">
  ]?: PasskeyCreateReport[K];
};

/**
 * Background check of bridged `create` requests (ADR 0007). Pateat refuses a registration only
 * when, within `CREATE_AFTER_SIGN_IN_MS` of its own sign-in to that RP ID in the same tab, the
 * request's `excludeCredentials` lists a passkey Pateat could sign with there: the site already
 * holds it, and the page gets the NotAllowedError a dismissed browser prompt gives. Every other
 * request, and any failure, hands it on to the browser and later providers. Nothing is written.
 */
export function createPasskeyCreateHandler<TCandidate extends PasskeyCandidate>(
  source: PasskeySource<TCandidate>,
  options: {
    extensionId: string;
    signIns: Pick<SignIns, "list">;
    timeoutMs?: () => number;
    /** Holds vault replacement off while the vault is read (ADR 0025). */
    hold?: () => Promise<() => void>;
    /** Receives a value-free report of each checked request. */
    report?: (report: PasskeyCreateReport) => void;
    now?: () => number;
  },
) {
  const now = options.now ?? Date.now;
  let running = 0;
  const delegate = (reason: string): CreateResult => ({ kind: "delegate", reason });

  /**
   * Whether the vault holds a passkey for this RP ID that is listed and Pateat signs with,
   * and whether the vault was searched completely.
   */
  async function listed(
    origin: string,
    rpId: string,
    excluded: readonly string[],
  ): Promise<{ found: boolean; complete: boolean } | undefined> {
    const controller = new AbortController();
    const timer = setTimeout(
      () => controller.abort(new DOMException("Passkey check timed out", "TimeoutError")),
      options.timeoutMs?.() ?? RUNTIME_TIMEOUT_MS,
    );
    const { signal } = controller;
    let leave: (() => void) | undefined;
    try {
      const entering = Promise.resolve(options.hold?.());
      try {
        leave = await abortable(entering, signal);
      } catch (error) {
        void entering.then(
          (late) => late?.(),
          () => {},
        );
        throw error;
      }
      const candidates = await abortable(source.candidates(origin, rpId, signal), signal);
      if (!candidates) return undefined;
      const found = matchingPasskeys(
        { rpId, allowCredentialIds: excluded },
        candidates.candidates,
      ).some((candidate) => candidate.counter === 0);
      return { found, complete: candidates.complete };
    } finally {
      clearTimeout(timer);
      leave?.();
    }
  }

  async function decide(
    request: unknown,
    origin: string,
    tabId: number,
    detail: CreateDetail,
  ): Promise<CreateResult> {
    const parsed = v.safeParse(bridgedCreateRequestSchema, request);
    if (!parsed.success) return delegate("invalid-request");
    const { excludeCredentials, mediation } = parsed.output;
    detail.excludeCredentials = excludeCredentials.length;
    if (mediation !== undefined)
      detail.mediation = mediation === "conditional" ? "conditional" : "other";
    const resolved = resolveRpId(origin, parsed.output.rpId);
    if (!resolved.ok) return delegate(resolved.reason);
    const { rpId } = resolved;
    detail.rpId = rpId;
    // A sign-in to this RP ID: a passkey made for it, or a login of an origin it covers.
    const signIns = (await options.signIns.list(tabId)).filter(
      (record) => record.rpId === rpId || resolveRpId(record.origin, rpId).ok,
    );
    if (signIns.length === 0) return delegate("not-signed-in");
    const since = now() - Math.max(...signIns.map((record) => record.at));
    detail.sinceSignIn = Math.max(0, Math.floor(since / 1000));
    if (since > CREATE_AFTER_SIGN_IN_MS) return delegate("expired");
    // Unknown descriptor types are skipped, as the client algorithm requires.
    const excluded = excludeCredentials
      .filter((entry) => entry.type === "public-key")
      .map((entry) => toBase64Url(entry.id));
    if (excluded.length === 0) {
      detail.listed = false;
      return delegate("not-listed");
    }
    let found: { found: boolean; complete: boolean } | undefined;
    try {
      found = await listed(origin, rpId, excluded);
    } catch (error) {
      return delegate(
        error instanceof DOMException && error.name === "TimeoutError"
          ? "timeout"
          : "vault-unavailable",
      );
    }
    if (found === undefined) return delegate("not-configured");
    detail.listed = found.found;
    // A locked or partly searched vault may hold the listed passkey; a found one still declines.
    if (found.found) return { kind: "decline" };
    return delegate(found.complete ? "not-listed" : "vault-incomplete");
  }

  return {
    async handle(message: unknown, sender: Sender): Promise<CreateResult> {
      const parsed = v.safeParse(createMessageSchema, message);
      const origin = senderOrigin(sender, options.extensionId);
      if (!parsed.success || !origin) return delegate("invalid-sender");
      // senderOrigin() accepted only a sender with a tab.
      const tabId = sender.tab!.id!;
      const detail: CreateDetail = {};
      let result: CreateResult;
      if (running >= MAX_CREATE_CHECKS) result = delegate("busy");
      else {
        running++;
        try {
          result = await decide(parsed.output.request, origin, tabId, detail);
        } catch {
          result = delegate("vault-unavailable");
        } finally {
          running--;
        }
      }
      try {
        options.report?.({
          ...detail,
          tabId,
          origin,
          outcome: result.kind === "decline" ? "declined" : "delegate",
          ...(result.kind === "delegate" ? { reason: result.reason } : {}),
        });
      } catch {
        // A report must never change the answer.
      }
      return result;
    },
  };
}
