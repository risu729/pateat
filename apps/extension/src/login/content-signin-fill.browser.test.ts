import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { userEvent } from "vitest/browser";
import { recordFillEdits, fillEditsReady, fillUntouched } from "../page/fill-edits";
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
        removeListener: (listener: Listener) => {
          const index = listeners.indexOf(listener);
          if (index >= 0) listeners.splice(index, 1);
        },
      },
    },
  },
}));
vi.mock("../messaging/protocol", () => ({
  sendMessage: async (_channel: string, message: Record<string, unknown>) => {
    sent.push(message);
    if (message["type"] === "login.operation.authorize") return true;
    return { ok: false, reason: "stale-document" };
  },
}));
let stop: (() => void) | undefined;
let uninstall: (() => void) | undefined;
let operation = 0;
const key = Symbol.for("pateat.fillEdits");
beforeEach(() => {
  operation = 0;
  sent.length = 0;
  listeners.length = 0;
});
afterEach(() => {
  uninstall?.();
  stop?.();
  uninstall = undefined;
  stop = undefined;
  delete (window as unknown as Record<symbol, unknown>)[key];
  document.body.innerHTML = "";
  vi.restoreAllMocks();
});

async function install(html: string, recording = true) {
  document.body.innerHTML = html;
  if (recording) {
    // Browser Mode has already loaded. Represent document_start only while installing
    // the actual recorder; every user edit below comes from Chromium's trusted typing.
    const loading = vi.spyOn(document, "readyState", "get").mockReturnValue("loading");
    stop = recordFillEdits(document, window);
    loading.mockRestore();
  }
  uninstall = installLoginContent();
  await vi.waitFor(() =>
    expect(sent.some((entry) => typeof entry["token"] === "string")).toBe(true),
  );
}
async function fill(
  target: string,
  { stepIndex = 0, slot = "username", value = "fixture@example.com", secret = "" } = {},
) {
  const token = sent.find((entry) => typeof entry["token"] === "string")?.["token"];
  let answer: unknown;
  operation += 1;
  const message = {
    version: 1,
    token,
    type: "login.execute",
    operation: {
      version: 1,
      attemptId: "attempt-fill",
      operationId: `operation-${operation}`,
      policyRevision: 1,
      expiresAt: Date.now() + 60_000,
      document: { origin: self.origin, tabId: 1, frameId: 0, documentId: "document-fill" },
      stepIndex,
      signInFill: true,
      step: {
        kind: "fill",
        effect: "prepare",
        path: observedPath(location.pathname),
        fields: [{ slot, target: { by: "id", value: target } }],
      },
    },
    values: [{ slot, value, ...(secret ? { secret } : {}) }],
  };
  for (const listener of listeners)
    listener(message, { id: "synthetic-extension" }, (reply) => {
      answer = reply;
    });
  await vi.waitFor(() => expect(answer).toBeDefined());
  return answer;
}
const input = (id: string) => document.getElementById(id) as HTMLInputElement;

test("trusted typing before fill protects both the edited field and its replacement", async () => {
  await install('<label>Username<input id="username" name="username" type="email"></label>');
  const trusted: boolean[] = [];
  input("username").addEventListener("input", (event) => trusted.push(event.isTrusted));
  await userEvent.type(input("username"), "person@example.com");
  expect(trusted.length).toBeGreaterThan(0);
  expect(trusted.every(Boolean)).toBe(true);
  expect(await fill("username")).toMatchObject({ ok: true });
  expect(input("username").value).toBe("person@example.com");
  document.body.innerHTML =
    '<label>Username<input id="replacement" name="username" type="email"></label>';
  expect(await fill("replacement", { stepIndex: 2 })).toMatchObject({
    ok: false,
    reason: "structural-mismatch",
    detail: "form-changed",
    mutation: "none",
  });
  expect(input("replacement").value).toBe("");
});

test("a replacement with no shared name remains protected by its logical input kind", async () => {
  await install('<label>Username<input id="username" type="email"></label>');
  await userEvent.type(input("username"), "person@example.com");
  document.body.innerHTML = '<label>Username<input id="fresh" type="email"></label>';
  expect(await fill("fresh")).toMatchObject({
    ok: false,
    reason: "structural-mismatch",
    detail: "form-changed",
    mutation: "none",
  });
  expect(input("fresh").value).toBe("");
});

test("editing the username does not prevent a later password step from filling", async () => {
  await install(
    '<label>Username<input id="username" type="email" autocomplete="username"></label>',
  );
  await userEvent.type(input("username"), "person@example.com");
  document.body.innerHTML =
    '<label>Password<input id="password" type="password" autocomplete="current-password"></label>';
  expect(fillUntouched(window, input("password"))).toBe(true);
  expect(
    await fill("password", {
      stepIndex: 2,
      slot: "password",
      secret: "password",
      value: "Synthetic-only!",
    }),
  ).toMatchObject({ ok: true });
  expect(input("password").value).toBe("Synthetic-only!");
});

test.each(["missing", "late"] as const)(
  "a %s document-start recording refuses all filling",
  async (recording) => {
    await install('<label>Username<input id="username" type="email"></label>', false);
    if (recording === "late") stop = recordFillEdits(document, window);
    expect(fillEditsReady(window)).toBe(false);
    expect(await fill("username")).toMatchObject({
      ok: false,
      reason: "cancelled",
      detail: "document-cancelled",
    });
    expect(input("username").value).toBe("");
  },
);

test("a lost fill acknowledgement and content reconnect never repeat the claimed field", async () => {
  await install('<label>Username<input id="username" type="email"></label>');
  let writes = 0;
  input("username").addEventListener("input", () => {
    writes += 1;
  });
  expect(await fill("username")).toMatchObject({ ok: true });
  expect(input("username").value).toBe("fixture@example.com");
  const initialWrites = writes;
  expect(initialWrites).toBeGreaterThan(0);
  // The page clears the input after the worker loses its acknowledgement. Reissuing
  // with a new operation ID must not treat this as an untouched slot to fill again.
  input("username").value = "";
  expect(await fill("username")).toMatchObject({
    ok: false,
    reason: "structural-mismatch",
    detail: "form-changed",
    mutation: "none",
  });
  expect(input("username").value).toBe("");
  expect(writes).toBe(initialWrites);
  uninstall?.();
  sent.length = 0;
  uninstall = installLoginContent();
  await vi.waitFor(() =>
    expect(sent.some((entry) => typeof entry["token"] === "string")).toBe(true),
  );
  expect(await fill("username")).toMatchObject({
    ok: false,
    reason: "structural-mismatch",
    detail: "form-changed",
    mutation: "none",
  });
  expect(input("username").value).toBe("");
  expect(writes).toBe(initialWrites);
});
