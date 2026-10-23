import { normalizeHostname, parseSiteUrl } from "@pateat/contracts";
import { Ban, ChevronRight, RefreshCw, User } from "lucide-react";
import { useId, useRef, useState, type FormEvent } from "react";
import { describeError, type ManageClient } from "./api";
import { Button } from "./button";
import { isActive, RevokedRecipes, UnreadableRecipes, useRecipes } from "./recipes";
import { AllowedSites } from "./allowed-sites";
import {
  defaultAccountLabel,
  exclusionLabel,
  exclusionsCovering,
  excludeSite,
  notAllowed,
  removeExclusion,
  siteHostname,
  useSettings,
  useSettingsEdit,
  type SettingsEdit,
} from "./settings";
import {
  Badge,
  ErrorNotice,
  Line,
  Lines,
  PAGE_TITLE_CLASSES,
  ROW_CLASSES,
  RowList,
  RowMain,
  SuccessNotice,
} from "./ui";

/**
 * A site's page: `/manage/sites/<scheme>/<host>`, for the exact origin that site
 * defaults, recipes and bindings are keyed by.
 */
export function sitePath(origin: string): string {
  const url = new URL(origin);
  return `/manage/sites/${url.protocol.slice(0, -1)}/${url.host}`;
}

/** The exact HTTP(S) origin a site page is for, if the path names one. */
export function siteOrigin(path: string): string | undefined {
  const match = /^\/manage\/sites\/(https?)\/([^/]+)$/.exec(path);
  if (!match) return undefined;
  const origin = `${match[1]}://${match[2]}`;
  const url = parseSiteUrl(origin);
  return url?.origin === origin && normalizeHostname(url.hostname) ? origin : undefined;
}

const count = (n: number, noun: string) => `${n} ${noun}${n === 1 ? "" : "s"}`;

/**
 * Every site the service holds something for: an origin with recipes, a default account
 * or bindings, each opening its own page, and the excluded hostnames.
 */
export function SitesPage({ client }: { client: ManageClient }) {
  const settings = useSettings(client);
  const recipes = useRecipes(client);
  const edit = useSettingsEdit(client);
  const [notice, setNotice] = useState("");
  const hostnameInput = useRef<HTMLInputElement>(null);
  const [hostname, setHostname] = useState("");
  const [includeSubdomains, setIncludeSubdomains] = useState(false);
  const [inputError, setInputError] = useState("");
  const ids = { hostname: useId(), subdomains: useId(), hostnameError: useId() };

  function change(next: SettingsEdit, onSuccess?: () => void) {
    setNotice("");
    edit.mutate(next, {
      onSuccess: () => {
        setNotice(next.done);
        onSuccess?.();
      },
    });
  }

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
    change(excludeSite(normalized, includeSubdomains), () => {
      setHostname("");
      setIncludeSubdomains(false);
    });
  }

  if (settings.isPending || recipes.isPending)
    return (
      <output id="settings-status" className="block">
        Loading sites…
      </output>
    );
  const current = settings.data?.settings ?? null;
  const active = (recipes.data?.recipes ?? []).filter(isActive);
  const origins = [
    ...new Set([
      ...active.map((entry) => entry.change.recipe.origin),
      ...(current?.siteDefaults ?? []).map((entry) => entry.origin),
      ...(current?.bindings ?? []).map((entry) => entry.origin),
    ]),
  ].toSorted();
  const recipesByOrigin = Map.groupBy(active, (entry) => entry.change.recipe.origin);
  const bindingsByOrigin = Map.groupBy(current?.bindings ?? [], (entry) => entry.origin);
  const excludedSites = current?.excludedSites ?? [];

  return (
    <div className="space-y-4">
      <h1 className={PAGE_TITLE_CLASSES}>Sites</h1>
      <SuccessNotice id="settings-saved" message={notice} />
      {edit.isError && <ErrorNotice id="settings-error">{describeError(edit.error)}</ErrorNotice>}
      {settings.isError && (
        <ErrorNotice id="settings-status">{describeError(settings.error)}</ErrorNotice>
      )}
      {/* A signed-out or unpaired owner fails both reads alike; that is said once. */}
      {recipes.isError &&
        !(settings.isError && describeError(settings.error) === describeError(recipes.error)) && (
          <ErrorNotice id="recipes-status">{describeError(recipes.error)}</ErrorNotice>
        )}
      {!settings.data && !recipes.data ? null : origins.length === 0 &&
        excludedSites.length === 0 ? (
        <p>No sites yet</p>
      ) : (
        <RowList id="sites">
          {origins.map((origin) => {
            const recipeCount = recipesByOrigin.get(origin)?.length ?? 0;
            const siteDefault = current?.siteDefaults.find((entry) => entry.origin === origin);
            const bindingCount = bindingsByOrigin.get(origin)?.length ?? 0;
            const excluded = exclusionsCovering(current, siteHostname(origin)).length > 0;
            const leftOut = !excluded && notAllowed(current, siteHostname(origin));
            return (
              // The whole row opens the site; the link is its only control.
              <li key={origin} className={`relative ${ROW_CLASSES} hover:bg-surface-sunken`}>
                <RowMain
                  title={
                    <a
                      href={sitePath(origin)}
                      className="text-ink no-underline after:absolute after:inset-0 after:content-['']"
                    >
                      {origin}
                    </a>
                  }
                  sub={
                    <span className="mt-1 flex flex-wrap gap-1.5">
                      {recipeCount > 0 && (
                        <Badge tone="muted">{count(recipeCount, "recipe")}</Badge>
                      )}
                      {siteDefault && (
                        <Badge>
                          <User size={12} aria-hidden />
                          {defaultAccountLabel(siteDefault)}
                        </Badge>
                      )}
                      {bindingCount > 0 && (
                        <Badge tone="muted">{count(bindingCount, "binding")}</Badge>
                      )}
                      {excluded && (
                        <Badge tone="muted">
                          <Ban size={12} aria-hidden />
                          Excluded
                        </Badge>
                      )}
                      {leftOut && (
                        <Badge tone="muted">
                          <Ban size={12} aria-hidden />
                          Not allowed
                        </Badge>
                      )}
                    </span>
                  }
                />
                <ChevronRight size={16} aria-hidden className="text-ink-muted" />
              </li>
            );
          })}
          {excludedSites.map((site) => (
            <li key={site.hostname} className={ROW_CLASSES}>
              <RowMain
                title={exclusionLabel(site)}
                sub={
                  <span className="mt-1 flex flex-wrap gap-1.5">
                    <Badge tone="muted">
                      <Ban size={12} aria-hidden />
                      Excluded
                    </Badge>
                  </span>
                }
              />
              <Button
                variant="outline"
                aria-label={`Remove exclusion for ${exclusionLabel(site)}`}
                disabled={edit.isPending}
                onClick={() =>
                  change(
                    removeExclusion(site.hostname, `${exclusionLabel(site)} is no longer excluded`),
                  )
                }
              >
                Remove exclusion
              </Button>
            </li>
          ))}
        </RowList>
      )}
      {settings.data && (
        <form noValidate onSubmit={addSite} className="flex flex-wrap items-end gap-x-4 gap-y-3">
          <div className="flex flex-[1_1_15rem] flex-col gap-1.5">
            <label htmlFor={ids.hostname} className="text-sm font-semibold">
              Hostname
            </label>
            <input
              ref={hostnameInput}
              id={ids.hostname}
              name="hostname"
              autoComplete="off"
              spellCheck={false}
              placeholder="example.com"
              value={hostname}
              onChange={(event) => setHostname(event.target.value)}
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
            <label htmlFor={ids.subdomains}>Include subdomains</label>
          </div>
          <Button type="submit" variant="outline" disabled={edit.isPending}>
            Exclude site
          </Button>
          {inputError && (
            <p role="alert" id={ids.hostnameError} className="w-full text-danger">
              {inputError}
            </p>
          )}
        </form>
      )}
      {settings.data && <AllowedSites settings={current} busy={edit.isPending} change={change} />}
      {recipes.data && (
        <div className="space-y-8 pt-4">
          <UnreadableRecipes client={client} announce={setNotice} />
          <RevokedRecipes recipes={recipes.data.recipes} />
        </div>
      )}
      <Lines>
        <Line icon={<RefreshCw size={16} aria-hidden />}>
          Devices apply a change on their next sync
        </Line>
      </Lines>
    </div>
  );
}
