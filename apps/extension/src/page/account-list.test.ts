import { afterEach, describe, expect, it } from "vitest";
import {
  accountEntries,
  accountEntryMiss,
  accountNames,
  besideAccounts,
  besideEmails,
  chooses,
  entryLike,
  listChoice,
  listControls,
  namedAccounts,
  namesUsername,
  otherAccountMiss,
  pickEntry,
  showsOtherAccountControl,
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

  it("reads an address inside an element with display: contents", () => {
    // Cloudflare's saved profiles, 2026-10-12.
    const entries = list(`
      <button data-testid="account-selector-last-used">
        <span style="display: contents"><span style="display: block">a@example.com</span></span>
        <span>Last used</span>
      </button>
      <button data-testid="account-selector-account-1">
        <span style="display: contents"><span style="display: block">b@example.com</span></span>
      </button>
      <button>Sign in with another profile</button>
    `);
    expect(entries.map((entry) => entry.accounts)).toEqual([["a@example.com"], ["b@example.com"]]);
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

describe("showsOtherAccountControl", () => {
  it("finds a control to sign in with another account by its words, whatever its element type", () => {
    document.body.innerHTML = instagram;
    expect(showsOtherAccountControl(document)).toBe(true);
    for (const text of [
      "Switch accounts",
      "Log into another account",
      "別のアカウントでログイン",
      "ユーザーを切り替える",
    ]) {
      document.body.innerHTML = `<div><span>taro</span><button>Continue</button></div><a href="/x">${text}</a>`;
      expect(showsOtherAccountControl(document)).toBe(true);
    }
  });

  it("leaves out a control whose text holds a shown name, which the page sent hides", () => {
    document.body.innerHTML = instagram;
    expect(showsOtherAccountControl(document, ["taro.yamada"])).toBe(true);
    document.body.innerHTML = `<div><span>taro</span><button>Continue</button></div><button>Not taro? Switch accounts</button>`;
    expect(showsOtherAccountControl(document, ["taro"])).toBe(false);
    document.body.innerHTML = `<div><h1>ログイン</h1><button>続ける</button></div><button>別のアカウントでログイン</button>`;
    expect(showsOtherAccountControl(document, ["ログイン"])).toBe(false);
    document.body.innerHTML = `<div><span>taro</span><button>Go</button></div><div role="button" aria-label="Switch from taro">Switch accounts</div>`;
    expect(showsOtherAccountControl(document, ["taro"])).toBe(false);
  });

  it("leaves out other controls, page chrome and long texts", () => {
    for (const html of [
      `<div><span>taro</span><button>Continue</button></div><button>Other ways to sign in</button>`,
      `<div><span>taro</span><button>Continue</button></div><button>Create new account</button>`,
      `<header><button>Switch account</button></header><div><span>taro</span><button>Go</button></div>`,
      `<div><span>taro</span><button>Go</button></div><button>${"Use another account ".repeat(4)}</button>`,
      `<div><span>taro</span><button>Go</button></div><button disabled>Use another profile</button>`,
    ]) {
      document.body.innerHTML = html;
      expect(showsOtherAccountControl(document)).toBe(false);
    }
  });
});

describe("otherAccountMiss", () => {
  it("says why no control for another account counts, for the log", () => {
    document.body.innerHTML = instagram;
    expect(otherAccountMiss(document, ["taro.yamada"])).toBeUndefined();
    document.body.innerHTML = `<div><span>taro</span><button>Continue</button></div><button>Not taro? Switch accounts</button>`;
    expect(otherAccountMiss(document, ["taro"])).toBe("other-holds-name");
    document.body.innerHTML = `<div><span>taro</span><button>Go</button></div><button>Switch account 1234</button>`;
    expect(otherAccountMiss(document)).toBe("other-not-clickable");
    for (const html of [
      `<header><button>Switch account</button></header><div><span>taro</span><button>Go</button></div>`,
      `<div><span>taro</span><button>Go</button></div><button disabled>Use another profile</button>`,
      `<div><span>taro</span><button>Go</button></div><p>Use another profile</p>`,
    ]) {
      document.body.innerHTML = html;
      expect(otherAccountMiss(document)).toBe("other-not-control");
    }
    document.body.innerHTML = `<div><span>taro</span><button>Continue</button></div><button>Create new account</button>`;
    expect(otherAccountMiss(document)).toBe("no-other");
  });
});

describe("account names and list controls", () => {
  it("hands over Instagram's username beside Continue and finds the one that names the account", () => {
    document.body.innerHTML = instagram;
    // A control's own text is never handed over.
    expect(accountNames(document)).toEqual(["taro.yamada"]);
    const found = namedAccounts(document, ["＠Taro.Yamada"]);
    expect(found.named.map((element) => element.textContent)).toEqual(["taro.yamada"]);
    expect(found.others).toEqual([]);
    const missing = namedAccounts(document, ["hanako"]);
    expect(missing.named).toEqual([]);
    expect(missing.others.map((element) => element.textContent)).toEqual(["taro.yamada"]);
  });

  it("never hands over a text with an @, or one longer than 64 characters", () => {
    document.body.innerHTML = `<div><span>taro@example.com</span><button>Continue</button></div>
      <div><span>${"x".repeat(65)}</span><button>Go</button></div>
      <button>hanako</button>`;
    expect(accountNames(document)).toEqual([]);
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

describe("listChoice", () => {
  const other = { by: "text", value: "Sign in with another profile" } as const;
  const cloudflare = `
    <h1>Sign in to Cloudflare</h1>
    <div role="link" tabindex="0">Taro <span>risutaku@example.com</span> Last used</div>
    <div role="link" tabindex="0">hanako@example.com</div>
    <button>Sign in with another profile</button>`;

  it("clicks the one entry that fits the account, else the other button", () => {
    document.body.innerHTML = cloudflare;
    const picked = listChoice(document, {
      username: "RisuTaku@example.com",
      others: [],
      othersComplete: true,
      other,
    });
    expect(picked.click).toBe("entry");
    expect("element" in picked && picked.element.textContent).toContain("risutaku@example.com");
    const missing = listChoice(document, {
      username: "jiro@example.com",
      others: [],
      othersComplete: true,
      other,
    });
    expect(missing.click).toBe("other");
    expect("element" in missing && missing.element.textContent).toBe(other.value);
    // Without the button, nothing is clicked.
    expect(
      listChoice(document, { username: "jiro@example.com", others: [], othersComplete: true }),
    ).toEqual({
      click: "none",
    });
  });

  it("never takes a masked entry another vault item fits too", () => {
    document.body.innerHTML = `<div role="link" tabindex="0">risu***@example.com</div>
      <button>Sign in with another profile</button>`;
    expect(
      listChoice(document, {
        username: "risutaku@example.com",
        others: [],
        othersComplete: true,
        other,
      }).click,
    ).toBe("entry");
    expect(
      listChoice(document, {
        username: "risutaku@example.com",
        others: ["risuko@example.com"],
        othersComplete: true,
        other,
      }).click,
    ).toBe("other");
  });

  it("continues with Wise's one shown account only when it fits", () => {
    document.body.innerHTML = wise;
    const buttons = {
      continue: { by: "text", value: "Log back in" },
      other: { by: "text", value: "Use another account" },
    } as const;
    // One visible character before @ is too few to choose it.
    expect(
      listChoice(document, {
        username: "taro@example.com",
        others: [],
        othersComplete: true,
        ...buttons,
      }).click,
    ).toBe("other");
    document.body.innerHTML = wise.replace("t***@", "tar***@");
    const chosen = listChoice(document, {
      username: "taro@example.com",
      others: [],
      othersComplete: true,
      ...buttons,
    });
    expect(chosen.click).toBe("continue");
    expect("element" in chosen && chosen.element.textContent).toBe("Log back in");
  });

  it("continues with Instagram's profile when its text is the username", () => {
    document.body.innerHTML = instagram;
    const buttons = {
      continue: { by: "text", value: "Continue" },
      other: { by: "text", value: "Use another profile" },
    } as const;
    expect(
      listChoice(document, {
        username: "@Taro.Yamada",
        others: [],
        othersComplete: true,
        ...buttons,
      }).click,
    ).toBe("continue");
    expect(
      listChoice(document, { username: "hanako", others: [], othersComplete: true, ...buttons })
        .click,
    ).toBe("other");
    // A list whose entry's whole text is the username clicks the entry itself.
    document.body.innerHTML = `<ul><li><a href="#">taro.yamada</a></li><li><a href="#">hanako</a></li></ul>`;
    expect(
      listChoice(document, { username: "taro.yamada", others: [], othersComplete: true }).click,
    ).toBe("entry");
  });

  it("takes no masked entry when the other vault items are not all known", () => {
    document.body.innerHTML = `<div role="link" tabindex="0">risu***@example.com</div>
      <div role="link" tabindex="0">hanako@example.com</div>
      <button>Sign in with another profile</button>`;
    const input = { others: [], othersComplete: false, other };
    expect(listChoice(document, { username: "risutaku@example.com", ...input }).click).toBe(
      "other",
    );
    // A whole address still fits.
    expect(listChoice(document, { username: "hanako@example.com", ...input }).click).toBe("entry");
  });

  it("continues with a username only beside the one shown account's own button", () => {
    const buttons = {
      continue: { by: "text", value: "Continue" },
      other: { by: "text", value: "Use another profile" },
    } as const;
    const input = { username: "taro", others: ["hanako"], othersComplete: true, ...buttons };
    // Two accounts beside one Continue: the checked one may be another account.
    document.body.innerHTML = `<form><label><input type="radio" name="a"> taro</label>
      <label><input type="radio" name="a" checked> hanako</label><button>Continue</button></form>
      <button>Use another profile</button>`;
    expect(listChoice(document, input).click).not.toBe("continue");
    // The name sits beside another button, and Continue is elsewhere.
    document.body.innerHTML = `<div><span>taro</span><button>Follow</button></div>
      <div><button>Continue</button></div><button>Use another profile</button>`;
    expect(listChoice(document, input).click).toBe("other");
  });

  it("never clicks a button whose text may name an account, or one in a form with fields", () => {
    const named = { by: "id", value: "next" } as const;
    document.body.innerHTML = `<button id="next">Continue as hanako@example.com</button>`;
    expect(
      listChoice(document, {
        username: "taro@example.com",
        others: [],
        othersComplete: true,
        other: named,
      }),
    ).toEqual({ click: "none" });
    document.body.innerHTML = `<form><input type="text" name="q"><button id="next">Next</button></form>`;
    expect(
      listChoice(document, {
        username: "taro@example.com",
        others: [],
        othersComplete: true,
        other: named,
      }),
    ).toEqual({ click: "none" });
    document.body.innerHTML = `<form><input type="hidden" name="q"><button id="next">Next</button></form>`;
    expect(
      listChoice(document, {
        username: "taro@example.com",
        others: [],
        othersComplete: true,
        other: named,
      }).click,
    ).toBe("other");
  });
});

describe("accountEntryMiss", () => {
  const miss = (html: string) => {
    document.body.innerHTML = html;
    expect(accountEntries(document)).toEqual([]);
    return accountEntryMiss(document);
  };

  it("names why a shown address is not an entry", () => {
    expect(miss("<p>Signed in as a@example.com</p>")).toBe("no-entry");
    expect(miss("<header><button>a@example.com</button></header>")).toBe("page-chrome");
    expect(miss('<a href="https://idp.example/"><span>a@example.com</span></a>')).toBe(
      "inside-control",
    );
    expect(miss("<p>No address here</p>")).toBeUndefined();
    expect(miss("<button><span>a</span><span>@example.com</span></button>")).toBe("split-address");
  });

  it("prefers a shown address, and otherwise names how one is hidden", () => {
    expect(miss('<div aria-hidden="true"><button>a@example.com</button></div>')).toBe(
      "aria-hidden",
    );
    expect(miss("<div inert><button>a@example.com</button></div>")).toBe("inert");
    expect(miss("<button hidden>a@example.com</button>")).toBe("hidden");
    expect(miss('<button style="opacity: 0">a@example.com</button>')).toBe("not-rendered");
    expect(miss("<button hidden>a@example.com</button><p>Signed in as b@example.com</p>")).toBe(
      "no-entry",
    );
  });
});
