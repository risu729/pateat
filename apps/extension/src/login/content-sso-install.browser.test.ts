import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { recordFillEdits } from "../page/fill-edits";
import { observedPath } from "../observation/path";
import { installLoginContent } from "./content";

type Listener = (
  message: unknown,
  sender: { id?: string; tab?: unknown },
  respond: (value: unknown) => void,
) => boolean | void;
const wire = vi.hoisted(() => ({
  listener: undefined as Listener | undefined,
  sent: [] as { channel: string; message: Record<string, unknown> }[],
  authorize: vi.fn<() => Promise<{ ok: boolean }>>(),
  raw: vi.fn(),
  nativeAuthorize: vi.fn<() => Promise<boolean>>(),
}));
vi.mock("wxt/browser", () => ({
  browser: {
    runtime: {
      id: "synthetic-extension",
      sendMessage: wire.raw,
      onMessage: {
        addListener: (listener: Listener) => {
          wire.listener = listener;
        },
        removeListener: (listener: Listener) => {
          if (wire.listener === listener) wire.listener = undefined;
        },
      },
    },
  },
}));
vi.mock("../messaging/protocol", () => ({
  sendMessage: async (channel: string, message: Record<string, unknown>) => {
    wire.sent.push({ channel, message });
    if (message["type"] === "login.sso.authorize") return wire.authorize();
    if (message["type"] === "login.operation.authorize") return wire.nativeAuthorize();
    return { ok: false, reason: "recipe-not-found", starts: [] };
  },
}));
let uninstall: (() => void) | undefined;
let stopRecording: (() => void) | undefined;
beforeEach(() => {
  wire.sent.length = 0;
  wire.nativeAuthorize.mockReset().mockResolvedValue(true);
  wire.authorize.mockReset().mockResolvedValue({ ok: true });
  wire.raw
    .mockReset()
    .mockRejectedValue(new Error("SSO must use the registered login messaging channel"));
  document.body.innerHTML =
    '<main><button id="entry" type="button">Continue with Synthetic</button></main>';
});
afterEach(() => {
  uninstall?.();
  stopRecording?.();
  stopRecording = undefined;
  delete (window as unknown as Record<symbol, unknown>)[Symbol.for("pateat.fillEdits")];
  uninstall = undefined;
  document.body.innerHTML = "";
});
async function command(message: Record<string, unknown>): Promise<unknown> {
  if (!wire.listener) throw new Error("No installed content listener");
  const listener = wire.listener;
  return new Promise((resolve, reject) => {
    let answered = false;
    const accepted = listener(message, { id: "synthetic-extension" }, (value) => {
      answered = true;
      resolve(value);
    });
    if (accepted !== true && !answered) reject(new Error("Command was not accepted"));
  });
}
async function installAndPrepare() {
  uninstall = installLoginContent();
  await vi.waitFor(() =>
    expect(wire.sent.some(({ message }) => typeof message["token"] === "string")).toBe(true),
  );
  const token = wire.sent.find(({ message }) => typeof message["token"] === "string")!.message[
    "token"
  ];
  const operation = { version: 1, token, flowId: "flow", operationId: "operation" };
  const prepared = (await command({
    ...operation,
    type: "login.sso.prepare",
    target: { by: "id", value: "entry" },
  })) as { ok: boolean; handle: string };
  expect(prepared).toMatchObject({ ok: true, handle: expect.any(String) });
  return { ...operation, type: "login.sso.commit", handle: prepared.handle };
}
describe("installed SSO content uses the registered background channel", () => {
  it("sends authorization through the login protocol before mutating the prepared target", async () => {
    const clicked = vi.fn();
    document.getElementById("entry")!.addEventListener("click", clicked);
    const commit = await installAndPrepare();
    const gate = Promise.withResolvers<{ ok: boolean }>();
    wire.authorize.mockReturnValueOnce(gate.promise);
    const committing = command(commit);
    await vi.waitFor(() => expect(wire.authorize).toHaveBeenCalledTimes(1));
    expect(clicked).not.toHaveBeenCalled();
    expect(wire.sent).toContainEqual({
      channel: "login",
      message: {
        version: 1,
        type: "login.sso.authorize",
        phase: "pointer",
        token: commit.token,
        flowId: "flow",
        operationId: "operation",
        handle: commit.handle,
      },
    });
    expect(wire.raw).not.toHaveBeenCalled();
    gate.resolve({ ok: true });
    expect(await committing).toEqual({ ok: true });
    expect(clicked).toHaveBeenCalledTimes(1);
    expect(await command(commit)).toEqual({ ok: false, reason: "operation-gone" });
    expect(wire.authorize).toHaveBeenCalledTimes(2);
  });
  it("refuses without a click when the registered background channel denies authorization", async () => {
    const clicked = vi.fn();
    document.getElementById("entry")!.addEventListener("click", clicked);
    const commit = await installAndPrepare();
    wire.authorize.mockResolvedValueOnce({ ok: false });
    expect(await command(commit)).toEqual({ ok: false, reason: "not-authorized" });
    expect(clicked).not.toHaveBeenCalled();
    expect(wire.raw).not.toHaveBeenCalled();
    expect(await command(commit)).toEqual({ ok: false, reason: "operation-gone" });
    expect(wire.authorize).toHaveBeenCalledTimes(1);
  });
});

function nativeFill(token: unknown, attemptId: string, operationId: string) {
  return {
    version: 1,
    type: "login.execute",
    token,
    operation: {
      version: 1,
      attemptId,
      operationId,
      policyRevision: 1,
      expiresAt: Date.now() + 60_000,
      document: { origin: self.origin, tabId: 1, frameId: 0, documentId: "native-idp-document" },
      stepIndex: 0,
      signInFill: true,
      step: {
        kind: "fill",
        effect: "prepare",
        path: observedPath(location.pathname),
        fields: [{ slot: "username", target: { by: "id", value: "native-username" } }],
      },
    },
    values: [{ slot: "username", value: "synthetic-local-user" }],
  };
}
describe("installed content narrowly withdraws one native attempt", () => {
  it.each(["exact", "other", "stale-token"])(
    "handles %s cancellation while native authority acknowledgement is pending",
    async (cancel) => {
      const commit = await installAndPrepare();
      const input = document.createElement("input");
      input.id = "native-username";
      input.autocomplete = "username";
      document.body.append(input);
      const loading = vi.spyOn(document, "readyState", "get").mockReturnValue("loading");
      stopRecording = recordFillEdits(document, window);
      loading.mockRestore();
      const gate = Promise.withResolvers<boolean>();
      wire.nativeAuthorize.mockReturnValueOnce(gate.promise);
      const filling = command(nativeFill(commit.token, "current-native", "pending-fill"));
      await vi.waitFor(() => expect(wire.nativeAuthorize).toHaveBeenCalledTimes(1));
      expect(input.value).toBe("");
      const cancelCommand = {
        version: 1,
        type: "login.native.cancel",
        token: cancel === "stale-token" ? "stale-document-token" : commit.token,
        attemptId: cancel === "other" ? "old-native" : "current-native",
      };
      if (cancel === "stale-token")
        await expect(command(cancelCommand)).rejects.toThrow("Command was not accepted");
      else expect(await command(cancelCommand)).toEqual({ ok: true });
      gate.resolve(true);
      const result = await filling;
      if (cancel === "exact") {
        expect(result).toMatchObject({ ok: false, reason: "cancelled", mutation: "none" });
        expect(input.value).toBe("");
        expect(
          await command(nativeFill(commit.token, "current-native", "replayed-fill")),
        ).toMatchObject({ ok: false, reason: "cancelled", mutation: "none" });
        expect(input.value).toBe("");
        expect(await command(nativeFill(commit.token, "new-native", "fresh-fill"))).toMatchObject({
          ok: true,
        });
        expect(input.value).toBe("synthetic-local-user");
      } else {
        expect(result).toMatchObject({ ok: true });
        expect(input.value).toBe("synthetic-local-user");
      }
      const clicked = vi.fn();
      document.getElementById("entry")!.addEventListener("click", clicked);
      expect(await command(commit)).toEqual({ ok: true });
      expect(clicked).toHaveBeenCalledTimes(1);
      expect(
        wire.sent.filter(({ message }) => message["type"] === "login.sso.authorize"),
      ).toHaveLength(2);
    },
  );
});
