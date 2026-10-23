import { afterEach, describe, expect, it } from "vitest";
import {
  accountEntries,
  accountSwitchControls,
  accountEntryMiss,
  accountNames,
  besideAccounts,
  besideEmails,
  chooses,
  listChoice,
  listControls,
  namedAccounts,
  namesUsername,
  otherAccountMiss,
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

  it("reads an address split by <wbr> or a format character", () => {
    for (const html of [
      "<button>me@&shy;example.com</button>",
      "<button>me@&#8203;example.com</button>",
      "<button>me@<wbr>example.com</button>",
      "<button><span>me@<wbr>example.com</span><small>Last used</small></button>",
    ]) {
      const entries = list(html);
      expect
        .soft(
          entries.map((entry) => entry.accounts),
          html,
        )
        .toEqual([["me@example.com"]]);
    }
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
    // An unmasked address is never shared with another account, even one of the same username.
    const plain = list(`<button>risutaku@example.com</button>`);
    expect(pickEntry(plain, "risutaku@example.com", ["risutaku@example.com"])).toEqual({
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
// Instagram's saved profile in the owner's Chrome on 2026-10-13, with made-up texts: a
// settings gear with no text sits in the container that holds the profile and its buttons.
const instagramGear = `
  <div>
    <div><div role="button" tabindex="0" aria-label="Open the settings of this profile"><svg aria-hidden="true"><path></path></svg><div role="none"></div></div></div>
    <div><div role="img"><svg aria-hidden="true"><path></path></svg></div><span>taro.yamada</span></div>
    <div>
      <div role="button" tabindex="-1"><div role="button" tabindex="0" aria-label="Continue as taro.yamada"><div role="none"><div role="none"><span>Continue</span></div><div role="none"></div></div></div></div>
      <form>${'<input type="hidden" name="h" value="x">'.repeat(11)}</form>
    </div>
    <div>
      <div role="button" tabindex="0" aria-label="Use another profile"><div role="none"><div role="none"><span>Use another profile</span></div><div role="none"></div></div></div>
      <a role="link" tabindex="0" aria-label="Create new account" href="/accounts/emailsignup/"><div role="none"><div role="none"><span>Create new account</span></div><div role="none"></div></div></a>
      <svg role="img" aria-label="Instagram"><path></path><path></path></svg>
    </div>
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

  it("leaves out texts beside more than three buttons and inside controls", () => {
    document.body.innerHTML = `
      <div><p>a@example.com</p><button>1</button><button>2</button><button>3</button><button>4</button></div>`;
    expect(besideAccounts(document).map((account) => account.text)).toEqual([]);
    document.body.innerHTML = `<div><button disabled><span>b@example.com</span></button><button>Go</button></div>`;
    expect(besideAccounts(document).map((account) => account.text)).toEqual([]);
  });

  it("finds Instagram's profile beside a settings gear with no text, and returns the gear too", () => {
    document.body.innerHTML = instagramGear;
    const beside = besideAccounts(document);
    expect(beside.map((account) => account.text)).toEqual(["taro.yamada"]);
    expect(beside[0]!.buttons.map((button) => button.getAttribute("aria-label"))).toEqual([
      "Open the settings of this profile",
      "Continue as taro.yamada",
      "Use another profile",
      "Create new account",
    ]);
    expect(accountNames(document)).toEqual(["taro.yamada"]);
  });

  it("still leaves out a text beside four buttons with text when a gear is there too", () => {
    document.body.innerHTML = instagramGear.replace(
      "<svg role",
      `<a href="/help"><span>Help</span></a><svg role`,
    );
    expect(besideAccounts(document)).toEqual([]);
  });

  it("does not take a container whose only control has no text as the text's holder", () => {
    document.body.innerHTML = `
      <div>
        <div><span>taro</span><button aria-label="Settings"><svg></svg></button></div>
        <button>Continue</button>
      </div>`;
    const beside = besideAccounts(document);
    expect(beside.map((account) => account.text)).toEqual(["taro"]);
    // The text climbs to the ancestor holding a control with text; the gear is still one
    // of the buttons beside it.
    expect(
      beside[0]!.buttons.map((button) => button.textContent || button.getAttribute("aria-label")),
    ).toEqual(["Settings", "Continue"]);
    // With no control with text around it, the text is not beside buttons at all.
    document.body.innerHTML = `<div><span>taro</span><button aria-label="Settings"><svg></svg></button></div>`;
    expect(besideAccounts(document)).toEqual([]);
  });

  it("counts no text a gear never shows, such as an SVG title or a hidden span", () => {
    for (const icon of [
      `<svg aria-hidden="true"><title>Settings</title><path></path></svg>`,
      `<svg aria-hidden="true"><path></path></svg><span hidden>Settings</span>`,
    ]) {
      // With the gear counted, the profile's container would hold four controls.
      document.body.innerHTML = instagramGear.replace(
        `<svg aria-hidden="true"><path></path></svg><div role="none"></div>`,
        icon,
      );
      expect(document.body.innerHTML).toContain(">Settings<");
      expect(
        besideAccounts(document).map((account) => account.text),
        icon,
      ).toEqual(["taro.yamada"]);
      document.body.innerHTML = `<div><span>taro</span><button aria-label="Settings">${icon}</button></div>`;
      expect(besideAccounts(document), icon).toEqual([]);
    }
  });

  it("counts an input button's value or alt text and an image's alt text as words", () => {
    for (const control of [
      `<input type="submit" value="Continue">`,
      `<input type="image" alt="Continue">`,
      `<button><img alt="Continue"></button>`,
    ]) {
      document.body.innerHTML = `<div><span>taro</span>${control}</div>`;
      expect(
        besideAccounts(document).map((account) => account.text),
        control,
      ).toEqual(["taro"]);
      // Counted, they also count toward the limit.
      document.body.innerHTML = `<div><span>taro</span>${control.repeat(4)}</div>`;
      expect(besideAccounts(document), control).toEqual([]);
    }
  });
});

describe("accountSwitchControls", () => {
  // Duolingo's remembered account (2026-10-23): a pointer-only element inside the password
  // form, beside the shown address.
  const remembered = `
    <form><div><div><div>
      <h1>Welcome Back!</h1><div>T</div><div>x@example.com</div>
      <div data-test="use-another-account" style="cursor: pointer"><span>Use another account</span></div>
    </div></div></div>
    <input id="password" type="password" placeholder="Password"><button>Log in</button></form>`;

  it("finds the page's one control for another account, also inside a form with a shown field", () => {
    document.body.innerHTML = remembered;
    expect(accountSwitchControls(document).map((element) => element.dataset["test"])).toEqual([
      "use-another-account",
    ]);
    document.body.innerHTML = `<form><input type="password"><a href="/signin">別のアカウントでログイン</a></form>`;
    expect(accountSwitchControls(document)).toHaveLength(1);
  });

  it("leaves out a submit button, page chrome, a long text, a text naming an account and another action", () => {
    for (const html of [
      `<form><input type="password"><button>Use another account</button></form>`,
      `<header><a href="/switch">Switch accounts</a></header><input type="password">`,
      `<input type="password"><a href="/x">${"Use another account ".repeat(4)}</a>`,
      `<input type="password"><button type="button">Not x@example.com? Use another account</button>`,
      `<input type="password"><button type="button">Use another account 1234</button>`,
      `<input type="password"><span>Use another account</span>`,
      `<input type="password"><button type="button">Add another account</button>`,
      `<input type="password"><a href="/x">Sign out of other accounts</a>`,
      `<input type="password"><a href="/x">別のアカウントを追加</a>`,
    ]) {
      document.body.innerHTML = html;
      expect(accountSwitchControls(document), html).toEqual([]);
    }
    document.body.innerHTML = `<form><input type="password"><button type="button">Use another account</button></form>`;
    expect(accountSwitchControls(document)).toHaveLength(1);
  });
});

describe("otherAccountMiss", () => {
  it("finds a control to sign in with another account by its words, whatever its element type", () => {
    for (const text of [
      "Switch accounts",
      "Log into another account",
      "別のアカウントでログイン",
      "ユーザーを切り替える",
    ]) {
      document.body.innerHTML = `<div><span>taro</span><button>Continue</button></div><a href="/x">${text}</a>`;
      expect(otherAccountMiss(document), text).toBeUndefined();
    }
  });

  it("leaves out a control whose text or label holds a shown name, which the page sent hides", () => {
    document.body.innerHTML = `<div><h1>ログイン</h1><button>続ける</button></div><button>別のアカウントでログイン</button>`;
    expect(otherAccountMiss(document, ["ログイン"])).toBe("other-holds-name");
    document.body.innerHTML = `<div><span>taro</span><button>Go</button></div><div role="button" aria-label="Switch from taro">Switch accounts</div>`;
    expect(otherAccountMiss(document, ["taro"])).toBe("other-holds-name");
  });

  it("says why no control for another account counts, for the log", () => {
    document.body.innerHTML = instagram;
    expect(otherAccountMiss(document, ["taro.yamada"])).toBeUndefined();
    document.body.innerHTML = instagramGear;
    expect(otherAccountMiss(document, ["taro.yamada"])).toBeUndefined();
    document.body.innerHTML = `<div><span>taro</span><button>Continue</button></div><button>Not taro? Switch accounts</button>`;
    expect(otherAccountMiss(document, ["taro"])).toBe("other-holds-name");
    document.body.innerHTML = `<div><span>taro</span><button>Go</button></div><button>Switch account 1234</button>`;
    expect(otherAccountMiss(document)).toBe("other-not-clickable");
    const go = `<div><span>taro</span><button>Go</button></div>`;
    const cases: [string, string][] = [
      [
        `${go}<button>Use another profile to sign in to this site and keep your saved settings</button>`,
        "other-text-long",
      ],
      [
        `${go}<div role="button" aria-label="Use another profile"><svg></svg></div>`,
        "other-label-only",
      ],
      [`${go}<div aria-label="Use another profile"><span></span></div>`, "other-label-only"],
      [`<header><button>Switch account</button></header>${go}`, "other-in-chrome"],
      [`${go}<footer><a href="/switch">Switch account</a></footer>`, "other-in-chrome"],
      [`${go}<button disabled>Use another profile</button>`, "other-not-entry"],
      [`${go}<p>Use another profile</p>`, "other-not-entry"],
      [
        `${go}<div role="button"><span>Use another profile</span><button>x</button></div>`,
        "other-not-control",
      ],
      [`${go}<button>Other ways to sign in</button>`, "no-other"],
      [`${go}<script>/* Switch account */</script>`, "no-other"],
    ];
    for (const [html, miss] of cases) {
      document.body.innerHTML = html;
      expect(otherAccountMiss(document), html).toBe(miss);
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
    // Page text is read without format characters, such as the ZWNJ of a Persian name.
    expect(namesUsername("علیرضا", "علی\u200Cرضا")).toBe(true);
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
    // The entry that fits, not the first one.
    const second = listChoice(document, {
      username: "hanako@example.com",
      others: [],
      othersComplete: true,
      other,
    });
    expect("element" in second && second.element.textContent).toBe("hanako@example.com");
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
      miss: {
        username: "email",
        entries: 2,
        masked: 0,
        sameDomain: 2,
        fits: 0,
        beside: 0,
        other: "none",
        continue: "none",
      },
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
    // On the page with a settings gear beside the profile, 2026-10-13.
    document.body.innerHTML = instagramGear;
    const gear = listChoice(document, {
      username: "taro.yamada",
      others: [],
      othersComplete: true,
      ...buttons,
    });
    expect(gear.click).toBe("continue");
    expect("element" in gear && gear.element.getAttribute("aria-label")).toBe(
      "Continue as taro.yamada",
    );
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
    document.body.innerHTML = `<div><label><input type="radio" name="a"> taro</label>
      <label><input type="radio" name="a" checked> hanako</label><button>Continue</button></div>
      <button>Use another profile</button>`;
    expect(listChoice(document, input).click).toBe("other");
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
    ).toEqual({
      click: "none",
      miss: {
        username: "email",
        entries: 1,
        masked: 0,
        sameDomain: 1,
        fits: 0,
        beside: 0,
        other: "missing",
        continue: "none",
      },
    });
    document.body.innerHTML = `<form><input type="text" name="q"><button id="next">Next</button></form>`;
    expect(
      listChoice(document, {
        username: "taro@example.com",
        others: [],
        othersComplete: true,
        other: named,
      }),
    ).toEqual({
      click: "none",
      miss: {
        username: "email",
        entries: 0,
        masked: 0,
        sameDomain: 0,
        fits: 0,
        beside: 0,
        other: "missing",
        continue: "none",
      },
    });
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

describe("listChoice miss", () => {
  const none = (choice: ReturnType<typeof listChoice>) => {
    expect(choice.click).toBe("none");
    return "miss" in choice ? choice.miss : undefined;
  };
  const email = `
    <h1>Choose an account</h1>
    <div role="link" tabindex="0">tar***@example.com</div>
    <div role="link" tabindex="0">hanako@example.com</div>
    <div role="link" tabindex="0">jiro@other.test</div>
    <div><p>s***@example.com</p><button>Log back in</button></div>`;

  it("counts an address list's entries, masked, same-domain and fitting ones, and its buttons", () => {
    document.body.innerHTML = email;
    // The masked entry fits, but the other vault items are not all known.
    const input = { username: "taro@example.com", others: [], othersComplete: false };
    expect(none(listChoice(document, input))).toEqual({
      username: "email",
      entries: 3,
      masked: 1,
      sameDomain: 2,
      fits: 1,
      beside: 1,
      other: "none",
      continue: "none",
    });
    document.body.innerHTML = `${email}<button>Next</button><button>Next</button>`;
    expect(
      none(
        listChoice(document, {
          ...input,
          other: { by: "text", value: "Use another account" },
          continue: { by: "text", value: "Next" },
        }),
      ),
    ).toMatchObject({ other: "missing", continue: "many" });
    expect(
      none(
        listChoice(document, {
          ...input,
          username: "jiro@example.com",
          continue: { by: "text", value: "Log back in" },
        }),
      ),
    ).toMatchObject({ entries: 3, fits: 0, other: "none", continue: "one" });
  });

  it("names why a text with an @ is no entry", () => {
    document.body.innerHTML = `<p>Signed in as hanako@example.com</p>`;
    expect(
      none(
        listChoice(document, { username: "taro@example.com", others: [], othersComplete: true }),
      ),
    ).toEqual({
      username: "email",
      entries: 0,
      masked: 0,
      sameDomain: 0,
      fits: 0,
      entryMiss: "no-entry",
      beside: 0,
      other: "none",
      continue: "none",
    });
  });

  it("counts a name list's controls, the texts beside buttons and the controls naming it", () => {
    document.body.innerHTML = `<ul><li><a href="#">hanako</a></li><li><a href="#">jiro</a></li></ul>
      <div><span>hanako</span><button>Follow</button></div>`;
    // The name shows both as a control and beside a button: nothing is clicked.
    expect(
      none(
        listChoice(document, {
          username: "Hanako",
          others: [],
          othersComplete: true,
          continue: { by: "text", value: "Continue" },
        }),
      ),
    ).toEqual({
      username: "name",
      entries: 3,
      beside: 1,
      named: 1,
      other: "none",
      continue: "missing",
    });
  });

  it("counts only the texts beside buttons for an empty username", () => {
    document.body.innerHTML = instagram;
    expect(
      none(
        listChoice(document, {
          username: " ",
          others: [],
          othersComplete: true,
          continue: { by: "text", value: "Continue" },
          other: { by: "text", value: "Switch accounts" },
        }),
      ),
    ).toEqual({ username: "empty", entries: 0, beside: 1, other: "missing", continue: "one" });
  });

  it("holds no name, address or other text of the page or the account", () => {
    const misses: unknown[] = [];
    document.body.innerHTML = email;
    misses.push(
      none(
        listChoice(document, { username: "taro@example.com", others: [], othersComplete: false }),
      ),
    );
    document.body.innerHTML = `<p>Signed in as hanako@example.com</p>`;
    misses.push(
      none(
        listChoice(document, { username: "taro@example.com", others: [], othersComplete: true }),
      ),
    );
    document.body.innerHTML = `<div><span>hanako</span><button>Follow</button></div>${instagram}`;
    misses.push(
      none(listChoice(document, { username: "hanako", others: [], othersComplete: true })),
      none(listChoice(document, { username: "", others: [], othersComplete: true })),
    );
    const serialized = JSON.stringify(misses);
    for (const text of [
      "@",
      "taro",
      "hanako",
      "jiro",
      "example",
      "other.test",
      "***",
      "Choose",
      "Signed",
      "Follow",
      "Log back",
      "Continue",
      "profile",
    ])
      expect(serialized, text).not.toContain(text);
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
