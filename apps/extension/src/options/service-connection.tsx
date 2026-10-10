import {
  normalizeServiceOrigin,
  type ServiceErrorCode,
  type ServiceResponse,
  type ServiceState,
} from "@pateat/contracts";
import { useEffect, useRef, useState } from "react";
import { Button } from "./button";
import type { ServiceClient } from "./service-client";

/** The service allows about 10 redemption attempts a minute per address; the background paces them too. */
export const PAIRING_POLL_MS = 10_000;

function errorMessage(error: ServiceErrorCode): string {
  switch (error) {
    case "storage-unavailable":
      return "Pateat could not read or save its service connection on this device.";
    case "storage-corrupt":
      return "Pateat cannot read its saved service connection. Forget it here, then revoke the old device on the service's management page if it was paired.";
    case "site-access-needed":
      return "Chrome is not letting Pateat reach this service. Pair again and allow site access when Chrome asks, or allow it in the extension's site access settings.";
    case "unreachable":
      return "The service could not be reached. Pateat keeps trying while this page is open.";
    case "rate-limited":
      return "The service asked Pateat to slow down. Pateat keeps trying while this page is open.";
    case "unexpected-response":
      return "The service gave an unexpected answer. Check the address, or cancel and pair again.";
    case "code-mismatch":
      return "The approval page has a different code. Retype the code shown here on that page. If it says another account approved this request, cancel and pair again.";
    case "pairing-expired":
      return "Pairing expired before this device received its credential. Start again. If you had approved it, remove the unused device on the service's management page.";
    case "wrong-state":
      return "The connection changed elsewhere. This page now shows its current state.";
    case "invalid-request":
      return "That request was not valid.";
  }
}

export function ServiceConnection({
  client,
  pollMs = PAIRING_POLL_MS,
}: {
  client: ServiceClient;
  pollMs?: number;
}) {
  const [state, setState] = useState<ServiceState | undefined>();
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const [address, setAddress] = useState("");
  const [label, setLabel] = useState("Chrome");
  const [addressError, setAddressError] = useState("");
  const [corrupt, setCorrupt] = useState(false);
  const mounted = useRef(true);
  const checking = useRef(false);
  // Acquire synchronously: React state alone cannot stop a double click.
  const acting = useRef(false);

  function receive(response: ServiceResponse, success?: string) {
    if (!mounted.current) return;
    setCorrupt(!response.ok && response.error === "storage-corrupt");
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

  // Redemption is polled only while this page is open and a pairing is pending.
  const pairing = state?.kind === "pairing";
  useEffect(() => {
    if (!pairing) return;
    const timer = setInterval(() => {
      // A tick during cancel would only report the state that cancel already changed.
      if (checking.current || acting.current) return;
      checking.current = true;
      void client
        .check()
        .then(
          (response) =>
            receive(
              response,
              !response.ok
                ? undefined
                : response.state.kind === "connected"
                  ? "This device is paired."
                  : "Waiting for approval on the service.",
            ),
          () => undefined,
        )
        .finally(() => {
          checking.current = false;
        });
    }, pollMs);
    return () => clearInterval(timer);
    // `receive` touches only state setters and refs; restart only when pairing toggles.
    // oxlint-disable-next-line react/exhaustive-effect-dependencies
  }, [client, pairing, pollMs]);

  return (
    <section className="panel" aria-labelledby="service-heading">
      <h2 id="service-heading">Sync service</h2>
      <p className="note">
        Optional. Pair this device with your own Pateat service to sync settings and recipes later.
        Pairing never sends vault values, passwords or keys.
      </p>
      <output
        id="service-status"
        className="settings-status block"
        aria-live="polite"
        aria-atomic="true"
      >
        {message}
      </output>
      {corrupt && (
        <div>
          <Button
            id="service-forget"
            type="button"
            variant="outline"
            disabled={busy}
            onClick={() =>
              void act(async () => receive(await client.forget(), "Saved connection forgotten."))
            }
          >
            Forget saved connection
          </Button>
        </div>
      )}
      {state?.kind === "disconnected" && (
        <form
          className="grid gap-3"
          noValidate
          onSubmit={(event) => {
            event.preventDefault();
            const origin = normalizeServiceOrigin(address);
            if (!origin) {
              setAddressError("Enter an HTTPS address such as https://pateat.example.com.");
              return;
            }
            const name = label.trim();
            if (!name) {
              setAddressError("Enter a device name.");
              return;
            }
            setAddressError("");
            void act(async () => {
              // Requested before any other await so Chrome still sees the click.
              if (!(await client.requestSiteAccess(origin))) {
                if (mounted.current) setMessage(errorMessage("site-access-needed"));
                return;
              }
              receive(
                await client.start(origin, name),
                "Pairing started. Approve it with the code below.",
              );
            });
          }}
        >
          <label>
            Service address
            <input
              id="service-address"
              type="url"
              inputMode="url"
              autoComplete="off"
              spellCheck={false}
              placeholder="https://pateat.example.com"
              value={address}
              aria-invalid={addressError ? true : undefined}
              aria-describedby={addressError ? "service-error" : undefined}
              onChange={(event) => setAddress(event.target.value)}
            />
          </label>
          <label>
            Device name
            <input
              id="service-label"
              maxLength={64}
              autoComplete="off"
              value={label}
              onChange={(event) => setLabel(event.target.value)}
            />
          </label>
          {addressError && (
            <p id="service-error" className="validation-error" role="alert">
              {addressError}
            </p>
          )}
          <div>
            <Button id="service-pair" type="submit" disabled={busy}>
              Pair this device
            </Button>
          </div>
        </form>
      )}
      {state?.kind === "pairing" && (
        <div className="grid gap-3">
          <p>
            Pairing <strong>{state.label}</strong> with {state.origin}. Open the approval page, sign
            in, and type this code:
          </p>
          <p id="service-code" className="text-2xl font-semibold tracking-widest">
            {state.code}
          </p>
          <p className="note">
            Pateat checks for approval while this page stays open. The request expires at{" "}
            {new Date(state.expiresAt).toLocaleTimeString()}.
          </p>
          <div className="flex flex-wrap gap-2">
            <Button
              id="service-open"
              type="button"
              disabled={busy}
              onClick={() => void act(() => client.openApproval(state.enrollUrl))}
            >
              Open approval page
            </Button>
            <Button
              id="service-cancel"
              type="button"
              variant="outline"
              disabled={busy}
              onClick={() =>
                void act(async () => receive(await client.cancel(), "Pairing cancelled."))
              }
            >
              Cancel pairing
            </Button>
          </div>
        </div>
      )}
      {state?.kind === "connected" && (
        <div className="grid gap-3">
          <p>
            <strong>{state.label}</strong> is paired with {state.origin}.
          </p>
          <div>
            <Button
              id="service-disconnect"
              type="button"
              variant="outline"
              disabled={busy}
              onClick={() =>
                void act(async () => {
                  const response = await client.disconnect();
                  receive(
                    response,
                    response.ok && response.revoked === false
                      ? `Disconnected on this device, but the service could not confirm it. Revoke this device from ${state.origin}/manage.`
                      : "Disconnected. The service no longer accepts this device.",
                  );
                })
              }
            >
              Disconnect this device
            </Button>
          </div>
        </div>
      )}
    </section>
  );
}
