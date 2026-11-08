import { afterEach, describe, expect, it } from "vitest";
import { typeValue } from "./enter-value";

const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;

afterEach(() => {
  document.body.innerHTML = "";
});

function field(attributes = ""): HTMLInputElement {
  document.body.innerHTML = `<input ${attributes}>`;
  return document.querySelector("input")!;
}

/** A page whose handler for `event` replaces the whole typed value with `held`. */
function rewriteOn(event: "input" | "change" | "blur", typed: string, held: string) {
  const input = field();
  input.addEventListener(event, () => {
    if (input.value === typed) input.value = held;
  });
  return input;
}

/** Every kind of rewrite after typing, and one of each outcome after `change` and blur. */
const refusedRewrites = [
  ["input", "1234", "1235"],
  ["input", "1234", "1243"],
  ["input", "pass", "past"],
  ["input", "abcd", "abdc"],
  ["change", "1234", "1235"],
  ["blur", "1234", "4321"],
] as const;

const keptRewrites = [
  ["input", "pa55", "••••"],
  ["input", "pa55", "****"],
  ["input", "1234", "＊＊＊4"],
  ["input", "1234", "・・●∙"],
  ["input", "ab1", "AB1"],
  ["input", "AbC", "abc"],
  ["input", "ab1", "ＡＢ１"],
  ["input", "ａｂ", "AB"],
  ["input", "card", "c••D"],
  ["change", "ab1", "AB1"],
  ["blur", "pa55", "••••"],
] as const;

describe("typing into a page that rewrites the value at the same length", () => {
  it.each(refusedRewrites)("refuses a %s rewrite of %j into %j", async (event, typed, held) => {
    const input = rewriteOn(event, typed, held);
    expect(await typeValue(input, typed, setter)).toBe("refused");
    expect(input.value).toBe(held);
  });

  it.each(keptRewrites)("keeps a %s rewrite of %j into %j", async (event, typed, held) => {
    const input = rewriteOn(event, typed, held);
    expect(await typeValue(input, typed, setter)).toBeUndefined();
    expect(input.value).toBe(held);
  });

  it("refuses a rewrite the width fold does not cover, such as hiragana into katakana", async () => {
    const input = rewriteOn("input", "あい", "アイ");
    expect(await typeValue(input, "あい", setter)).toBe("refused");
  });

  it("refuses a same-length mask the page writes for a key it cancelled", async () => {
    // A cancelled key leaves only the width rule: the page could have written any character.
    const input = field();
    input.addEventListener("keydown", (event) => {
      if (event.key.length !== 1) return;
      event.preventDefault();
      input.value += "•";
    });
    expect(await typeValue(input, "1234", setter)).toBe("refused");
    expect(input.value).toBe("••••");
  });

  it("refuses a substitution the page writes for a key it cancelled", async () => {
    const input = field();
    input.addEventListener("keydown", (event) => {
      if (event.key !== "4") return;
      event.preventDefault();
      input.value += "5";
    });
    expect(await typeValue(input, "1234", setter)).toBe("refused");
    expect(input.value).toBe("1235");
  });

  it("keeps a same-length mask within `maxlength` and refuses one beyond it", async () => {
    const fits = field('maxlength="4"');
    fits.addEventListener("input", () => (fits.value = "•".repeat(fits.value.length)));
    expect(await typeValue(fits, "1234", setter)).toBeUndefined();
    expect(fits.value).toBe("••••");
    // Typing sets the value past `maxlength`, as a person's keyboard could not.
    const over = field('maxlength="3"');
    over.addEventListener("input", () => (over.value = "•".repeat(over.value.length)));
    expect(await typeValue(over, "1234", setter)).toBe("refused");
    expect(over.value).toBe("••••");
  });
});
