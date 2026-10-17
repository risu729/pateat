// The toolbar icon, emitted beside the bundle as the favicon is.
import logo from "../../../apps/extension/icons/icon.svg?url";
import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { describeError, type ManageClient } from "./api";
import { SETTINGS_QUERY_KEY } from "./settings";
import { Button } from "./button";
import { DevicesPage } from "./devices";
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
  { path: "/manage/sites", title: "Sites", Page: SitesPage },
  { path: "/manage", title: "Devices", Page: DevicesPage },
] as const;

const linkClasses = "text-accent-ink underline hover:text-accent-hover";

export function ManageApp({ client, path }: { client: ManageClient; path: string }) {
  const queryClient = useQueryClient();
  const [selectedProfile, setSelectedProfile] = useState("");
  const [name, setName] = useState("");
  const profiles = useQuery({ queryKey: ["profiles"], queryFn: () => client.profiles() });
  const profileId =
    selectedProfile ||
    client.profileId ||
    (profiles.data?.profiles.length === 1 ? profiles.data.profiles[0]!.id : "");
  if (profileId) client.selectProfile(profileId);
  const copy = useMutation({
    mutationFn: () => client.copyProfile(name.trim(), profileId),
    onSuccess: async (profile) => {
      setName("");
      setSelectedProfile(profile.id);
      client.selectProfile(profile.id);
      await queryClient.invalidateQueries({ queryKey: ["profiles"] });
      await queryClient.invalidateQueries({ queryKey: SETTINGS_QUERY_KEY });
    },
  });
  const site = siteOrigin(path);
  const current = PAGES.find((page) => page.path === (site ? "/manage/sites" : path));
  const title = site ?? current?.title;
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
      {profiles.data && profiles.data.profiles.length > 0 && (
        <section aria-label="Settings profiles" className="flex flex-wrap items-end gap-3">
          <label>
            Editing profile
            <select
              aria-label="Editing profile"
              value={profileId}
              onChange={(event) => {
                setSelectedProfile(event.target.value);
                client.selectProfile(event.target.value);
                queryClient.removeQueries({ queryKey: SETTINGS_QUERY_KEY });
              }}
            >
              <option value="" disabled>
                Choose a profile
              </option>
              {profiles.data.profiles.map((profile) => (
                <option key={profile.id} value={profile.id}>
                  {profile.name}
                </option>
              ))}
            </select>
          </label>
          <form
            onSubmit={(event) => {
              event.preventDefault();
              copy.mutate();
            }}
          >
            <label>
              New profile name{" "}
              <input
                aria-label="New profile name"
                value={name}
                maxLength={64}
                onChange={(event) => setName(event.target.value)}
              />
            </label>
            <Button type="submit" disabled={!profileId || !name.trim() || copy.isPending}>
              Copy selected profile
            </Button>
          </form>
          {copy.isError && <p role="alert">{describeError(copy.error)}</p>}
        </section>
      )}
      <main key={profileId}>
        {(site || current?.path === "/manage/sites") && profiles.isPending ? (
          <output>Loading settings profiles…</output>
        ) : (site || current?.path === "/manage/sites") && profiles.isError ? (
          <p role="alert">{describeError(profiles.error)}</p>
        ) : (site || current?.path === "/manage/sites") && !profileId ? (
          <p>Choose a settings profile to edit.</p>
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
