import {
  deviceLabelSchema,
  VISIBLE_LABEL_CHARACTER,
  normalizeServiceOrigin,
  type ServiceErrorCode,
  type ServiceResponse,
  type ServiceState,
} from "@pateat/contracts";
import { useTranslation } from "react-i18next";
import { formatLocale, i18n } from "../i18n";
import { useEffect, useEffectEvent, useRef, useState } from "react";
import { flushSync } from "react-dom";
import * as v from "valibot";
import { CircleCheck, CircleX, Clock, Link, Lock, TriangleAlert } from "lucide-react";
import { Button } from "./button";
import type { ServiceClient } from "./service-client";
import {
  Badge,
  controlClass,
  fieldClass,
  Panel,
  Row,
  RowList,
  RowSub,
  RowTitle,
  StatusLines,
} from "./ui";

/** How often the page checks whether the first sync after pairing finished. */
export const SYNC_POLL_MS = 10_000;

type ServiceMessage = string | { key: string; values?: Record<string, string | number> };

function errorMessage(error: ServiceErrorCode, origin?: string): ServiceMessage {
  switch (error) {
    case "storage-unavailable":
      return "Pateat could not read or save its service connection on this device.";
    case "storage-corrupt":
      return "Pateat cannot read its saved service connection. Forget it here, then revoke the old device on the service's management page if it was paired.";
    case "site-access-needed":
      return "Chrome is not letting Pateat reach this service. Allow site access when Chrome asks, or in the extension's site access settings.";
    case "unreachable":
      return "The service could not be reached. Check the address, then try again.";
    case "rate-limited":
      return "The service asked Pateat to slow down. Wait a minute, then try again.";
    case "unexpected-response":
      return "The service gave an unexpected answer. Check the address, then try again.";
    case "sign-in-needed":
      return {
        key: "Sign in to {{origin}} first: open the sign-in page, then come back here. If the service refuses your account, ask its operator.",
        values: origin ? { origin } : {},
      };
    case "sign-in-rejected":
      return "The service did not accept your sign-in.";
    case "extension-not-allowed":
      return "This service does not accept this build of Pateat. Its operator must add this extension's ID to PAIRING_EXTENSION_IDS.";
    case "pairing-unavailable":
      return "Pairing is not configured on this service.";
    case "access-keys-unavailable":
      return "The service could not check your sign-in. Try again later.";
    case "wrong-state":
      return "The connection changed elsewhere. This page now shows its current state.";
    case "invalid-request":
      return "That request was not valid.";
  }
}

/** A pairing the user asked for that has not succeeded yet. */
type Attempt = { origin: string; label: string; error: ServiceErrorCode };

export function ServiceConnection({
  client,
  pollMs = SYNC_POLL_MS,
}: {
  client: ServiceClient;
  pollMs?: number;
}) {
  const { t } = useTranslation(undefined, { i18n });
  const text = (value: ServiceMessage) =>
    typeof value === "string"
      ? t(value)
      : t(value.key, { origin: t("the service"), ...value.values });
  const syncTime = (value: number) => {
    try {
      return Temporal.Instant.fromEpochMilliseconds(value).toLocaleString(formatLocale(), {
        dateStyle: "medium",
        timeStyle: "short",
      });
    } catch {
      return t("at an unknown time");
    }
  };
  const [state, setState] = useState<ServiceState | undefined>();
  const [message, setMessage] = useState<ServiceMessage>("");
  const [busy, setBusy] = useState(false);
  const [address, setAddress] = useState("");
  const [label, setLabel] = useState("Chrome");
  const [addressError, setAddressError] = useState("");
  const [labelError, setLabelError] = useState("");
  const [corrupt, setCorrupt] = useState(false);
  const [attempt, setAttempt] = useState<Attempt | undefined>();
  const mounted = useRef(true);
  const checking = useRef(false);
  // Acquire synchronously: React state alone cannot stop a double click.
  const acting = useRef(false);
  // A one-shot retry for when the user comes back from the sign-in tab.
  const retryOnReturn = useRef<{ origin: string; label: string } | undefined>(undefined);
  const addressInput = useRef<HTMLInputElement>(null);
  const labelInput = useRef<HTMLInputElement>(null);
  // Counts edits so a request that answers after one does not leave a retry behind.
  const edits = useRef(0);

  /** An edited address or device name is a new request: drop the old one's retry. */
  function edited() {
    edits.current += 1;
    retryOnReturn.current = undefined;
    setAttempt(undefined);
  }

  function receive(response: ServiceResponse, success?: ServiceMessage) {
    if (!mounted.current) return;
    // Any response carrying a state proves the stored record is readable.
    if (response.ok || response.state) setCorrupt(false);
    else if (response.error === "storage-corrupt") setCorrupt(true);
    if (response.ok) {
      setState(response.state);
      if (success !== undefined) setMessage(success);
    } else {
      if (response.state) setState(response.state);
      setMessage(errorMessage(response.error));
    }
  }
  async function act(run: () => Promise<void>) {
    if (acting.current) return;
    acting.current = true;
    setBusy(true);
    try {
      await run();
    } catch {
      if (mounted.current) setMessage("The extension did not answer. Reload this page to retry.");
    } finally {
      acting.current = false;
      if (mounted.current) setBusy(false);
    }
  }

  /**
   * Opens the sign-in page and retries once when this page is shown again,
   * unless the address or device name was edited while the tab opened.
   */
  async function openSignIn(origin: string, name: string) {
    const edit = edits.current;
    await client.openSignIn(origin);
    if (edit === edits.current) retryOnReturn.current = { origin, label: name };
  }

  /**
   * Sends one pairing request. Only the Pair click itself opens the sign-in page;
   * a retry that still needs a sign-in leaves that to the "Open sign-in page" button.
   * `edit` is the edit count when the user asked; an edit since then drops the retry.
   */
  async function pair(origin: string, name: string, signInTab: boolean, edit = edits.current) {
    retryOnReturn.current = undefined;
    const response = await client.pair(origin, name);
    if (!mounted.current) return;
    if (response.ok) {
      setAttempt(undefined);
      receive(response, "This device is paired.");
      return;
    }
    receive(response);
    if (edit !== edits.current || (response.state && response.state.kind !== "disconnected")) {
      setAttempt(undefined);
      return;
    }
    setAttempt({ origin, label: name, error: response.error });
    if (response.error !== "sign-in-needed") return;
    if (signInTab) {
      await openSignIn(origin, name);
      if (mounted.current)
        setMessage({
          key: "Sign in to {{origin}} in the new tab, then come back here. If the service refuses your account, ask its operator.",
          values: { origin },
        });
    } else setMessage(errorMessage("sign-in-needed", origin));
  }

  useEffect(() => {
    mounted.current = true;
    void client.get().then(
      (response) => receive(response),
      () => setMessage("The extension did not answer. Reload this page to retry."),
    );
    return () => {
      mounted.current = false;
    };
    // `receive` touches only state setters and refs; load once per client.
    // oxlint-disable-next-line react/exhaustive-effect-dependencies
  }, [client]);

  // Coming back from the sign-in tab retries once. Focus and visibility often fire
  // together, so the first one takes the retry; the tab opening only hides this page.
  // The retry passes no sign-in tab, so only a click ever opens one.
  const retryAfterSignIn = useEffectEvent(() => {
    const pending = retryOnReturn.current;
    if (!pending || document.visibilityState !== "visible" || acting.current) return;
    retryOnReturn.current = undefined;
    void act(() => pair(pending.origin, pending.label, false));
  });
  useEffect(() => {
    const returned = () => retryAfterSignIn();
    const controller = new AbortController();
    const { signal } = controller;
    document.addEventListener("visibilitychange", returned, { signal });
    window.addEventListener("focus", returned, { signal });
    return () => controller.abort();
  }, []);

  // The first sync runs in the background after pairing; show when it finishes.
  const awaitingSync =
    state?.kind === "connected" &&
    state.syncedAt === undefined &&
    !state.rejected &&
    !state.cacheFull;
  useEffect(() => {
    if (!awaitingSync) return;
    const timer = setInterval(() => {
      if (checking.current || acting.current) return;
      checking.current = true;
      void client
        .get()
        .then(
          (response) => receive(response),
          () => undefined,
        )
        .finally(() => {
          checking.current = false;
        });
    }, pollMs);
    return () => clearInterval(timer);
    // `receive` touches only state setters and refs; restart only when waiting toggles.
    // oxlint-disable-next-line react/exhaustive-effect-dependencies
  }, [client, awaitingSync, pollMs]);

  return (
    <Panel id="sync" headingId="sync-service-heading" title={t("Sync service")}>
      <output
        id="sync-service-status"
        className="settings-status block text-sm leading-5"
        aria-live="polite"
        aria-atomic="true"
      >
        {message ? text(message) : ""}
      </output>
      {corrupt && (
        <div>
          <Button
            id="sync-service-forget"
            type="button"
            variant="outline"
            disabled={busy}
            onClick={() =>
              void act(async () => receive(await client.forget(), "Saved connection forgotten."))
            }
          >
            {t("Forget saved connection")}
          </Button>
        </div>
      )}
      {state?.kind === "disconnected" && (
        <form
          noValidate
          className="flex flex-col gap-3"
          onSubmit={(event) => {
            event.preventDefault();
            const origin = normalizeServiceOrigin(address);
            const name = v.safeParse(deviceLabelSchema, label);
            // Each field shows its own error, and the first invalid one takes focus
            // after the error is linked, so the field is announced with it.
            flushSync(() => {
              setAddressError(
                origin ? "" : "Enter an HTTPS address such as https://pateat.example.com.",
              );
              setLabelError(
                name.success
                  ? ""
                  : // A name of invisible characters alone looks empty, so it reads as missing.
                    VISIBLE_LABEL_CHARACTER.test(label)
                    ? "Use a device name of up to 64 characters without control characters, line breaks or text-direction marks."
                    : "Enter a device name.",
              );
            });
            if (!origin) addressInput.current?.focus();
            else if (!name.success) labelInput.current?.focus();
            if (!origin || !name.success) return;
            // Read before the site access prompt, so an edit while it is open counts.
            const edit = edits.current;
            void act(async () => {
              // Requested before any other await so Chrome still sees the click.
              if (!(await client.requestSiteAccess(origin))) {
                if (mounted.current) setMessage(errorMessage("site-access-needed"));
                return;
              }
              await pair(origin, name.output, true, edit);
            });
          }}
        >
          <div className="grid gap-x-4 gap-y-3 sm:grid-cols-2">
            <label className={fieldClass}>
              {t("Service address")}
              <input
                id="sync-service-address"
                ref={addressInput}
                className={controlClass}
                type="url"
                inputMode="url"
                autoComplete="off"
                spellCheck={false}
                placeholder="https://pateat.example.com"
                value={address}
                aria-invalid={addressError ? true : undefined}
                aria-describedby={addressError ? "sync-service-address-error" : undefined}
                onChange={(event) => {
                  setAddress(event.target.value);
                  edited();
                }}
              />
            </label>
            <label className={fieldClass}>
              {t("Device name")}
              <input
                id="sync-service-label"
                ref={labelInput}
                className={controlClass}
                type="text"
                maxLength={64}
                autoComplete="off"
                value={label}
                aria-invalid={labelError ? true : undefined}
                aria-describedby={labelError ? "sync-service-label-error" : undefined}
                onChange={(event) => {
                  setLabel(event.target.value);
                  edited();
                }}
              />
            </label>
          </div>
          {addressError && (
            <p id="sync-service-address-error" className="validation-error m-0" role="alert">
              {t(addressError)}
            </p>
          )}
          {labelError && (
            <p id="sync-service-label-error" className="validation-error m-0" role="alert">
              {t(labelError)}
            </p>
          )}
          <StatusLines
            muted
            lines={[
              {
                tone: "idle",
                icon: Lock,
                text: t(
                  "Syncs recipes, site exclusions, saved accounts and account bindings. Never sends vault values, passwords or keys.",
                ),
              },
            ]}
          />
          <div className="flex flex-wrap gap-2">
            <Button id="sync-service-pair" type="submit" disabled={busy}>
              {t("Pair this device")}
            </Button>
            {attempt && (
              <Button
                id="sync-service-retry"
                type="button"
                variant="outline"
                disabled={busy}
                onClick={() => {
                  const edit = edits.current;
                  void act(async () => {
                    // Requested before any other await so Chrome still sees the click.
                    if (!(await client.requestSiteAccess(attempt.origin))) {
                      if (mounted.current) setMessage(errorMessage("site-access-needed"));
                      return;
                    }
                    await pair(attempt.origin, attempt.label, false, edit);
                  });
                }}
              >
                {t("Try again")}
              </Button>
            )}
            {attempt?.error === "sign-in-needed" && (
              <Button
                id="sync-service-sign-in"
                type="button"
                variant="outline"
                disabled={busy}
                onClick={() => void act(() => openSignIn(attempt.origin, attempt.label))}
              >
                {t("Open sign-in page")}
              </Button>
            )}
          </div>
        </form>
      )}
      {state?.kind === "connected" && (
        <RowList>
          <Row
            icon={Link}
            main={
              <>
                <RowTitle>
                  <span>{new URL(state.origin).host}</span>
                  <Badge>{t("Paired")}</Badge>
                </RowTitle>
                <RowSub>{t("Named {{label}} on the service", { label: state.label })}</RowSub>
                <StatusLines
                  id="sync-service-recipes"
                  lines={[
                    state.rejected
                      ? {
                          tone: "err",
                          icon: CircleX,
                          text: t(
                            "The service no longer accepts this device. Login keeps using the recipes synced before; disconnect and pair again to sync.",
                          ),
                        }
                      : state.cacheFull
                        ? {
                            tone: "warn",
                            icon: TriangleAlert,
                            text: t(
                              "Your recipes or settings no longer fit, so newer changes are not applied. Login keeps using what was synced before.",
                            ),
                          }
                        : state.syncedAt === undefined
                          ? {
                              tone: "idle",
                              icon: Clock,
                              text: t("Recipes and settings have not finished syncing yet"),
                            }
                          : {
                              tone: "ok",
                              icon: CircleCheck,
                              text: t("Recipes and settings synced {{time}}", {
                                time: syncTime(state.syncedAt),
                              }),
                            },
                  ]}
                />
              </>
            }
            actions={
              <Button
                id="sync-service-disconnect"
                type="button"
                variant="danger"
                disabled={busy}
                onClick={() =>
                  void act(async () => {
                    const response = await client.disconnect();
                    receive(
                      response,
                      response.ok && response.revoked === false
                        ? {
                            key: "Disconnected on this device, but the service could not confirm it. Revoke this device from {{url}} in a browser that can open it.",
                            values: { url: `${state.origin}/manage` },
                          }
                        : "Disconnected. The service no longer accepts this device.",
                    );
                  })
                }
              >
                {t("Disconnect this device")}
              </Button>
            }
          />
        </RowList>
      )}
    </Panel>
  );
}
