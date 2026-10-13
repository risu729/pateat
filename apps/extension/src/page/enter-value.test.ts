import { createElement, useState } from "react";
import { createRoot } from "react-dom/client";
import { flushSync } from "react-dom";
import { afterEach, describe, expect, it } from "vitest";
import { FIELD_GAP_MS, typeValue } from "./enter-value";

const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
const pause = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
const cleanups: (() => void)[] = [];

afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
  document.body.innerHTML = "";
});

/** Fills the inputs in order, as a preparing fill step does. */
async function fill(entries: readonly [HTMLInputElement, string][]): Promise<void> {
  for (const [index, [input, value]] of entries.entries()) {
    // eslint-disable-next-line no-await-in-loop
    if (index > 0) await pause(FIELD_GAP_MS);
    // eslint-disable-next-line no-await-in-loop
    await typeValue(input, value, setter);
  }
}

/**
 * A synthetic bank-style form: branch and account number inputs whose script records a
 * field as entered only on one kind of signal, and on Next shows "required" under each
 * field it never saw entered (as a page did after a fill on 2026-10-13).
 */
function requiredForm(entered: "keyup" | "blur" | "hidden"): {
  branch: HTMLInputElement;
  account: HTMLInputElement;
  next: () => string[];
} {
  document.body.innerHTML = `<form>
    <input id="branch" inputmode="numeric"><p id="branch-error"></p>
    <input id="account" inputmode="numeric"><p id="account-error"></p>
    <input type="hidden" id="branch-copy"><input type="hidden" id="account-copy">
  </form>`;
  const seen = new Map<string, string>();
  for (const id of ["branch", "account"]) {
    const field = document.getElementById(id) as HTMLInputElement;
    const copy = document.getElementById(`${id}-copy`) as HTMLInputElement;
    if (entered === "keyup") field.addEventListener("keyup", () => seen.set(id, field.value));
    if (entered === "blur") field.addEventListener("blur", () => seen.set(id, field.value));
    if (entered === "hidden") field.addEventListener("blur", () => (copy.value = field.value));
  }
  return {
    branch: document.getElementById("branch") as HTMLInputElement,
    account: document.getElementById("account") as HTMLInputElement,
    next: () =>
      ["branch", "account"].flatMap((id) => {
        const value =
          entered === "hidden"
            ? (document.getElementById(`${id}-copy`) as HTMLInputElement).value
            : seen.get(id);
        const error = document.getElementById(`${id}-error`)!;
        error.textContent = value ? "" : "必須項目です。";
        return error.textContent ? [id] : [];
      }),
  };
}

describe("typeValue", () => {
  for (const [entered, reads] of [
    ["keyup", "on a key"],
    ["blur", "on its blur"],
    ["hidden", "from a hidden copy made on its blur"],
  ] as const) {
    it(`leaves no required-field error on a page that reads a field ${reads}`, async () => {
      const page = requiredForm(entered);
      await fill([
        [page.branch, "007"],
        [page.account, "00001234"],
      ]);
      expect(page.branch.value).toBe("007");
      expect(page.account.value).toBe("00001234");
      expect(page.next()).toEqual([]);
    });
  }

  it("sends the events in the order typing does, and blurs the field afterwards", async () => {
    document.body.innerHTML = '<input id="before"><input id="field">';
    const before = document.getElementById("before") as HTMLInputElement;
    const field = document.getElementById("field") as HTMLInputElement;
    before.focus();
    const events: string[] = [];
    before.addEventListener("blur", () => events.push("before:blur"));
    for (const type of ["focus", "keydown", "keypress", "beforeinput", "input", "keyup"])
      field.addEventListener(type, (event) => {
        events.push(
          event instanceof InputEvent
            ? `${type}:${event.inputType}:${String(event.data)}:${field.value}`
            : event instanceof KeyboardEvent
              ? `${type}:${event.key}:${event.code}`
              : `${type}:${field.value}`,
        );
      });
    for (const type of ["change", "blur"])
      field.addEventListener(type, () => events.push(`${type}:${field.value}`));
    let typed = "";
    await typeValue(field, "a1", setter, {
      beforeInput: () => {
        typed = field.value;
        events.push("typed");
      },
    });
    expect(events).toEqual([
      "before:blur",
      "focus:",
      "keydown:a:KeyA",
      "keypress:a:KeyA",
      "beforeinput:insertText:a:",
      "input:insertText:a:a",
      "keyup:a:KeyA",
      "keydown:1:Digit1",
      "keypress:1:Digit1",
      "beforeinput:insertText:1:a",
      "typed",
      "input:insertText:1:a1",
      "keyup:1:Digit1",
      "change:a1",
      "blur:a1",
    ]);
    expect(typed).toBe("a1");
    expect(document.activeElement).toBe(document.body);
  });

  it("types into a page that builds the value from its keys and resets it on blur", async () => {
    // A field whose script keeps its own copy from key events, as a bank's password field
    // did on 2026-10-13, clearing the field on blur when the copy differs.
    document.body.innerHTML = '<input id="field" type="password">';
    const field = document.getElementById("field") as HTMLInputElement;
    let keys = "";
    field.addEventListener("keydown", (event) => {
      if (event.key.length === 1) keys += event.key;
    });
    field.addEventListener("blur", () => {
      if (field.value !== keys) field.value = "";
    });
    await typeValue(field, "pa55-word", setter);
    expect(field.value).toBe("pa55-word");
  });

  it("keeps out a character whose key the page cancels, and then refuses the value", async () => {
    document.body.innerHTML = '<input id="field" inputmode="numeric">';
    const field = document.getElementById("field") as HTMLInputElement;
    let changes = 0;
    field.addEventListener("change", () => changes++);
    field.addEventListener("keydown", (event) => {
      if (!/^\d$/u.test(event.key)) event.preventDefault();
    });
    field.addEventListener("beforeinput", (event) => {
      if (event.data === "3") event.preventDefault();
    });
    expect(await typeValue(field, "12-34", setter)).toBe("refused");
    expect(field.value).toBe("124");
    expect(changes).toBe(0);
    // A cancelled clear keeps the old text, so the value is refused as well.
    document.body.innerHTML = '<input id="kept" value="old">';
    const kept = document.getElementById("kept") as HTMLInputElement;
    kept.addEventListener("beforeinput", (event) => {
      if ((event as InputEvent).inputType === "deleteContentBackward") event.preventDefault();
    });
    expect(await typeValue(kept, "new", setter)).toBe("refused");
    expect(kept.value).toBe("old");
  });

  it("refuses no value a page writes itself once its handlers' microtasks run", async () => {
    // A React input that cancels the key and sets its state writes the field in a
    // microtask, after the key's events returned.
    document.body.innerHTML = '<input id="field" value="old">';
    const field = document.getElementById("field") as HTMLInputElement;
    field.addEventListener("beforeinput", (event) => {
      if ((event as InputEvent).inputType === "deleteContentBackward") {
        event.preventDefault();
        queueMicrotask(() => (field.value = ""));
      }
    });
    field.addEventListener("keydown", (event) => {
      if (event.key.length !== 1) return;
      event.preventDefault();
      queueMicrotask(() => (field.value += event.key));
    });
    expect(await typeValue(field, "7", setter)).toBeUndefined();
    expect(field.value).toBe("7");
  });

  it("waits a task rather than a timer between characters in a hidden tab", async () => {
    Object.defineProperty(document, "hidden", { configurable: true, get: () => true });
    cleanups.push(() => Reflect.deleteProperty(document, "hidden"));
    document.body.innerHTML = '<input id="field">';
    const field = document.getElementById("field") as HTMLInputElement;
    const started = performance.now();
    expect(await typeValue(field, "abcdefgh", setter)).toBeUndefined();
    expect(field.value).toBe("abcdefgh");
    expect(performance.now() - started).toBeLessThan(FIELD_GAP_MS * 4);
  });

  it("accepts a page that types a cancelled key itself, as a masked field does", async () => {
    document.body.innerHTML = '<input id="field">';
    const field = document.getElementById("field") as HTMLInputElement;
    field.addEventListener("keydown", (event) => {
      if (event.key.length !== 1) return;
      event.preventDefault();
      field.value += event.key;
    });
    expect(await typeValue(field, "ab1", setter)).toBeUndefined();
    expect(field.value).toBe("ab1");
  });

  it("types a number input's value whole even where a prefix is not yet a number", async () => {
    document.body.innerHTML = '<input id="field" type="number" step="any">';
    const field = document.getElementById("field") as HTMLInputElement;
    expect(await typeValue(field, "-1.5", setter)).toBeUndefined();
    expect(field.value).toBe("-1.5");
  });

  it("holds Shift for the characters a US keyboard types with it", async () => {
    document.body.innerHTML = '<input id="field">';
    const field = document.getElementById("field") as HTMLInputElement;
    const keys: string[] = [];
    field.addEventListener("keydown", (event) => keys.push(`${event.key}:${event.shiftKey}`));
    await typeValue(field, "aB!", setter);
    expect(keys).toEqual(["a:false", "B:true", "!:true"]);
  });

  it("clears a field's earlier text before typing", async () => {
    document.body.innerHTML = '<input id="field" value="old">';
    const field = document.getElementById("field") as HTMLInputElement;
    const inputs: string[] = [];
    field.addEventListener("input", (event) =>
      inputs.push(`${(event as InputEvent).inputType}:${field.value}`),
    );
    await typeValue(field, "ab", setter);
    expect(inputs).toEqual(["deleteContentBackward:", "insertText:a", "insertText:ab"]);
  });

  it("stops between characters with the cause the check gives", async () => {
    document.body.innerHTML = '<input id="field">';
    const field = document.getElementById("field") as HTMLInputElement;
    let checks = 0;
    const cause = await typeValue(field, "abcd", setter, {
      between: () => (++checks === 2 ? "page-changed" : undefined),
    });
    expect(cause).toBe("page-changed");
    expect(field.value).toBe("ab");
  });

  it("leaves focus where the page moved it", async () => {
    document.body.innerHTML = '<input id="field"><button id="keypad">1</button>';
    const field = document.getElementById("field") as HTMLInputElement;
    const keypad = document.getElementById("keypad")!;
    field.addEventListener("focus", () => keypad.focus());
    await typeValue(field, "1234", setter);
    expect(field.value).toBe("1234");
    expect(document.activeElement).toBe(keypad);
  });

  it("updates a React controlled input's state", async () => {
    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);
    cleanups.push(() => root.unmount());
    // The component shows its state next to the input.
    function Field() {
      const [value, setValue] = useState("");
      return createElement(
        "div",
        null,
        createElement("input", {
          id: "react-field",
          value,
          onChange: (event: { target: HTMLInputElement }) => setValue(event.target.value),
        }),
        createElement("output", { id: "react-state" }, value),
      );
    }
    flushSync(() => root.render(createElement(Field)));
    const field = document.getElementById("react-field") as HTMLInputElement;
    await typeValue(field, "sato-7", setter);
    await pause(FIELD_GAP_MS);
    expect(document.getElementById("react-state")!.textContent).toBe("sato-7");
    expect(field.value).toBe("sato-7");
  });
});
