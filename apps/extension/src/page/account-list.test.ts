import { afterEach, describe, expect, it } from "vitest";
import {
  accountEntries,
  accountNames,
  besideAccounts,
  besideEmails,
  chooses,
  entryLike,
  listControls,
  namedAccounts,
  namesUsername,
  pickEntry,
} from "./account-list";

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

// The structure of Wise's "Welcome back" card and Instagram's saved profile in the
// owner's Chrome on 2026-10-12, with made-up texts.
const wise = `
  <h1>Welcome back</h1>
  <div class="df-box-renderer">
    <div class="df-media-layout-avatar">TY</div>
    <h3>Taro</h3>
    <p>t***@example.com</p>
    <button><span>Log back in</span></button>
    <button><span>Use another account</span></button>
  </div>
  <footer><p>Contact help@example.com</p><button>Cookies</button></footer>`;
const instagram = `
  <div>
    <div>
      <div><div role="img"><svg></svg></div><div><span>taro.yamada</span></div></div>
      <div role="button"><div role="button" aria-label="Continue as taro.yamada">Continue</div></div>
    </div>
    <div role="button" aria-label="Use another profile">Use another profile</div>
    <a role="link" aria-label="Create new account" href="/accounts/emailsignup/">Create new account</a>
  </div>`;

describe("besideAccounts", () => {
  it("finds Wise's masked email beside its buttons, not the footer's address", () => {
    document.body.innerHTML = wise;
    expect(accountEntries(document)).toEqual([]);
    const emails = besideEmails(document);
    expect(emails.map((account) => account.text)).toEqual(["t***@example.com"]);
    expect(emails[0]!.buttons.map((button) => button.textContent)).toEqual([
      "Log back in",
      "Use another account",
    ]);
    expect(besideAccounts(document).map((account) => account.text)).toContain("Taro");
  });

  it("finds Instagram's username beside Continue", () => {
    document.body.innerHTML = instagram;
    const shown = besideAccounts(document).find((account) => account.text === "taro.yamada");
    expect(shown?.buttons.map((button) => button.textContent)).toEqual(["Continue"]);
    expect(besideEmails(document)).toEqual([]);
  });

  it("leaves out texts beside more than three buttons and inside controls", () => {
    document.body.innerHTML = `
      <div><p>a@example.com</p><button>1</button><button>2</button><button>3</button><button>4</button></div>
      <button disabled><span>b@example.com</span></button>`;
    expect(besideAccounts(document).map((account) => account.text)).toEqual([]);
  });
});

describe("account names and list controls", () => {
  it("hands over Instagram's short texts and finds the one that names the account", () => {
    document.body.innerHTML = instagram;
    expect(accountNames(document)).toEqual([
      "taro.yamada",
      "Continue",
      "Use another profile",
      "Create new account",
    ]);
    expect(namedAccounts(document, ["Taro.Yamada"]).map((element) => element.textContent)).toEqual([
      "taro.yamada",
    ]);
    expect(namedAccounts(document, ["hanako"])).toEqual([]);
  });

  it("never hands over a text with an @, or one longer than 64 characters", () => {
    document.body.innerHTML = `<div><span>taro@example.com</span><button>Continue</button></div>
      <button>${"x".repeat(65)}</button>`;
    expect(accountNames(document)).toEqual(["Continue"]);
  });

  it("finds a list's own buttons by their whole text, whatever their element type", () => {
    document.body.innerHTML = instagram;
    expect(
      listControls(document, { by: "text", value: "Use another profile" }).map(
        (element) => element.tagName,
      ),
    ).toEqual(["DIV"]);
    expect(listControls(document, { by: "text", value: "Continue" })).toHaveLength(1);
    expect(listControls(document, { by: "text", value: "Use another" })).toEqual([]);
    document.body.innerHTML = wise;
    expect(listControls(document, { by: "text", value: "Log back in" })).toHaveLength(1);
  });
});

describe("besideAccounts limits", () => {
  it("counts page chrome's controls but never returns them", () => {
    document.body.innerHTML = `
      <div>
        <header><a href="/a">A</a><a href="/b">B</a><a href="/c">C</a></header>
        <p>a@example.com</p><button>Continue</button>
      </div>`;
    expect(besideAccounts(document)).toEqual([]);
    document.body.innerHTML = `
      <div><nav><a href="/a">A</a></nav><p>a@example.com</p><button>Continue</button></div>`;
    expect(besideEmails(document)[0]?.buttons.map((button) => button.textContent)).toEqual([
      "Continue",
    ]);
  });

  it("leaves out contact details and counts no hidden or script text", () => {
    document.body.innerHTML = `
      ${"<p hidden>x</p>".repeat(450)}<script>${"var a;".repeat(10)}</script>
      <div role="contentinfo"><p>help@example.com</p><button>Help</button></div>
      <div><p>t***@example.com</p><button>Log back in</button></div>`;
    expect(besideEmails(document).map((account) => account.text)).toEqual(["t***@example.com"]);
  });
});

describe("namesUsername", () => {
  it("matches a whole text, ignoring case and a leading @", () => {
    expect(namesUsername("taro.yamada", "Taro.Yamada")).toBe(true);
    expect(namesUsername("@taro.yamada", "taro.yamada")).toBe(true);
    expect(namesUsername("taro.yamada2", "taro.yamada")).toBe(false);
    expect(namesUsername("Continue as taro.yamada", "taro.yamada")).toBe(false);
    expect(namesUsername("taro***", "taro.yamada")).toBe(false);
    expect(namesUsername("taro@example.com", "taro@example.com")).toBe(false);
  });
});
