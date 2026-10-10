import { afterEach, expect, it, vi } from "vitest";
import { createConnectionClient } from "../options/connection-client";
import { SETUP_PORT } from "./wire";

function channel() {
  let message: (input: unknown) => void = () => {};
  let disconnected: () => void = () => {};
  const port = {
    postMessage: vi.fn(),
    disconnect: vi.fn(),
    onMessage: {
      addListener: (listener: typeof message) => {
        message = listener;
      },
    },
    onDisconnect: {
      addListener: (listener: typeof disconnected) => {
        disconnected = listener;
      },
    },
  };
  return { port, message: (input: unknown) => message(input), disconnected: () => disconnected() };
}
const clients: ReturnType<typeof createConnectionClient>[] = [];
afterEach(() => {
  for (const client of clients.splice(0)) client.close();
});
function harness() {
  const first = channel(),
    second = channel();
  const connect = vi.fn().mockReturnValueOnce(first.port).mockReturnValue(second.port);
  const requestPermission = vi.fn(async (_origins: string[]) => true);
  const client = createConnectionClient({ connect, requestPermission });
  clients.push(client);
  return { client, first, second, connect, requestPermission };
}
function firstId(h: ReturnType<typeof harness>) {
  return h.first.port.postMessage.mock.calls[0]![0].requestId as string;
}

it("requests canonical provider permissions immediately from the caller gesture", async () => {
  const h = harness();
  const pending = h.client.requestProviderPermission({ kind: "cloud", region: "eu" });
  expect(h.requestPermission).toHaveBeenCalledWith([
    "https://identity.bitwarden.eu/*",
    "https://api.bitwarden.eu/*",
  ]);
  expect(await pending).toBe(true);
  expect(h.connect).not.toHaveBeenCalled();
});
it("invalid provider configuration never calls permissions.request", async () => {
  const h = harness();
  expect(
    await h.client.requestProviderPermission({
      kind: "self-hosted",
      baseUrl: "http://vault.example",
    }),
  ).toBe(false);
  expect(h.requestPermission).not.toHaveBeenCalled();
});
it("correlates only fixed request IDs without a page-supplied caller role", async () => {
  const h = harness();
  const pending = h.client.list();
  const request = h.first.port.postMessage.mock.calls[0]![0];
  expect(Object.keys(request).sort()).toEqual(["requestId", "type"]);
  expect(request.type).toBe("connection.status");
  expect(h.connect).toHaveBeenCalledWith(SETUP_PORT);
  let settled = false;
  void pending.then(() => {
    settled = true;
    return undefined;
  });
  h.first.message({
    requestId: crypto.randomUUID(),
    result: { ok: true, kind: "status", connections: [] },
  });
  await Promise.resolve();
  expect(settled).toBe(false);
  h.first.message({ requestId: firstId(h), result: { ok: true, kind: "status", connections: [] } });
  expect(await pending).toEqual({ ok: true, kind: "status", connections: [] });
});
it.each([
  {
    ok: true,
    kind: "ready",
    connectionId: "synthetic",
    snapshotId: crypto.randomUUID(),
    policyReviewItemIds: [],
    accessToken: "synthetic-secret-token",
  },
  { ok: false, error: { code: "provider leaked synthetic-secret-password" } },
  { ok: true, kind: "mfa-required", flowId: crypto.randomUUID(), providers: [5] },
])(
  "closes the private channel rather than exposing malformed metadata reply %#",
  async (result) => {
    const h = harness();
    const pending = h.client.list();
    h.first.message({ requestId: firstId(h), result });
    await expect(pending).rejects.toThrow("Connection operation could not be confirmed.");
    expect(h.first.port.disconnect).toHaveBeenCalledTimes(1);
  },
);
it("resolves a code-only provider HTTP failure as an error reply", async () => {
  const h = harness();
  const pending = h.client.sync("synthetic");
  h.first.message({ requestId: firstId(h), result: { ok: false, error: { code: "http-error" } } });
  expect(await pending).toEqual({ ok: false, error: { code: "http-error" } });
  expect(h.first.port.disconnect).not.toHaveBeenCalled();
});
it("closes the channel when an error reply carries fields beyond its code", async () => {
  const h = harness();
  const pending = h.client.sync("synthetic");
  h.first.message({
    requestId: firstId(h),
    result: { ok: false, error: { code: "http-error", status: 500 } },
  });
  await expect(pending).rejects.toThrow("Connection operation could not be confirmed.");
  expect(h.first.port.disconnect).toHaveBeenCalledTimes(1);
});
it("closing pending credential work rejects once and never replays on a fresh channel", async () => {
  const h = harness();
  const input = {
    kind: "new" as const,
    environment: { kind: "cloud" as const, region: "us" as const },
    label: "Synthetic",
    email: "test@example.test",
    password: "synthetic-local-only-password",
    enabled: true,
  };
  const pending = h.client.begin(input);
  const oldId = firstId(h);
  h.client.close();
  await expect(pending).rejects.toThrow("Connection operation could not be confirmed.");
  const status = h.client.list();
  h.first.message({
    requestId: oldId,
    result: {
      ok: true,
      kind: "ready",
      connectionId: "synthetic",
      snapshotId: crypto.randomUUID(),
      policyReviewItemIds: [],
    },
  });
  expect(h.second.port.postMessage).toHaveBeenCalledTimes(1);
  expect(h.second.port.postMessage.mock.calls[0]![0].type).toBe("connection.status");
  h.second.message({
    requestId: h.second.port.postMessage.mock.calls[0]![0].requestId,
    result: { ok: true, kind: "status", connections: [] },
  });
  expect((await status).ok).toBe(true);
  expect(h.first.port.postMessage).toHaveBeenCalledTimes(1);
});
it("native disconnect withholds a pending result without automatically reconnecting", async () => {
  const h = harness();
  const pending = h.client.list();
  h.first.disconnected();
  await expect(pending).rejects.toThrow("Connection operation could not be confirmed.");
  expect(h.connect).toHaveBeenCalledTimes(1);
});
