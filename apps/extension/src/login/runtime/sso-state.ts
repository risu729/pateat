import * as v from "valibot";
import { storage } from "wxt/utils/storage";
import {
  loginAccountSchema,
  loginDocumentSchema,
  loginOriginSchema,
  type LoginAccount,
  type LoginAttemptMetadata,
  type LoginDocument,
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
});
export type SsoWork = {
  id: string;
  account: LoginAccount;
  chosen: Choice;
  source: SsoSourceRef;
  selected: SsoIdpChoice;
  form?: "url" | "bracket";
  label?: string;
  entryId?: string;
  phase: "prepared" | "entering-idp" | "at-idp" | "returning-rp";
  rpLive: LiveDocument;
  live: LiveDocument;
  saved: Extract<SettingsResponse, { ok: true }>;
  abort: AbortController;
  startedAt: number;
  recipe?: SsoRecipeDocument;
  deliveryFence?: () => boolean;
  layout?: string;
  parent?: LoginAttemptMetadata;
  choice?: UnsavedChoice;
  childId?: string;
  reprompted?: boolean;
  generation?: boolean;
  completionTried?: boolean;
  operation?: {
    id: string;
    handle: string;
    live: LiveDocument;
    stage: "prepared" | "intent" | "spent";
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
};
/** Authority is memory-only. Persisted intents become interrupted holds after restart. */
export function createSsoState() {
  const flows = new Map<number, SsoWork>();
  const native = new Map<number, SsoNativeChoice>();
  // Immutable run identities outlive parent cancellation until runtime disposal.
  const children = new Map<string, { parentId: string; account: LoginAccount }>();
  const interrupted = new Map<number, v.InferOutput<typeof journalSchema>>();
  let healthy = true;
  let queue = Promise.resolve();
  const loaded = storage.getItem(KEY).then(
    (raw) => {
      const parsed = v.safeParse(v.pipe(v.array(journalSchema), v.maxLength(100)), raw ?? []);
      if (!parsed.success) {
        healthy = false;
        return;
      }
      for (const record of parsed.output) interrupted.set(record.document.tabId, record);
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
      const active = [...flows.values()]
        .filter((work) => !work.ended)
        .map((work) => ({
          id: work.id,
          document: work.rpLive.document,
          account: work.account,
          idp: { ...work.selected.account, origin: work.selected.origin },
          method: work.source.method.number,
          sourceEvidence: work.source.sourceEvidence,
          phase: work.phase,
          ...(work.operation ? { operationId: work.operation.id } : {}),
        }));
      return storage.setItem(KEY, [...interrupted.values(), ...active]);
    });
    try {
      await queue;
    } catch (error) {
      healthy = false;
      throw error;
    }
  };
  return { flows, native, children, interrupted, loaded, write, healthy: () => healthy };
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
  state.children.set(metadata.id, { parentId: work.id, account: { ...metadata.account } });
  return true;
}
export const ssoChild = (state: SsoState, metadata: LoginAttemptMetadata) => {
  if (metadata.ssoChild?.attemptId === metadata.id) return true;
  const child = state.children.get(metadata.id);
  return (
    !!child &&
    child.account.origin === metadata.account.origin &&
    child.account.connectionId === metadata.account.connectionId &&
    child.account.itemId === metadata.account.itemId
  );
};
