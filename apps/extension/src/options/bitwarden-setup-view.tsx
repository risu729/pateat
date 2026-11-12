import { AlertDialog } from "@base-ui/react/alert-dialog";
import { Clock, Globe, Info, Lock, RefreshCw, TriangleAlert } from "lucide-react";
import { formatLocale } from "../i18n";
import { localClockTime } from "../time";
import { Button } from "./button";
import {
  checkClass,
  controlClass,
  fieldClass,
  groupClass,
  Panel,
  StatusLines,
  type Tone,
} from "./ui";
import type { EmailCode } from "./bitwarden-setup-types";
import type { BitwardenSetupModel } from "./use-bitwarden-setup";
import { listHosts } from "./bitwarden-connection-status";
import { deleteDialog } from "./bitwarden-delete-dialog";
import { renderConnectionRows } from "./bitwarden-connection-rows";
import { renderFieldReviews } from "./bitwarden-setup-review";

/**
 * The official browser extension's `ACCOUNT_LIMIT`. Pateat does not cap connections but
 * warns past it, since each unlocked vault keeps its own Worker in memory.
 */
const BITWARDEN_ACCOUNT_LIMIT = 5;
const emailCodeLines: Record<EmailCode, { tone: Tone; text: string }> = {
  sending: { tone: "idle", text: "Asking the server to email a verification code…" },
  sent: {
    tone: "ok",
    text: "The server sent a verification code to the account's two-step email.",
  },
  "rate-limited": {
    tone: "warn",
    text: "The server is limiting code emails. Wait a few minutes before resending.",
  },
  unavailable: {
    tone: "warn",
    text: "This server cannot send email codes. Use another method or a code you already received.",
  },
  refused: { tone: "warn", text: "The server did not send a code. Resend or use another method." },
  failed: { tone: "err", text: "The code email could not be requested. Resend to try again." },
};

/** Hook-free rendering keeps the existing element ancestry and component lifetimes. */
export function renderBitwardenSetup(model: BitwardenSetupModel) {
  const {
    t,
    busy,
    challenge,
    formOpen,
    cancel,
    start,
    readConnections,
    generation,
    say,
    statusOutput,
    message,
    connections,
    keepConnectionButton,
    deleting,
    menuTriggers,
    receive,
    client,
    renderOthers,
    statusKnown,
    refused,
    provider,
    setProvider,
    codeInput,
    code,
    setCode,
    emailCode,
    sendEmailCode,
    continueSetup,
    cancelable,
    existing,
    setAddOpen,
    ended,
    regionSelect,
    region,
    setRegion,
    baseUrl,
    setBaseUrl,
    name,
    setName,
    email,
    setEmail,
    passwordInput,
    password,
    setPassword,
    enabled,
    setEnabled,
    origins,
    connect,
    clearSecrets,
    setExisting,
    setEnded,
    focusNext,
  } = model;
  const cancelButton = (id?: string) => (
    <Button id={id} type="button" variant="outline" disabled={!cancelable} onClick={() => cancel()}>
      {t("Cancel setup")}
    </Button>
  );
  return (
    <Panel
      id="bitwarden"
      headingId="bitwarden-setup-heading"
      title={t("Bitwarden")}
      actions={
        <div className="flex flex-wrap gap-2">
          {/* While a row's operation runs with the form closed, it can still be stopped. */}
          {busy && !challenge && !formOpen && (
            <Button
              type="button"
              variant="outline"
              onClick={() => cancel("Stopped. Refresh to see the current state.")}
            >
              {t("Cancel")}
            </Button>
          )}
          <Button
            id="bitwarden-refresh-connections"
            type="button"
            variant="ghost"
            aria-label={t("Refresh connections")}
            disabled={busy || !!challenge}
            focusableWhenDisabled={busy}
            onClick={() =>
              start(async (epoch) => {
                await readConnections(epoch);
                if (epoch === generation.current) say("Connection status refreshed.");
              })
            }
          >
            <RefreshCw aria-hidden size={16} strokeWidth={2} />
            {t("Refresh")}
          </Button>
        </div>
      }
    >
      <output
        id="bitwarden-setup-status"
        ref={statusOutput}
        tabIndex={-1}
        className="settings-status block text-sm leading-5"
        aria-live="polite"
        aria-atomic="true"
      >
        {typeof message === "function" ? message(t) : t(message)}
      </output>
      {renderConnectionRows(model)}
      {connections.length > BITWARDEN_ACCOUNT_LIMIT && (
        <StatusLines
          lines={[
            {
              tone: "warn",
              icon: TriangleAlert,
              text: t(
                "More than 5 connections. The official Bitwarden extension allows up to 5 accounts, and each unlocked vault uses more memory.",
              ),
            },
          ]}
        />
      )}
      <AlertDialog.Root
        handle={deleteDialog}
        onOpenChange={(open, details) => {
          if (!open && details.reason === "escape-key") say("Connection kept.");
        }}
      >
        {({ payload }) => (
          <AlertDialog.Portal>
            <AlertDialog.Backdrop
              id="bitwarden-delete-backdrop"
              className="fixed inset-0 bg-black/40 transition-opacity duration-150 data-ending-style:opacity-0 data-starting-style:opacity-0"
            />
            <AlertDialog.Popup
              className="fixed top-1/2 left-1/2 max-h-[calc(100dvh-2rem)] w-[calc(100%-2rem)] max-w-lg -translate-x-1/2 -translate-y-1/2 overflow-y-auto rounded-xl border border-border bg-surface p-6 text-ink shadow-[var(--shadow-menu)] outline-none transition-opacity duration-150 data-ending-style:opacity-0 data-starting-style:opacity-0"
              initialFocus={keepConnectionButton}
              finalFocus={() => {
                // Deleting removes the row's menu; the status reports the outcome either way.
                if (deleting.current) {
                  deleting.current = false;
                  return statusOutput.current ?? true;
                }
                return (payload && menuTriggers.current.get(payload.connectionId)) ?? true;
              }}
            >
              <AlertDialog.Title className="m-0 text-lg font-semibold wrap-anywhere">
                {t("Delete {{name}}?", { name: payload?.label })}
              </AlertDialog.Title>
              <AlertDialog.Description className="my-4 text-sm leading-6">
                {t(
                  "This removes the connection, its local vault copy, unlock key and sync sign-in from this device. It does not sign out other sessions, and the synced settings of its account stay for other devices and a later connection.",
                )}
              </AlertDialog.Description>
              <div className="flex flex-wrap justify-end gap-2">
                <AlertDialog.Close
                  ref={keepConnectionButton}
                  render={<Button variant="outline" />}
                  onClick={() => {
                    if (deleteDialog.isOpen) say("Connection kept.");
                  }}
                >
                  {t("Keep connection")}
                </AlertDialog.Close>
                <AlertDialog.Close
                  render={<Button variant="danger" />}
                  disabled={busy || !!challenge || !payload}
                  onClick={() => {
                    // Close retains these buttons during its exit animation.
                    if (!deleteDialog.isOpen || !payload) return;
                    deleting.current = true;
                    start(async (epoch) => {
                      await receive(await client.deleteConnection(payload.connectionId), epoch);
                    });
                  }}
                >
                  {t("Delete connection")}
                </AlertDialog.Close>
              </div>
            </AlertDialog.Popup>
          </AlertDialog.Portal>
        )}
      </AlertDialog.Root>
      {renderOthers?.(
        statusKnown ? connections.map((connection) => connection.connectionId) : undefined,
      )}
      {renderFieldReviews(model)}
      {challenge ? (
        <div className={groupClass}>
          <fieldset className="m-0 flex min-w-0 flex-col gap-3 border-0 p-0" disabled={busy}>
            <legend className="mb-3 p-0 font-semibold">{t("Manual verification")}</legend>
            <StatusLines
              id="bitwarden-code-deadline"
              muted
              lines={[
                ...(refused
                  ? [
                      {
                        tone: "warn" as const,
                        icon: TriangleAlert,
                        text:
                          challenge.kind === "mfa-required" && provider === 0
                            ? t(
                                "The code was not accepted: it is wrong or no longer valid. Enter the current code from the authenticator app.",
                              )
                            : challenge.kind === "mfa-required"
                              ? t(
                                  "The code was not accepted: it is wrong or no longer valid. Enter the code from the latest email, or Resend code.",
                                )
                              : t(
                                  "The code was not accepted: it is wrong or no longer valid. Enter the code from the latest email.",
                                ),
                      },
                    ]
                  : []),
                {
                  tone: "idle",
                  icon: Clock,
                  text: t(
                    "Enter the code by {{time}}. After that the sign-in ends and needs the master password again.",
                    { time: localClockTime(challenge.expiresAt, formatLocale()) },
                  ),
                },
              ]}
            />
            {challenge.kind === "mfa-required" ? (
              <div className="grid gap-x-4 gap-y-3 sm:grid-cols-2">
                <label className={fieldClass}>
                  {t("Verification method")}
                  <select
                    id="bitwarden-mfa-provider"
                    className={controlClass}
                    value={provider}
                    onChange={(event) => setProvider(event.target.value === "1" ? 1 : 0)}
                  >
                    {challenge.providers.map((id) => (
                      <option key={id} value={id}>
                        {t(id === 0 ? "Authenticator code" : "Email code")}
                      </option>
                    ))}
                  </select>
                </label>
                <label className={fieldClass}>
                  {t("Verification code")}
                  <input
                    id="bitwarden-code"
                    ref={codeInput}
                    className={controlClass}
                    aria-describedby="bitwarden-code-deadline"
                    type="password"
                    autoComplete="off"
                    maxLength={1024}
                    value={code}
                    onChange={(event) => setCode(event.target.value)}
                  />
                </label>
              </div>
            ) : (
              <label className={fieldClass}>
                {t("New-device verification code")}
                <input
                  id="bitwarden-new-device-otp"
                  ref={codeInput}
                  className={controlClass}
                  aria-describedby="bitwarden-code-deadline"
                  type="password"
                  autoComplete="off"
                  maxLength={1024}
                  value={code}
                  onChange={(event) => setCode(event.target.value)}
                />
              </label>
            )}
            {provider === 1 && challenge.kind === "mfa-required" && (
              <div className="flex flex-wrap items-center gap-2">
                {/* The send's answer is read out; the panel status keeps the sign-in step. */}
                <output className="block" aria-live="polite">
                  {emailCode && (
                    <StatusLines
                      id="bitwarden-email-code"
                      muted
                      lines={[
                        {
                          ...emailCodeLines[emailCode],
                          text: t(emailCodeLines[emailCode].text),
                          icon: Info,
                        },
                      ]}
                    />
                  )}
                </output>
                <Button
                  id="bitwarden-resend-code"
                  type="button"
                  variant="ghost"
                  disabled={busy}
                  onClick={() => sendEmailCode(challenge.flowId)}
                >
                  {t("Resend code")}
                </Button>
              </div>
            )}
          </fieldset>
          <div className="flex flex-wrap gap-2">
            <Button
              id="bitwarden-continue"
              type="button"
              focusableWhenDisabled={busy}
              disabled={
                busy ||
                !code.trim() ||
                (challenge.kind === "mfa-required" && !challenge.providers.length)
              }
              onClick={continueSetup}
            >
              {t("Verify code")}
            </Button>
            {cancelButton("bitwarden-cancel")}
          </div>
        </div>
      ) : (
        <details
          className={groupClass}
          open={formOpen}
          onToggle={(event) => {
            // Toggle events also follow the page's own changes; keep only the owner's.
            const open = event.currentTarget.open;
            if (open !== formOpen) setAddOpen(open);
          }}
        >
          <summary className="cursor-pointer font-semibold">
            {existing
              ? t("Sign in to {{name}} again", { name: existing.label })
              : t("Add a connection")}
          </summary>
          <fieldset className="m-0 flex min-w-0 flex-col gap-3 border-0 p-0" disabled={busy}>
            <legend className="visually-hidden">
              {existing
                ? t("Sign in to {{name}} again", { name: existing.label })
                : t("Add a connection")}
            </legend>
            {ended && (
              <StatusLines
                id="bitwarden-sign-in-ended"
                lines={[
                  {
                    tone: "warn",
                    icon: TriangleAlert,
                    text: typeof ended === "function" ? ended(t) : t(ended),
                  },
                ]}
              />
            )}
            <div className="grid gap-x-4 gap-y-3 sm:grid-cols-2">
              {!existing && (
                <>
                  <label className={fieldClass}>
                    {t("Server")}
                    <select
                      id="bitwarden-region"
                      ref={regionSelect}
                      className={controlClass}
                      value={region}
                      onChange={(event) => setRegion(event.target.value)}
                    >
                      <option value="us">{t("Bitwarden Cloud US")}</option>
                      <option value="eu">{t("Bitwarden Cloud EU")}</option>
                      <option value="self-hosted">{t("Self-hosted")}</option>
                    </select>
                  </label>
                  {region === "self-hosted" && (
                    <label className={fieldClass}>
                      {t("Server address")}
                      <input
                        id="bitwarden-base-url"
                        className={controlClass}
                        type="text"
                        maxLength={2048}
                        placeholder="https://vault.example.com"
                        value={baseUrl}
                        onChange={(event) => setBaseUrl(event.target.value)}
                      />
                    </label>
                  )}
                  <label className={fieldClass}>
                    {t("Name")}
                    <input
                      id="bitwarden-name"
                      className={controlClass}
                      type="text"
                      maxLength={200}
                      placeholder={t("Personal")}
                      value={name}
                      onChange={(event) => setName(event.target.value)}
                    />
                  </label>
                  <label className={fieldClass}>
                    {t("Email")}
                    <input
                      id="bitwarden-email"
                      className={controlClass}
                      type="email"
                      autoComplete="username"
                      maxLength={320}
                      value={email}
                      onChange={(event) => setEmail(event.target.value)}
                    />
                  </label>
                </>
              )}
              {existing && (
                <div className={fieldClass}>
                  {t("Email")}
                  <span className="flex min-h-10 items-center font-normal">{existing.email}</span>
                </div>
              )}
              <label className={fieldClass}>
                {t("Master password")}
                <input
                  id="bitwarden-password"
                  ref={passwordInput}
                  className={controlClass}
                  aria-describedby={ended ? "bitwarden-sign-in-ended" : undefined}
                  type="password"
                  autoComplete="off"
                  value={password}
                  onChange={(event) => setPassword(event.target.value)}
                />
              </label>
            </div>
            {!existing && (
              <label className={checkClass}>
                <input
                  id="bitwarden-enabled"
                  type="checkbox"
                  checked={enabled}
                  onChange={(event) => setEnabled(event.target.checked)}
                />
                {t("Use this vault")}
              </label>
            )}
            <StatusLines
              muted
              lines={[
                // Past the limit, the same warning already stands under the list.
                ...(!existing && connections.length === BITWARDEN_ACCOUNT_LIMIT
                  ? [
                      {
                        tone: "warn" as const,
                        icon: TriangleAlert,
                        text: t(
                          "More than 5 connections. The official Bitwarden extension allows up to 5 accounts, and each unlocked vault uses more memory.",
                        ),
                      },
                    ]
                  : []),
                {
                  tone: "idle",
                  icon: Lock,
                  text: t(
                    "The master password and verification codes are not saved. An encrypted vault copy and a sync sign-in stay on this device, and its unlock key too while the vault timeout is Never.",
                  ),
                },
                origins.ok
                  ? {
                      tone: "idle",
                      icon: Globe,
                      text: t("Chrome asks for access to {{hosts}}.", {
                        hosts: listHosts(origins.data, formatLocale()),
                      }),
                    }
                  : {
                      tone: "warn",
                      icon: TriangleAlert,
                      text: t("Enter an HTTPS server address, or HTTP on localhost or 127.0.0.1."),
                    },
              ]}
            />
          </fieldset>
          <div className="flex flex-wrap gap-2">
            <Button
              id="bitwarden-connect"
              type="button"
              disabled={busy}
              focusableWhenDisabled={busy}
              onClick={connect}
            >
              {t(existing ? "Sign in and sync" : "Connect Bitwarden")}
            </Button>
            {existing && (
              <Button
                id="bitwarden-add-new"
                type="button"
                variant="outline"
                disabled={busy}
                onClick={() => {
                  clearSecrets();
                  setExisting(undefined);
                  setEnded(undefined);
                  // This button leaves with the sign-in form; continue in the new one.
                  focusNext.current = regionSelect;
                }}
              >
                {t("Add another connection")}
              </Button>
            )}
            {cancelButton("bitwarden-cancel")}
          </div>
        </details>
      )}
    </Panel>
  );
}
