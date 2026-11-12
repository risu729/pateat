import {
  MANAGE_LOGIN_HISTORY_LIMIT,
  loginOutcomeSchema,
  manageLoginHistoryFiltersSchema,
  type LoginOutcome,
  type ManageLoginHistoryCursor,
  type ManageLoginHistoryFilters,
} from "@pateat/contracts";
import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import * as v from "valibot";
import { describeError, type ManageClient } from "./api";
import { Button } from "./button";
import { formatTime } from "./devices";
import { Badge, ErrorNotice, KeyValues, Panel, ROW_CLASSES, RowList, RowMain } from "./ui";

export const LOGIN_HISTORY_QUERY_KEY = ["login-history"] as const;
const OUTCOME_LABELS = {
  authenticated: "Signed in",
  "credential-rejected": "Credentials rejected",
  challenge: "Waiting for verification",
  "unknown-submit": "Sign-in result unknown",
  interrupted: "Interrupted",
  "structural-mismatch": "Page did not match the recipe",
  timeout: "Timed out",
  "retry-limit": "Retry limit reached",
  "submission-limit": "Submission limit reached",
  "policy-changed": "Settings changed",
  cancelled: "Cancelled",
  "wrong-account": "Different account shown",
  "account-switched": "Switched accounts",
  "value-mismatch": "Value did not fit the field",
  "fill-rejected": "Page rejected the filled field",
  "left-origin": "Left the site",
  "account-not-listed": "Account not listed",
  "challenge-abandoned": "Verification did not finish",
  "watch-abandoned": "Sign-in did not finish",
} satisfies Record<LoginOutcome, string>;
const fieldClass =
  "min-h-10 rounded-lg border border-border-strong bg-surface px-3 text-sm text-ink";
const duration = (ms: number) =>
  ms < 1000
    ? `${ms} ms`
    : `${new Intl.NumberFormat("en", { maximumFractionDigits: 2 }).format(ms / 1000)} s`;

function showing(count: number, older: boolean) {
  const s = count === 1 ? "" : "s";
  return older
    ? `Showing ${count} older login record${s}.`
    : `Showing the ${count} newest login record${s}.`;
}

/** Browse only retained login metadata, independently of the request-log delete control. */
export function LoginHistory({ client }: { client: ManageClient }) {
  const [site, setSite] = useState("");
  const [outcome, setOutcome] = useState("");
  const [filterError, setFilterError] = useState(false);
  const [filters, setFilters] = useState<ManageLoginHistoryFilters>({});
  const [cursor, setCursor] = useState<ManageLoginHistoryCursor>();
  const history = useQuery({
    queryKey: [...LOGIN_HISTORY_QUERY_KEY, filters, cursor ?? null],
    queryFn: () =>
      client.loginHistory({
        ...filters,
        ...(cursor ? { beforeAt: cursor.at, beforeId: cursor.id } : {}),
      }),
  });
  const reset = () => {
    setCursor(undefined);
    // Refresh even when the owner is already on the newest page.
    if (!cursor) void history.refetch();
  };
  // The list follows the applied filters, which inputs typed since may not match.
  const applied = [filters.origin, filters.outcome && OUTCOME_LABELS[filters.outcome]]
    .filter(Boolean)
    .join(", ");
  return (
    <Panel id="login-history-heading" title="Login history">
      <p>
        Browse the login records already held by the service, newest first, up to{" "}
        {MANAGE_LOGIN_HISTORY_LIMIT} at a time. Only logins with a service recipe that were reported
        by the extension are included.
      </p>
      <form
        className="flex flex-wrap items-end gap-3"
        onSubmit={(event) => {
          event.preventDefault();
          // A pasted address keeps only its origin, which URL also lowercases.
          const raw = site.trim();
          const origin = URL.canParse(raw) ? new URL(raw).origin : raw;
          const parsed = v.safeParse(manageLoginHistoryFiltersSchema, {
            ...(origin ? { origin } : {}),
            ...(outcome ? { outcome } : {}),
          });
          if (!parsed.success) {
            setFilterError(true);
            return;
          }
          setFilterError(false);
          setFilters(parsed.output);
          setCursor(undefined);
        }}
      >
        <label className="flex flex-col gap-1" htmlFor="login-history-site">
          Site
          <input
            id="login-history-site"
            type="text"
            className={fieldClass}
            placeholder="https://example.com"
            value={site}
            maxLength={300}
            aria-describedby="login-history-site-hint"
            aria-invalid={filterError || undefined}
            onChange={(event) => {
              setSite(event.target.value);
              setFilterError(false);
            }}
          />
        </label>
        <label className="flex flex-col gap-1" htmlFor="login-history-outcome">
          Result
          <select
            id="login-history-outcome"
            className={fieldClass}
            value={outcome}
            onChange={(event) => setOutcome(event.target.value)}
          >
            <option value="">All results</option>
            {loginOutcomeSchema.options.map((value) => (
              <option key={value} value={value}>
                {OUTCOME_LABELS[value]}
              </option>
            ))}
          </select>
        </label>
        <Button type="submit">Apply filters</Button>
        <Button
          type="button"
          variant="outline"
          onClick={() => {
            setSite("");
            setOutcome("");
            setFilterError(false);
            setFilters({});
            setCursor(undefined);
          }}
        >
          Clear filters
        </Button>
      </form>
      <p id="login-history-site-hint" className="text-sm text-ink-muted">
        Records match the site&apos;s origin, such as https://example.com; a path is ignored.
      </p>
      {filterError && (
        <ErrorNotice id="login-history-filter-error">
          Enter a site address such as https://example.com.
        </ErrorNotice>
      )}
      {history.isPending ? (
        <output className="block">Loading login history…</output>
      ) : history.isError ? (
        <ErrorNotice id="login-history-error">{describeError(history.error)}</ErrorNotice>
      ) : history.data.entries.length === 0 ? (
        <output className="block">
          {history.data.next
            ? "None of the login records on this page can be shown. Choose Older for earlier ones."
            : cursor
              ? applied
                ? "No older login records match these filters."
                : "No older login records are held."
              : applied
                ? "No login records match these filters."
                : "No login records are held yet."}
          {applied && ` Filtered by ${applied}.`}
        </output>
      ) : (
        <>
          <output className="block">
            {showing(history.data.entries.length, cursor !== undefined)}
            {applied && ` Filtered by ${applied}.`}
          </output>
          <RowList aria-label="Login records">
            {history.data.entries.map((entry) => (
              <li key={entry.id} className={ROW_CLASSES}>
                <RowMain title={entry.origin} sub={formatTime(entry.at, { seconds: true })} />
                <Badge tone={entry.outcome === "authenticated" ? "accent" : "muted"}>
                  {OUTCOME_LABELS[entry.outcome]}
                </Badge>
                <details className="w-full">
                  <summary className="cursor-pointer text-sm font-semibold text-accent-ink">
                    Details
                  </summary>
                  <div className="pt-3">
                    <KeyValues
                      entries={[
                        ["Result code", entry.outcome],
                        ["Reason", entry.cause?.replaceAll("-", " ") ?? "Not recorded"],
                        ["Recipe", `${entry.recipeId}, revision ${entry.revision}`],
                        ["Extension build", entry.extensionBuild],
                        ["Total time", duration(entry.totalMs)],
                        ["Waiting for you", duration(entry.personMs)],
                        ["Waiting for service", duration(entry.serviceMs)],
                        ["Network within service (lower bound)", duration(entry.networkMs)],
                        ["Waiting for site", duration(entry.pageMs)],
                      ]}
                    />
                  </div>
                </details>
              </li>
            ))}
          </RowList>
        </>
      )}
      <div className="flex flex-wrap gap-2" aria-label="Login history pages">
        <Button type="button" variant="outline" disabled={history.isFetching} onClick={reset}>
          Newest
        </Button>
        <Button
          type="button"
          variant="outline"
          disabled={history.isFetching || !history.data?.next}
          onClick={() => setCursor(history.data?.next ?? undefined)}
        >
          Older
        </Button>
      </div>
    </Panel>
  );
}
