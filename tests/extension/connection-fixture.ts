import type { Page } from "@playwright/test";
import type {
  SetupBegin,
  SetupContinuation,
  SetupReply,
} from "../../apps/extension/src/connections/types";
import type { SettingsRequest, SettingsResponse } from "../../packages/contracts/src/index";
import type { CustomAccountVariant } from "../../packages/bitwarden/src/__fixtures__/connection";
import { v1Email, v1Password } from "../../packages/bitwarden/src/__fixtures__/crypto";

type Port = {
  postMessage(value: unknown): void;
  onMessage: {
    addListener(listener: (value: { requestId: string; result: SetupReply }) => void): void;
    removeListener(listener: (value: { requestId: string; result: SetupReply }) => void): void;
  };
  onDisconnect: {
    addListener(listener: () => void): void;
    removeListener(listener: () => void): void;
  };
};
type ExtensionScope = typeof globalThis & {
  chrome: {
    runtime: {
      connect(options: { name: string }): Port;
      sendMessage(value: unknown): Promise<unknown>;
    };
  };
  syntheticSetupPort?: Port;
};
type Request =
  | { type: "connection.begin"; input: SetupBegin }
  | { type: "connection.continue"; input: SetupContinuation }
  | { type: "connection.status" }
  | { type: "connection.sync" | "connection.disable"; connectionId: string }
  | { type: "connection.cancel"; flowId: string }
  | {
      type: "connection.review";
      input: {
        connectionId: string;
        itemId: string;
        snapshotId: string;
        expectedRevision: number;
        excludedFieldIds: string[];
      };
    };

/** Uses Chrome's actual exact-options sender identity; no page-supplied caller role. */
export function setupRequest(page: Page, request: Request): Promise<SetupReply> {
  return page.evaluate(async (input) => {
    const scope = globalThis as ExtensionScope;
    const port = (scope.syntheticSetupPort ??= scope.chrome.runtime.connect({
      name: "pateat.bitwarden-setup.v1",
    }));
    const requestId = crypto.randomUUID();
    return new Promise<SetupReply>((resolve, reject) => {
      const finish = () => {
        clearTimeout(timer);
        port.onMessage.removeListener(message);
        port.onDisconnect.removeListener(disconnected);
      };
      const message = (value: { requestId: string; result: SetupReply }) => {
        if (value.requestId === requestId) {
          finish();
          resolve(value.result);
        }
      };
      const disconnected = () => {
        finish();
        delete scope.syntheticSetupPort;
        reject(new Error("Synthetic setup Port disconnected"));
      };
      const timer = setTimeout(() => {
        finish();
        reject(new Error("Synthetic setup reply timed out"));
      }, 20_000);
      port.onMessage.addListener(message);
      port.onDisconnect.addListener(disconnected);
      port.postMessage({ ...input, requestId });
    });
  }, request);
}
export function beginInput(label = "Synthetic vault"): Extract<SetupBegin, { kind: "new" }> {
  return {
    kind: "new",
    environment: { kind: "cloud", region: "us" },
    label,
    email: v1Email,
    password: v1Password,
    enabled: true,
  };
}
export type ProbeStatus = {
  ok: true;
  permission: boolean;
  calls: number;
  preloginCalls: number;
  tokenCalls: number;
  syncCalls: number;
  configuredIds: string[];
  metadataOnly: boolean;
  revision: number;
  catalogs: {
    connectionId: string;
    snapshotId?: string;
    itemCount: number;
    quarantineCount: number;
    state: string;
  }[];
};
export type ProbeRequest =
  | {
      action: "configure";
      variant: CustomAccountVariant;
      challenge?: "none" | "mfa" | "new-device" | "rejected";
      permission?: boolean;
      overflow?: "group-refs";
    }
  | { action: "status" | "inspect" }
  | { action: "resolve"; field: "password" | "custom-0" | "custom-1" | "linked" };
export function setupProbe<T = ProbeStatus>(page: Page, request: ProbeRequest): Promise<T> {
  return page.evaluate(
    async (input) =>
      (globalThis as ExtensionScope).chrome.runtime.sendMessage({
        type: "setup.probe",
        ...input,
      }) as Promise<T>,
    request,
  );
}
export async function settingsRequest(
  page: Page,
  request: SettingsRequest = { version: 1, type: "settings.get" },
): Promise<Extract<SettingsResponse, { ok: true }>> {
  const result = await page.evaluate(
    async (input) =>
      (globalThis as ExtensionScope).chrome.runtime.sendMessage(input) as Promise<SettingsResponse>,
    request,
  );
  if (!result.ok) throw new Error(`Synthetic settings operation: ${result.error.code}`);
  return result;
}
/** Return flags only, never durable keys or an arbitrary decrypted object. */
export function inspectSetupPersistence(page: Page) {
  return page.evaluate(async () => {
    const scope = globalThis as unknown as {
      chrome: { storage: { local: { get(value: null): Promise<unknown> } } };
    };
    const metadata = await scope.chrome.storage.local.get(null);
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const open = indexedDB.open("pateat.local-vault.v1", 1);
      open.onsuccess = () => resolve(open.result);
      open.onerror = () => reject(new Error("Synthetic database open failed"));
    });
    try {
      const records = await new Promise<unknown[]>((resolve, reject) => {
        const tx = db.transaction("records", "readonly");
        const get = tx.objectStore("records").getAll();
        tx.oncomplete = () => resolve(get.result);
        tx.onerror = () => reject(new Error("Synthetic record read failed"));
      });
      const prohibited = new Set([
        "password",
        "masterPasswordHash",
        "accessToken",
        "refreshToken",
        "access_token",
        "refresh_token",
      ]);
      // Encrypted provider DTOs legitimately use names such as login.password.
      // Check their plaintext separately while inspecting the surrounding record/configuration.
      const unexpectedKey = (value: unknown): boolean =>
        value !== null &&
        typeof value === "object" &&
        Object.entries(value).some(
          ([key, child]) => key !== "prepared" && (prohibited.has(key) || unexpectedKey(child)),
        );
      const serialized = JSON.stringify({ metadata, records });
      return {
        records: records.length,
        noCredentialProperties: !unexpectedKey({ metadata, records }),
        passwordAbsent: !serialized.includes("asdfasdfasdf"),
        plaintextAbsent: !serialized.includes("test_password") && !serialized.includes("00001234"),
      };
    } finally {
      db.close();
    }
  });
}
