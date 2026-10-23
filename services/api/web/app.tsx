// The toolbar icon, emitted beside the bundle as the favicon is.
import logo from "../../../apps/extension/icons/icon.svg?url";
import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { describeError, type ManageClient } from "./api";
import { DashboardPage } from "./dashboard";
import { SETTINGS_QUERY_KEY } from "./settings";
import { DevicesPage } from "./devices";
import { ModelsPage } from "./models";
import { PROFILES_QUERY_KEY, ProfilesPage, storedProfile, storeProfile } from "./profiles";
import { RequestLogPage } from "./request-log";
import { SitePage } from "./site";
import { siteOrigin, SitesPage } from "./sites";
import { ThemeSelect } from "./theme-select";

const revision = PATEAT_BUILD_REVISION;
const isCommit = /^[0-9a-f]{40}$/.test(revision);
// The source offer and license text are the repository at the exact built commit.
const sourceRef = isCommit ? revision : "main";
const sourceUrl = `https://github.com/risu729/pateat/tree/${sourceRef}`;
const licenseUrl = `https://github.com/risu729/pateat/blob/${sourceRef}/LICENSE-GPL-3.0.txt`;

/**
 * The sections the app renders, by path; each site's page sits under Sites. The Worker
 * serves the app only at these paths.
 */
const PAGES = [
  { path: "/manage/dashboard", title: "Dashboard", Page: DashboardPage },
  { path: "/manage/sites", title: "Sites", Page: SitesPage },
  { path: "/manage/profiles", title: "Profiles", Page: ProfilesPage },
  { path: "/manage", title: "Devices", Page: DevicesPage },
  { path: "/manage/models", title: "Models", Page: ModelsPage },
  { path: "/manage/request-log", title: "Request log", Page: RequestLogPage },
] as const;

const linkClasses = "text-accent-ink underline hover:text-accent-hover";

export function ManageApp({ client, path }: { client: ManageClient; path: string }) {
  const queryClient = useQueryClient();
  const [chosen, setChosen] = useState(storedProfile);
  const site = siteOrigin(path);
  const current = PAGES.find((page) => page.path === (site ? "/manage/sites" : path));
  const title = site ?? current?.title;
  const editsSites = Boolean(site) || current?.path === "/manage/sites";
  const profiles = useQuery({
    queryKey: PROFILES_QUERY_KEY,
    queryFn: () => client.profiles(),
    enabled: editsSites,
  });
  const list = profiles.data?.profiles ?? [];
  // A choice of a deleted profile, or one from another account, is no choice.
  const profileId = !editsSites
    ? undefined
    : list.some((profile) => profile.id === chosen)
      ? chosen
      : list.length === 1
        ? list[0]!.id
        : undefined;
  if (profileId) client.selectProfile(profileId);
  return (
    <div className="mx-auto flex max-w-[880px] flex-col gap-6 px-4 pt-6 pb-12 text-[15px]/6 sm:px-6">
      <title>{title ? `${title} – Pateat` : "Pateat"}</title>
      <header className="flex flex-wrap items-center gap-4">
        <span className="flex items-center gap-2 font-bold">
          <img src={logo} alt="" width={20} height={20} />
          Pateat
        </span>
        <nav aria-label="Sections">
          <ul className="flex flex-wrap gap-1">
            {PAGES.map((page) => (
              <li key={page.path}>
                <a
                  href={page.path}
                  // A site's page is part of Sites without being that page.
                  aria-current={page === current ? (site ? "true" : "page") : undefined}
                  className="inline-flex min-h-10 items-center rounded-lg px-3.5 text-sm font-medium text-ink no-underline hover:bg-surface [&[aria-current]]:bg-surface [&[aria-current]]:font-semibold [&[aria-current]]:text-accent-ink [&[aria-current]]:shadow-[inset_0_0_0_1px_var(--border)]"
                >
                  {page.title}
                </a>
              </li>
            ))}
          </ul>
        </nav>
      </header>
      {editsSites && list.length > 1 && (
        <div className="flex flex-wrap items-center gap-x-3 gap-y-2 rounded-xl border border-border bg-surface px-4 py-3">
          <label htmlFor="settings-profile" className="text-sm font-semibold">
            Settings profile
          </label>
          <select
            id="settings-profile"
            aria-describedby="settings-profile-hint"
            className="min-h-10 rounded-lg border border-border-strong bg-surface px-3 text-sm text-ink"
            value={profileId ?? ""}
            onChange={(event) => {
              storeProfile(event.target.value);
              setChosen(event.target.value);
              client.selectProfile(event.target.value);
              queryClient.removeQueries({ queryKey: SETTINGS_QUERY_KEY });
            }}
          >
            <option value="" disabled>
              Choose a profile
            </option>
            {list.map((profile) => (
              <option key={profile.id} value={profile.id}>
                {profile.name}
              </option>
            ))}
          </select>
          <span id="settings-profile-hint" className="text-[13px]/5 text-ink-muted">
            Exclusions and saved accounts below belong to this profile; bindings are shared.{" "}
            <a className={linkClasses} href="/manage/profiles">
              Manage profiles
            </a>
          </span>
        </div>
      )}
      <main key={profileId}>
        {editsSites && profiles.isPending ? (
          <output>Loading settings profiles…</output>
        ) : editsSites && profiles.isError ? (
          <p role="alert">{describeError(profiles.error)}</p>
        ) : editsSites && list.length > 1 && !profileId ? (
          <p>Choose the settings profile to edit.</p>
        ) : site ? (
          <SitePage client={client} origin={site} />
        ) : current ? (
          <current.Page client={client} />
        ) : (
          <p>No such page.</p>
        )}
      </main>
      <footer className="flex flex-wrap items-center gap-x-4 gap-y-2 border-t border-border pt-4 text-[13px]/5 text-ink-muted">
        {/* The bundle includes GPL-3.0-only code: its source and license at the built commit. */}
        <span className="font-mono">Pateat {isCommit ? revision.slice(0, 7) : revision}</span>
        <a className={linkClasses} href={sourceUrl}>
          Source
        </a>
        <a className={linkClasses} href={licenseUrl}>
          GPL-3.0-only
        </a>
        <a className={linkClasses} href="/manage/assets/notices.md">
          Third-party notices
        </a>
        <span className="ml-auto">
          <ThemeSelect />
        </span>
      </footer>
    </div>
  );
}
