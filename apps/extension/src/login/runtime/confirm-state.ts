import * as v from "valibot";
import {
  type LoginAttemptMetadata,
  type LoginOperation,
  type LoginRecipe,
  loginDocumentSchema,
  sameLoginDocument,
} from "@pateat/contracts";
import { storage } from "wxt/utils/storage";
import type { ConfirmVisit, LiveDocument } from "./types";
import type { Runtime } from "./state";
import type { ConfirmPick } from "./confirm-pick-scope";

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
  /** The tab's top document when it was claimed; a new top document drops the claim. */
  top: v.optional(v.string()),
});
const schema = v.strictObject({
  proofs: v.pipe(v.array(proofSchema), v.maxLength(100)),
  claims: v.pipe(v.array(claimSchema), v.maxLength(512)),
});
type Proof = v.InferOutput<typeof proofSchema>;
type Claim = v.InferOutput<typeof claimSchema>;
/** One tab never holds more claims than this, so it cannot use up every other tab's. */
export const TAB_CLAIMS = 64;
/** Closed master password windows remembered for one tab's pages it no longer shows. */
export const DECLINED_KEPT = 16;
/** How a document's confirmation fill on a path ended, for the popup (ADR 0038). */
export type ConfirmOutcome = "confirm-filled" | "confirm-fill-kept" | "confirm-fill-stopped";
/** Whose account a confirmation fill uses, as its log entries name it, never the account. */
export type ConfirmAccountSource = "login" | "pick";
/**
 * A master password the confirmation's own window accepted for `attemptId connectionId`:
 * it fills the document once, on the path and with the recipe it was asked for, before it
 * expires (ADR 0035 delivery 3).
 */
export type ConfirmGrant = { grant: string; path: string; recipeId: string; expires: number };
export type ConfirmWork = {
  live: LiveDocument;
  /** Whose fill this is: the tab's confirmed login's ID, or the person's popup press's. */
  id: string;
  /** The account that fills: the confirmed login's, or the one the person chose. */
  account: { origin: string; connectionId: string; itemId: string };
  /** The tab's confirmed login whose account fills automatically (ADR 0035 delivery 3). */
  parent?: LoginAttemptMetadata;
  /** The person's **Fill** press in the popup, in place of `parent` (amended 2026-11-17). */
  pick?: ConfirmPick;
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
    /** Each tab's latest **Fill** press from the popup, in memory only. */
    picks: new Map<number, ConfirmPick>(),
    /**
     * `tabId documentId` to how its fill on `path` ended, in memory only; `declined` when
     * the person closed its master password window.
     */
    outcomes: new Map<
      string,
      {
        path: string;
        reason: ConfirmOutcome;
        declined?: true;
        accountSource?: ConfirmAccountSource;
        /** The visit the fill ended in, whose rows alone log this end. */
        visit?: ConfirmVisit;
      }
    >(),
    /** `tabId documentId` to the grant its window left for the document's next announcement. */
    verified: new Map<string, ConfirmGrant>(),
    /** The announcement that took its document's grant, for its own fill only. */
    granted: new WeakMap<LiveDocument, ConfirmGrant>(),
    /** Documents whose confirmation waits for its master password window to answer. */
    asking: new Set<string>(),
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

/**
 * One classification attempt per authenticated document and path, or per **Fill** press:
 * `id` is the login's or the press's.
 */
export const confirmationGenerationKey = (id: string, live: LiveDocument) =>
  JSON.stringify(["generation", id, live.document, live.path]);

export const hasConfirmClaim = (rt: Runtime, key: string): boolean =>
  rt.confirmFill.claims.some((entry) => entry.key === key);

/**
 * The generation claim of a **Fill** press (amended 2026-11-17): one per document and
 * path, whichever press sent it. Kept in the session store with the other claims, it also
 * holds that document from starting a login on that path, across a worker restart. A
 * generation the service gave no answer to drops it (`releaseConfirmClaim`).
 */
export const pressGenerationKey = (live: LiveDocument) => confirmationGenerationKey("pick", live);

const PRESS_PREFIX = '["generation","pick",';

/** Drops the press holds of `live`'s document on the paths it left. */
export function releasePressHolds(rt: Runtime, live: LiveDocument): void {
  const left = (key: string) => {
    if (!key.startsWith(PRESS_PREFIX)) return false;
    try {
      const [, , document, path] = JSON.parse(key) as [string, string, unknown, string];
      const parsed = v.safeParse(loginDocumentSchema, document);
      return (
        parsed.success && sameLoginDocument(parsed.output, live.document) && path !== live.path
      );
    } catch {
      return false;
    }
  };
  if (!rt.confirmFill.claims.some((entry) => left(entry.key))) return;
  update(rt, (state) => {
    const before = state.claims.length;
    state.claims = state.claims.filter((entry) => !left(entry.key));
    return state.claims.length !== before;
  });
}

/**
 * Drops the claim `key`: a press's generation that got no answer from the service leaves
 * no claim, so it holds nothing and a later press may send the page again.
 */
export async function releaseConfirmClaim(rt: Runtime, key: string): Promise<void> {
  const state = rt.confirmFill;
  const before = state.claims.length;
  state.claims = state.claims.filter((entry) => entry.key !== key);
  if (state.claims.length !== before) await write(rt);
}

/** Claim before any read/delivery; an unknown acknowledgement is never replayed. */
export async function claimConfirm(rt: Runtime, work: ConfirmWork, key: string): Promise<boolean> {
  const state = rt.confirmFill;
  const { tabId, frameId, documentId } = work.live.document;
  if (
    !state.healthy ||
    state.claims.some((entry) => entry.key === key) ||
    state.claims.length >= 512 ||
    state.claims.filter((entry) => entry.tabId === tabId).length >= TAB_CLAIMS
  )
    return false;
  const top = frameId === 0 ? documentId : work.topDocumentId;
  state.claims.push({
    key,
    tabId,
    document: work.live.document,
    ...(top === undefined ? {} : { top }),
  });
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

/** A tab that closed or was replaced takes its **Fill** press with it. */
function dropPick(rt: Runtime, tabId: number): void {
  const pick = rt.confirmFill.picks.get(tabId);
  if (!pick) return;
  clearTimeout(pick.timer);
  pick.active = false;
  rt.confirmFill.picks.delete(tabId);
}

/** Runs `change` once the session state is read, and writes it only when it changed. */
function update(rt: Runtime, change: (state: { proofs: Proof[]; claims: Claim[] }) => boolean) {
  void rt.confirmFill.loaded
    .then(async () => {
      if (change(rt.confirmFill)) await write(rt);
      return undefined;
    })
    .catch(() => undefined);
}

/**
 * Drops what is kept in memory of documents `keep` refuses. With `declined`, the closed
 * windows of the latest `DECLINED_KEPT` of them stay, so a page brought back from the
 * back/forward cache does not open its window again; older ones go first.
 */
const dropDocuments = (rt: Runtime, keep: (key: string) => boolean, declined = false) => {
  const { outcomes, verified } = rt.confirmFill;
  // Map order is insertion order, and a settled outcome is inserted anew: oldest first.
  const gone = [...outcomes].filter(([key]) => !keep(key));
  const kept = declined ? gone.filter(([, outcome]) => outcome.declined).slice(-DECLINED_KEPT) : [];
  for (const [key] of gone) if (!kept.some(([other]) => other === key)) outcomes.delete(key);
  for (const key of verified.keys()) if (!keep(key)) verified.delete(key);
};

export function forgetConfirmTab(rt: Runtime, tabId: number): void {
  cancelConfirm(rt, tabId);
  dropPick(rt, tabId);
  dropDocuments(rt, (key) => !key.startsWith(`${tabId} `));
  update(rt, (state) => {
    const proofs = state.proofs.filter((entry) => entry.tabId !== tabId);
    const claims = state.claims.filter((entry) => entry.tabId !== tabId);
    if (proofs.length === state.proofs.length && claims.length === state.claims.length)
      return false;
    state.proofs = proofs;
    state.claims = claims;
    return true;
  });
}

/**
 * The tab shows the top document `documentId`: claims of the documents it left, its old
 * page's and that page's frames', are dropped, so a long-lived tab does not keep them until
 * it closes. A document the tab still shows keeps its claims, as a frame that announced
 * before its page's top document did. A document brought back from the back/forward cache
 * still keeps the inputs it was filled into from another fill (`claimFill`), and its filled
 * values from being replaced, but its page may be filled again.
 */
export function leaveConfirmDocuments(rt: Runtime, tabId: number, documentId: string): void {
  const shown = new Set(
    [...rt.documents.values()].map((live) => `${live.document.tabId} ${live.document.documentId}`),
  );
  // A page brought back from the back/forward cache does not open a window closed on it,
  // for the tab's latest such pages.
  dropDocuments(
    rt,
    (key) => !key.startsWith(`${tabId} `) || key === `${tabId} ${documentId}` || shown.has(key),
    true,
  );
  update(rt, (state) => {
    let changed = false;
    state.claims = state.claims.flatMap((entry) => {
      const kept = shown.has(`${entry.tabId} ${entry.document.documentId}`);
      if (entry.tabId !== tabId || entry.top === documentId || (kept && entry.top)) return [entry];
      changed = true;
      // A frame claimed before its page's top document announced belongs to that page.
      return kept ? [{ ...entry, top: documentId }] : [];
    });
    return changed;
  });
}

/**
 * Each announcement of a document takes the grant its master password window left for it,
 * which only an announcement on the path the window was asked for may use, before it
 * expires; any other announcement drops it. A window the person closed on a path leaves
 * the page to them until the document announces another path.
 */
export function enterConfirmPath(rt: Runtime, live: LiveDocument): void {
  const state = rt.confirmFill;
  const key = `${live.document.tabId} ${live.document.documentId}`;
  const grant = state.verified.get(key);
  state.verified.delete(key);
  if (grant && grant.path === live.path && Date.now() < grant.expires)
    state.granted.set(live, grant);
  const outcome = state.outcomes.get(key);
  if (outcome?.declined && outcome.path !== live.path) state.outcomes.delete(key);
}

/** The tab's login record of the origin was released (ADR 0062): so is its proof. */
export function forgetConfirmProof(rt: Runtime, tabId: number, origin: string): void {
  update(rt, (state) => {
    const proofs = state.proofs.filter((entry) => entry.tabId !== tabId || entry.origin !== origin);
    if (proofs.length === state.proofs.length) return false;
    state.proofs = proofs;
    return true;
  });
}

/**
 * Chrome replaced tab `removed` with `added` (`tabs.onReplaced`): the proofs move with the
 * login records, which move to the new tab too. The gone page's claims and outcomes go with
 * its documents.
 */
export function moveConfirmTab(rt: Runtime, removed: number, added: number): void {
  cancelConfirm(rt, removed);
  dropPick(rt, removed);
  dropDocuments(rt, (key) => !key.startsWith(`${removed} `));
  update(rt, (state) => {
    if (!state.proofs.some((entry) => entry.tabId === removed)) return false;
    const moved = new Set(
      state.proofs.flatMap((entry) => (entry.tabId === removed ? [entry.origin] : [])),
    );
    state.proofs = state.proofs
      .filter((entry) => entry.tabId !== added || !moved.has(entry.origin))
      .map((entry) => (entry.tabId === removed ? { ...entry, tabId: added } : entry));
    state.claims = state.claims.filter((entry) => entry.tabId !== removed);
    return true;
  });
}
