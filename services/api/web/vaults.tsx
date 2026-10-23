import type { LocalSettings } from "@pateat/contracts";
import { Vault } from "lucide-react";
import { describeError, type ManageClient } from "./api";
import { useSettings } from "./settings";
import {
  Badge,
  ErrorNotice,
  PAGE_TITLE_CLASSES,
  ROW_CLASSES,
  RowIcon,
  RowList,
  RowMain,
} from "./ui";

type AccountPolicy = LocalSettings["accountPolicies"][number];
type ItemPolicy = LocalSettings["itemPolicies"][number];
type ExcludedField = ItemPolicy["excludedFields"][number];
type Account = Pick<AccountPolicy, "provider" | "server" | "userId">;

const accountKey = (entry: Account) => JSON.stringify([entry.provider, entry.server, entry.userId]);

/** Where an account lives, as the owner set it up on a device. */
export function serverLabel(server: string): string {
  if (server === "cloud-us") return "Bitwarden cloud (US)";
  if (server === "cloud-eu") return "Bitwarden cloud (EU)";
  return server;
}

/** One excluded field as a device names it: a built-in ID, or a custom field by name. */
export function describeExcludedField(field: ExcludedField): string {
  if (typeof field === "string") return field;
  const name = field.custom === null ? "an unnamed custom field" : `custom field "${field.custom}"`;
  return field.position === undefined ? name : `${name} (${field.position} of ${field.count})`;
}

function itemSummary(item: ItemPolicy): string {
  const parts = [
    item.excluded && "excluded",
    item.selected && "selected",
    ...item.excludedFields.map((field) => `${describeExcludedField(field)} excluded`),
  ].filter(Boolean);
  return parts.join(", ");
}

/**
 * Which vault items Pateat uses, per provider account (ADR 0023). Devices edit these,
 * since only they have the item and field lists; this page only lists them.
 */
export function VaultsPage({ client }: { client: ManageClient }) {
  const settings = useSettings(client);
  return (
    <section aria-labelledby="vaults-heading" className="space-y-4">
      <h1 id="vaults-heading" className={PAGE_TITLE_CLASSES}>
        Vaults
      </h1>
      <p className="text-ink-muted">
        Which vault items Pateat uses, per vault account. Change them on a device's settings page.
      </p>
      {settings.isPending ? (
        <output id="vaults-status" className="block">
          Loading settings…
        </output>
      ) : settings.isError ? (
        <ErrorNotice id="vaults-status">{describeError(settings.error)}</ErrorNotice>
      ) : (
        <VaultList settings={settings.data.settings} />
      )}
    </section>
  );
}

function VaultList({ settings }: { settings: LocalSettings | null }) {
  const accounts = new Map<string, { account: Account; policy?: AccountPolicy }>();
  for (const policy of settings?.accountPolicies ?? [])
    accounts.set(accountKey(policy), { account: policy, policy });
  for (const entry of [...(settings?.itemPolicies ?? []), ...(settings?.customFieldReviews ?? [])])
    if (!accounts.has(accountKey(entry))) accounts.set(accountKey(entry), { account: entry });
  if (!accounts.size) return <p id="vaults-status">No vault settings are saved yet.</p>;
  return (
    <RowList id="vaults">
      {[...accounts.values()].map(({ account, policy }) => {
        const key = accountKey(account);
        const items = (settings?.itemPolicies ?? []).filter((entry) => accountKey(entry) === key);
        const reviewed = (settings?.customFieldReviews ?? []).filter(
          (entry) => accountKey(entry) === key,
        ).length;
        const selection = policy?.selection;
        return (
          <li key={key} className={ROW_CLASSES}>
            <RowIcon>
              <Vault aria-hidden size={16} />
            </RowIcon>
            <RowMain
              title={policy?.accountName ?? `${account.provider} account ${account.userId}`}
              sub={
                <>
                  {serverLabel(account.server)}.{" "}
                  {!selection
                    ? "No account settings."
                    : selection.mode === "all"
                      ? "All items except exclusions."
                      : selection.groups.length
                        ? `Selected groups: ${selection.groups.map((group) => group.name).join(", ")}.`
                        : "Selected items only."}
                  {reviewed > 0 &&
                    ` Custom fields reviewed for ${reviewed} item${reviewed === 1 ? "" : "s"}.`}
                  {items.length > 0 && (
                    <ul>
                      {items.map((item) => (
                        <li key={item.itemId}>
                          {item.itemName}: {itemSummary(item)}
                        </li>
                      ))}
                    </ul>
                  )}
                </>
              }
            />
            <Badge tone={policy?.enabled ? "accent" : "muted"}>
              {policy?.enabled ? "Used" : "Not used"}
            </Badge>
          </li>
        );
      })}
    </RowList>
  );
}
