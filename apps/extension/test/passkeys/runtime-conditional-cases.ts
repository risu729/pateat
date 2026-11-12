import { expect, it, type Mock, vi } from "vitest";
import {
  createPasskeyRuntime,
  type ConditionalDecision,
  type PasskeyItem,
} from "../../src/passkeys/runtime";
import type { RuntimeFixtures, RuntimeGet } from "./runtime-context";

type ConditionalInput = {
  tabId: number;
  origin: string;
  documentId: string;
  signal: AbortSignal;
  incognito: boolean;
};

export function registerConditionalCases({
  extensionId,
  origin,
  sender,
  candidate,
  request,
  get,
  source,
  loginItem,
  conditionalGet,
  tick,
  decisions,
  holds,
}: Pick<
  RuntimeFixtures,
  "extensionId" | "origin" | "sender" | "candidate" | "request" | "get" | "source"
> & {
  loginItem: PasskeyItem;
  conditionalGet: (operationId?: ReturnType<Crypto["randomUUID"]>) => Omit<
    RuntimeGet,
    "request"
  > & {
    request: RuntimeFixtures["request"] & { mediation: string };
  };
  tick: () => Promise<unknown>;
  decisions: () => {
    conditional: Mock<(input: ConditionalInput) => Promise<ConditionalDecision>>;
    waiting: { input: ConditionalInput; decide(decision: ConditionalDecision): void }[];
  };
  holds: () => { hold: Mock<() => Promise<() => void>>; events: string[] };
}) {
  it("hands on a parked request whose site was listed while it waited (ADR 0007)", async () => {
    const backing = source();
    const answered = vi.fn();
    const { conditional, waiting } = decisions();
    let listed = false;
    const browserSite = vi.fn(async () => listed);
    const runtime = createPasskeyRuntime(backing, { extensionId, conditional, browserSite });
    const pending = runtime.handle(conditionalGet(), sender());
    await vi.waitFor(() => expect(waiting).toHaveLength(1));
    // "Always for this site" in another tab, while the request is parked for its login.
    listed = true;
    waiting[0]!.decide({ kind: "answer", item: loginItem, answered });
    expect(await pending).toEqual({ kind: "delegate", reason: "browser-site" });
    expect(backing.sign).not.toHaveBeenCalled();
    expect(answered.mock.calls).toEqual([[false]]);
  });

  it("hands on a request whose site was listed during its lookup (ADR 0007)", async () => {
    let listed = false;
    const { promise: looked, resolve: look } = Promise.withResolvers<void>();
    const backing = source({
      candidates: vi.fn(async () => {
        await looked;
        return { candidates: [candidate], complete: true };
      }),
    });
    const runtime = createPasskeyRuntime(backing, {
      extensionId,
      browserSite: async () => listed,
    });
    const pending = runtime.handle(get(), sender());
    await vi.waitFor(() => expect(backing.candidates).toHaveBeenCalled());
    listed = true;
    look();
    expect(await pending).toEqual({ kind: "delegate", reason: "browser-site" });
    expect(backing.sign).not.toHaveBeenCalled();
  });

  it("waits for the login's decision and hands the request on with its reason", async () => {
    const report = vi.fn();
    const requested = vi.fn();
    const backing = source();
    const { conditional, waiting } = decisions();
    const { hold, events } = holds();
    const runtime = createPasskeyRuntime(backing, {
      extensionId,
      report,
      requested,
      conditional,
      hold,
    });
    const pending = runtime.handle(conditionalGet(), sender());
    await vi.waitFor(() => expect(waiting).toHaveLength(1));
    expect(waiting[0]!.input).toEqual({
      tabId: 7,
      origin,
      documentId: "document-a",
      signal: expect.any(AbortSignal),
      // The sender's window kind, which keeps its own pauses (ADR 0062).
      incognito: false,
    });
    // Nothing is read from the vault, and the vault is not held, while it waits.
    expect(backing.candidates).not.toHaveBeenCalled();
    expect(hold).not.toHaveBeenCalled();
    waiting[0]!.decide({ kind: "delegate", reason: "no-login" });
    expect(await pending).toEqual({ kind: "delegate", reason: "no-login" });
    expect(events).toEqual([]);
    expect(requested).not.toHaveBeenCalled();
    await vi.waitFor(() =>
      expect(report).toHaveBeenLastCalledWith({
        tabId: 7,
        origin,
        outcome: "delegate",
        reason: "no-login",
        rpId: "example.com",
        allowCredentials: 0,
        mediation: "conditional",
      }),
    );
  });

  it("hands a paused site's own request on at once, while a modal one is still answered (ADR 0062)", async () => {
    const report = vi.fn();
    const backing = source();
    // The login runtime decides at once that the page's site is paused.
    const conditional = vi.fn(async (): Promise<ConditionalDecision> => ({
      kind: "delegate",
      reason: "paused",
    }));
    const runtime = createPasskeyRuntime(backing, { extensionId, report, conditional });
    expect(await runtime.handle(conditionalGet(), sender())).toEqual({
      kind: "delegate",
      reason: "paused",
    });
    expect(backing.candidates).not.toHaveBeenCalled();
    await vi.waitFor(() =>
      expect(report).toHaveBeenLastCalledWith(
        expect.objectContaining({
          outcome: "delegate",
          reason: "paused",
          mediation: "conditional",
        }),
      ),
    );
    // A request the person started on the page never asks the login runtime; without a
    // pause hook it is answered as before.
    expect(await runtime.handle(get(), sender())).toMatchObject({ kind: "assertion" });
    expect(conditional).toHaveBeenCalledTimes(1);
  });

  it("withholds the request after the login signed in", async () => {
    const report = vi.fn();
    const { conditional, waiting } = decisions();
    const runtime = createPasskeyRuntime(source(), { extensionId, report, conditional });
    const pending = runtime.handle(conditionalGet(), sender());
    await vi.waitFor(() => expect(waiting).toHaveLength(1));
    waiting[0]!.decide({ kind: "withhold" });
    expect(await pending).toEqual({ kind: "withheld" });
    expect(report).toHaveBeenLastCalledWith(
      expect.objectContaining({ outcome: "withheld", mediation: "conditional" }),
    );
    expect(report.mock.lastCall![0]).not.toHaveProperty("reason");
  });

  it("answers with the login's item, holding the vault only while it signs", async () => {
    const report = vi.fn();
    const answeredTab = vi.fn();
    const other = { ...candidate, credentialId: "BBBB", preferred: true };
    const backing = source({
      candidates: vi.fn(async (_origin: string, _rpId: string, _signal, only?: PasskeyItem) => ({
        candidates: only ? [{ ...candidate, credentialId: "CCCC" }] : [other],
        complete: true,
      })),
    });
    const { conditional, waiting } = decisions();
    const { hold, events } = holds();
    const runtime = createPasskeyRuntime(backing, {
      extensionId,
      report,
      conditional,
      hold,
      answered: answeredTab,
      // The budget runs only once the login answers.
      timeoutMs: () => 50,
    });
    const pending = runtime.handle(conditionalGet(), sender());
    await vi.waitFor(() => expect(waiting).toHaveLength(1));
    await new Promise((resolve) => setTimeout(resolve, 80));
    expect(hold).not.toHaveBeenCalled();
    const signed = vi.fn(() => void events.push("answered"));
    waiting[0]!.decide({ kind: "answer", item: loginItem, answered: signed });
    expect(await pending).toMatchObject({
      kind: "assertion",
      assertion: { credentialId: "CCCC" },
    });
    expect(signed.mock.calls).toEqual([[true]]);
    expect(backing.candidates).toHaveBeenCalledWith(
      origin,
      "example.com",
      expect.any(AbortSignal),
      loginItem,
    );
    expect(events).toEqual(["hold", "answered", "leave"]);
    // The login's item signed it.
    // A login's answer is not a sign-in Pateat made by itself.
    expect(answeredTab).toHaveBeenCalledWith(
      7,
      origin,
      "example.com",
      expect.objectContaining({ credentialId: "CCCC" }),
      { incognito: false, documentId: "document-a" },
    );
    expect(report).toHaveBeenLastCalledWith(
      expect.objectContaining({ outcome: "assertion", mediation: "conditional" }),
    );
  });

  it("waits for the login again when its item cannot answer, and never answers twice", async () => {
    const report = vi.fn();
    const backing = source({
      candidates: vi.fn(async () => ({ candidates: [], complete: true })),
    });
    const { conditional, waiting } = decisions();
    const { hold, events } = holds();
    const runtime = createPasskeyRuntime(backing, { extensionId, report, conditional, hold });
    const pending = runtime.handle(conditionalGet(), sender());
    await vi.waitFor(() => expect(waiting).toHaveLength(1));
    const signed = vi.fn(() => void events.push("answered"));
    waiting[0]!.decide({ kind: "answer", item: loginItem, answered: signed });
    // The login falls back to its password and decides the waiting request again.
    await vi.waitFor(() => expect(waiting).toHaveLength(2));
    expect(signed.mock.calls).toEqual([[false]]);
    expect(events).toEqual(["hold", "answered", "leave"]);
    expect(waiting[1]!.input.signal).toBe(waiting[0]!.input.signal);
    expect(waiting[1]!.input.signal.aborted).toBe(false);
    waiting[1]!.decide({ kind: "withhold" });
    expect(await pending).toEqual({ kind: "withheld" });
    expect(events).toEqual(["hold", "answered", "leave"]);
    expect(backing.sign).not.toHaveBeenCalled();
    expect(report).toHaveBeenLastCalledWith(
      expect.objectContaining({
        outcome: "withheld",
        answerFailed: "login-item-no-credential",
        mediation: "conditional",
      }),
    );
  });

  it("tells the login of a failed signing, and of a timeout once it answers", async () => {
    const failing = source({ sign: vi.fn(async () => Promise.reject(new Error("unavailable"))) });
    const { conditional, waiting } = decisions();
    const report = vi.fn();
    const runtime = createPasskeyRuntime(failing, { extensionId, conditional, report });
    const pending = runtime.handle(conditionalGet(), sender());
    await vi.waitFor(() => expect(waiting).toHaveLength(1));
    const signed = vi.fn();
    waiting[0]!.decide({ kind: "answer", item: loginItem, answered: signed });
    await vi.waitFor(() => expect(waiting).toHaveLength(2));
    expect(signed.mock.calls).toEqual([[false]]);
    waiting[1]!.decide({ kind: "delegate", reason: "login-ended" });
    expect(await pending).toEqual({ kind: "delegate", reason: "login-ended" });
    await vi.waitFor(() =>
      expect(report).toHaveBeenLastCalledWith(
        expect.objectContaining({ answerFailed: "assertion-failed", cause: "signing" }),
      ),
    );

    const slow = source({
      sign: vi.fn(
        (_candidate, _data, _hash, signal: AbortSignal) =>
          new Promise<Uint8Array>((_resolve, reject) => {
            signal.addEventListener("abort", () => reject(signal.reason), { once: true });
          }),
      ),
    });
    const timed = decisions();
    const { hold, events } = holds();
    const bounded = createPasskeyRuntime(slow, {
      extensionId,
      conditional: timed.conditional,
      hold,
      timeoutMs: () => 20,
    });
    const answering = bounded.handle(conditionalGet(), sender());
    await vi.waitFor(() => expect(timed.waiting).toHaveLength(1));
    const late = vi.fn();
    timed.waiting[0]!.decide({ kind: "answer", item: loginItem, answered: late });
    expect(await answering).toEqual({ kind: "delegate", reason: "timeout" });
    expect(late.mock.calls).toEqual([[false]]);
    expect(timed.waiting).toHaveLength(1);
    expect(events).toEqual(["hold", "leave"]);
  });

  it("is not cancelled by a settings change while it waits", async () => {
    const { conditional, waiting } = decisions();
    const runtime = createPasskeyRuntime(source(), { extensionId, conditional });
    const pending = runtime.handle(conditionalGet(), sender());
    await vi.waitFor(() => expect(waiting).toHaveLength(1));
    runtime.settingsChanged();
    await tick();
    expect(waiting[0]!.input.signal.aborted).toBe(false);
    const signed = vi.fn();
    waiting[0]!.decide({ kind: "answer", item: loginItem, answered: signed });
    expect(await pending).toMatchObject({ kind: "assertion" });
    expect(signed.mock.calls).toEqual([[true]]);
  });

  it("ends when the page cancels it while it waits, without holding the vault", async () => {
    const report = vi.fn();
    const { conditional, waiting } = decisions();
    const { hold } = holds();
    const runtime = createPasskeyRuntime(source(), { extensionId, report, conditional, hold });
    const operationId = crypto.randomUUID();
    const pending = runtime.handle(conditionalGet(operationId), sender());
    await vi.waitFor(() => expect(waiting).toHaveLength(1));
    expect(
      await runtime.handle({ version: 1, type: "passkey.cancel", operationId }, sender()),
    ).toEqual({ ok: true });
    expect(await pending).toEqual({ kind: "cancelled" });
    expect(waiting[0]!.input.signal.aborted).toBe(true);
    // A decision after the cancellation changes nothing.
    const signed = vi.fn();
    waiting[0]!.decide({ kind: "answer", item: loginItem, answered: signed });
    await tick();
    expect(signed).not.toHaveBeenCalled();
    expect(hold).not.toHaveBeenCalled();
    expect(report).toHaveBeenLastCalledWith(
      expect.objectContaining({
        outcome: "cancelled",
        cause: "page-cancelled",
        mediation: "conditional",
      }),
    );
  });

  it("ends when the login decision cancels the page immediately", async () => {
    const backing = source();
    const { hold } = holds();
    const operationId = crypto.randomUUID();
    let cancelled: Promise<unknown> | undefined;
    const runtime = createPasskeyRuntime(backing, {
      extensionId,
      hold,
      conditional: (): Promise<ConditionalDecision> => {
        cancelled = runtime.handle({ version: 1, type: "passkey.cancel", operationId }, sender());
        return new Promise(() => {});
      },
    });
    await expect(runtime.handle(conditionalGet(operationId), sender())).resolves.toEqual({
      kind: "cancelled",
    });
    await expect(cancelled).resolves.toEqual({ ok: true });
    expect(hold).not.toHaveBeenCalled();
    expect(backing.candidates).not.toHaveBeenCalled();
    expect(backing.sign).not.toHaveBeenCalled();
  });

  it.each<[string, () => Promise<ConditionalDecision>]>([
    [
      "throws synchronously",
      () => {
        throw new Error("storage unavailable");
      },
    ],
    ["rejects", async () => Promise.reject(new Error("storage unavailable"))],
  ])("delegates when the login's decision %s, naming the wait", async (_name, conditional) => {
    const report = vi.fn();
    const runtime = createPasskeyRuntime(source(), {
      extensionId,
      report,
      conditional,
    });
    expect(await runtime.handle(conditionalGet(), sender())).toEqual({
      kind: "delegate",
      reason: "assertion-failed",
    });
    await vi.waitFor(() =>
      expect(report).toHaveBeenLastCalledWith(
        expect.objectContaining({ reason: "assertion-failed", cause: "login-wait" }),
      ),
    );
  });

  it("holds the vault while it answers any other request, and leaves a late hold", async () => {
    const { hold, events } = holds();
    const backing = source({
      candidates: vi.fn(async () => {
        events.push("lookup");
        return { candidates: [candidate], complete: true };
      }),
    });
    const runtime = createPasskeyRuntime(backing, { extensionId, hold });
    expect(await runtime.handle(get(), sender())).toMatchObject({ kind: "assertion" });
    expect(events).toEqual(["hold", "lookup", "leave"]);

    // A hold that comes only after the page cancelled is left at once.
    let enter!: (leave: () => void) => void;
    const leave = vi.fn();
    const slowHold = vi.fn(() => new Promise<() => void>((resolve) => (enter = resolve)));
    const waiting = createPasskeyRuntime(source(), { extensionId, hold: slowHold });
    const operationId = crypto.randomUUID();
    const pending = waiting.handle(get(operationId), sender());
    await vi.waitFor(() => expect(slowHold).toHaveBeenCalledOnce());
    await waiting.handle({ version: 1, type: "passkey.cancel", operationId }, sender());
    expect(await pending).toEqual({ kind: "cancelled" });
    enter(leave);
    await vi.waitFor(() => expect(leave).toHaveBeenCalledOnce());
  });

  it.each<[string, unknown, string | undefined]>([
    ["optional", "optional", "optional"],
    ["required", "required", "required"],
    ["no", undefined, undefined],
    ["an unknown", "made-up", "other"],
  ])("reports %s mediation on an answered request", async (_label, mediation, reported) => {
    const report = vi.fn();
    const runtime = createPasskeyRuntime(source(), {
      extensionId,
      report,
      conditional: decisions().conditional,
    });
    const asked = {
      ...get(),
      request: mediation === undefined ? request : { ...request, mediation },
    };
    const result = await runtime.handle(asked, sender());
    await vi.waitFor(() => expect(report).toHaveBeenCalledOnce());
    if (reported === "other") {
      expect(result).toEqual({ kind: "delegate", reason: "unsupported-mediation" });
      expect(report.mock.lastCall![0]).toMatchObject({ mediation: "other" });
    } else {
      expect(result).toMatchObject({ kind: "assertion" });
      if (reported) expect(report.mock.lastCall![0]).toMatchObject({ mediation: reported });
      else expect(report.mock.lastCall![0]).not.toHaveProperty("mediation");
    }
  });
}
