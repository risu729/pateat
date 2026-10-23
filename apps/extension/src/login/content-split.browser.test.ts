import { detailSlot } from "@pateat/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { observedPath } from "../observation/path";
import { installLoginContent } from "./content";

// A personal detail split over several inputs (ADR 0061, owner 2026-10-23 12:26 UTC), as
// the popup's fill and a login's fill put it in: every part's input is checked before any
// is filled, a select's part is chosen only by an option that says its number, a digit
// group goes only into a box of its length, and the click goes on only while every select
// still shows its option. Synthetic pages and values only.
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

type Field = {
  target: { by: "id"; value: string };
  value: string;
  secret: string;
  group?: number;
  part?: "year" | "month" | "day";
  shortYear?: true;
};
/** Sends `message` to the content script and waits for its answer. */
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
/** The page's answer to the popup's `login.detail.fill` of these fields. */
const fill = (fields: Field[]) =>
  ask({ type: "login.detail.fill", path: location.pathname, fields });
let operations = 0;
/**
 * The page's answer to a login's step, as the service worker sends it (`login.execute`),
 * without the operation and document it names.
 */
async function execute(
  step: { kind: "fill"; fields: Field[] } | { kind: "click"; target: string },
): Promise<unknown> {
  operations += 1;
  const path = observedPath(location.pathname);
  const answer = await ask({
    type: "login.execute",
    operation: {
      version: 1,
      attemptId: "attempt-split",
      operationId: `operation-${operations}`,
      policyRevision: 1,
      expiresAt: Date.now() + 60_000,
      document: { origin: self.origin, tabId: 1, frameId: 0, documentId: "document-split" },
      stepIndex: step.kind === "fill" ? 0 : 1,
      step:
        step.kind === "fill"
          ? {
              kind: "fill",
              effect: "prepare",
              path,
              fields: step.fields.map((field, at) => ({
                slot: detailSlot(at),
                target: field.target,
              })),
            }
          : { kind: "click", path, target: id(step.target), purpose: "submit" },
    },
    values:
      step.kind === "fill"
        ? step.fields.map(({ target: _target, ...field }, at) => ({
            slot: detailSlot(at),
            ...field,
          }))
        : [],
  });
  if (typeof answer !== "object" || answer === null) return answer;
  const { operationId, documentId, ...rest } = answer as Record<string, unknown>;
  expect([operationId, documentId]).toEqual([`operation-${operations}`, "document-split"]);
  return rest;
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
const datePart = (
  target: string,
  value: string,
  part: "year" | "month" | "day" = target === "by" ? "year" : target === "bm" ? "month" : "day",
): Field => ({ target: id(target), value, secret: "date-part", part });
const birthDate = () => [datePart("by", "1990"), datePart("bm", "04"), datePart("bd", "5")];
const value = (target: string) =>
  (document.getElementById(target) as HTMLInputElement | HTMLSelectElement).value;
const cardBoxes = (lengths: number[]) =>
  `<form>${lengths
    .map((length, at) => `<input id="c${at + 1}" type="tel" maxlength="${length}">`)
    .join("")}<button id="confirm" type="button">Confirm</button></form>`;
const cardGroups = (values: string[], lengths: number[]) =>
  values.map((group, at): Field => ({
    target: id(`c${at + 1}`),
    value: group,
    secret: "card-number",
    group: lengths[at]!,
  }));
const monthNames = (values: (at: number) => number) =>
  [
    "January",
    "February",
    "March",
    "April",
    "May",
    "June",
    "July",
    "August",
    "September",
    "October",
    "November",
    "December",
  ]
    .map((name, at) => `<option value="${values(at)}">${name}</option>`)
    .join("");
async function install(page: string) {
  document.body.innerHTML = page;
  uninstall?.();
  // A removed content script's listener and token answer nothing more.
  listeners.length = 0;
  sent.length = 0;
  uninstall = installLoginContent();
  await vi.advanceTimersByTimeAsync(200);
}

describe("a split detail's popup fill", () => {
  it("chooses a birth date's year, month and day by their numbers, with bubbling events", async () => {
    await install(birthPage());
    const changes: string[] = [];
    document.body.addEventListener("change", (event) => {
      changes.push((event.target as HTMLSelectElement).id);
    });
    expect(await fill(birthDate())).toEqual({ ok: true });
    expect([value("by"), value("bm"), value("bd")]).toEqual(["1990", "4", "5"]);
    expect(changes).toEqual(["by", "bm", "bd"]);
  });

  it("chooses a month by its name's value only while the values count from 1", async () => {
    await install(birthPage(monthNames((at) => at + 1)));
    expect(await fill(birthDate())).toEqual({ ok: true });
    expect((document.getElementById("bm") as HTMLSelectElement).selectedOptions[0]?.text).toBe(
      "April",
    );
  });

  it("chooses nothing when one select has no option for its part, or several", async () => {
    for (const [page, parts] of [
      [birthPage(), [datePart("by", "1939"), datePart("bm", "4"), datePart("bd", "5")]],
      // Month names whose values count from 0: April's value says 3, May's 4.
      [birthPage(monthNames((at) => at)), birthDate()],
      // A month select the page fills only once the year is chosen.
      [birthPage(""), birthDate()],
    ] as const) {
      // eslint-disable-next-line no-await-in-loop
      await install(page);
      // eslint-disable-next-line no-await-in-loop
      expect(await fill([...parts])).toEqual({ ok: false });
      expect([value("by"), value("bm"), value("bd")]).toEqual(["", "", ""]);
    }
  });

  it("takes a birth year only by its own number, never an era year's", async () => {
    const eraYears = Array.from(
      { length: 20 },
      (_, at) => `<option value="S${45 + at}">昭和${45 + at}年</option>`,
    ).join("");
    await install(
      `<form><select id="by"><option value="">--</option>${eraYears}</select>
        <select id="bm">${options(1, 12)}</select><select id="bd">${options(1, 31)}</select></form>`,
    );
    expect(await fill(birthDate())).toEqual({ ok: false });
    expect(value("by")).toBe("");
  });

  it("chooses a card expiry year a select writes with two digits", async () => {
    await install(
      `<form><select id="em"><option value="">MM</option>${options(1, 12)}</select>
        <select id="ey"><option value="">YY</option>${options(26, 36)}</select></form>`,
    );
    expect(
      await fill([
        { target: id("em"), value: "04", secret: "date-part", part: "month" },
        { target: id("ey"), value: "2031", secret: "date-part", part: "year", shortYear: true },
      ]),
    ).toEqual({ ok: true });
    expect([value("em"), value("ey")]).toEqual(["4", "31"]);
  });

  it("puts no value but a date's part into a select", async () => {
    await install(birthPage());
    expect(
      await fill([{ target: id("by"), value: "1990", secret: "detail" }, datePart("bm", "4")]),
    ).toEqual({ ok: false });
    expect([value("by"), value("bm")]).toEqual(["", ""]);
  });

  it("fills no parts that are in different forms", async () => {
    await install(
      `<form><select id="by">${options(1940, 2010)}</select></form>
       <form><select id="bm">${options(1, 12)}</select><select id="bd">${options(1, 31)}</select></form>`,
    );
    const before = [value("by"), value("bm"), value("bd")];
    expect(await fill(birthDate())).toEqual({ ok: false });
    expect([value("by"), value("bm"), value("bd")]).toEqual(before);
  });

  it("types a card number's groups into boxes of their length, or none of them", async () => {
    const groups = () => cardGroups(["4000", "0000", "0000", "0002"], [4, 4, 4, 4]);
    await install(cardBoxes([4, 4, 4, 4]));
    expect(await fill(groups())).toEqual({ ok: true });
    expect(["c1", "c2", "c3", "c4"].map(value)).toEqual(["4000", "0000", "0000", "0002"]);
    // A last box that takes more digits than the worker made its group for is another box.
    document.body.innerHTML = cardBoxes([4, 4, 4, 7]);
    expect(await fill(groups())).toEqual({ ok: false });
    expect(["c1", "c2", "c3", "c4"].map(value)).toEqual(["", "", "", ""]);
  });
});

describe("a login's fill of a split detail (login.execute)", () => {
  it("chooses a birth date's parts, then clicks while every select shows its option", async () => {
    await install(birthPage());
    const clicks: string[] = [];
    document.getElementById("confirm")!.addEventListener("click", () => clicks.push("confirm"));
    expect(await execute({ kind: "fill", fields: birthDate() })).toEqual({
      ok: true,
      mutation: "possible",
    });
    expect([value("by"), value("bm"), value("bd")]).toEqual(["1990", "4", "5"]);
    expect(await execute({ kind: "click", target: "confirm" })).toEqual({
      ok: true,
      mutation: "possible",
    });
    expect(clicks).toEqual(["confirm"]);
  });

  it("never clicks after the page changed a chosen select back", async () => {
    await install(birthPage());
    const clicks: string[] = [];
    document.getElementById("confirm")!.addEventListener("click", () => clicks.push("confirm"));
    expect(await execute({ kind: "fill", fields: birthDate() })).toMatchObject({ ok: true });
    // The page resets the month once the fill is over, as a script that rebuilds it might.
    (document.getElementById("bm") as HTMLSelectElement).selectedIndex = 0;
    expect(await execute({ kind: "click", target: "confirm" })).toEqual({
      ok: false,
      reason: "cancelled",
      detail: "field-changed",
      mutation: "none",
    });
    expect(clicks).toEqual([]);
    // So does a select whose chosen option the page replaced with an equal one.
    await install(birthPage());
    expect(await execute({ kind: "fill", fields: birthDate() })).toMatchObject({ ok: true });
    const day = document.getElementById("bd") as HTMLSelectElement;
    day.replaceChildren(...[...day.options].map((option) => option.cloneNode(true)));
    day.value = "5";
    expect(await execute({ kind: "click", target: "confirm" })).toMatchObject({
      ok: false,
      detail: "field-changed",
    });
  });

  it("types a card number of 16 digits into groups whose last box takes up to 7", async () => {
    await install(cardBoxes([4, 4, 4, 7]));
    expect(
      await execute({
        kind: "fill",
        fields: cardGroups(["4000", "0000", "0000", "0002"], [4, 4, 4, 7]),
      }),
    ).toEqual({ ok: true, mutation: "possible" });
    expect(["c1", "c2", "c3", "c4"].map(value)).toEqual(["4000", "0000", "0000", "0002"]);
    expect(await execute({ kind: "click", target: "confirm" })).toMatchObject({ ok: true });
  });

  it("fills nothing when a part does not fit its input, before anything is filled", async () => {
    // A box whose maxlength is not its group's.
    await install(cardBoxes([4, 4, 4, 4]));
    expect(
      await execute({
        kind: "fill",
        fields: cardGroups(["4000", "0000", "0000", "0002"], [4, 4, 4, 7]),
      }),
    ).toEqual({ ok: false, reason: "value-mismatch", mutation: "none" });
    expect(["c1", "c2", "c3", "c4"].map(value)).toEqual(["", "", "", ""]);
    // A month select the page fills only once the year is chosen: the runtime leaves it to
    // the person as a challenge (`detail-unfit`).
    await install(birthPage(""));
    expect(await execute({ kind: "fill", fields: birthDate() })).toEqual({
      ok: false,
      reason: "value-mismatch",
      mutation: "none",
    });
    expect([value("by"), value("bm"), value("bd")]).toEqual(["", "", ""]);
  });

  it("puts only a date's part into a select", async () => {
    await install(birthPage());
    expect(
      await execute({
        kind: "fill",
        fields: [{ target: id("by"), value: "1990", secret: "detail" }, datePart("bm", "4")],
      }),
    ).toEqual({
      ok: false,
      reason: "structural-mismatch",
      detail: "target-missing",
      mutation: "none",
    });
    expect([value("by"), value("bm")]).toEqual(["", ""]);
  });

  it("clicks nothing after the page marks a chosen select invalid", async () => {
    await install(birthPage());
    const day = document.getElementById("bd") as HTMLSelectElement;
    // The page refuses the day it was given.
    day.addEventListener("change", () => day.setAttribute("aria-invalid", "true"));
    expect(await execute({ kind: "fill", fields: birthDate() })).toEqual({
      ok: false,
      reason: "fill-rejected",
      mutation: "possible",
    });
  });
});
