import { newId } from "@pateat/contracts/ids";
import type { LoginAccount, LoginDocument, SettingsResponse } from "@pateat/contracts";
import type { SsoPortableAccount } from "./sso-mapping-store";
import type { SafeSsoMethod, SsoCandidate, SsoIdpChoice, SsoSourceRef } from "./sso-vault";
import type { SsoResponse } from "./sso-wire";

export type Saved = Extract<SettingsResponse, { ok: true }>;
type AccountRef = SsoIdpChoice["account"];
export type SsoChoiceInput = {
  /** The account is already chosen by the account chooser; methods never select an account. */
  document: LoginDocument;
  account: LoginAccount;
  native: { passkey: boolean; password: boolean };
  /** Explicit choices remain per offer; they never change a site or IdP default. */
  automatic?: boolean;
  /** An IdP hop can use only that account's native routes; never another SSO hop. */
  asIdentityProvider?: boolean;
  /** URL-form entries come from a local observation, never from a guessed provider label. */
  entries?: { id: string; label: string }[];
  entryCurrent?: (entryId: string) => Promise<boolean>;
  signal?: AbortSignal;
};
export type SsoResolvedChoice =
  | { kind: "native"; route: "passkey" | "password" }
  | { kind: "sso"; source: SsoSourceRef; selected: SsoIdpChoice; label?: string; entryId?: string };
export type SsoChoiceOutcome = { ok: true; choiceId: string } | { ok: false; reason: string };
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
};
export type Offer = {
  id: string;
  input: SsoChoiceInput;
  saved: Saved;
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

const connectionFor = (saved: Saved, account: AccountRef) =>
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
      ({ source: _source, discovered: _discovered, candidates: list, ...method }) => ({
        ...method,
        candidates: list.map(({ selected, ...entry }) => ({ ...entry, origin: selected.origin })),
      }),
    ),
    entries: offer.input.entries ?? [],
    ...(offer.input.document.frameId === 0 ? {} : { frame: true as const }),
    ...(offer.reason ? { reason: offer.reason } : {}),
    ...(offer.field ? { field: offer.field } : {}),
    ...(offer.settled ? { blocked: true as const } : {}),
  };
}
