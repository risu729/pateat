import { afterEach, describe, expect, it } from "vitest";
import { userEvent } from "vitest/browser";
import {
  recordSiteValues,
  sameAccountValue,
  siteValue,
  siteValueChoice,
  stopSiteValues,
} from "./site-values";

const key = Symbol.for("pateat.siteValues");

afterEach(() => {
  stopSiteValues(window);
  delete (window as unknown as Record<symbol, unknown>)[key];
  document.body.innerHTML = "";
});

/** Lets the observer see the changes made so far. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

const add = (html: string) => {
  const holder = document.createElement("div");
  holder.innerHTML = html;
  document.body.append(holder);
  return holder.querySelector("input")!;
};

describe("siteValue", () => {
  it("reads the value an input held when the page inserted it", async () => {
    recordSiteValues(document, window);
    const input = add('<input type="email" value="a@example.com">');
    await settle();
    expect(siteValue(window, input)).toBe("a@example.com");
  });

  it("reads a value the page set after inserting the input, before anyone typed", () => {
    recordSiteValues(document, window);
    const input = add('<input type="email">');
    input.setAttribute("value", "a@example.com");
    // Pending changes are taken when asked.
    expect(siteValue(window, input)).toBe("a@example.com");
  });

  it("reads nothing for an input that existed before the recording started", () => {
    const input = add('<input type="email" value="a@example.com">');
    recordSiteValues(document, window);
    expect(siteValue(window, input)).toBeUndefined();
  });

  it("reads nothing without a recording, as after an extension reload", () => {
    const input = add('<input type="email" value="a@example.com">');
    expect(siteValue(window, input)).toBeUndefined();
  });

  it("reads nothing once the input holds something else", async () => {
    recordSiteValues(document, window);
    const input = add('<input type="email" value="a@example.com">');
    await settle();
    input.value = "b@example.com";
    expect(siteValue(window, input)).toBeUndefined();
  });

  it("records nothing after the person's first input, even an attribute a framework copies", async () => {
    recordSiteValues(document, window);
    const typed = add('<input type="text">');
    await settle();
    await userEvent.type(typed, "b");
    // A framework mounts a new input holding the typed text, or copies it to the attribute.
    const mounted = add('<input type="email" value="b@example.com">');
    typed.setAttribute("value", "b");
    await settle();
    expect(siteValue(window, mounted)).toBeUndefined();
    expect(siteValue(window, typed)).toBeUndefined();
  });

  it("keeps what was recorded before the person's first input", async () => {
    recordSiteValues(document, window);
    const input = add('<input type="email" value="a@example.com">');
    const other = add('<input type="text">');
    await settle();
    await userEvent.type(other, "x");
    expect(siteValue(window, input)).toBe("a@example.com");
  });

  it("records nothing after Pateat starts acting on the page", async () => {
    recordSiteValues(document, window);
    stopSiteValues(window);
    const input = add('<input type="email" value="a@example.com">');
    await settle();
    expect(siteValue(window, input)).toBeUndefined();
  });

  it("ignores inputs that are not account inputs, and an empty value", async () => {
    recordSiteValues(document, window);
    const password = add('<input type="password" value="secret">');
    const empty = add('<input type="email" value="">');
    await settle();
    expect(siteValue(window, password)).toBeUndefined();
    expect(siteValue(window, empty)).toBeUndefined();
  });
});

describe("siteValueChoice", () => {
  it("names the one username equal to the page's value, ignoring ASCII case", async () => {
    recordSiteValues(document, window);
    const input = add('<input type="email" value="B@Example.com">');
    await settle();
    expect(siteValueChoice(window, [input], ["a@example.com", "b@example.com"])).toBe(1);
  });

  it("names none for a value equal to no username or to several", async () => {
    recordSiteValues(document, window);
    const input = add('<input type="email" value="c@example.com">');
    await settle();
    expect(siteValueChoice(window, [input], ["a@example.com", "b@example.com"])).toBeUndefined();
    expect(siteValueChoice(window, [input], ["c@example.com", "C@example.com"])).toBeUndefined();
  });

  it("names none when an input holds no recorded value or the inputs differ", async () => {
    recordSiteValues(document, window);
    const first = add('<input type="email" value="a@example.com">');
    const second = add('<input type="email" value="b@example.com">');
    const blank = add('<input type="email">');
    await settle();
    const usernames = ["a@example.com", "b@example.com"];
    expect(siteValueChoice(window, [first, second], usernames)).toBeUndefined();
    expect(siteValueChoice(window, [first, blank], usernames)).toBeUndefined();
  });
});

describe("sameAccountValue", () => {
  it("compares ASCII letters without case and trims nothing", () => {
    expect(sameAccountValue("A@example.com", "a@EXAMPLE.com")).toBe(true);
    expect(sameAccountValue(" a@example.com", "a@example.com")).toBe(false);
    expect(sameAccountValue("İ@example.com", "i@example.com")).toBe(false);
  });
});
