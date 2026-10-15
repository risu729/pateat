import { normalizeHostname, parseSiteUrl, type LocalSettings } from "@pateat/contracts";
import { Check, Info, TriangleAlert } from "lucide-react";
import { useRef, useState } from "react";
import { Button } from "./button";
import { checkClass, controlClass, fieldClass, Panel, RowList, RowTitle, StatusLines } from "./ui";

type SiteRule = LocalSettings["excludedSites"][number];

/** The hostname an entered origin or hostname names, or undefined. */
export function enteredHostname(value: string): string | undefined {
  const entered = value.trim();
  const url = parseSiteUrl(entered);
  return url && url.origin === entered
    ? normalizeHostname(url.hostname)
    : normalizeHostname(entered);
}

function ruleName(rule: SiteRule): string {
  return rule.includeSubdomains ? `${rule.hostname} and subdomains` : rule.hostname;
}

/**
 * The allowlist: while it is on, Pateat runs only on the sites listed here, and the
 * exclusions under Sites still win. Turning it off removes the list.
 */
export function AllowedSites({
  draft,
  edit,
}: {
  draft: LocalSettings;
  edit: (update: (value: LocalSettings) => void) => boolean;
}) {
  const input = useRef<HTMLInputElement>(null);
  const [site, setSite] = useState("");
  const [includeSubdomains, setIncludeSubdomains] = useState(false);
  const [error, setError] = useState("");
  const rules = draft.allowedSites;
  function allow() {
    const hostname = enteredHostname(site);
    if (!hostname) {
      setError("Enter a site such as https://bank.example or bank.example.");
      input.current?.focus();
      return;
    }
    const added = edit((settings) => {
      settings.allowedSites = [
        ...(settings.allowedSites ?? []).filter((entry) => entry.hostname !== hostname),
        { hostname, includeSubdomains },
      ];
    });
    if (!added) return;
    setSite("");
    setIncludeSubdomains(false);
    setError("");
    input.current?.focus();
  }
  return (
    <Panel id="allowed-sites" headingId="allowed-sites-heading" title="Allowed sites">
      <label className={checkClass}>
        <input
          id="allowlist-on"
          type="checkbox"
          role="switch"
          checked={rules !== undefined}
          aria-checked={rules !== undefined}
          onChange={(event) => {
            const on = event.target.checked;
            edit((settings) => {
              if (on) settings.allowedSites = settings.allowedSites ?? [];
              else delete settings.allowedSites;
            });
          }}
        />
        Run only on allowed sites
      </label>
      {rules === undefined ? (
        <StatusLines
          muted
          lines={[
            {
              tone: "idle",
              icon: Info,
              text: "Pateat runs on every HTTPS site that is not excluded",
            },
          ]}
        />
      ) : (
        <>
          <RowList id="allowed-site-list">
            {rules.map((rule) => (
              <li
                key={rule.hostname}
                className="flex flex-wrap items-center justify-between gap-3 px-4 py-3"
              >
                <RowTitle>
                  <span>{ruleName(rule)}</span>
                </RowTitle>
                <Button
                  type="button"
                  variant="outline"
                  aria-label={`Remove ${ruleName(rule)} from the allowed sites`}
                  onClick={() => {
                    edit((settings) => {
                      settings.allowedSites = (settings.allowedSites ?? []).filter(
                        (entry) => entry.hostname !== rule.hostname,
                      );
                    });
                    input.current?.focus();
                  }}
                >
                  Remove
                </Button>
              </li>
            ))}
          </RowList>
          {!rules.length && (
            <StatusLines
              lines={[
                {
                  tone: "warn",
                  icon: TriangleAlert,
                  text: "No site is allowed, so Pateat logs in nowhere until you allow one",
                },
              ]}
            />
          )}
          <form
            className="flex flex-col gap-3"
            noValidate
            onSubmit={(event) => {
              event.preventDefault();
              allow();
            }}
          >
            <label className={fieldClass}>
              Site
              <input
                ref={input}
                id="allowed-site"
                className={controlClass}
                type="text"
                placeholder="bank.example"
                autoComplete="off"
                aria-describedby={error ? "allowed-site-error" : undefined}
                aria-invalid={Boolean(error)}
                value={site}
                onChange={(event) => {
                  setSite(event.target.value);
                  setError("");
                }}
              />
            </label>
            <label className={checkClass}>
              <input
                id="allowed-site-subdomains"
                type="checkbox"
                checked={includeSubdomains}
                onChange={(event) => setIncludeSubdomains(event.target.checked)}
              />
              Allow subdomains too
            </label>
            {error && (
              <p id="allowed-site-error" className="validation-error m-0" role="alert">
                {error}
              </p>
            )}
            <div className="flex flex-wrap gap-2">
              <Button id="add-allowed-site" type="submit" variant="outline">
                <Check aria-hidden size={16} strokeWidth={2} />
                Allow site
              </Button>
            </div>
          </form>
          <StatusLines
            muted
            lines={[
              { tone: "idle", icon: Info, text: "Exclusions under Sites win over allowed sites" },
              {
                tone: "idle",
                icon: Info,
                text: "Turning this off removes the list; the Pateat popup can allow the open site",
              },
            ]}
          />
        </>
      )}
    </Panel>
  );
}
