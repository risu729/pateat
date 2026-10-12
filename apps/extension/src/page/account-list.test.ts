import { afterEach, describe, expect, it } from "vitest";
import { accountEntries, chooses, entryLike, pickEntry } from "./account-list";

afterEach(() => {
  document.body.innerHTML = "";
});

const list = (html: string) => {
  document.body.innerHTML = html;
  return accountEntries(document);
};

describe("accountEntries", () => {
  it("finds entries whatever their element type", () => {
    const entries = list(`
      <h1>Sign in</h1>
      <button><span>Taro</span><span>a@example.com</span><small>Last used</small></button>
      <a href="/login?profile=2"><span>b@example.com</span></a>
      <div role="link"><div>c@example.com</div></div>
      <li tabindex="0">d@example.com</li>
      <div style="cursor: pointer"><span>e@example.com</span></div>
      <div>f@example.com is not clickable</div>
      <button>Sign in with another profile</button>
    `);
    expect(entries.map((entry) => entry.accounts)).toEqual([
      ["a@example.com"],
      ["b@example.com"],
      ["c@example.com"],
      ["d@example.com"],
      ["e@example.com"],
    ]);
    expect(entries.map((entry) => entry.element.tagName)).toEqual([
      "BUTTON",
      "A",
      "DIV",
      "LI",
      "DIV",
    ]);
  });

  it("takes the innermost entry and leaves out page chrome", () => {
    const entries = list(`
      <header><button>me@example.com</button></header>
      <nav><a href="/account">me@example.com</a></nav>
      <div role="navigation"><button>me@example.com</button></div>
      <div role="listbox" tabindex="0">
        <div role="option"><span>a@example.com</span></div>
      </div>
    `);
    expect(entries).toHaveLength(1);
    expect(entries[0]!.element.getAttribute("role")).toBe("option");
  });

  it("skips hidden, disabled and other-origin entries", () => {
    const entries = list(`
      <button hidden>a@example.com</button>
      <button disabled>b@example.com</button>
      <div role="button" aria-disabled="true">c@example.com</div>
      <a href="https://other.example/">d@example.com</a>
      <button style="display: none">e@example.com</button>
      <fieldset disabled><button>f@example.com</button></fieldset>
    `);
    expect(entries).toEqual([]);
  });

  it("finds no entry inside or around a rejected link or button", () => {
    const entries = list(`
      <div role="button"><a href="https://idp.example/">a@example.com</a></div>
      <li tabindex="0"><button disabled>b@example.com</button></li>
      <a href="https://idp.example/"><span tabindex="0">c@example.com</span></a>
    `);
    expect(entries).toEqual([]);
  });

  it("counts nested entries as the inner one", () => {
    const entries = list(`
      <div role="button" id="row">a@example.com <button id="inner">a@example.com</button></div>
    `);
    expect(entries.map((entry) => entry.element.id)).toEqual(["inner"]);
  });
});

describe("entryLike", () => {
  it("counts only the element that sets cursor: pointer", () => {
    document.body.innerHTML = `<div id="row" style="cursor: pointer"><span id="inner">x</span></div>`;
    expect(entryLike(document.querySelector("#row")!)).toBe(true);
    expect(entryLike(document.querySelector("#inner")!)).toBe(false);
  });
});

describe("chooses", () => {
  it("chooses an unmasked address only when equal", () => {
    expect(chooses("A@Example.com", "a@example.com")).toBe(true);
    expect(chooses("aa@example.com", "a@example.com")).toBe(false);
    expect(chooses("a@example.com", "taro")).toBe(false);
  });

  it("chooses a masked address with enough visible characters", () => {
    expect(chooses("risu***@example.com", "risutaku@example.com")).toBe(true);
    expect(chooses("ris●●●ku@example.com", "risutaku@example.com")).toBe(true);
    expect(chooses("ri***@example.com", "risutaku@example.com")).toBe(false);
    expect(chooses("r***u@example.com", "risutaku@example.com")).toBe(false);
    expect(chooses("abc***@example.com", "abcdefghij@example.com")).toBe(false);
    expect(chooses("risx***@example.com", "risutaku@example.com")).toBe(false);
    expect(chooses("risu***@e***.com", "risutaku@example.com")).toBe(false);
    expect(chooses("risu***@example.org", "risutaku@example.com")).toBe(false);
  });
});

describe("pickEntry", () => {
  it("picks the one entry of the username", () => {
    const entries = list(`
      <button>a@example.com</button>
      <button>b@example.com</button>
    `);
    expect(pickEntry(entries, "b@example.com")).toEqual({ entry: entries[1] });
    expect(pickEntry(entries, "c@example.com")).toEqual({ reason: "none" });
  });

  it("refuses several fitting entries and masks another vault account fits", () => {
    const entries = list(`
      <button>risu***@example.com</button>
      <button>risu***@example.com</button>
    `);
    expect(pickEntry(entries, "risutaku@example.com")).toEqual({ reason: "ambiguous" });
    const one = list(`<button>risu***@example.com</button>`);
    expect(pickEntry(one, "risutaku@example.com")).toEqual({ entry: one[0] });
    expect(pickEntry(one, "risutaku@example.com", ["risuko@example.com"])).toEqual({
      reason: "none",
    });
    // An unmasked address is never shared with another account.
    const plain = list(`<button>risutaku@example.com</button>`);
    expect(pickEntry(plain, "risutaku@example.com", ["risuko@example.com"])).toEqual({
      entry: plain[0],
    });
  });
});
