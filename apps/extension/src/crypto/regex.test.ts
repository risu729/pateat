import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createRegexRunner } from "./regex";

type Request = { id: number; url: string; patterns: string[] };
/** What a fake Worker does with one pattern: answer after a delay, or keep running. */
type Answer = { matched: boolean; delayMs?: number } | "runs-forever";

/** Stands in for the nested Regex Worker; tests drive it from outside. */
class FakeWorker {
  onmessage: ((event: MessageEvent<unknown>) => void) | null = null;
  onerror: ((event: ErrorEvent) => void) | null = null;
  readonly requests: Request[] = [];
  terminated = false;
  readonly terminate = vi.fn(() => {
    this.terminated = true;
  });

  private readonly answer: ((pattern: string, url: string) => Answer) | undefined;

  constructor(answer?: (pattern: string, url: string) => Answer) {
    this.answer = answer;
  }

  postMessage(message: Request) {
    this.requests.push(structuredClone(message));
    if (!this.answer) return;
    // Like the real Worker, answer each pattern in order and stop at one that never ends.
    let delayMs = 0;
    for (const [index, pattern] of message.patterns.entries()) {
      const answer = this.answer(pattern, message.url);
      if (answer === "runs-forever") return;
      delayMs += answer.delayMs ?? 0;
      const data = { id: message.id, index, matched: answer.matched };
      if (delayMs === 0) void Promise.resolve().then(() => this.emit(data));
      else setTimeout(() => this.emit(data), delayMs);
    }
  }

  /** Delivers a message unless the Worker was terminated, as a real Worker would. */
  emit(data: unknown) {
    if (!this.terminated) this.onmessage?.({ data } as MessageEvent<unknown>);
  }

  fail() {
    const event = { preventDefault: vi.fn() };
    if (!this.terminated) this.onerror?.(event as unknown as ErrorEvent);
    return event;
  }
}

/** A Worker factory that records every Worker it starts. */
function workers(
  // `null` leaves every answer to the test.
  answer: ((pattern: string, url: string) => Answer) | null = regexAnswer,
  ready: "immediately" | "manually" = "immediately",
) {
  const started: FakeWorker[] = [];
  const start = vi.fn(() => {
    const worker = new FakeWorker(answer ?? undefined);
    started.push(worker);
    if (ready === "immediately") void Promise.resolve().then(() => worker.emit("ready"));
    return worker as unknown as Worker;
  });
  return { start, started };
}
const regexAnswer = (pattern: string, url: string): Answer => ({
  matched: new RegExp(pattern, "i").test(url),
});

const url = "https://example.com/login";
const otherUrl = "https://example.org/login";

/** Lets real async work (the SHA-256 digest) and queued answers finish without moving time. */
async function settle() {
  for (let turn = 0; turn < 20; turn += 1)
    // eslint-disable-next-line no-await-in-loop
    await new Promise<void>((resolve) => setImmediate(resolve));
}
/** Runs until `predicate` holds without advancing fake time. */
async function until(predicate: () => boolean) {
  // Real time, as `performance` is not faked: the digest runs off the main thread.
  const deadline = performance.now() + 5_000;
  while (!predicate() && performance.now() < deadline)
    // eslint-disable-next-line no-await-in-loop
    await new Promise<void>((resolve) => setImmediate(resolve));
  expect(predicate()).toBe(true);
}
/** Observes whether a run has finished, without awaiting it. */
function track<T>(promise: Promise<T>) {
  const state: { done: boolean; value?: T } = { done: false };
  void (async () => {
    state.value = await promise;
    state.done = true;
  })();
  return state;
}

beforeEach(() => {
  // Only the runner's timers are fake; the digest and the polling above use real turns.
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
});
afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
});

describe("createRegexRunner (ADR 0056)", () => {
  it("returns each pattern's result as the pinned clients' case-insensitive RegExp decides", async () => {
    const { start, started } = workers();
    const runner = createRegexRunner(start);
    const results = await runner.run(["^https://EXAMPLE\\.com/", "example\\.org", "login$"], url);
    expect(results).toEqual(
      new Map([
        ["^https://EXAMPLE\\.com/", true],
        ["example\\.org", false],
        ["login$", true],
      ]),
    );
    expect(started).toHaveLength(1);
    expect(started[0]!.requests).toEqual([
      {
        id: expect.any(Number),
        url,
        patterns: ["^https://EXAMPLE\\.com/", "example\\.org", "login$"],
      },
    ]);
    expect(started[0]!.terminate).not.toHaveBeenCalled();
    // Neither the start bound nor the budget is left running after a complete answer.
    expect(vi.getTimerCount()).toBe(0);
  });

  it("sends each pattern once and keeps using the same Worker", async () => {
    const { start, started } = workers();
    const runner = createRegexRunner(start);
    expect(await runner.run(["a", "b", "a", "b", "c"], url)).toEqual(
      new Map([
        ["a", true],
        ["b", false],
        ["c", true],
      ]),
    );
    expect(started[0]!.requests[0]!.patterns).toEqual(["a", "b", "c"]);
    expect(await runner.run(["x"], otherUrl)).toEqual(new Map([["x", true]]));
    expect(start).toHaveBeenCalledOnce();
    const [first, second] = started[0]!.requests;
    expect(second!.id).not.toBe(first!.id);
  });

  it("starts no Worker when there is nothing to run", async () => {
    const { start } = workers();
    expect(await createRegexRunner(start).run([], url)).toEqual(new Map());
    expect(start).not.toHaveBeenCalled();
  });

  it("does not count the Worker's startup against the budget", async () => {
    const { start, started } = workers(
      (pattern) => ({ matched: pattern === "a", delayMs: 900 }),
      "manually",
    );
    const runner = createRegexRunner(start, 1_000);
    const run = track(runner.run(["a", "b"], url));
    await until(() => started.length === 1);
    // Startup takes almost all of its own 5 s bound, far longer than the 1 s budget.
    await vi.advanceTimersByTimeAsync(4_900);
    expect(run.done).toBe(false);
    expect(started[0]!.requests).toEqual([]);
    started[0]!.emit("ready");
    await until(() => started[0]!.requests.length === 1);
    // Each answer takes 0.9 s: the first is within the budget, the second is not.
    await vi.advanceTimersByTimeAsync(900);
    await settle();
    expect(run.done).toBe(false);
    await vi.advanceTimersByTimeAsync(100);
    await settle();
    expect(run).toEqual({ done: true, value: new Map([["a", true]]) });
    expect(started[0]!.terminate).toHaveBeenCalledOnce();
  });

  it("gives up on a Worker that never says it is ready after 5 s", async () => {
    const { start, started } = workers(regexAnswer, "manually");
    const runner = createRegexRunner(start);
    const run = track(runner.run(["a"], url));
    await until(() => started.length === 1);
    await vi.advanceTimersByTimeAsync(4_999);
    expect(run.done).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await settle();
    expect(run).toEqual({ done: true, value: new Map() });
    expect(started[0]!.terminate).toHaveBeenCalledOnce();
    expect(started[0]!.requests).toEqual([]);
    // A late "ready" from the abandoned Worker changes nothing.
    started[0]!.terminated = false;
    started[0]!.emit("ready");
    // The next run starts a new Worker.
    const next = track(runner.run(["a"], url));
    await until(() => started.length === 2);
    started[1]!.emit("ready");
    await until(() => next.done);
    expect(next.value).toEqual(new Map([["a", true]]));
  });

  describe("a pattern that runs out of time", () => {
    const slow = "(a+)+$";
    const answer = (pattern: string, page: string): Answer =>
      pattern === slow ? "runs-forever" : regexAnswer(pattern, page);

    async function timeOut(
      runner: ReturnType<typeof createRegexRunner>,
      started: FakeWorker[],
      patterns: string[],
    ) {
      const count = started.length;
      const run = track(runner.run(patterns, url));
      await until(() => started[count]?.requests.length === 1);
      await settle();
      expect(run.done).toBe(false);
      await vi.advanceTimersByTimeAsync(4_999);
      await settle();
      expect(run.done).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      await settle();
      expect(run.done).toBe(true);
      return run.value;
    }

    it("returns the results it has after 5 s and terminates the Worker", async () => {
      const { start, started } = workers(answer);
      const runner = createRegexRunner(start);
      expect(await timeOut(runner, started, ["login", slow, "example"])).toEqual(
        new Map([["login", true]]),
      );
      expect(started[0]!.terminate).toHaveBeenCalledOnce();
      expect(vi.getTimerCount()).toBe(0);
    });

    it("is skipped later for the same URL, while patterns after it run again", async () => {
      const { start, started } = workers(answer);
      const runner = createRegexRunner(start);
      await timeOut(runner, started, ["login", slow, "example"]);
      expect(await runner.run([slow, "example", "login"], url)).toEqual(
        new Map([
          ["example", true],
          ["login", true],
        ]),
      );
      // A new Worker was started for the next run and never received the slow pattern.
      expect(start).toHaveBeenCalledTimes(2);
      expect(started[1]!.requests.map((request) => request.patterns)).toEqual([
        ["example", "login"],
      ]);
      // A run of only slow patterns needs no Worker at all.
      expect(await runner.run([slow], url)).toEqual(new Map());
      expect(start).toHaveBeenCalledTimes(2);
      expect(started[1]!.requests).toHaveLength(1);
    });

    it("still runs for another URL", async () => {
      const { start, started } = workers(answer);
      const runner = createRegexRunner(start);
      await timeOut(runner, started, [slow]);
      const run = track(runner.run(["example", slow], otherUrl));
      await until(() => started[1]?.requests.length === 1);
      expect(started[1]!.requests[0]).toMatchObject({ url: otherUrl, patterns: ["example", slow] });
      await vi.advanceTimersByTimeAsync(5_000);
      await settle();
      expect(run).toEqual({ done: true, value: new Map([["example", true]]) });
    });

    it("ignores a late answer from the terminated Worker", async () => {
      const { start, started } = workers(answer);
      const runner = createRegexRunner(start);
      await timeOut(runner, started, [slow]);
      const old = started[0]!;
      old.terminated = false;
      old.emit({ id: old.requests[0]!.id, index: 0, matched: true });
      old.fail();
      expect(await runner.run(["example"], url)).toEqual(new Map([["example", true]]));
      expect(start).toHaveBeenCalledTimes(2);
    });
  });

  describe("a Worker that misbehaves is terminated and the run returns what it has", () => {
    it.each([
      ["a non-boolean result", (id: number) => ({ id, index: 1, matched: "true" })],
      ["an answer out of order", (id: number) => ({ id, index: 2, matched: true })],
      ["a repeated answer", (id: number) => ({ id, index: 0, matched: true })],
      ["an index past the patterns", (id: number) => ({ id, index: 3, matched: true })],
      ["a negative index", (id: number) => ({ id, index: -1, matched: true })],
      ["another run's id", (id: number) => ({ id: id + 1, index: 1, matched: true })],
      ["an extra field", (id: number) => ({ id, index: 1, matched: true, pattern: "b" })],
      ["no object", () => null],
    ])("on %s", async (_label, malformed) => {
      const { start, started } = workers(null);
      const runner = createRegexRunner(start);
      const run = track(runner.run(["a", "b", "c"], url));
      await until(() => started[0]?.requests.length === 1);
      const worker = started[0]!;
      const { id } = worker.requests[0]!;
      worker.emit({ id, index: 0, matched: true });
      worker.emit(malformed(id));
      await until(() => run.done);
      expect(run.value).toEqual(new Map([["a", true]]));
      expect(worker.terminate).toHaveBeenCalledOnce();
      expect(vi.getTimerCount()).toBe(0);
      // Nothing was remembered as slow: the next run starts a new Worker with every pattern.
      const next = track(runner.run(["a", "b", "c"], url));
      await until(() => started[1]?.requests.length === 1);
      expect(started[1]!.requests[0]!.patterns).toEqual(["a", "b", "c"]);
      expect(start).toHaveBeenCalledTimes(2);
      const nextId = started[1]!.requests[0]!.id;
      for (const index of [0, 1, 2]) started[1]!.emit({ id: nextId, index, matched: false });
      await until(() => next.done);
      expect(next.value?.size).toBe(3);
    });

    it("but not on a repeated ready, which is no answer", async () => {
      const { start, started } = workers(null);
      const run = track(createRegexRunner(start).run(["a", "b"], url));
      await until(() => started[0]?.requests.length === 1);
      const worker = started[0]!;
      const { id } = worker.requests[0]!;
      worker.emit({ id, index: 0, matched: true });
      worker.emit("ready");
      worker.emit({ id, index: 1, matched: false });
      await until(() => run.done);
      expect(run.value).toEqual(
        new Map([
          ["a", true],
          ["b", false],
        ]),
      );
      expect(worker.terminate).not.toHaveBeenCalled();
    });

    it("on a Worker error during a run, and relaunches for the next run", async () => {
      const { start, started } = workers(null);
      const runner = createRegexRunner(start);
      const run = track(runner.run(["a", "b"], url));
      await until(() => started[0]?.requests.length === 1);
      const worker = started[0]!;
      worker.emit({ id: worker.requests[0]!.id, index: 0, matched: false });
      const event = worker.fail();
      await until(() => run.done);
      expect(run.value).toEqual(new Map([["a", false]]));
      expect(event.preventDefault).toHaveBeenCalledOnce();
      expect(worker.terminate).toHaveBeenCalled();
      expect(vi.getTimerCount()).toBe(0);

      const next = track(runner.run(["a", "b"], url));
      await until(() => started[1]?.requests.length === 1);
      // Both patterns run again: an error marks nothing as slow.
      expect(started[1]!.requests[0]!.patterns).toEqual(["a", "b"]);
      const { id } = started[1]!.requests[0]!;
      started[1]!.emit({ id, index: 0, matched: true });
      started[1]!.emit({ id, index: 1, matched: true });
      await until(() => next.done);
      expect(next.value).toEqual(
        new Map([
          ["a", true],
          ["b", true],
        ]),
      );
    });

    it("on a Worker error before it is ready", async () => {
      const { start, started } = workers(regexAnswer, "manually");
      const runner = createRegexRunner(start);
      const run = track(runner.run(["a"], url));
      await until(() => started.length === 1);
      const event = started[0]!.fail();
      await until(() => run.done);
      expect(run.value).toEqual(new Map());
      expect(event.preventDefault).toHaveBeenCalledOnce();
      expect(started[0]!.terminate).toHaveBeenCalled();
      expect(started[0]!.requests).toEqual([]);
      expect(vi.getTimerCount()).toBe(0);
    });

    it("when the Worker cannot be constructed, and tries again on the next run", async () => {
      const { start: working, started } = workers();
      const start = vi
        .fn<() => Worker>()
        .mockImplementationOnce(() => {
          throw new DOMException("Synthetic Worker start failure", "SecurityError");
        })
        .mockImplementation(working);
      const runner = createRegexRunner(start);
      expect(await runner.run(["a"], url)).toEqual(new Map());
      expect(await runner.run(["a"], url)).toEqual(new Map([["a", true]]));
      expect(start).toHaveBeenCalledTimes(2);
      expect(started).toHaveLength(1);
    });
  });
});

describe("the Regex Worker entry", () => {
  type Posted = string | { id: number; index: number; matched: boolean };
  const scope = {
    onmessage: null as ((event: MessageEvent<Request>) => void) | null,
    postMessage: vi.fn<(message: Posted) => void>(),
  };

  const originalConsole = console;
  beforeEach(async () => {
    vi.useRealTimers();
    vi.resetModules();
    scope.onmessage = null;
    scope.postMessage.mockReset();
    vi.stubGlobal("self", scope);
    // The entry replaces logging and fetch; keep those changes in this test's globals.
    vi.stubGlobal("console", { ...console });
    vi.stubGlobal("fetch", globalThis.fetch);
    await import("./regex-worker");
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("says it is ready, then answers each pattern in order", () => {
    expect(scope.postMessage.mock.calls).toEqual([["ready"]]);
    scope.onmessage?.({
      data: {
        id: 7,
        url: "https://Example.com/Login?next=%2F",
        patterns: ["^https://example\\.com/login", "[invalid", "example\\.org", "", "next=%2f$"],
      },
    } as MessageEvent<Request>);
    expect(scope.postMessage.mock.calls.slice(1)).toEqual([
      [{ id: 7, index: 0, matched: true }],
      // A pattern that does not compile matches nothing.
      [{ id: 7, index: 1, matched: false }],
      [{ id: 7, index: 2, matched: false }],
      [{ id: 7, index: 3, matched: true }],
      [{ id: 7, index: 4, matched: true }],
    ]);
  });

  it("neither logs nor fetches", async () => {
    for (const method of ["log", "info", "warn", "error", "debug", "trace"] as const) {
      expect(console[method]).not.toBe(originalConsole[method]);
      expect(console[method]("synthetic")).toBeUndefined();
    }
    await expect(fetch("https://example.com/")).rejects.toThrow("Network disabled");
  });

  it("drives the runner end to end with the real pattern logic", async () => {
    const start = () => {
      const outer = new FakeWorker();
      // Forward the runner's requests to the entry and its answers back, asynchronously.
      outer.postMessage = (message: Request) => {
        outer.requests.push(message);
        setTimeout(() => scope.onmessage?.({ data: message } as MessageEvent<Request>));
      };
      scope.postMessage.mockImplementation((message) => {
        setTimeout(() => outer.emit(message));
      });
      setTimeout(() => outer.emit("ready"));
      return outer as unknown as Worker;
    };
    const runner = createRegexRunner(start);
    expect(await runner.run(["^HTTPS://example\\.com/", "(", "\\.org/"], url)).toEqual(
      new Map([
        ["^HTTPS://example\\.com/", true],
        ["(", false],
        ["\\.org/", false],
      ]),
    );
  });
});
