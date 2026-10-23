import { MANAGE_PROBLEMS_LIMIT, PROBLEM_LOG_RETENTION_MS } from "@pateat/contracts";
import { useQuery } from "@tanstack/react-query";
import { Clock, FileText, TriangleAlert } from "lucide-react";
import { describeError, type ManageClient } from "./api";
import { formatTime } from "./devices";
import {
  Badge,
  ErrorNotice,
  Line,
  Lines,
  PAGE_TITLE_CLASSES,
  ROW_CLASSES,
  RowIcon,
  RowList,
  RowMain,
} from "./ui";

export const PROBLEMS_QUERY_KEY = ["problems"] as const;

const RETENTION_DAYS = PROBLEM_LOG_RETENTION_MS / (24 * 60 * 60 * 1000);

/**
 * The newest warning and error lines devices sent from their local logs (proposed ADR
 * 0066), so failures are found without a report. Deleting them goes with the request log.
 */
export function ProblemsPage({ client }: { client: ManageClient }) {
  const problems = useQuery({ queryKey: PROBLEMS_QUERY_KEY, queryFn: () => client.problems() });
  return (
    <section aria-labelledby="problems-heading" className="space-y-4">
      <h1 id="problems-heading" className={PAGE_TITLE_CLASSES}>
        Problems
      </h1>
      <p>
        Devices send the warnings and errors of their local logs, such as a login that stopped or a
        vault sync that failed: codes, counts, the recipe and the site, and a page&apos;s path
        without its query. Sites that are not set up stay unnamed. The newest{" "}
        {MANAGE_PROBLEMS_LIMIT} are shown.
      </p>
      {problems.isPending ? (
        <output id="problems-status" className="block">
          Loading problems…
        </output>
      ) : problems.isError ? (
        <ErrorNotice id="problems-status">{describeError(problems.error)}</ErrorNotice>
      ) : problems.data.problems.length === 0 ? (
        <p id="problems-status">No problems were sent.</p>
      ) : (
        <RowList id="problems">
          {problems.data.problems.map((problem, index) => (
            // oxlint-disable-next-line no-array-index-key -- lines have no ID here; the list is read-only
            <li key={index} className={ROW_CLASSES}>
              <RowIcon>
                <TriangleAlert size={16} aria-hidden />
              </RowIcon>
              <RowMain
                title={problem.event}
                sub={
                  <>
                    <span>
                      {formatTime(problem.loggedAt)}, {problem.device || "Unnamed device"},{" "}
                      {problem.extensionBuild}
                    </span>
                    <code className="block font-mono text-xs [overflow-wrap:anywhere]">
                      {Object.entries(problem.fields)
                        .map(([key, value]) => `${key}=${String(value)}`)
                        .join(" ")}
                    </code>
                  </>
                }
              />
              <Badge tone={problem.level === "error" ? "warning" : "muted"}>{problem.level}</Badge>
            </li>
          ))}
        </RowList>
      )}
      <Lines>
        <Line icon={<Clock size={16} aria-hidden />}>
          Each line is kept for {RETENTION_DAYS} days; Delete all on the Request log page deletes
          them too
        </Line>
        <Line icon={<FileText size={16} aria-hidden />}>
          Vault values, usernames and page text are never logged, so they are never sent
        </Line>
      </Lines>
    </section>
  );
}
