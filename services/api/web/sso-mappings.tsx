import { ssoMappingKey, type LocalSettings, type SsoMapping } from "@pateat/contracts";
import { useState } from "react";
import { Button } from "./button";
import { describeError, type ManageClient } from "./api";
import { serverLabel, useSettingsEdit, type SettingsEdit } from "./settings";
import { Badge, ErrorNotice, Panel, ROW_CLASSES, RowList, RowMain, SuccessNotice } from "./ui";

type Account = Pick<SsoMapping, "provider" | "server" | "userId">;
const accountKey = (entry: Account) => JSON.stringify([entry.provider, entry.server, entry.userId]);

/** A vault account as the settings name it: its saved label, else the provider account ID. */
function accountLabel(settings: LocalSettings, account: Account): string {
  const policy = settings.accountPolicies.find(
    (entry) => accountKey(entry) === accountKey(account),
  );
  return policy?.accountName ?? `${account.provider} account ${account.userId}`;
}

/** Removes one site item's method mapping, matched as the extension matches it. */
function removeMapping(mapping: SsoMapping): SettingsEdit {
  const key = ssoMappingKey(mapping);
  return {
    apply: (value) => ({
      ...value,
      ssoMappings: (value.ssoMappings ?? []).filter((entry) => ssoMappingKey(entry) !== key),
    }),
    done: `Mapping of method ${mapping.method} to ${mapping.idp.origin} removed`,
  };
}

/**
 * Which identity provider account each site item's SSO method uses (ADR 0085). They are
 * shared by every profile and hold item IDs only, so they are listed by ID. A mapping of
 * an account no device has any more is never resolved; its row says so, and Remove is
 * the only way to drop it, as nothing prunes mappings without a vault to compare.
 */
export function SsoMappings({
  client,
  settings,
}: {
  client: ManageClient;
  settings: LocalSettings | null;
}) {
  const edit = useSettingsEdit(client);
  const [notice, setNotice] = useState("");
  const mappings = settings?.ssoMappings ?? [];
  return (
    <Panel id="sso-mappings-heading" title="SSO mappings">
      <p className="text-ink-muted">
        A device saves one when you choose an identity provider account for a sign-in method.
        Removing one makes devices ask again.
      </p>
      <SuccessNotice id="sso-mappings-saved" message={notice} />
      {edit.isError && (
        <ErrorNotice id="sso-mappings-error">{describeError(edit.error)}</ErrorNotice>
      )}
      {!settings || mappings.length === 0 ? (
        <p>No SSO mappings</p>
      ) : (
        <RowList id="sso-mappings">
          {mappings.map((mapping) => {
            const known = settings.accountPolicies.some(
              (entry) => accountKey(entry) === accountKey(mapping),
            );
            return (
              <li key={ssoMappingKey(mapping)} className={ROW_CLASSES}>
                <RowMain
                  title={`Method ${mapping.method} of item ${mapping.itemId}`}
                  sub={
                    <>
                      In {accountLabel(settings, mapping)} ({serverLabel(mapping.server)}). Signs in
                      at <bdi>{mapping.idp.origin}</bdi> with item {mapping.idp.itemId} in{" "}
                      {accountLabel(settings, mapping.idp)}.
                    </>
                  }
                />
                {!known && <Badge tone="muted">No vault settings for this account</Badge>}
                <Button
                  variant="danger"
                  aria-label={`Remove mapping of method ${mapping.method} of item ${mapping.itemId}`}
                  disabled={edit.isPending}
                  onClick={() => {
                    const change = removeMapping(mapping);
                    setNotice("");
                    edit.mutate(change, { onSuccess: () => setNotice(change.done) });
                  }}
                >
                  Remove
                </Button>
              </li>
            );
          })}
        </RowList>
      )}
    </Panel>
  );
}
