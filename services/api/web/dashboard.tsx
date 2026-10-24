import type {
  ManageDashboard,
  ManageDashboardFailure,
  ManageDashboardRange,
  ManageDurations,
} from "@pateat/contracts";
import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { ChevronRight } from "lucide-react";
import { lazy, Suspense, useState, type ReactNode } from "react";
import { describeError, type ManageClient } from "./api";
import {
  LOGIN_PART_CONFIG,
  LOGIN_PARTS,
  PART_CONFIG,
  PARTS,
  ROLE_CONFIG,
  formatMs,
} from "./dashboard-series";
import { formatTime } from "./devices";
import { siteOrigin, sitePath } from "./sites";
import { Badge, ErrorNotice, KeyValues, PAGE_TITLE_CLASSES, Panel, RowList } from "./ui";

export const DASHBOARD_QUERY_KEY = ["dashboard"] as const;

// Recharts loads only with this page.
const BreakdownChart = lazy(() =>
  import("./dashboard-charts").then((module) => ({ default: module.BreakdownChart })),
);
const TrendChart = lazy(() =>
  import("./dashboard-charts").then((module) => ({ default: module.TrendChart })),
);
const LoginBreakdownChart = lazy(() =>
  import("./dashboard-charts").then((module) => ({ default: module.LoginBreakdownChart })),
);
const LoginTrendChart = lazy(() =>
  import("./dashboard-charts").then((module) => ({ default: module.LoginTrendChart })),
);

const RANGES: [ManageDashboardRange, string][] = [
  ["24h", "24 hours"],
  ["7d", "7 days"],
  ["30d", "30 days"],
];
const ROLE_LABELS = { generate: "Generate", judge: "Judge", logout: "Logout" } as const;

const plural = (n: number, noun: string) =>
  `${n.toLocaleString("en")} ${noun}${n === 1 ? "" : "s"}`;
const dollars = (microUsd: number) => `$${(microUsd / 1_000_000).toFixed(2)}`;
const optionalMs = (milliseconds: number | null | undefined) =>
  milliseconds === null || milliseconds === undefined ? "–" : formatMs(milliseconds);
/** A median with how many values it is of. */
const p50 = (durations: ManageDurations) =>
  durations.p50 === null ? "–" : `${formatMs(durations.p50)} · n ${durations.n}`;
const percent = (part: number, whole: number) => `${Math.round((part / whole) * 100)}%`;

/** A median with its count, and the p90 or, below 20 values, the values themselves. */
function DurationsLine({
  durations,
  empty = "No timed requests",
}: {
  durations: ManageDurations;
  empty?: string;
}) {
  if (durations.p50 === null) return <span className="text-ink-muted">{empty}</span>;
  return (
    <span>
      p50 {formatMs(durations.p50)}
      {durations.p90 !== undefined && <> · p90 {formatMs(durations.p90)}</>} · n {durations.n}
      {durations.values && durations.values.length > 1 && (
        <span className="block text-[13px]/5 text-ink-muted">
          Values: {durations.values.map(formatMs).join(", ")}
        </span>
      )}
    </span>
  );
}

/** A link to the site's page when the origin has one. */
function SiteLink({ origin }: { origin: string }) {
  let path: string | undefined;
  try {
    path = sitePath(origin);
  } catch {
    path = undefined;
  }
  return path && siteOrigin(path) === origin ? (
    <a
      className="text-accent-ink underline hover:text-accent-hover [overflow-wrap:anywhere]"
      href={path}
    >
      {origin}
    </a>
  ) : (
    <span className="[overflow-wrap:anywhere]">{origin}</span>
  );
}

/** A table with a caption; `visuallyHidden` for one that repeats a chart for screen readers. */
function Table({
  caption,
  head,
  rows,
  visuallyHidden = false,
}: {
  caption: string;
  head: string[];
  rows: { key: string; cells: ReactNode[] }[];
  visuallyHidden?: boolean;
}) {
  return (
    <div className={visuallyHidden ? "sr-only" : "overflow-x-auto"}>
      <table className="w-full border-collapse text-left text-sm">
        <caption className="pb-2 text-left text-[13px]/5 text-ink-muted">{caption}</caption>
        <thead>
          <tr>
            {head.map((label, index) => (
              <th
                key={label}
                scope="col"
                className={`border-b border-border py-2 pr-3 font-semibold text-ink-muted ${index ? "text-right" : ""}`}
              >
                {label}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row.key} className="border-b border-border last:border-b-0">
              {row.cells.map((cell, index) => (
                <td
                  key={head[index]}
                  className={`py-2 pr-3 align-top ${index ? "text-right font-mono text-[13px]/5 whitespace-nowrap" : ""}`}
                >
                  {cell}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function SubHeading({ children }: { children: ReactNode }) {
  return <h3 className="text-base/6 font-semibold">{children}</h3>;
}

function ChartFallback({ className }: { className: string }) {
  return <div aria-hidden className={`${className} rounded-lg bg-surface-sunken`} />;
}

const LOGIN_GROUPS = [
  ["withService", "Waited on the service"],
  ["recipeOnly", "Recipe only"],
] as const;

/**
 * Login speed from the login records devices send (ADR 0055): a signed-in login's time
 * less the person's, for logins that waited on the service and the rest.
 */
function LoginSpeed({ data }: { data: ManageDashboard }) {
  const { logins } = data;
  const timed = logins.withService.n + logins.recipeOnly.n;
  const withParts = LOGIN_GROUPS.filter(([key]) => logins.parts[key].n > 0);
  const timedDays = data.daily.some((day) => day.loginP50 !== null);
  return (
    <>
      <SubHeading>Logins</SubHeading>
      <p className="text-sm text-ink-muted">
        A login&apos;s time runs from when Pateat saw its first page until it ended, less the time
        it waited for the person, such as for a code. Only logins that signed in are timed.
      </p>
      {timed ? (
        <p className="text-sm">
          {logins.withService.n} of {plural(timed, "signed-in login")} (
          {percent(logins.withService.n, timed)}) waited on the service.
        </p>
      ) : null}
      <div className="grid gap-3 sm:grid-cols-2">
        {LOGIN_GROUPS.map(([key, label]) => (
          <section
            key={key}
            aria-labelledby={`dashboard-login-${key}`}
            className="space-y-2 rounded-lg border border-border bg-surface-sunken p-4"
          >
            <h3 id={`dashboard-login-${key}`} className="text-sm font-semibold text-ink-muted">
              {label} · login time
            </h3>
            <p className="text-[1.75rem]/9 font-bold tabular-nums">
              {logins[key].p50 === null ? "–" : formatMs(logins[key].p50)}
            </p>
            <p className="text-sm">
              <DurationsLine durations={logins[key]} empty="No signed-in logins" />
            </p>
            <KeyValues
              entries={[["Person's time p50, apart", optionalMs(logins.parts[key].personMs)]]}
            />
          </section>
        ))}
      </div>

      <SubHeading>Where a login&apos;s time goes</SubHeading>
      <p className="text-sm text-ink-muted">
        The median of each part over signed-in logins. Waiting for the site runs from a step that
        may change the page until the login read the page&apos;s answer. The network counts only
        answers that named the service&apos;s own time. The person&apos;s time is not part of the
        login time and is shown apart. Medians of parts do not add up exactly to the median total.
      </p>
      {withParts.length ? (
        <>
          <Suspense fallback={<ChartFallback className="h-44" />}>
            <LoginBreakdownChart parts={logins.parts} />
          </Suspense>
          <Table
            caption="Median login time by part"
            head={[
              "Logins",
              ...LOGIN_PARTS.map((part) => LOGIN_PART_CONFIG[part].label),
              "Person, apart",
              "n",
            ]}
            rows={withParts.map(([key, label]) => ({
              key,
              cells: [
                label,
                ...LOGIN_PARTS.map((part) => optionalMs(logins.parts[key][part])),
                optionalMs(logins.parts[key].personMs),
                logins.parts[key].n,
              ],
            }))}
          />
        </>
      ) : (
        <p className="text-sm">No login in this range signed in.</p>
      )}

      <SubHeading>Login time by day</SubHeading>
      {timedDays ? (
        <>
          <Suspense fallback={<ChartFallback className="h-56" />}>
            <LoginTrendChart daily={data.daily} />
          </Suspense>
          <Table
            visuallyHidden
            caption="Median login time by UTC day; a dash is a day without a signed-in login"
            head={["Day", "Login time p50", "Logins", "Signed in"]}
            rows={data.daily.map((day) => ({
              key: day.day,
              cells: [day.day, optionalMs(day.loginP50), day.logins, day.authenticatedLogins],
            }))}
          />
        </>
      ) : (
        <p className="text-sm">No login in this range signed in.</p>
      )}

      <SubHeading>Logins by site</SubHeading>
      {logins.perSite.length ? (
        <Table
          caption="Logins per site, slowest median login time first"
          head={["Site", "Logins", "Signed in", "Login p50"]}
          rows={logins.perSite.map((site) => ({
            key: site.origin,
            cells: [
              <SiteLink key="site" origin={site.origin} />,
              site.logins,
              site.signedIn,
              p50(site.loginMs),
            ],
          }))}
        />
      ) : (
        <p className="text-sm">No logins in this range.</p>
      )}

      <SubHeading>Logins by extension build</SubHeading>
      {logins.perBuild.length ? (
        <Table
          caption="Logins per extension build, most recently used first"
          head={["Build", "Last used", "Logins", "Login p50"]}
          rows={logins.perBuild.map((build) => ({
            key: build.build,
            cells: [
              <span key="build" className="font-mono text-[13px]/5">
                {build.build === "development" ? build.build : build.build.slice(0, 7)}
              </span>,
              formatTime(build.lastAt),
              build.logins,
              p50(build.loginMs),
            ],
          }))}
        />
      ) : (
        <p className="text-sm">No logins in this range.</p>
      )}
    </>
  );
}

function Speed({ data }: { data: ManageDashboard }) {
  const withParts = data.llm.filter((role) => role.parts.n > 0);
  const timedDays = data.daily.some(
    (day) => day.generateModelP50 !== null || day.judgeModelP50 !== null,
  );
  return (
    <Panel id="dashboard-speed" title="Speed">
      <LoginSpeed data={data} />

      <SubHeading>Requests to Claude</SubHeading>
      <div className="grid gap-3 sm:grid-cols-2">
        {data.llm.map((role) => (
          <section
            key={role.role}
            aria-labelledby={`dashboard-llm-${role.role}`}
            className="space-y-2 rounded-lg border border-border bg-surface-sunken p-4"
          >
            <h3 id={`dashboard-llm-${role.role}`} className="text-sm font-semibold text-ink-muted">
              {ROLE_LABELS[role.role]} · model time
            </h3>
            <p className="text-[1.75rem]/9 font-bold tabular-nums">
              {role.modelMs.p50 === null ? "–" : formatMs(role.modelMs.p50)}
            </p>
            <p className="text-sm">
              <DurationsLine durations={role.modelMs} />
            </p>
            <KeyValues
              entries={[
                ["Model calls", role.calls.toLocaleString("en")],
                ["Token exchange p50", p50(role.tokenMs)],
                ["Before the model p50", p50(role.preModelMs)],
                ["Server p50", p50(role.serverMs)],
                [
                  "Tokens in / out",
                  `${role.inputTokens.toLocaleString("en")} / ${role.outputTokens.toLocaleString("en")}`,
                ],
              ]}
            />
          </section>
        ))}
      </div>

      <SubHeading>Where the server time goes</SubHeading>
      <p className="text-sm text-ink-muted">
        The median of each part, over requests with all four times recorded. Medians of parts do not
        add up exactly to the median total.
      </p>
      {withParts.length ? (
        <>
          <Suspense fallback={<ChartFallback className="h-44" />}>
            <BreakdownChart llm={withParts} />
          </Suspense>
          <Table
            caption="Median server time by part"
            head={["Role", ...PARTS.map((part) => PART_CONFIG[part].label), "n"]}
            rows={withParts.map((role) => ({
              key: role.role,
              cells: [
                ROLE_LABELS[role.role],
                ...PARTS.map((part) => optionalMs(role.parts[part])),
                role.parts.n,
              ],
            }))}
          />
        </>
      ) : (
        <p className="text-sm">No request in this range has all four times recorded.</p>
      )}

      <SubHeading>Model time by day</SubHeading>
      {timedDays ? (
        <>
          <Suspense fallback={<ChartFallback className="h-56" />}>
            <TrendChart daily={data.daily} />
          </Suspense>
          <Table
            visuallyHidden
            caption="Median model time by UTC day; a dash is a day without requests"
            head={[
              "Day",
              `${ROLE_CONFIG.generateModelP50.label} p50`,
              "Generate requests",
              `${ROLE_CONFIG.judgeModelP50.label} p50`,
              "Judge requests",
            ]}
            rows={data.daily.map((day) => ({
              key: day.day,
              cells: [
                day.day,
                optionalMs(day.generateModelP50),
                day.generateRequests,
                optionalMs(day.judgeModelP50),
                day.judgeRequests,
              ],
            }))}
          />
        </>
      ) : (
        <p className="text-sm">No model time was recorded in this range.</p>
      )}

      <SubHeading>Requests by site</SubHeading>
      {data.perSite.length ? (
        <Table
          caption="Requests per site, slowest median server time first"
          head={["Site", "Requests", "Server p50", "Model p50"]}
          rows={data.perSite.map((site) => ({
            key: site.origin,
            cells: [
              <SiteLink key="site" origin={site.origin} />,
              site.requests,
              p50(site.serverMs),
              p50(site.modelMs),
            ],
          }))}
        />
      ) : (
        <p className="text-sm">No requests with a model call in this range.</p>
      )}

      <SubHeading>Requests by service build</SubHeading>
      {data.perBuild.length ? (
        <Table
          caption="Requests per service build, most recently used first"
          head={["Build", "Last used", "Requests", "Model p50", "Server p50"]}
          rows={data.perBuild.map((build) => ({
            key: build.build ?? "",
            cells: [
              <span key="build" className="font-mono text-[13px]/5">
                {build.build === null ? "Not recorded" : build.build.slice(0, 7)}
              </span>,
              formatTime(build.lastAt),
              build.requests,
              p50(build.modelMs),
              p50(build.serverMs),
            ],
          }))}
        />
      ) : (
        <p className="text-sm">No requests with a model call in this range.</p>
      )}

      <SubHeading>Slowest requests</SubHeading>
      {data.slowest.length ? (
        <Table
          caption="The 10 requests with the longest server time"
          head={["Site", "Time", "Role", "Outcome", "Token", "Model", "Server"]}
          rows={data.slowest.map((request, index) => ({
            key: `${request.at}-${index}`,
            cells: [
              <SiteLink key="site" origin={request.origin} />,
              formatTime(request.at),
              ROLE_LABELS[request.role],
              request.outcome,
              optionalMs(request.tokenMs),
              optionalMs(request.modelMs),
              formatMs(request.serverMs),
            ],
          }))}
        />
      ) : (
        <p className="text-sm">No server time was recorded in this range.</p>
      )}
    </Panel>
  );
}

/** Result codes and how many logins ended with each. */
function OutcomeTable({
  caption,
  rows,
}: {
  caption: string;
  rows: ManageDashboard["stats"]["logins"];
}) {
  return (
    <Table
      caption={caption}
      head={["Result", "Logins"]}
      rows={rows.map((row) => ({
        key: row.outcome,
        cells: [
          <span key="outcome" className="font-mono text-[13px]/5">
            {row.outcome}
          </span>,
          row.count,
        ],
      }))}
    />
  );
}

function Stats({ data }: { data: ManageDashboard }) {
  const { stats } = data;
  const loginTotal = stats.logins.reduce((sum, row) => sum + row.count, 0);
  const firstTotal = stats.firstLogins.reduce((sum, row) => sum + row.count, 0);
  return (
    <Panel id="dashboard-stats" title="Stats">
      <KeyValues
        entries={[
          [
            "Spend today (UTC)",
            `${dollars(stats.spend.dayMicroUsd)} of ${dollars(stats.spend.dailyLimitMicroUsd)}`,
          ],
          [
            "Spend this month (UTC)",
            `${dollars(stats.spend.monthMicroUsd)} of ${dollars(stats.spend.monthlyLimitMicroUsd)}`,
          ],
          [
            "Tokens in / out",
            `${stats.inputTokens.toLocaleString("en")} / ${stats.outputTokens.toLocaleString("en")}`,
          ],
          ["Active recipes", stats.activeRecipes.toLocaleString("en")],
          ["Recipes generated in this range", stats.recipesGenerated.toLocaleString("en")],
        ]}
      />
      <SubHeading>Logins</SubHeading>
      <p className="text-sm text-ink-muted">
        Every login with a recipe that ended, signed in or blocked, as devices report it.
      </p>
      {stats.logins.length ? (
        <>
          <KeyValues
            entries={[
              [
                "Signed in",
                `${stats.loginsAuthenticated} of ${loginTotal} (${percent(stats.loginsAuthenticated, loginTotal)})`,
              ],
            ]}
          />
          <OutcomeTable caption="How logins ended" rows={stats.logins} />
          <Table
            caption="Logins by UTC day; days without one are left out"
            head={["Day", "Logins", "Signed in"]}
            rows={data.daily
              .filter((day) => day.logins > 0)
              .map((day) => ({
                key: day.day,
                cells: [day.day, day.logins, day.authenticatedLogins],
              }))}
          />
        </>
      ) : (
        <p className="text-sm">No logins in this range.</p>
      )}
      <SubHeading>Requests</SubHeading>
      {stats.requests.length ? (
        <Table
          caption="Requests by role and outcome"
          head={["Outcome", "Role", "Requests"]}
          rows={stats.requests.map((row) => ({
            key: `${row.role}-${row.outcome}`,
            cells: [
              <span key="outcome" className="font-mono text-[13px]/5">
                {row.outcome}
              </span>,
              ROLE_LABELS[row.role],
              row.count,
            ],
          }))}
        />
      ) : (
        <p className="text-sm">No requests in this range.</p>
      )}
      <SubHeading>First login with each recipe version</SubHeading>
      <p className="text-sm text-ink-muted">
        The result code kept for evaluating generation: only the first login with each recipe
        version, so these are not every login.
      </p>
      {stats.firstLogins.length ? (
        <>
          <KeyValues
            entries={[
              [
                "Signed in",
                `${stats.firstLoginsAuthenticated} of ${firstTotal} (${percent(stats.firstLoginsAuthenticated, firstTotal)})`,
              ],
            ]}
          />
          <OutcomeTable
            caption="How the first login with each recipe version ended"
            rows={stats.firstLogins}
          />
        </>
      ) : (
        <p className="text-sm">No first-login results in this range.</p>
      )}
    </Panel>
  );
}

function FailureGroups({ groups, empty }: { groups: ManageDashboardFailure[]; empty: string }) {
  if (!groups.length) return <p className="text-sm">{empty}</p>;
  return (
    <RowList>
      {groups.map((group) => (
        <li key={`${group.kind}-${group.code}`}>
          <details className="group">
            <summary className="flex cursor-pointer list-none flex-wrap items-center gap-x-3 gap-y-1 px-4 py-3 [&::-webkit-details-marker]:hidden">
              <ChevronRight
                size={16}
                aria-hidden
                className="flex-none text-ink-muted transition-transform group-open:rotate-90"
              />
              <span className="font-mono text-[13px]/5 font-semibold">{group.code}</span>
              <Badge tone="muted">{group.kind === "login" ? "Login" : "Request"}</Badge>
              <span className="text-sm">{plural(group.count, "time")}</span>
              <span className="text-[13px]/5 text-ink-muted">
                last {formatTime(group.lastAt)}, {group.lastOrigin}
              </span>
            </summary>
            <div className="border-t border-border px-4 py-3">
              <Table
                caption={`The latest ${plural(group.latest.length, "time")} ${group.code} came`}
                head={[
                  "Site",
                  "Time",
                  "Recipe",
                  "Revision",
                  group.kind === "login" ? "Cause" : "Role",
                ]}
                rows={group.latest.map((event, index) => ({
                  key: `${event.at}-${index}`,
                  cells: [
                    <SiteLink key="site" origin={event.origin} />,
                    formatTime(event.at),
                    event.recipeId ?? "–",
                    event.revision ?? "–",
                    group.kind === "login"
                      ? (event.cause ?? "–")
                      : event.role
                        ? ROLE_LABELS[event.role]
                        : "–",
                  ],
                }))}
              />
            </div>
          </details>
        </li>
      ))}
    </RowList>
  );
}

function Failures({ data }: { data: ManageDashboard }) {
  return (
    <Panel id="dashboard-failures" title="Failures">
      <p className="text-sm text-ink-muted">
        Requests that did not end <code className="font-mono">ok</code> and logins that did not end{" "}
        <code className="font-mono">authenticated</code>, by result code. Open a row for its latest
        20.
      </p>
      <FailureGroups groups={data.failures} empty="No failures in this range." />
      <SubHeading>Needed the person</SubHeading>
      <p className="text-sm text-ink-muted">
        Logins that waited for a code or an approval, or that the person stopped. They are the usual
        steps on sites that ask for a code, not failures.
      </p>
      <FailureGroups groups={data.needsPerson} empty="None in this range." />
    </Panel>
  );
}

/**
 * The owner's dashboard: login speed from the login records devices send and request speed
 * from the request log's recorded times, counts and spend, and the failures by result code,
 * over 24 hours, 7 days or 30 days.
 */
export function DashboardPage({ client }: { client: ManageClient }) {
  const [range, setRange] = useState<ManageDashboardRange>("7d");
  const dashboard = useQuery({
    queryKey: [...DASHBOARD_QUERY_KEY, range],
    queryFn: () => client.dashboard(range),
    // The previous range stays shown while the next loads.
    placeholderData: keepPreviousData,
  });
  return (
    <section aria-labelledby="dashboard-heading" className="chart-palette space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 id="dashboard-heading" className={PAGE_TITLE_CLASSES}>
          Dashboard
        </h1>
        <fieldset>
          <legend className="sr-only">Range</legend>
          <div className="inline-flex rounded-lg border border-border bg-surface p-0.5">
            {RANGES.map(([value, label]) => (
              <label
                key={value}
                className="inline-flex min-h-9 cursor-pointer items-center rounded-md px-3 text-sm font-medium text-ink-muted has-checked:bg-accent-tint has-checked:font-semibold has-checked:text-accent-ink has-focus-visible:outline-2 has-focus-visible:outline-offset-2 has-focus-visible:outline-focus has-focus-visible:outline-solid"
              >
                <input
                  type="radio"
                  name="dashboard-range"
                  value={value}
                  checked={range === value}
                  onChange={() => setRange(value)}
                  className="sr-only"
                />
                {label}
              </label>
            ))}
          </div>
        </fieldset>
      </div>
      {dashboard.isPending ? (
        <output id="dashboard-status" className="block">
          Loading the dashboard…
        </output>
      ) : dashboard.isError ? (
        <ErrorNotice id="dashboard-status">{describeError(dashboard.error)}</ErrorNotice>
      ) : (
        <>
          <p id="dashboard-status" className="text-sm text-ink-muted">
            {formatTime(dashboard.data.from)} to {formatTime(dashboard.data.to)}{" "}
            <output aria-live="polite">
              {dashboard.isPlaceholderData ? "(loading the new range…)" : ""}
            </output>
          </p>
          <Speed data={dashboard.data} />
          <Stats data={dashboard.data} />
          <Failures data={dashboard.data} />
        </>
      )}
    </section>
  );
}
