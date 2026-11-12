import { afterEach, describe, expect, it } from "vitest";
import { clickable, keyable, writable } from "./target-state";

afterEach(() => {
  document.body.innerHTML = "";
});
const controls = `<input data-control="input" type="password">
  <input data-control="keypad" type="password" readonly>
  <button data-control="button" type="button">Continue</button>
  <input data-control="submit" type="submit" value="Sign in">`;
function check(root: ParentNode, enabled: boolean) {
  const input = root.querySelector<HTMLInputElement>('[data-control="input"]')!;
  const keypad = root.querySelector<HTMLInputElement>('[data-control="keypad"]')!;
  expect(writable(input)).toBe(enabled);
  expect(keyable(input)).toBe(enabled);
  expect(writable(keypad)).toBe(false);
  expect(keyable(keypad)).toBe(enabled);
  expect(clickable(root.querySelector('[data-control="button"]')!)).toBe(enabled);
  expect(clickable(root.querySelector('[data-control="submit"]')!)).toBe(enabled);
}

describe("native controls inside disabled fieldsets", () => {
  it("rejects inherited disablement although the controls' own disabled properties are false", () => {
    document.body.innerHTML = `<fieldset disabled>${controls}</fieldset>`;
    expect(
      [...document.querySelectorAll<HTMLInputElement | HTMLButtonElement>("input,button")].every(
        (control) => !control.disabled,
      ),
    ).toBe(true);
    check(document, false);
  });

  it("still rejects directly disabled controls without a fieldset", () => {
    document.body.innerHTML = controls;
    for (const control of document.querySelectorAll<HTMLInputElement | HTMLButtonElement>(
      "input,button",
    ))
      control.disabled = true;
    check(document, false);
  });

  it("keeps the first legend enabled and disables a second legend and the fieldset body", () => {
    document.body.innerHTML = `<fieldset disabled>
      <legend id="first">${controls}</legend><div id="body">${controls}</div>
      <legend id="second">${controls}</legend></fieldset>`;
    check(document.querySelector("#first")!, true);
    check(document.querySelector("#body")!, false);
    check(document.querySelector("#second")!, false);
  });

  it("does not let a nested fieldset's first legend escape its disabled outer fieldset", () => {
    document.body.innerHTML = `<fieldset disabled><legend>Outer title</legend>
      <fieldset><legend id="inner">${controls}</legend></fieldset></fieldset>`;
    check(document.querySelector("#inner")!, false);
  });

  it("applies each disabled fieldset's own first-legend exception", () => {
    document.body.innerHTML = `<fieldset disabled><legend><fieldset disabled>
      <legend id="both-first">${controls}</legend><div id="inner-body">${controls}</div>
      </fieldset></legend></fieldset>`;
    check(document.querySelector("#both-first")!, true);
    check(document.querySelector("#inner-body")!, false);
  });

  it("follows a fieldset becoming enabled and disabled again without changing its inputs", () => {
    document.body.innerHTML = `<fieldset disabled>${controls}</fieldset>`;
    const fieldset = document.querySelector("fieldset")!;
    check(document, false);
    fieldset.disabled = false;
    check(document, true);
    fieldset.disabled = true;
    check(document, false);
  });
});
