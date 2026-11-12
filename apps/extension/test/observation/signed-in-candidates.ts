import type { LoginObservation } from "@pateat/contracts";
import { describe, expect, it } from "vitest";
import { findTargets } from "../../src/page/targets";
import { extractLoginObservation, extractSignedInObservation } from "../../src/observation/extract";
import type { SignedInObservationTestContext } from "./context";

export function registerSignedInCandidates({
  page,
  shadow,
  observe,
  summary,
  signedIn,
}: Pick<SignedInObservationTestContext, "page" | "shadow" | "observe" | "summary" | "signedIn">) {
  it("never locates by an id or name that carries an email address or a long number", () => {
    page(
      `<a id="acct-0123456789" href="/a">Account</a>
      <a id="card-0123456789" href="/c">Card 0123456789</a>
      <button name="alice@example.com" type="button">Profile</button>
      <button id="logout" name="user-123456" type="button">Sign out</button>`,
    );
    // The links fall back to their paths (ADR 0029); the buttons to their text and id.
    expect(summary(signedIn())).toEqual([
      { role: "link", target: { by: "href", value: "/a" }, label: "Account" },
      { role: "link", target: { by: "href", value: "/c" }, label: "Card [number]" },
      { role: "button", target: { by: "text", value: "Profile" }, label: "Profile" },
      { role: "button", target: { by: "id", value: "logout" }, label: "Sign out" },
    ]);

    // Nor one that may be a token, such as an account ID.
    page(`<button id="acct-a1b2c3d4e5f6a7b8c9d0" type="button">Account</button>`);
    expect(summary(signedIn())).toEqual([
      { role: "button", target: { by: "text", value: "Account" }, label: "Account" },
    ]);

    page(`<form><input id="mail-0123456789" type="email"></form>
      <button id="logout" type="button">Sign out</button>`);
    // A field that may be a sign-in field and cannot be located safely makes the
    // description incomplete, unless its visible name locates it (ADR 0037); another
    // such field is left out.
    expect(signedIn().complete).toBe(false);
    document.querySelector("input")!.setAttribute("aria-label", "Email");
    expect(signedIn().candidates[0]!.target).toEqual({ by: "label", value: "Email" });
    page(`<form><input id="note-0123456789" type="text" aria-label="Note"></form>
      <button id="logout" type="button">Sign out</button>`);
    expect(signedIn().complete).toBe(true);
    expect(summary(signedIn()).map((entry) => entry.target.value)).toEqual(["logout"]);
  });

  it("locates a link by its path when that names nobody, else by its text (ADR 0029)", () => {
    // Shaped like ニコニコ's top bar after sign-in (2026-10-13): plain divs, and the
    // account link's only text is the person's nickname.
    page(
      `<div><a href="/my">Nick</a><a href="https://other.example/my">Elsewhere</a>
        <a href="/user/12345">Uploader</a><a href="/video_top?ref=bar#top">動画</a>
        <a href="/same">One</a><a href="/same">Two</a></div>`,
    );
    const kept = summary(signedIn());
    expect(kept).toEqual([
      { role: "link", target: { by: "href", value: "/my" }, label: "Nick" },
      { role: "link", target: { by: "text", value: "Elsewhere" }, label: "Elsewhere" },
      { role: "link", target: { by: "text", value: "Uploader" }, label: "Uploader" },
      { role: "link", target: { by: "href", value: "/video_top" }, label: "動画" },
      { role: "link", target: { by: "text", value: "One" }, label: "One" },
      { role: "link", target: { by: "text", value: "Two" }, label: "Two" },
    ]);
    // The executor finds each by the same locator, whatever the link's query or fragment.
    for (const entry of kept)
      expect(findTargets(document, entry.target, { links: true }), entry.target.value).toHaveLength(
        1,
      );
    // A login page's description never names a link by its path.
    page(`<form><input id="user" type="text"><button id="go">Go</button></form>
      <a href="/my">Nick</a>`);
    const login = extractLoginObservation();
    expect(
      login.ok && login.observation.candidates.some((entry) => entry.target.by === "href"),
    ).toBe(false);
  });

  it("never locates a link by a path that repeats its text or a header word (ADR 0029)", () => {
    page(
      `<header><span>@taro_y</span><a href="/taro_y/likes">Likes</a>
        <span>Hana · Sato @k.ito</span><a href="/hana-sato">Hana</a><a href="/k.ito/">Ito</a>
      </header>
      <main><a href="/u/Taro-Y">Taro Y</a><a href="/alice/settings">Settings</a>
        <a href="/mypage/">Account</a></main>`,
    );
    expect(summary(signedIn())).toEqual([
      { role: "link", target: { by: "text", value: "Likes" }, label: "Likes" },
      { role: "link", target: { by: "text", value: "Hana" }, label: "Hana" },
      { role: "link", target: { by: "text", value: "Ito" }, label: "Ito" },
      { role: "link", target: { by: "text", value: "Taro Y" }, label: "Taro Y" },
      { role: "link", target: { by: "text", value: "Settings" }, label: "Settings" },
      { role: "link", target: { by: "href", value: "/mypage/" }, label: "Account" },
    ]);
  });

  it("keeps every field ahead of markers and drops markers past the limit", () => {
    const links = Array.from(
      { length: 60 },
      (_, index) => `<a id="link${index}" href="/p${index}">Page ${index}</a>`,
    ).join("");
    page(`${links}<form><input id="q" type="text" aria-label="Search"></form>`);
    const observation = signedIn();
    expect(observation.complete).toBe(true);
    expect(observation.candidates).toHaveLength(48);
    // The field comes last in the page, yet it is kept; the last links are dropped.
    expect(observation.candidates.at(-1)).toMatchObject({ role: "text", target: { value: "q" } });
    expect(observation.candidates.at(-2)).toMatchObject({ target: { value: "link46" } });
  });

  // Shaped like a points site's top page after sign-in (ポイントインカム, 2026-10-12):
  // carousels, ads and news tabs, with the account links in the header carrying no id.
  const pointsSite = (header: string) => {
    const slides = Array.from(
      { length: 16 },
      (_, index) => `<a id="splide04-slide${index + 1}" href="/ad/${index}">${index + 1} of 16</a>`,
    ).join("");
    const ads = Array.from(
      { length: 40 },
      (_, index) => `<a href="/ad/detail.php?id=${index}">広告${"ア".repeat(index + 1)}で還元</a>`,
    ).join("");
    const tabs = ["総合", "芸能", "社会", "スポーツ", "経済", "国際", "IT", "ライフ"]
      .map((tab) => `<button type="button">${tab}</button>`)
      .join("");
    return `<a id="recommen_fab" href="/ad/fab">本日のイチオシ広告</a>
      <div><button id="splide02-slide01" type="button">Go to slide 1</button>${slides}</div>
      <h2>新着広告</h2>${ads}${tabs}${header}
      <div id="cbox"><button id="cboxClose" type="button">close</button></div>`;
  };
  const icon = (alt: string) => `<img src="data:," alt="${alt}" width="24" height="24">`;

  it("keeps the account links of a busy page ahead of its carousels, ads and tabs", () => {
    page(
      pointsSite(
        `<header><form><input id="search" type="text" placeholder="広告名で探す"></form>
          <a href="/my/point.php">2,358pt</a><a href="/notice/">お知らせ 7</a>
          <a href="/my/">マイページ</a><a href="/my/bankbook.php">${icon("通帳")}</a>
          <a href="/logout.php">${icon("")}</a></header>`,
      ),
      "ポイ活するなら【ポイントサイト】",
    );
    const observation = signedIn();
    expect(observation.candidates).toHaveLength(48);
    const kept = summary(observation);
    // The header comes last in the page, after more than 48 controls, yet its field and
    // its links, located by their paths (ADR 0029), are kept in document order; the ads
    // past the limit, the news tabs and the pop-up's close button are left out. The
    // sign-out icon has neither text nor `alt`, but its path locates it.
    expect(kept.slice(-6)).toEqual([
      {
        role: "text",
        target: { by: "id", value: "search" },
        placeholder: "広告名で探す",
        group: "f1",
      },
      { role: "link", target: { by: "href", value: "/my/point.php" }, label: "[number]pt" },
      { role: "link", target: { by: "href", value: "/notice/" }, label: "お知らせ [number]" },
      { role: "link", target: { by: "href", value: "/my/" }, label: "マイページ" },
      { role: "link", target: { by: "href", value: "/my/bankbook.php" }, label: "通帳" },
      { role: "link", target: { by: "href", value: "/logout.php" } },
    ]);
    expect(kept[0]).toMatchObject({ target: { by: "id", value: "recommen_fab" } });
    // The executor finds each kept link by the same locator.
    for (const entry of kept)
      expect(findTargets(document, entry.target, { links: true }), entry.target.value).toHaveLength(
        1,
      );
  });

  it("keeps navigation links after a busy page and drops other links past the limit", () => {
    page(
      pointsSite(`<nav><a href="/member/settings">設定</a></nav>
        <a href="/auth/logout">ログアウト</a>`),
    );
    const kept = summary(signedIn());
    expect(kept).toEqual(
      expect.arrayContaining([
        { role: "link", target: { by: "href", value: "/member/settings" }, label: "設定" },
      ]),
    );
    // Its words do not count: a link outside the header or navigation waits its turn.
    expect(kept.some((entry) => entry.label === "ログアウト")).toBe(false);
  });

  it("describes a split code whose inputs declare no maxlength by its first input (ADR 0027 amendment of 2026-11-04)", () => {
    // Notion's code page in the owner's Chrome on 2026-11-04. The other digits are no
    // sign-in fields on their own, so they are left out without flawing the page; the
    // login finds them from the first one (`splitCodeInputs`). The texts near the code
    // are read past the row of digits, which are no other field.
    page(
      `<main><div><p>Enter the code from your authenticator app.</p><div><div><input type="text" inputmode="numeric" autocomplete="one-time-code" aria-label="Enter verification code digit 1">${[
        2, 3, 4, 5, 6,
      ]
        .map(
          (place) =>
            `<input type="text" inputmode="numeric" autocomplete="off" aria-label="Digit ${place}">`,
        )
        .join("")}</div><button id="go">Continue</button></div></div></main>`,
    );
    const result = extractSignedInObservation();
    if (!result.ok) throw new Error(result.reason);
    expect(result.observation.complete).toBe(true);
    expect(result.observation.nearCode).toEqual(["Enter the code from your authenticator app."]);
    expect(
      result.observation.candidates.flatMap(({ role, target }) =>
        role === "button" ? [] : [target],
      ),
    ).toEqual([{ by: "autocomplete", value: "one-time-code" }]);
  });

  it("describes the role buttons of a page that shows a code input (ADR 0027 amendment of 2026-11-04)", () => {
    // Notion's code page: its Continue below the code is a `<div role="button">`.
    const code = `<input type="text" inputmode="numeric" autocomplete="one-time-code" aria-label="Enter verification code digit 1">${[
      2, 3, 4, 5, 6,
    ]
      .map(
        (place) =>
          `<input type="text" inputmode="numeric" autocomplete="off" aria-label="Digit ${place}">`,
      )
      .join("")}`;
    const buttons = `<div role="button" tabindex="0" aria-disabled="true">Continue</div>
      <div role="button" tabindex="0">Try another method</div><a href="/help">Need help?</a>`;
    page(`<main><h1>Verify your identity</h1><div>${code}</div>${buttons}</main>`);
    const result = extractSignedInObservation();
    if (!result.ok) throw new Error(result.reason);
    expect(summary(result.observation).filter(({ role }) => role !== "text")).toEqual([
      { role: "button", target: { by: "text", value: "Continue" }, label: "Continue" },
      {
        role: "button",
        target: { by: "text", value: "Try another method" },
        label: "Try another method",
      },
      { role: "link", target: { by: "text", value: "Need help?" }, label: "Need help?" },
    ]);
    // The login presses Continue by it.
    expect(findTargets(document, { by: "text", value: "Continue" })).toEqual([
      document.querySelector("[role=button]"),
    ]);
    // Without a code input, such widgets stay out, and a number input counts as one only
    // with the one-time-code hint, as the service reads it without its length.
    page(`<main><h1>Home</h1>${buttons}</main>`);
    expect(summary(signedIn())).toEqual([
      { role: "link", target: { by: "text", value: "Need help?" }, label: "Need help?" },
    ]);
    page(`<main><h1>Home</h1><input id="qty" type="number" maxlength="3">${buttons}</main>`);
    expect(summary(signedIn()).some(({ role }) => role === "button")).toBe(false);
    page(`<main><h1>Home</h1>${buttons}</main>`);
    const home = extractSignedInObservation();
    if (!home.ok) throw new Error(home.reason);
    expect(summary(home.observation)).toEqual([
      { role: "link", target: { by: "text", value: "Need help?" }, label: "Need help?" },
    ]);
  });

  it("locates a split code's inputs by names that number their places (#850)", () => {
    // Slack's two-factor page (Grok Bot, 2026-10-21: `unlocated-field`): six one-digit
    // inputs with no ID or name, outside any form, each named by its place.
    const digits = (name: (place: number) => string, count = 6, extra = "") =>
      Array.from(
        { length: count },
        (_, index) =>
          `<input type="text" inputmode="numeric" maxlength="1" aria-label="${name(index + 1)}"${extra}>`,
      ).join("");
    const located = () => {
      const result = extractSignedInObservation();
      if (!result.ok) throw new Error(result.reason);
      return [
        result.observation.complete,
        result.observation.candidates.flatMap(({ role, target }) =>
          role === "button" ? [] : [target],
        ),
      ];
    };
    page(`<div>${digits((place) => `digit ${place} of 6`)}</div><button id="go">Continue</button>`);
    expect(located()).toEqual([
      true,
      Array.from({ length: 6 }, (_, index) => ({ by: "label", value: `digit ${index + 1} of 6` })),
    ]);
    const judged = extractSignedInObservation();
    if (!judged.ok) throw new Error(judged.reason);
    // The label still hides the numbers this page shows.
    expect(judged.observation.candidates[0]!.label).toBe("digit [number] of [number]");
    // On a login page too.
    const login = observe();
    expect(login.complete).toBe(true);
    expect(login.candidates[0]!.target).toEqual({ by: "label", value: "digit 1 of 6" });
    // Inside a form too.
    page(
      `<form><div>${digits((place) => `Ziffer ${place}`)}</div><button id="go">Weiter</button></form>`,
    );
    expect(located()).toEqual([
      true,
      Array.from({ length: 6 }, (_, index) => ({ by: "label", value: `Ziffer ${index + 1}` })),
    ]);
    // Not a name with a number other than the input's place or the count, nor inputs that
    // are no split code.
    for (const html of [
      digits((place) => `digit ${place + 10}`),
      digits((place) => `Sent to ••• 4 2 7, digit ${place}`),
      digits((place) => `digit ${place} of 6, step 2`),
      digits((place) => `digit ${place} of 6`, 5),
      digits((place) => `digit ${place} of 6`, 9),
      digits((place) => `digit ${place} of 6`, 6, ` maxlength="2"`).replaceAll(
        `maxlength="1" `,
        "",
      ),
    ]) {
      page(`<div>${html}</div><button id="go">Continue</button>`);
      const result = extractSignedInObservation();
      expect(result.ok && [result.observation.complete, result.gap], html).toEqual([
        false,
        "unlocated-field",
      ]);
    }
  });

  it("marks a page incomplete when a field cannot be described, and says why", () => {
    const gap = () => {
      const result = extractSignedInObservation();
      return result.ok ? [result.observation.complete, result.gap] : result.reason;
    };
    // A field nothing can locate counts only when it may be a sign-in field.
    for (const field of [
      `<input type="password">`,
      `<input type="email">`,
      `<input autocomplete="username"><input autocomplete="username">`,
      `<input inputmode="numeric" maxlength="6">`,
      `<input class="q"><input class="q" type="password">`,
      // One password field of its form, beside one of another form.
      `<form><input type="password"></form><form><input type="password"></form>`,
    ]) {
      page(`<button id="logout">Sign out</button>${field}`);
      expect(gap(), field).toEqual([false, "unlocated-field"]);
    }
    // Others, such as a search box with no ID, are left out (Grafana Cloud and Wise,
    // 2026-10-12: `unlocated-field`; which field it was is inferred).
    for (const field of [
      `<input placeholder="Search">`,
      `<input type="text" autocomplete="off">`,
      `<input type="tel"><input type="tel">`,
      // A password change form, as S2 reads it (JP BANKカードWEB's optional password
      // change page, 2026-10-12: `unlocated-field`; which field it was is inferred).
      `<input type="password"><input type="password"><input type="password">`,
      `<input type="password" autocomplete="new-password">`,
    ]) {
      page(`<button id="logout">Sign out</button><form>${field}</form>`);
      expect(gap(), field).toEqual([true, undefined]);
      expect(summary(signedIn()).map((entry) => entry.target.value)).toEqual(["logout"]);
    }
    // Outside any form, the fields count as one form.
    page(`<button id="logout">Sign out</button><input type="password"><input type="password">`);
    expect(gap()).toEqual([true, undefined]);
    page(`<button id="logout">Sign out</button><input id="pin" type="password" readonly>`);
    expect(gap()).toEqual([false, "unfillable-field"]);
    // A disabled field that may not be a sign-in field is left out, and the result says so:
    // it may still be a code field waiting for a timer or a sent code, so only `signed-in`
    // completes such a page (owner, 2026-10-12, ADR 0029; Q-move's history page after a
    // sign-in, 2026-10-12: `disabled-field`, never judged; which field it was is inferred).
    for (const field of [
      `<input id="otp" name="otp" disabled>`,
      `<input id="date" type="text" disabled>`,
      `<input id="f" type="tel" maxlength="11" disabled>`,
    ]) {
      page(`<button id="logout">Sign out</button><form>${field}</form>`);
      const result = extractSignedInObservation();
      expect(result, field).toMatchObject({
        ok: true,
        observation: { complete: true },
        disabledLeftOut: true,
      });
      expect(result).not.toHaveProperty("gap");
      expect(summary(signedIn()).map((entry) => entry.target.value)).toEqual(["logout"]);
    }
    // A disabled field that may be a sign-in field still makes the page incomplete.
    for (const field of [
      `<input id="f" autocomplete="one-time-code" disabled>`,
      `<input id="f" autocomplete="current-password" disabled>`,
      `<input id="f" autocomplete="username" disabled>`,
      `<input id="f" type="password" disabled>`,
      `<input id="f" type="email" disabled>`,
      `<input id="f" inputmode="numeric" maxlength="6" disabled>`,
    ]) {
      page(`<button id="logout">Sign out</button><input id="date" disabled>${field}`);
      expect(gap(), field).toEqual([false, "unfillable-field"]);
    }
    // Other fields that cannot be filled are left out without the mark.
    page(`<button id="logout">Sign out</button><input id="date" type="text" readonly>`);
    expect(extractSignedInObservation()).not.toHaveProperty("disabledLeftOut");
    // A read-only field that may be a sign-in field.
    for (const field of [
      `<input id="f" autocomplete="section-a username" readonly>`,
      `<input id="f" autocomplete="email" readonly>`,
      `<input id="f" type="email" readonly>`,
      `<input id="f" autocomplete="current-password" readonly>`,
      `<input id="f" autocomplete="new-password" readonly>`,
      `<input id="f" autocomplete="one-time-code" readonly>`,
      `<input id="f" inputmode="numeric" maxlength="6" readonly>`,
      `<input id="f" type="tel" maxlength="10" readonly>`,
      `<input id="f" type="number" maxlength="1" readonly>`,
      `<input id="f" type="text" autocomplete="username" style="opacity: 0">`,
    ]) {
      page(`<button id="logout">Sign out</button>${field}`);
      expect(gap(), field).toEqual([false, "unfillable-field"]);
    }
    // Any other field that cannot be filled is left out: read-only, transparent or tiny.
    // The read-only date picker of a hotel search is the inferred case (アパホテル,
    // 2026-10-12; the log showed only `unfillable-field`).
    for (const field of [
      `<input id="date" type="text" readonly>`,
      `<input id="f" type="tel" maxlength="11" readonly>`,
      `<input id="f" inputmode="numeric" readonly>`,
      `<input id="f" type="text" style="opacity: 0">`,
      `<input id="f" type="text" autocomplete="on" style="opacity: 0">`,
      `<input id="f" type="text" autocomplete="off" style="width: 1px; height: 1px; padding: 0; border: 0">`,
    ]) {
      page(`<button id="logout">Sign out</button><form>${field}</form>`);
      expect(gap(), field).toEqual([true, undefined]);
      expect(summary(signedIn()).map((entry) => entry.target.value)).toEqual(["logout"]);
    }
    page(
      `<button id="logout">Sign out</button>${Array.from({ length: 49 }, (_, index) => `<input id="f${index}">`).join("")}`,
    );
    expect(gap()).toEqual([false, "too-many-fields"]);
    // A shadow root's fields are the page's own (ADR 0070): a search box is left out, a
    // password field without a locator is not.
    page(`<button id="logout">Sign out</button><div id="host"></div>`);
    shadow("#host", "<input>");
    expect(gap()).toEqual([true, undefined]);
    page(`<button id="logout">Sign out</button><main><div id="host"></div></main>`);
    shadow("#host", `<input type="password">`, "closed");
    expect(gap()).toEqual([false, "unlocated-field"]);
    page(`<button id="logout">Sign out</button><input id="q">`);
    expect(gap()).toEqual([true, undefined]);
  });

  it("says when a signed-in page shows a choice or answer it leaves out (ADR 0065)", () => {
    const flagged = (markup: string) => {
      page(`<button id="logout">Sign out</button>${markup}`);
      const result = extractSignedInObservation();
      expect(result, markup).toMatchObject({ ok: true, observation: { complete: true } });
      return (result as { inputLeftOut?: true }).inputLeftOut === true;
    };
    // "Send the code to: [SMS] [Email] [Continue]", however the choice is built.
    const card = (input: string) =>
      `<form><label class="card">${input.replaceAll("$", "sms")} Text message</label>` +
      `<label class="card">${input.replaceAll("$", "email")} Email</label>` +
      `<button id="continue">Continue</button></form>`;
    for (const markup of [
      card(`<input type="radio" name="via" value="$">`),
      // A styled radio: transparent, tiny or not rendered under its label "card".
      card(`<input type="radio" name="via" value="$" style="opacity: 0; position: absolute">`),
      card(`<input type="radio" name="via" value="$" style="width: 1px; height: 1px">`),
      card(`<input type="radio" name="via" value="$" style="display: none">`),
      card(`<input type="radio" name="via" value="$" disabled>`),
      // ARIA radios, and other ARIA widgets.
      `<div role="radiogroup" aria-label="Send the code to">` +
        `<div role="radio" aria-checked="true" tabindex="0">Text message</div>` +
        `<div role="radio" aria-checked="false" tabindex="-1">Email</div></div>` +
        `<button id="continue">Continue</button>`,
      `<div role="combobox" aria-label="Method" tabindex="0">Text message</div>`,
      `<ul role="listbox" aria-label="Method"><li role="option">Text message</li></ul>`,
      `<div role="textbox" contenteditable="true" aria-label="Answer"></div>`,
      // Selects and text areas, disabled ones too.
      `<form><select id="via"><option>Text message</option><option>Email</option></select></form>`,
      `<form><select id="via" disabled><option>Text message</option></select></form>`,
      `<textarea id="answer"></textarea>`,
      `<textarea id="answer" disabled></textarea>`,
      // A site search box in the same form exempts only itself.
      `<form><input type="search" id="q" aria-label="Search">` +
        `<label><input type="radio" name="via" value="sms"> Text message</label>` +
        `<label><input type="radio" name="via" value="email"> Email</label>` +
        `<button id="continue">Continue</button></form>`,
      // A footer exempts only a picker: its radios and text areas still count, and a
      // card's or section's own footer is no page footer.
      `<footer><label><input type="radio" name="via" value="sms"> Text message</label></footer>`,
      `<div role="contentinfo"><textarea id="answer"></textarea></div>`,
      `<section><footer><select id="via"><option>Text message</option></select></footer></section>`,
      `<form><input type="search" id="q"><input id="email" type="email">` +
        `<select id="via"><option>Text message</option></select><button id="go">Go</button></form>`,
    ])
      expect(flagged(markup), markup).toBe(true);
    // Part of a site search, or hidden with its container, says nothing.
    for (const markup of [
      `<form role="search"><select id="in"><option>All</option></select></form>`,
      `<search><select id="in"><option>All</option></select></search>`,
      `<nav role="search"><input role="combobox" aria-label="Search"></nav>`,
      `<form><input type="search" id="q"><select id="in"><option>All</option></select>` +
        `<button id="go">Go</button></form>`,
      `<input id="q" role="combobox" placeholder="Search the docs">`,
      `<div hidden><select id="in"><option>All</option></select></div>`,
      // A page footer's language picker.
      `<footer><select id="lang"><option>English</option><option>日本語</option></select></footer>`,
      `<div role="contentinfo"><div role="combobox" aria-label="Language" tabindex="0">English</div></div>`,
      `<footer><form><select id="lang"><option>English</option></select></form></footer>`,
      `<div style="display: none"><label><input type="radio" name="via"> Email</label></div>`,
    ])
      expect(flagged(markup), markup).toBe(false);
  });

  it("reports a still-visible sign-in field so the service can refuse the page", () => {
    page(`<form><input id="pw" type="password"><button id="go">Sign in</button></form>`);
    expect(summary(signedIn())).toEqual([
      { role: "password", target: { by: "id", value: "pw" }, group: "f1" },
      { role: "button", target: { by: "id", value: "go" }, label: "Sign in", group: "f1" },
    ]);
  });

  it("refuses a page with nothing to describe", () => {
    page(`<p>Loading</p>`);
    expect(extractSignedInObservation()).toEqual({ ok: false, reason: "no-candidates" });
  });

  it("leaves out another extension's overlay, as on Notion's loading page (2026-11-04)", () => {
    // Notion's empty shell at `/` in the owner's Chrome, read with only Claude in Chrome's
    // buttons (1.0.105): a closed root on an attribute-less `<div>` at the body's end.
    page(`<div id="notion-app"></div>`, "Notion");
    const host = document.createElement("div");
    document.body.append(host);
    shadow(
      "body > div:last-child",
      `<div id="claude-static-indicator-container"><span>Claude is active in this tab group</span>
        <button id="claude-static-chat-button"><span>Open chat</span></button>
        <button id="claude-static-close-button"><span>Close</span></button></div>`,
      "closed",
    );
    expect(extractSignedInObservation()).toEqual({ ok: false, reason: "no-candidates" });
    // Nor does it join the page once the page shows its own content.
    document.querySelector("#notion-app")!.innerHTML =
      `<nav><a href="/settings" id="settings">Settings</a></nav>`;
    const observation = signedIn();
    expect(observation.nearButtons).toBeUndefined();
    expect(summary(observation).map(({ target }) => target)).toEqual([
      { by: "id", value: "settings" },
    ]);
  });

  // A page that asks how to confirm the sign-in, as read in the owner's Chrome on
  // 2026-10-18 (values not kept): row headings, and in each row a link to `#` that shows
  // "Select", which only its accessible name tells apart and whose click a page script
  // handles (ADR 0048 amendment of 2026-10-19).
  describe("controls that show the same text and differ by their accessible names", () => {
    const style = `<style>.factor{display:inline-block;width:63px;height:40px}</style>`;
    const select = (name: string, extra = "") =>
      `<a href="#" class="factor" data-se="button" aria-label="${name}"${extra}>Select</a>`;
    const choice = (
      password = select("Select Password."),
      phone = select("Select Phone - +61 4•• ••• 123"),
    ) =>
      page(
        `${style}<main><h1>Let's confirm it's you</h1><form>
          <div><h3>Password</h3>${password}</div>
          <div><h3>Mobile</h3>${phone}</div>
        </form><a href="/signout">Cancel</a></main>
        <footer><a href="/contact">Contact us</a> <a href="/terms">Terms</a></footer>`,
        "Sign in",
      );
    const named = { by: "accessible-name", value: "Select Password." } as const;
    const byName = (observation: LoginObservation) =>
      observation.candidates.filter((candidate) => candidate.target.by === "accessible-name");

    it("offers the password one as a button located by its name, never the phone one", () => {
      choice();
      const observation = signedIn();
      expect(observation.complete).toBe(true);
      expect(summary(observation)).toEqual([
        { role: "button", target: named, label: "Select Password.", group: "f1" },
        { role: "link", target: { by: "href", value: "/signout" }, label: "Cancel" },
        { role: "link", target: { by: "text", value: "Contact us" }, label: "Contact us" },
        { role: "link", target: { by: "text", value: "Terms" }, label: "Terms" },
      ]);
      // The executor finds the same control by it.
      expect(findTargets(document, named)).toEqual([document.querySelector("a.factor")]);
    });

    it("never locates a name that holds a number", () => {
      choice(select("Select Password 2"), select("Select Phone"));
      expect(byName(signedIn())).toEqual([]);
      choice(select("Select Password."), select("Select Password 2"));
      expect(byName(signedIn()).map(({ target }) => target)).toEqual([named]);
    });

    it("offers nothing when two shown controls share the name", () => {
      choice(select("Select Password."), select("Select Password."));
      expect(byName(signedIn())).toEqual([]);
      // Nor when the other one is a button that shows text of its own.
      choice(
        select("Select Password."),
        `<button type="button" aria-label="Select Password.">Continue</button>`,
      );
      expect(byName(signedIn())).toEqual([]);
    });

    it("never counts a hidden control with the name", () => {
      for (const hidden of [
        select("Select Password.", " hidden"),
        select("Select Password.", ' style="display:none"'),
        `<button type="button" aria-label="Select Password." hidden>Select</button>`,
      ]) {
        choice(select("Select Password."), hidden);
        expect(
          byName(signedIn()).map(({ target }) => target),
          hidden,
        ).toEqual([named]);
      }
    });

    it("needs a name that names the password and a text with no other way", () => {
      for (const password of [
        select("Select Phone"),
        `<button type="button" aria-label="Select Password.">Send code</button>`,
        `<a href="#" aria-label="Select Password.">Use mobile</a>`,
      ]) {
        choice(password, select("Select Phone"));
        expect(byName(signedIn()), password).toEqual([]);
      }
      // Text hidden from assistive technology, or too long to read in full, still counts.
      for (const password of [
        `<a href="#" aria-label="Select Password."><span aria-hidden="true">Send code</span></a>`,
        `<a href="#" aria-label="Select Password.">Send a code to your phone${" now".repeat(40)}</a>`,
        `<a href="#" aria-label="Select Password.">${"Select ".repeat(80)}</a>`,
        `<a href="#" aria-label="Select Password.">Sign out</a>`,
      ]) {
        choice(password, select("Select Phone"));
        expect(byName(signedIn()), password).toEqual([]);
      }
      // A name that redaction would change, as one that holds an email address.
      for (const name of ["Use password for taro@example.com", "Use password ••••"]) {
        choice(select(name), select("Select Phone"));
        expect(byName(signedIn()), name).toEqual([]);
      }
      choice(select("Use password for Taro"), select("Select Phone"));
      expect(byName(signedIn()).map(({ target }) => target)).toEqual([
        { by: "accessible-name", value: "Use password for Taro" },
      ]);
      // A link to a route of the page's router is no control here.
      choice(
        `<a href="#/account/delete" aria-label="Select Password.">Select</a>`,
        select("Select Phone"),
      );
      expect(byName(signedIn())).toEqual([]);
      // A name from `aria-labelledby` comes before `aria-label`.
      choice(
        `<span id="row">Password</span><button type="button" aria-labelledby="row" aria-label="Select Phone">Select</button>`,
        `<button type="button" aria-label="Select Phone">Select</button>`,
      );
      expect(byName(signedIn()).map(({ target }) => target)).toEqual([
        { by: "accessible-name", value: "Password" },
      ]);
    });

    it("keeps a button's unique text and attribute locators first", () => {
      choice(
        `<button type="button" aria-label="Select Password.">Use password</button>`,
        `<button type="button" data-testid="phone" aria-label="Select Phone">Select</button>`,
      );
      expect(summary(signedIn()).slice(0, 2)).toEqual([
        {
          role: "button",
          target: { by: "text", value: "Use password" },
          label: "Select Password.",
          group: "f1",
        },
        {
          role: "button",
          target: { by: "test-id", value: "phone" },
          label: "Select Phone",
          group: "f1",
        },
      ]);
    });

    it("counts a link as such a button only when it stays on its document in the same tab", () => {
      // Fragment links with their own `onclick` are script buttons already.
      const onclick = ' onclick="void 0"';
      choice(select("Select Password.", onclick), select("Select Phone", onclick));
      expect(summary(signedIn())[0]).toEqual({
        role: "button",
        target: named,
        label: "Select Password.",
        group: "f1",
      });
      for (const extra of [' target="_blank"', " download", ' target="other"']) {
        choice(select("Select Password.", extra), select("Select Phone"));
        expect(byName(signedIn()), extra).toEqual([]);
      }
      // An empty `href` reloads the page.
      choice(`<a href="" aria-label="Select Password.">Select</a>`, select("Select Phone"));
      expect(byName(signedIn())).toEqual([]);
      const base = document.createElement("base");
      document.head.append(base);
      try {
        // A `<base target>` opens it elsewhere, and a `<base href>` naming another document
        // makes `#` navigate there.
        base.target = "_blank";
        choice();
        expect(byName(signedIn())).toEqual([]);
        base.removeAttribute("target");
        base.href = "https://elsewhere.example/";
        choice();
        expect(byName(signedIn())).toEqual([]);
        // One that names this document keeps it here.
        base.href = location.href;
        choice();
        expect(byName(signedIn()).map(({ target }) => target)).toEqual([named]);
      } finally {
        base.remove();
      }
    });

    it("is never offered on a login page", () => {
      page(
        `${style}<form><input id="pw" type="password">
          ${select("Select Password.")}${select("Select Phone")}
          <button id="go" type="submit">Sign in</button></form>`,
      );
      expect(byName(observe())).toEqual([]);
    });
  });

  describe("role buttons that choose the authenticator app (ADR 0081, #1152)", () => {
    // Notion's "Verify your identity" page in the owner's Chrome on 2026-11-03: each way is
    // a `<div role="button">` with no attribute that names it, its app's name above.
    const option = (...lines: string[]) =>
      `<div role="button" tabindex="0">${lines.map((line) => `<div>${line}</div>`).join("")}</div>`;
    const chooser = (app = option("Bitwarden", "Use code from authenticator")) =>
      page(
        `<main><h1>Verify your identity</h1>${app}${option("+81 •••• ••• 12", "Text me a code")}
          ${option("Use backup code", "Use a one-time backup code")}
          <div role="button" tabindex="0">Log into another account</div></main>`,
        "Notion",
      );
    const app = { by: "text", value: "Bitwarden Use code from authenticator" } as const;

    it("offers the authenticator one by its text, and no other way or widget", () => {
      chooser();
      const observation = signedIn();
      expect(observation.headings).toEqual(["Verify your identity"]);
      expect(summary(observation)).toEqual([{ role: "button", target: app, label: app.value }]);
      // The login presses the same element by it.
      expect(findTargets(document, app)).toEqual([document.querySelector("[role=button]")]);
      // A signed-in marker's lookup takes links, never such a widget.
      expect(findTargets(document, app, { links: true })).toEqual([]);
    });

    it("never offers one that names another way, even in hidden text", () => {
      chooser(
        `<div role="button" tabindex="0"><div>Use code from authenticator</div>
          <span style="display:none">or text me</span></div>`,
      );
      expect(extractSignedInObservation()).toEqual({ ok: false, reason: "no-candidates" });
      chooser(option("Set up an authenticator app"));
      expect(extractSignedInObservation()).toEqual({ ok: false, reason: "no-candidates" });
    });

    it("locates the native button, never the widget, when both carry the same text", () => {
      chooser();
      document
        .querySelector("main")!
        .insertAdjacentHTML("beforeend", `<button>Bitwarden Use code from authenticator</button>`);
      expect(summary(signedIn())).toEqual([{ role: "button", target: app, label: app.value }]);
      expect(findTargets(document, app)).toEqual([document.querySelector("button")]);
    });

    it("leaves it out when a link shows the same text, keeping the page described", () => {
      chooser();
      document
        .querySelector("main")!
        .insertAdjacentHTML(
          "beforeend",
          `<a href="/help">Bitwarden Use code from authenticator</a>`,
        );
      expect(summary(signedIn())).toEqual([
        { role: "link", target: { by: "href", value: "/help" }, label: app.value },
      ]);
    });
  });

  describe("ARIA widgets an attribute names (ADR 0029 amendment of 2026-11-04)", () => {
    // Notion's signed-in sidebar in the owner's Chrome on 2026-11-04: its fixed items are
    // `<div role="tab">` with a stable ID, or `<div role="button">` with only a label,
    // beside links named by the person's own page titles.
    const sidebar = (extra = "") =>
      page(
        `<nav>
          <div role="tablist" aria-label="Sidebar">
            <div role="tab" tabindex="0" id="sidebar-tab-default-home" aria-label="Home"
              aria-selected="true"><span>Home</span></div>
            <div role="tab" tabindex="0" id=":r7m:" aria-label="Chat"><span>Chat</span></div>
          </div>
          <div role="button" tabindex="0" aria-label="Library">Library</div>
          <a href="/p/risu729/cf-scoped-token-0123456789abcdef0123456789abcdef">cf scoped token</a>
          ${extra}
        </nav><main><h1>cf scoped token</h1></main>`,
        "cf scoped token | Notion",
      );
    const home = { by: "id", value: "sidebar-tab-default-home" } as const;

    it("offers a tab by its ID as a link, never a widget by its text", () => {
      sidebar();
      expect(summary(signedIn())).toEqual([
        { role: "link", target: home, label: "Home" },
        {
          role: "link",
          target: { by: "text", value: "cf scoped token" },
          label: "cf scoped token",
        },
      ]);
      // The marker's lookup finds it with no change.
      expect(findTargets(document, home, { links: true, hidden: true })).toEqual([
        document.getElementById("sidebar-tab-default-home"),
      ]);
    });

    it("offers a menu item, tree item or link widget, and leaves out what holds a link", () => {
      sidebar(
        `<div role="menuitem" id="settings-menu" tabindex="0">Settings</div>
        <div role="treeitem" id="tree-root" tabindex="0">Workspace</div>
        <span role="link" data-testid="inbox-link" tabindex="0">Inbox</span>
        <div role="treeitem" id="wrapped-item"><a href="/trash">Trash</a></div>
        <div role="tab" id="hidden-tab" style="display:none">Hidden</div>
        <div role="option" id="some-option">Option</div>`,
      );
      expect(summary(signedIn()).map(({ target }) => target)).toEqual([
        home,
        { by: "text", value: "cf scoped token" },
        { by: "id", value: "settings-menu" },
        { by: "id", value: "tree-root" },
        { by: "test-id", value: "inbox-link" },
        // The link inside the tree item, which is left out itself.
        { by: "text", value: "Trash" },
      ]);
    });

    it("leaves out a widget that holds a control, and reads only its first role", () => {
      sidebar(
        `<div role="tab" id="with-button"><button id="inner-button">Close</button></div>
        <div role="tab" id="with-role-button"><span role="button">Pin</span></div>
        <div role="tab" id="with-tab-stop"><span tabindex="0" style="cursor: pointer">Star</span></div>
        <div role="menuitem" id="with-shadow"></div>
        <div role="option tab" id="option-first">Option</div>
        <div role="tab option" name="tab-first">First</div>`,
      );
      shadow("#with-shadow", `<button>Open</button>`);
      expect(summary(signedIn()).map(({ target }) => target)).toEqual([
        home,
        { by: "text", value: "cf scoped token" },
        // The controls inside are described themselves; a role button only on a code page.
        { by: "id", value: "inner-button" },
        { by: "text", value: "Open" },
        { by: "name", value: "tab-first" },
      ]);
    });

    it("never names one by an ID shaped like a render counter", () => {
      sidebar(`<div role="tab" id="headlessui-tabs-tab-1" tabindex="0">Billing</div>`);
      expect(summary(signedIn()).map(({ target }) => target)).toEqual([
        home,
        { by: "text", value: "cf scoped token" },
      ]);
    });

    it("never names one by an ID two elements share", () => {
      sidebar(`<div role="tab" id="sidebar-tab-default-home" style="display:none">Home</div>`);
      expect(summary(signedIn()).map(({ target }) => target)).toEqual([
        { by: "text", value: "cf scoped token" },
      ]);
    });

    it("is never offered on a login page", () => {
      page(
        `<form><div role="tab" id="tab-email" tabindex="0">Email</div>
          <input id="user" autocomplete="username"><button id="go">Next</button></form>`,
      );
      expect(summary(observe()).map(({ target }) => target)).toEqual([
        { by: "id", value: "user" },
        { by: "id", value: "go" },
      ]);
    });
  });
}
