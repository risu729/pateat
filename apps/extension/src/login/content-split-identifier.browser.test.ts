import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { observedPath } from "../observation/path";
import { installLoginContent } from "./content";

// An identifier split over several inputs (ADR 0089), as a login's fill puts it in: the
// recipe names the first box and the boxes' lengths, the content script finds the others
// from the first and checks them all before it types into any. Synthetic page and values.
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
    // The background authorizes every operation of a login's synthetic steps.
    if (message["type"] === "login.operation.authorize") return true;
    return { ok: false, reason: "stale-document" };
  },
}));

let uninstall: (() => void) | undefined;
beforeEach(() => {
  sent.length = 0;
  listeners.length = 0;
  vi.useFakeTimers();
});
afterEach(() => {
  uninstall?.();
  uninstall = undefined;
  vi.useRealTimers();
  document.body.innerHTML = "";
});

async function ask(message: Record<string, unknown>) {
  const token = sent.find((entry) => typeof entry["token"] === "string")?.["token"];
  const answer: { value?: unknown } = {};
  for (const listener of listeners)
    listener({ version: 1, token, ...message }, { id: "synthetic-extension" }, (value) => {
      answer.value = value;
    });
  for (let tick = 0; tick < 100 && answer.value === undefined; tick += 1)
    // eslint-disable-next-line no-await-in-loop
    await vi.advanceTimersByTimeAsync(100);
  return answer.value;
}
let operations = 0;
/** The page's answer to a login's step, as the service worker sends it (`login.execute`). */
async function execute(
  step: Record<string, unknown>,
  values: { slot: string; value: string }[] = [],
): Promise<unknown> {
  operations += 1;
  const answer = await ask({
    type: "login.execute",
    operation: {
      version: 1,
      attemptId: "attempt-split-identifier",
      operationId: `operation-${operations}`,
      policyRevision: 1,
      expiresAt: Date.now() + 60_000,
      document: { origin: self.origin, tabId: 1, frameId: 0, documentId: "document-split" },
      stepIndex: step["kind"] === "fill" ? 0 : 1,
      step: { ...step, path: observedPath(location.pathname) },
    },
    values,
  });
  if (typeof answer !== "object" || answer === null) return answer;
  const {
    operationId: _operation,
    documentId: _document,
    ...rest
  } = answer as Record<string, unknown>;
  return rest;
}
const boxes = (lengths: number[], extra = "") =>
  `<form><p>お客さま番号</p><p>${lengths
    .map((length, at) => `<input type="text" name="no${at + 1}" maxlength="${length}">`)
    .join(" - ")}</p>${extra}</form>`;
const fill = (value: string, split: number[] = [4, 4, 5]) =>
  execute(
    {
      kind: "fill",
      effect: "prepare",
      fields: [{ slot: "username", target: { by: "name", value: "no1" }, split }],
    },
    [{ slot: "username", value }],
  );
const typed = () =>
  [...document.querySelectorAll<HTMLInputElement>("input[type='text']")].map(
    (input) => input.value,
  );
async function install(page: string) {
  document.body.innerHTML = page;
  uninstall?.();
  listeners.length = 0;
  sent.length = 0;
  uninstall = installLoginContent();
  await vi.advanceTimersByTimeAsync(200);
}

describe("a split identifier's login fill", () => {
  it("types each part of the number into its box, without its hyphens", async () => {
    await install(boxes([4, 4, 5], '<button name="next">Next</button>'));
    const inputs: string[] = [];
    document.body.addEventListener("input", (event) => {
      inputs.push((event.target as HTMLInputElement).name);
    });
    expect(await fill("1234-5678-12345")).toEqual({ ok: true, mutation: "possible" });
    expect(typed()).toEqual(["1234", "5678", "12345"]);
    // Box by box, in order.
    expect([...new Set(inputs)]).toEqual(["no1", "no2", "no3"]);
  });

  it("takes a number without hyphens, in full-width digits, or with a shorter last part", async () => {
    for (const [value, parts] of [
      ["1234567812345", ["1234", "5678", "12345"]],
      ["１２３４ ５６７８ １２３", ["1234", "5678", "123"]],
    ] as const) {
      // eslint-disable-next-line no-await-in-loop
      await install(boxes([4, 4, 5], '<button name="next">Next</button>'));
      // eslint-disable-next-line no-await-in-loop
      expect(await fill(value)).toMatchObject({ ok: true });
      expect(typed()).toEqual(parts);
    }
  });

  it("fills no box when the boxes are not the ones the recipe names", async () => {
    for (const [page, split] of [
      // Another length.
      [boxes([4, 4, 4]), [4, 4, 5]],
      // Another number of boxes.
      [boxes([4, 4, 5, 2]), [4, 4, 5]],
      [boxes([4, 4]), [4, 4, 5]],
    ] as const) {
      // eslint-disable-next-line no-await-in-loop
      await install(page);
      // eslint-disable-next-line no-await-in-loop
      expect(await fill("1234-5678-12345", [...split])).toEqual({
        ok: false,
        reason: "structural-mismatch",
        detail: "split-mismatch",
        mutation: "none",
      });
      expect(typed().every((value) => value === "")).toBe(true);
    }
  });

  it("fills no box with a value the boxes cannot take", async () => {
    for (const value of ["1234-5678-123456", "1234-5678", "12345678"]) {
      // eslint-disable-next-line no-await-in-loop
      await install(boxes([4, 4, 5]));
      // eslint-disable-next-line no-await-in-loop
      expect(await fill(value)).toEqual({
        ok: false,
        reason: "value-mismatch",
        mutation: "none",
      });
      expect(typed()).toEqual(["", "", ""]);
    }
  });

  it("presses Enter in the last box of a form without a button", async () => {
    await install(boxes([4, 4]));
    const submits: string[] = [];
    document.querySelector("form")!.addEventListener("submit", (event) => {
      event.preventDefault();
      submits.push("form");
    });
    expect(await fill("1234-5678", [4, 4])).toMatchObject({ ok: true });
    expect(
      await execute({
        kind: "click",
        target: { by: "name", value: "no2" },
        purpose: "advance",
        press: "enter",
      }),
    ).toMatchObject({ ok: true });
    expect(submits).toEqual(["form"]);
  });
});
