import * as v from "valibot";
import {
  type LoginAttemptMetadata,
  type LoginOperation,
  type LoginRecipe,
  loginDocumentSchema,
} from "@pateat/contracts";
import { storage } from "wxt/utils/storage";
import type { LiveDocument } from "./types";
import type { Runtime } from "./state";

const KEY = "session:pateat.confirm-fills.v1" as const;
const proofSchema = v.strictObject({
  id: v.string(),
  tabId: v.number(),
  origin: v.string(),
  connectionId: v.string(),
  itemId: v.string(),
});
const claimSchema = v.strictObject({
  key: v.string(),
  tabId: v.number(),
  document: loginDocumentSchema,
});
const schema = v.strictObject({
  proofs: v.pipe(v.array(proofSchema), v.maxLength(100)),
  claims: v.pipe(v.array(claimSchema), v.maxLength(512)),
});
type Proof = v.InferOutput<typeof proofSchema>;
type Claim = v.InferOutput<typeof claimSchema>;
export type ConfirmWork = {
  live: LiveDocument;
  parent: LoginAttemptMetadata;
  topDocumentId: string | undefined;
  policyRevision?: number;
  snapshotId?: string;
  scopeMark?: string;
  reprompted?: true;
  operation?: LoginOperation;
  recipe?: LoginRecipe;
  cancelled: boolean;
  generation: boolean;
};

/** Session evidence outlives the worker, never a browser restart. No values are stored. */
export function createConfirmState() {
  const state = {
    proofs: [] as Proof[],
    claims: [] as Claim[],
    work: new Map<number, ConfirmWork>(),
    healthy: true,
    queue: Promise.resolve(),
    loaded: Promise.resolve(),
  };
  state.loaded = storage
    .getItem(KEY)
    .then((value) => {
      if (value === null || value === undefined) return undefined;
      const parsed = v.safeParse(schema, value);
      if (!parsed.success) {
        state.healthy = false;
        return undefined;
      }
      state.proofs = parsed.output.proofs;
      state.claims = parsed.output.claims;
      return undefined;
    })
    .catch(() => {
      state.healthy = false;
    });
  return state;
}

async function write(rt: Runtime): Promise<void> {
  const state = rt.confirmFill;
  state.queue = state.queue.then(async () => {
    if (!state.healthy) throw new Error("confirmation-storage-failed");
    await storage.setItem(KEY, { proofs: state.proofs, claims: state.claims });
    return undefined;
  });
  try {
    await state.queue;
  } catch {
    state.healthy = false;
    throw new Error("confirmation-storage-failed");
  }
}

/** Called only at a newly confirmed authentication, after its local journal write. */
export async function rememberConfirmAuthentication(rt: Runtime, metadata: LoginAttemptMetadata) {
  await rt.confirmFill.loaded;
  if (
    !rt.confirmFill.healthy ||
    metadata.state !== "authenticated" ||
    metadata.unconfirmed ||
    metadata.fillOnly ||
    metadata.signInFill
  )
    return;
  const { proofs } = rt.confirmFill;
  const found = proofs.find((entry) => entry.id === metadata.id);
  if (found) return;
  rt.confirmFill.proofs = proofs.filter(
    (entry) => entry.tabId !== metadata.document.tabId || entry.origin !== metadata.account.origin,
  );
  if (rt.confirmFill.proofs.length >= 100) return;
  rt.confirmFill.proofs.push({
    id: metadata.id,
    tabId: metadata.document.tabId,
    origin: metadata.account.origin,
    connectionId: metadata.account.connectionId,
    itemId: metadata.account.itemId,
  });
  await write(rt);
}

export function hasConfirmAuthentication(rt: Runtime, metadata: LoginAttemptMetadata): boolean {
  return (
    rt.confirmFill.healthy &&
    metadata.state === "authenticated" &&
    !metadata.unconfirmed &&
    !metadata.fillOnly &&
    !metadata.signInFill &&
    rt.confirmFill.proofs.some(
      (entry) =>
        entry.id === metadata.id &&
        entry.tabId === metadata.document.tabId &&
        entry.origin === metadata.account.origin &&
        entry.connectionId === metadata.account.connectionId &&
        entry.itemId === metadata.account.itemId,
    )
  );
}

/** One automatic classification attempt per authenticated document and path. */
export const confirmationGenerationKey = (parent: LoginAttemptMetadata, live: LiveDocument) =>
  JSON.stringify(["generation", parent.id, live.document, live.path]);

export const hasConfirmClaim = (rt: Runtime, key: string): boolean =>
  rt.confirmFill.claims.some((entry) => entry.key === key);

/** Claim before any read/delivery; an unknown acknowledgement is never replayed. */
export async function claimConfirm(rt: Runtime, work: ConfirmWork, key: string): Promise<boolean> {
  const state = rt.confirmFill;
  if (
    !state.healthy ||
    state.claims.some((entry) => entry.key === key) ||
    state.claims.length >= 512
  )
    return false;
  state.claims.push({ key, tabId: work.live.document.tabId, document: work.live.document });
  await write(rt);
  return !work.cancelled && state.work.get(work.live.document.tabId) === work;
}

export function confirmBusy(rt: Runtime, tabId?: number): boolean {
  return tabId === undefined ? rt.confirmFill.work.size > 0 : rt.confirmFill.work.has(tabId);
}

export function cancelConfirm(rt: Runtime, tabId?: number): void {
  for (const [id, work] of rt.confirmFill.work) {
    if (tabId !== undefined && id !== tabId) continue;
    work.cancelled = true;
    rt.confirmFill.work.delete(id);
  }
}

export function forgetConfirmTab(rt: Runtime, tabId: number): void {
  cancelConfirm(rt, tabId);
  void rt.confirmFill.loaded
    .then(async () => {
      rt.confirmFill.proofs = rt.confirmFill.proofs.filter((entry) => entry.tabId !== tabId);
      rt.confirmFill.claims = rt.confirmFill.claims.filter((entry) => entry.tabId !== tabId);
      await write(rt);
      return undefined;
    })
    .catch(() => undefined);
}
