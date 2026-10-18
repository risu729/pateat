import { INFERENCE_LOG_RETENTION_MS } from "@pateat/contracts";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Clock, FileText, ShieldCheck } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { describeError, type ManageClient } from "./api";
import { Button } from "./button";
import { formatTime } from "./devices";
import { ErrorNotice, Line, Lines, PAGE_TITLE_CLASSES, SuccessNotice } from "./ui";

export const REQUEST_LOG_QUERY_KEY = ["request-log"] as const;

const RETENTION_DAYS = INFERENCE_LOG_RETENTION_MS / (24 * 60 * 60 * 1000);
const requests = (n: number) => `${n} request${n === 1 ? "" : "s"}`;
const results = (n: number) => `${n} login result${n === 1 ? "" : "s"}`;
/** Requests, and login results when there are any. */
const held = (entries: number, outcomes: number) =>
  outcomes ? `${requests(entries)} and ${results(outcomes)}` : requests(entries);

/**
 * The service's log of the requests it sent to Claude (ADR 0012) and the login result codes
 * devices sent (ADR 0019), and deleting all of it. Deletion cannot be undone, so it takes a
 * second, explicit confirmation.
 */
export function RequestLogPage({ client }: { client: ManageClient }) {
  const queryClient = useQueryClient();
  const log = useQuery({ queryKey: REQUEST_LOG_QUERY_KEY, queryFn: () => client.requestLog() });
  const [confirming, setConfirming] = useState(false);
  // The control to focus once the one the owner used has gone away.
  const focusTarget = useRef<string | null>(null);
  const remove = useMutation({
    mutationFn: () => client.deleteRequestLog(),
    onSuccess: () => {
      focusTarget.current = "request-log-heading";
    },
    onError: () => {
      focusTarget.current = "request-log-delete";
    },
    onSettled: () => {
      setConfirming(false);
      void queryClient.invalidateQueries({ queryKey: REQUEST_LOG_QUERY_KEY });
    },
  });
  useEffect(() => {
    const target = focusTarget.current;
    if (!target || remove.isPending) return;
    (document.getElementById(target) ?? document.getElementById("request-log-heading"))?.focus();
    focusTarget.current = null;
  });

  const entries = log.data?.entries ?? 0;
  const outcomes = log.data?.outcomes ?? 0;
  return (
    <section aria-labelledby="request-log-heading" className="space-y-4">
      <h1 id="request-log-heading" tabIndex={-1} className={`${PAGE_TITLE_CLASSES} outline-none`}>
        Request log
      </h1>
      <p>
        The service keeps each request it sent to Claude to generate a recipe or judge a page: the
        page as described, the instructions and what Claude answered. For the first login with each
        recipe version, it also keeps how the login ended, as a result code without any page text or
        value. They are used to evaluate and improve generation.
      </p>
      <SuccessNotice
        id="request-log-deleted"
        message={remove.isSuccess && `${held(remove.data.deleted, remove.data.outcomes)} deleted`}
      />
      {remove.isError && (
        <ErrorNotice id="request-log-error">{describeError(remove.error)}</ErrorNotice>
      )}
      {log.isPending ? (
        <output id="request-log-status" className="block">
          Loading the request log…
        </output>
      ) : log.isError ? (
        <ErrorNotice id="request-log-status">{describeError(log.error)}</ErrorNotice>
      ) : (
        <p id="request-log-status">
          {log.data.oldestAt === null
            ? "No requests are logged."
            : `${held(log.data.entries, log.data.outcomes)} logged since ${formatTime(log.data.oldestAt)}.`}
        </p>
      )}
      {!log.data ? null : confirming ? (
        <div className="flex flex-wrap items-center gap-2">
          <span>Delete all {held(entries, outcomes)}? This cannot be undone.</span>
          <Button
            id="request-log-confirm"
            variant="danger"
            disabled={remove.isPending}
            onClick={() => remove.mutate()}
          >
            Confirm
          </Button>
          <Button
            variant="outline"
            disabled={remove.isPending}
            onClick={() => {
              setConfirming(false);
              focusTarget.current = "request-log-delete";
            }}
          >
            Cancel
          </Button>
        </div>
      ) : (
        <Button
          id="request-log-delete"
          variant="danger"
          disabled={entries + outcomes === 0 || remove.isPending}
          onClick={() => {
            setConfirming(true);
            focusTarget.current = "request-log-confirm";
          }}
        >
          Delete all
        </Button>
      )}
      <Lines>
        <Line icon={<Clock size={16} aria-hidden />}>
          Each request and login result is kept for {RETENTION_DAYS} days
        </Line>
        <Line icon={<FileText size={16} aria-hidden />}>
          Vault values are never sent, so they are never logged
        </Line>
        <Line icon={<ShieldCheck size={16} aria-hidden />}>
          Deleting the log does not change recipes, settings or the spend counted toward the monthly
          and daily limits
        </Line>
      </Lines>
    </section>
  );
}
