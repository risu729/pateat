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

  it("admits up to eight open sessions and refuses a ninth", () => {
    startCryptoOffscreen();
    port.deliver({ version: 1, type: "crypto.reset", generation });
    // Four connections each with a live session and a sync candidate.
    const openSession = (index: number) => {
      const owner = `synthetic-connection-${index % 4}`;
      const request = `40000000-0000-4000-8000-00000000000${index}`;
      port.deliver({ ...open, requestId: request, connectionId: owner });
      const worker = SilentWorker.created[index];
      if (!worker) return port.sent.at(-1);
      const session = {
        brokerGeneration: generation,
        connectionId: owner,
        userId: "40000000-0000-4000-8000-0000000000aa",
        sessionId: `40000000-0000-4000-8000-0000000001${index}0`,
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
    for (let index = 0; index < 8; index += 1)
      expect(openSession(index), `open ${index + 1}`).toMatchObject({ result: { ok: true } });
    expect(openSession(8)).toMatchObject({
      result: { ok: false, error: { code: "resource-limit" } },
    });
    expect(SilentWorker.created).toHaveLength(8);
  });
});
