import { afterEach, describe, expect, it } from "vitest";
import { pageSigns, passedCaptcha, submittedPage } from "./sign-in-state";

afterEach(() => {
  document.body.innerHTML = "";
});

const none = { password: false, code: false, captcha: false, invalid: false, alert: false };

describe("pageSigns", () => {
  it("reads a shown password input, but not one for a new password", () => {
    document.body.innerHTML = '<form><input type="password"></form>';
    expect(pageSigns(document)).toEqual({ ...none, password: true });
    document.body.innerHTML = '<form><input type="password" autocomplete="new-password"></form>';
    expect(pageSigns(document)).toEqual(none);
    // A password change form: current, new and confirmation.
    document.body.innerHTML =
      '<form><input type="password"><input type="password"><input type="password"></form>';
    expect(pageSigns(document)).toEqual(none);
    document.body.innerHTML = '<form><input type="password" style="display:none"></form>';
    expect(pageSigns(document)).toEqual(none);
    // A hidden second password input, as a honeypot, does not make it a change form.
    document.body.innerHTML =
      '<form><input type="password"><input type="password" style="display:none"></form>';
    expect(pageSigns(document)).toEqual({ ...none, password: true });
    // Inputs outside any form count as one form.
    document.body.innerHTML = '<input type="password"><input type="password">';
    expect(pageSigns(document)).toEqual(none);
  });

  it("reads a code input and a CAPTCHA widget large enough to solve", () => {
    document.body.innerHTML = '<input autocomplete="one-time-code">';
    expect(pageSigns(document)).toEqual({ ...none, code: true });
    document.body.innerHTML = '<input inputmode="numeric" maxlength="6">';
    expect(pageSigns(document)).toEqual({ ...none, code: true });
    document.body.innerHTML = '<input inputmode="numeric">';
    expect(pageSigns(document)).toEqual(none);
    const frame = (src: string, size = 'width="300" height="80"') =>
      `<iframe ${size} src="${src}"></iframe>`;
    for (const src of [
      "https://www.google.com/recaptcha/api2/anchor?k=x",
      "https://newassets.hcaptcha.com/captcha/v1/x/static/hcaptcha.html",
      "https://challenges.cloudflare.com/cdn-cgi/challenge-platform/x",
    ]) {
      document.body.innerHTML = frame(src);
      expect(pageSigns(document), src).toEqual({ ...none, captcha: true });
    }
    // An invisible check's badge, a tiny frame and another Google frame do not count.
    for (const html of [
      frame("https://www.google.com/recaptcha/api2/anchor?k=x&size=invisible"),
      frame("https://www.google.com/recaptcha/api2/anchor?k=x", 'width="10" height="10"'),
      frame("https://www.google.com/maps/embed?pb=x"),
      frame("https://["),
    ]) {
      document.body.innerHTML = html;
      expect(pageSigns(document), html).toEqual(none);
    }
  });

  it("tells a CAPTCHA that passed by its service's token field", () => {
    for (const name of ["g-recaptcha-response", "h-captcha-response", "cf-turnstile-response"]) {
      document.body.innerHTML = `<textarea name="${name}"></textarea>`;
      expect(passedCaptcha(document), name).toBe(false);
      document.body.innerHTML = `<input type="hidden" name="${name}" value="token">`;
      expect(passedCaptcha(document), name).toBe(true);
    }
    document.body.innerHTML = '<input type="hidden" name="captcha" value="token">';
    expect(passedCaptcha(document)).toBe(false);
  });

  it("reads new invalid marks and alerts only against the submitted document", () => {
    document.body.innerHTML =
      '<form><input id="user"><input id="old" aria-invalid="true"><p id="status" role="status"></p></form><input id="search"><p role="alert">Cookies are off</p>';
    expect(pageSigns(document)).toEqual(none);
    const fields = [...document.querySelectorAll<HTMLInputElement>("form input")];
    const submitted = submittedPage(document, fields);
    // Marks and messages the page already showed are not its answer.
    expect(pageSigns(document, { submitted })).toEqual(none);
    document.querySelector("#user")!.setAttribute("aria-invalid", "true");
    expect(pageSigns(document, { submitted })).toEqual({ ...none, invalid: true });
    document.querySelector("#user")!.removeAttribute("aria-invalid");
    // Only the step's sign-in inputs count, not a search box.
    document.querySelector("#search")!.setAttribute("aria-invalid", "true");
    expect(pageSigns(document, { submitted })).toEqual(none);
    // A status region inside the form counts.
    document.querySelector("#status")!.textContent = "Wrong password";
    expect(pageSigns(document, { submitted })).toEqual({ ...none, alert: true });
    document.querySelector("#status")!.textContent = "";
    document.body.insertAdjacentHTML(
      "beforeend",
      '<div aria-live="assertive">Wrong password</div>',
    );
    expect(pageSigns(document, { submitted })).toEqual({ ...none, alert: true });
    document.body.lastElementChild!.remove();
    // A live region around a button changes with its text, which is not an answer.
    document.body.insertAdjacentHTML(
      "beforeend",
      '<div aria-live="assertive"><button>Signing in…</button></div>',
    );
    expect(pageSigns(document, { submitted })).toEqual(none);
    // An alert with a close button still counts by its own text.
    document.body.insertAdjacentHTML(
      "beforeend",
      '<div role="alert">Wrong password <button aria-label="Close">×</button></div>',
    );
    expect(pageSigns(document, { submitted })).toEqual({ ...none, alert: true });
    document.body.lastElementChild!.remove();
    // A status region of another form, such as a search form, does not count.
    document.body.insertAdjacentHTML(
      "beforeend",
      '<form><input><p role="status">3 results</p></form>',
    );
    expect(pageSigns(document, { submitted })).toEqual(none);
    // Without the submitted document, nothing is compared.
    expect(pageSigns(document)).toEqual(none);
  });

  it("reads any mark and alert next to a sign-in form shown again in a new document", () => {
    document.body.innerHTML =
      '<form><input id="user"><input id="password" type="password"><p id="status" role="status"></p></form><form><input id="search"><p role="status">3 results</p></form>';
    const reshown = [...document.querySelectorAll<HTMLInputElement>("#user, #password")];
    expect(pageSigns(document, { reshown })).toEqual({
      ...none,
      password: true,
      alertMiss: "body",
    });
    // A sign-in input marked invalid, with no earlier reading to compare with.
    document.querySelector("#user")!.setAttribute("aria-invalid", "true");
    expect(pageSigns(document, { reshown })).toEqual({
      ...none,
      password: true,
      invalid: true,
      alertMiss: "body",
    });
    // Only the sign-in inputs count, not a search box.
    document.querySelector("#user")!.removeAttribute("aria-invalid");
    document.querySelector("#search")!.setAttribute("aria-invalid", "true");
    expect(pageSigns(document, { reshown })).toEqual({
      ...none,
      password: true,
      alertMiss: "body",
    });
    // Any text of a status region in the sign-in form counts, with nothing to compare.
    document.querySelector("#status")!.textContent = "Incorrect username or password.";
    const submitted = submittedPage(document, reshown);
    expect(pageSigns(document, { submitted })).toEqual({ ...none, password: true });
    expect(pageSigns(document, { reshown })).toEqual({ ...none, password: true, alert: true });
    document.querySelector("#status")!.textContent = "";
    // No sign-in input shows: no alert is taken for its answer.
    expect(pageSigns(document, { reshown: [] })).toEqual({
      ...none,
      password: true,
      alertMiss: "no-input",
    });
  });

  it("never takes a site-wide banner beside a re-shown sign-in form for its answer", () => {
    const form =
      '<form action="/session"><input name="login"><input type="password" name="password"><input type="submit" value="Sign in"></form>';
    const inputs = () => [
      ...document.querySelectorAll<HTMLInputElement>("[name=login], [name=password]"),
    ];
    // A notice at the top of the body, as a maintenance banner.
    document.body.innerHTML = `<div role="alert">Scheduled maintenance tonight</div><main><div class="box">${form}</div></main>`;
    expect(pageSigns(document, { reshown: inputs() })).toEqual({
      ...none,
      password: true,
      alertMiss: "body",
    });
    // In a wrapper that also holds the page's header, navigation or footer.
    for (const chrome of ["<header>Site</header>", "<nav>Menu</nav>", "<footer>About</footer>"]) {
      document.body.innerHTML = `<div id="page">${chrome}<div role="alert">Session expired</div><main>${form}</main></div>`;
      expect(pageSigns(document, { reshown: inputs() }), chrome).toEqual({
        ...none,
        password: true,
        alertMiss: "chrome",
      });
    }
    // Or another form, such as a search form.
    document.body.innerHTML = `<div id="page"><form><input type="search"></form><div role="alert">Session expired</div>${form}</div>`;
    expect(pageSigns(document, { reshown: inputs() })).toEqual({
      ...none,
      password: true,
      alertMiss: "other-form",
    });
    // A banner inside a dialog in the wrapper does not count either.
    document.body.innerHTML = `<div id="page"><div role="dialog"><p role="alert">Cookies</p></div>${form}</div>`;
    expect(pageSigns(document, { reshown: inputs() })).toEqual({
      ...none,
      password: true,
      alertMiss: "chrome",
    });
  });

  it("reads a flash message in the sign-in form's own container, as GitHub's", () => {
    // The shape of GitHub's sign-in page after a failed password: the flash sits beside
    // the form's body inside the sign-in box, with the page header and footer outside it.
    document.body.innerHTML = `
      <header role="banner"><a href="/">Home</a></header>
      <main><div id="login" class="auth-form">
        <div class="auth-form-header"><h1>Sign in</h1></div>
        <div id="js-flash-container"><div class="flash flash-error js-flash-alert" role="alert">
          Incorrect username or password. <button aria-label="Dismiss">x</button>
        </div></div>
        <div class="auth-form-body"><form action="/session">
          <input name="login"><input type="password" name="password">
          <input type="submit" value="Sign in">
        </form></div>
      </div></main>
      <footer role="contentinfo">Terms</footer>`;
    const reshown = [
      ...document.querySelectorAll<HTMLInputElement>("[name=login], [name=password]"),
    ];
    expect(pageSigns(document, { reshown })).toEqual({ ...none, password: true, alert: true });
    // Without the message, nothing shows.
    document.querySelector("#js-flash-container")!.innerHTML = "";
    expect(pageSigns(document, { reshown })).toEqual({
      ...none,
      password: true,
      alertMiss: "no-alert",
    });
  });

  it("reads a flash message beside a passkey and a social sign-in form (2026-10-13)", () => {
    // On 2026-10-13 GitHub's sign-in page after a wrong password showed its flash message
    // in the sign-in box, which also held a passkey form and a social sign-in form with
    // buttons and hidden inputs only (the shape is recalled, not captured). Such forms ask
    // for nothing and no longer keep the message from counting.
    document.body.innerHTML = `
      <header role="banner"><a href="/">Home</a></header>
      <main><div id="login" class="auth-form">
        <div class="flash flash-full flash-error" role="alert">Incorrect username or password.</div>
        <div class="auth-form-body"><form action="/session">
          <input name="login"><input type="password" name="password">
          <input type="hidden" name="authenticity_token" value="x">
          <input type="submit" value="Sign in">
        </form>
        <form action="/session/passkey"><input type="hidden" name="webauthn" value="x">
          <button type="submit">Sign in with a passkey</button></form>
        <form action="/auth/provider"><input type="hidden" name="state" value="x">
          <input type="checkbox" name="remember"><button>Continue with a provider</button></form>
        </div>
      </div></main>
      <footer role="contentinfo">Terms</footer>`;
    const reshown = [
      ...document.querySelectorAll<HTMLInputElement>("[name=login], [name=password]"),
    ];
    expect(pageSigns(document, { reshown })).toEqual({ ...none, password: true, alert: true });
  });

  it("never reads a message beside another form that asks for input or the main area", () => {
    const form =
      '<form action="/session"><input name="login"><input type="password" name="password"></form>';
    const inputs = () => [
      ...document.querySelectorAll<HTMLInputElement>("[name=login], [name=password]"),
    ];
    // Another form in the box with a shown text input, as a newsletter or search form.
    document.body.innerHTML = `<div class="box"><div role="alert">Subscribed</div>${form}<form><input name="email"></form></div>`;
    expect(pageSigns(document, { reshown: inputs() })).toEqual({
      ...none,
      password: true,
      alertMiss: "other-form",
    });
    // A hidden or disabled one, or one of buttons, check boxes and hidden inputs, asks for
    // nothing.
    for (const other of [
      '<form hidden><input name="email"></form>',
      '<form><input name="email" disabled></form>',
      '<form><input name="email" style="display:none"></form>',
      '<form><input type="hidden" name="challenge"><button>Sign in with a passkey</button></form>',
      '<form><input type="checkbox" name="remember"><input type="submit" value="Go"></form>',
    ]) {
      document.body.innerHTML = `<div class="box"><div role="alert">Wrong password</div>${form}${other}</div>`;
      expect(pageSigns(document, { reshown: inputs() }), other).toEqual({
        ...none,
        password: true,
        alert: true,
      });
    }
    // A text area, a select, a date or read-only date picker, an editable region, or a form
    // laid out with display: contents asks for input too.
    for (const other of [
      "<form><textarea></textarea></form>",
      "<form><select></select></form>",
      '<form><input type="date"></form>',
      '<form><input name="checkin" readonly><button>Search</button></form>',
      '<form><div contenteditable="true"></div></form>',
      '<form style="display:contents"><input name="email"></form>',
    ]) {
      document.body.innerHTML = `<div class="box"><div role="alert">Sent</div>${form}${other}</div>`;
      expect(pageSigns(document, { reshown: inputs() }), other).toEqual({
        ...none,
        password: true,
        alertMiss: "other-form",
      });
    }
    // A single-page site's root wrapper around the main area is the page, not the form's.
    for (const main of ["<main>", '<div role="main">']) {
      const close = main === "<main>" ? "</main>" : "</div>";
      document.body.innerHTML = `<div id="root"><div role="alert">New: dark mode</div>${main}${form}${close}</div>`;
      expect(pageSigns(document, { reshown: inputs() }), main).toEqual({
        ...none,
        password: true,
        alertMiss: "main",
      });
    }
  });

  it("reads an error a re-shown sign-in input names, wherever it is", () => {
    document.body.innerHTML =
      '<div role="status" id="error"></div><main><input id="user" aria-describedby="hint error"><p id="hint">Your email</p></main>';
    const reshown = [document.querySelector<HTMLInputElement>("#user")!];
    expect(pageSigns(document, { reshown })).toEqual({ ...none, alertMiss: "no-alert" });
    document.querySelector("#error")!.textContent = "Your session expired. Sign in again.";
    expect(pageSigns(document, { reshown })).toEqual({ ...none, alert: true });
    // A hidden error does not count.
    document.querySelector("#error")!.setAttribute("hidden", "");
    expect(pageSigns(document, { reshown })).toEqual({ ...none, alertMiss: "no-alert" });
  });

  it("names why no alert beside a re-shown sign-in form counted, by the closest one", () => {
    const form =
      '<form action="/session"><input name="login"><input type="password" name="password"></form>';
    const inputs = () => [
      ...document.querySelectorAll<HTMLInputElement>("[name=login], [name=password]"),
    ];
    // A banner at the top of the body fails first; the box's message beside a search form
    // comes closer to counting, so its rule is the one named.
    document.body.innerHTML = `<div role="alert">Maintenance</div><div class="box"><p role="status">Wrong password</p>${form}<form><input type="search"></form></div>`;
    expect(pageSigns(document, { reshown: inputs() }).alertMiss).toBe("other-form");
    // A region around a sign-in input and an empty one are no candidates.
    document.body.innerHTML = `<div role="alert"><p role="status"></p>${form}</div>`;
    expect(pageSigns(document, { reshown: inputs() }).alertMiss).toBe("no-alert");
    // Only for a form shown again: nothing is named in the submitted document or when F2 holds.
    document.body.innerHTML = `<div role="alert">Maintenance</div>${form}`;
    expect(pageSigns(document)).not.toHaveProperty("alertMiss");
    expect(
      pageSigns(document, { submitted: submittedPage(document, inputs()) }),
    ).not.toHaveProperty("alertMiss");
    document.body.innerHTML = `<div class="box"><div role="alert">Wrong password</div>${form}</div>`;
    expect(pageSigns(document, { reshown: inputs() })).not.toHaveProperty("alertMiss");
  });

  it("finds the username as a whole word in the header or navigation only", () => {
    document.body.innerHTML =
      "<header><a href=/me>Risu729</a></header><main>We sent a link to other@example.com</main>";
    expect(pageSigns(document, { username: "risu729" }).username).toBe(true);
    expect(pageSigns(document, { username: "risu" }).username).toBe(false);
    expect(pageSigns(document, { username: "other@example.com" }).username).toBe(false);
    document.body.innerHTML =
      '<nav><span>me@example.com</span></nav><div role="navigation">x.me@example.com</div>';
    expect(pageSigns(document, { username: "me@example.com" }).username).toBe(true);
    document.body.innerHTML = "<nav>x.me@example.com</nav>";
    expect(pageSigns(document, { username: "me@example.com" }).username).toBe(false);
    // A hidden menu and a short username do not count.
    document.body.innerHTML = "<header><span hidden>risu729</span>ab</header>";
    expect(pageSigns(document, { username: "risu729" }).username).toBe(false);
    expect(pageSigns(document, { username: "ab" }).username).toBe(false);
    expect(pageSigns(document)).not.toHaveProperty("username");
  });

  it("finds a username split by <wbr> or a format character in the navigation", () => {
    for (const html of [
      "<nav>me@<wbr>example.com</nav>",
      "<nav>me@&#8203;example.com</nav>",
      "<nav>me@example&shy;.com</nav>",
      "<header><span>taro.yamada@<wbr>example.com</span></header>",
    ]) {
      document.body.innerHTML = html;
      const username = html.includes("taro") ? "taro.yamada@example.com" : "me@example.com";
      expect.soft(pageSigns(document, { username }).username, html).toBe(true);
    }
    // A username holding a format character, such as the ZWNJ of a Persian name.
    document.body.innerHTML = "<nav>علی&zwnj;رضا</nav>";
    expect(pageSigns(document, { username: "علی\u200Cرضا" }).username).toBe(true);
  });

  it("finds the username behind an open modal dialog that hid the page (2026-10-13)", () => {
    const header = (hider: string) =>
      `<div id="app" ${hider}><header><a href="/me">risu729</a></header></div>`;
    const modal = `<div role="dialog" aria-modal="true"><button>Later</button></div>`;
    for (const hider of ['aria-hidden="true"', "inert"]) {
      document.body.innerHTML = header(hider) + modal;
      expect(pageSigns(document, { username: "risu729" }).username).toBe(true);
      // Without an open modal the hidden header still does not count.
      document.body.innerHTML = header(hider);
      expect(pageSigns(document, { username: "risu729" }).username).toBe(false);
    }
  });
});
