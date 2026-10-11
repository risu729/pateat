import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { Button } from "../options/button";
import { formatReport, shortRevision, utcMinute, type BrowserInfo } from "./report";
import type { DiagnosticsCheck, DiagnosticsResponse, DiagnosticsStatus } from "./wire";

export type DiagnosticsClient = {
  load(): Promise<DiagnosticsResponse>;
  browser(): Promise<BrowserInfo>;
  copy(text: string): Promise<void>;
};

const LEVEL_MARK: Record<DiagnosticsCheck["level"], string> = {
  ok: "✓",
  info: "·",
  warn: "!",
  error: "✗",
};

/** UTC first, as in the copied report, then the local time for reading. */
function time(ms: number | undefined): string {
  if (ms === undefined) return "—";
  return `${utcMinute(ms)} (${new Date(ms).toLocaleString()})`;
}

function Row({ term, children, id }: { term: string; children: React.ReactNode; id?: string }) {
  return (
    <div>
      <dt>{term}</dt>
      <dd id={id}>{children}</dd>
    </div>
  );
}

function Version({ status, browser }: { status: DiagnosticsStatus; browser: BrowserInfo }) {
  const { build } = status;
  return (
    <section aria-labelledby="version-heading" className="panel">
      <h2 id="version-heading">Version</h2>
      <dl>
        <Row term="Pateat" id="diagnostics-version">
          {build.version} ({shortRevision(build.revision)}, {build.mode})
        </Row>
        <Row term="Install type">{browser.installType}</Row>
        <Row term="Browser" id="diagnostics-browser">
          {browser.name} {browser.version}
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
            ` + ${status.permissions.otherOrigins} granted sites`}
        </Row>
        <Row term="Toolbar icon">{status.actionIcon}</Row>
      </dl>
    </section>
  );
}

function Checks({ checks }: { checks: readonly DiagnosticsCheck[] }) {
  return (
    <section aria-labelledby="checks-heading" className="panel">
      <h2 id="checks-heading">Checks</h2>
      <ul id="diagnostics-checks" className="list-none p-0">
        {checks.map((check) => (
          <li key={check.id} data-level={check.level} className="py-1 font-mono text-sm">
            <span aria-label={check.level}>{LEVEL_MARK[check.level]}</span> {check.detail}
          </li>
        ))}
      </ul>
    </section>
  );
}

function Connections({ status }: { status: DiagnosticsStatus }) {
  return (
    <section aria-labelledby="bitwarden-heading" className="panel">
      <h2 id="bitwarden-heading">Bitwarden connections</h2>
      {status.connections.length === 0 && <p className="note">No connections.</p>}
      {status.connections.map((entry) => (
        <dl key={entry.id} aria-label={entry.id}>
          <Row term="Connection">{entry.id}</Row>
          <Row term="Environment">{entry.environment}</Row>
          <Row term="State">
            {entry.state}
            {entry.storageError && ` (${entry.storageError})`}
          </Row>
          <Row term="Automatic unlock">{entry.autoUnlock}</Row>
          <Row term="Sync sign-in">{entry.providerSession}</Row>
          <Row term="Last vault sync">{time(entry.acceptedAt)}</Row>
          {entry.items && (
            <Row term="Items">
              {entry.items.total} (login {entry.items.login}, TOTP {entry.items.totp}, passkey{" "}
              {entry.items.passkey}) + {entry.items.unsupported} unsupported
            </Row>
          )}
          {entry.unlockKdf && <Row term="Unlock KDF (not copied)">{entry.unlockKdf}</Row>}
        </dl>
      ))}
    </section>
  );
}

function Service({ status }: { status: DiagnosticsStatus }) {
  const { service } = status;
  return (
    <section aria-labelledby="service-heading" className="panel">
      <h2 id="service-heading">Pateat service</h2>
      <dl>
        <Row term="Pairing" id="diagnostics-service">
          {service.kind}
          {service.rejected && " (rejected)"}
          {service.cacheFull && " (recipe cache full)"}
        </Row>
        {service.siteAccess !== undefined && (
          <Row term="Site access">{service.siteAccess ? "granted" : "withheld"}</Row>
        )}
        {service.health && (
          <Row term="Service revision">
            {service.health.ok
              ? shortRevision(service.health.revision)
              : `unavailable (${service.health.error}${service.health.status === undefined ? "" : ` ${service.health.status}`})`}
          </Row>
        )}
        {service.kind === "connected" && (
          <>
            <Row term="Last recipe sync">{time(service.syncedAt)}</Row>
            <Row term="Next recipe sync">{time(service.nextSyncAt)}</Row>
            <Row term="Settings revision">{service.settingsRevision ?? "—"}</Row>
            <Row term="Settings waiting for a login">{time(service.holdSince)}</Row>
            <Row term="Cached recipes">
              {service.recipes
                ? `${service.recipes.count} (${Math.ceil(service.recipes.bytes / 1024)} KB)`
                : "—"}
            </Row>
          </>
        )}
      </dl>
    </section>
  );
}

function Local({ status }: { status: DiagnosticsStatus }) {
  return (
    <section aria-labelledby="local-heading" className="panel">
      <h2 id="local-heading">Settings and storage</h2>
      <dl>
        {status.settings && (
          <Row term="Settings">
            excluded sites {status.settings.excludedSites}, site defaults{" "}
            {status.settings.siteDefaults}, bindings {status.settings.bindings}
          </Row>
        )}
        <Row term="storage.local">
          {status.storage.localBytes === undefined
            ? "—"
            : `${Math.ceil(status.storage.localBytes / 1024)} KB of 10 MB`}
        </Row>
        <Row term="Collected">{time(status.collectedAt)}</Row>
      </dl>
    </section>
  );
}

export function DiagnosticsApp({ client }: { client: DiagnosticsClient }) {
  const query = useQuery({
    queryKey: ["diagnostics"],
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
  const [message, setMessage] = useState("");
  const state = query.isFetching
    ? ({ kind: "loading" } as const)
    : query.isError || !query.data
      ? ({ kind: "failed" } as const)
      : ({ kind: "ready", ...query.data } as const);
  function refresh() {
    setPreview(undefined);
    setMessage("");
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
    <main className="mx-auto max-w-6xl px-5 py-10 sm:px-8 sm:py-14">
      <header className="mb-8 max-w-3xl">
        <p className="eyebrow">Pateat · This device</p>
        <h1>Diagnostics</h1>
        <p className="intro">
          Versions and state for bug reports. No passwords, keys, field values, names, emails or
          site addresses are shown or copied.
        </p>
      </header>
      <div className="mb-6 flex flex-wrap gap-3">
        <Button
          id="copy-report"
          type="button"
          disabled={state.kind !== "ready"}
          onClick={() => {
            if (state.kind === "ready") setPreview(formatReport(state.status, state.browser));
          }}
        >
          Copy for bug report
        </Button>
        <Button
          id="refresh-diagnostics"
          type="button"
          variant="outline"
          disabled={state.kind === "loading"}
          onClick={refresh}
        >
          Refresh
        </Button>
      </div>
      <output id="diagnostics-status" className="block" aria-live="polite">
        {state.kind === "loading"
          ? "Collecting diagnostics…"
          : state.kind === "failed"
            ? "Unable to collect diagnostics. Reload the extension and try again."
            : ""}
      </output>
      {preview !== undefined && (
        <section aria-labelledby="preview-heading" className="panel">
          <h2 id="preview-heading">Bug report text</h2>
          <p className="note">This exact text is copied. Check it before posting.</p>
          <pre id="report-preview" className="overflow-x-auto text-sm whitespace-pre-wrap">
            {preview}
          </pre>
          <div className="flex flex-wrap gap-3">
            <Button id="confirm-copy" type="button" onClick={() => void copy(preview)}>
              Copy
            </Button>
            <Button
              type="button"
              variant="outline"
              onClick={() => {
                setPreview(undefined);
                setMessage("");
              }}
            >
              Close
            </Button>
          </div>
          <output id="copy-status" className="block" aria-live="polite">
            {message}
          </output>
        </section>
      )}
      {state.kind === "ready" && (
        <>
          <Checks checks={state.status.checks} />
          <Version status={state.status} browser={state.browser} />
          <Connections status={state.status} />
          <Service status={state.status} />
          <Local status={state.status} />
        </>
      )}
    </main>
  );
}
