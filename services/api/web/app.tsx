import type { ManageClient } from "./api";
import { DevicesPage } from "./devices";

const revision = PATEAT_BUILD_REVISION;
const sourceUrl = `https://github.com/risu729/pateat/tree/${/^[0-9a-f]{40}$/.test(revision) ? revision : "main"}`;

/** Pages the app renders, by path; the Worker serves the app only at these paths. */
const PAGES = [{ path: "/manage", title: "Devices" }] as const;

export function ManageApp({ client, path }: { client: ManageClient; path: string }) {
  const current = PAGES.find((page) => page.path === path);
  return (
    <div className="mx-auto max-w-4xl space-y-6 p-4">
      <header className="space-y-2">
        <h1 className="text-2xl font-bold">Pateat</h1>
        <nav aria-label="Sections">
          <ul className="flex gap-4">
            {PAGES.map((page) => (
              <li key={page.path}>
                <a
                  href={page.path}
                  aria-current={page === current ? "page" : undefined}
                  className="text-teal-800 underline aria-[current=page]:font-semibold aria-[current=page]:no-underline"
                >
                  {page.title}
                </a>
              </li>
            ))}
          </ul>
        </nav>
      </header>
      <main>{current ? <DevicesPage client={client} /> : <p>No such page.</p>}</main>
      <footer className="border-t border-slate-200 pt-4 text-sm text-slate-600">
        Pateat {revision}. This page includes code licensed under the{" "}
        <a className="text-teal-800 underline" href="/manage/assets/LICENSE-GPL-3.0.txt">
          GPL-3.0-only
        </a>
        ;{" "}
        <a className="text-teal-800 underline" href={sourceUrl}>
          its source
        </a>{" "}
        and the{" "}
        <a className="text-teal-800 underline" href="/manage/assets/notices.md">
          third-party notices
        </a>{" "}
        are available.
      </footer>
    </div>
  );
}
