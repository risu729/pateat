import { normalizeBitwardenProfile, type BitwardenProfile } from "@pateat/bitwarden";
import type { SettingsResponse, VaultItemMetadata } from "@pateat/contracts";
import { Menu } from "@base-ui/react/menu";
import {
  CircleCheck,
  CircleX,
  Ellipsis,
  Globe,
  Info,
  Lock,
  LogIn,
  LogOut,
  Pause,
  RefreshCw,
  Trash2,
  TriangleAlert,
  Vault,
} from "lucide-react";
import { useEffect, useRef, useState } from "react";
import type { SetupBegin, SetupReply } from "../connections/types";
import { providerPermissionOrigins } from "../connections/permissions";
import { Button } from "./button";
import type { ConnectionClient } from "./connection-client";
import {
  checkClass,
  controlClass,
  fieldClass,
  groupClass,
  Panel,
  Row,
  RowList,
  RowSub,
  RowTitle,
  StatusLines,
  type Tone,
} from "./ui";

type StatusReply = Extract<SetupReply, { kind: "status" }>;
type Challenge = Extract<SetupReply, { kind: "mfa-required" | "new-device-verification-required" }>;
type Connection = StatusReply["connections"][number];
function errorMessage(code: string, check?: string): string {
  if (code === "account-mismatch")
    return `The provider's sign-in and vault data did not agree${check ? ` (check: ${check})` : ""}. Setup is incomplete; report this check name.`;
  const messages: Record<string, string> = {
    "provider-permission-required":
      "Provider access was not granted. Use the connection button to grant access.",
    "setup-reauthentication-required":
      "Sign in again to sync. The saved local vault can still unlock independently.",
    "auto-unlock-disabled":
      "Automatic unlock is off for this connection, and Sync needs it. Sign in again and check Enable automatic unlock on this device to restore it.",
    "crypto-locked": "The vault is locked. Refresh to check recovery options.",
    "resource-limit":
      "The operation reached a resource limit. Refresh to check the current vault status before trying again.",
    "cache-quota-exceeded":
      "The vault exceeds the local cache limit. Refresh to check the current vault status.",
    "storage-uncertain":
      "The cache update could not be confirmed. Refresh and reload saved settings before using this vault.",
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
    messages[code] ?? `Connection operation unavailable (${code}). Refresh before trying again.`
  );
}
type Line = { tone: Tone; icon: typeof Info; text: string };

/** The vault, the sync sign-in and automatic unlock, one line each. */
function statusLines(connection: Connection): Line[] {
  const lines: Line[] = [];
  switch (connection.state) {
    case "ready":
      lines.push({ tone: "ok", icon: CircleCheck, text: "Local vault ready" });
      break;
    case "review-required":
      lines.push({
        tone: "warn",
        icon: TriangleAlert,
        text: "Some items need their field settings reviewed before use",
      });
      break;
    case "configured":
      lines.push({ tone: "warn", icon: TriangleAlert, text: "Setup incomplete or vault locked" });
      break;
    case "unavailable":
      lines.push({ tone: "err", icon: CircleX, text: "Vault unavailable" });
      break;
    case "disabled":
      // The automatic-unlock line below says it.
      break;
  }
  switch (connection.providerSession) {
    case "active":
      lines.push({ tone: "ok", icon: CircleCheck, text: "Sync sign-in saved on this device" });
      break;
    case "refresh-required":
      lines.push({
        tone: "ok",
        icon: CircleCheck,
        text: "Sync sign-in saved, renewed on the next sync",
      });
      break;
    case "reauthentication-required":
      lines.push({ tone: "warn", icon: TriangleAlert, text: "Sign in again to sync" });
      break;
    case "none":
      lines.push({ tone: "idle", icon: Pause, text: "Not signed in for sync" });
      break;
    case "unavailable":
      lines.push({ tone: "warn", icon: TriangleAlert, text: "Sync sign-in unavailable" });
      break;
  }
  if (connection.autoUnlock === "enabled")
    lines.push({ tone: "ok", icon: CircleCheck, text: "Automatic unlock on" });
  else if (connection.autoUnlock === "disabled")
    lines.push({ tone: "idle", icon: Pause, text: "Automatic unlock off" });
  else lines.push({ tone: "idle", icon: Info, text: "Automatic unlock unknown" });
  return lines;
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
    <fieldset
      className="m-0 flex min-w-0 flex-col gap-2 rounded-lg border border-border bg-surface p-4"
      disabled={disabled}
    >
      <legend className="px-1 font-semibold">Review changed fields in {item.label}</legend>
      <p className="m-0 text-sm text-ink-muted">
        All current custom fields start excluded. Save this review before the item can be used;
        other saved exclusions stay in place.
      </p>
      {fields.map((field, index) => (
        <label className={checkClass} key={field.id}>
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
        <p className="m-0 text-sm">
          This item has no current custom fields. Saving this review explicitly removes its old
          custom-field exclusions.
        </p>
      )}
      <Button
        type="button"
        className="self-start"
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
  const [confirmingDelete, setConfirmingDelete] = useState<string>();
  const confirmDeleteButton = useRef<HTMLButtonElement>(null);
  const menuTriggers = useRef(new Map<string, HTMLButtonElement>());
  /** The row whose menu trigger takes focus back once Keep connection closes the confirmation. */
  const keptConnection = useRef<string>(undefined);
  useEffect(() => {
    if (confirmingDelete) {
      confirmDeleteButton.current?.focus();
    } else if (keptConnection.current) {
      menuTriggers.current.get(keptConnection.current)?.focus();
      keptConnection.current = undefined;
    }
  }, [confirmingDelete]);
  // Unset until toggled: the form starts open only while there is no connection.
  const [addOpen, setAddOpen] = useState<boolean>();
  const focusPassword = useRef(false);
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
          setMessage("Unable to read connection status. Refresh to retry.");
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
      setMessage(errorMessage(result.error.code, result.error.check));
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
      // Adding a connection already saved its policy entry, so the settings draft reloads.
      onCatalogChanged();
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
    } else if (result.kind === "deleted") {
      setMessage(
        "Connection deleted from this device, with its local vault cache, unlock key and sync sign-in. This does not sign out other sessions. Saved settings that referred to it now show it as unavailable.",
      );
      const deleted = result.connectionId;
      setExisting((previous) => (previous?.connectionId === deleted ? undefined : previous));
      catalogChanged.current();
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
    setConfirmingDelete(undefined);
    // Invoke synchronously: provider permission must keep the original click gesture.
    void action(epoch)
      .catch(() => {
        if (epoch !== generation.current) return;
        setChallenge(undefined);
        setMessage(
          "The operation could not be confirmed. Refresh and reload saved settings. Your previous draft is preserved.",
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
    setMessage("Setup stopped. Refresh to confirm the latest state.");
    catalogChanged.current();
  }
  function syncConnection(connection: Connection) {
    start(async (epoch) => {
      const granted = await client.requestProviderPermission(connection.environment);
      if (epoch !== generation.current) return;
      if (!granted) {
        setMessage("Provider access was not granted. No sync request was sent.");
        return;
      }
      await receive(await client.sync(connection.connectionId), epoch);
    });
  }
  function signInAgain(connection: Connection) {
    clearSecrets();
    setExisting(connection);
    setEnableUnlock(false);
    setAddOpen(true);
    focusPassword.current = true;
    setMessage(
      "Enter the master password to sign in again. Automatic unlock stays unchanged unless explicitly enabled.",
    );
  }
  // The sign-in form may only now be open; focus its password once it is shown.
  useEffect(() => {
    if (!focusPassword.current) return;
    focusPassword.current = false;
    passwordInput.current?.focus();
  });
  const previewEnvironment: BitwardenProfile["environment"] =
    existing?.environment ??
    (region === "self-hosted"
      ? { kind: "self-hosted", baseUrl }
      : { kind: "cloud", region: region === "eu" ? "eu" : "us" });
  const origins = providerPermissionOrigins(previewEnvironment);
  const formOpen = addOpen ?? !connections.length;
  const cancelable = busy || !!challenge || !!password || !!code || !!existing;
  const cancelButton = (id?: string) => (
    <Button id={id} type="button" variant="outline" disabled={!cancelable} onClick={cancel}>
      Cancel setup
    </Button>
  );
  return (
    <Panel
      id="bitwarden"
      headingId="bitwarden-setup-heading"
      title="Bitwarden"
      actions={
        <div className="flex flex-wrap gap-2">
          {/* While a row's operation runs with the form closed, it can still be stopped. */}
          {busy && !challenge && !formOpen && cancelButton()}
          <Button
            id="bitwarden-refresh-connections"
            type="button"
            variant="ghost"
            aria-label="Refresh connections"
            disabled={busy || !!challenge}
            onClick={() =>
              start(async (epoch) => {
                await readConnections(epoch);
                if (epoch === generation.current) setMessage("Connection status refreshed.");
              })
            }
          >
            <RefreshCw aria-hidden size={16} strokeWidth={2} />
            Refresh
          </Button>
        </div>
      }
    >
      <output
        id="bitwarden-setup-status"
        className="settings-status block text-sm leading-5"
        aria-live="polite"
        aria-atomic="true"
      >
        {message}
      </output>
      <RowList id="bitwarden-connections">
        {connections.map((connection) => {
          const signInFirst = needsSignIn(connection);
          const blocked = busy || !!challenge;
          const confirming = confirmingDelete === connection.connectionId;
          return (
            <Row
              key={connection.connectionId}
              icon={Vault}
              main={
                <>
                  <RowTitle>{connection.label}</RowTitle>
                  <RowSub>
                    {connection.email} on {serverName(connection.environment)}
                  </RowSub>
                  <StatusLines lines={statusLines(connection)} />
                </>
              }
              actions={
                confirming ? (
                  <>
                    <Button
                      ref={confirmDeleteButton}
                      type="button"
                      variant="danger"
                      disabled={blocked}
                      aria-label={`${connection.label}: Confirm delete connection`}
                      onClick={() =>
                        start(async (epoch) => {
                          await receive(
                            await client.deleteConnection(connection.connectionId),
                            epoch,
                          );
                        })
                      }
                    >
                      Confirm delete
                    </Button>
                    <Button
                      type="button"
                      variant="outline"
                      aria-label={`${connection.label}: Keep connection`}
                      onClick={() => {
                        keptConnection.current = connection.connectionId;
                        setConfirmingDelete(undefined);
                        setMessage("Connection kept.");
                      }}
                    >
                      Keep connection
                    </Button>
                  </>
                ) : (
                  <>
                    <Button
                      type="button"
                      variant="outline"
                      disabled={blocked}
                      aria-label={`${connection.label}: ${signInFirst ? "Sign in again" : "Sync"}`}
                      onClick={() =>
                        signInFirst ? signInAgain(connection) : syncConnection(connection)
                      }
                    >
                      {signInFirst ? (
                        <LogIn aria-hidden size={16} strokeWidth={2} />
                      ) : (
                        <RefreshCw aria-hidden size={16} strokeWidth={2} />
                      )}
                      {signInFirst ? "Sign in again" : "Sync"}
                    </Button>
                    <Menu.Root>
                      <Menu.Trigger
                        ref={(element: HTMLButtonElement | null) => {
                          if (element) menuTriggers.current.set(connection.connectionId, element);
                          else menuTriggers.current.delete(connection.connectionId);
                        }}
                        className={iconButtonClass}
                        aria-label={`More for ${connection.label}`}
                        disabled={blocked}
                      >
                        <Ellipsis aria-hidden size={16} strokeWidth={2} />
                      </Menu.Trigger>
                      <Menu.Portal>
                        <Menu.Positioner sideOffset={4} align="end">
                          <Menu.Popup className="min-w-56 rounded-lg border border-border bg-surface p-1 text-ink shadow-[var(--shadow-menu)] outline-none">
                            {signInFirst ? (
                              <Menu.Item
                                className={menuItemClass}
                                aria-label={`${connection.label}: Sync`}
                                onClick={() => syncConnection(connection)}
                              >
                                <RefreshCw aria-hidden size={16} strokeWidth={2} />
                                Sync
                              </Menu.Item>
                            ) : (
                              <Menu.Item
                                className={menuItemClass}
                                aria-label={`${connection.label}: Sign in again`}
                                onClick={() => signInAgain(connection)}
                              >
                                <LogIn aria-hidden size={16} strokeWidth={2} />
                                Sign in again
                              </Menu.Item>
                            )}
                            <Menu.Item
                              className={menuItemClass}
                              aria-label={`${connection.label}: Disable automatic unlock`}
                              disabled={connection.autoUnlock === "disabled"}
                              onClick={() =>
                                start(async (epoch) => {
                                  await receive(
                                    await client.disableAutoUnlock(connection.connectionId),
                                    epoch,
                                  );
                                })
                              }
                            >
                              <Pause aria-hidden size={16} strokeWidth={2} />
                              Disable automatic unlock
                            </Menu.Item>
                            <Menu.Item
                              className={menuItemClass}
                              aria-label={`${connection.label}: Forget sync sign-in`}
                              disabled={connection.providerSession === "none"}
                              onClick={() =>
                                start(async (epoch) => {
                                  await receive(
                                    await client.forgetProviderSession(connection.connectionId),
                                    epoch,
                                  );
                                })
                              }
                            >
                              <LogOut aria-hidden size={16} strokeWidth={2} />
                              Forget sync sign-in
                            </Menu.Item>
                            <Menu.Item
                              className={`${menuItemClass} text-danger`}
                              aria-label={`${connection.label}: Delete connection`}
                              onClick={() => {
                                setConfirmingDelete(connection.connectionId);
                                setMessage(
                                  `Delete ${connection.label}? This removes the connection, its local vault cache, unlock key and sync sign-in from this device. It does not sign out other sessions, and saved settings that refer to it will show it as unavailable. Choose Confirm delete to continue.`,
                                );
                              }}
                            >
                              <Trash2 aria-hidden size={16} strokeWidth={2} />
                              Delete connection
                            </Menu.Item>
                          </Menu.Popup>
                        </Menu.Positioner>
                      </Menu.Portal>
                    </Menu.Root>
                  </>
                )
              }
            />
          );
        })}
      </RowList>
      {acceptedSettings?.catalog.connections.map((connection) => {
        const quarantined = connection.quarantinedItemIds ?? [];
        if (!quarantined.length) return null;
        return (
          <div key={connection.id} className={groupClass}>
            <h3 className="m-0 flex items-center gap-2 text-base">
              <TriangleAlert aria-hidden size={16} strokeWidth={2} className="text-warning" />
              Review changed custom fields in {connection.label}
            </h3>
            <StatusLines
              muted
              lines={[
                {
                  tone: "idle",
                  icon: Info,
                  text: "Affected items stay unavailable until their field settings are reviewed; refreshing does not approve them.",
                },
                ...(reviewBlocked
                  ? [
                      {
                        tone: "warn" as const,
                        icon: TriangleAlert,
                        text: "Reload saved settings to review the current field list. Your unsaved policy draft is preserved until you choose Reload.",
                      },
                    ]
                  : []),
              ]}
            />
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
      {challenge ? (
        <div className={groupClass}>
          <fieldset className="m-0 flex min-w-0 flex-col gap-3 border-0 p-0" disabled={busy}>
            <legend className="mb-3 p-0 font-semibold">Manual verification</legend>
            {challenge.kind === "mfa-required" ? (
              <div className="grid gap-x-4 gap-y-3 sm:grid-cols-2">
                <label className={fieldClass}>
                  Verification method
                  <select
                    id="bitwarden-mfa-provider"
                    className={controlClass}
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
                <label className={fieldClass}>
                  Verification code
                  <input
                    id="bitwarden-code"
                    ref={codeInput}
                    className={controlClass}
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
                New-device verification code
                <input
                  id="bitwarden-new-device-otp"
                  ref={codeInput}
                  className={controlClass}
                  type="password"
                  autoComplete="off"
                  maxLength={1024}
                  value={code}
                  onChange={(event) => setCode(event.target.value)}
                />
              </label>
            )}
            {provider === 1 && challenge.kind === "mfa-required" && (
              <StatusLines
                muted
                lines={[
                  {
                    tone: "idle",
                    icon: Info,
                    text: "Enter an email code you already received. Sending an email verification code is not available here.",
                  },
                ]}
              />
            )}
          </fieldset>
          <div className="flex flex-wrap gap-2">
            <Button
              id="bitwarden-continue"
              type="button"
              disabled={
                busy || !code || (challenge.kind === "mfa-required" && !challenge.providers.length)
              }
              onClick={continueSetup}
            >
              Verify code
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
            {existing ? `Sign in to ${existing.label} again` : "Add a connection"}
          </summary>
          <fieldset className="m-0 flex min-w-0 flex-col gap-3 border-0 p-0" disabled={busy}>
            <legend className="visually-hidden">
              {existing ? `Sign in to ${existing.label} again` : "Add a connection"}
            </legend>
            <div className="grid gap-x-4 gap-y-3 sm:grid-cols-2">
              {!existing && (
                <>
                  <label className={fieldClass}>
                    Server
                    <select
                      id="bitwarden-region"
                      className={controlClass}
                      value={region}
                      onChange={(event) => setRegion(event.target.value)}
                    >
                      <option value="us">Bitwarden Cloud US</option>
                      <option value="eu">Bitwarden Cloud EU</option>
                      <option value="self-hosted">Self-hosted HTTPS</option>
                    </select>
                  </label>
                  {region === "self-hosted" && (
                    <label className={fieldClass}>
                      Server address
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
                    Name
                    <input
                      id="bitwarden-name"
                      className={controlClass}
                      type="text"
                      maxLength={200}
                      placeholder="Personal"
                      value={name}
                      onChange={(event) => setName(event.target.value)}
                    />
                  </label>
                  <label className={fieldClass}>
                    Email
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
                  Email
                  <span className="flex min-h-10 items-center font-normal">{existing.email}</span>
                </div>
              )}
              <label className={fieldClass}>
                Master password
                <input
                  id="bitwarden-password"
                  ref={passwordInput}
                  className={controlClass}
                  type="password"
                  autoComplete="off"
                  value={password}
                  onChange={(event) => setPassword(event.target.value)}
                />
              </label>
            </div>
            {existing ? (
              <label className={checkClass}>
                <input
                  id="bitwarden-enable-auto-unlock"
                  type="checkbox"
                  checked={enableUnlock}
                  onChange={(event) => setEnableUnlock(event.target.checked)}
                />
                Enable automatic unlock on this device
              </label>
            ) : (
              <label className={checkClass}>
                <input
                  id="bitwarden-enabled"
                  type="checkbox"
                  checked={enabled}
                  onChange={(event) => setEnabled(event.target.checked)}
                />
                Use this connection
              </label>
            )}
            <StatusLines
              muted
              lines={[
                {
                  tone: "idle",
                  icon: Lock,
                  text: "The master password and verification codes are not saved. An unlock key, an encrypted vault copy and a sync sign-in stay on this device.",
                },
                origins.ok
                  ? {
                      tone: "idle",
                      icon: Globe,
                      text: `Chrome asks for access to ${listHosts(origins.data)}`,
                    }
                  : {
                      tone: "warn",
                      icon: TriangleAlert,
                      text: "Enter a valid HTTPS server address.",
                    },
              ]}
            />
          </fieldset>
          <div className="flex flex-wrap gap-2">
            <Button id="bitwarden-connect" type="button" disabled={busy} onClick={connect}>
              {existing ? "Sign in and sync" : "Connect Bitwarden"}
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
                }}
              >
                Add another connection
              </Button>
            )}
            {cancelButton("bitwarden-cancel")}
          </div>
        </details>
      )}
    </Panel>
  );
}

const iconButtonClass =
  "inline-grid size-10 flex-none place-items-center rounded-lg border border-transparent bg-transparent text-ink-muted hover:bg-surface-sunken disabled:opacity-50";
const menuItemClass =
  "flex min-h-9 cursor-default items-center gap-2 rounded-md px-3 text-sm outline-none select-none data-[disabled]:opacity-50 data-[highlighted]:bg-accent-tint data-[highlighted]:outline-solid data-[highlighted]:outline-2 data-[highlighted]:-outline-offset-2 data-[highlighted]:outline-focus";

/** Where a connection's vault lives, as the Server choice names it. */
function serverName(environment: BitwardenProfile["environment"]): string {
  if (environment.kind === "self-hosted") return new URL(environment.baseUrl).host;
  return environment.region === "eu" ? "Bitwarden Cloud EU" : "Bitwarden Cloud US";
}

/** "a", "a and b", "a, b and c" of the hosts in Chrome match patterns. */
function listHosts(patterns: string[]): string {
  const hosts = patterns.map((pattern) => new URL(pattern.replace(/\/\*$/, "/")).host);
  return hosts.length > 1
    ? `${hosts.slice(0, -1).join(", ")} and ${hosts.at(-1)}`
    : (hosts[0] ?? "");
}

/** A connection that cannot sync until its owner signs in again. */
function needsSignIn(connection: Connection): boolean {
  return (
    connection.state === "configured" ||
    connection.state === "unavailable" ||
    connection.state === "disabled" ||
    (connection.providerSession !== "active" && connection.providerSession !== "refresh-required")
  );
}
