import {
  createSettingsStore,
  type LocalSettings,
  type SettingsSnapshot,
  type SyncSettingsState,
} from "@pateat/contracts";
import type { ServiceConnection } from "../runtime";
import { createSettingsSync } from "../settings-sync";
import type { ServiceTransport, SettingsResult } from "../transport";

// A synthetic settings service shared by paired devices, with the service's
// compare-and-swap write and each device's `written` (services/api/src/settings-store.ts),
// and devices whose requests and storage writes can be made to fail. Synthetic service,
// device and credential values only.

export const SERVICE = "https://pateat.example.com";
const PROFILE = "00000000-0000-4000-8000-000000000010";

export const settingsOf = (parts: Partial<LocalSettings> = {}): LocalSettings => ({
  connections: [],
  accountPolicies: [],
  itemPolicies: [],
  customFieldReviews: [],
  excludedSites: [],
  passkeyBrowserSites: [],
  repromptSites: [],
  siteDefaults: [],
  bindings: [],
  detailLinks: [],
  ...parts,
});
export const site = (hostname: string) => ({ hostname, includeSubdomains: false });
export const hostnames = (settings: LocalSettings | null | undefined) =>
  (settings?.excludedSites ?? []).map((entry) => entry.hostname).toSorted();

/** One upload the service stored: who sent it and the document before and after. */
export type Commit = { credential: string; before: LocalSettings | null; after: LocalSettings };

/** `committed` is told of each upload the service stores, as it stores it. */
export function settingsService(committed?: (commit: Commit) => void) {
  let state: SyncSettingsState = { version: 1, profileId: PROFILE, revision: 0, settings: null };
  const written = new Map<string, string>();
  const commits: Commit[] = [];
  const answer = (credential: string): SyncSettingsState => {
    const own = written.get(credential);
    return structuredClone({ ...state, ...(own === undefined ? {} : { written: own }) });
  };
  return {
    commits,
    state: () => state,
    /** A write of another device, or of the owner's web UI, which no device sees as its own. */
    write(settings: LocalSettings) {
      const after = structuredClone({ ...settings, connections: [] });
      commits.push({ credential: "", before: state.settings, after });
      state = { ...state, revision: state.revision + 1, settings: after };
    },
    /** The device's requests; `faults` decides how the next ones fail. */
    transport(faults: DeviceFaults): Pick<ServiceTransport, "settings" | "saveSettings"> {
      return {
        settings: async (_, credential): Promise<SettingsResult> => {
          await faults.pause?.();
          return { kind: "state", state: answer(credential) };
        },
        saveSettings: async (_, credential, write): Promise<SettingsResult> => {
          await faults.pause?.();
          const fault = faults.upload?.();
          if (fault === "unsent") return { kind: "failed", error: "unreachable" };
          if (write.expectedRevision !== state.revision)
            return { kind: "conflict", current: answer(credential) };
          const after = structuredClone(write.settings);
          commits.push({ credential, before: state.settings, after });
          committed?.({ credential, before: state.settings, after });
          state = { ...state, revision: state.revision + 1, settings: after };
          if (write.writeId === undefined) written.delete(credential);
          else written.set(credential, write.writeId);
          // The answer is the state this write made, as the service's is.
          const stored = answer(credential);
          await faults.pause?.();
          if (fault === "answer-lost") return { kind: "failed", error: "unreachable" };
          return { kind: "state", state: stored };
        },
      };
    },
  };
}

type UploadFault = "unsent" | "answer-lost";

/** Fails the next upload only. */
export function nextUpload(fault: UploadFault) {
  let used = false;
  return () => {
    if (used) return undefined;
    used = true;
    return fault;
  };
}

export type DeviceFaults = {
  /** Decides how each upload fails: before it reaches the service, or after it committed. */
  upload?: () => UploadFault | undefined;
  /** Decides how a write of the sync base fails, from the base it would write. */
  base?: (next: Record<string, unknown>) => "fails" | "hangs" | undefined;
  /** Awaited around each request and before each base write, so a test can interleave. */
  pause?: () => Promise<void>;
};

/** `wrote` is told of each local settings write a sync makes, after it landed. */
export function settingsDevice(
  service: ReturnType<typeof settingsService>,
  number: number,
  wrote?: (snapshot: SettingsSnapshot) => void,
) {
  const connection: ServiceConnection = {
    origin: SERVICE,
    deviceId: `00000000-0000-4000-8000-${String(number).padStart(12, "0")}`,
    credential: `pateat_device_${String.fromCharCode(64 + number).repeat(43)}`,
    rejected: false,
  };
  const faults: DeviceFaults = {};
  let snapshot: SettingsSnapshot = { version: 1, revision: 1, settings: settingsOf() };
  const store = createSettingsStore(
    {
      read: async () => structuredClone(snapshot),
      write: async (next) => {
        snapshot = structuredClone(next) as SettingsSnapshot;
      },
    },
    { connections: [] },
  );
  let base: unknown;
  /** Settles when a base write stops the worker. */
  let stop = Promise.withResolvers<void>();
  let stopped = false;
  const storage = {
    read: async () => structuredClone(base),
    write: async (next: Record<string, unknown>) => {
      await faults.pause?.();
      const fault = faults.base?.(next);
      if (fault === "fails") throw new Error("synthetic storage failure");
      // A worker stopped here: neither this write nor anything after it happens.
      if (fault === "hangs") {
        stopped = true;
        stop.resolve();
        return new Promise<void>(() => undefined);
      }
      base = structuredClone(next);
    },
    clear: async () => {
      base = undefined;
    },
  };
  // A new instance over the same storage stands for a restarted service worker.
  const settings = {
    read: () => store.read(),
    update: async (...args: Parameters<typeof store.update>) => {
      const next = await store.update(...args);
      wrote?.(next);
      return next;
    },
  };
  /** The last service state this device received. */
  let received: SyncSettingsState | undefined;
  const note = (result: SettingsResult) => {
    if (result.kind === "state") received = result.state;
    if (result.kind === "conflict") received = result.current;
    return result;
  };
  const transport = service.transport(faults);
  const watched: typeof transport = {
    settings: async (...args) => note(await transport.settings(...args)),
    saveSettings: async (...args) => note(await transport.saveSettings(...args)),
  };
  const start = () => createSettingsSync({ transport: watched, settings, storage });
  let sync = start();
  return {
    connection,
    faults,
    run: () => sync.run(connection, () => false),
    stopped: () => stopped,
    /** Settles when a base write stops this worker. */
    whenStopped: () => stop.promise,
    restart: () => {
      stopped = false;
      stop = Promise.withResolvers<void>();
      sync = start();
    },
    /** A change the person makes on this device. */
    edit: (change: (settings: LocalSettings) => LocalSettings) =>
      store.update(undefined, "settings-save", (current) => ({
        ...current,
        settings: change(current.settings),
      })),
    settings: () => snapshot.settings,
    base: () => base,
    received: () => received,
  };
}

/** Adds `hostname` to the excluded sites. */
export const exclude = (hostname: string) => (settings: LocalSettings) => ({
  ...settings,
  excludedSites: [...settings.excludedSites, site(hostname)],
});
/** Removes `hostname` from the excluded sites. */
export const include = (hostname: string) => (settings: LocalSettings) => ({
  ...settings,
  excludedSites: settings.excludedSites.filter((entry) => entry.hostname !== hostname),
});
