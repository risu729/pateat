import { afterEach, describe, expect, it } from "vitest";
import { typeValue } from "./enter-value";

const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;

afterEach(() => {
  document.body.innerHTML = "";
});

function field(): HTMLInputElement {
  const input = document.createElement("input");
  document.body.append(input);
  return input;
}

function group(value: string, separator: string): string {
  return value.replace(/[- ]/gu, "").replace(/(.{4})(?=.)/gu, "$1" + separator);
}

function rewriteLastInput(input: HTMLInputElement, typed: string, held: string): void {
  input.addEventListener("input", () => {
    if (input.value === typed) input.value = held;
  });
}

describe("typing into page-formatted values", () => {
  it.each([" ", "-"])(
    "keeps an input formatter that groups every four digits with %j",
    async (separator) => {
      const input = field();
      const ended: string[] = [];
      input.addEventListener("input", () => (input.value = group(input.value, separator)));
      for (const event of ["change", "blur"])
        input.addEventListener(event, () => ended.push(event));
      expect(await typeValue(input, "123456789012", setter)).toBeUndefined();
      expect(input.value).toBe("1234" + separator + "5678" + separator + "9012");
      expect(ended).toEqual(["change", "blur"]);
      expect(document.activeElement).toBe(document.body);
    },
  );

  it.each([
    ["change", " "],
    ["change", "-"],
    ["blur", " "],
    ["blur", "-"],
  ] as const)("keeps permitted formatting on %s with %j", async (event, separator) => {
    const input = field();
    input.addEventListener(event, () => (input.value = group(input.value, separator)));
    expect(await typeValue(input, "12345678", setter)).toBeUndefined();
    expect(input.value).toBe("1234" + separator + "5678");
  });

  it.each([" ", "-"])(
    "keeps a formatter that writes cancelled keys with %j separators",
    async (separator) => {
      const input = field();
      input.addEventListener("keydown", (event) => {
        if (event.key.length !== 1) return;
        event.preventDefault();
        input.value = group(input.value + event.key, separator);
      });
      expect(await typeValue(input, "12345678", setter)).toBeUndefined();
      expect(input.value).toBe("1234" + separator + "5678");
    },
  );

  it.each(["/", ".", "(", "\t", "\u00a0", "\u2010", "\u2013", "\u2212", "\uff0d", "\u3000"])(
    "refuses an inserted character outside ASCII space/hyphen: %j",
    async (separator) => {
      const input = field();
      const held = "1234" + separator + "5678";
      const ended: string[] = [];
      rewriteLastInput(input, "12345678", held);
      for (const event of ["change", "blur"])
        input.addEventListener(event, () => ended.push(event));
      expect(await typeValue(input, "12345678", setter)).toBe("refused");
      expect(input.value).toBe(held);
      expect(ended).toEqual([]);
    },
  );

  it.each(["change", "blur"])("refuses a slash inserted on %s", async (event) => {
    const input = field();
    input.addEventListener(event, () => (input.value = "1234/5678"));
    expect(await typeValue(input, "12345678", setter)).toBe("refused");
    expect(input.value).toBe("1234/5678");
  });

  it.each([
    ["12345678", "1234567"],
    ["12345678", "1234--567"],
    ["12345678", "9234 5678"],
    ["12345678", "5678-1234"],
    ["12-34", "1234"],
    ["12 34", "1234"],
    ["12-34", "12 34-"],
    ["12 34", "12-34 "],
  ] as const)(
    "refuses dropped, changed or moved original characters: %j to %j",
    async (typed, held) => {
      const input = field();
      rewriteLastInput(input, typed, held);
      expect(await typeValue(input, typed, setter)).toBe("refused");
      expect(input.value).toBe(held);
    },
  );

  it.each([
    ["12345678", " 12345678"],
    ["12345678", "-12345678"],
    ["12345678", "12345678 "],
    ["12345678", "12345678----"],
  ] as const)("refuses a separator before or after the value: %j to %j", async (typed, held) => {
    const input = field();
    rewriteLastInput(input, typed, held);
    expect(await typeValue(input, typed, setter)).toBe("refused");
    expect(input.value).toBe(held);
  });

  it("refuses a hyphen a page inserts into a number input", async () => {
    const input = field();
    input.type = "number";
    rewriteLastInput(input, "1e5", "1e-5");
    expect(await typeValue(input, "1e5", setter)).toBe("refused");
    expect(input.value).toBe("1e-5");
  });

  it.each([
    ["1234-5678", "1234- 5678"],
    ["1234 5678", "1234 -5678"],
  ] as const)(
    "preserves original separators while permitting additional ones: %j to %j",
    async (typed, held) => {
      const input = field();
      rewriteLastInput(input, typed, held);
      expect(await typeValue(input, typed, setter)).toBeUndefined();
      expect(input.value).toBe(held);
    },
  );

  it.each([
    ["a-", "a--"],
    ["a ", "a  "],
    ["a-", "a- -"],
    ["-a", "--a"],
  ] as const)(
    "keeps a separator inserted beside the value's own first or last separator: %j to %j",
    async (typed, held) => {
      const input = field();
      rewriteLastInput(input, typed, held);
      expect(await typeValue(input, typed, setter)).toBeUndefined();
      expect(input.value).toBe(held);
    },
  );

  it("refuses a separator that splits a character outside the BMP", async () => {
    const input = field();
    const held = "abc\uD83D \uDE00def";
    rewriteLastInput(input, "abc😀def", held);
    expect(await typeValue(input, "abc😀def", setter)).toBe("refused");
    expect(input.value).toBe(held);
  });

  it.each([
    ["input", 8, "refused"],
    ["change", 8, "refused"],
    ["blur", 8, "refused"],
    ["input", 9, undefined],
    ["change", 9, undefined],
    ["blur", 9, undefined],
  ] as const)("checks the held maxlength after %s (limit %i)", async (event, maxLength, result) => {
    const input = field();
    input.maxLength = maxLength;
    if (event === "input") rewriteLastInput(input, "12345678", "1234 5678");
    else input.addEventListener(event, () => (input.value = "1234 5678"));
    expect(await typeValue(input, "12345678", setter)).toBe(result);
    expect(input.value).toBe("1234 5678");
  });
});
