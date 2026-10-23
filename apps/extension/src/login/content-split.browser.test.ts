import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { installLoginContent } from "./content";

// The popup's fill of a personal detail split over several inputs (ADR 0061, owner
// 2026-10-23 12:26 UTC): every part's input is checked before any is filled, a select's
// part is chosen only by an option that says its number, and a digit group goes only into
// a box of its length. Synthetic pages and values only.
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

type Field = { target: { by: "id"; value: string }; value: string; secret: string; group?: true };
/** The page's answer to the popup's `login.detail.fill` of these fields. */
async function fill(fields: Field[]) {
  const token = sent.find((message) => typeof message["token"] === "string")?.["token"];
  let answer: unknown;
  for (const listener of listeners)
    listener(
      { version: 1, type: "login.detail.fill", token, path: location.pathname, fields },
      { id: "synthetic-extension" },
      (value) => (answer = value),
    );
  for (let tick = 0; tick < 100 && answer === undefined; tick += 1)
    // eslint-disable-next-line no-await-in-loop
    await vi.advanceTimersByTimeAsync(100);
  return answer;
}
const id = (value: string) => ({ by: "id" as const, value });
const options = (from: number, to: number, suffix = "") =>
  Array.from({ length: to - from + 1 }, (_, at) => from + at)
    .map((number) => `<option value="${number}">${number}${suffix}</option>`)
    .join("");
const birthPage = (months = options(1, 12, "月")) =>
  `<form><label>生年月日
    <select id="by"><option value="">----</option>${options(1940, 2010, "年")}</select>
    <select id="bm"><option value="">--</option>${months}</select>
    <select id="bd"><option value="">--</option>${options(1, 31, "日")}</select></label>
    <button id="confirm" type="button">確認</button></form>`;
const datePart = (target: string, value: string): Field => ({
  target: id(target),
  value,
  secret: "date-part",
});
const value = (target: string) =>
  (document.getElementById(target) as HTMLInputElement | HTMLSelectElement).value;

describe("a split detail's popup fill", () => {
  it("chooses a birth date's year, month and day by their numbers, with bubbling events", async () => {
    document.body.innerHTML = birthPage();
    const changes: string[] = [];
    document.body.addEventListener("change", (event) => {
      changes.push((event.target as HTMLSelectElement).id);
    });
    uninstall = installLoginContent();
    await vi.advanceTimersByTimeAsync(200);
    expect(await fill([datePart("by", "1990"), datePart("bm", "04"), datePart("bd", "5")])).toEqual(
      { ok: true },
    );
    expect([value("by"), value("bm"), value("bd")]).toEqual(["1990", "4", "5"]);
    expect(changes).toEqual(["by", "bm", "bd"]);
  });

  it("chooses nothing when one select has no option for its part, or several", async () => {
    // The month's values count from 0, so its option for April cannot be told.
    const zeroBased = Array.from(
      { length: 12 },
      (_, at) => `<option value="${at}">${at + 1}</option>`,
    ).join("");
    for (const [page, parts] of [
      [birthPage(), [datePart("by", "1939"), datePart("bm", "4"), datePart("bd", "5")]],
      [birthPage(zeroBased), [datePart("by", "1990"), datePart("bm", "4"), datePart("bd", "5")]],
    ] as const) {
      document.body.innerHTML = page;
      uninstall?.();
      uninstall = installLoginContent();
      // eslint-disable-next-line no-await-in-loop
      await vi.advanceTimersByTimeAsync(200);
      // eslint-disable-next-line no-await-in-loop
      expect(await fill([...parts])).toEqual({ ok: false });
      expect([value("by"), value("bm"), value("bd")]).toEqual(["", "", ""]);
    }
  });

  it("puts no value but a date's part into a select", async () => {
    document.body.innerHTML = birthPage();
    uninstall = installLoginContent();
    await vi.advanceTimersByTimeAsync(200);
    expect(
      await fill([{ target: id("by"), value: "1990", secret: "detail" }, datePart("bm", "4")]),
    ).toEqual({ ok: false });
    expect([value("by"), value("bm")]).toEqual(["", ""]);
  });

  it("types a card number's groups into boxes of their length, or none of them", async () => {
    const boxes = (fourth = 4) =>
      `<form>${[4, 4, 4, fourth]
        .map((length, at) => `<input id="c${at + 1}" type="tel" maxlength="${length}">`)
        .join("")}<button id="confirm" type="button">Confirm</button></form>`;
    const groups = ["4000", "0000", "0000", "0002"].map((group, at): Field => ({
      target: id(`c${at + 1}`),
      value: group,
      secret: "card-number",
      group: true,
    }));
    document.body.innerHTML = boxes();
    uninstall = installLoginContent();
    await vi.advanceTimersByTimeAsync(200);
    expect(await fill(groups.map((group) => ({ ...group })))).toEqual({ ok: true });
    expect(["c1", "c2", "c3", "c4"].map(value)).toEqual(["4000", "0000", "0000", "0002"]);
    // A last box that takes more digits than its group is no box of that group.
    document.body.innerHTML = boxes(7);
    expect(await fill(groups.map((group) => ({ ...group })))).toEqual({ ok: false });
    expect(["c1", "c2", "c3", "c4"].map(value)).toEqual(["", "", "", ""]);
  });
});
