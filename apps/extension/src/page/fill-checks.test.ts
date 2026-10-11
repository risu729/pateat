import { afterEach, describe, expect, it } from "vitest";
import { inputValueMismatch, pageFeedback, rejectsFill } from "./fill-checks";

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
    const field = input('<input id="field" pattern="[0-9]+">');
    const before = pageFeedback(document);
    field.value = "123";
    expect(rejectsFill([field], before, document)).toBe(false);
    field.value = "abc";
    expect(rejectsFill([field], before, document)).toBe(true);
    field.value = "123";
    field.setAttribute("aria-invalid", "true");
    expect(rejectsFill([field], before, document)).toBe(true);
    field.setAttribute("aria-invalid", "false");
    field.setCustomValidity("Not accepted");
    expect(rejectsFill([field], before, document)).toBe(true);
    field.setCustomValidity("");
    for (const region of [
      '<p role="alert">Wrong format</p>',
      '<p role="status">Wrong format</p>',
      '<div aria-live="assertive"><span>Wrong format</span></div>',
    ]) {
      document.body.insertAdjacentHTML("beforeend", region);
      expect(rejectsFill([field], before, document)).toBe(true);
      document.body.lastElementChild!.remove();
    }
  });

  it("ignores messages already shown, hidden regions and self-updating regions", () => {
    document.body.innerHTML =
      '<div id="notice"><p role="alert">Your session expired</p></div><p role="alert" hidden>Wrong format</p><div role="timer">00:59</div><p role="status" aria-live="off"></p>';
    const field = input("<input>");
    const before = pageFeedback(document);
    field.value = "user";
    // Rendered again as a new element with the same text.
    document.getElementById("notice")!.innerHTML = '<p role="alert">Your session expired</p>';
    document.querySelector('[role="timer"]')!.textContent = "00:58";
    expect(rejectsFill([field], before, document)).toBe(false);
    document.querySelector<HTMLElement>("[hidden]")!.hidden = false;
    expect(rejectsFill([field], before, document)).toBe(true);
  });
});
