import { vi } from "vitest";
import {
  createDefaultSettings,
  localSettingsSchema,
  type LoginAccount,
  type LoginDocument,
  type SettingsResponse,
  type SettingsSnapshot,
  type SsoMapping,
  type VaultConnectionMetadata,
} from "@pateat/contracts";
import * as v from "valibot";
import { setAccountPolicy } from "../vault/__fixtures__/policy";
import { createSsoChoiceController, type SsoChoiceInput } from "./sso-choice";
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
  let current = true;
  let path = "/ready";
  const readSettings = vi.fn(async (): Promise<SettingsResponse> => structuredClone(saved));
  const currentDocument = vi.fn((): string | undefined => (current ? path : undefined));
  /** The settings store's trusted update: one revision per write, with its cause. */
  const updateSettings = vi.fn(
    async (
      expected: number | undefined,
      cause: NonNullable<SettingsSnapshot["changes"]>[number]["cause"],
      mutate: (snapshot: SettingsSnapshot) => SettingsSnapshot,
      authorize?: (snapshot: SettingsSnapshot) => Promise<boolean>,
    ) => {
      const before = structuredClone(saved.snapshot);
      if (expected !== undefined && expected !== before.revision)
        throw new Error("revision-conflict");
      if (authorize && !(await authorize(structuredClone(before))))
        throw new Error("update-not-authorized");
      const next = mutate(structuredClone(before));
      v.parse(localSettingsSchema, next.settings);
      saved.snapshot = {
        ...next,
        revision: before.revision + 1,
        changes: [...(before.changes ?? []), { revision: before.revision + 1, cause }],
      };
      return structuredClone(saved.snapshot);
    },
  );
  const controller = createSsoChoiceController({
    source,
    readSettings,
    currentDocument,
    updateSettings,
  });
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
    updateSettings,
    saved,
    readSettings,
    currentDocument,
    input,
    request,
    offer,
    choose,
    methods,
    candidateLists,
    records: () => saved.snapshot.settings.ssoMappings ?? [],
    setCurrent: (value: boolean) => {
      current = value;
    },
    setPath: (value: string) => {
      path = value;
    },
    /** Mappings the settings held before the offer, at the same revision. */
    setRecords: (value: SsoMapping[]) => {
      saved.snapshot.settings.ssoMappings = structuredClone(value);
    },
    /** A settings write of another cause, as another setting saved meanwhile. */
    revise: (cause: NonNullable<SettingsSnapshot["changes"]>[number]["cause"]) =>
      updateSettings(undefined, cause, (snapshot) => snapshot),
  };
}
export type SsoHarness = ReturnType<typeof ssoHarness>;
