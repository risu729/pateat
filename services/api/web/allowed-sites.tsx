import { normalizeHostname, type LocalSettings } from "@pateat/contracts";
import { Check, Info, TriangleAlert } from "lucide-react";
import { useId, useRef, useState, type FormEvent } from "react";
import { Button } from "./button";
import {
  addAllowedSite,
  exclusionLabel,
  removeAllowedSite,
  setAllowedSites,
  type SettingsEdit,
} from "./settings";
import { Line, Lines, Panel, ROW_CLASSES, RowList, RowMain } from "./ui";

/**
 * The profile's allowed sites (ADR 0077): while they are on, automatic login runs only on
 * the sites listed here and is paused on every other site, as an exclusion pauses it
 * (ADR 0062). Turning them off keeps the list.
 */
export function AllowedSites({
  settings,
  busy,
  change,
}: {
  settings: LocalSettings | null;
  busy: boolean;
  change: (next: SettingsEdit, onSuccess?: () => void) => void;
}) {
  const input = useRef<HTMLInputElement>(null);
  const [hostname, setHostname] = useState("");
  const [includeSubdomains, setIncludeSubdomains] = useState(false);
  const [inputError, setInputError] = useState("");
  const ids = {
    heading: useId(),
    on: useId(),
    hostname: useId(),
    subdomains: useId(),
    hostnameError: useId(),
  };
  const rules = settings?.allowedSites ?? [];
  const on = settings?.allowedSitesEnabled === true;

  function add(event: FormEvent) {
    event.preventDefault();
    const normalized = normalizeHostname(hostname.trim());
    if (!normalized) {
      setInputError("Enter a hostname without a scheme, port or path.");
      input.current?.focus();
      return;
    }
    const saved = rules.find((site) => site.hostname === normalized);
    if (saved?.includeSubdomains === includeSubdomains) {
      setInputError(`${normalized} is already an allowed site.`);
      input.current?.focus();
      return;
    }
    setInputError("");
    change(
      addAllowedSite(normalized, includeSubdomains, `${normalized} is now an allowed site`),
      () => {
        setHostname("");
        setIncludeSubdomains(false);
      },
    );
  }

  return (
    <Panel id={ids.heading} title="Allowed sites">
      <label className="inline-flex cursor-pointer items-center gap-2 text-sm has-disabled:cursor-default">
        <input
          id={ids.on}
          type="checkbox"
          // A checkbox exposes its own checked state to the switch role.
          // oxlint-disable-next-line jsx-a11y/role-has-required-aria-props
          role="switch"
          checked={on}
          disabled={busy}
          onChange={(event) => change(setAllowedSites(event.target.checked))}
          className="relative h-5 w-9 flex-none cursor-pointer appearance-none rounded-full bg-border-strong transition-colors after:absolute after:top-0.5 after:left-0.5 after:size-4 after:rounded-full after:bg-surface after:transition-[left] after:content-[''] checked:bg-accent checked:after:left-[18px] disabled:cursor-default disabled:opacity-50"
        />
        Log in automatically only on allowed sites
      </label>
      {rules.length > 0 && (
        <RowList id="allowed-sites">
          {rules.map((site) => (
            <li key={site.hostname} className={ROW_CLASSES}>
              <RowMain title={exclusionLabel(site)} />
              <Button
                variant="outline"
                aria-label={`Remove ${exclusionLabel(site)} from the allowed sites`}
                disabled={busy}
                onClick={() =>
                  change(
                    removeAllowedSite(
                      site.hostname,
                      `${exclusionLabel(site)} is no longer an allowed site`,
                    ),
                  )
                }
              >
                Remove
              </Button>
            </li>
          ))}
        </RowList>
      )}
      <Lines>
        {on ? (
          rules.length ? (
            <Line icon={<Info size={16} aria-hidden />}>Pateat runs only on these sites</Line>
          ) : (
            <Line icon={<TriangleAlert size={16} aria-hidden />}>
              No site is allowed, so automatic login is paused everywhere until you allow one
            </Line>
          )
        ) : (
          <Line icon={<Info size={16} aria-hidden />}>
            While this is off, Pateat runs on every site
          </Line>
        )}
      </Lines>
      <form noValidate onSubmit={add} className="flex flex-wrap items-end gap-x-4 gap-y-3">
        <div className="flex flex-[1_1_15rem] flex-col gap-1.5">
          <label htmlFor={ids.hostname} className="text-sm font-semibold">
            Hostname to allow
          </label>
          <input
            ref={input}
            id={ids.hostname}
            name="allowed-hostname"
            autoComplete="off"
            spellCheck={false}
            placeholder="bank.example"
            value={hostname}
            onChange={(event) => {
              setHostname(event.target.value);
              setInputError("");
            }}
            aria-invalid={inputError ? true : undefined}
            aria-describedby={inputError ? ids.hostnameError : undefined}
            className="min-h-10 rounded-lg border border-border-strong bg-surface px-3 placeholder:text-ink-muted"
          />
        </div>
        <div className="flex min-h-10 items-center gap-2.5">
          <input
            id={ids.subdomains}
            type="checkbox"
            checked={includeSubdomains}
            onChange={(event) => setIncludeSubdomains(event.target.checked)}
            className="size-[18px]"
          />
          <label htmlFor={ids.subdomains}>Allow subdomains too</label>
        </div>
        <Button type="submit" variant="outline" disabled={busy}>
          <Check size={16} aria-hidden />
          Allow site
        </Button>
        {inputError && (
          <p role="alert" id={ids.hostnameError} className="w-full text-danger">
            {inputError}
          </p>
        )}
      </form>
      <Lines>
        <Line icon={<Info size={16} aria-hidden />}>
          A site paused on the Sites list stays paused while it is allowed
        </Line>
      </Lines>
    </Panel>
  );
}
