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
});
