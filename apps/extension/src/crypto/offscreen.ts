import * as v from "valibot";
import { browser } from "wxt/browser";
import {
  boundedMessage,
  commandSchema,
  controlSchema,
  CRYPTO_PORT,
  replySchema,
  type HostCommand,
  type HostSessionRef,
} from "./wire";

/** One bundled offscreen document supervises local Workers; it does not persist credentials. */
export function startCryptoOffscreen() {
  const port = browser.runtime.connect({ name: CRYPTO_PORT });
  let connected = true;
  let generation: string | undefined;
  const sessions = new Map<string, { worker: Worker; ref: HostSessionRef; openedBy: string }>();
  const jobs = new Map<
    string,
    {
      worker: Worker;
      command: Pick<HostCommand, "generation" | "requestId" | "connectionId"> & {
        operation: { kind: HostCommand["operation"]["kind"] };
      };
      deadline: number;
      timer: ReturnType<typeof setTimeout>;
      ephemeral: boolean;
    }
  >();
  function send(message: unknown) {
    if (!connected) return;
    try {
      port.postMessage(message);
    } catch {
      connected = false;
      reset();
      generation = undefined;
    }
  }
  const post = (
    command: Pick<HostCommand, "generation" | "requestId" | "connectionId">,
    result: unknown,
  ) =>
    send({
      version: 1,
      type: "crypto.result",
      generation: command.generation,
      requestId: command.requestId,
      connectionId: command.connectionId,
      result,
    });
  const failure = (code: string) => ({ ok: false, error: { code } });
  function terminate(worker: Worker, code = "crypto-locked") {
    worker.terminate();
    for (const [id, session] of sessions) if (session.worker === worker) sessions.delete(id);
    for (const [id, job] of jobs)
      if (job.worker === worker) {
        clearTimeout(job.timer);
        jobs.delete(id);
        post(job.command, failure(code));
      }
  }
  function reset() {
    const workers = new Set([...sessions.values(), ...jobs.values()].map((entry) => entry.worker));
    for (const worker of workers) terminate(worker);
    sessions.clear();
    jobs.clear();
  }
  function start(command: HostCommand) {
    const op = command.operation;
    if (op.kind === "close") {
      for (const session of [...sessions.values()])
        if (session.ref.connectionId === command.connectionId) terminate(session.worker);
      for (const job of [...jobs.values()])
        if (job.command.connectionId === command.connectionId) terminate(job.worker);
      post(command, { ok: true, data: null });
      return;
    }
    let worker: Worker;
    const ephemeral = op.kind === "derive-auth" || op.kind === "open";
    if (ephemeral) {
      if (sessions.size >= 4 || jobs.size >= 8 || [...jobs.values()].some((job) => job.ephemeral)) {
        post(command, failure("resource-limit"));
        return;
      }
      worker = new Worker(new URL("./worker.ts", import.meta.url), { type: "module" });
      worker.onmessage = (event: MessageEvent<unknown>) => {
        if (!boundedMessage(event.data)) {
          terminate(worker);
          return;
        }
        const parsed = v.safeParse(replySchema, event.data);
        if (!parsed.success || parsed.output.generation !== generation) return;
        const job = jobs.get(parsed.output.requestId);
        if (
          !job ||
          job.worker !== worker ||
          job.command.connectionId !== parsed.output.connectionId
        )
          return;
        if (Date.now() >= job.deadline) {
          terminate(worker, "timeout");
          return;
        }
        clearTimeout(job.timer);
        jobs.delete(parsed.output.requestId);
        const result = parsed.output.result as {
          ok?: boolean;
          data?: { session?: HostSessionRef };
        };
        if (job.command.operation.kind === "open" && result?.ok === true && result.data?.session)
          sessions.set(result.data.session.sessionId, {
            worker,
            ref: result.data.session,
            openedBy: job.command.requestId,
          });
        else if (job.ephemeral) worker.terminate();
        send(parsed.output);
      };
      worker.onerror = (event) => {
        event.preventDefault();
        terminate(worker, "crypto-failed");
      };
    } else {
      const session = sessions.get(op.session.sessionId);
      // The background may already have sent an immediate exact-ref cancellation.
      if (!session && op.kind === "lock") {
        post(command, { ok: true, data: null });
        return;
      }
      if (
        !session ||
        Object.entries(session.ref).some(
          ([key, value]) => op.session[key as keyof HostSessionRef] !== value,
        ) ||
        session.ref.connectionId !== command.connectionId
      ) {
        post(command, failure("crypto-locked"));
        return;
      }
      worker = session.worker;
      if (op.kind === "lock") {
        terminate(worker);
        post(command, { ok: true, data: null });
        return;
      }
      if (jobs.size >= 8 || [...jobs.values()].some((job) => job.worker === worker)) {
        post(command, failure("resource-limit"));
        return;
      }
    }
    const requestId = command.requestId;
    const timer = setTimeout(() => {
      const job = jobs.get(requestId);
      if (job?.worker === worker) terminate(worker, "timeout");
    }, 30_000);
    jobs.set(command.requestId, {
      worker,
      command: {
        generation: command.generation,
        requestId,
        connectionId: command.connectionId,
        operation: { kind: command.operation.kind },
      },
      timer,
      ephemeral,
      deadline: Date.now() + 30_000,
    });
    worker.postMessage(command);
    send({
      version: 1,
      type: "crypto.dispatched",
      generation,
      requestId: command.requestId,
      connectionId: command.connectionId,
    });
  }
  port.onMessage.addListener((message: unknown) => {
    if (!connected || !boundedMessage(message)) return;
    const control = v.safeParse(controlSchema, message);
    if (control.success) {
      if (control.output.type === "crypto.reset") {
        // Duplicate handshake resets must not invalidate work after readiness.
        if (generation !== control.output.generation) {
          reset();
          generation = control.output.generation;
        }
        send({ version: 1, type: "crypto.ready", generation });
      } else if (control.output.generation === generation) {
        const requestId = control.output.requestId;
        const ref = control.output.session;
        const job = jobs.get(requestId);
        if (job) terminate(job.worker);
        else {
          const session = ref
            ? sessions.get(ref.sessionId)
            : [...sessions.values()].find((candidate) => candidate.openedBy === requestId);
          if (
            session &&
            (!ref ||
              Object.entries(session.ref).every(
                ([key, value]) => ref[key as keyof HostSessionRef] === value,
              ))
          )
            terminate(session.worker);
        }
      }
      return;
    }
    const command = v.safeParse(commandSchema, message);
    if (
      command.success &&
      command.output.generation === generation &&
      !jobs.has(command.output.requestId)
    )
      try {
        start(command.output);
      } catch {
        post(command.output, failure("crypto-failed"));
      }
  });
  port.onDisconnect.addListener(() => {
    connected = false;
    reset();
    generation = undefined;
  });
  window.addEventListener("pagehide", reset, { once: true });
  send({ version: 1, type: "crypto.hello" });
}
