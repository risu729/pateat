import { afterEach, describe, expect, it } from "vitest";
import { chooseFor, choosingRadio } from "./choice-radio";

afterEach(() => {
  document.body.innerHTML = "";
});

const input = (id: string) => document.querySelector<HTMLInputElement>(`#${id}`)!;

/**
 * A synthetic copy of the MUFG lightbox's shape (ADR 0061): hidden copies of the ID and
 * password, then one radio before each detail input.
 */
const choicePage = `<form id="extra">
  <dl style="display:none"><input id="id-copy" name="webId"></dl>
  <dl style="display:none"><input id="password-copy" type="password" name="webPassword"></dl>
  <label><input type="radio" id="by-birth" name="authType" value="2"> Birth year and month</label>
  <input id="birth" name="birth" maxlength="6">
  <label><input type="radio" id="by-phone" name="authType" value="3"> Last 4 digits of phone</label>
  <input id="phone" name="phone" maxlength="4">
  <input id="submit" type="submit" value="Log in">
</form>`;

describe("the radio button that chooses an input (ADR 0061)", () => {
  it("is the radio of a group right before each input", () => {
    document.body.innerHTML = choicePage;
    expect(choosingRadio(input("birth"))).toBe(input("by-birth"));
    expect(choosingRadio(input("phone"))).toBe(input("by-phone"));
    // The inputs before the radios have none.
    expect(choosingRadio(input("id-copy"))).toBeUndefined();
    expect(choosingRadio(input("password-copy"))).toBeUndefined();
  });

  it("is none when the radios all come before their inputs", () => {
    document.body.innerHTML = `<form>
      <input type="radio" name="authType" value="2"> <input type="radio" name="authType" value="3">
      <input id="birth"> <input id="phone">
    </form>`;
    expect(choosingRadio(input("birth"))).toBeUndefined();
    expect(choosingRadio(input("phone"))).toBeUndefined();
  });

  it("is none for a radio alone in its group", () => {
    document.body.innerHTML = `<form><input type="radio" name="authType"> <input id="birth"></form>`;
    expect(choosingRadio(input("birth"))).toBeUndefined();
  });

  it("is none for a radio without a name", () => {
    document.body.innerHTML = `<form>
      <input type="radio" id="first"> <input id="birth">
      <input type="radio" id="second"> <input id="phone">
    </form>`;
    expect(choosingRadio(input("birth"))).toBeUndefined();
    expect(choosingRadio(input("phone"))).toBeUndefined();
  });

  it("counts only radios of the input's form in the group", () => {
    document.body.innerHTML = `<form><input type="radio" id="by-birth" name="authType">
      <input id="birth"></form>
      <form><input type="radio" name="authType"> <input id="phone"></form>`;
    expect(choosingRadio(input("birth"))).toBeUndefined();
    expect(choosingRadio(input("phone"))).toBeUndefined();
  });

  it("counts a radio tied to the input's form by its form attribute", () => {
    document.body.innerHTML = `<form id="extra"><input type="radio" id="by-birth" name="authType">
      <input id="birth"></form>
      <input type="radio" name="authType" form="extra">`;
    expect(choosingRadio(input("birth"))).toBe(input("by-birth"));
  });

  it("chooses inputs outside every form by the radios outside every form", () => {
    document.body.innerHTML = `<div>
      <input type="radio" id="by-birth" name="authType"> <input id="birth">
      <input type="radio" id="by-phone" name="authType"> <input id="phone">
    </div>
    <form><input type="radio" name="other"> <input type="radio" name="other"></form>`;
    expect(choosingRadio(input("birth"))).toBe(input("by-birth"));
    expect(choosingRadio(input("phone"))).toBe(input("by-phone"));
  });

  it.each([
    ["a text input", `<input id="between">`],
    ["a password input", `<input id="between" type="password">`],
    ["a number input", `<input id="between" type="number">`],
    ["a textarea", `<textarea id="between"></textarea>`],
  ])("is none with %s between the radio and the input", (_label, between) => {
    document.body.innerHTML = `<form>
      <input type="radio" name="authType"> ${between} <input id="birth">
      <input type="radio" name="authType"> <input id="phone">
    </form>`;
    expect(choosingRadio(input("birth"))).toBeUndefined();
    // The next radio still chooses the input right after it.
    expect(choosingRadio(input("phone"))).toBeInstanceOf(HTMLInputElement);
  });

  it("is none with another radio between the radio and the input", () => {
    document.body.innerHTML = `<form>
      <input type="radio" name="authType"> <input type="radio" name="other">
      <input id="birth"> <input type="radio" name="authType"> <input type="radio" name="other">
    </form>`;
    expect(choosingRadio(input("birth"))).toBeUndefined();
  });

  it.each([
    ["a hidden input", `<input type="hidden" name="token" value="synthetic">`],
    ["a checkbox", `<input type="checkbox" name="remember">`],
    ["a button", `<input type="button" value="Help">`],
  ])("keeps the radio with %s between it and the input", (_label, between) => {
    document.body.innerHTML = `<form>
      <input type="radio" id="by-birth" name="authType"> ${between} <input id="birth">
      <input type="radio" name="authType"> <input id="phone">
    </form>`;
    expect(choosingRadio(input("birth"))).toBe(input("by-birth"));
  });
});

describe("checking an input's radio before its fill (ADR 0061)", () => {
  it("clicks an unchecked radio, so the page's own handlers run", () => {
    document.body.innerHTML = choicePage;
    const clicked: string[] = [];
    const changed: string[] = [];
    for (const id of ["by-birth", "by-phone"]) {
      input(id).addEventListener("click", () => clicked.push(id));
      input(id).addEventListener("change", () => changed.push(id));
    }
    input("by-birth").checked = true;
    expect(chooseFor(input("phone"))).toBe(true);
    expect(input("by-phone").checked).toBe(true);
    expect(input("by-birth").checked).toBe(false);
    expect(clicked).toEqual(["by-phone"]);
    expect(changed).toEqual(["by-phone"]);
  });

  it("leaves a checked radio as it is", () => {
    document.body.innerHTML = choicePage;
    input("by-birth").checked = true;
    let clicks = 0;
    input("by-birth").addEventListener("click", () => (clicks += 1));
    expect(chooseFor(input("birth"))).toBe(true);
    expect(clicks).toBe(0);
    expect(input("by-birth").checked).toBe(true);
  });

  it("fills an input without a radio as it is", () => {
    document.body.innerHTML = `<form><input id="birth"></form>`;
    expect(chooseFor(input("birth"))).toBe(true);
  });

  it("refuses an input whose radio is disabled, clicking nothing", () => {
    document.body.innerHTML = choicePage;
    input("by-phone").disabled = true;
    let clicks = 0;
    input("by-phone").addEventListener("click", () => (clicks += 1));
    expect(chooseFor(input("phone"))).toBe(false);
    expect(clicks).toBe(0);
    expect(input("by-phone").checked).toBe(false);
  });

  it("refuses an input whose radio the page keeps unchecked", () => {
    document.body.innerHTML = choicePage;
    input("by-phone").addEventListener("click", (event) => event.preventDefault());
    expect(chooseFor(input("phone"))).toBe(false);
    expect(input("by-phone").checked).toBe(false);
  });
});
