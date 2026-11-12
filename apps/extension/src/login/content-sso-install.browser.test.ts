import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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
    return { ok: false, reason: "recipe-not-found", starts: [] };
  },
}));
let uninstall: (() => void) | undefined;
beforeEach(() => {
  wire.sent.length = 0;
  wire.authorize.mockReset().mockResolvedValue({ ok: true });
  wire.raw
    .mockReset()
    .mockRejectedValue(new Error("SSO must use the registered login messaging channel"));
  document.body.innerHTML =
    '<main><button id="entry" type="button">Continue with Synthetic</button></main>';
});
afterEach(() => {
  uninstall?.();
  uninstall = undefined;
  document.body.innerHTML = "";
});
async function command(message: Record<string, unknown>): Promise<unknown> {
  if (!wire.listener) throw new Error("No installed content listener");
  const listener = wire.listener;
  return new Promise((resolve, reject) => {
    if (listener(message, { id: "synthetic-extension" }, resolve) !== true)
      reject(new Error("Command was not accepted"));
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
