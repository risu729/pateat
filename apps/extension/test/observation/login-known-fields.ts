import { expect, it } from "vitest";
import { extractLoginObservation } from "../../src/observation/extract";
import type { ObservationTestContext } from "./context";

export function registerLoginKnownFields({
  page,
  observe,
  summary,
}: Pick<ObservationTestContext, "page" | "observe" | "summary">) {
  it("describes a read-only field beside a software keyboard with the keypad's locator and leaves its keys out (ADR 0067)", () => {
    const keys = (characters: string) =>
      [...characters].map((character) => `<input type="button" value="${character}">`).join("");
    page(
      `<form id="f"><label>暗証番号<input id="pin" type="password" readonly></label>
      <div id="soft-keys" hidden><div>${keys("７３９１０２８４６５")}</div><button type="button">クリア</button></div>
      <button id="go" type="button">ログイン</button></form>`,
    );
    const observation = observe();
    expect(observation.complete).toBe(true);
    expect(summary(observation)).toEqual([
      {
        role: "password",
        target: { by: "id", value: "pin" },
        label: "暗証番号",
        keypad: { by: "id", value: "soft-keys" },
        group: "f1",
      },
      { role: "button", target: { by: "id", value: "go" }, label: "ログイン", group: "f1" },
    ]);
    // A shown keypad's keys are left out too, and its locator may be an ancestor's test ID.
    page(
      `<form id="f"><input id="pin" type="password" readonly>
      <section data-testid="pad"><div>${keys("0123456789")}</div></section>
      <button id="go" type="button">Log in</button></form>`,
    );
    expect(
      summary(observe()).map((candidate) => [candidate.target.value, candidate.keypad]),
    ).toEqual([
      ["pin", { by: "test-id", value: "pad" }],
      ["go", undefined],
    ]);
    // Without a keypad, a read-only field is still unfillable. So is one that holds a
    // value, as a date or an email address shown again, or a read-only text input, as a
    // search box beside an A-Z filter bar of buttons, and a keypad with neither every
    // digit nor 26 letters is no keypad.
    for (const html of [
      `<input id="q" type="text" readonly><div id="pad">${keys("ABCDEFGHIJKLMNOPQRSTUVWXYZ")}</div>`,
      `<input id="pin" type="password" readonly><div id="pad">${keys("012345678")}</div>`,
      `<input id="pin" type="password" readonly><div id="pad">${keys("ABCDEFGHIJKLMNOPQRSTUVWXY")}</div>`,
      `<input id="pin" type="password" readonly disabled><div id="pad">${keys("0123456789")}</div>`,
      `<input id="day" readonly value="2026-10-23"><input id="pin" type="password" readonly><div id="pad">${keys("0123456789")}</div>`,
    ]) {
      page(`<form>${html}<button id="go" type="button">Log in</button></form>`);
      const result = extractLoginObservation();
      expect(result.ok && result.observation.complete, html).toBe(false);
    }
    // A keypad that shares no box with the field but the body belongs to something else.
    page(
      `<form><input id="pin" type="password" readonly><button id="go" type="button">Log in</button></form>
      <div id="pad">${keys("0123456789")}</div>`,
    );
    const apart = extractLoginObservation();
    expect(apart.ok && apart.observation.complete).toBe(false);
  });

  it("never sends a software keyboard's key labels or their order, in a label, description or anywhere else (ADR 0067)", () => {
    // A shuffled letters-only keyboard of links, and a shuffled digit pad.
    const order = "QWERTYUIOPASDFGHJKLZXCVBNM";
    const digits = "7391028465";
    const links = (characters: string) =>
      [...characters].map((character) => `<a href="#">${character}</a>`).join(" ");
    const sent = (keys: string) => {
      const result = extractLoginObservation();
      if (!result.ok) throw new Error(result.reason);
      const text = JSON.stringify(result.observation).replaceAll(/\s/gu, "");
      // No three keys in their order, with or without the spaces between them.
      return [...keys].slice(0, -2).flatMap((_, at) => {
        const run = keys.slice(at, at + 3);
        return text.includes(run) ? [run] : [];
      });
    };
    for (const [keys, html] of [
      // The keys before the field in its row, where a label by layout would be read.
      [
        order,
        `<form id="f"><div id="pad">${links(order)}</div><div><input id="pin" type="password" readonly></div><button id="go" type="button">Log in</button></form>`,
      ],
      [
        digits,
        `<form id="f"><table><tr><td id="pad">${links(digits)}</td><td><input id="pin" type="password" readonly></td></tr></table><button id="go" type="button">Log in</button></form>`,
      ],
      // The keys inside the field's label.
      [
        order,
        `<form id="f"><label>Password <input id="pin" type="password" readonly><span id="pad">${links(order)}</span></label><button id="go" type="button">Log in</button></form>`,
      ],
      // The keypad named as the field's label or description.
      [
        digits,
        `<form id="f"><input id="pin" type="password" readonly aria-labelledby="pad"><div id="pad">${links(digits)}</div><button id="go" type="button">Log in</button></form>`,
      ],
      [
        digits,
        `<form id="f"><label for="pin">PIN</label><input id="pin" type="password" readonly aria-describedby="pad"><div id="pad">${links(digits)}</div><button id="go" type="button">Log in</button></form>`,
      ],
    ] as const) {
      page(html);
      expect(
        summary(observe()).map((candidate) => [candidate.target.value, candidate.keypad]),
        html,
      ).toEqual([
        ["pin", { by: "id", value: "pad" }],
        ["go", undefined],
      ]);
      expect(sent(keys), html).toEqual([]);
    }
  });

  it("never sends the keys of an optional keyboard beside a writable field, or of a keypad for each of two fields (ADR 0067)", () => {
    const order = "QWERTYUIOPASDFGHJKLZXCVBNM";
    const digits = "7391028465";
    const runs = (keys: string) => {
      const result = extractLoginObservation();
      if (!result.ok) throw new Error(result.reason);
      const text = JSON.stringify(result.observation).replaceAll(/\s/gu, "");
      return {
        observation: result.observation,
        runs: [...keys].slice(0, -2).flatMap((_, at) => {
          const run = keys.slice(at, at + 3);
          return text.includes(run) ? [run] : [];
        }),
      };
    };
    // A writable password field with an optional keyboard: full-width input buttons in a
    // shuffled order, as SMBC Direct's, and links in a list, as MUFG's.
    const full = (character: string) =>
      /\d/u.test(character) ? String.fromCodePoint(character.codePointAt(0)! + 0xfee0) : character;
    for (const [keys, pad] of [
      [
        digits + order,
        `<div id="soft">${[...(digits + order)].map((key) => `<input type="button" value="${full(key)}">`).join("")}</div>`,
      ],
      [
        order,
        `<ul id="soft">${[...order].map((key) => `<li><a href="#">${key}</a></li>`).join("")}</ul>`,
      ],
    ] as const) {
      page(
        `<form id="f">${pad}<div><input id="pw" type="password"></div><button id="go" type="button">Log in</button></form>`,
      );
      const { observation, runs: found } = runs(keys);
      expect(found, pad).toEqual([]);
      expect(
        observation.candidates.map((candidate) => [candidate.target.value, candidate.label]),
        pad,
      ).toEqual([
        ["pw", undefined],
        ["go", "Log in"],
      ]);
    }
    // Two read-only fields, each beside its own keypad: each field names its own.
    page(
      `<form id="f"><label>PIN<input id="pin" type="password" readonly></label><div id="digits">${[...digits].map((key) => `<a href="#">${key}</a>`).join("")}</div>
      <label>Word<input id="word" type="password" readonly></label><div id="letters">${[...order].map((key) => `<a href="#">${key}</a>`).join("")}</div>
      <button id="go" type="button">Log in</button></form>`,
    );
    expect(runs(digits).runs).toEqual([]);
    expect(runs(order).runs).toEqual([]);
    expect(
      summary(observe()).map((candidate) => [
        candidate.target.value,
        candidate.label,
        candidate.keypad,
      ]),
    ).toEqual([
      ["pin", "PIN", { by: "id", value: "digits" }],
      ["word", "Word", { by: "id", value: "letters" }],
      ["go", "Log in", undefined],
    ]);
  });

  it("keeps the other labels of a form whose keys sit in the form itself (ADR 0067)", () => {
    const keys = [..."7391028465"].map((key) => `<a href="#">${key}</a>`).join("");
    page(
      `<form id="f"><label>Customer number <input id="customer" inputmode="numeric"></label><label>PIN <input id="pin" type="password" readonly></label>${keys}<button id="go" type="button">Log in</button></form>`,
    );
    expect(
      summary(observe()).map((candidate) => [
        candidate.target.value,
        candidate.label,
        candidate.keypad,
      ]),
    ).toEqual([
      ["customer", "Customer number", undefined],
      ["pin", "PIN", expect.anything()],
      ["go", "Log in", undefined],
    ]);
    expect(JSON.stringify(observe())).not.toMatch(/7\s*3\s*9/u);
  });

  it("names a keypad without an id or test ID by a class only it has, else by its position from the field (ADR 0067)", () => {
    const keys = (characters: string) =>
      [...characters].map((character) => `<input type="button" value="${character}">`).join("");
    const keypadOf = () =>
      summary(observe()).map((candidate) => [candidate.target.value, candidate.keypad]);
    // A class only the keypad's box has, even a letters-only keyboard's (owner's choice,
    // 2026-10-23 13:01 UTC).
    page(
      `<form><input id="pin" type="password" readonly><div class="soft-keys"><div>${keys("ABCDEFGHIJKLMNOPQRSTUVWXYZ")}</div></div>
      <button id="go" type="button">Log in</button></form>`,
    );
    expect(keypadOf()).toEqual([
      ["pin", { by: "class", value: "soft-keys" }],
      ["go", undefined],
    ]);
    // A class two elements share, or one that looks generated, does not name it; the
    // keypad's place from each field does.
    page(
      `<form><div><input id="pin" type="password" readonly></div><div class="row"><div class="css-1q2w3e4r5t">${keys("0123456789")}</div></div>
      <div class="row"><button id="go" type="button">Log in</button></div></form>`,
    );
    expect(keypadOf()).toEqual([
      ["pin", { by: "position", value: "2:1.0" }],
      ["go", undefined],
    ]);
  });

  it("leaves out a field the continued recipe already fills when it is read-only or disabled", () => {
    // An email address shown again, read-only, beside the password (ADR 0018).
    const email = { by: "id" as const, value: "email" };
    for (const state of ["readonly", "disabled"]) {
      page(
        `<form id="f"><input id="email" type="email" ${state} autocomplete="username"><input id="p" type="password"><button id="go">Log in</button></form>`,
      );
      expect(observe().complete, state).toBe(false);
      const result = extractLoginObservation(document, [email]);
      if (!result.ok) throw new Error(result.reason);
      expect(result.observation.complete, state).toBe(true);
      expect(result.observation.candidates.map((candidate) => candidate.target.value)).toEqual([
        "p",
        "go",
      ]);
    }
    // Another read-only field, a known field under another locator, or a known locator that
    // names two elements still makes the page incomplete.
    for (const html of [
      `<input id="email" readonly><input id="branch" readonly><input id="p" type="password">`,
      `<input name="email" readonly><input id="p" type="password">`,
      `<input id="email" readonly><input id="email" readonly><input id="p" type="password">`,
    ]) {
      page(`<form id="f">${html}<button id="go">Log in</button></form>`);
      const result = extractLoginObservation(document, [email]);
      expect(result.ok && result.observation.complete, html).toBe(false);
    }
    // A known field the page still lets the person edit is described as any field is.
    page(
      `<form id="f"><input id="email" type="email"><input id="p" type="password"><button id="go">Log in</button></form>`,
    );
    const editable = extractLoginObservation(document, [email]);
    if (!editable.ok) throw new Error(editable.reason);
    expect(editable.observation.candidates.map((candidate) => candidate.target.value)).toEqual([
      "email",
      "p",
      "go",
    ]);
  });

  it("leaves out a read-only email a password page on another path keeps (#831)", () => {
    // A WorkOS AuthKit sign-in (2026-10-22): the email step at `/` filled `name="email"`;
    // `/password` keeps the address read-only under the same name and a useId ID.
    page(
      `<form><label for="radix-_r_1_">Email</label>
        <input type="text" name="email" readonly tabindex="-1" id="radix-_r_1_">
        <label for="radix-_r_2_">Password</label>
        <input type="password" name="password" autocomplete="current-password" id="radix-_r_2_">
        <button type="submit">Sign in</button></form>`,
    );
    expect(observe().complete).toBe(false);
    for (const known of [
      { by: "name" as const, value: "email" },
      { by: "label" as const, value: "Email" },
    ]) {
      const result = extractLoginObservation(document, [known]);
      if (!result.ok) throw new Error(result.reason);
      expect(result.observation.complete, known.by).toBe(true);
      expect(result.observation.candidates.map((candidate) => candidate.target)).toEqual([
        { by: "name", value: "password" },
        { by: "text", value: "Sign in" },
      ]);
    }
  });

  it("matches a known field by its name or test ID locator too, exactly (ADR 0018)", () => {
    const form = (field: string) =>
      page(
        `<form id="f">${field}<input id="p" type="password"><button id="go">Log in</button></form>`,
      );
    const complete = (known: { by: "id" | "name" | "test-id"; value: string }[]) => {
      const result = extractLoginObservation(document, known);
      return result.ok && result.observation.complete;
    };
    form(`<input name="login" readonly>`);
    expect(complete([{ by: "name", value: "login" }])).toBe(true);
    expect(complete([{ by: "id", value: "login" }])).toBe(false);
    form(`<input data-testid="login" disabled>`);
    expect(complete([{ by: "test-id", value: "login" }])).toBe(true);
    expect(complete([{ by: "name", value: "login" }])).toBe(false);
    // Values compare exactly.
    form(`<input id="Email" readonly>`);
    expect(complete([{ by: "id", value: "email" }])).toBe(false);
  });

  it("leaves out every known read-only field, but keeps the page's other forms whole", () => {
    page(
      `<form id="f"><input id="email" readonly><input id="member" disabled><input id="p" type="password"><button id="go">Log in</button></form>`,
    );
    const result = extractLoginObservation(document, [
      { by: "id", value: "email" },
      { by: "id", value: "member" },
    ]);
    if (!result.ok) throw new Error(result.reason);
    expect(result.observation.complete).toBe(true);
    expect(result.observation.candidates.map((candidate) => candidate.target.value)).toEqual([
      "p",
      "go",
    ]);
    // With the known field the only field, the page has nothing to describe.
    page(`<form id="f"><input id="email" readonly><button id="go">Next</button></form>`);
    expect(extractLoginObservation(document, [{ by: "id", value: "email" }])).toEqual({
      ok: false,
      reason: "no-candidates",
    });
  });

  it("keeps a disabled submit input as a button", () => {
    page(
      `<form id="f"><input id="u"><input id="go" type="submit" value="ログイン" disabled></form>`,
    );
    expect(summary(observe())).toContainEqual({
      role: "button",
      target: { by: "id", value: "go" },
      label: "ログイン",
      group: "f1",
    });
  });
}
