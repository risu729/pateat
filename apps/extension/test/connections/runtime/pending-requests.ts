import { expect, it, vi, type Mock } from "vitest";
import type { CryptoHost } from "../../../src/crypto/host";
import type { VaultEntry } from "../../../src/vault/record";
import { activeEntry, lockedEntry } from "../../../src/vault/__fixtures__/vault";
import type { createConnectionRuntime } from "../../../src/connections/runtime";

export function registerPendingRequestCases<
  Host extends { open: Mock<CryptoHost["open"]> },
  Timeout extends {
    used: Mock<(opened?: string) => Promise<void>>;
  },
>({
  stored,
  sessionKeys,
  id,
  timeout,
  runtimeWith,
  port,
  heldOpen,
}: {
  stored: { entry: VaultEntry | null; writable: boolean };
  sessionKeys: Map<string, { revision: string; userKey: string }>;
  id: string;
  timeout: () => Timeout;
  runtimeWith: (options: {
    vaultTimeout: Timeout;
    retention?: () => Promise<"durable" | "session">;
  }) => { host: Host; runtime: ReturnType<typeof createConnectionRuntime> };
  port: () => { request: (message: Record<string, unknown>) => Promise<unknown> };
  heldOpen: (host: Host) => () => void;
}) {
  it("a retry leaves a vault being unlocked owed", async () => {
    stored.entry = lockedEntry();
    stored.writable = true;
    const vaultTimeout = timeout();
    const { host, runtime } = runtimeWith({ vaultTimeout });
    const release = heldOpen(host);
    const page = port();
    runtime.attach(page as never);
    const unlocking = page.request({
      type: "connection.unlock",
      input: { connectionId: id, password: "synthetic-password" },
    });
    await vi.waitFor(() => expect(host.open).toHaveBeenCalledOnce());
    expect(await runtime.timeOut("log-out", undefined, {})).toEqual({ closed: 0, failed: [id] });
    expect(await runtime.timeOut("log-out", [id], {})).toEqual({ closed: 0, failed: [id] });
    expect(stored.entry).toEqual(lockedEntry());
    release();
    expect(await unlocking).toMatchObject({ ok: true, kind: "unlocked" });
    await vi.waitFor(() => expect(vaultTimeout.used).toHaveBeenCalledWith(id));
    // Once the unlock is recorded, a retry acts on the vault again.
    await vi.waitFor(async () =>
      expect(await runtime.timeOut("lock", undefined, {})).toEqual({ closed: 1, failed: [] }),
    );
  });
  it("the timeout's own action still closes a vault being unlocked", async () => {
    stored.entry = lockedEntry();
    stored.writable = true;
    const vaultTimeout = timeout();
    const { host, runtime } = runtimeWith({ vaultTimeout, retention: async () => "session" });
    const release = heldOpen(host);
    const page = port();
    runtime.attach(page as never);
    const unlocking = page.request({
      type: "connection.unlock",
      input: { connectionId: id, password: "synthetic-password" },
    });
    await vi.waitFor(() => expect(host.open).toHaveBeenCalledOnce());
    expect(await runtime.timeOut("lock")).toEqual({ closed: 0, failed: [] });
    release();
    expect(await unlocking).toMatchObject({ ok: false });
    expect(sessionKeys.has(id)).toBe(false);
    expect(stored.entry).toEqual(lockedEntry());
  });
  it("a vault stays out of the retries until its unlock is recorded as use", async () => {
    stored.entry = lockedEntry();
    stored.writable = true;
    const vaultTimeout = timeout();
    let record!: () => void;
    vaultTimeout.used.mockImplementation(async (opened?: string) => {
      if (opened)
        await new Promise<void>((resolve) => {
          record = resolve;
        });
    });
    const { runtime } = runtimeWith({ vaultTimeout });
    const page = port();
    runtime.attach(page as never);
    expect(
      await page.request({
        type: "connection.unlock",
        input: { connectionId: id, password: "synthetic-password" },
      }),
    ).toMatchObject({ ok: true, kind: "unlocked" });
    await vi.waitFor(() => expect(vaultTimeout.used).toHaveBeenCalledWith(id));
    expect(await runtime.timeOut("lock", undefined, {})).toEqual({ closed: 0, failed: [id] });
    record();
    await vi.waitFor(async () =>
      expect(await runtime.timeOut("lock", undefined, {})).toEqual({ closed: 1, failed: [] }),
    );
  });
  it("a retry leaves a vault with a sign-in again in flight owed", async () => {
    stored.entry = activeEntry();
    stored.writable = true;
    const vaultTimeout = timeout();
    let started!: () => void;
    vaultTimeout.used.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          started = resolve;
        }),
    );
    const { runtime } = runtimeWith({ vaultTimeout });
    const page = port();
    runtime.attach(page as never);
    const signingIn = page.request({
      type: "connection.begin",
      input: { kind: "existing", connectionId: id, password: "synthetic-password" },
    });
    await vi.waitFor(() => expect(vaultTimeout.used).toHaveBeenCalledOnce());
    expect(await runtime.timeOut("lock", undefined, {})).toEqual({ closed: 0, failed: [id] });
    expect(stored.entry).toEqual(activeEntry());
    started();
    await signingIn;
    await vi.waitFor(async () =>
      expect(await runtime.timeOut("lock", undefined, {})).toEqual({ closed: 1, failed: [] }),
    );
  });
}
