import { useEffect } from "react";
// The toolbar icon, emitted beside the bundle as the favicon is.
import logo from "../../../apps/extension/icons/icon.svg?url";
import type { ManageClient } from "./api";
import { DevicesPage } from "./devices";
import { SitePage } from "./site";
import { siteOrigin, SitesPage } from "./sites";
import { ThemeSelect } from "./theme-select";
import { VaultsPage } from "./vaults";

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
  { path: "/manage/vaults", title: "Vaults", Page: VaultsPage },
  { path: "/manage", title: "Devices", Page: DevicesPage },
] as const;

const linkClasses = "text-accent-ink underline hover:text-accent-hover";

export function ManageApp({ client, path }: { client: ManageClient; path: string }) {
  const site = siteOrigin(path);
  const current = PAGES.find((page) => page.path === (site ? "/manage/sites" : path));
  const title = site ?? current?.title;
  useEffect(() => {
    document.title = title ? `${title} – Pateat` : "Pateat";
  }, [title]);
  return (
    <div className="mx-auto flex max-w-[880px] flex-col gap-6 px-4 pt-6 pb-12 text-[15px]/6 sm:px-6">
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
      <main>
        {site ? (
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
