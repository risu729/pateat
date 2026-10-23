import { afterEach, describe, expect, it } from "vitest";
import {
  besideKeypad,
  findKeypad,
  keyLabel,
  keypadCovers,
  keypadField,
  keypadKeys,
  keysFor,
} from "./keypad";
import { typeOnKeypad } from "./keypad-typing";

afterEach(() => {
  document.body.innerHTML = "";
});

const digits = [..."0123456789"];
/** A keypad of `<button>` keys showing `characters`, in that order, inside `#pad`. */
const pad = (characters: readonly string[], attributes = "") =>
  `<div id="pad" ${attributes}>${characters.map((character) => `<button type="button" class="key">${character}</button>`).join("")}</div>`;

/**
 * A page whose read-only input takes characters only from `#pad`: each press of a key
 * that came with `pointerdown` adds a mask character, and the keys are shuffled after
 * each press. `open` keeps the keypad hidden until the input is clicked.
 */
function keypadPage({
  characters = digits,
  open = true,
  mask = true,
  perPress = 1,
}: { characters?: readonly string[]; open?: boolean; mask?: boolean; perPress?: number } = {}) {
  document.body.innerHTML = `<form><input id="pin" type="password" readonly>${pad(characters, open ? "" : "hidden")}</form>`;
  const input = document.querySelector<HTMLInputElement>("#pin")!;
  const keypad = document.querySelector<HTMLElement>("#pad")!;
  const typed: string[] = [];
  let armed: Element | null = null;
  input.addEventListener("click", () => {
    keypad.hidden = false;
  });
  keypad.addEventListener("pointerdown", (event) => {
    armed = (event.target as Element).closest(".key");
  });
  keypad.addEventListener("click", (event) => {
    const key = (event.target as Element).closest(".key");
    if (!key || key !== armed) return;
    armed = null;
    typed.push(key.textContent!);
    if (mask) input.value = "*".repeat(typed.length * perPress);
    // Shuffle by rotating the keys, so each character moves to another key.
    keypad.append(keypad.firstElementChild!);
  });
  return { input, keypad, typed };
}

describe("keyLabel", () => {
  it("reads one character from a key's text, value, aria-label or image alt, folding full-width forms", () => {
    document.body.innerHTML = `
      <button id="text"> 7 </button>
      <input id="value" type="button" value="Ｆ">
      <input id="image" type="image" alt="3">
      <a id="link" href="#">a</a>
      <span id="cell" onclick="void 0">９</span>
      <button id="aria" aria-label="5"><span aria-hidden="true"></span></button>
      <button id="alt"><img alt="8" src="data:image/gif;base64,R0lGODlhAQABAAAAACw=" width="10" height="10"></button>`;
    const label = (id: string) => keyLabel(document.getElementById(id)!);
    expect(["text", "value", "image", "link", "cell", "aria", "alt"].map(label)).toEqual([
      "7",
      "F",
      "3",
      "a",
      "9",
      "5",
      "8",
    ]);
  });

  it("gives no character for a word, an image without alt, a field or plain text", () => {
    document.body.innerHTML = `
      <button id="word">Clear</button>
      <button id="image"><img src="data:image/gif;base64,R0lGODlhAQABAAAAACw=" width="10" height="10"></button>
      <input id="field" value="1">
      <span id="plain">1</span>
      <a id="away" href="/next">1</a>`;
    for (const id of ["word", "image", "field", "plain", "away"])
      expect(keyLabel(document.getElementById(id)!), id).toBeUndefined();
  });

  it("reads a key that is not shown yet by its text", () => {
    document.body.innerHTML = `<div hidden><button id="key">4</button></div>`;
    expect(keyLabel(document.getElementById("key")!)).toBe("4");
  });
});

describe("keypadKeys and keysFor", () => {
  it("takes the innermost of nested keys, and only keys a person can press now", () => {
    document.body.innerHTML = `<div id="pad"><span onclick="void 0"><a href="#">1</a></span><button disabled>2</button><button aria-disabled="true">3</button><button>4</button><button>4</button></div>`;
    const keypad = document.getElementById("pad")!;
    expect(keypadKeys(keypad).map((key) => key.tagName)).toEqual([
      "A",
      "BUTTON",
      "BUTTON",
      "BUTTON",
      "BUTTON",
    ]);
    expect(keysFor(keypad, "1")).toHaveLength(1);
    expect(keysFor(keypad, "2")).toEqual([]);
    expect(keysFor(keypad, "3")).toEqual([]);
    // Two keys for one character: the caller refuses it.
    expect(keysFor(keypad, "4")).toHaveLength(2);
    // Only the key's label is folded: a full-width character of the value has no key.
    expect(keysFor(keypad, "１")).toEqual([]);
    expect(keypadCovers(keypad, "1")).toBe(true);
    expect(keypadCovers(keypad, "14")).toBe(false);
  });

  it("folds a key's full-width label but never the value", () => {
    document.body.innerHTML = `<div id="pad"><input type="button" value="Ａ"><input type="button" value="１"></div>`;
    const keypad = document.getElementById("pad")!;
    expect(keysFor(keypad, "A")).toHaveLength(1);
    expect(keysFor(keypad, "1")).toHaveLength(1);
    expect(keysFor(keypad, "Ａ")).toEqual([]);
    expect(keypadCovers(keypad, "A1")).toBe(true);
    expect(keypadCovers(keypad, "Ａ1")).toBe(false);
  });
});

describe("findKeypad", () => {
  it("finds the nearest element that holds every key, hidden or shown", () => {
    document.body.innerHTML = `<main><form><input type="password" readonly>${pad(digits, "hidden")}</form></main>`;
    expect(findKeypad(document)).toBe(document.getElementById("pad"));
  });

  it("finds none with fewer than ten keys", () => {
    document.body.innerHTML = `<main>${pad(digits.slice(0, 9))}</main>`;
    expect(findKeypad(document)).toBeUndefined();
  });

  it("finds none when a key elsewhere on the page puts them all under the body", () => {
    document.body.innerHTML = `${pad(digits)}<button>?</button>`;
    expect(findKeypad(document)).toBeUndefined();
  });

  it("finds none without a key for each of the ten digits: a date picker, pages or an A-Z index", () => {
    const days = Array.from({ length: 31 }, (_, day) => String(day + 1));
    const letters = [..."ABCDEFGHIJKLMNOPQRSTUVWXYZ"];
    for (const keys of [days, letters, [...digits.slice(1), ...letters]]) {
      document.body.innerHTML = `<main>${pad(keys)}</main>`;
      expect(findKeypad(document), keys.join("")).toBeUndefined();
    }
    document.body.innerHTML = `<main>${pad([...letters, ...digits])}</main>`;
    expect(findKeypad(document)).toBe(document.getElementById("pad"));
  });
});

describe("besideKeypad and keypadField", () => {
  it("takes a keypad in the field's form or in one box with it, never one only the body holds", () => {
    document.body.innerHTML = `<main><section><form><input id="in-form" type="password" readonly>${pad(digits)}</form></section></main>`;
    const keypad = document.getElementById("pad")!;
    const field = () => document.querySelector<HTMLInputElement>("input")!;
    expect(besideKeypad(keypad, field())).toBe(true);
    document.body.innerHTML = `<main><form><input type="password" readonly></form>${pad(digits)}</main>`;
    expect(besideKeypad(document.getElementById("pad")!, field())).toBe(true);
    document.body.innerHTML = `<form><input type="password" readonly></form>${pad(digits)}`;
    expect(besideKeypad(document.getElementById("pad")!, field())).toBe(false);
  });

  it("is an empty, enabled read-only field beside the keypad only", () => {
    document.body.innerHTML = `<form><input id="pin" type="password" readonly>
      <input id="email" readonly value="me@example.com"><input id="date" type="text" readonly value="2026-10-23">
      <input id="off" type="password" readonly disabled><input id="open" type="password">${pad(digits)}</form>`;
    const keypad = findKeypad(document);
    const field = (id: string) =>
      keypadField(document.querySelector<HTMLInputElement>(`#${id}`)!, keypad);
    expect(["pin", "email", "date", "off", "open"].map(field)).toEqual([
      true,
      false,
      false,
      false,
      false,
    ]);
    expect(keypadField(document.querySelector<HTMLInputElement>("#pin")!, undefined)).toBe(false);
  });
});

describe("typeOnKeypad", () => {
  it("opens the keypad by pressing the field and presses one key per character as the keys move", async () => {
    const { input, typed } = keypadPage({ open: false });
    const keypad = document.getElementById("pad")!;
    await expect(typeOnKeypad(input, "4071", keypad)).resolves.toBeUndefined();
    expect(typed).toEqual(["4", "0", "7", "1"]);
    expect(input.value).toBe("****");
  });

  it("presses nothing for a full-width character of the value, though the keys show full-width labels", async () => {
    const { input, typed } = keypadPage({ characters: [..."０１２３４５６７８９"] });
    const keypad = document.getElementById("pad")!;
    await expect(typeOnKeypad(input, "1２", keypad)).resolves.toBe("key-missing");
    expect(typed).toEqual([]);
    await expect(typeOnKeypad(input, "12", keypad)).resolves.toBeUndefined();
    expect(typed).toEqual(["１", "２"]);
  });

  it("presses nothing when a character has no key, or the field already holds characters", async () => {
    const { input, typed } = keypadPage({ characters: digits.slice(1) });
    const keypad = document.getElementById("pad")!;
    await expect(typeOnKeypad(input, "120", keypad)).resolves.toBe("key-missing");
    expect(typed).toEqual([]);
    input.value = "*";
    await expect(typeOnKeypad(input, "12", keypad)).resolves.toBe("refused");
    expect(typed).toEqual([]);
  });

  it("presses nothing when two keys type one character", async () => {
    const { input, typed } = keypadPage({ characters: [...digits, "1"] });
    await expect(typeOnKeypad(input, "1", document.getElementById("pad")!)).resolves.toBe(
      "key-missing",
    );
    expect(typed).toEqual([]);
  });

  it("stops after the first press when the field does not show the character", async () => {
    const { input, typed } = keypadPage({ mask: false });
    await expect(typeOnKeypad(input, "123", document.getElementById("pad")!)).resolves.toBe(
      "refused",
    );
    expect(typed).toEqual(["1"]);
  });

  it("stops after the first press when the field grows by more than one character", async () => {
    const { input, typed } = keypadPage({ perPress: 2 });
    await expect(typeOnKeypad(input, "123", document.getElementById("pad")!)).resolves.toBe(
      "refused",
    );
    expect(typed).toEqual(["1"]);
  });

  it("never clicks a key the page relabels as it is pressed", async () => {
    const { input, keypad, typed } = keypadPage();
    // On `mousedown`, the key for 1 shows 9 instead and 9's key shows 1.
    keypad.addEventListener("mousedown", (event) => {
      const key = (event.target as Element).closest(".key");
      if (key?.textContent !== "1") return;
      const other = [...keypad.querySelectorAll(".key")].find((each) => each.textContent === "9")!;
      key.textContent = "9";
      other.textContent = "1";
    });
    let presses = 0;
    await expect(
      typeOnKeypad(input, "12", keypad, {
        onPress: () => {
          presses += 1;
        },
      }),
    ).resolves.toBe("refused");
    expect(typed).toEqual([]);
    expect(input.value).toBe("");
    // The press reached `pointerdown`, so the caller counts it as one that may have typed.
    expect(presses).toBe(1);
  });

  it("stops when a keypad never opens", async () => {
    document.body.innerHTML = `<input id="pin" type="password" readonly>${pad(digits, "hidden")}`;
    const input = document.querySelector<HTMLInputElement>("#pin")!;
    await expect(
      typeOnKeypad(input, "1", document.getElementById("pad")!, { openMs: 100 }),
    ).resolves.toBe("keypad-closed");
  });

  it("stops with the caller's cause between presses, and reports each press made", async () => {
    const { input, typed } = keypadPage();
    let presses = 0;
    const stopped = await typeOnKeypad(input, "123", document.getElementById("pad")!, {
      between: () => (typed.length === 1 ? "page-changed" : undefined),
      onPress: () => {
        presses += 1;
      },
    });
    expect(stopped).toBe("page-changed");
    expect(typed).toEqual(["1"]);
    expect(presses).toBe(1);
  });
});
