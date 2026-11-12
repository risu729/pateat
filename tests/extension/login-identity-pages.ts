import { createHmac } from "node:crypto";
import { bitwardenTotpSecret } from "../../packages/bitwarden/src/__fixtures__/totp";
import { html } from "./login-page";

/**
 * The RFC 6238 codes (SHA-1, six digits, 30-second steps) of a Base32 TOTP key for the
 * step before now and the next four, so a page served now still takes the code an
 * authenticator shows when a login fills it a minute or two later.
 */
function totpCodes(secret: string, now = Date.now()): string[] {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  let bits = "";
  for (const character of secret) bits += alphabet.indexOf(character).toString(2).padStart(5, "0");
  const key = Buffer.from((bits.match(/.{8}/gu) ?? []).map((byte) => Number.parseInt(byte, 2)));
  const step = Math.floor(now / 30_000);
  return [-1, 0, 1, 2, 3, 4].map((offset) => {
    const counter = Buffer.alloc(8);
    counter.writeBigUInt64BE(BigInt(step + offset));
    const digest = createHmac("sha1", key).update(counter).digest();
    const at = digest[19]! & 0x0f;
    return String((digest.readUInt32BE(at) & 0x7fffffff) % 1_000_000).padStart(6, "0");
  });
}

export function identityPage(fixtureUrl: URL, issuedRunId: string | undefined): string {
  // The account number is a Hidden vault field, which fills only password or short
  // numeric inputs; `?account-input=text` renders a plain text input instead.
  const groupSeparator =
    fixtureUrl.searchParams.get("group-account") === "space"
      ? " "
      : fixtureUrl.searchParams.get("group-account") === "hyphen"
        ? "-"
        : undefined;
  const expectedAccount =
    groupSeparator === undefined ? "00001234" : "0000" + groupSeparator + "1234";
  const account =
    fixtureUrl.searchParams.get("account-input") === "text"
      ? '<input id="account">'
      : groupSeparator === undefined
        ? '<input id="account" inputmode="numeric" maxlength="8">'
        : '<input id="account" inputmode="numeric" maxlength="9">';
  return html(
    fixtureUrl.searchParams.has("split-forms")
      ? `<h1>Synthetic identity step</h1><form><label>Branch<input id="branch"></label></form><form><label>Account${account}</label></form><button id="next" type="button">Next</button>`
      : fixtureUrl.searchParams.has("account-form")
        ? `<h1>Synthetic identity step</h1><label>Branch<input id="branch"></label><form><label>Account${account}</label></form><button id="next" type="button">Next</button>`
        : `<h1>Synthetic identity step</h1><label>Branch<input id="branch"></label><label>Account${account}</label><button id="next" type="button">Next</button>`,
    `${
      groupSeparator === undefined
        ? ""
        : `const groupedAccount = document.getElementById('account');
        groupedAccount.addEventListener('input', () => {
          groupedAccount.value = groupedAccount.value.replace(/[- ]/g, '').replace(/(.{4})(?=.)/g, '$1' + ${JSON.stringify(groupSeparator)});
        });`
    }
        document.getElementById('next').addEventListener('click', () => {
          sessionStorage.setItem('identityClicks', String(Number(sessionStorage.getItem('identityClicks') || 0) + 1));
          sessionStorage.setItem('identity', JSON.stringify([document.getElementById('branch').value, document.getElementById('account').value]));
          sessionStorage.setItem('identityMatched', String(document.getElementById('branch').value === '007' && document.getElementById('account').value === ${JSON.stringify(expectedAccount)}));
          ${issuedRunId === undefined ? "" : `void fetch('/effect/${issuedRunId}', {method:'POST', keepalive:true, body:new URLSearchParams({source:'click', stage:'identity', branch:document.getElementById('branch').value, account:document.getElementById('account').value})});`}
          location.href = '/password${fixtureUrl.searchParams.has("slow-password") ? "?slow=1" : ""}';
        });
        ${
          fixtureUrl.searchParams.has("replace-on-fill")
            ? `document.getElementById('branch').addEventListener('input', () => {
          const previous = document.getElementById('account');
          previous.id = 'decoy';
          const replacement = document.createElement('input');
          replacement.id = 'account';
          previous.after(replacement);
        }, {once:true});`
            : ""
        }
        ${
          fixtureUrl.searchParams.has("move-on-fill")
            ? `document.getElementById('branch').addEventListener('input', () => {
          const form = document.createElement('form');
          document.body.append(form);
          form.append(document.getElementById('account'));
        }, {once:true});`
            : ""
        }`,
  );
}

export function identifierFirstPage(
  fixtureUrl: URL,
  password: string,
  accountName: string | undefined,
): string {
  // An identifier-first form (ADR 0013): Next hides the account form and, a moment
  // later, shows the password form in the same document on the same path. `?push`
  // also changes the URL with `history.pushState`, keeping the path, and `?shown` shows
  // the password form from the start. `?unknown` shows the account form again with an
  // unknown-account error instead, the password form still hidden. `?account` expects the
  // `accountName` option instead and signs in to /account, as a generated recipe's site
  // (ADR 0018). `?prefill` keeps a password input hidden from assistive technology and
  // transparent in the account form for the browser to fill, and Next keeps the account
  // form showing while it looks the account up for two and a half seconds before it
  // swaps the password form in. Only those known flags are read, and the query is never
  // written into the page.
  const push = fixtureUrl.searchParams.has("push");
  const shown = fixtureUrl.searchParams.has("shown");
  const unknown = fixtureUrl.searchParams.has("unknown");
  const toAccount = fixtureUrl.searchParams.has("account");
  const prefill = fixtureUrl.searchParams.has("prefill");
  return html(
    `<h1>Synthetic identifier-first sign-in</h1><form id="account-form"><label>Account<input id="account" autocomplete="username"></label>${prefill ? '<input id="prefill" type="password" tabindex="-1" aria-hidden="true" autocomplete="off" style="position:absolute;width:1px;height:1px;opacity:0">' : ""}<button id="next" type="button">Next</button></form><p id="account-error" hidden>Unknown account</p><form id="password-form"${shown ? "" : " hidden"}><label>Password<input id="password" type="password" autocomplete="current-password"></label><button id="login" type="button">Log in</button></form>`,
    `document.getElementById('next').addEventListener('click', () => {
          sessionStorage.setItem('identityClicks', String(Number(sessionStorage.getItem('identityClicks') || 0) + 1));
          sessionStorage.setItem('identityMatched', String(document.getElementById('account').value === ${JSON.stringify(toAccount ? accountName : "00001234")}));
          ${
            prefill
              ? "setTimeout(() => { document.getElementById('account-form').hidden = true; document.getElementById('password-form').hidden = false; }, 2500);"
              : "document.getElementById('account-form').hidden = true;"
          }
          ${push ? "history.pushState({}, '', '/identifier-first?push=1&step=password');" : ""}
          ${
            prefill
              ? ""
              : unknown
                ? "setTimeout(() => { document.getElementById('account-error').hidden = false; document.getElementById('account-form').hidden = false; }, 300);"
                : "setTimeout(() => { document.getElementById('password-form').hidden = false; }, 300);"
          }
          updateFixtureStatus();
        });
        document.getElementById('login').addEventListener('click', () => {
          sessionStorage.setItem('submitClicks', String(Number(sessionStorage.getItem('submitClicks') || 0) + 1));
          sessionStorage.setItem('passwordMatched', String(document.getElementById('password').value === ${JSON.stringify(password)}));
          location.href = ${toAccount ? "'/account'" : "'/authenticated'"};
        });`,
  );
}

export function identifierKeptPage(
  fixtureUrl: URL,
  password: string,
  accountName: string | undefined,
): string {
  // An identifier-first form that keeps its email input, filled and writable, above the
  // password input it adds in the same document on the same path, as JetBrains Account
  // does (issue #1413). Every input carries the same `data-test` value, and so does its
  // one submit button, which reads "Continue" and then "Log in" beside a "Forgot
  // password?" button without one. Its submit signs in to /account with the
  // `accountName` option. With `?code` it instead swaps a two-factor view in, in place:
  // the email and password inputs go, and a code input marked `one-time-code` with the
  // same `data-test` shows beside the same "Log in" button. Its submit signs in to
  // /account with the current code of the synthetic vault item's TOTP key
  // (`bitwardenTotpSecret`) and otherwise shows an error. Only that flag is read, and
  // the query is never written into the page.
  const code = fixtureUrl.searchParams.has("code");
  return html(
    `<h1>Log in</h1><form id="sign-in-form" novalidate><label><input id="email" name="email" autocomplete="username" inputmode="email" aria-label="Email" placeholder="Email" data-test="input__inner"></label><div id="password-slot"></div><button data-test="button" type="submit">Continue</button><div id="extra"></div></form>`,
    `const form = document.getElementById('sign-in-form');
        const email = document.getElementById('email');
        let stage = 'account';
        form.addEventListener('submit', (event) => {
          event.preventDefault();
          if (stage === 'account') {
            stage = 'lookup';
            sessionStorage.setItem('identityClicks', String(Number(sessionStorage.getItem('identityClicks') || 0) + 1));
            sessionStorage.setItem('identityMatched', String(email.value === ${JSON.stringify(accountName ?? "")}));
            updateFixtureStatus();
            setTimeout(() => {
              document.getElementById('password-slot').innerHTML = '<label><input id="password" name="password" type="password" autocomplete="current-password" aria-label="Password" placeholder="Password" data-test="input__inner"></label>';
              form.querySelector('[data-test="button"]').textContent = 'Log in';
              document.getElementById('extra').innerHTML = '<button type="button">Forgot password?</button>';
              stage = 'password';
            }, 300);
          } else if (stage === 'password') {
            sessionStorage.setItem('submitClicks', String(Number(sessionStorage.getItem('submitClicks') || 0) + 1));
            sessionStorage.setItem('passwordMatched', String(document.getElementById('password').value === ${JSON.stringify(password)}));
            ${
              code
                ? `updateFixtureStatus();
            setTimeout(() => {
              email.closest('label').remove();
              document.getElementById('password-slot').innerHTML = '<p>Enter the 6-digit code from the authenticator app.</p><label><input id="code" name="code" autocomplete="one-time-code" inputmode="numeric" aria-label="Code" placeholder="6-digit code" data-test="input__inner"></label>';
              document.getElementById('extra').innerHTML = '<button type="button">Enter a recovery code instead</button>';
              stage = 'code';
            }, 300);`
                : "location.href = '/account';"
            }
          } else if (stage === 'code') {
            const matched = ${JSON.stringify(code ? totpCodes(bitwardenTotpSecret) : [])}.includes(document.getElementById('code').value);
            sessionStorage.setItem('codeMatched', String(matched));
            if (matched) location.href = '/account';
            else document.getElementById('extra').innerHTML = '<p role="alert">That code is not valid.</p>';
          }
        });`,
  );
}

export function identifierSwapPage(password: string): string {
  // An identifier-first form that swaps its views in one document on one path (ADR
  // 0013), as some identity providers do: the form fades in, and the email view keeps
  // the password input for the browser to fill, transparent, small, fixed to a corner,
  // hidden from assistive technology and out of the tab order. Its one button reads
  // "Next"; half a second after it is pressed, as after a lookup request, the email
  // input loses its id and becomes such a hidden input in turn, the password input
  // shows as its view slides and fades in, and the same button, keeping its id, reads
  // "Sign in". Pressing it then signs in to /authenticated. The query is never read.
  return html(
    `<style>.kept{position:fixed;right:24px;bottom:24px;width:10px;height:13px;opacity:0}</style><div id="box"><h1 id="title">Sign in</h1><form id="sign-in-form" novalidate><div id="view"><label id="account-label">Account<input id="account" name="account" autocomplete="username"></label><input id="password" name="password" type="password" class="kept" tabindex="-1" aria-hidden="true" autocomplete="off"></div><input id="next" type="submit" value="Next"></form></div>`,
    `const box = document.getElementById('box');
        const view = document.getElementById('view');
        const account = document.getElementById('account');
        const password = document.getElementById('password');
        const button = document.getElementById('next');
        box.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 600, easing: 'ease-out' });
        let stage = 'account';
        document.getElementById('sign-in-form').addEventListener('submit', (event) => {
          event.preventDefault();
          if (stage === 'account') {
            stage = 'lookup';
            sessionStorage.setItem('identityClicks', String(Number(sessionStorage.getItem('identityClicks') || 0) + 1));
            sessionStorage.setItem('identityMatched', String(account.value === '00001234'));
            updateFixtureStatus();
            setTimeout(() => {
              account.removeAttribute('id');
              account.className = 'kept';
              account.tabIndex = -1;
              account.setAttribute('aria-hidden', 'true');
              document.getElementById('account-label').before(account);
              document.getElementById('account-label').remove();
              const label = document.createElement('label');
              label.append('Password');
              view.append(label);
              password.removeAttribute('class');
              password.removeAttribute('tabindex');
              password.removeAttribute('aria-hidden');
              password.setAttribute('autocomplete', 'current-password');
              label.append(password);
              document.getElementById('title').textContent = 'Enter password';
              button.value = 'Sign in';
              view.animate(
                [{ opacity: 0, transform: 'translateY(34px)' }, { opacity: 1, transform: 'none' }],
                { duration: 500, easing: 'ease-out' },
              );
              stage = 'password';
            }, 500);
          } else if (stage === 'password') {
            sessionStorage.setItem('submitClicks', String(Number(sessionStorage.getItem('submitClicks') || 0) + 1));
            sessionStorage.setItem('passwordMatched', String(password.value === ${JSON.stringify(password)}));
            location.href = '/authenticated';
          } else {
            sessionStorage.setItem('lookupClicks', String(Number(sessionStorage.getItem('lookupClicks') || 0) + 1));
          }
        });`,
  );
}

export function methodChoicePage(
  fixtureUrl: URL,
  path: string,
  password: string,
  accountName: string | undefined,
): string {
  // An identifier-first form whose Next asks how to confirm the sign-in (ADR 0048), in
  // the same document on the same path: "Password" shows the password form, "Mobile"
  // and Cancel do nothing here. `?skip` shows the password form right after Next, as a
  // site that skips the choice; `?forgot` labels the button "Forgot password?"; `?dead`
  // makes the button do nothing. Only those known flags are read, and the query is
  // never written into the page. `/method-choice-named` shows the choice as row
  // headings, each followed by a link to `#` that reads "Select", told apart only by its
  // accessible name, with no id, name, test ID, `onclick` or role, whose click the page's
  // script handles (ADR 0048 amendment of 2026-10-19). `?account` expects the
  // `accountName` option instead and signs in to /account, as a generated recipe's site
  // (ADR 0018); `?rerender` makes Next remove the account form from the document rather
  // than hide it, as a sign-in widget that renders each view anew.
  const skip = fixtureUrl.searchParams.has("skip");
  const toAccount = fixtureUrl.searchParams.has("account");
  const rerender = fixtureUrl.searchParams.has("rerender");
  const forgot = fixtureUrl.searchParams.has("forgot");
  const dead = fixtureUrl.searchParams.has("dead");
  const named = path === "/method-choice-named";
  const choices = named
    ? `<div><h3>Password</h3><a href="#" class="factor" aria-label="Select Password.">Select</a></div><div><h3>Mobile</h3><a href="#" class="factor" aria-label="Select Phone - +00 0•• ••• 000">Select</a></div>`
    : `<button id="choose-password" type="button">${forgot ? "Forgot password?" : "Password"}</button><button id="mobile" type="button">Mobile</button>`;
  const [choosePassword, chooseMobile] = named
    ? ["document.querySelectorAll('.factor')[0]", "document.querySelectorAll('.factor')[1]"]
    : ["document.getElementById('choose-password')", "document.getElementById('mobile')"];
  return html(
    `<h1>Synthetic sign-in with a choice of how to verify</h1><form id="account-form"><label>Account<input id="account" autocomplete="username"></label><button id="next" type="button">Next</button></form><section id="choice" hidden><h2>Let's confirm it's you</h2>${choices}<a id="cancel" href="#">Cancel</a></section><form id="password-form" hidden><label>Password<input id="password" type="password" autocomplete="current-password"></label><button id="login" type="button">Log in</button></form>`,
    `const count = (key) => sessionStorage.setItem(key, String(Number(sessionStorage.getItem(key) || 0) + 1));
        document.getElementById('next').addEventListener('click', () => {
          count('identityClicks');
          sessionStorage.setItem('identityMatched', String(document.getElementById('account').value === ${JSON.stringify(toAccount ? accountName : "00001234")}));
          document.getElementById('account-form')${rerender ? ".remove()" : ".hidden = true"};
          setTimeout(() => { document.getElementById(${JSON.stringify(skip ? "password-form" : "choice")}).hidden = false; }, 300);
          updateFixtureStatus();
        });
        ${choosePassword}.addEventListener('click', (event) => {
          event.preventDefault();
          count('chooseClicks');
          ${dead ? "" : "document.getElementById('choice').hidden = true; setTimeout(() => { document.getElementById('password-form').hidden = false; }, 300);"}
        });
        ${chooseMobile}.addEventListener('click', (event) => { event.preventDefault(); count('mobileClicks'); });
        document.getElementById('login').addEventListener('click', () => {
          count('submitClicks');
          sessionStorage.setItem('passwordMatched', String(document.getElementById('password').value === ${JSON.stringify(password)}));
          location.href = ${toAccount ? "'/account'" : "'/authenticated'"};
        });`,
  );
}

export function identifierPage(
  fixtureUrl: URL,
  path: string,
  accountName: string | undefined,
): string {
  // An identifier page whose Next opens the password page as a new document (ADR 0018).
  // `?again` opens /identifier/again instead, which shows the identifier form again
  // with an unknown-account error, as a site that did not know the account. `?email`
  // marks the account input for an email address and `?login` names it only `login`,
  // without `autocomplete` and with a label that names no identifier (ADR 0016).
  // `?no-button` shows no Next button until the account input has a value, as x.com's
  // sign-in does, and only beside a "Use phone" trap: Pressing Enter submits the form
  // (ADR 0064). Only these known flags are read, and the query is never written into
  // the page.
  const again = fixtureUrl.searchParams.has("again");
  const noButton = fixtureUrl.searchParams.has("no-button");
  const account = fixtureUrl.searchParams.has("email")
    ? '<input id="account" autocomplete="email">'
    : fixtureUrl.searchParams.has("login")
      ? '<input id="account" name="login">'
      : '<input id="account" autocomplete="username">';
  return html(
    `<h1>Synthetic identifier page</h1>${path === "/identifier/again" ? '<p id="account-error">Unknown account</p>' : ""}<form>${noButton ? '<button id="phone" type="button">Use phone</button>' : ""}<label>${fixtureUrl.searchParams.has("login") ? "Your handle" : "Username"}${account}</label>${noButton ? '<div id="next-placeholder">Next</div>' : '<button id="next" type="button">Next</button>'}</form>`,
    `function next(event) {
          event?.preventDefault();
          sessionStorage.setItem('identityClicks', String(Number(sessionStorage.getItem('identityClicks') || 0) + 1));
          sessionStorage.setItem('identityMatched', String(document.getElementById('account').value === ${JSON.stringify(accountName)}));
          location.href = ${again || path === "/identifier/again" ? "'/identifier/again'" : "'/identifier/password'"};
        }
        ${
          noButton
            ? `document.getElementById('phone').addEventListener('click', () => {
          sessionStorage.setItem('phoneClicks', String(Number(sessionStorage.getItem('phoneClicks') || 0) + 1));
        });
        document.getElementById('account').addEventListener('input', (event) => {
          if (!event.target.value || document.getElementById('next')) return;
          document.getElementById('next-placeholder').replaceWith(Object.assign(document.createElement('button'), { id: 'next', type: 'submit', textContent: 'Next' }));
        });
        document.querySelector('form').addEventListener('submit', next);`
            : "document.getElementById('next').addEventListener('click', next);"
        }`,
  );
}

export function identifierPasswordPage(password: string): string {
  return html(
    '<h1>Synthetic password page</h1><form><label>Password<input id="password" type="password" autocomplete="current-password"></label><button id="login" type="button">Log in</button></form>',
    `document.getElementById('login').addEventListener('click', () => {
          sessionStorage.setItem('submitClicks', String(Number(sessionStorage.getItem('submitClicks') || 0) + 1));
          sessionStorage.setItem('passwordMatched', String(document.getElementById('password').value === ${JSON.stringify(password)}));
          location.href = '/account';
        });`,
  );
}
