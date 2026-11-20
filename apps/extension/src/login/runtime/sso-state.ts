import { createSsoPauseIntents } from "./sso-pause";
import * as v from "valibot";
import { storage } from "wxt/utils/storage";
import {
  loginAccountSchema,
  loginDocumentSchema,
  loginOriginSchema,
  type LoginAccount,
  type LoginAttemptMetadata,
  type LoginDocument,
  type LoginTarget,
  type SettingsResponse,
  type SsoRecipeDocument,
} from "@pateat/contracts";
import type { SsoSourceRef, SsoIdpChoice } from "../sso-vault";
import type { Choice, LiveDocument, UnsavedChoice } from "./types";
const KEY = "session:pateat.sso-intents.v1";
const id = v.pipe(v.string(), v.minLength(1), v.maxLength(128));
const journalSchema = v.strictObject({
  id,
  document: loginDocumentSchema,
  account: loginAccountSchema,
  idp: v.strictObject({ connectionId: id, itemId: id, origin: loginOriginSchema }),
  method: v.pipe(v.number(), v.safeInteger(), v.minValue(1), v.maxValue(1_000_000)),
  sourceEvidence: v.pipe(v.string(), v.regex(/^[A-Za-z0-9_-]{43}$/u)),
  phase: v.picklist(["prepared", "entering-idp", "at-idp", "returning-rp"]),
  operationId: v.optional(id),
  /** When the hold began: an interrupted hold ends `SSO_INTERRUPTED_HOLD_MS` later. */
  at: v.optional(v.pipe(v.number(), v.safeInteger(), v.minValue(0))),
  /** The flow was still running when written: its hold begins when the journal is loaded. */
  active: v.optional(v.literal(true)),
});
export type SsoJournalRecord = v.InferOutput<typeof journalSchema>;
/** The most journal records kept; the oldest interrupted holds give way first. */
export const MAX_SSO_JOURNAL = 100;
/** How long a tab stays held on the RP and IdP origins after an interrupted SSO flow. */
export const SSO_INTERRUPTED_HOLD_MS = 10 * 60_000;
export type SsoWork = {
  id: string;
  account: LoginAccount;
  chosen: Choice;
  source: SsoSourceRef;
  selected: SsoIdpChoice;
  form?: "url" | "bracket";
  label?: string;
  entryId?: string;
  /**
   * A URL-form method's pressed RP entry, learned for its IdP once the tab reaches it;
   * `labeled` when only its label chose it, so it is never learned from an RP return.
   */
  entry?: { path: string; target: LoginTarget; labeled?: true };
  phase: "prepared" | "entering-idp" | "at-idp" | "returning-rp";
  rpLive: LiveDocument;
  live: LiveDocument;
  saved: Extract<SettingsResponse, { ok: true }>;
  abort: AbortController;
  startedAt: number;
  recipe?: SsoRecipeDocument;
  layout?: string;
  parent?: LoginAttemptMetadata;
  choice?: UnsavedChoice;
  childId?: string;
  childRecord?: LoginAttemptMetadata;
  moved?: Promise<void>;
  movedAgain?: boolean;
  refresh?: LiveDocument;
  reprompted?: boolean;
  generation?: boolean;
  /** The RP document and path the RP-return judge was last asked about: once each. */
  judged?: string;
  /** The RP document asked to say when it describes something, and how often. */
  watched?: { documentId: string; count: number };
  /**
   * The RP document the IdP child was detached on, at the RP return: its record ends with
   * the flow, signed in once the RP shows it, released otherwise (ADR 0026, amendment of
   * 2026-11-20).
   */
  detached?: LoginDocument;
  /** The detached IdP child's end was recorded (`releaseChild`), once. */
  childEnded?: true;
  /** An RP page's reading on the return, which a page announcing meanwhile waits for. */
  reading?: Promise<void>;
  operation?: {
    id: string;
    handle: string;
    live: LiveDocument;
    stage: "prepared" | "intent" | "pointer" | "spent";
    destinations: string[];
  };
  used: Set<string>;
  busy: boolean;
  ended: boolean;
  stopReason?: string;
  timer?: ReturnType<typeof setTimeout>;
};
export type SsoNativeChoice = {
  document: LoginDocument;
  account: LoginAccount;
  chosen: Choice;
  route: "passkey" | "password";
  /** The chooser's own automatic decision, not a person's explicit pick for this sign-in. */
  automatic?: true;
  /** The item offered an SSO method beside its native routes (ADR 0085). */
  methods?: true;
  /** The person picked this route in the popup, rather than the chooser by itself. */
  picked?: true;
  /** The site had refused the item's passkey, so the chooser picked without it. */
  passkeyRefused?: true;
  /** The login this choice started: only its own refused passkey goes back to the chooser. */
  attemptId?: string;
};
/** Authority is memory-only. Persisted intents become interrupted holds after restart. */
export function createSsoState() {
  const flows = new Map<number, SsoWork>();
  const native = new Map<number, SsoNativeChoice>();
  /**
   * The account whose passkey a tab's site refused: the tab's next choice for it has no
   * passkey, whichever document the site shows by then, so a refusal never repeats.
   */
  const passkeyRefused = new Map<number, LoginAccount>();
  // Immutable run identities outlive parent cancellation until runtime disposal.
  const children = new Map<string, { parentId: string; account: LoginAccount }>();
  const interrupted = new Map<number, SsoJournalRecord>();
  let healthy = true;
  let queue = Promise.resolve();
  const loaded = storage.getItem(KEY).then(
    (raw) => {
      const parsed = v.safeParse(v.array(journalSchema), raw ?? []);
      if (!parsed.success) {
        healthy = false;
        return;
      }
      // An overfull journal keeps its newest records instead of disabling SSO. A flow that
      // was running when the worker stopped is held from the restart, not from its write.
      const now = Date.now();
      for (const { active, ...record } of parsed.output.slice(-MAX_SSO_JOURNAL))
        interrupted.set(record.document.tabId, {
          ...record,
          at: active ? now : (record.at ?? now),
        });
      return;
    },
    () => {
      healthy = false;
    },
  );
  const write = async () => {
    queue = queue.then(async () => {
      await loaded;
      if (!healthy) throw new Error("sso-storage-unavailable");
      const now = Date.now();
      const active = [...flows.values()]
        .filter((work) => !work.ended)
        .map((work) => ({
          at: now,
          id: work.id,
          document: work.rpLive.document,
          account: work.account,
          idp: { ...work.selected.account, origin: work.selected.origin },
          method: work.source.method.number,
          sourceEvidence: work.source.sourceEvidence,
          phase: work.phase,
          ...(work.operation ? { operationId: work.operation.id } : {}),
          active: true as const,
        }));
      // Insertion order is age order: the oldest holds are pruned to keep the journal bounded.
      for (const tabId of interrupted.keys()) {
        if (interrupted.size + active.length <= MAX_SSO_JOURNAL) break;
        interrupted.delete(tabId);
      }
      return storage.setItem(KEY, [...interrupted.values(), ...active]);
    });
    try {
      await queue;
    } catch (error) {
      healthy = false;
      throw error;
    }
  };
  return {
    flows,
    native,
    passkeyRefused,
    pauseIntents: createSsoPauseIntents(),
    children,
    interrupted,
    loaded,
    write,
    healthy: () => healthy,
  };
}
export type SsoState = ReturnType<typeof createSsoState>;
export function registerSsoChild(
  state: SsoState,
  work: SsoWork,
  metadata: LoginAttemptMetadata,
): boolean {
  if (
    work.ended ||
    work.childId ||
    state.children.has(metadata.id) ||
    state.children.size >= 1000 ||
    metadata.document.tabId !== work.rpLive.document.tabId ||
    metadata.document.frameId !== 0 ||
    metadata.document.origin !== work.selected.origin ||
    metadata.account.origin !== work.selected.origin ||
    metadata.account.connectionId !== work.selected.account.connectionId ||
    metadata.account.itemId !== work.selected.account.itemId
  )
    return false;
  metadata.ssoChild = { parentId: work.id, attemptId: metadata.id };
  work.childId = metadata.id;
  work.childRecord = metadata;
  state.children.set(metadata.id, { parentId: work.id, account: { ...metadata.account } });
  return true;
}
export const ssoChild = (state: SsoState, metadata: LoginAttemptMetadata) => {
  const child = state.children.get(metadata.id);
  if (!child) return metadata.ssoChild?.attemptId === metadata.id;
  return (
    child !== undefined &&
    child.account.origin === metadata.account.origin &&
    child.account.connectionId === metadata.account.connectionId &&
    child.account.itemId === metadata.account.itemId
  );
};
