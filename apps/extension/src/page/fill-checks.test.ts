import { afterEach, describe, expect, it } from "vitest";
import { fillBaseline, inputValueMismatch, rejectsFill } from "./fill-checks";

afterEach(() => {
  document.body.innerHTML = "";
});

function input(html: string): HTMLInputElement {
  document.body.insertAdjacentHTML("beforeend", html);
  return document.body.lastElementChild as HTMLInputElement;
}

describe("inputValueMismatch", () => {
  it("reads the input's type and declared lengths", () => {
    expect(inputValueMismatch(input('<input maxlength="3">'), "1234")).toBe("too-long");
    expect(inputValueMismatch(input('<input maxlength="3">'), "123")).toBeUndefined();
    expect(inputValueMismatch(input('<input minlength="6">'), "12345")).toBe("too-short");
    expect(inputValueMismatch(input('<input maxlength="0">'), "1")).toBe("too-long");
    // An invalid attribute is ignored, as the browser ignores it.
    expect(inputValueMismatch(input('<input maxlength="x">'), "1234")).toBeUndefined();
    expect(inputValueMismatch(input('<input type="email">'), "sato-7")).toBe("not-email");
    expect(inputValueMismatch(input('<input type="number" maxlength="2">'), "123")).toBeUndefined();
    expect(inputValueMismatch(input('<input type="number">'), "12a")).toBe("not-number");
    expect(inputValueMismatch(input('<input type="password">'), "")).toBe("missing-value");
  });
});

describe("rejectsFill", () => {
  it("sees invalid inputs and new alert or live region text", () => {
    document.body.innerHTML =
      '<form><input id="field" pattern="[0-9]+" aria-describedby="hint"><p id="inside"></p></form><p id="hint" aria-live="polite"></p>';
    const field = document.querySelector<HTMLInputElement>("#field")!;
    const before = fillBaseline([field]);
    field.value = "123";
    expect(rejectsFill([field], before)).toBe(false);
    field.value = "abc";
    expect(rejectsFill([field], before)).toBe(true);
    field.value = "123";
    field.setAttribute("aria-invalid", "true");
    expect(rejectsFill([field], before)).toBe(true);
    field.setAttribute("aria-invalid", "false");
    field.setCustomValidity("Not accepted");
    expect(rejectsFill([field], before)).toBe(true);
    field.setCustomValidity("");
    expect(rejectsFill([field], before)).toBe(false);
    // An alert anywhere, a status inside the form, and the region the input names.
    for (const [parent, region] of [
      [document.body, '<p role="alert">Wrong format</p>'],
      [document.body, '<div aria-live="assertive"><span>Wrong format</span></div>'],
      [document.querySelector("form")!, '<p role="status">Wrong format</p>'],
    ] as const) {
      parent.insertAdjacentHTML("beforeend", region);
      expect(rejectsFill([field], before)).toBe(true);
      parent.lastElementChild!.remove();
    }
    document.querySelector("#hint")!.textContent = "Digits only";
    expect(rejectsFill([field], before)).toBe(true);
    document.querySelector("#hint")!.textContent = "";
  });

  it("ignores messages already shown, unrelated status regions and earlier marks", () => {
    document.body.innerHTML =
      '<div id="notice"><p role="alert">Your session expired</p></div><p role="alert" hidden>Wrong format</p><div role="timer">00:59</div><p aria-live="polite" id="clock">Session expires in 5:00</p><div role="status" id="suggestions"></div><form aria-live="polite"><input id="field" aria-invalid="true"><button type="button" hidden>Show</button></form>';
    const field = document.querySelector<HTMLInputElement>("#field")!;
    field.setCustomValidity("Left from the last sign-in");
    const before = fillBaseline([field]);
    field.value = "user";
    // Rendered again as a new element with the same text.
    document.getElementById("notice")!.innerHTML = '<p role="alert">Your session expired</p>';
    document.querySelector('[role="timer"]')!.textContent = "00:58";
    document.querySelector("#clock")!.textContent = "Session expires in 4:59";
    document.querySelector("#suggestions")!.textContent = "3 results available";
    // A live region around the input itself changes with any text of the form.
    document.querySelector<HTMLElement>("form button")!.hidden = false;
    expect(rejectsFill([field], before)).toBe(false);
    field.setCustomValidity("Another message");
    expect(rejectsFill([field], before)).toBe(true);
    field.setCustomValidity("Left from the last sign-in");
    document.querySelector<HTMLElement>("[hidden]")!.hidden = false;
    expect(rejectsFill([field], before)).toBe(true);
  });
});

describe("a code fill's status messages (ADR 0027)", () => {
  it("never reads a new status of the form as a rejection of the code", () => {
    document.body.innerHTML =
      '<form><input id="code" autocomplete="one-time-code"><p role="status" id="state"></p></form>';
    const code = document.querySelector<HTMLInputElement>("#code")!;
    const before = fillBaseline([code]);
    code.value = "012345";
    document.querySelector("#state")!.textContent = "6 of 6 digits";
    expect(rejectsFill([code], before, { statuses: false })).toBe(false);
    // A fill whose statuses count still reads it as a rejection, and alerts always count.
    expect(rejectsFill([code], before)).toBe(true);
    document.body.insertAdjacentHTML("beforeend", '<p role="alert">Wrong code</p>');
    expect(rejectsFill([code], before, { statuses: false })).toBe(true);
  });
});
