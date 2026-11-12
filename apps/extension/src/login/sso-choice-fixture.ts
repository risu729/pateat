import { vi } from "vitest";
import {
  createDefaultSettings,
  type LoginAccount,
  type LoginDocument,
  type SettingsResponse,
  type VaultConnectionMetadata,
} from "@pateat/contracts";
import { setAccountPolicy } from "../vault/__fixtures__/policy";
import { createSsoChoiceController, type SsoChoiceInput } from "./sso-choice";
import { createSsoMappingStore, type SsoMapping } from "./sso-mapping-store";
import type { SafeSsoMethod, SsoCandidate, SsoSourceRef, VaultSsoSource } from "./sso-vault";
export const origin = "https://site.example.test";
export const idpOrigin = "https://idp.example.test";
export const sourceItem = "a0000000-0000-4000-8000-000000000001";
export const targetItem = "a0000000-0000-4000-8000-000000000002";
export const otherItem = "a0000000-0000-4000-8000-000000000003";
export const snapshotId = "b0000000-0000-4000-8000-000000000001";
export const evidence = "E".repeat(43);
export const account: LoginAccount = { origin, connectionId: "site", itemId: sourceItem };
export const document: LoginDocument = {
  origin,
  tabId: 7,
  frameId: 0,
  documentId: "site-document",
};
export const selected = { account: { connectionId: "idp", itemId: targetItem }, origin: idpOrigin };
export const sourceRef = (number = 1): SsoSourceRef => ({
  account: { connectionId: "site", itemId: sourceItem },
  method: { number },
  sourceEvidence: evidence,
});
export function connection(id: string, itemId: string): VaultConnectionMetadata {
  return {
    id,
    label: `Synthetic ${id} vault`,
    provider: "bitwarden",
    server: "cloud-us",
    userId: id === "site" ? sourceItem : targetItem,
    snapshotId,
    state: "ready",
    groups: [],
    items: [
      {
        id: itemId,
        label: `Synthetic ${id} item`,
        allowedOrigins: [],
        groupIds: [],
        fields: [
          { id: "login.username", label: "Username", name: null, kind: "text" },
          { id: "login.password", label: "Password", name: null, kind: "hidden" },
        ],
      },
    ],
  };
}
export function ssoHarness(
  methods: SafeSsoMethod[] = [
    { method: { number: 1 }, automatic: true, form: "bracket", label: "Synthetic provider" },
  ],
) {
  const catalog = {
    connections: [
      connection("site", sourceItem),
      connection("idp", targetItem),
      connection("other", otherItem),
    ],
  };
  const settings = createDefaultSettings(catalog);
  for (const entry of catalog.connections) setAccountPolicy(settings, entry);
  const saved: Extract<SettingsResponse, { ok: true }> = {
    version: 1,
    ok: true,
    snapshot: { version: 1, revision: 7, settings },
    catalog,
  };
  const candidateLists = new Map<number, SsoCandidate[]>([
    [1, [{ account: selected.account, snapshotId, origins: [idpOrigin] }]],
    [
      2,
      [
        {
          account: { connectionId: "other", itemId: otherItem },
          snapshotId,
          origins: ["https://other-idp.example.test"],
        },
      ],
    ],
  ]);
  const source = {
    describe: vi.fn<VaultSsoSource["describe"]>(async () => ({
      ok: true,
      data: {
        sourceEvidence: evidence,
        policyRevision: saved.snapshot.revision,
        methods: structuredClone(methods),
      },
    })),
    candidates: vi.fn<VaultSsoSource["candidates"]>(async (reference) => ({
      ok: true,
      data: {
        sourceEvidence: evidence,
        policyRevision: saved.snapshot.revision,
        candidates: structuredClone(candidateLists.get(reference.method.number) ?? []),
      },
    })),
    validate: vi.fn<VaultSsoSource["validate"]>(async () => ({
      ok: true,
      data: { sourceEvidence: evidence, policyRevision: saved.snapshot.revision, candidates: [] },
    })),
  };
  let records: SsoMapping[] = [];
  let current = true;
  const record = {
    read: vi.fn(async () => structuredClone(records)),
    write: vi.fn(async (value: SsoMapping[]) => {
      records = structuredClone(value);
    }),
    clear: vi.fn(async () => {
      records = [];
    }),
  };
  const store = createSsoMappingStore(record);
  const readSettings = vi.fn(async (): Promise<SettingsResponse> => structuredClone(saved));
  const currentDocument = vi.fn(() => current);
  const controller = createSsoChoiceController({ source, store, readSettings, currentDocument });
  const input: SsoChoiceInput = { account, document, native: { passkey: true, password: true } };
  const request = (extra: Partial<SsoChoiceInput> = {}) =>
    controller.request({ ...input, ...extra });
  const offer = async () => {
    const response = await controller.get(7);
    if (!response.ok || !response.offer) throw new Error("No SSO offer");
    return response.offer;
  };
  const choose = async (
    kind: "mapping" | "sso" = "mapping",
    number = 1,
    extra: Record<string, unknown> = {},
  ) => {
    const shown = await offer();
    const method = shown.methods.find((entry) => entry.method.number === number)!;
    return controller.choose({
      tabId: 7,
      offerId: shown.id,
      selection: { kind, method: method.method, candidateId: method.candidates[0]!.id, ...extra },
    });
  };
  return {
    controller,
    source,
    store,
    record,
    saved,
    readSettings,
    currentDocument,
    input,
    request,
    offer,
    choose,
    methods,
    candidateLists,
    records: () => records,
    setCurrent: (value: boolean) => {
      current = value;
    },
  };
}
export type SsoHarness = ReturnType<typeof ssoHarness>;
