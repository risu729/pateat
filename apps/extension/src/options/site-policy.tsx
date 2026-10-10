import {
  normalizeHostname,
  parseSiteUrl,
  resolveSiteAccount,
  siteDefaultConnection,
  type LocalSettings,
  type VaultCatalog,
} from "@pateat/contracts";
import { useForm } from "@tanstack/react-form";
import { useRef, useState } from "react";
import * as v from "valibot";
import { Button } from "./button";

const hostnameSchema = v.pipe(
  v.string(),
  v.check(
    (value) => Boolean(normalizeHostname(value.trim())),
    "Enter a hostname without a scheme, port or path.",
  ),
);
const originSchema = v.pipe(
  v.string(),
  v.check((value) => {
    const origin = value.trim();
    const url = parseSiteUrl(origin);
    return Boolean(url && url.origin === origin && normalizeHostname(url.hostname));
  }, "Enter an exact HTTP(S) origin without a path or trailing slash."),
);

function unavailableReason(reason: string): string {
  const descriptions: Record<string, string> = {
    "invalid-url": "The destination is invalid.",
    "site-excluded": "This site is excluded.",
    "default-not-set": "No default account is configured.",
    "item-origin-mismatch": "This account does not match the exact origin.",
    "connection-missing": "The vault connection is unavailable.",
    "account-ambiguous": "This vault account is connected more than once.",
    "vault-unavailable": "The vault is locked or unavailable.",
    "connection-disabled": "The vault connection is disabled.",
    "item-missing": "The account is unavailable.",
    "item-excluded": "This account is excluded.",
    "item-not-selected": "This account is outside the selected groups and items.",
    "fields-excluded": "All fields in this account are excluded.",
  };
  return descriptions[reason] ?? "This account is unavailable.";
}

export function SitePolicy({
  draft,
  catalog,
  edit,
}: {
  draft: LocalSettings;
  catalog: VaultCatalog;
  edit: (update: (value: LocalSettings) => void) => boolean;
}) {
  const hostnameInput = useRef<HTMLInputElement>(null);
  const originInput = useRef<HTMLInputElement>(null);
  const [siteError, setSiteError] = useState("");
  const [defaultError, setDefaultError] = useState("");
  const firstConnection = catalog.connections.find((connection) => connection.items.length);
  const firstItem = firstConnection?.items[0];
  const siteForm = useForm({
    defaultValues: { hostname: "", includeSubdomains: false },
    onSubmit: ({ value }) => {
      const validated = v.safeParse(hostnameSchema, value.hostname);
      if (!validated.success) {
        setSiteError(validated.issues[0].message);
        hostnameInput.current?.focus();
        return;
      }
      const hostname = normalizeHostname(validated.output.trim());
      if (!hostname) return;
      const added = edit((settings) => {
        settings.excludedSites = settings.excludedSites.filter(
          (entry) => entry.hostname !== hostname,
        );
        settings.excludedSites.push({ hostname, includeSubdomains: value.includeSubdomains });
      });
      if (!added) return;
      siteForm.reset();
      setSiteError("");
      hostnameInput.current?.focus();
    },
  });
  const defaultForm = useForm({
    defaultValues: {
      origin: "",
      account:
        firstConnection && firstItem ? JSON.stringify([firstConnection.id, firstItem.id]) : "",
    },
    onSubmit: ({ value }) => {
      const validated = v.safeParse(originSchema, value.origin);
      if (!validated.success) {
        setDefaultError(validated.issues[0].message);
        originInput.current?.focus();
        return;
      }
      const selected = catalog.connections
        .flatMap((connection) =>
          connection.items.map((item) => ({
            connectionId: connection.id,
            provider: connection.provider,
            userId: connection.userId,
            itemId: item.id,
            value: JSON.stringify([connection.id, item.id]),
          })),
        )
        .find((entry) => entry.value === value.account);
      const userId = selected?.userId;
      if (!selected || !userId) {
        setDefaultError("Choose an available default account.");
        originInput.current?.focus();
        return;
      }
      const origin = validated.output.trim();
      const nextDefault = { origin, provider: selected.provider, userId, itemId: selected.itemId };
      // A default names the account, so it must lead back to the chosen connection.
      const mapped = siteDefaultConnection(nextDefault, catalog);
      if (!mapped.ok || mapped.connectionId !== selected.connectionId) {
        setDefaultError(unavailableReason(mapped.ok ? "account-ambiguous" : mapped.reason));
        originInput.current?.focus();
        return;
      }
      const added = edit((settings) => {
        settings.siteDefaults = settings.siteDefaults.filter((entry) => entry.origin !== origin);
        settings.siteDefaults.push(nextDefault);
      });
      if (!added) return;
      defaultForm.setFieldValue("origin", "");
      setDefaultError("");
      originInput.current?.focus();
    },
  });

  return (
    <>
      <section aria-labelledby="sites-heading" className="panel">
        <h2 id="sites-heading">Excluded sites</h2>
        <p>
          Match a hostname exactly, or include its subdomains. Excluded sites are blocked by the
          local policy before any future login work.
        </p>
        <ul id="excluded-sites" className="saved-list">
          {!draft.excludedSites.length && <li>No excluded sites.</li>}
          {draft.excludedSites.map((site) => (
            <li key={site.hostname}>
              <span>
                {site.hostname} ·{" "}
                {site.includeSubdomains ? "Including subdomains" : "Exact hostname only"}
              </span>
              <Button
                type="button"
                variant="outline"
                aria-label={`Remove excluded site ${site.hostname}`}
                onClick={() => {
                  edit((settings) => {
                    settings.excludedSites = settings.excludedSites.filter(
                      (entry) => entry.hostname !== site.hostname,
                    );
                  });
                  hostnameInput.current?.focus();
                }}
              >
                Remove
              </Button>
            </li>
          ))}
        </ul>
        <form
          className="add-row"
          noValidate
          onSubmit={(event) => {
            event.preventDefault();
            void siteForm.handleSubmit();
          }}
        >
          <siteForm.Field name="hostname">
            {(field) => (
              <>
                <label htmlFor="site-hostname">Hostname</label>
                <input
                  ref={hostnameInput}
                  id="site-hostname"
                  type="text"
                  placeholder="bank.example"
                  autoComplete="off"
                  aria-describedby={`site-help${siteError ? " site-error" : ""}`}
                  aria-invalid={Boolean(siteError)}
                  value={field.state.value}
                  onBlur={field.handleBlur}
                  onChange={(event) => {
                    field.handleChange(event.target.value);
                    setSiteError("");
                  }}
                />
              </>
            )}
          </siteForm.Field>
          <siteForm.Field name="includeSubdomains">
            {(field) => (
              <label className="checkbox-row">
                <input
                  id="site-subdomains"
                  type="checkbox"
                  checked={field.state.value}
                  onChange={(event) => field.handleChange(event.target.checked)}
                />
                Include subdomains
              </label>
            )}
          </siteForm.Field>
          {siteError && (
            <p id="site-error" className="validation-error" role="alert">
              {siteError}
            </p>
          )}
          <Button id="add-site" type="submit">
            Add excluded site
          </Button>
        </form>
        <p id="site-help" className="note">
          Enter a hostname without a scheme, port or path. Add it to the draft, then save settings.
        </p>
      </section>
      <section aria-labelledby="defaults-heading" className="panel">
        <h2 id="defaults-heading">Site default accounts</h2>
        <p>
          Choose an account for an exact origin. A default applies to the next login; it does not
          log out or switch an existing session.
        </p>
        <ul id="site-defaults" className="saved-list">
          {!draft.siteDefaults.length && (
            <li>No site defaults. Account selection requires configuration.</li>
          )}
          {draft.siteDefaults.map((selected) => {
            const mapped = siteDefaultConnection(selected, catalog);
            const connection = mapped.ok
              ? catalog.connections.find((entry) => entry.id === mapped.connectionId)
              : undefined;
            const item = connection?.items.find((entry) => entry.id === selected.itemId);
            const resolved = resolveSiteAccount(draft, catalog, selected.origin);
            return (
              <li key={selected.origin}>
                <span>
                  {selected.origin} →{" "}
                  {connection?.label ??
                    ("connectionId" in selected
                      ? selected.connectionId
                      : `account ${selected.userId} (not available here)`)}{" "}
                  / {item?.label ?? selected.itemId}
                  <small>
                    {resolved.ok
                      ? "Available under this draft policy"
                      : `Unavailable under this draft policy: ${unavailableReason(resolved.reason)}`}
                  </small>
                </span>
                <Button
                  type="button"
                  variant="outline"
                  aria-label={`Remove site default ${selected.origin}`}
                  onClick={() => {
                    edit((settings) => {
                      settings.siteDefaults = settings.siteDefaults.filter(
                        (entry) => entry.origin !== selected.origin,
                      );
                    });
                    originInput.current?.focus();
                  }}
                >
                  Remove
                </Button>
              </li>
            );
          })}
        </ul>
        <form
          className="add-row"
          noValidate
          onSubmit={(event) => {
            event.preventDefault();
            void defaultForm.handleSubmit();
          }}
        >
          <defaultForm.Field name="origin">
            {(field) => (
              <>
                <label htmlFor="default-origin">Exact origin</label>
                <input
                  ref={originInput}
                  id="default-origin"
                  type="text"
                  placeholder="https://bank.example"
                  autoComplete="off"
                  aria-describedby={`default-help${defaultError ? " default-error" : ""}`}
                  aria-invalid={Boolean(defaultError)}
                  value={field.state.value}
                  onBlur={field.handleBlur}
                  onChange={(event) => {
                    field.handleChange(event.target.value);
                    setDefaultError("");
                  }}
                />
              </>
            )}
          </defaultForm.Field>
          <defaultForm.Field name="account">
            {(field) => (
              <>
                <label htmlFor="default-account">Default account</label>
                <select
                  id="default-account"
                  value={field.state.value}
                  onBlur={field.handleBlur}
                  onChange={(event) => field.handleChange(event.target.value)}
                >
                  {catalog.connections.map((connection) => (
                    <optgroup key={connection.id} label={connection.label}>
                      {connection.items.map((item) => (
                        <option key={item.id} value={JSON.stringify([connection.id, item.id])}>
                          {item.label}
                        </option>
                      ))}
                    </optgroup>
                  ))}
                </select>
              </>
            )}
          </defaultForm.Field>
          {defaultError && (
            <p id="default-error" className="validation-error" role="alert">
              {defaultError}
            </p>
          )}
          <Button id="add-default" type="submit">
            Set site default
          </Button>
        </form>
        <p id="default-help" className="note">
          Use an HTTP(S) origin without a path or trailing slash. The demo accounts match
          https://bank.example and, for the secondary account, https://mail.example. Setting an
          existing origin replaces only that draft default.
        </p>
      </section>
    </>
  );
}
