import { Trans, useTranslation } from "react-i18next";
import { formatLocale, i18n } from "../i18n";
import { diagnosticsCheckLabel, diagnosticsCode } from "./presentation";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  CircleCheck,
  CircleX,
  Copy,
  Download,
  Info,
  Lock,
  RefreshCw,
  Trash,
  TriangleAlert,
} from "lucide-react";
import { useRef, useState } from "react";
import { isoMinute } from "../time";
import { Logo } from "../logo";
import { Button } from "../options/button";
import {
  deviceFailureLabel,
  generationLabel,
  installLabel,
  plural,
  problemCounts,
  serverLabel,
  syncSignIn,
} from "./labels";
import { DEBUG_STAYS_ON, DEBUG_UNTIL_TURNED_OFF, LOG_RETENTION_MS } from "./log";
import { formatReport, shortRevision, vaultTimeoutText, type BrowserInfo } from "./report";
import type {
  DiagnosticsCheck,
  DiagnosticsResponse,
  DiagnosticsStatus,
  LogsResponse,
} from "./wire";

export type DiagnosticsClient = {
  load(): Promise<DiagnosticsResponse>;
  browser(): Promise<BrowserInfo>;
  copy(text: string): Promise<void>;
  exportLogs(includeSites: boolean): Promise<LogsResponse<"diagnostics.logs.export">>;
  clearLogs(): Promise<LogsResponse<"diagnostics.logs.clear">>;
  /** Turns debug logging on for 24 hours, or until turned off before publishing, or off at once. */
  setDebugLogs(enabled: boolean): Promise<LogsResponse<"diagnostics.logs.debug">>;
  /** Saves `text` as a file through the browser's download of a `Blob` link. */
  download(text: string, filename: string): void;
};

/** Each check is a status line led by its level's icon; the level is also read out. */
const LEVELS: Record<
  DiagnosticsCheck["level"],
  { icon: typeof CircleCheck; name: string; color: string }
> = {
  ok: { icon: CircleCheck, name: "OK", color: "text-accent-ink" },
  info: { icon: Info, name: "Info", color: "text-ink-muted" },
  warn: { icon: TriangleAlert, name: "Warning", color: "text-warning" },
  error: { icon: CircleX, name: "Error", color: "text-danger" },
};

const PANEL = "panel m-0 flex min-w-0 flex-col gap-4";
const HEADING = "m-0 text-xl/7 font-[650]";
/** Facts as label and value rows: muted labels, monospace values. */
const FACTS =
  "m-0 [&_dd]:font-mono [&_dd]:text-[13px] [&_dd]:wrap-anywhere [&_dt]:text-sm [&_dt]:font-normal [&_dt]:text-ink-muted [&_dd]:min-w-0 [&>div]:py-2.5 [&>div:first-child]:border-t-0 [&>div:first-child]:pt-0";
const TWO_PANELS = "grid grid-cols-[repeat(auto-fit,minmax(min(300px,100%),1fr))] gap-6";
const PREVIEW =
  "m-0 overflow-auto rounded-lg border border-border bg-surface-sunken p-3 font-mono text-[13px] whitespace-pre-wrap";
const NOTE = "m-0 text-[13px]/5 text-ink-muted";

/** UTC first, as in the copied report, then the local time for reading. */
function time(ms: number | undefined): string {
  if (ms === undefined) return "—";
  return `${isoMinute(ms)} (${Temporal.Instant.fromEpochMilliseconds(ms).toLocaleString(formatLocale())})`;
}

function Row({ term, children, id }: { term: string; children: React.ReactNode; id?: string }) {
  const { t } = useTranslation(undefined, { i18n });
  return (
    <div>
      <dt>{t(term)}</dt>
      <dd id={id}>{children}</dd>
    </div>
  );
}

function Version({ status, browser }: { status: DiagnosticsStatus; browser: BrowserInfo }) {
  const { t } = useTranslation(undefined, { i18n });
  const { build } = status;
  return (
    <section aria-labelledby="version-heading" className={PANEL}>
      <h2 id="version-heading" className={HEADING}>
        {t("Version")}
      </h2>
      <dl className={FACTS}>
        <Row term="Pateat" id="diagnostics-version">
          {t("{{version}} ({{revision}}) {{mode}} build", {
            version: build.version,
            revision: shortRevision(build.revision),
            mode: build.mode,
          })}
        </Row>
        <Row term="Install">
          {installLabel(browser.installType, t)} ({browser.installType})
        </Row>
        <Row term="Browser" id="diagnostics-browser">
          {browser.name === "Unknown browser" ? t("Unknown browser") : browser.name}{" "}
          {browser.version}
        </Row>
        <Row term="Platform">
          {status.platform.os} {status.platform.arch}
        </Row>
        <Row term="Bitwarden SDK" id="diagnostics-sdk">
          {build.bitwardenSdk}
        </Row>
        <Row term="Bitwarden protocol">{build.bitwardenProtocol}</Row>
        <Row term="Permissions">
          {[...status.permissions.permissions, ...status.permissions.origins].join(", ")}
          {status.permissions.otherOrigins > 0 &&
            ` + ${plural(status.permissions.otherOrigins, "granted site", undefined, t)}`}
        </Row>
        <Row term="Toolbar icon">{diagnosticsCode(status.actionIcon, t)}</Row>
      </dl>
    </section>
  );
}

function Checks({ status }: { status: DiagnosticsStatus }) {
  const { t } = useTranslation(undefined, { i18n });
  const checks = status.checks;
  return (
    <section aria-labelledby="checks-heading" className={PANEL}>
      <h2 id="checks-heading" className={HEADING}>
        {t("Checks")}
      </h2>
      <ul id="diagnostics-checks" className="m-0 flex list-none flex-col gap-2 p-0">
        {checks.map((check) => {
          const level = LEVELS[check.level];
          const Icon = level.icon;
          return (
            <li
              key={check.id}
              data-level={check.level}
              className="flex items-start gap-2 text-sm/5 wrap-anywhere"
            >
              <Icon
                aria-hidden
                size={16}
                strokeWidth={2}
                className={`mt-0.5 shrink-0 ${level.color}`}
              />
              <span>
                <span className="visually-hidden">{t(level.name)} </span>
                {diagnosticsCheckLabel(check, status, t)}
              </span>
            </li>
          );
        })}
      </ul>
    </section>
  );
}

function Connections({ status }: { status: DiagnosticsStatus }) {
  const { t } = useTranslation(undefined, { i18n });
  return (
    <section aria-labelledby="bitwarden-heading" className={PANEL}>
      <h2 id="bitwarden-heading" className={HEADING}>
        {t("Bitwarden connections")}
      </h2>
      {status.connections.length === 0 && <p className={NOTE}>{t("No connections.")}</p>}
      {status.connections.map((entry, index) => (
        <dl
          key={entry.id}
          aria-label={entry.id}
          className={`${FACTS} ${index > 0 ? "border-t border-border pt-4" : ""}`}
        >
          <Row term="Connection">{entry.id}</Row>
          <Row term="Environment">{diagnosticsCode(entry.environment, t)}</Row>
          {entry.server && <Row term="Server">{serverLabel(entry.server, t)}</Row>}
          <Row term="State">
            {diagnosticsCode(entry.state, t)}
            {entry.storageError && ` (${entry.storageError})`}
          </Row>
          <Row term="Automatic unlock">{diagnosticsCode(entry.autoUnlock, t)}</Row>
          <Row term="Sync sign-in">{syncSignIn(entry.providerSession, t)}</Row>
          <Row term="Vault synced">{time(entry.acceptedAt)}</Row>
          {entry.items && (
            <Row term="Items">
              {t(
                "{{total}} (login {{login}}, TOTP {{totp}}, passkey {{passkey}}) + {{unsupported}} unsupported",
                {
                  total: entry.items.total,
                  login: entry.items.login,
                  totp: entry.items.totp,
                  passkey: entry.items.passkey,
                  unsupported: entry.items.unsupported,
                },
              )}
            </Row>
          )}
          {entry.unlockKdf && (
            <Row term="Unlock KDF (only the type is copied)">{entry.unlockKdf}</Row>
          )}
        </dl>
      ))}
    </section>
  );
}

function Service({ status }: { status: DiagnosticsStatus }) {
  const { t } = useTranslation(undefined, { i18n });
  const { service } = status;
  return (
    <section aria-labelledby="service-heading" className={PANEL}>
      <h2 id="service-heading" className={HEADING}>
        {t("Pateat service")}
      </h2>
      <dl className={FACTS}>
        <Row term="Pairing" id="diagnostics-service">
          {diagnosticsCode(service.kind, t)}
          {service.rejected && t(" (rejected)")}
          {service.cacheFull && t(" (recipe cache full)")}
        </Row>
        {service.siteAccess !== undefined && (
          <Row term="Site access">{t(service.siteAccess ? "granted" : "withheld")}</Row>
        )}
        {service.health && (
          <Row term="Service revision">
            {service.health.ok
              ? shortRevision(service.health.revision)
              : t("unavailable ({{error}})", {
                  error: `${service.health.error}${service.health.status === undefined ? "" : ` ${service.health.status}`}`,
                })}
          </Row>
        )}
        {service.kind === "connected" && (
          <>
            <Row term="Last sync">{time(service.syncedAt)}</Row>
            <Row term="Next sync">{time(service.nextSyncAt)}</Row>
            <Row term="Settings revision">{service.settingsRevision ?? "—"}</Row>
            <Row term="Settings waiting for a login">{time(service.holdSince)}</Row>
            <Row term="Cached recipes">
              {service.recipes
                ? `${service.recipes.count} (${Math.ceil(service.recipes.bytes / 1024)} KB)`
                : "—"}
            </Row>
          </>
        )}
        {service.device &&
          (service.device.ok ? (
            <>
              <Row term="Paired" id="diagnostics-service-paired">
                {time(service.device.pairedAt)}
              </Row>
              <Row term="Recipes on the service">{service.device.recipes}</Row>
              <Row term="Settings revision on the service">{service.device.settingsRevision}</Row>
              <Row term="Recipe generation" id="diagnostics-service-generation">
                {generationLabel(service.device.generation, t)}
              </Row>
            </>
          ) : (
            <Row term="Service record" id="diagnostics-service-record">
              {deviceFailureLabel(service.device.error, t)}
            </Row>
          ))}
      </dl>
    </section>
  );
}

function Local({ status }: { status: DiagnosticsStatus }) {
  const { t } = useTranslation(undefined, { i18n });
  return (
    <section aria-labelledby="local-heading" className={PANEL}>
      <h2 id="local-heading" className={HEADING}>
        {t("Settings and storage")}
      </h2>
      <dl className={FACTS}>
        {status.settings && (
          <Row term="Settings">
            {t(
              "excluded sites {{excludedSites}}, site defaults {{siteDefaults}}, bindings {{bindings}}",
              {
                excludedSites: status.settings.excludedSites,
                siteDefaults: status.settings.siteDefaults,
                bindings: status.settings.bindings,
              },
            )}
          </Row>
        )}
        {status.vaultTimeout && (
          <Row term="Vault timeout">
            {vaultTimeoutText(status.vaultTimeout, (value) => diagnosticsCode(value, t))}
          </Row>
        )}
        <Row term="storage.local">
          {status.storage.localBytes === undefined
            ? "—"
            : t("{{size}} KB of 10 MB", { size: Math.ceil(status.storage.localBytes / 1024) })}
        </Row>
        <Row term="Collected">{time(status.collectedAt)}</Row>
      </dl>
    </section>
  );
}

/** `pateat-logs-20261011-1035.jsonl`, from the UTC time of the export. */
export function logFilename(ms: number): string {
  const iso = isoMinute(ms);
  return `pateat-logs-${iso.slice(0, 10).replaceAll("-", "")}-${iso.slice(11, 16).replace(":", "")}.jsonl`;
}

/** Entries in an export: every line after its header line. */
function exportedEntries(text: string): number {
  return Math.max(0, text.trimEnd().split("\n").length - 1);
}

type DiagnosticMessage = string | { key: string; values: Record<string, string | number> };

function Logs({
  status,
  client,
  changed,
  message,
  setMessage,
}: {
  status: DiagnosticsStatus;
  client: DiagnosticsClient;
  /** Updates the summary in place, after applying `update` to it at once when given. */
  changed: (update?: (logs: DiagnosticsStatus["logs"]) => DiagnosticsStatus["logs"]) => void;
  message: DiagnosticMessage;
  setMessage: (message: DiagnosticMessage) => void;
}) {
  const { t } = useTranslation(undefined, { i18n });
  // The text and the choice it was exported with, so the checkbox never disagrees with it.
  const [preview, setPreview] = useState<{ text: string; includeSites: boolean }>();
  // The choice being exported; Save waits for it.
  const [pending, setPending] = useState<boolean>();
  const latest = useRef(0);
  const [confirmClear, setConfirmClear] = useState(false);
  const { logs } = status;
  async function open(includeSites: boolean) {
    const request = (latest.current += 1);
    setPending(includeSites);
    const response = await client.exportLogs(includeSites).catch(() => undefined);
    // Only the newest export is shown; an earlier, slower one is ignored.
    if (request !== latest.current) return;
    setPending(undefined);
    if (response?.ok) {
      setPreview({ text: response.text, includeSites });
      setMessage("");
    } else {
      setPreview(undefined);
      setMessage("Unable to read the logs.");
    }
  }
  async function copy(text: string) {
    const request = latest.current;
    let copied = true;
    try {
      await client.copy(text);
    } catch {
      copied = false;
    }
    // A preview closed or cleared meanwhile keeps its own message.
    if (request !== latest.current) return;
    setMessage(
      copied
        ? { key: "diagnostics.copiedEntries", values: { count: exportedEntries(text) } }
        : "Copy failed. Use Save file instead.",
    );
  }
  const debugOff = logs?.debugUntil === undefined;
  return (
    <section aria-labelledby="logs-heading" className={PANEL}>
      <div className="flex flex-wrap items-center justify-between gap-4">
        <h2 id="logs-heading" className={HEADING}>
          {t("Logs")}
        </h2>
        <div className="flex flex-wrap items-center gap-2">
          {/* Sites and recipes are shown unless the person hides them (owner, 2026-10-12). */}
          <Button
            id="download-logs"
            type="button"
            variant="outline"
            className="gap-2"
            onClick={() => void open(true)}
          >
            <Download aria-hidden size={16} strokeWidth={2} />
            {t("Download logs")}
          </Button>
          {confirmClear ? (
            <Button
              id="confirm-clear-logs"
              type="button"
              variant="danger"
              className="gap-2"
              onClick={() =>
                void client
                  .clearLogs()
                  .catch(() => undefined)
                  .then((response) => {
                    setConfirmClear(false);
                    latest.current += 1;
                    setPending(undefined);
                    setPreview(undefined);
                    setMessage(response?.ok ? "Logs cleared." : "Unable to clear the logs.");
                    changed();
                    return undefined;
                  })
              }
            >
              <Trash aria-hidden size={16} strokeWidth={2} />
              {t("Delete all log entries")}
            </Button>
          ) : (
            <Button
              id="clear-logs"
              type="button"
              variant="danger"
              className="gap-2"
              onClick={() => setConfirmClear(true)}
            >
              <Trash aria-hidden size={16} strokeWidth={2} />
              {t("Clear logs")}
            </Button>
          )}
        </div>
      </div>
      <dl className={FACTS}>
        <Row term="Entries" id="diagnostics-logs">
          {logs ? `${logs.entries} (${Math.ceil(logs.bytes / 1024)} KB)` : t("unreadable")}
        </Row>
        {logs && <Row term="Problems in the last 24 h">{problemCounts(logs, t)}</Row>}
        <Row term="Kept on this device">
          {t("{{count}} days", {
            count: Temporal.Duration.from({ milliseconds: LOG_RETENTION_MS }).total("days"),
          })}
        </Row>
      </dl>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <span id="diagnostics-debug">
          {t("Debug logging")}{" "}
          <span className="text-[13px] text-ink-muted">
            {debugOff
              ? t("off")
              : logs?.debugUntil === DEBUG_UNTIL_TURNED_OFF
                ? t("on until turned off")
                : t("on until {{time}}", { time: time(logs?.debugUntil) })}
          </span>
        </span>
        <Button
          id="debug-logs"
          type="button"
          variant="outline"
          onClick={() => {
            // On turns itself off after 24 hours (owner, 2026-10-12), or until published stays
            // on until turned off (owner, 2026-10-18); off takes effect at once.
            const enable = debugOff;
            void client
              .setDebugLogs(enable)
              .catch(() => undefined)
              .then((response) => {
                setMessage(
                  response?.ok
                    ? enable
                      ? DEBUG_STAYS_ON
                        ? "Debug logging is on until you turn it off."
                        : "Debug logging is on for 24 hours."
                      : "Debug logging is off."
                    : "Unable to change logging.",
                );
                // The button follows at once; the entry counts follow when the summary is read.
                if (!response?.ok) changed();
                else {
                  const until = response.debugUntil;
                  changed((current) => {
                    if (!current) return current;
                    const { debugUntil: _, ...rest } = current;
                    return until === undefined ? rest : { ...rest, debugUntil: until };
                  });
                }
                return undefined;
              });
          }}
        >
          {t(
            debugOff
              ? DEBUG_STAYS_ON
                ? "Turn on debug logging"
                : "Turn on debug logging for 24 hours"
              : "Turn off debug logging",
          )}
        </Button>
      </div>
      <div className="flex items-start gap-2 rounded-xl bg-warning-tint px-3 py-2.5 text-sm/5">
        <TriangleAlert
          aria-hidden
          size={16}
          strokeWidth={2}
          className="mt-0.5 shrink-0 text-warning"
        />
        <span>
          <Trans
            i18n={i18n}
            t={t}
            i18nKey={
              "With site addresses included, a download names page paths and their parameters' names, not values; a path or a page's route can still hold a code or an ID. A site you had not set up when an entry was written stays pseudonymous, as <code>{{origin}}</code> or <code>{{rp}}</code>. Check the preview before sharing."
            }
            values={{ origin: "origin:7d2b91aa", rp: "rp:7d2b91aa" }}
            components={{ code: <code /> }}
          />
        </span>
      </div>
      {preview !== undefined && (
        <div className="flex flex-col gap-3">
          <p className={NOTE}>
            {t("This exact text is saved or copied. Check it before attaching it to a bug report.")}
          </p>
          <label className="m-0 flex items-start gap-2">
            <input
              id="hide-sites"
              type="checkbox"
              checked={!(pending ?? preview.includeSites)}
              onChange={(event) => void open(!event.target.checked)}
            />
            {t("Hide site addresses and recipe IDs")}
          </label>
          <pre id="logs-preview" className={`${PREVIEW} max-h-96`}>
            {preview.text}
          </pre>
          <div className="flex flex-wrap gap-2">
            <Button
              id="save-logs"
              type="button"
              className="gap-2"
              disabled={pending !== undefined}
              onClick={() => {
                client.download(preview.text, logFilename(Date.now()));
                setMessage("Download started.");
              }}
            >
              <Download aria-hidden size={16} strokeWidth={2} />
              {t("Save file")}
            </Button>
            <Button
              id="copy-logs"
              type="button"
              variant="outline"
              className="gap-2"
              disabled={pending !== undefined}
              onClick={() => void copy(preview.text)}
            >
              <Copy aria-hidden size={16} strokeWidth={2} />
              {t("Copy all")}
            </Button>
            <Button
              type="button"
              variant="outline"
              onClick={() => {
                latest.current += 1;
                setPending(undefined);
                setPreview(undefined);
              }}
            >
              {t("Close")}
            </Button>
          </div>
        </div>
      )}
      <output id="logs-status" className="block empty:absolute" aria-live="polite">
        {typeof message === "string" ? (message ? t(message) : "") : t(message.key, message.values)}
      </output>
    </section>
  );
}

const QUERY_KEY = ["diagnostics"] as const;

export function DiagnosticsApp({ client }: { client: DiagnosticsClient }) {
  const { t } = useTranslation(undefined, { i18n });
  const queryClient = useQueryClient();
  const query = useQuery({
    queryKey: QUERY_KEY,
    queryFn: async () => {
      const [response, browser] = await Promise.all([client.load(), client.browser()]);
      if (!response.ok) throw new Error(response.error);
      return { status: response.status, browser };
    },
    retry: false,
    staleTime: Infinity,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
  });
  const [preview, setPreview] = useState<string>();
  const [message, setMessage] = useState<DiagnosticMessage>("");
  const [logsMessage, setLogsMessage] = useState<DiagnosticMessage>("");
  // Only the first load and Refresh start over; a change made on this page updates the
  // summary in place, so open previews and messages stay, and a failed update keeps the last one.
  const state = query.isPending
    ? ({ kind: "loading" } as const)
    : query.data
      ? ({ kind: "ready", ...query.data } as const)
      : ({ kind: "failed" } as const);
  function refresh() {
    setPreview(undefined);
    setMessage("");
    setLogsMessage("");
    void queryClient.resetQueries({ queryKey: QUERY_KEY });
  }
  function changed(update?: (logs: DiagnosticsStatus["logs"]) => DiagnosticsStatus["logs"]) {
    if (update) {
      queryClient.setQueryData<NonNullable<typeof query.data>>(
        QUERY_KEY,
        (data) => data && { ...data, status: { ...data.status, logs: update(data.status.logs) } },
      );
    }
    void query.refetch();
  }
  async function copy(text: string) {
    try {
      await client.copy(text);
      setMessage("Copied. Paste it into the bug report.");
    } catch {
      setMessage("Copy failed. Select the text above and copy it manually.");
    }
  }
  return (
    <main className="mx-auto flex max-w-220 flex-col gap-6 px-4 py-8 sm:px-6">
      <header className="flex flex-col gap-3">
        <div className="flex flex-wrap items-center gap-3">
          <Logo className="size-7 shrink-0" />
          <h1 className="m-0 flex-1">{t("Diagnostics")}</h1>
          <button
            id="refresh-diagnostics"
            type="button"
            aria-label={t("Refresh")}
            title={t("Refresh")}
            disabled={state.kind === "loading"}
            className="inline-flex size-10 items-center justify-center rounded-lg text-ink-muted hover:bg-surface-sunken disabled:opacity-50 disabled:hover:bg-transparent"
            onClick={refresh}
          >
            <RefreshCw aria-hidden size={16} strokeWidth={2} />
          </button>
          <Button
            id="copy-report"
            type="button"
            className="gap-2"
            disabled={state.kind !== "ready"}
            onClick={() => {
              if (state.kind === "ready") setPreview(formatReport(state.status, state.browser));
            }}
          >
            <Copy aria-hidden size={16} strokeWidth={2} />
            {t("Copy for bug report")}
          </Button>
        </div>
        <p className="m-0 flex items-center gap-1.5 text-[13px]/5 text-ink-muted">
          <Lock aria-hidden size={14} strokeWidth={2} className="shrink-0" />
          {t("No passwords, keys, field values, names or emails are shown, copied or saved")}
        </p>
      </header>
      <output id="diagnostics-status" className="block empty:absolute" aria-live="polite">
        {state.kind === "loading"
          ? t("Collecting diagnostics…")
          : state.kind === "failed"
            ? t("Unable to collect diagnostics. Reload the extension and try again.")
            : ""}
      </output>
      {preview !== undefined && (
        <section aria-labelledby="preview-heading" className={PANEL}>
          <h2 id="preview-heading" className={HEADING}>
            {t("Bug report text")}
          </h2>
          <p className={NOTE}>
            <Trans
              i18n={i18n}
              t={t}
              i18nKey={
                "This exact text is copied. Check it before posting. Sites are numbered here, separately from a hidden <strong>Download logs</strong>, so <code>site-1</code> may differ."
              }
              components={{ code: <code />, strong: <strong /> }}
            />{" "}
            {t(
              "Bug report text and exported log entries stay in English and keep their diagnostic codes.",
            )}
          </p>
          <pre id="report-preview" className={PREVIEW}>
            {preview}
          </pre>
          <div className="flex flex-wrap gap-2">
            <Button
              id="confirm-copy"
              type="button"
              className="gap-2"
              onClick={() => void copy(preview)}
            >
              <Copy aria-hidden size={16} strokeWidth={2} />
              {t("Copy")}
            </Button>
            <Button
              type="button"
              variant="outline"
              onClick={() => {
                setPreview(undefined);
                setMessage("");
              }}
            >
              {t("Close")}
            </Button>
          </div>
          <output id="copy-status" className="block empty:absolute" aria-live="polite">
            {typeof message === "string"
              ? message
                ? t(message)
                : ""
              : t(message.key, message.values)}
          </output>
        </section>
      )}
      {state.kind === "ready" && (
        <>
          <Checks status={state.status} />
          <div className={TWO_PANELS}>
            <Version status={state.status} browser={state.browser} />
            <Local status={state.status} />
          </div>
          <div className={TWO_PANELS}>
            <Connections status={state.status} />
            <Service status={state.status} />
          </div>
          <Logs
            status={state.status}
            client={client}
            changed={changed}
            message={logsMessage}
            setMessage={setLogsMessage}
          />
        </>
      )}
    </main>
  );
}
