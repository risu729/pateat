import { chromium, type BrowserContext, type Page, type Worker } from "@playwright/test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve as resolvePath } from "node:path";
import { fileURLToPath } from "node:url";
import { accountProfile } from "../../packages/bitwarden/src/__fixtures__/account";

const repository = fileURLToPath(new URL("../../", import.meta.url));
const probeDirectory = resolvePath(repository, "apps/extension/.output/chrome-mv3-probe");

export type VaultBrowser = {
  context: BrowserContext;
  background: Worker;
  page: Page;
  extensionId: string;
};

/** Reopen the same isolated profile; delete it only after all restart assertions. */
export async function withVaultProfile(
  run: (open: () => Promise<VaultBrowser>, externalRequests: string[]) => Promise<void>,
) {
  const profile = await mkdtemp(resolvePath(tmpdir(), "pateat-vault-test-"));
  let context: BrowserContext | undefined;
  const externalRequests: string[] = [];
  try {
    const open = async () => {
      await context?.close();
      context = await chromium.launchPersistentContext(profile, {
        channel: "chromium",
        headless: true,
        args: [
          `--disable-extensions-except=${probeDirectory}`,
          `--load-extension=${probeDirectory}`,
        ],
      });
      context.on("request", (request) => {
        const url = new URL(request.url());
        if (url.protocol === "http:" || url.protocol === "https:")
          externalRequests.push(`${url.protocol}//${url.hostname}`);
      });
      const background =
        context.serviceWorkers()[0] ?? (await context.waitForEvent("serviceworker"));
      const extensionId = new URL(background.url()).hostname;
      const page = await context.newPage();
      await page.goto(`chrome-extension://${extensionId}/crypto-probe.html`);
      return { context, background, page, extensionId };
    };
    await run(open, externalRequests);
  } finally {
    await context?.close();
    await rm(profile, { recursive: true, force: true });
  }
}

type Handle = {
  managerGeneration: string;
  handleId: string;
  connectionId: string;
  userId: string;
  recordId: string;
  snapshotId: string;
};
export type Accepted = {
  handle: Handle;
  summary: {
    revision: string;
    autoUnlock: "enabled" | "disabled";
    accountVersion?: "v1" | "v2";
    securityVersion?: 1 | 2;
  };
};
export type VaultStatus = {
  generation: string;
  busy: boolean;
  ready: boolean;
  storageUncertain: boolean;
  handle?: Handle;
  checkpoint: "before-write" | "after-write" | null;
  reached: boolean;
  host: { generation: string; sessions: number; ready: boolean };
};
export type VaultInspection = {
  exists: boolean;
  state: "active" | "disabled" | "missing";
  revision: string | null;
  recordId: string | null;
  snapshotId: string | null;
  keyStored: boolean;
  passwordAbsent: boolean;
  tokensAbsent: boolean;
  plaintextAbsent: boolean;
};
type FixedAction =
  | "restore"
  | "disable"
  | "resolve"
  | "status"
  | "inspect"
  | "release"
  | "abort"
  | "cas-conflict"
  | "export-gate"
  | "oversize"
  | "corrupt-key";
export type VaultRequest =
  | { action: FixedAction }
  | {
      action: "accept";
      kind:
        | "v1"
        | "v2"
        | "organization"
        | "corrupt-last"
        | "unavailable"
        | "uri"
        | "uri-without-context";
      autoUnlock?: "enable" | "preserve";
    }
  | { action: "match"; url: string }
  | { action: "arm"; checkpoint: "before-write" | "after-write" };
export type VaultResult<T> = { ok: true; data: T } | { ok: false; error: { code: string } };
export function invokeVault<T>(page: Page, request: VaultRequest): Promise<VaultResult<T>> {
  return page.evaluate(async (fixed) => {
    const browser = globalThis as unknown as {
      chrome: { runtime: { sendMessage(message: unknown): Promise<unknown> } };
    };
    return (await browser.chrome.runtime.sendMessage({
      type: "vault.probe",
      ...fixed,
    })) as VaultResult<T>;
  }, request);
}

export async function vaultData<T>(page: Page, request: VaultRequest): Promise<T> {
  const result = await invokeVault<T>(page, request);
  if (!result.ok) throw new Error(`Synthetic vault action ${request.action}: ${result.error.code}`);
  return result.data;
}

/** Test-only native DB writer. Reads remain inside the trusted extension page. */
export function mutateNativeVault(page: Page, action: "abort" | "malformed" | "replace") {
  return page.evaluate(
    async ({ connectionId, operation }) => {
      const db = await new Promise<IDBDatabase>((resolve, reject) => {
        const opening = indexedDB.open("pateat.local-vault.v1", 1);
        opening.onsuccess = () => resolve(opening.result);
        opening.onerror = () => reject(new Error("Synthetic database open failed"));
      });
      let committed = false;
      let aborted = false;
      let previous = "";
      try {
        await new Promise<void>((resolve, reject) => {
          const tx = db.transaction("records", "readwrite", { durability: "strict" });
          tx.oncomplete = () => {
            committed = true;
            resolve();
          };
          tx.onabort = () => {
            aborted = true;
            resolve();
          };
          tx.onerror = () => reject(new Error("Synthetic database write failed"));
          const records = tx.objectStore("records");
          const get = records.get(connectionId);
          get.onsuccess = () => {
            const record = get.result as Record<string, unknown>;
            previous = JSON.stringify(record);
            const next =
              operation === "malformed"
                ? { schemaVersion: 99 }
                : { ...record, revision: crypto.randomUUID() };
            const put = records.put(next, connectionId);
            // Actual request success precedes transaction completion. Aborting
            // here must roll back the write rather than publish a new revision.
            if (operation === "abort") put.onsuccess = () => tx.abort();
          };
        });
        const unchanged = await new Promise<boolean>((resolve, reject) => {
          const tx = db.transaction("records", "readonly");
          const get = tx.objectStore("records").get(connectionId);
          let same = false;
          get.onsuccess = () => {
            same = JSON.stringify(get.result) === previous;
          };
          tx.oncomplete = () => resolve(same);
          tx.onabort = () => reject(new Error("Synthetic database read failed"));
        });
        return { committed, aborted, unchanged };
      } finally {
        db.close();
      }
    },
    { connectionId: accountProfile.connectionId, operation: action },
  );
}
