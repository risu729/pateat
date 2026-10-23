import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { startCryptoOffscreen } from "./offscreen";
import { CRYPTO_PORT } from "./wire";

const port = vi.hoisted(() => {
  const listeners = {
    message: [] as ((message: unknown) => void)[],
    disconnect: [] as (() => void)[],
  };
  return {
    name: "",
    sent: [] as unknown[],
    postMessage(message: unknown) {
      this.sent.push(message);
    },
    onMessage: {
      addListener: (listener: (message: unknown) => void) => listeners.message.push(listener),
    },
    onDisconnect: { addListener: (listener: () => void) => listeners.disconnect.push(listener) },
    deliver(message: unknown) {
      for (const listener of listeners.message) listener(message);
    },
    clear() {
      this.sent.length = 0;
      listeners.message.length = 0;
      listeners.disconnect.length = 0;
    },
  };
});
vi.mock("wxt/browser", () => ({
  browser: {
    runtime: {
      connect: ({ name }: { name: string }) => {
        port.name = name;
        return port;
      },
    },
  },
}));

/** A Dedicated Worker that never answers, like one whose SDK call threw outside its Promise. */
class SilentWorker {
  static created: SilentWorker[] = [];
  onmessage: ((event: MessageEvent<unknown>) => void) | null = null;
  onerror: ((event: { preventDefault(): void }) => void) | null = null;
  posted: unknown[] = [];
  terminated = 0;
  constructor() {
    SilentWorker.created.push(this);
  }
  postMessage(message: unknown) {
    this.posted.push(message);
  }
  terminate() {
    this.terminated += 1;
  }
}

const generation = "30000000-0000-4000-8000-000000000001";
const requestId = "30000000-0000-4000-8000-000000000002";
const connectionId = "synthetic-connection";
const open = {
  version: 1,
  type: "crypto.command",
  generation,
  requestId,
  connectionId,
  operation: {
    kind: "open",
    prepared: {},
    snapshotId: "30000000-0000-4000-8000-000000000003",
    unlock: { kind: "decrypted-key", userKey: "synthetic-user-key" },
  },
};

function started() {
  startCryptoOffscreen();
  port.deliver({ version: 1, type: "crypto.reset", generation });
  port.deliver(open);
  const [worker] = SilentWorker.created;
  if (!worker) throw new Error("No Worker was started");
  return worker;
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal("Worker", SilentWorker);
  vi.stubGlobal("window", { addEventListener: vi.fn() });
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  SilentWorker.created.length = 0;
  port.clear();
});

describe("offscreen Worker supervision", () => {
  it("answers crypto-failed and terminates the Worker when it reports an uncaught error", () => {
    const worker = started();
    expect(port.name).toBe(CRYPTO_PORT);
    expect(worker.posted).toHaveLength(1);
    const preventDefault = vi.fn();
    worker.onerror?.({ preventDefault });
    expect(preventDefault).toHaveBeenCalledOnce();
    expect(worker.terminated).toBe(1);
    expect(port.sent.at(-1)).toEqual({
      version: 1,
      type: "crypto.result",
      generation,
      requestId,
      connectionId,
      result: { ok: false, error: { code: "crypto-failed" } },
    });
    // The settled job's deadline no longer answers again.
    const answers = port.sent.length;
    vi.advanceTimersByTime(30_000);
    expect(port.sent).toHaveLength(answers);
  });

  it("answers timeout and terminates a Worker that never settles", () => {
    const worker = started();
    vi.advanceTimersByTime(29_999);
    expect(worker.terminated).toBe(0);
    vi.advanceTimersByTime(1);
    expect(worker.terminated).toBe(1);
    expect(port.sent.at(-1)).toMatchObject({
      type: "crypto.result",
      requestId,
      result: { ok: false, error: { code: "timeout" } },
    });
  });

  it("gives an Argon2id derivation 60 seconds and every other job 30", () => {
    startCryptoOffscreen();
    port.deliver({ version: 1, type: "crypto.reset", generation });
    port.deliver({
      ...open,
      operation: {
        ...open.operation,
        prepared: { kdf: { argon2id: { iterations: 10, memory: 1024, parallelism: 4 } } },
        unlock: { kind: "password", password: "synthetic-password" },
      },
    });
    const [worker] = SilentWorker.created;
    vi.advanceTimersByTime(59_999);
    expect(worker?.terminated).toBe(0);
    vi.advanceTimersByTime(1);
    expect(worker?.terminated).toBe(1);
    expect(port.sent.at(-1)).toMatchObject({ result: { ok: false, error: { code: "timeout" } } });
  });

  it("admits a live and a sync session for any number of connections, refuses a third for one, and still derives a sign-in's hash", () => {
    startCryptoOffscreen();
    port.deliver({ version: 1, type: "crypto.reset", generation });
    const openSession = (index: number, owner: string) => {
      const request = `40000000-0000-4000-8000-${String(index).padStart(12, "0")}`;
      port.deliver({ ...open, requestId: request, connectionId: owner });
      const worker = SilentWorker.created[index];
      if (!worker) return port.sent.at(-1);
      const session = {
        brokerGeneration: generation,
        connectionId: owner,
        userId: "40000000-0000-4000-8000-0000000000aa",
        sessionId: `40000000-0000-4000-8000-1${String(index).padStart(11, "0")}`,
        snapshotId: open.operation.snapshotId,
      };
      const result = { ok: true, data: { session } };
      worker.onmessage?.({
        data: {
          version: 1,
          type: "crypto.result",
          generation,
          requestId: request,
          connectionId: owner,
          result,
        },
      } as MessageEvent<unknown>);
      return port.sent.at(-1);
    };
    // Six connections, past Bitwarden's 5 accounts, each with a live session and a sync candidate.
    for (let index = 0; index < 12; index += 1)
      expect(
        openSession(index, `synthetic-connection-${index % 6}`),
        `open ${index + 1}`,
      ).toMatchObject({
        result: { ok: true },
      });
    expect(openSession(12, "synthetic-connection-0")).toMatchObject({
      result: { ok: false, error: { code: "resource-limit" } },
    });
    expect(SilentWorker.created).toHaveLength(12);
    // A password derivation opens no session, so the session cap leaves it alone.
    const derive = "40000000-0000-4000-8000-0000000000d1";
    port.deliver({
      version: 1,
      type: "crypto.command",
      generation,
      requestId: derive,
      connectionId: "synthetic-connection-0",
      operation: { kind: "derive-auth", input: {} },
    });
    expect(SilentWorker.created).toHaveLength(13);
    expect(port.sent.at(-1)).toMatchObject({ type: "crypto.dispatched", requestId: derive });
  });
});
