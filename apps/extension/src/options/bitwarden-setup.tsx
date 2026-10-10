import { normalizeBitwardenProfile, type BitwardenProfile } from "@pateat/bitwarden";
import type { SettingsResponse, VaultItemMetadata } from "@pateat/contracts";
import { useEffect, useRef, useState } from "react";
import type { SetupBegin, SetupReply } from "../connections/types";
import { providerPermissionOrigins } from "../connections/permissions";
import { Button } from "./button";
import type { ConnectionClient } from "./connection-client";

type StatusReply = Extract<SetupReply, { kind: "status" }>;
type Challenge = Extract<SetupReply, { kind: "mfa-required" | "new-device-verification-required" }>;
type Connection = StatusReply["connections"][number];
const inputClass = "w-full rounded-lg border border-slate-400 bg-white px-3 py-2.5";
function errorMessage(code: string): string {
  const messages: Record<string, string> = {
    "provider-permission-required":
      "Provider access was not granted. Use the connection button to grant access.",
    "setup-reauthentication-required":
      "Sign in again to sync. The saved local vault can still unlock independently.",
    "auto-unlock-disabled":
      "Automatic unlock is off for this connection, and Sync needs it. Sign in again and check Enable automatic unlock on this device to restore it.",
    "crypto-locked": "The vault is locked. Refresh connections to check recovery options.",
    "resource-limit":
      "The operation reached a resource limit. Refresh connections to check the current vault status before trying again.",
    "cache-quota-exceeded":
      "The vault exceeds the local cache limit. Refresh connections to check the current vault status.",
    "storage-uncertain":
      "The cache update could not be confirmed. Refresh connections and reload saved settings before using this vault.",
    "setup-expired": "This verification session expired. Start sign-in again.",
    "unsupported-crypto": "This account uses an unsupported vault format. Setup is incomplete.",
    "invalid-response": "The provider response could not be accepted. Setup is incomplete.",
    "authentication-rejected":
      "The provider rejected this sign-in. Review the account and password before starting again.",
    "authentication-expired": "The provider session expired. Sign in again to sync.",
    "revision-conflict":
      "Saved settings changed. Reload saved settings and review the current field list before trying again.",
  };
  return (
    messages[code] ??
    `Connection operation unavailable (${code}). Refresh connections before trying again.`
  );
}
function stateLabel(connection: Connection): string {
  switch (connection.state) {
    case "ready":
      return "Local vault ready";
    case "disabled":
      return "Automatic unlock disabled";
    case "review-required":
      return "Some items need their field settings reviewed before use";
    case "configured":
      return "Setup incomplete or vault locked · sign in again";
    case "unavailable":
      return "Vault unavailable · refresh or sign in again";
  }
}

function sessionLabel(connection: Connection): string {
  switch (connection.providerSession) {
    case "active":
      return "Sync sign-in saved on this device";
    case "refresh-required":
      return "Sync sign-in saved · it renews on the next sync";
    case "reauthentication-required":
      return "Sign in again to sync";
    case "none":
      return "Not signed in for sync";
    case "unavailable":
      return "Sync sign-in unavailable · sign in again";
  }
}

function FieldReview({
  item,
  disabled,
  onReview,
}: {
  item: VaultItemMetadata;
  disabled: boolean;
  onReview: (excludedFieldIds: string[]) => void;
}) {
  const fields = item.fields.filter((field) => field.id.startsWith("custom."));
  const [excluded, setExcluded] = useState(() => fields.map((field) => field.id));
  return (
    <fieldset className="item-exclusions" disabled={disabled}>
      <legend>Review changed fields: {item.label}</legend>
      <p className="note">
        This item's custom fields changed. All current custom fields start excluded. Review each
        exclusion, then explicitly save this review before the item can be used. Other saved
        exclusions stay in place.
      </p>
      {fields.map((field, index) => (
        <label className="checkbox-row" key={field.id}>
          <input
            type="checkbox"
            aria-label={`${item.label}: Review exclude ${field.label} (field ${index + 1})`}
            checked={excluded.includes(field.id)}
            onChange={(event) =>
              setExcluded((previous) =>
                event.target.checked
                  ? [...previous, field.id]
                  : previous.filter((id) => id !== field.id),
              )
            }
          />
          Exclude {field.label} (field {index + 1})
        </label>
      ))}
      {!fields.length && (
        <p>
          This item has no current custom fields. Saving this review explicitly removes its old
          custom-field exclusions.
        </p>
      )}
      <Button
        type="button"
        aria-label={`${item.label}: Save reviewed field exclusions`}
        onClick={() => onReview(excluded)}
      >
        Save reviewed field exclusions
      </Button>
    </fieldset>
  );
}

export function BitwardenSetup({
  client,
  onCatalogChanged,
  acceptedSettings,
  reviewBlocked = true,
}: {
  client: ConnectionClient;
  onCatalogChanged: () => void;
  acceptedSettings?: Extract<SettingsResponse, { ok: true }> | undefined;
  reviewBlocked?: boolean;
}) {
  const [connections, setConnections] = useState<Connection[]>([]);
  const [existing, setExisting] = useState<Connection>();
  const [region, setRegion] = useState("us");
  const [baseUrl, setBaseUrl] = useState("");
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [enabled, setEnabled] = useState(true);
  const [enableUnlock, setEnableUnlock] = useState(false);
  const [challenge, setChallenge] = useState<Challenge>();
  const [provider, setProvider] = useState<0 | 1>(0);
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(true);
  const [message, setMessage] = useState("Loading Bitwarden connections…");
  const operation = useRef(false);
  const generation = useRef(0);
  const passwordInput = useRef<HTMLInputElement>(null);
  const codeInput = useRef<HTMLInputElement>(null);
  const catalogChanged = useRef(onCatalogChanged);
  catalogChanged.current = onCatalogChanged;
  function clearSecrets() {
    setPassword("");
    setCode("");
    if (passwordInput.current) passwordInput.current.value = "";
    if (codeInput.current) codeInput.current.value = "";
  }
  async function readConnections(epoch: number) {
    const result = await client.list();
    if (epoch !== generation.current) return;
    if (result.ok && result.kind === "status") setConnections(result.connections);
    else throw new Error("Connection metadata unavailable.");
  }
  useEffect(() => {
    const epoch = ++generation.current;
    operation.current = true;
    void readConnections(epoch)
      .then(() => {
        if (epoch === generation.current)
          setMessage("Connections loaded. Add a vault or sign in again below.");
        return undefined;
      })
      .catch(() => {
        if (epoch === generation.current)
          setMessage("Unable to read connection status. Refresh connections to retry.");
      })
      .finally(() => {
        if (epoch === generation.current) {
          operation.current = false;
          setBusy(false);
        }
      });
    return () => {
      // This counter is an operation fence, not a DOM ref captured by the effect.
      // oxlint-disable-next-line react/exhaustive-deps
      ++generation.current;
      client.close();
    };
    // This lifetime belongs to the exact client; metadata loads are never automatic retries.
    // oxlint-disable-next-line react/exhaustive-deps
  }, [client]);
  async function receive(result: SetupReply, epoch: number) {
    if (epoch !== generation.current) return;
    if (!result.ok) {
      setChallenge(undefined);
      setMessage(errorMessage(result.error.code));
      // A resolved error may follow a durable cache/configuration change.
      // Preserve the draft and require a fresh catalog before another settings save.
      onCatalogChanged();
      return;
    }
    if (result.kind === "mfa-required" || result.kind === "new-device-verification-required") {
      setChallenge(result);
      if (result.kind === "mfa-required") {
        setProvider(result.providers[0] ?? 0);
        setMessage("Enter a manual two-step verification code. No code is sent automatically.");
      } else
        setMessage(
          result.invalidOtp
            ? "The new-device code was rejected. Enter a new code manually."
            : "Enter the new-device verification code from your email.",
        );
      return;
    }
    setChallenge(undefined);
    if (result.kind === "ready") {
      setMessage(
        result.policyReviewItemIds.length
          ? `Vault accepted. ${result.policyReviewItemIds.length} item(s) need their field settings reviewed before use.`
          : "Vault verified and local cache accepted. Check automatic-unlock status below.",
      );
      setExisting(undefined);
      catalogChanged.current();
      await readConnections(epoch);
    } else if (result.kind === "interaction-required")
      setMessage(`Setup is incomplete: ${result.reason}. This interaction is not supported here.`);
    else if (result.kind === "cancelled") setMessage("Setup cancelled.");
    else if (result.kind === "status") setConnections(result.connections);
    else if (result.kind === "forgotten") {
      setMessage(
        "Sync sign-in removed from this device. This does not sign out other sessions; the local vault still unlocks as before.",
      );
      await readConnections(epoch);
    } else if (result.kind === "disabled") {
      setMessage(
        "Automatic unlock disabled. Sign in again with Enable automatic unlock to restore it.",
      );
      catalogChanged.current();
      await readConnections(epoch);
    }
  }
  function start(action: (epoch: number) => Promise<void>) {
    if (operation.current) return;
    operation.current = true;
    const epoch = ++generation.current;
    setBusy(true);
    // Invoke synchronously: provider permission must keep the original click gesture.
    void action(epoch)
      .catch(() => {
        if (epoch !== generation.current) return;
        setChallenge(undefined);
        setMessage(
          "The operation could not be confirmed. Refresh connections and reload saved settings. Your previous draft is preserved.",
        );
        catalogChanged.current();
      })
      .finally(() => {
        if (epoch !== generation.current) return;
        operation.current = false;
        setBusy(false);
      });
  }
  function connect() {
    if (operation.current) return;
    const environment: BitwardenProfile["environment"] =
      existing?.environment ??
      (region === "self-hosted"
        ? { kind: "self-hosted", baseUrl }
        : { kind: "cloud", region: region === "eu" ? "eu" : "us" });
    const profile = normalizeBitwardenProfile({ connectionId: "setup-preview", environment });
    if (
      !profile.ok ||
      (!existing && (!name.trim() || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))) ||
      !password
    ) {
      setMessage(
        "Enter a connection name, valid email and master password. Self-hosted addresses must be ordinary HTTPS roots without a path, credentials, query or fragment.",
      );
      return;
    }
    const input: SetupBegin = existing
      ? {
          kind: "existing",
          connectionId: existing.connectionId,
          password,
          autoUnlock: enableUnlock ? "enable" : "preserve",
        }
      : {
          kind: "new",
          environment: profile.data.environment,
          label: name.trim(),
          email,
          password,
          enabled,
        };
    clearSecrets();
    setMessage("Requesting provider access and connecting…");
    start(async (epoch) => {
      const granted = await client.requestProviderPermission(profile.data.environment);
      if (epoch !== generation.current) return;
      if (!granted) {
        setMessage("Provider access was not granted. No sign-in request was sent.");
        return;
      }
      await receive(await client.begin(input), epoch);
    });
  }
  function continueSetup() {
    if (!challenge || !code || operation.current) return;
    const input =
      challenge.kind === "mfa-required"
        ? { flowId: challenge.flowId, twoFactor: { provider, code } }
        : { flowId: challenge.flowId, newDeviceOtp: code };
    clearSecrets();
    start(async (epoch) => {
      await receive(await client.continue(input), epoch);
    });
  }
  function cancel() {
    ++generation.current;
    operation.current = false;
    client.close();
    clearSecrets();
    setChallenge(undefined);
    setBusy(false);
    setMessage("Setup stopped. Refresh connections to confirm the latest state.");
    catalogChanged.current();
  }
  const previewEnvironment: BitwardenProfile["environment"] =
    existing?.environment ??
    (region === "self-hosted"
      ? { kind: "self-hosted", baseUrl }
      : { kind: "cloud", region: region === "eu" ? "eu" : "us" });
  const origins = providerPermissionOrigins(previewEnvironment);
  return (
    <section className="panel" aria-labelledby="bitwarden-setup-heading">
      <h2 id="bitwarden-setup-heading">Bitwarden connections</h2>
      <p className="note">
        Connect manually to Bitwarden Cloud US/EU or an ordinary HTTPS self-hosted server. Master
        passwords and verification codes are not saved. Connecting retains a local unlock key, an
        encrypted vault cache and a sync sign-in on this device. Automatic website login remains
        unavailable.
      </p>
      <output
        id="bitwarden-setup-status"
        className="settings-status block"
        aria-live="polite"
        aria-atomic="true"
      >
        {message}
      </output>
      <ul id="bitwarden-connections" className="saved-list">
        {connections.map((connection) => (
          <li key={connection.connectionId} className="flex-wrap">
            <div>
              <strong>{connection.label}</strong>
              <small>
                {connection.email} · {stateLabel(connection)}
              </small>
              <small>Automatic unlock: {connection.autoUnlock}.</small>
              <small>{sessionLabel(connection)}.</small>
            </div>
            <div className="flex flex-wrap gap-2">
              <Button
                type="button"
                variant="outline"
                disabled={busy || !!challenge}
                aria-label={`${connection.label}: Sync`}
                onClick={() => {
                  start(async (epoch) => {
                    const granted = await client.requestProviderPermission(connection.environment);
                    if (epoch !== generation.current) return;
                    if (!granted) {
                      setMessage("Provider access was not granted. No sync request was sent.");
                      return;
                    }
                    await receive(await client.sync(connection.connectionId), epoch);
                  });
                }}
              >
                Sync
              </Button>
              <Button
                type="button"
                variant="outline"
                disabled={busy || !!challenge}
                aria-label={`${connection.label}: Sign in again`}
                onClick={() => {
                  clearSecrets();
                  setExisting(connection);
                  setEnableUnlock(false);
                  setMessage(
                    "Enter the master password to sign in again. Automatic unlock stays unchanged unless explicitly enabled.",
                  );
                  passwordInput.current?.focus();
                }}
              >
                Sign in again
              </Button>
              <Button
                type="button"
                variant="outline"
                disabled={busy || !!challenge || connection.autoUnlock === "disabled"}
                aria-label={`${connection.label}: Disable automatic unlock`}
                onClick={() =>
                  start(async (epoch) => {
                    await receive(await client.disableAutoUnlock(connection.connectionId), epoch);
                  })
                }
              >
                Disable automatic unlock
              </Button>
              <Button
                type="button"
                variant="outline"
                disabled={busy || !!challenge || connection.providerSession === "none"}
                aria-label={`${connection.label}: Forget sync sign-in`}
                onClick={() =>
                  start(async (epoch) => {
                    await receive(
                      await client.forgetProviderSession(connection.connectionId),
                      epoch,
                    );
                  })
                }
              >
                Forget sync sign-in
              </Button>
            </div>
          </li>
        ))}
      </ul>
      {acceptedSettings?.catalog.connections.map((connection) => {
        const quarantined = connection.quarantinedItemIds ?? [];
        if (!quarantined.length) return null;
        return (
          <div key={connection.id}>
            <h3>{connection.label}: Review changed custom fields</h3>
            {reviewBlocked && (
              <p className="note">
                Reload saved settings to review the current field list. Your unsaved policy draft is
                preserved until you choose Reload.
              </p>
            )}
            {connection.items
              .filter((item) => quarantined.includes(item.id))
              .map((item) => (
                <FieldReview
                  key={`${connection.snapshotId}:${acceptedSettings.snapshot.revision}:${item.id}`}
                  item={item}
                  disabled={busy || !!challenge || reviewBlocked || !connection.snapshotId}
                  onReview={(excludedFieldIds) => {
                    if (!connection.snapshotId || reviewBlocked) return;
                    const input = {
                      connectionId: connection.id,
                      itemId: item.id,
                      snapshotId: connection.snapshotId,
                      expectedRevision: acceptedSettings.snapshot.revision,
                      excludedFieldIds,
                    };
                    start(async (epoch) => {
                      await receive(await client.review(input), epoch);
                    });
                  }}
                />
              ))}
          </div>
        );
      })}
      <Button
        id="bitwarden-refresh-connections"
        type="button"
        variant="outline"
        disabled={busy || !!challenge}
        onClick={() =>
          start(async (epoch) => {
            await readConnections(epoch);
            if (epoch === generation.current) setMessage("Connection status refreshed.");
          })
        }
      >
        Refresh connections
      </Button>
      {challenge ? (
        <fieldset className="connection" disabled={busy}>
          <legend>Manual verification</legend>
          {challenge.kind === "mfa-required" ? (
            <>
              <label>
                Verification method
                <select
                  id="bitwarden-mfa-provider"
                  value={provider}
                  onChange={(event) => setProvider(event.target.value === "1" ? 1 : 0)}
                >
                  {challenge.providers.map((id) => (
                    <option key={id} value={id}>
                      {id === 0 ? "Authenticator code" : "Email code"}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                Verification code
                <input
                  id="bitwarden-code"
                  ref={codeInput}
                  className={inputClass}
                  type="password"
                  autoComplete="off"
                  maxLength={1024}
                  value={code}
                  onChange={(event) => setCode(event.target.value)}
                />
              </label>
            </>
          ) : (
            <label>
              New-device verification code
              <input
                id="bitwarden-new-device-otp"
                ref={codeInput}
                className={inputClass}
                type="password"
                autoComplete="off"
                maxLength={1024}
                value={code}
                onChange={(event) => setCode(event.target.value)}
              />
            </label>
          )}
          <Button
            id="bitwarden-continue"
            type="button"
            disabled={!code || (challenge.kind === "mfa-required" && !challenge.providers.length)}
            onClick={continueSetup}
          >
            Verify code
          </Button>
        </fieldset>
      ) : (
        <fieldset className="connection" disabled={busy}>
          <legend>{existing ? `Sign in again: ${existing.label}` : "Add a connection"}</legend>
          {!existing ? (
            <>
              <label>
                Server
                <select
                  id="bitwarden-region"
                  value={region}
                  onChange={(event) => setRegion(event.target.value)}
                >
                  <option value="us">Bitwarden Cloud US</option>
                  <option value="eu">Bitwarden Cloud EU</option>
                  <option value="self-hosted">Self-hosted HTTPS</option>
                </select>
              </label>
              {region === "self-hosted" && (
                <label>
                  Server address
                  <input
                    id="bitwarden-base-url"
                    type="text"
                    maxLength={2048}
                    placeholder="https://vault.example.com"
                    value={baseUrl}
                    onChange={(event) => setBaseUrl(event.target.value)}
                  />
                </label>
              )}
              <label>
                Connection name
                <input
                  id="bitwarden-name"
                  type="text"
                  maxLength={200}
                  value={name}
                  onChange={(event) => setName(event.target.value)}
                />
              </label>
              <label>
                Email
                <input
                  id="bitwarden-email"
                  className={inputClass}
                  type="email"
                  autoComplete="username"
                  maxLength={320}
                  value={email}
                  onChange={(event) => setEmail(event.target.value)}
                />
              </label>
              <label className="checkbox-row">
                <input
                  id="bitwarden-enabled"
                  type="checkbox"
                  checked={enabled}
                  onChange={(event) => setEnabled(event.target.checked)}
                />
                Enable this connection in Pateat policy
              </label>
            </>
          ) : (
            <>
              <p>{existing.email}</p>
              <label className="checkbox-row">
                <input
                  id="bitwarden-enable-auto-unlock"
                  type="checkbox"
                  checked={enableUnlock}
                  onChange={(event) => setEnableUnlock(event.target.checked)}
                />
                Enable automatic unlock on this device
              </label>
            </>
          )}
          <label>
            Master password
            <input
              id="bitwarden-password"
              ref={passwordInput}
              className={inputClass}
              type="password"
              autoComplete="off"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
            />
          </label>
          {provider === 1 && (
            <p className="note">
              Enter an email code you already received. Sending an email verification code is not
              available here.
            </p>
          )}
          <p className="note">
            Provider hosts requested by this button:{" "}
            {origins.ok ? origins.data.join(", ") : "Enter a valid HTTPS server address."}
          </p>
          <div className="flex gap-3">
            <Button id="bitwarden-connect" type="button" onClick={connect}>
              {existing ? "Sign in and sync" : "Connect Bitwarden"}
            </Button>
            {existing && (
              <Button
                id="bitwarden-add-new"
                type="button"
                variant="outline"
                onClick={() => {
                  clearSecrets();
                  setExisting(undefined);
                }}
              >
                Add another connection
              </Button>
            )}
          </div>
        </fieldset>
      )}
      <Button
        id="bitwarden-cancel"
        type="button"
        variant="outline"
        disabled={!busy && !challenge && !password && !code && !existing}
        onClick={cancel}
      >
        Cancel setup
      </Button>
      <p className="note">
        Changed custom-field exclusions can require review. Affected items remain unavailable until
        their field settings are explicitly reviewed; refreshing does not approve them.
      </p>
    </section>
  );
}
