import { afterEach, describe, expect, it } from "vitest";
import {
  besideKeypad,
  findKeypad,
  keyLabel,
  keypadCovers,
  keypadField,
  keypadKeys,
  keypadPosition,
  keysFor,
  locateKeypad,
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

  it("finds a keyboard of every digit or of at least 26 letters, and none of fewer", () => {
    const upper = [..."ABCDEFGHIJKLMNOPQRSTUVWXYZ"];
    const kana = [..."あいうえおかきくけこさしすせそたちつてとなにぬねのはひふへほまみむめも"];
    // Letters-only keyboards count (owner's choice, 2026-10-23 13:01 UTC).
    for (const keys of [digits, upper, upper.map((letter) => letter.toLowerCase()), kana]) {
      document.body.innerHTML = `<main>${pad(keys)}</main>`;
      expect(findKeypad(document), keys.join("")).toBe(document.getElementById("pad"));
    }
    for (const keys of [digits.slice(1).concat("A"), upper.slice(0, 25), [..."ABCDEFabcdef"]]) {
      document.body.innerHTML = `<main>${pad(keys)}</main>`;
      expect(findKeypad(document), keys.join("")).toBeUndefined();
    }
  });

  it("finds no keypad in a date picker, even one with a one-character control for each digit", () => {
    const days = (from: number, to: number) =>
      Array.from({ length: to - from + 1 }, (_, day) => String(from + day));
    // A month's days 1 to 31 and its navigation as buttons, with a "0" control so that its
    // one-character controls alone would pass as a keypad: the days from 10 on give it away.
    document.body.innerHTML = `<main><form><input type="password" readonly><div id="picker"><button>‹</button><span>October 2026</span><button>›</button>
      ${["0", ...days(1, 31)].map((day) => `<button type="button">${day}</button>`).join("")}</div></form></main>`;
    expect(findKeypad(document)).toBeUndefined();
    // A calendar table whose cells run scripts.
    document.body.innerHTML = `<main><form><input type="password" readonly><table><tbody><tr>${[
      "0",
      ...days(1, 31),
    ]
      .map((day) => `<td onclick="pick()">${day}</td>`)
      .join("")}</tr></tbody></table></form></main>`;
    expect(findKeypad(document)).toBeUndefined();
    // A grid, or dates, around keys that alone would be a keypad.
    for (const wrap of [
      (keys: string) => `<div role="grid">${keys}</div>`,
      (keys: string) => `<div>${keys}<time datetime="2026-10-23">today</time></div>`,
    ]) {
      document.body.innerHTML = `<main><form><input type="password" readonly>${wrap(pad(digits))}</form></main>`;
      expect(findKeypad(document)).toBeUndefined();
    }
    // A keypad's "00" key is no day.
    document.body.innerHTML = `<main><form><input type="password" readonly>${pad([...digits, "00"])}</form></main>`;
    expect(findKeypad(document)).toBe(document.getElementById("pad"));
  });

  it("finds no keypad in pagination", () => {
    const pages = (attributes: (page: string) => string) =>
      digits.map((page) => `<a href="#" ${attributes(page)}>${page}</a>`).join("");
    for (const html of [
      // Pages in navigation.
      `<nav>${pages(() => "")}<a href="#">›</a></nav>`,
      `<div role="navigation">${pages(() => "")}</div>`,
      // The current page and next/previous links.
      `<div id="pages">${pages((page) => (page === "1" ? 'aria-current="page"' : ""))}</div>`,
      `<div id="pages"><a href="#" rel="prev">‹</a>${pages(() => "")}<a href="#" rel="next">›</a></div>`,
      // Page numbers from 10 on.
      `<div id="pages">${pages(() => "")}<a href="#">10</a><a href="#">11</a></div>`,
    ]) {
      document.body.innerHTML = `<main><form><input type="password" readonly>${html}</form></main>`;
      expect(findKeypad(document), html).toBeUndefined();
    }
  });

  it("finds no keypad in an A-Z index bar, which jumps within its page, but keeps a keypad beside one", () => {
    const upper = [..."ABCDEFGHIJKLMNOPQRSTUVWXYZ"];
    const entries = upper.map((letter) => `<h2 id="${letter}">${letter}</h2>`).join("");
    const index = `<div id="index">${upper.map((letter) => `<a href="#${letter}">${letter}</a>`).join("")}</div>`;
    document.body.innerHTML = `<main>${index}${entries}</main>`;
    expect(findKeypad(document)).toBeUndefined();
    // Named anchors are jump targets too.
    document.body.innerHTML = `<main>${index}${upper.map((letter) => `<a name="${letter}"></a>`).join("")}</main>`;
    expect(findKeypad(document)).toBeUndefined();
    // A keypad's links go nowhere, so the same letters as `href="#"` links are a keyboard.
    document.body.innerHTML = `<main><form><input type="password" readonly><ul id="keys">${upper.map((letter) => `<li><a href="#">${letter}</a></li>`).join("")}</ul></form></main>`;
    expect(findKeypad(document)).toBe(document.getElementById("keys"));
    // An index bar elsewhere on the page holds no keys, so the keypad is still found.
    document.body.innerHTML = `<main><nav>${index}</nav><form><input type="password" readonly>${pad(digits)}</form>${entries}</main>`;
    expect(findKeypad(document)).toBe(document.getElementById("pad"));
    // One inside the keypad's box makes it no keypad.
    document.body.innerHTML = `<main><form><input type="password" readonly><div id="box">${pad(digits)}${index}</div></form>${entries}</main>`;
    expect(findKeypad(document)).toBeUndefined();
  });

  it("reads a large number only from a key's own label, never from a group of keys", () => {
    // Rows of keys in `role="group"` boxes read "123", "456" and "7890" together.
    const row = (keys: string) =>
      `<div role="group">${[...keys].map((key) => `<button type="button">${key}</button>`).join("")}</div>`;
    document.body.innerHTML = `<main><form><input type="password" readonly><div id="pad">${row("123")}${row("456")}${row("7890")}</div></form></main>`;
    expect(findKeypad(document)).toBe(document.getElementById("pad"));
    // A table row of keys that runs a script.
    document.body.innerHTML = `<main><form><input type="password" readonly><table><tbody><tr onclick="void 0">${digits.map((key) => `<td><button type="button">${key}</button></td>`).join("")}</tr></tbody></table></form></main>`;
    expect(findKeypad(document)).toBe(document.querySelector("tr"));
  });

  it("leaves out one-character controls outside the field's box", () => {
    // A text-size switch in the header beside a keypad in the sign-in form.
    document.body.innerHTML = `<header><button>小</button><button>中</button><button>大</button></header>
      <main><div><form><input type="password" readonly>${pad(digits)}</form></div></main>`;
    const field = document.querySelector("input")!;
    expect(findKeypad(document, field)).toBe(document.getElementById("pad"));
    // Without the field, every key of the document counts, so the page has none.
    expect(findKeypad(document)).toBeUndefined();
    // So is a help button that only the body shares with the form.
    document.body.innerHTML = `<main><form><input type="password" readonly>${pad(digits)}</form></main><button>?</button>`;
    expect(findKeypad(document, document.querySelector("input")!)).toBe(
      document.getElementById("pad"),
    );
    expect(findKeypad(document)).toBeUndefined();
  });
});

describe("locateKeypad and keypadPosition", () => {
  it("names the keypad by its position from the field, only while that place holds the page's keypad", () => {
    document.body.innerHTML = `<main><form><div><input type="password" readonly></div><section><p>Keys</p>${pad(digits).replace(' id="pad"', ' class="pad"')}</section></form></main>`;
    const field = document.querySelector("input")!;
    const keypad = document.querySelector(".pad")!;
    const position = keypadPosition(field, keypad);
    // Up from the field's box to the form, then the section, then its second child.
    expect(position).toBe("2:1.1");
    expect(locateKeypad(document, { by: "position", value: position! }, field)).toBe(keypad);
    // Another element in that place, or none, names nothing.
    expect(locateKeypad(document, { by: "position", value: "2:1.0" }, field)).toBeUndefined();
    expect(locateKeypad(document, { by: "position", value: "2:5" }, field)).toBeUndefined();
    // Without a keypad on the page, the place names nothing either.
    keypad.querySelector("button")!.remove();
    expect(locateKeypad(document, { by: "position", value: position! }, field)).toBeUndefined();
  });

  it("reads the keys from the keypad alone, never from the rest of the element an id names", () => {
    // A wrapper with the only unique id also holds pagination, whose "3" is no key.
    const pages = digits.map((page) => `<a href="#">${page}</a>`).join("");
    document.body.innerHTML = `<div id="wrapper"><main><form><input type="password" readonly>${pad(digits)}</form></main><nav>${pages}</nav></div>`;
    const field = document.querySelector("input")!;
    const keypad = document.getElementById("pad")!;
    expect(locateKeypad(document, { by: "id", value: "wrapper" }, field)).toBe(keypad);
    expect(locateKeypad(document, { by: "id", value: "pad" }, field)).toBe(keypad);
    expect(keysFor(keypad, "3")).toEqual([keypad.children[3]]);
    // Even read from the wrapper, pagination's controls type nothing.
    expect(keysFor(document.getElementById("wrapper")!, "3")).toEqual([keypad.children[3]]);
    // An id or test ID on an element without the keypad names none.
    document.querySelector("nav")!.id = "pages";
    document.querySelector("nav")!.dataset["testid"] = "pages";
    expect(locateKeypad(document, { by: "id", value: "pages" }, field)).toBeUndefined();
    expect(locateKeypad(document, { by: "test-id", value: "pages" }, field)).toBeUndefined();
    expect(locateKeypad(document, { by: "id", value: "missing" }, field)).toBeUndefined();
  });

  it("gives no position from a field the body alone shares with the keypad", () => {
    document.body.innerHTML = `<form><input type="password" readonly></form>${pad(digits)}`;
    expect(
      keypadPosition(document.querySelector("input")!, document.getElementById("pad")!),
    ).toBeUndefined();
  });

  it("names the keypad by a class only one element has and that holds the page's keypad", () => {
    document.body.innerHTML = `<main><form><input type="password" readonly><div class="keys box">${pad(digits)}</div><p class="box"></p></form></main>`;
    const field = document.querySelector("input")!;
    const keypad = document.getElementById("pad")!;
    expect(locateKeypad(document, { by: "class", value: "keys" }, field)).toBe(keypad);
    // Shared by two elements, the class names no keypad.
    expect(locateKeypad(document, { by: "class", value: "box" }, field)).toBeUndefined();
    // A class on an element without the keypad names nothing.
    document.querySelector("p")!.className = "other";
    expect(locateKeypad(document, { by: "class", value: "other" }, field)).toBeUndefined();
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

  it("is an empty, enabled read-only password or code field beside the keypad only", () => {
    document.body.innerHTML = `<form><input id="pin" type="password" readonly>
      <input id="email" readonly value="me@example.com"><input id="date" type="text" readonly value="2026-10-23">
      <input id="off" type="password" readonly disabled><input id="open" type="password">
      <input id="search" type="text" readonly><input id="current" readonly autocomplete="current-password">
      <input id="code" type="tel" readonly autocomplete="one-time-code">${pad(digits)}</form>`;
    const keypad = findKeypad(document);
    const field = (id: string) =>
      keypadField(document.querySelector<HTMLInputElement>(`#${id}`)!, keypad);
    // A read-only text input, as a search box beside an A-Z filter bar, takes no keys.
    expect(["pin", "email", "date", "off", "open", "search", "current", "code"].map(field)).toEqual(
      [true, false, false, false, false, false, true, true],
    );
    expect(keypadField(document.querySelector<HTMLInputElement>("#pin")!, undefined)).toBe(false);
  });
});

describe("typeOnKeypad", () => {
  it("opens the keypad by pressing the field and presses one key per character as the keys move", async () => {
    const { input, typed } = keypadPage({ open: false });
    const keypad = document.getElementById("pad")!;
    await expect(typeOnKeypad(input, "4071", () => keypad)).resolves.toBeUndefined();
    expect(typed).toEqual(["4", "0", "7", "1"]);
    expect(input.value).toBe("****");
  });

  it("presses nothing for a full-width character of the value, though the keys show full-width labels", async () => {
    const { input, typed } = keypadPage({ characters: [..."０１２３４５６７８９"] });
    const keypad = document.getElementById("pad")!;
    await expect(typeOnKeypad(input, "1２", () => keypad)).resolves.toBe("key-missing");
    expect(typed).toEqual([]);
    await expect(typeOnKeypad(input, "12", () => keypad)).resolves.toBeUndefined();
    expect(typed).toEqual(["１", "２"]);
  });

  it("presses nothing when a character has no key, or the field already holds characters", async () => {
    const { input, typed } = keypadPage({ characters: digits.slice(1) });
    const keypad = document.getElementById("pad")!;
    await expect(typeOnKeypad(input, "120", () => keypad)).resolves.toBe("key-missing");
    expect(typed).toEqual([]);
    input.value = "*";
    await expect(typeOnKeypad(input, "12", () => keypad)).resolves.toBe("refused");
    expect(typed).toEqual([]);
  });

  it("presses nothing when two keys type one character", async () => {
    const { input, typed } = keypadPage({ characters: [...digits, "1"] });
    await expect(typeOnKeypad(input, "1", () => document.getElementById("pad")!)).resolves.toBe(
      "key-missing",
    );
    expect(typed).toEqual([]);
  });

  it("waits for a press the page shows a moment later", async () => {
    const { input, keypad, typed } = keypadPage({ mask: false });
    // The page shows each press 200 ms after it, as one that animates its keys.
    keypad.addEventListener("click", () => {
      const length = typed.length;
      setTimeout(() => {
        input.value = "*".repeat(length);
      }, 200);
    });
    await expect(typeOnKeypad(input, "12", () => keypad)).resolves.toBeUndefined();
    expect(typed).toEqual(["1", "2"]);
    expect(input.value).toBe("**");
  });

  it("types on a keypad the page redraws after each press", async () => {
    document.body.innerHTML = `<form><input id="pin" type="password" readonly><div id="box"></div></form>`;
    const input = document.querySelector<HTMLInputElement>("#pin")!;
    const box = document.getElementById("box")!;
    const typed: string[] = [];
    // Each press replaces the keypad's element with a new one.
    const draw = () => {
      const keypad = document.createElement("div");
      keypad.innerHTML = digits
        .map((digit) => `<button type="button" class="key">${digit}</button>`)
        .join("");
      keypad.addEventListener("click", (event) => {
        const key = (event.target as Element).closest(".key");
        if (!key) return;
        typed.push(key.textContent!);
        input.value = "*".repeat(typed.length);
        draw();
      });
      box.replaceChildren(keypad);
    };
    draw();
    await expect(
      typeOnKeypad(input, "123", () => box.firstElementChild ?? undefined),
    ).resolves.toBeUndefined();
    expect(typed).toEqual(["1", "2", "3"]);
  });

  it("stops after the first press when the field does not show the character", async () => {
    const { input, typed } = keypadPage({ mask: false });
    await expect(typeOnKeypad(input, "123", () => document.getElementById("pad")!)).resolves.toBe(
      "refused",
    );
    expect(typed).toEqual(["1"]);
  });

  it("stops after the first press when the field grows by more than one character", async () => {
    const { input, typed } = keypadPage({ perPress: 2 });
    const started = performance.now();
    await expect(typeOnKeypad(input, "123", () => document.getElementById("pad")!)).resolves.toBe(
      "refused",
    );
    expect(typed).toEqual(["1"]);
    // At once, without waiting for the press's time.
    expect(performance.now() - started).toBeLessThan(500);
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
      typeOnKeypad(input, "12", () => keypad, {
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
      typeOnKeypad(input, "1", () => document.getElementById("pad")!, { openMs: 100 }),
    ).resolves.toBe("keypad-closed");
  });

  it("stops with the caller's cause between presses, and reports each press made", async () => {
    const { input, typed } = keypadPage();
    let presses = 0;
    const stopped = await typeOnKeypad(input, "123", () => document.getElementById("pad")!, {
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
