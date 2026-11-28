import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { observedPath } from "../observation/path";
import { installLoginContent } from "./content";

type Listener = (
  message: unknown,
  sender: { id: string },
  respond: (value: unknown) => void,
) => boolean | undefined;
const { sent, listeners } = vi.hoisted(() => ({
  sent: [] as Record<string, unknown>[],
  listeners: [] as Listener[],
}));
vi.mock("wxt/browser", () => ({
  browser: {
    runtime: {
      id: "synthetic-extension",
      onMessage: {
        addListener: (listener: Listener) => listeners.push(listener),
        removeListener: () => undefined,
      },
    },
  },
}));
vi.mock("../messaging/protocol", () => ({
  sendMessage: async (_channel: string, message: Record<string, unknown>) => {
    sent.push(message);
    if (message["type"] === "login.destination.check") return { ok: true };
    return message["type"] === "login.operation.authorize"
      ? true
      : { ok: false, reason: "stale-document" };
  },
}));

let uninstall: (() => void) | undefined;
let operations = 0;
beforeEach(() => {
  sent.length = 0;
  listeners.length = 0;
  operations = 0;
  vi.useFakeTimers();
});
afterEach(() => {
  uninstall?.();
  uninstall = undefined;
  vi.useRealTimers();
  document.body.innerHTML = "";
});

const password = { by: "id" as const, value: "240:credentialElement" };
const layer = { by: "id" as const, value: "274:areaElement" };
async function execute(kind: "fill" | "click", shows?: string) {
  const token = sent.find((message) => typeof message["token"] === "string")?.["token"];
  const path = observedPath(location.pathname);
  const operationId = `operation-overlaid-${++operations}`;
  const message = {
    version: 1,
    type: "login.execute",
    token,
    operation: {
      version: 1,
      attemptId: "attempt-overlaid",
      operationId,
      policyRevision: 1,
      expiresAt: Date.now() + 60_000,
      document: { origin: self.origin, tabId: 1, frameId: 0, documentId: "document-overlaid" },
      stepIndex: kind === "fill" ? 0 : 1,
      step:
        kind === "fill"
          ? { kind, effect: "prepare", path, fields: [{ slot: "password", target: password }] }
          : {
              kind,
              path,
              target: layer,
              purpose: "submit",
              ...(shows === undefined ? {} : { shows }),
            },
    },
    values: kind === "fill" ? [{ slot: "password", value: "synthetic-secret" }] : [],
  };
  const answer: { value?: unknown } = {};
  for (const listener of listeners)
    listener(message, { id: "synthetic-extension" }, (value) => (answer.value = value));
  for (let tick = 0; tick < 100 && answer.value === undefined; tick += 1)
    // eslint-disable-next-line no-await-in-loop
    await vi.advanceTimersByTimeAsync(100);
  expect(answer.value).toMatchObject({ operationId, documentId: "document-overlaid" });
  return answer.value;
}

/**
 * A reduced copy of UNSW Endeavour's sign-in dialog (ADR 0090), synthetic: "log on" takes
 * its clicks on an empty layer under the sibling that holds the text.
 */
async function page(text = "log on") {
  document.body.innerHTML = `<div id="dialog" tabindex="-1" style="position:absolute;left:0;top:0;width:500px;height:234px">
    <div tabindex="-1"><input id="232:credentialElement" autocomplete="username"></div>
    <div tabindex="-1"><input id="240:credentialElement" type="password" autocomplete="current-password"></div>
    <div id="214:spaceElement" tabindex="-1" style="position:absolute;left:165px;top:185px;width:99px;height:20px">
      <div id="274" tabindex="-1" style="position:absolute;inset:0;z-index:1;pointer-events:none"><div id="274:areaElement" tabindex="-1" style="position:absolute;inset:0;cursor:pointer;pointer-events:auto"></div></div>
      <div id="284" tabindex="-1" style="position:absolute;inset:0;z-index:6;pointer-events:none"><div tabindex="-1" style="position:absolute;left:2px;top:2px">${text}</div></div>
    </div>
  </div>`;
  const clicked = vi.fn();
  document.getElementById("274:areaElement")!.addEventListener("click", clicked);
  uninstall = installLoginContent();
  await vi.advanceTimersByTimeAsync(200);
  expect(await execute("fill")).toMatchObject({ ok: true, mutation: "possible" });
  return clicked;
}

describe("a click on a click layer named by the text laid over it (ADR 0090)", () => {
  it("presses the layer while it shows the step's text", async () => {
    const clicked = await page();
    expect(await execute("click", "log on")).toMatchObject({ ok: true, mutation: "possible" });
    expect(clicked).toHaveBeenCalledOnce();
  });

  it.each([
    ["shows another control's text", "exit", "log on"],
    ["is named by a step without `shows`", "log on", undefined],
  ])("presses nothing when the layer %s", async (_, text, shows) => {
    const clicked = await page(text);
    expect(await execute("click", shows)).toMatchObject({
      ok: false,
      reason: "structural-mismatch",
      detail: "target-missing",
      mutation: "none",
    });
    expect(clicked).not.toHaveBeenCalled();
  });
});
