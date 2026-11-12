import { afterEach, describe, expect, it } from "vitest";
import { extractLoginObservation } from "../observation/extract";
import { identifierInput } from "./identifier-field";
import { keypadInput, pressable } from "./keypad";
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

describe("page reading inside disabled fieldsets", () => {
  it("counts no keypad key in a disabled fieldset as pressable, apart from its first legend's", () => {
    document.body.innerHTML = `<input id="pin" type="password" readonly>
      <fieldset disabled><legend><button type="button" id="one">1</button></legend>
      <button type="button" id="two">2</button><input type="button" id="three" value="3">
      <span id="four" role="button" onclick="">4</span></fieldset>`;
    const key = (id: string) => document.querySelector<HTMLElement>(`#${id}`)!;
    expect(["one", "two", "three", "four"].map((id) => pressable(key(id)))).toEqual([
      true,
      false,
      false,
      // A script key has no native disabled state.
      true,
    ]);
    document.querySelector("fieldset")!.disabled = false;
    expect(["one", "two", "three"].every((id) => pressable(key(id)))).toBe(true);
  });

  it("takes no keypad characters into a field in a disabled fieldset, apart from its first legend's", () => {
    document.body.innerHTML = `<fieldset disabled>
      <legend><input id="legend" type="password" readonly></legend>
      <input id="body" type="password" readonly></fieldset>`;
    const field = (id: string) => document.querySelector<HTMLInputElement>(`#${id}`)!;
    expect(keypadInput(field("legend"))).toBe(true);
    expect(keypadInput(field("body"))).toBe(false);
  });

  it("finds no identifier input in a disabled fieldset, apart from its first legend's", () => {
    document.body.innerHTML = `<fieldset disabled><input type="email" name="email"></fieldset>`;
    expect(identifierInput(document)).toBeUndefined();
    document.body.innerHTML = `<fieldset disabled><legend><input type="email" name="email">
      </legend></fieldset>`;
    expect(identifierInput(document)).toBe("sole");
  });

  it("observes fields in a disabled fieldset as unfillable, apart from its first legend's", () => {
    const form = (fields: string) => `<form id="f">${fields}<button id="go">Log in</button></form>`;
    const fields = '<input id="u" autocomplete="username"><input id="p" type="password">';
    document.body.innerHTML = form(`<fieldset disabled>${fields}</fieldset>`);
    const disabled = extractLoginObservation();
    expect(disabled.ok && [disabled.observation.complete, disabled.gap]).toEqual([
      false,
      "unfillable-field",
    ]);
    document.body.innerHTML = form(`<fieldset disabled><legend>${fields}</legend></fieldset>`);
    const legend = extractLoginObservation();
    expect(legend.ok && legend.observation.complete).toBe(true);
    expect(
      legend.ok && legend.observation.candidates.map((candidate) => candidate.target.value),
    ).toEqual(["u", "p", "go"]);
  });
});
