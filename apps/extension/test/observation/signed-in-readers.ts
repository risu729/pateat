import type { LoginObservation } from "@pateat/contracts";
import { describe, expect, it } from "vitest";
import type { SignedInObservationTestContext } from "./context";

export function registerSignedInReaders({
  page,
  observe,
  summary,
  signedIn,
}: Pick<SignedInObservationTestContext, "page" | "observe" | "summary" | "signedIn">) {
  it("describes a page without a form by its buttons and links", () => {
    page(
      `<header><nav><a id="home" href="/home">Home</a>
        <a id="account" href="/account">Account 1234-5678</a></nav>
        <button id="logout" type="button">Sign out</button></header>
      <h1>Welcome back</h1>
      <select id="lang"><option>English</option></select>
      <p>Balance</p>`,
      "Accounts",
    );
    const observation = signedIn();
    expect(observation).toMatchObject({
      complete: true,
      title: "Accounts",
      headings: ["Welcome back"],
    });
    // A select is described by its label and place, never its options (ADR 0061, owner
    // 2026-10-23 12:26 UTC); the text before it labels it, as for an input.
    expect(summary(observation)).toEqual([
      { role: "link", target: { by: "id", value: "home" }, label: "Home" },
      { role: "link", target: { by: "id", value: "account" }, label: "Account [number]-[number]" },
      { role: "button", target: { by: "id", value: "logout" }, label: "Sign out" },
      { role: "select", target: { by: "id", value: "lang" }, label: "Welcome back" },
    ]);
    expect(JSON.stringify(observation)).not.toContain("English");
  });

  it("describes a page's selects by their labels, for a split birth date (ADR 0061)", () => {
    page(
      `<form><p>Confirm your date of birth</p>
        <label for="by">Year of birth</label>
        <select id="by" name="by"><option value="">--</option><option>1990</option></select>
        <label>Month <select name="bm"><option>4</option></select></label>
        <label>Day <select name="bd"><option>5</option></select></label>
        <select name="off" disabled><option>1</option></select>
        <select name="many" multiple><option>1</option></select>
        <select name="gone" hidden><option>1</option></select>
        <button id="confirm" type="button">Confirm</button></form>`,
    );
    const observation = signedIn();
    expect(observation.complete).toBe(true);
    expect(summary(observation)).toEqual([
      { role: "select", target: { by: "id", value: "by" }, label: "Year of birth", group: "f1" },
      { role: "select", target: { by: "name", value: "bm" }, label: "Month", group: "f1" },
      { role: "select", target: { by: "name", value: "bd" }, label: "Day", group: "f1" },
      { role: "button", target: { by: "id", value: "confirm" }, label: "Confirm", group: "f1" },
    ]);
    // An option's text never reaches the description.
    expect(JSON.stringify(observation)).not.toContain("1990");
    // At most twelve selects, so the markers keep their room.
    page(
      `${Array.from({ length: 14 }, (_, at) => `<select name="s${at}"><option>1</option></select>`).join("")}
      <button id="logout" type="button">Sign out</button>`,
    );
    const many = summary(signedIn());
    expect(many.filter((entry) => entry.role === "select")).toHaveLength(12);
    expect(many.at(-1)).toEqual({
      role: "button",
      target: { by: "id", value: "logout" },
      label: "Sign out",
    });
  });

  it("never names a marker by an ID that another load may change", () => {
    // A Mantine-built site (2026-10-13): Tabs give each tab `${useId}-tab-${value}`.
    page(
      `<header><nav><a id="mantine-ypxwydcwg-tab-mypage" href="/mypage">マイページ</a>
        <a id="account-menu" href="/account">Account</a>
        <a id="nav-k3j9x2m1q" href="/a">More</a>
        <a id="nav-p8d2w5z7c" href="/b">More</a></nav></header>
      <input id="mantine-v0zmrhrmb" aria-label="Search">`,
    );
    const observation = signedIn();
    expect(observation.complete).toBe(true);
    // Links are named by their paths instead (ADR 0029).
    expect(summary(observation)).toEqual([
      { role: "link", target: { by: "href", value: "/mypage" }, label: "マイページ" },
      { role: "link", target: { by: "id", value: "account-menu" }, label: "Account" },
      { role: "link", target: { by: "href", value: "/a" }, label: "More" },
      { role: "link", target: { by: "href", value: "/b" }, label: "More" },
    ]);
    // A field that may be a sign-in field keeps such an ID rather than leave the page
    // incomplete, as on a login page.
    page(
      `<a id="mantine-ypxwydcwg-tab-mypage" href="/mypage">マイページ</a>
      <input id="mantine-v0zmrhrmb" type="password">`,
    );
    const withField = signedIn();
    expect(withField.complete).toBe(true);
    expect(withField.candidates.map(({ target }) => target)).toEqual([
      { by: "href", value: "/mypage" },
      { by: "id", value: "mantine-v0zmrhrmb" },
    ]);
  });

  it("names a marker only by a value no hidden copy shares (ADR 0037 amendment of 2026-10-22)", () => {
    page(
      `<header><a name="account" href="/account">My page</a>
        <a name="account" href="/settings" hidden>Settings</a></header>`,
    );
    // A marker counts every copy, so the shared name never names it.
    expect(summary(signedIn())).toEqual([
      { role: "link", target: { by: "href", value: "/account" }, label: "My page" },
    ]);
  });

  it("names a field that may be a sign-in field by its visible name, never a marker", () => {
    page(
      `<a id="mantine-ypxwydcwg-tab-mypage" href="/mypage">マイページ</a>
      <input id="mantine-v0zmrhrmb" type="password" placeholder="パスワード">
      <input id="mantine-qwhxkbtfz" inputmode="numeric" maxlength="6" placeholder="6桁のコード">
      <input id="mantine-p9o8i7u6y" aria-label="Search">`,
    );
    const observation = signedIn();
    expect(observation.complete).toBe(true);
    // A name with a number, which this page's text never shows, is not used.
    expect(observation.candidates.map(({ target }) => target)).toEqual([
      { by: "href", value: "/mypage" },
      { by: "label", value: "パスワード" },
      { by: "id", value: "mantine-qwhxkbtfz" },
    ]);
  });

  it("hides every number in a signed-in page's text, whatever its length", () => {
    page(
      `<header><a id="points" href="/points">保有ポイント 1,234,567pt</a>
        <a id="miles" href="/miles">850 ポイント ①</a>
        <button id="inbox" type="button" aria-label="Inbox ٣ new">✉</button></header>
      <h1>Balance 12.50</h1><h2>Balance 7.25</h2><h3>Balance 1234.56</h3>
      <form><input id="note" type="text" aria-label="Step 2" placeholder="e.g. 7"
          aria-describedby="note-hint">
        <span id="note-hint">Step 3</span>
        <input id="memo" type="text" aria-label="Memo" aria-describedby="memo-hint">
        <span id="memo-hint">Up to 20 characters</span></form>`,
      "Account 3",
    );
    const observation = signedIn();
    // Headings that differ only in their numbers become one.
    expect(observation).toMatchObject({
      title: "Account [number]",
      headings: ["Balance [number]"],
    });
    expect(
      observation.candidates.map(({ label, placeholder, description }) => [
        label,
        placeholder,
        description,
      ]),
    ).toEqual([
      ["保有ポイント [number]pt", undefined, undefined],
      ["[number] ポイント [number]", undefined, undefined],
      ["Inbox [number] new", undefined, undefined],
      // A description that repeats the label once hidden is left out.
      ["Step [number]", "e.g. [number]", undefined],
      ["Memo", undefined, "Up to [number] characters"],
    ]);
  });

  it("sends the visible header and navigation text, hidden as the rest of the page (ADR 0029)", () => {
    page(
      `<header><span>Welcome back, taro@example.com</span> <span hidden>Secret</span>
        <nav><a href="/points">Points 1,234</a> <a href="/account">My account</a></nav></header>
      <div role="navigation"><a href="/help">Help</a></div>
      <main><p>Body text 99</p><button id="logout" type="button">Sign out</button></main>`,
    );
    expect(signedIn().headerText).toBe("Welcome back, [email] Points [number] My account Help");
    // Every element boundary separates words.
    page(
      `<header><a href="/account">Account</a><span>taro.yamada</span></header>
      <button id="logout" type="button">Sign out</button>`,
    );
    expect(signedIn().headerText).toBe("Account taro.yamada");
    // A <wbr> or a zero-width space does not split an address out of its redaction.
    page(
      `<header><span>taro.yamada@<wbr>example.com</span><span>me@&#8203;example.com</span></header>
      <button id="logout" type="button">Sign out</button>`,
    );
    expect(signedIn().headerText).toBe("[email] [email]");
    // Cut at 1,000 characters.
    page(
      `<nav>${"<a href='/x'>Menu</a> ".repeat(300)}</nav>
      <button id="logout" type="button">Sign out</button>`,
    );
    const { headerText } = signedIn();
    expect(headerText!.length).toBeLessThanOrEqual(1000);
    expect(headerText!.startsWith("Menu Menu")).toBe(true);
    // A page without a header or navigation sends none, and a login page never does.
    page(`<main><button id="logout" type="button">Sign out</button></main>`);
    expect(signedIn()).not.toHaveProperty("headerText");
    page(
      `<header><a href="/help">Help</a></header>
      <form><input id="user" name="user" autocomplete="username" aria-label="Email">
        <input id="pass" type="password" aria-label="Password"><button>Log in</button></form>`,
    );
    expect(observe()).not.toHaveProperty("headerText");
  });

  describe("behind an open modal dialog (2026-10-13)", () => {
    // A modal library marks everything beside the dialog `aria-hidden` or `inert`.
    const header = (hider: string) =>
      `<div id="app" ${hider}>
        <header><span>Taro Yamada</span><a id="logout" href="/logout">Log out</a></header>
        <main><h1>Recommended</h1><p>For you</p></main></div>`;
    const promo = (attributes: string) =>
      `<div ${attributes}><h2>Premium scout</h2>
        <button id="later" type="button">Later</button>
        <button id="check" type="button">See the message</button></div>`;
    const modal = promo('role="dialog" aria-modal="true"');
    const controls = (observation: LoginObservation) =>
      summary(observation).map(({ role, target }) => [role, target]);

    it("reads the page an `aria-hidden` ancestor hides behind the modal", () => {
      page(header('aria-hidden="true"') + modal, "Recommended | Example");
      const observation = signedIn();
      expect(observation.headerText).toBe("Taro Yamada Log out");
      expect(observation.headings).toEqual(["Recommended", "Premium scout"]);
      expect(controls(observation)).toEqual([
        ["link", { by: "id", value: "logout" }],
        ["button", { by: "id", value: "later" }],
        ["button", { by: "id", value: "check" }],
      ]);
    });

    it("reads the page an `inert` ancestor hides behind the modal, and a native modal", () => {
      page(header("inert") + modal);
      expect(signedIn().headerText).toBe("Taro Yamada Log out");
      expect(controls(signedIn())).toContainEqual(["link", { by: "id", value: "logout" }]);
      // `showModal()` makes the page inert without an attribute; the site's own one counts.
      page(header("inert") + `<dialog id="promo">${promo("")}</dialog>`);
      document.querySelector<HTMLDialogElement>("#promo")!.showModal();
      expect(signedIn().headerText).toBe("Taro Yamada Log out");
      expect(controls(signedIn())).toEqual([
        ["link", { by: "id", value: "logout" }],
        ["button", { by: "id", value: "later" }],
        ["button", { by: "id", value: "check" }],
      ]);
    });

    it("leaves a hidden page out without an open modal, and what hides inside the page", () => {
      for (const hider of ['aria-hidden="true"', "inert"]) {
        // No modal, a modal that is not shown, and a dialog that is not modal.
        for (const rest of [
          "",
          promo('role="dialog" aria-modal="true" hidden'),
          promo('role="dialog"'),
        ]) {
          page(header(hider) + rest + `<button id="other" type="button">Other</button>`);
          const observation = signedIn();
          expect(observation).not.toHaveProperty("headerText");
          expect(controls(observation)).not.toContainEqual(["link", { by: "id", value: "logout" }]);
        }
      }
      // Behind a modal, a menu hidden inside the page stays hidden.
      page(
        `<div id="app" aria-hidden="true"><header><span>Taro Yamada</span>
          <nav aria-hidden="true"><a id="drawer" href="/drawer">Drawer</a></nav></header></div>
        ${modal}`,
      );
      const observation = signedIn();
      expect(observation.headerText).toBe("Taro Yamada");
      expect(controls(observation)).not.toContainEqual(["link", { by: "id", value: "drawer" }]);
    });

    it("keeps the modal's controls on a page with more controls than the limit", () => {
      const many = Array.from(
        { length: 60 },
        (_, at) => `<a id="item-${at}" href="/item/${at}">Item</a>`,
      ).join("");
      page(`<div id="app" aria-hidden="true"><main>${many}</main></div>${modal}`);
      const kept = controls(signedIn());
      expect(kept).toHaveLength(48);
      expect(kept.slice(-2)).toEqual([
        ["button", { by: "id", value: "later" }],
        ["button", { by: "id", value: "check" }],
      ]);
    });
  });

  it("sends up to three texts near the code field, hidden as the rest of the page (ADR 0027)", () => {
    // The sentence that names the code's source sits outside the code form.
    page(
      `<header><a id="logout" href="/logout">Log out</a></header>
      <main><div><h1>Two-factor authentication</h1>
        <div><span>Enter the 6-digit code from your authenticator app.</span></div>
        <form><div><input id="otp" autocomplete="one-time-code" inputmode="numeric"
            maxlength="6" aria-label="Code"></div>
          <button id="verify" type="submit">Verify</button></form>
        <a href="/help">Lost access to your app?</a></div></main>`,
    );
    expect(signedIn().nearCode).toEqual([
      "Enter the [number]-digit code from your authenticator app.",
    ]);
    // Live regions, error messages, labels, links, buttons and headings are left out, and
    // once three texts are found nothing further up is read.
    page(
      `<div><p>Far away</p><div><div><div>
        <p role="alert">Wrong code 123456</p><p aria-live="polite">Sent again</p>
        <p id="otp-error">Code 654321 is wrong</p>
        <label for="otp">Code</label><h2>Verify</h2><a href="/sms">Use SMS instead</a>
        <span>Open your authenticator app</span>
        <div><input id="otp" autocomplete="one-time-code" aria-errormessage="otp-error">
          <small>Codes change every 30 seconds</small></div>
        <span role="button" tabindex="0">Resend</span>
        <button id="verify" type="submit">Verify</button>
        <p>Trouble? Contact support</p><p>Fourth text</p>
      </div></div></div></div>`,
    );
    // The nearest come first, then page order; they are sent in page order.
    expect(signedIn().nearCode).toEqual([
      "Open your authenticator app",
      "Codes change every [number] seconds",
      "Trouble? Contact support",
    ]);
    // Only kept texts count: one repeating the label, a timer and one typed character in a
    // box of its own leave room for the sentence a parent further up holds, and the text of
    // a text box is never read, even a read-only one that lets the climb go on.
    page(
      `<div><div><p>Enter the code from your authenticator app, taro@example.com</p>
        <div><span>Verification code</span><div>
          <input id="otp" autocomplete="one-time-code" aria-label="Verification code">
          <div>A</div><div>B</div><div role="textbox" aria-readonly="true">my words</div></div>
          <span>0:30</span><span>Didn't receive it?</span><span>Didn't receive it?</span>
        </div><button id="verify" type="submit">Verify</button></div></div>`,
    );
    expect(signedIn().nearCode).toEqual([
      "Enter the code from your authenticator app, [email]",
      "Didn't receive it?",
    ]);
    // A field marked invalid gets none, as its description does.
    page(
      `<div><span>Open your authenticator app</span>
        <input id="otp" autocomplete="one-time-code" aria-invalid="true"></div>
      <button id="verify" type="submit">Verify</button>`,
    );
    expect(signedIn()).not.toHaveProperty("nearCode");
    // A page without a code field sends none, and a login page never does.
    page(
      `<div><span>Search the help center</span><input id="q" type="text" aria-label="Search">
        <button id="logout" type="button">Sign out</button></div>`,
    );
    expect(signedIn()).not.toHaveProperty("nearCode");
    page(
      `<form><div><span>Open your authenticator app</span>
        <input id="otp" autocomplete="one-time-code" aria-label="Code"></div>
        <button id="verify">Verify</button></form>`,
    );
    expect(observe()).not.toHaveProperty("nearCode");
  });

  it("reads text up to six parents above the code field, below any other field to type in (ADR 0027)", () => {
    // A code input wrapped in several elements, with the sentence that names the code's
    // source outside its form, e.g. a site whose sentence sits outside the form: text in
    // the fourth and sixth parents counts.
    const wrapped = (extra: number) =>
      page(
        `<main><div><p>Enter the code from your authenticator app.</p>
          ${"<div>".repeat(extra)}<div><form><p>Codes change every 30 seconds</p>
            <div><div><div><input id="otp" autocomplete="one-time-code" inputmode="numeric"
              maxlength="6" aria-label="Code"></div></div></div>
            <button id="verify" type="submit">Verify</button></form></div>${"</div>".repeat(extra)}
        </div></main>`,
      );
    wrapped(0);
    expect(signedIn().nearCode).toEqual([
      "Enter the code from your authenticator app.",
      "Codes change every [number] seconds",
    ]);
    // Text in the seventh parent does not.
    wrapped(1);
    expect(signedIn().nearCode).toEqual(["Codes change every [number] seconds"]);
    // A parent that holds another shown field to type in, such as a search box, stops the
    // climb: neither its text nor any further up is read.
    page(
      `<div><p>Far text</p>
        <div><span>Search the help center</span><input id="q" type="search" aria-label="Search">
          <div><p>Enter the code from your authenticator app.</p>
            <form><div><input id="otp" autocomplete="one-time-code" aria-label="Code"></div>
              <button id="verify" type="submit">Verify</button></form></div></div></div>`,
    );
    expect(signedIn().nearCode).toEqual(["Enter the code from your authenticator app."]);
    // So does an email field in the code's own form.
    page(
      `<div><p>Enter the code from your authenticator app.</p>
        <form><input id="email" type="email" aria-label="Email">
          <div><span>Codes change every 30 seconds</span>
            <input id="otp" autocomplete="one-time-code" aria-label="Code"></div>
          <button id="verify" type="submit">Verify</button></form></div>`,
    );
    expect(signedIn().nearCode).toEqual(["Codes change every [number] seconds"]);
    // A hidden input, a field not shown and a "Remember this device" checkbox do not.
    page(
      `<div><p>Enter the code from your authenticator app.</p>
        <form><input type="hidden" name="token" value="abc">
          <input id="backup" type="text" hidden aria-label="Backup code">
          <div><input id="otp" autocomplete="one-time-code" aria-label="Code"></div>
          <input id="remember" type="checkbox"><label for="remember">Remember this device</label>
          <button id="verify" type="submit">Verify</button></form></div>`,
    );
    expect(signedIn().nearCode).toEqual(["Enter the code from your authenticator app."]);
    // Nor does a field kept out of reach, as a form's trap for bots is.
    for (const trap of [
      '<input id="trap" type="text" aria-disabled="true" aria-label="Website">',
      '<input id="trap" type="text" tabindex="-1" aria-label="Website">',
      '<div aria-hidden="true"><input id="trap" type="text" aria-label="Website"></div>',
      '<div aria-hidden="TRUE"><input id="trap" type="text" aria-label="Website"></div>',
    ]) {
      page(
        `<div><p>Enter the code from your authenticator app.</p>
          <form>${trap}
            <div><input id="otp" autocomplete="one-time-code" aria-label="Code"></div>
            <button id="verify" type="submit">Verify</button></form></div>`,
      );
      expect(signedIn().nearCode, trap).toEqual(["Enter the code from your authenticator app."]);
    }
    // Nor does a field that cannot be typed in, e.g. the account shown read-only above the
    // code: a read-only, `aria-readonly` or disabled input.
    for (const attribute of ["readonly", 'aria-readonly="true"', "disabled"]) {
      page(
        `<div><p>Enter the code from your authenticator app.</p>
          <form><input id="account" type="email" value="taro@example.com" ${attribute}
              aria-label="Account">
            <div><input id="otp" autocomplete="one-time-code" aria-label="Code"></div>
            <button id="verify" type="submit">Verify</button></form></div>`,
      );
      expect(signedIn().nearCode, attribute).toEqual([
        "Enter the code from your authenticator app.",
      ]);
    }
    // Nor does a select, such as a choice of where the code comes from.
    page(
      `<div><p>Enter the code from your authenticator app.</p>
        <form><select id="method" aria-label="Method"><option>Authenticator app</option>
            <option>Text message</option></select>
          <div><input id="otp" autocomplete="one-time-code" aria-label="Code"></div>
          <button id="verify" type="submit">Verify</button></form></div>`,
    );
    expect(signedIn().nearCode).toEqual(["Enter the code from your authenticator app."]);
    // Shown editable text stops it, as an input does; text marked not editable does not.
    const editable = (box: string) =>
      page(
        `<div><p>Enter the code from your authenticator app.</p>
          <form>${box}
            <div><span>Codes change every 30 seconds</span>
              <input id="otp" autocomplete="one-time-code" aria-label="Code"></div>
            <button id="verify" type="submit">Verify</button></form></div>`,
      );
    for (const box of [
      "<div contenteditable>Notes</div>",
      '<div role="textbox" tabindex="0">Notes</div>',
      '<div role="searchbox" tabindex="0">Search</div>',
    ]) {
      editable(box);
      expect(signedIn().nearCode, box).toEqual(["Codes change every [number] seconds"]);
    }
    editable('<div contenteditable="false">Notes</div>');
    expect(signedIn().nearCode).toEqual([
      "Enter the code from your authenticator app.",
      "Notes",
      "Codes change every [number] seconds",
    ]);
    // An element inside the code field itself is not another field, even one that counts
    // as shown (a child with `display: contents` of a shown input).
    page(
      `<div><p>Enter the code from your authenticator app.</p>
        <form><div><input id="otp" autocomplete="one-time-code" aria-label="Code"></div>
          <button id="verify" type="submit">Verify</button></form></div>`,
    );
    const inside = document.createElement("span");
    inside.contentEditable = "true";
    inside.style.display = "contents";
    document.getElementById("otp")!.append(inside);
    expect(signedIn().nearCode).toEqual(["Enter the code from your authenticator app."]);
    // A code split into one input per digit reaches a sentence a few parents up: the other
    // one-character inputs do not stop the climb.
    const digits = Array.from(
      { length: 6 },
      (_, index) =>
        `<div><input id="d${index}" type="text" inputmode="numeric" maxlength="1"
          aria-label="Digit ${index + 1}"></div>`,
    ).join("");
    page(
      `<main><div><p>Enter the code from your authenticator app.</p>
        <form><div>${digits}</div><button id="verify" type="submit">Verify</button></form>
      </div></main>`,
    );
    expect(signedIn().nearCode).toEqual(["Enter the code from your authenticator app."]);
    // A form card that also names the device being trusted (as one page did, 2026-10-13):
    // the device name's notes stay out, and the text in the code's own group is sent.
    page(
      `<main><div><h1>Two-step verification</h1>
        <form>
          <div><p>Enter the 6-digit code from your authenticator app.</p>
            <div>${digits}</div></div>
          <div><input id="trust" type="checkbox"><label for="trust">Trust this device</label></div>
          <div><label for="device">Device name</label>
            <input id="device" type="text" value="Chrome on Windows">
            <p>※ You can rename this device</p><p>※ This cannot be changed later</p></div>
          <button id="verify" type="submit">Verify</button></form></div></main>`,
    );
    expect(signedIn().nearCode).toEqual([
      "Enter the [number]-digit code from your authenticator app.",
    ]);
  });

  it("reads a sentence of inline text near the code field whole, without excluded parts", () => {
    const near = (text: string, field = "") =>
      page(
        `<div><p>${text}</p>
          <input id="otp" autocomplete="one-time-code" aria-label="Code" ${field}></div>
        <button id="verify" type="submit">Verify</button>`,
      );
    near("Open your <strong>authenticator</strong> app<br>and enter the code.");
    expect(signedIn().nearCode).toEqual(["Open your authenticator app and enter the code."]);
    // A span may be a sentence too, inside a parent that holds a link.
    near('<span>Open your<br>authenticator app.</span> <a href="/help">Help</a>');
    expect(signedIn().nearCode).toEqual(["Open your authenticator app."]);
    // A hidden part is left out of the sentence.
    near(
      'Open your app.<span hidden>Secret words here</span><span aria-hidden="true">More words</span>',
    );
    expect(signedIn().nearCode).toEqual(["Open your app."]);
    // A live region, a part with a role or the field's error message is no inline text:
    // the parts are read alone and that one is left out, as before.
    for (const part of [
      '<span role="alert">Wrong code typed</span>',
      '<span aria-live="polite">Wrong code typed</span>',
      '<span role="link">Wrong code typed</span>',
    ]) {
      near(`<span>Open your app.</span><br>${part}`);
      expect(signedIn().nearCode, part).toEqual(["Open your app."]);
    }
    near(
      '<span>Open your app.</span><br><span id="err">Wrong code typed</span>',
      'aria-errormessage="err"',
    );
    expect(signedIn().nearCode).toEqual(["Open your app."]);
    // A sentence not shown leaves a shown part of it to be read alone.
    page(
      `<div><p style="visibility: hidden">Hidden words <span style="visibility: visible">Open your app.</span></p>
        <input id="otp" autocomplete="one-time-code" aria-label="Code"></div>
      <button id="verify" type="submit">Verify</button>`,
    );
    expect(signedIn().nearCode).toEqual(["Open your app."]);
  });

  it("never sends code-like text near the code field (ADR 0027)", () => {
    const near = (text: string) =>
      page(
        `<div><div>${text}</div>
          <input id="otp" autocomplete="one-time-code" aria-label="Code"></div>
        <button id="verify" type="submit">Verify</button>`,
      );
    // Text in `code`, `pre`, `kbd` or `samp`, which may show a setup key or recovery code,
    // is left out, and so is everything inside one.
    for (const tag of ["code", "pre", "kbd", "samp"]) {
      near(
        `<p>Enter the code from your authenticator app.</p>
        <${tag}>Setup words <span>for this app</span></${tag}><${tag}>Plain words</${tag}>`,
      );
      expect(signedIn().nearCode, tag).toEqual(["Enter the code from your authenticator app."]);
    }
    // A text that looks like a key or recovery code is never sent: an unspaced key, a key
    // in groups of capitals and digits, hyphenated groups and lowercase groups with digits.
    for (const text of [
      "Enter this key: JBSWY3DPEHPK3PXP",
      "JBSW Y3DP EHPK 3PXP",
      "ABCD EFGH IJKL",
      "abcd-efgh-ijkl",
      "a1b2 c3d4 e5f6",
      // A key with four or more digits in a row is read before redaction hides them.
      "Key: ABCDEFGH2345IJKL",
      "ABCD 2345 EFGH IJ2K",
      "Your key ABCD-EFGH-2345-IJKL",
      // An invisible character inside a key does not split it.
      "Key: JBSWY3DP\u200bEHPK3PXP",
      "Key: JBSWY3DP\u00adEHPK3PXP",
    ]) {
      near(`<span>${text}</span>`);
      expect(signedIn(), text).not.toHaveProperty("nearCode");
    }
    // Two hyphenated groups holding a letter and a digit, two words side by side of four to
    // eight letters and digits that each mix them, and four or more groups of four of which
    // two mix them are keys too. Two model names side by side look the same and are left
    // out as well, an accepted false positive.
    for (const text of [
      "a1b2c-3d4e5",
      "JBSW-Y3DP",
      "XK7Q 9PLM",
      "JBSWY3DP EHPK3PXP",
      "jbsw y3dp ehpk 3pxp",
      "Use iPhone15 iPad10",
    ]) {
      near(`<span>${text}</span>`);
      expect(signedIn(), text).not.toHaveProperty("nearCode");
    }
    // A key printed one group per element, inline or in blocks, and recovery codes one per
    // list item show as a key only in a parent's text; none of their parts is sent.
    for (const key of [
      "<p><span>JBSW</span><span>Y3DP</span><span>EHPK</span><span>3PXP</span></p>",
      "<div><div>JBSW</div><div>Y3DP</div><div>EHPK</div><div>3PXP</div></div>",
      "<ul><li>7FJ2K9PL</li><li>AB3D9XYZ</li><li>Q8RT4MNB</li><li>Z2XC7VBN</li></ul>",
    ]) {
      near(key);
      expect(signedIn(), key).not.toHaveProperty("nearCode");
    }
    // A parent that shows a key leaves out every text read in it, also those in another
    // branch than the key's; texts found nearer the field, before it was reached, stay.
    page(
      `<div><div><span>JBSW</span><span>Y3DP</span><span>EHPK</span><span>3PXP</span></div>
        <div><p>Enter the code from your authenticator app.</p>
          <div><span>Codes change every 30 seconds</span>
            <input id="otp" autocomplete="one-time-code" aria-label="Code"></div></div>
        <p>Trouble? Contact support</p></div>
      <button id="verify" type="submit">Verify</button>`,
    );
    expect(signedIn().nearCode).toEqual([
      "Enter the code from your authenticator app.",
      "Codes change every [number] seconds",
    ]);
    // Ordinary sentences are, in any language.
    near(
      `<p>Enter the 6-digit code from your authenticator app.</p><p>your code from this app</p>
      <p>認証アプリに表示されている6桁のコードを入力してください</p>`,
    );
    expect(signedIn().nearCode).toEqual([
      "Enter the [number]-digit code from your authenticator app.",
      "your code from this app",
      "認証アプリに表示されている[number]桁のコードを入力してください",
    ]);
    // So are sentences with an email address, a phone number, a device or key model or a
    // number in groups, hidden as the rest of the page.
    for (const [text, sent] of [
      ["We sent a code to user42@example.com", "We sent a code to [email]"],
      ["Code sent to yamada2024@example.com", "Code sent to [email]"],
      ["Code sent to your iPhone15", "Code sent to your iPhone[number]"],
      [
        "Enter the code we sent to +1 0123-4567-8901",
        "Enter the code we sent to +[number] [number]-[number]-[number]",
      ],
      ["Open your FIDO2 key", "Open your FIDO[number] key"],
      ["SMS to 090-1234-5678", "SMS to [number]-[number]-[number]"],
      ["Call 0123 4567 8901 for help", "Call [number] [number] [number] for help"],
      ["Dial 0800 1234 5678 for help", "Dial [number] [number] [number] for help"],
      ["CALL 0123 4567 8901", "CALL [number] [number] [number]"],
      ["Use your iPhone15 to sign in", "Use your iPhone[number] to sign in"],
      // Mixed words apart from each other are not a key.
      ["Use your iPhone15 with your iPad2", "Use your iPhone[number] with your iPad[number]"],
      ["Open Authy2 then your FIDO2 key", "Open Authy[number] then your FIDO[number] key"],
      // Nor are fewer than four groups of four, or groups of four with one mixed word.
      ["Use Pix7 with Mac2", "Use Pix[number] with Mac[number]"],
      ["Sign into your Pix7 with this code", "Sign into your Pix[number] with this code"],
      ["ABCD-EFGH", "ABCD-EFGH"],
    ]) {
      near(`<span>${text}</span>`);
      expect(signedIn().nearCode, text).toEqual([sent]);
    }
  });
}
