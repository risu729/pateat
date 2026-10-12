import { normalizeHostname, type LocalSettings } from "@pateat/contracts";
import { useId, useRef, useState, type FormEvent } from "react";
import { describeError, type ManageClient } from "./api";
import { Button } from "./button";
import { useSettings, useSettingsEdit, vaultAccountLabel } from "./settings";

type SiteDefault = LocalSettings["siteDefaults"][number];

function defaultItem(entry: SiteDefault): string {
  return entry.itemName || entry.itemId;
}

export function SitesPage({ client }: { client: ManageClient }) {
  const settings = useSettings(client);
  const edit = useSettingsEdit(client);
  const hostnameInput = useRef<HTMLInputElement>(null);
  const [hostname, setHostname] = useState("");
  const [includeSubdomains, setIncludeSubdomains] = useState(false);
  const [inputError, setInputError] = useState("");
  const ids = { hostname: useId(), subdomains: useId(), hostnameError: useId() };

  function addSite(event: FormEvent) {
    event.preventDefault();
    const normalized = normalizeHostname(hostname.trim());
    if (!normalized) {
      setInputError("Enter a hostname without a scheme, port or path.");
      hostnameInput.current?.focus();
      return;
    }
    const saved = settings.data?.settings?.excludedSites.find(
      (site) => site.hostname === normalized,
    );
    if (saved?.includeSubdomains === includeSubdomains) {
      setInputError(`${normalized} is already excluded.`);
      hostnameInput.current?.focus();
      return;
    }
    setInputError("");
    edit.mutate(
      {
        apply: (current) => ({
          ...current,
          excludedSites: [
            ...current.excludedSites.filter((site) => site.hostname !== normalized),
            { hostname: normalized, includeSubdomains },
          ],
        }),
        done: `Excluded ${normalized}.`,
      },
      {
        onSuccess: () => {
          setHostname("");
          setIncludeSubdomains(false);
        },
      },
    );
  }

  if (settings.isPending)
    return (
      <output id="settings-status" className="block">
        Loading settings…
      </output>
    );
  if (settings.isError)
    return (
      <p role="alert" id="settings-status" className="text-danger">
        {describeError(settings.error)}
      </p>
    );
  const current = settings.data.settings;
  const excludedSites = current?.excludedSites ?? [];
  const siteDefaults = current?.siteDefaults ?? [];

  return (
    <div className="space-y-8">
      <output id="settings-saved" className="block text-ink-muted">
        {edit.isSuccess && edit.variables.done}
      </output>
      {edit.isError && (
        <p role="alert" id="settings-error" className="text-danger">
          {describeError(edit.error)}
        </p>
      )}
      <section aria-labelledby="excluded-heading" className="space-y-4">
        <h2 id="excluded-heading" className="text-xl font-semibold">
          Excluded sites
        </h2>
        <p className="text-ink-muted">
          Pateat does not analyze, fill or submit anything on these sites, and does not answer
          passkey requests there. Devices apply a change on their next sync.
        </p>
        {excludedSites.length === 0 ? (
          <p>No sites are excluded.</p>
        ) : (
          <ul id="excluded-sites" className="divide-y divide-border">
            {excludedSites.map((site) => (
              <li key={site.hostname} className="flex items-center justify-between gap-4 py-2">
                <span>
                  {site.hostname}
                  {site.includeSubdomains && (
                    <span className="text-ink-muted"> and its subdomains</span>
                  )}
                </span>
                <Button
                  variant="outline"
                  aria-label={`Remove excluded site ${site.hostname}`}
                  disabled={edit.isPending}
                  onClick={() =>
                    edit.mutate({
                      apply: (value) => ({
                        ...value,
                        excludedSites: value.excludedSites.filter(
                          (entry) => entry.hostname !== site.hostname,
                        ),
                      }),
                      done: `Removed ${site.hostname} from the excluded sites.`,
                    })
                  }
                >
                  Remove
                </Button>
              </li>
            ))}
          </ul>
        )}
        <form noValidate onSubmit={addSite} className="flex flex-wrap items-end gap-4">
          <div className="flex flex-col gap-1">
            <label htmlFor={ids.hostname}>Hostname</label>
            <input
              ref={hostnameInput}
              id={ids.hostname}
              name="hostname"
              autoComplete="off"
              spellCheck={false}
              value={hostname}
              onChange={(event) => setHostname(event.target.value)}
              aria-invalid={inputError ? true : undefined}
              aria-describedby={inputError ? ids.hostnameError : undefined}
              className="min-h-10 rounded-lg border border-border-strong bg-surface px-3"
            />
          </div>
          <div className="flex min-h-10 items-center gap-2">
            <input
              id={ids.subdomains}
              type="checkbox"
              checked={includeSubdomains}
              onChange={(event) => setIncludeSubdomains(event.target.checked)}
            />
            <label htmlFor={ids.subdomains}>Include subdomains</label>
          </div>
          <Button type="submit" disabled={edit.isPending}>
            Exclude site
          </Button>
          {inputError && (
            <p role="alert" id={ids.hostnameError} className="w-full text-danger">
              {inputError}
            </p>
          )}
        </form>
      </section>

      <section aria-labelledby="defaults-heading" className="space-y-4">
        <h2 id="defaults-heading" className="text-xl font-semibold">
          Site default accounts
        </h2>
        <p className="text-ink-muted">
          The account a login uses on each exact origin. A login saves one automatically when only
          one vault item matches the site. Removing a default lets the next login choose again.
        </p>
        {siteDefaults.length === 0 ? (
          <p>No default accounts are saved.</p>
        ) : (
          <ul id="site-defaults" className="divide-y divide-border">
            {siteDefaults.map((entry) => (
              <li key={entry.origin} className="flex items-center justify-between gap-4 py-2">
                <span>
                  {entry.origin}: {defaultItem(entry)}{" "}
                  <span className="text-ink-muted">({vaultAccountLabel(entry)})</span>
                </span>
                <Button
                  variant="outline"
                  aria-label={`Remove default account for ${entry.origin}`}
                  disabled={edit.isPending}
                  onClick={() =>
                    edit.mutate({
                      apply: (value) => ({
                        ...value,
                        siteDefaults: value.siteDefaults.filter(
                          (saved) => saved.origin !== entry.origin,
                        ),
                      }),
                      done: `Removed the default account for ${entry.origin}.`,
                    })
                  }
                >
                  Remove
                </Button>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
