import { newId } from "@pateat/contracts/ids";
import type { LoginAccount, LoginDocument, SettingsResponse } from "@pateat/contracts";
import type { SafeSsoMethod, SsoCandidate, SsoIdpChoice, SsoSourceRef } from "./sso-vault";
import type { SsoResponse } from "./sso-wire";

export type Saved = Extract<SettingsResponse, { ok: true }>;
/**
 * One vault item by its provider account, as synced settings name it (ADR 0023): the
 * same on every device, unlike the random per-device connection ID.
 */
export type SsoPortableAccount = {
  provider: string;
  server: string;
  userId: string;
  itemId: string;
};
type AccountRef = SsoIdpChoice["account"];
export type SsoChoiceInput = {
  /** The account is already chosen by the account chooser; methods never select an account. */
  document: LoginDocument;
  account: LoginAccount;
  /** Whether the tab is a private window, whose pausing the offer depends on. */
  incognito?: boolean;
  /**
   * The settings the coordinator chose the account and admitted the page under; a read of
   * the request's own that changes what it reads ends the request (`settings-changed`).
   */
  basis?: Saved;
  native: { passkey: boolean; password: boolean };
  /**
   * Explicit choices remain per offer; they never change a site or IdP default. `sso` is
   * **Log in now**'s: only an SSO method the automatic order decides runs by itself, and
   * the explicit chooser stays open otherwise (ADR 0088 amendment of 2026-11-18).
   */
  automatic?: boolean | "sso";
  /** For `automatic: "sso"`: whether the request's scope reaches the IdP's origin. */
  hopAllowed?: (origin: string) => Promise<boolean>;
  /** An IdP hop can use only that account's native routes; never another SSO hop. */
  asIdentityProvider?: boolean;
  /** URL-form entries come from a local observation, never from a guessed provider label. */
  entries?: { id: string; label: string }[];
  /**
   * The visible labels of the page's other observed entries, never pressed, as a link or
   * an entry its inspection refused: one that names the mapped IdP keeps the label rule
   * from pressing any entry (ADR 0085, amended 2026-11-18).
   */
  otherLabels?: string[];
  entryCurrent?: (entryId: string) => Promise<boolean>;
  /** A fresh explicit HTTP destination of the entry matches this selected origin; never a label guess. */
  entryOrigin?: (entryId: string, selectedOrigin: string) => Promise<boolean>;
  /**
   * A broker page's entry (ADR 0085 amendment of 2026-11-18): an SSO layout the site's
   * recipe holds for this page names it, a flow pressed it there and reached
   * `selectedOrigin`, and a fresh inspection finds it going nowhere but the page's own
   * origin. Only with a saved mapping, and only when no entry's own destination names
   * the mapped origin.
   */
  entryLearned?: (entryId: string, selectedOrigin: string) => Promise<boolean>;
  /**
   * A broker page's first visit (ADR 0085 amendment of 2026-11-18, owner): the entry whose
   * visible label names the mapped IdP goes nowhere but the page's own origin on a fresh
   * inspection, and no flow learned it for another IdP. Asked only when neither an entry's
   * own destination nor a learned entry decides, and only for the one entry named.
   */
  entryLabeled?: (entryId: string, selectedOrigin: string) => Promise<boolean>;
  signal?: AbortSignal;
};
export type SsoResolvedChoice =
  | { kind: "native"; route: "passkey" | "password" }
  | { kind: "sso"; source: SsoSourceRef; selected: SsoIdpChoice; label?: string; entryId?: string };
/**
 * How a method offer ended. An offer that waited for the person and ended unanswered
 * names, in `waited`, why the automatic order left it to them (`entry-required`,
 * `mapping-required`, `method-unavailable`), so its log line says why nothing was pressed.
 */
export type SsoChoiceOutcome =
  | { ok: true; choiceId: string }
  | { ok: false; reason: string; waited?: string };
export type Candidate = {
  id: string;
  selected: SsoIdpChoice;
  itemLabel: string;
  connectionLabel: string;
};
export type Method = SafeSsoMethod & {
  source: SsoSourceRef;
  candidates: Candidate[];
  selectedId?: string;
  /** Why the method cannot run now; only an SSO route of it is held back. */
  reason?: string;
  field?: string;
  /** Whether the person's choices were listed, not only the saved mapping. */
  discovered?: boolean;
  /** Whether the settings hold a mapping of this method, usable here or not. */
  stored?: true;
  /**
   * The one IdP item a URL-form method's discovery found, used without a saved mapping
   * (ADR 0085, amended 2026-11-18); never saved.
   */
  inferred?: true;
};
export type Offer = {
  id: string;
  input: SsoChoiceInput;
  saved: Saved;
  /** The site item's saved mappings the offer holds, as its own writes leave them. */
  mappings: string;
  /** The document's path when the offer was made; another path withdraws it. */
  path: string;
  field?: string;
  methods: Method[];
  reason?: string;
  choosing: boolean;
  settled?: boolean;
  ready?: boolean;
  expiresAt: number;
  done: (outcome: SsoChoiceOutcome) => void;
  releaseAbort: () => void;
};

export const connectionFor = (saved: Saved, account: AccountRef) =>
  saved.catalog.connections.find((entry) => entry.id === account.connectionId);
/** The account's portable identity, while its connection is open on a known account. */
export function portable(saved: Saved, account: AccountRef): SsoPortableAccount | undefined {
  const connection = connectionFor(saved, account);
  return connection?.snapshotId && connection.userId
    ? {
        provider: connection.provider,
        server: connection.server,
        userId: connection.userId,
        itemId: account.itemId,
      }
    : undefined;
}
/** A comparable key of the account's portable identity. */
export function identity(saved: Saved, account: AccountRef): string | undefined {
  const value = portable(saved, account);
  return value
    ? JSON.stringify([value.provider, value.server, value.userId, value.itemId.toLowerCase()])
    : undefined;
}
/** The first open connection that holds a portable account's item, resolved at use. */
export function resolveAccount(saved: Saved, account: SsoPortableAccount): AccountRef | undefined {
  for (const connection of saved.catalog.connections) {
    if (
      connection.provider !== account.provider ||
      connection.server !== account.server ||
      connection.userId !== account.userId ||
      !connection.snapshotId
    )
      continue;
    const item = connection.items.find(
      (entry) => entry.id.toLowerCase() === account.itemId.toLowerCase(),
    );
    if (item) return { connectionId: connection.id, itemId: item.id };
  }
  return undefined;
}
/** Why the site's own account or origin cannot be its IdP; undefined when it can be. */
export function hopRefusal(offer: Offer, choice: SsoIdpChoice): string | undefined {
  const site = identity(offer.saved, offer.input.account);
  const idp = identity(offer.saved, choice.account);
  if (!site || !idp) return "vault-unavailable";
  return choice.origin === offer.input.account.origin || site === idp ? "unsafe-hop" : undefined;
}
export function candidate(saved: Saved, selected: SsoIdpChoice): Candidate {
  const connection = connectionFor(saved, selected.account);
  const label = connection?.label ?? "-";
  return {
    id: newId(),
    selected,
    itemLabel:
      connection?.items.find((item) => item.id === selected.account.itemId)?.label ?? label,
    connectionLabel: label,
  };
}
/** Discovered candidates, never the site's own account or origin. */
export function candidates(offer: Offer, found: SsoCandidate[]): Candidate[] {
  const site = identity(offer.saved, offer.input.account);
  return found.flatMap((entry) =>
    entry.origins
      .filter(
        (origin) =>
          origin !== offer.input.account.origin && identity(offer.saved, entry.account) !== site,
      )
      .map((origin) => candidate(offer.saved, { account: entry.account, origin })),
  );
}
type ShownOffer = NonNullable<Extract<SsoResponse, { ok: true }>["offer"]>;
/** What the popup sees: opaque candidate IDs and labels, no item ID or source reference. */
export function shown(offer: Offer): ShownOffer {
  const connection = connectionFor(offer.saved, offer.input.account);
  return {
    id: offer.id,
    origin: offer.input.account.origin,
    accountLabel:
      connection?.items.find((item) => item.id === offer.input.account.itemId)?.label ??
      connection?.label ??
      "-",
    ...offer.input.native,
    methods: offer.methods.map(
      ({ source: _source, discovered: _discovered, stored, candidates: list, ...method }) => ({
        ...method,
        candidates: list.map(({ selected, ...entry }) => ({ ...entry, origin: selected.origin })),
        ...(stored ? { mapped: true as const } : {}),
      }),
    ),
    entries: offer.input.entries ?? [],
    ...(offer.input.document.frameId === 0 ? {} : { frame: true as const }),
    ...(offer.reason ? { reason: offer.reason } : {}),
    ...(offer.field ? { field: offer.field } : {}),
    ...(offer.settled ? { blocked: true as const } : {}),
  };
}
