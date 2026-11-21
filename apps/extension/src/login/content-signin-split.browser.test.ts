// A passive fill (ADR 0035: a sign-in fill, a confirmation fill or the popup's Fill) of an
// identifier split over several inputs (ADR 0089): every part is kept, protected and given
// back as the field's one input would be. Synthetic page and values.
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { userEvent } from "vitest/browser";
import { recordFillEdits } from "../page/fill-edits";
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
    if (message["type"] === "login.destination.check")
      return { ok: new URL(String(message["destination"])).hostname === location.hostname };
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
});

// The parts differ in type, so the person's edit of one is not read as an edit of the
// others by the recorder's input-kind identity.
const page = `<form action="${self.origin}/signin"><p>お客さま番号</p><p>
  <input type="text" id="no1" name="no1" maxlength="4"> -
  <input type="tel" id="no2" name="no2" maxlength="4"> -
  <input type="text" id="no3" name="no3" maxlength="5"></p><span id="slot"></span></form>`;
async function install(html = page) {
  document.body.innerHTML = html;
  // Browser Mode has already loaded; document_start is represented while installing.
  const loading = vi.spyOn(document, "readyState", "get").mockReturnValue("loading");
  stop = recordFillEdits(document, window);
  loading.mockRestore();
  uninstall = installLoginContent();
  await vi.waitFor(() =>
    expect(sent.some((entry) => typeof entry["token"] === "string")).toBe(true),
  );
}
async function fill(attemptId = "attempt-fill", value = "1234-5678-12345") {
  const token = sent.find((entry) => typeof entry["token"] === "string")?.["token"];
  let answer: unknown;
  operation += 1;
  const message = {
    version: 1,
    token,
    type: "login.execute",
    operation: {
      version: 1,
      attemptId,
      operationId: `operation-${operation}`,
      policyRevision: 1,
      expiresAt: Date.now() + 60_000,
      document: { origin: self.origin, tabId: 1, frameId: 0, documentId: "document-fill" },
      stepIndex: 0,
      signInFill: true,
      step: {
        kind: "fill",
        effect: "prepare",
        path: observedPath(location.pathname),
        fields: [{ slot: "username", target: { by: "id", value: "no1" }, split: [4, 4, 5] }],
      },
    },
    values: [{ slot: "username", value }],
  };
  for (const listener of listeners)
    listener(message, { id: "synthetic-extension" }, (reply) => {
      answer = reply;
    });
  await vi.waitFor(() => expect(answer).toBeDefined());
  return answer;
}
const values = () =>
  ["no1", "no2", "no3"].map((id) => (document.getElementById(id) as HTMLInputElement).value);
const part = (id: string) => document.getElementById(id) as HTMLInputElement;

test.each(["attempt-fill", "confirm:authenticated-login", "confirm:pick:popup"])(
  "a passive fill (%s) types each part into its box",
  async (attemptId) => {
    await install();
    expect(await fill(attemptId)).toMatchObject({ ok: true });
    expect(values()).toEqual(["1234", "5678", "12345"]);
  },
);

test("the person's typing in a later box keeps every box as it is", async () => {
  await install();
  await userEvent.type(part("no2"), "99");
  // Nothing changed; the boxes left empty read as a changed form, as for any kept field.
  expect(await fill()).toMatchObject({ mutation: "none" });
  expect(values()).toEqual(["", "99", ""]);
});

test("a confirmation fill keeps every box when a later one holds a value", async () => {
  await install();
  part("no3").value = "00000";
  expect(await fill("confirm:authenticated-login")).toMatchObject({ mutation: "none" });
  expect(values()).toEqual(["", "", "00000"]);
});

test("an edit of a later box during the fill stops it before that box", async () => {
  await install();
  part("no1").addEventListener("input", () => {
    // As the recorder marks a box the person typed into while the first is filled.
    (window as unknown as Record<symbol, { touched: WeakSet<Element> }>)[key]!.touched.add(
      part("no3"),
    );
  });
  expect(await fill()).toMatchObject({ ok: false, detail: "field-changed" });
  expect(part("no3").value).toBe("");
});

test("a foreign submitter shown during the fill gives every box back its value", async () => {
  await install();
  part("no2").addEventListener("input", () => {
    if (!document.getElementById("other"))
      document
        .getElementById("slot")!
        .insertAdjacentHTML(
          "beforeend",
          '<button id="other" formaction="https://foreign.example/collect">Go</button>',
        );
  });
  expect(await fill()).toMatchObject({ ok: false, detail: "form-changed" });
  // No part of the number stays where Enter or the new button would send it (ADR 0051).
  expect(values()).toEqual(["", "", ""]);
});
