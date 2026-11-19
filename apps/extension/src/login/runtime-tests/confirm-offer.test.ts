// The authenticated record's offer of a page for classification (ADR 0035 delivery 3):
// the person's pending **Log in now** keeps its own scope, so the page is not offered.
import { describe, expect, it, vi } from "vitest";
import type { LoginAttemptMetadata } from "@pateat/contracts";
const fake = await vi.hoisted(async () => (await import("./browser-fake")).createBrowserFake());
vi.mock("wxt/browser", () => ({ browser: fake.browser }));
vi.stubEnv("MODE", "production");
const { offersConfirmGeneration } = await import("../runtime/confirm-admit");
const { createConfirmState } = await import("../runtime/confirm-state");
import type { AdmitContext } from "../runtime/admit-context";
import type { ManualStart } from "../runtime/manual-scope";
import type { PickedAccount } from "../runtime/session-schemas";
import type { LiveDocument } from "../runtime/types";
import type { Runtime } from "../runtime/state";

const origin = "https://login.example";
const account = { origin, connectionId: "connection", itemId: "item" };
const live: LiveDocument = {
  document: { origin, tabId: 1, frameId: 0, documentId: "reconfirm" },
  token: "token",
  url: `${origin}/confirm`,
  path: "/confirm",
  incognito: false,
  seenAt: Date.now(),
  timing: { since: Date.now(), serviceMs: 0, networkMs: 0, personMs: 0 },
};
const recorded = {
  id: "login",
  state: "authenticated",
  document: live.document,
  account,
} as LoginAttemptMetadata;

function runtime() {
  const confirmFill = createConfirmState();
  confirmFill.healthy = true;
  confirmFill.proofs.push({ id: recorded.id, tabId: 1, ...account });
  return {
    confirmFill,
    manualStarts: new Map<number, ManualStart>(),
    picked: new Map<number, PickedAccount>(),
    documents: new Map([["1:0", live]]),
    recipes: {
      starts: vi.fn(async () => []),
      entries: vi.fn(async () => []),
      routes: vi.fn(async () => []),
    },
    generation: { available: vi.fn(async () => true as const) },
    uris: vi.fn(),
    vars: { origin: "https://probe.example" },
    options: {},
  } as unknown as Runtime;
}
const ctx = { paused: false, live, document: live.document, key: "1:0" } as AdmitContext;

describe("offersConfirmGeneration", () => {
  it("offers the page of the confirmed login, and not while a manual login is pending", async () => {
    const rt = runtime();
    expect(await offersConfirmGeneration(rt, ctx, recorded)).toBe(true);
    const pick: PickedAccount = {
      tabId: 1,
      origin,
      documentId: live.document.documentId,
      connectionId: account.connectionId,
      itemId: account.itemId,
      makeDefault: false,
      waitedMs: 0,
      manual: true,
      manualRequestId: "manual-request",
    };
    rt.picked.set(1, pick);
    rt.manualStarts.set(1, {
      document: live.document,
      url: live.url,
      path: live.path,
      topUrl: live.url,
      topDocumentId: live.document.documentId,
      expiresAt: Date.now() + 300_000,
      status: { requestId: "manual-request", state: "evaluating" },
      pick,
    });
    expect(await offersConfirmGeneration(rt, ctx, recorded)).toBe(false);
  });

  it("reads the session store before it reads the proofs", async () => {
    const rt = runtime();
    const loaded = Promise.withResolvers<void>();
    rt.confirmFill.loaded = loaded.promise;
    const proofs = rt.confirmFill.proofs.splice(0);
    const offer = offersConfirmGeneration(rt, ctx, recorded);
    // The store answers with the proof after the offer started.
    rt.confirmFill.proofs.push(...proofs);
    loaded.resolve();
    expect(await offer).toBe(true);
  });
});
