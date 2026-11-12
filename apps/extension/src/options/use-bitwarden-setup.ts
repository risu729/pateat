import { useTranslation } from "react-i18next";
import { i18n } from "../i18n";
import {
  bitwardenEmail,
  normalizeBitwardenProfile,
  type BitwardenProfile,
} from "@pateat/bitwarden";
import { useEffect, useEffectEvent, useRef, useState, type RefObject } from "react";
import * as v from "valibot";
import type { SetupBegin, SetupReply } from "../connections/types";
import { providerPermissionOrigins } from "../connections/permissions";
import type { UnlockResult } from "./unlock-form";
import type {
  BitwardenSetupProps,
  Challenge,
  Connection,
  EmailCode,
  Message,
} from "./bitwarden-setup-types";
import { endedText, errorMessage } from "./bitwarden-setup-messages";

/** Below Chrome's 30-second idle limit for an extension service worker. */
const KEEP_ALIVE_MS = 20_000;

/** The background stores a new connection's email in this form. */
function normalEmail(email: string) {
  return email.trim().toLowerCase();
}

export function useBitwardenSetup({
  client,
  onCatalogChanged,
  acceptedSettings,
  reviewBlocked = true,
  unsavedChanges = false,
  renderAccess,
  renderOthers,
}: BitwardenSetupProps) {
  const { t } = useTranslation(undefined, { i18n });
  const [connections, setConnections] = useState<Connection[]>([]);
  const [existing, setExisting] = useState<Connection>();
  const [region, setRegion] = useState("us");
  const [baseUrl, setBaseUrl] = useState("");
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [enabled, setEnabled] = useState(true);
  // The connection whose unlock form is open in its row.
  const [unlocking, setUnlocking] = useState<string>();
  const [challenge, setChallenge] = useState<Challenge>();
  const menuTriggers = useRef(new Map<string, HTMLButtonElement>());
  const keepConnectionButton = useRef<HTMLButtonElement>(null);
  // Unset until toggled: the form starts open only while there is no connection.
  const [addOpen, setAddOpen] = useState<boolean>();
  // A control to focus once it is shown and enabled, such as a field in a form just opened.
  const focusNext = useRef<RefObject<HTMLElement | null>>(undefined);
  const shownChallenge = useRef<Challenge>(undefined);
  const deleting = useRef(false);
  const wasBusy = useRef(false);
  // A cancel ended the person's action, even when no operation was running.
  const cancelled = useRef(false);
  const [provider, setProvider] = useState<0 | 1>(0);
  const [emailCode, setEmailCode] = useState<EmailCode>();
  // The sign-in whose email code was already asked for once without a click.
  const emailFlow = useRef<string>(undefined);
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(true);
  const [statusKnown, setStatusKnown] = useState(false);
  const [message, setMessage] = useState<Message>("Loading Bitwarden connections…");
  const say = (next: Message) => setMessage(() => next);
  // When the shown challenge stops waiting; a reply handler may see an older render's state.
  const deadline = useRef<{ flowId: string; expiresAt: number }>(undefined);
  // Why the last sign-in ended while it waited for its code, shown in the sign-in form.
  const [ended, setEndedState] = useState<Message>();
  const setEnded = (next: Message | undefined) => setEndedState(() => next);
  // The server refused the last code; the code screen says so until the next answer.
  const [refused, setRefused] = useState(false);
  const operation = useRef(false);
  const generation = useRef(0);
  // The page's first connection read is running.
  const loading = useRef(false);
  // This page's add of a new connection: the IDs listed before it and what it sent.
  const pendingAdd = useRef<{ before: Set<string>; label: string; email: string }>(undefined);
  // Whether the running sign-in, and so its challenge, is that add.
  const adding = useRef(false);
  const draft = useRef({ name, email });
  draft.current = { name, email };
  const passwordInput = useRef<HTMLInputElement>(null);
  const codeInput = useRef<HTMLInputElement>(null);
  const regionSelect = useRef<HTMLSelectElement>(null);
  const statusOutput = useRef<HTMLOutputElement>(null);
  const catalogChanged = useRef(onCatalogChanged);
  catalogChanged.current = onCatalogChanged;
  function clearSecrets() {
    setPassword("");
    setCode("");
    if (passwordInput.current) passwordInput.current.value = "";
    if (codeInput.current) codeInput.current.value = "";
  }
  /**
   * `endsAdd`: the read after this page's add got its final reply; `failed`: that reply
   * was an error, so the form moves on to finishing the listed connection.
   */
  async function readConnections(epoch: number, endsAdd = false, failed = false) {
    const result = await client.list();
    if (epoch !== generation.current) return;
    if (!result.ok || result.kind !== "status") throw new Error("Connection metadata unavailable.");
    setConnections(result.connections);
    setStatusKnown(true);
    // The background keeps a new connection even when its first sign-in fails; once its
    // row is listed, "Sign in again" completes it and the add form must not register it twice.
    // A stop or a lost reply can come before the row exists, so a later read may list it.
    const add = pendingAdd.current;
    if (!add) return;
    const listed = result.connections.find(
      (connection) =>
        !add.before.has(connection.connectionId) &&
        connection.label === add.label &&
        connection.email === add.email,
    );
    if (listed || endsAdd) pendingAdd.current = undefined;
    const { name: typedName, email: typedEmail } = draft.current;
    // A draft edited since the add is a different connection and stays.
    if (!listed || typedName.trim() !== add.label || normalEmail(typedEmail) !== add.email) return;
    setName("");
    setEmail("");
    // The failure's message stays: it says why the password or code has to be entered again.
    if (failed && listed.autoUnlock === "unknown" && listed.state !== "unavailable")
      signInAgain(listed, false);
  }
  /** Rows may have changed after an error or cancellation; a failed read keeps the message. */
  function rereadConnections(epoch: number, endsAdd = false, failed = false) {
    return readConnections(epoch, endsAdd, failed).catch(() => undefined);
  }
  useEffect(() => {
    const epoch = ++generation.current;
    operation.current = true;
    loading.current = true;
    void readConnections(epoch)
      .then(() => {
        if (epoch === generation.current)
          say("Connections loaded. Add a vault or sign in again below.");
        return undefined;
      })
      .catch(() => {
        if (epoch === generation.current)
          say("Pateat could not read the connection status. Refresh to try again.");
      })
      .finally(() => {
        if (epoch === generation.current) {
          operation.current = false;
          loading.current = false;
          setBusy(false);
          setStatusKnown(true);
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
  /** `endsAdd`: the reply answers this page's add, so its read is the add's last chance. */
  async function receive(result: SetupReply, epoch: number, endsAdd = false) {
    if (epoch !== generation.current) return;
    const expiresAt = deadline.current?.expiresAt;
    deadline.current = undefined;
    if (!result.ok) {
      setChallenge(undefined);
      const now = Date.now();
      if (expiresAt !== undefined && result.error.code === "setup-expired") {
        const text = endedText(expiresAt, now);
        setEnded(text.reason);
        say(text.status);
      } else if (expiresAt !== undefined && result.error.code === "cancelled" && now >= expiresAt) {
        // The end stopped the work after a code, which may have been accepted: the vault
        // download and unlock still count against the 5 minutes.
        setEnded(
          "The sign-in reached its 5-minute end before it finished. Enter the master password to start again.",
        );
        say(
          "The sign-in reached its 5-minute end before it finished. Enter the master password to start again.",
        );
      } else {
        const text = errorMessage(result.error.code, result.error.check);
        say(text);
        // Any other end of a waiting sign-in is said where the password goes too.
        if (expiresAt !== undefined) setEnded(text);
      }
      // A resolved error may follow a durable cache/configuration change.
      // Preserve the draft and require a fresh catalog before another settings save.
      onCatalogChanged();
      await rereadConnections(epoch, endsAdd, endsAdd);
      return;
    }
    if (result.kind === "mfa-required" || result.kind === "new-device-verification-required") {
      setChallenge(result);
      deadline.current = { flowId: result.flowId, expiresAt: result.expiresAt };
      setEnded(undefined);
      const again = result.kind === "mfa-required" ? !!result.invalidCode : result.invalidOtp;
      setRefused(again);
      if (again) {
        // The same sign-in waits for another code: the method and the sent email stay.
        focusNext.current = codeInput;
        say("The code was not accepted.");
      } else if (result.kind === "mfa-required") {
        // Ascending IDs put the authenticator before email, as the official clients rank them.
        setProvider(result.providers[0] ?? 0);
        setEmailCode(undefined);
        say("Enter a two-step verification code.");
      } else say("Enter the new-device verification code from your email.");
      // Adding a connection already saved its policy entry, so the settings draft reloads.
      onCatalogChanged();
      return;
    }
    setChallenge(undefined);
    if (result.kind === "ready") {
      say(
        result.policyReviewItemIds.length
          ? (translate) =>
              translate(
                "Vault accepted. {{count}} item needs its field settings reviewed before use.",
                { count: result.policyReviewItemIds.length },
              )
          : "Vault verified, unlocked and copied to this device.",
      );
      setExisting(undefined);
      catalogChanged.current();
      await readConnections(epoch, endsAdd);
    } else if (result.kind === "interaction-required") {
      say((translate) =>
        translate(
          "Setup is incomplete: Bitwarden asks for a step Pateat does not support ({{reason}}).",
          {
            reason: result.reason,
          },
        ),
      );
      await rereadConnections(epoch, endsAdd, endsAdd);
    } else if (result.kind === "cancelled") {
      say("Setup cancelled.");
      await rereadConnections(epoch, endsAdd);
    } else if (result.kind === "status") setConnections(result.connections);
    else if (result.kind === "forgotten") {
      say(
        "Sync sign-in removed from this device. This does not sign out other sessions; the local vault still unlocks as before.",
      );
      await readConnections(epoch);
    } else if (result.kind === "deleted") {
      say(
        "Connection deleted from this device, with its local vault copy, unlock key and sync sign-in. This does not sign out other sessions, and the synced settings of its account stay.",
      );
      const deleted = result.connectionId;
      setExisting((previous) => (previous?.connectionId === deleted ? undefined : previous));
      catalogChanged.current();
      await readConnections(epoch);
    } else if (result.kind === "disabled") {
      say("Logged out on this device. Sign in again to use this vault.");
      catalogChanged.current();
      await readConnections(epoch);
    } else if (result.kind === "locked") {
      say("Vault locked. Unlock it with the master password; the sync sign-in stays.");
      catalogChanged.current();
      await readConnections(epoch);
    } else if (result.kind === "unlocked") {
      say("Vault unlocked.");
      setUnlocking(undefined);
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
        deadline.current = undefined;
        setChallenge(undefined);
        say("Pateat could not confirm the result. Refresh, then reload saved settings.");
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
        ? { kind: "self-hosted", baseUrl: baseUrl.trim() }
        : { kind: "cloud", region: region === "eu" ? "eu" : "us" });
    const profile = normalizeBitwardenProfile({ connectionId: "setup-preview", environment });
    if (!profile.ok || (!existing && (!name.trim() || !v.is(bitwardenEmail, email))) || !password) {
      say(
        "Enter a name, a valid email and the master password. A self-hosted server address is an HTTPS address such as https://vault.example.com, or HTTP on localhost or 127.0.0.1, with no path, credentials, query or fragment.",
      );
      return;
    }
    const input: SetupBegin = existing
      ? { kind: "existing", connectionId: existing.connectionId, password }
      : {
          kind: "new",
          environment: profile.data.environment,
          label: name.trim(),
          email,
          password,
          enabled,
        };
    clearSecrets();
    setEnded(undefined);
    say("Asking Chrome for access to the Bitwarden server, then connecting…");
    start(async (epoch) => {
      const granted = await client.requestProviderPermission(profile.data.environment);
      if (epoch !== generation.current) return;
      if (!granted) {
        say("Chrome did not grant access to the Bitwarden server, so nothing was sent.");
        return;
      }
      // A sign-in again leaves an add still pending after a stop in place.
      adding.current = input.kind === "new";
      if (input.kind === "new")
        pendingAdd.current = {
          before: new Set(connections.map((c) => c.connectionId)),
          label: input.label,
          email: normalEmail(input.email),
        };
      await receive(await client.begin(input), epoch, adding.current);
    });
  }
  function continueSetup() {
    // As the official clients, only the ends are trimmed, so a pasted code keeps its digits.
    const value = code.trim();
    if (!challenge || !value || operation.current) return;
    const input =
      challenge.kind === "mfa-required"
        ? { flowId: challenge.flowId, twoFactor: { provider, code: value } }
        : { flowId: challenge.flowId, newDeviceOtp: value };
    clearSecrets();
    start(async (epoch) => {
      await receive(await client.continue(input), epoch, adding.current);
    });
  }
  function sendEmailCode(flowId: string) {
    if (operation.current) return;
    // A new code is on its way; the refused one no longer matters.
    setRefused(false);
    setEmailCode("sending");
    // Disabling the form for a send drops focus from the method select or Resend code;
    // return it to the code.
    focusNext.current = codeInput;
    start(async (epoch) => {
      const result = await client.sendEmailCode(flowId);
      if (epoch !== generation.current) return;
      if (result.ok && result.kind === "email-code") setEmailCode(result.result);
      else await receive(result, epoch, adding.current);
    });
  }
  // As the official extension, choosing email sends one code; more need "Resend code". A
  // send that did not go out is tried again when email is chosen again, as there.
  useEffect(() => {
    if (challenge?.kind !== "mfa-required" || busy) return;
    if (provider !== 1) {
      if (emailFlow.current === challenge.flowId && emailCode !== "sent")
        emailFlow.current = undefined;
      return;
    }
    if (emailFlow.current === challenge.flowId) return;
    emailFlow.current = challenge.flowId;
    sendEmailCode(challenge.flowId);
  });
  // The waiting sign-in, password included, lives only in the service worker, which Chrome
  // stops after 30 seconds without an event while the person fetches a code. A message on
  // the Port restarts that count, so the page sends one as soon as a challenge shows and
  // every 20 seconds after, until the challenge's own 5 minutes end it. A tab Chrome froze
  // or slowed, or a computer that slept, hears late, so the page also asks as the 5 minutes
  // end and as it shows again, and says at once that the sign-in ended.
  const beat = useEffectEvent(async (flowId: string) => {
    // An operation started after this beat moves the epoch on and answers for the flow.
    const epoch = generation.current;
    let result: SetupReply;
    try {
      result = await client.keepAlive(flowId);
    } catch {
      // The page's next request reports a closed connection.
      return;
    }
    // Only an ended flow ends the challenge; a running request answers for the flow
    // itself, and a busy worker's refusal leaves it waiting.
    if (result.ok || result.error.code !== "setup-expired" || operation.current) return;
    // Several heartbeats can find the end at once, as when a frozen tab shows again; only
    // the first ends the challenge it was sent for.
    if (deadline.current?.flowId !== flowId) return;
    await receive(result, epoch, adding.current);
  });
  useEffect(() => {
    if (!challenge) return;
    const { flowId, expiresAt } = challenge;
    void beat(flowId);
    const timer = setInterval(() => void beat(flowId), KEEP_ALIVE_MS);
    const end = setTimeout(() => void beat(flowId), Math.max(0, expiresAt - Date.now()));
    const shown = () => {
      if (document.visibilityState === "visible") void beat(flowId);
    };
    document.addEventListener("visibilitychange", shown);
    return () => {
      clearInterval(timer);
      clearTimeout(end);
      document.removeEventListener("visibilitychange", shown);
    };
  }, [challenge]);
  function cancel(stopped = "Setup stopped. Refresh to see the current state.") {
    cancelled.current = true;
    clearSecrets();
    setExisting(undefined);
    setEnded(undefined);
    // With nothing running, a pending re-read from an earlier stop must still land.
    if (!operation.current && !challenge) {
      say("Setup cancelled.");
      return;
    }
    const epoch = ++generation.current;
    operation.current = false;
    deadline.current = undefined;
    setChallenge(undefined);
    setBusy(false);
    client.close();
    if (loading.current) {
      // Only the first read was stopped: nothing was written, so saved settings stay current.
      loading.current = false;
      say("Loading stopped.");
      void readConnections(epoch)
        .then(() => {
          if (epoch === generation.current)
            say("Connections loaded. Add a vault or sign in again below.");
          return undefined;
        })
        .catch(() => {
          if (epoch === generation.current)
            say("Pateat could not read the connection status. Refresh to try again.");
        })
        .finally(() => {
          // As after the first read: other settings show even when the status is unreadable.
          if (epoch === generation.current) setStatusKnown(true);
        });
      return;
    }
    say(stopped);
    catalogChanged.current();
    void rereadConnections(epoch);
  }
  function syncConnection(connection: Connection) {
    if (operation.current) return;
    // Until the reply, the line says what runs instead of keeping the last load's text.
    say((translate) => translate("Syncing {{name}}…", { name: connection.label }));
    start(async (epoch) => {
      const granted = await client.requestProviderPermission(connection.environment);
      if (epoch !== generation.current) return;
      if (!granted) {
        say("Chrome did not grant access to the Bitwarden server, so nothing was synced.");
        return;
      }
      await receive(await client.sync(connection.connectionId), epoch);
    });
  }
  function signInAgain(connection: Connection, explain = true) {
    // A connection that never unlocked has no record yet; its first sign-in finishes the setup.
    const unfinished = connection.autoUnlock === "unknown" && connection.state !== "unavailable";
    clearSecrets();
    setExisting(connection);
    setUnlocking(undefined);
    if (explain) setEnded(undefined);
    setAddOpen(true);
    focusNext.current = passwordInput;
    if (!explain) return;
    say(
      unfinished
        ? "Enter the master password to finish setting up this connection."
        : "Enter the master password to sign in again.",
    );
  }
  /** Unlocks a locked vault offline; the form shows a wrong password itself. */
  function unlockConnection(connection: Connection, masterPassword: string): Promise<UnlockResult> {
    return new Promise((resolve) => {
      if (operation.current) {
        resolve({ ok: false, error: "unavailable" });
        return;
      }
      say((translate) => translate("Unlocking {{name}}…", { name: connection.label }));
      let answer: UnlockResult = { ok: false, error: "unavailable" };
      start(async (epoch) => {
        try {
          const result = await client.unlock(connection.connectionId, masterPassword);
          // Only a password that does not open the user key is wrong; any other refusal
          // is said with the check that made it.
          if (
            !result.ok &&
            result.error.code === "crypto-failed" &&
            result.error.check === "master-password"
          ) {
            answer = { ok: false, error: "wrong-password" };
            if (epoch === generation.current) say("Invalid master password.");
            return;
          }
          if (result.ok) answer = { ok: true };
          else if (result.error.code === "crypto-failed" && result.error.check) {
            // The form says why too, instead of asking to refresh into the same refusal.
            const text = errorMessage(result.error.code, result.error.check);
            answer = {
              ok: false,
              error: "unavailable",
              message: typeof text === "string" ? (translate) => translate(text) : text,
            };
          }
          await receive(result, epoch);
        } finally {
          resolve(answer);
        }
      });
    });
  }
  useEffect(() => {
    // The first load is not the person's operation and must not take focus.
    const finished = (wasBusy.current && !busy) || cancelled.current;
    wasBusy.current = busy && statusKnown;
    cancelled.current = false;
    const focused = document.activeElement;
    // Focus the person moved out of the panel, such as into another settings field while
    // a sign-in ran, stays there.
    const lost = !focused || focused === document.body || focused.matches(":disabled");
    if (challenge !== shownChallenge.current) {
      shownChallenge.current = challenge;
      // A new or repeated challenge asks for a code. When it ends, its removed controls
      // leave focus on the page; the status then says how it ended, unless the end opened
      // another control to fill, such as the master password to finish a first sign-in.
      if (challenge) focusNext.current = codeInput;
      else if (focusNext.current === codeInput) focusNext.current = undefined;
      if (!challenge && !focusNext.current && (!focused || focused === document.body))
        statusOutput.current?.focus({ preventScroll: true });
    }
    // The control may only now be shown, or still disabled while an operation finishes. An
    // operation started in this render, such as the email send choosing email starts, has
    // not disabled it yet.
    const target = focusNext.current?.current;
    if (target?.isConnected && !target.matches(":disabled") && !operation.current) {
      focusNext.current = undefined;
      if (lost || focused.closest("#bitwarden")) target.focus();
      return;
    }
    // A control the result removed or disabled, such as Cancel setup with nothing left to
    // cancel, leaves focus on the page; the status says what happened.
    if (finished && !focusNext.current && lost)
      statusOutput.current?.focus({ preventScroll: true });
  });
  const previewEnvironment: BitwardenProfile["environment"] =
    existing?.environment ??
    (region === "self-hosted"
      ? { kind: "self-hosted", baseUrl: baseUrl.trim() }
      : { kind: "cloud", region: region === "eu" ? "eu" : "us" });
  const origins = providerPermissionOrigins(previewEnvironment);
  const formOpen = addOpen ?? !connections.length;
  const cancelable = busy || !!challenge || !!password || !!code || !!existing;
  return {
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
    unlocking,
    setUnlocking,
    signInAgain,
    syncConnection,
    menuTriggers,
    receive,
    client,
    unlockConnection,
    renderAccess,
    keepConnectionButton,
    deleting,
    renderOthers,
    statusKnown,
    acceptedSettings,
    reviewBlocked,
    unsavedChanges,
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
  };
}

export type BitwardenSetupModel = ReturnType<typeof useBitwardenSetup>;
