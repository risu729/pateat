import { createServer, type Server } from "node:http";
import { randomUUID } from "node:crypto";

type FixtureOutcome = "authenticated" | "credential-rejected" | "unknown";
export type LoginPostEvidence = {
  posts: number;
  inputPosts: number;
  clickPosts: number;
  allMatched: boolean;
};
type FixtureRun = {
  outcome: FixtureOutcome;
  holdResult: boolean;
  evidence: LoginPostEvidence;
  pending: (() => void)[];
};

function html(body: string, script = ""): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Synthetic login fixture</title></head><body>${body}<p id="fixture-status" aria-live="polite"></p><p>Close this tab and open /identity in a new tab to start another synthetic login.</p><script>
    function updateFixtureStatus() {
      document.getElementById('fixture-status').textContent =
        'Identity clicks: ' + (sessionStorage.getItem('identityClicks') || '0') +
        '; Submit clicks: ' + (sessionStorage.getItem('submitClicks') || '0') +
        '; Identity matched: ' + (sessionStorage.getItem('identityMatched') || 'false') +
        '; Password matched: ' + (sessionStorage.getItem('passwordMatched') || 'false');
    }
    ${script}
    updateFixtureStatus();
  </script></body></html>`;
}

/**
 * `password` selects the expected synthetic value, such as a fixture vault's login password;
 * `accountName` the synthetic account name the generated identifier pages expect.
 */
export async function startLoginFixture(
  port = 0,
  {
    password = "Pateat-synthetic-only!",
    accountName,
  }: { password?: string; accountName?: string } = {},
): Promise<{
  server: Server;
  origin: string;
  createRun: (outcome?: FixtureOutcome, holdResult?: boolean) => string;
  evidence: (runId: string) => LoginPostEvidence;
  releaseResult: (runId: string) => void;
  close: () => Promise<void>;
}> {
  const runs = new Map<string, FixtureRun>();
  const getRun = (runId: string): FixtureRun => {
    const run = runs.get(runId);
    if (!run) throw new Error("Unknown synthetic login run");
    return run;
  };
  const server = createServer((request, response) => {
    const fixtureUrl = new URL(request.url ?? "/", "http://fixture.test");
    const path = fixtureUrl.pathname;
    // Pages echo only a run ID this fixture issued, never other request text.
    const requestedRunId = fixtureUrl.searchParams.get("runId");
    const issuedRunId =
      requestedRunId !== null && runs.has(requestedRunId) ? requestedRunId : undefined;
    // `/sign-in-submit` is the `?button=script-url` sign-in form's own POST, which answers
    // with a redirect to the account page instead of JSON.
    const formPost = path === "/sign-in-submit";
    if ((path.startsWith("/effect/") || formPost) && request.method === "POST") {
      const run = runs.get(formPost ? (requestedRunId ?? "") : path.slice("/effect/".length));
      if (!run) {
        response.writeHead(404).end();
        return;
      }
      let body = "";
      request.setEncoding("utf8");
      request.on("data", (chunk: string) => {
        body += chunk;
        if (body.length > 4096) request.destroy();
      });
      request.on("end", () => {
        const fields = new URLSearchParams(body);
        run.evidence.posts++;
        if (fields.get("source") === "event") run.evidence.inputPosts++;
        if (fields.get("source") === "click") run.evidence.clickPosts++;
        const matched =
          fields.get("stage") === "identity"
            ? fields.get("branch") === "007" && fields.get("account") === "00001234"
            : fields.get("stage") === "account"
              ? fields.get("account") === "00001234"
              : fields.get("password") === password;
        run.evidence.allMatched &&= matched;
        // Retain counts and matched flags only, never submitted synthetic values.
        body = "";
        const finish = () => {
          if (formPost) {
            response.writeHead(303, {
              // Only fixed locations, never the query's own value.
              location:
                fixtureUrl.searchParams.get("marker") === "link"
                  ? "/account?marker=link"
                  : "/account",
              "cache-control": "no-store",
            });
            response.end();
            return;
          }
          response.writeHead(200, {
            "content-type": "application/json",
            "cache-control": "no-store",
          });
          response.end(JSON.stringify({ outcome: matched ? run.outcome : "credential-rejected" }));
        };
        if (run.holdResult) run.pending.push(finish);
        else finish();
      });
      return;
    }
    if (path === "/totp-verify") {
      // A slow code verification (ADR 0027): the code page stays until the answer arrives.
      const to = fixtureUrl.searchParams.get("to");
      setTimeout(() => {
        response.writeHead(302, {
          // Only fixed locations, never the query's own value.
          location:
            to === "/authenticated"
              ? "/authenticated"
              : to === "/totp-code?wrong"
                ? "/totp-code?wrong"
                : "/totp-code",
          "cache-control": "no-store",
        });
        response.end();
      }, 1200);
      return;
    }
    // The `/sign-in?maintenance` page answers 503 (ADR 0041).
    const maintenance = path === "/sign-in" && fixtureUrl.searchParams.has("maintenance");
    response.writeHead(maintenance ? 503 : 200, {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store",
    });
    if (path === "/input-submit" || path === "/change-submit") {
      const runId = fixtureUrl.searchParams.get("runId");
      if (!runId || !runs.has(runId)) {
        response.end(html("<h1>Unknown synthetic login run</h1>"));
        return;
      }
      const event = path === "/input-submit" ? "input" : "change";
      response.end(
        html(
          `<h1>Synthetic ${event} submission</h1><label>Password<input id="${fixtureUrl.searchParams.has("missing") ? "missing-password" : "password"}" type="password"></label><button id="login" type="button">Fallback click trap</button><p id="effect-status">No POST observed</p>`,
          `
        const password = document.querySelector('input');
        window.syntheticMutations = 0;
        async function submitEffect(source) {
          const payload = new URLSearchParams({source, password: password.value});
          const result = await fetch('/effect/${runId}', {method:'POST', body:payload}).then(response => response.json());
          document.getElementById('effect-status').textContent = 'POST result received';
          if (result.outcome === 'authenticated') document.body.insertAdjacentHTML('beforeend', '<p id="authenticated">Authenticated synthetic account</p>');
          if (result.outcome === 'credential-rejected') document.body.insertAdjacentHTML('beforeend', '<p id="rejected">Synthetic credentials rejected</p>');
        }
        password.addEventListener('${event}', () => {
          window.syntheticMutations++;
          void submitEffect('event');
        });
        document.getElementById('login').addEventListener('click', () => void submitEffect('click'));
        `,
        ),
      );
    } else if (path === "/input-advance") {
      const runId = fixtureUrl.searchParams.get("runId");
      if (!runId || !runs.has(runId)) {
        response.end(html("<h1>Unknown synthetic login run</h1>"));
        return;
      }
      response.end(
        html(
          '<h1>Synthetic input advancement</h1><label>Account<input id="account"></label><button id="next" type="button">Fallback click trap</button>',
          `
        const account = document.getElementById('account');
        async function advance(source) {
          const result = await fetch('/effect/${runId}', {method:'POST', keepalive:true, body:new URLSearchParams({source, stage:'account', account:account.value})}).then(response => response.json());
          if (result.outcome !== 'authenticated') return;
          sessionStorage.setItem('identityMatched', 'true');
          location.href = '/password?runId=${runId}';
        }
        account.addEventListener('input', () => void advance('event'));
        document.getElementById('next').addEventListener('click', () => void advance('click'));
        `,
        ),
      );
    } else if (path === "/identity") {
      // The account number is a Hidden vault field, which fills only password or short
      // numeric inputs; `?account-input=text` renders a plain text input instead.
      const account =
        fixtureUrl.searchParams.get("account-input") === "text"
          ? '<input id="account">'
          : '<input id="account" inputmode="numeric" maxlength="8">';
      response.end(
        html(
          fixtureUrl.searchParams.has("split-forms")
            ? `<h1>Synthetic identity step</h1><form><label>Branch<input id="branch"></label></form><form><label>Account${account}</label></form><button id="next" type="button">Next</button>`
            : fixtureUrl.searchParams.has("account-form")
              ? `<h1>Synthetic identity step</h1><label>Branch<input id="branch"></label><form><label>Account${account}</label></form><button id="next" type="button">Next</button>`
              : `<h1>Synthetic identity step</h1><label>Branch<input id="branch"></label><label>Account${account}</label><button id="next" type="button">Next</button>`,
          `document.getElementById('next').addEventListener('click', () => {
          sessionStorage.setItem('identityClicks', String(Number(sessionStorage.getItem('identityClicks') || 0) + 1));
          sessionStorage.setItem('identity', JSON.stringify([document.getElementById('branch').value, document.getElementById('account').value]));
          sessionStorage.setItem('identityMatched', String(document.getElementById('branch').value === '007' && document.getElementById('account').value === '00001234'));
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
        ),
      );
    } else if (path === "/identifier-first") {
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
      response.end(
        html(
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
        ),
      );
    } else if (path === "/identifier-swap") {
      // An identifier-first form that swaps its views in one document on one path (ADR
      // 0013), as some identity providers do: the form fades in, and the email view keeps
      // the password input for the browser to fill, transparent, small, fixed to a corner,
      // hidden from assistive technology and out of the tab order. Its one button reads
      // "Next"; half a second after it is pressed, as after a lookup request, the email
      // input loses its id and becomes such a hidden input in turn, the password input
      // shows as its view slides and fades in, and the same button, keeping its id, reads
      // "Sign in". Pressing it then signs in to /authenticated. The query is never read.
      response.end(
        html(
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
        ),
      );
    } else if (path === "/method-choice" || path === "/method-choice-named") {
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
      response.end(
        html(
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
        ),
      );
    } else if (path === "/identifier" || path === "/identifier/again") {
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
      response.end(
        html(
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
        ),
      );
    } else if (path === "/identifier/password") {
      response.end(
        html(
          '<h1>Synthetic password page</h1><form><label>Password<input id="password" type="password" autocomplete="current-password"></label><button id="login" type="button">Log in</button></form>',
          `document.getElementById('login').addEventListener('click', () => {
          sessionStorage.setItem('submitClicks', String(Number(sessionStorage.getItem('submitClicks') || 0) + 1));
          sessionStorage.setItem('passwordMatched', String(document.getElementById('password').value === ${JSON.stringify(password)}));
          location.href = '/account';
        });`,
        ),
      );
    } else if (path === "/keypad" || path === "/keypad-position") {
      // A read-only password input that takes its characters only from a software keyboard
      // that opens when the input is pressed (ADR 0067). Its keys change order on
      // load and after every press, show digits in full-width forms, and come as buttons,
      // input buttons and links; an image key without `alt` shows no character to Pateat,
      // though the page types `~` for it. Each press adds a mask character to the input and
      // the character to the page's own value, and counts. Keys only count a press that
      // comes with `pointerdown`, as a person's does. `?missing=X` leaves out the key for X,
      // `?open=1` shows the keypad from the start, `?maxlength=N` limits the input,
      // `?submit-at=N` submits the form by itself at the Nth character, replacing it,
      // On `/keypad-position` the keypad has no `id`, so its recipe names it by its position
      // from the input. `?keep-after=N` keeps every character after the Nth in its own value only, leaving
      // the input unchanged, and `?reject=invalid` answers the login button by marking the input invalid, with no
      // other sign. Typed input is ignored, and the page records any change to the input's
      // value that it did not make itself.
      const missing = fixtureUrl.searchParams.get("missing") ?? "";
      const open = fixtureUrl.searchParams.has("open");
      const maxLength = Number(fixtureUrl.searchParams.get("maxlength") ?? 0);
      const submitAt = Number(fixtureUrl.searchParams.get("submit-at") ?? 0);
      const keepAfter = Number(fixtureUrl.searchParams.get("keep-after") ?? 0);
      const rejectInvalid = fixtureUrl.searchParams.get("reject") === "invalid";
      const characters = [
        ..."ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-!@",
      ].filter((character) => character !== missing);
      response.end(
        html(
          `<h1>Synthetic software keyboard</h1><form><label>Password<input id="password" type="password" readonly${maxLength ? ` maxlength="${maxLength}"` : ""}></label><div${path === "/keypad" ? ' id="keypad"' : ""}${open ? "" : " hidden"}><div class="keys"></div><button type="button" id="keypad-clear">Clear</button><button type="button" class="key" data-character="~"><img src="data:image/gif;base64,R0lGODlhAQABAAAAACw=" width="20" height="20"></button></div><button id="login" type="button">Log in</button></form>`,
          `const characters = ${JSON.stringify(characters)};
          const input = document.getElementById('password');
          const keypad = document.querySelector('form > div');
          const keys = keypad.querySelector('.keys');
          let typed = '';
          let armed = null;
          const full = (character) => /[0-9]/.test(character) ? String.fromCharCode(character.charCodeAt(0) + 0xfee0) : character;
          function render() {
            const order = characters.slice();
            for (let i = order.length - 1; i > 0; i--) {
              const j = Math.floor(Math.random() * (i + 1));
              [order[i], order[j]] = [order[j], order[i]];
            }
            keys.replaceChildren(...order.map((character, index) => {
              let key;
              if (/[0-9]/.test(character)) {
                key = document.createElement('input');
                key.type = 'button';
                key.value = full(character);
              } else if (index % 2) {
                key = document.createElement('a');
                key.href = '#';
                key.textContent = character;
              } else {
                key = document.createElement('button');
                key.type = 'button';
                key.textContent = character;
              }
              key.dataset.character = character;
              key.className = 'key';
              return key;
            }));
          }
          render();
          sessionStorage.setItem('keypadPresses', '0');
          sessionStorage.setItem('foreignWrites', '0');
          input.addEventListener('click', () => { keypad.hidden = false; });
          input.addEventListener('input', () => sessionStorage.setItem('foreignWrites', String(Number(sessionStorage.getItem('foreignWrites')) + 1)));
          keypad.addEventListener('pointerdown', (event) => { armed = event.target.closest('.key'); });
          keypad.addEventListener('click', (event) => {
            event.preventDefault();
            const key = event.target.closest('.key');
            if (!key || key !== armed || !key.dataset.character) return;
            armed = null;
            typed += key.dataset.character;
            if (!${keepAfter} || typed.length <= ${keepAfter}) input.value = '\u25cf'.repeat(typed.length);
            sessionStorage.setItem('keypadPresses', String(Number(sessionStorage.getItem('keypadPresses')) + 1));
            if (typed.length === ${submitAt}) {
              submit();
              document.querySelector('form').remove();
              return;
            }
            render();
          });
          document.getElementById('keypad-clear').addEventListener('click', () => { typed = ''; input.value = ''; });
          function submit() {
            sessionStorage.setItem('submitClicks', String(Number(sessionStorage.getItem('submitClicks') || 0) + 1));
            sessionStorage.setItem('passwordMatched', String(typed === ${JSON.stringify(password)}));
            if (${rejectInvalid}) input.setAttribute('aria-invalid', 'true');
            else document.body.insertAdjacentHTML('beforeend', typed === ${JSON.stringify(password)} ? '<p id="authenticated">Authenticated</p>' : '<p id="rejected">Credentials rejected</p>');
            updateFixtureStatus();
          }
          document.getElementById('login').addEventListener('click', submit);`,
        ),
      );
    } else if (path === "/variants") {
      // Two identifier sets for one sign-in (ADR 0027): a contract number, or a branch and
      // account number, each with the password. The demo account maps only the second.
      response.end(
        html(
          '<h1>Synthetic identifier sets</h1><label>Contract number<input id="contract" inputmode="numeric" maxlength="10"></label><label>Branch<input id="branch"></label><label>Account<input id="account" inputmode="numeric" maxlength="8"></label><label>Password<input id="password" type="password"></label><button id="login" type="button">Log in</button>',
          `document.getElementById('login').addEventListener('click', () => {
          sessionStorage.setItem('submitClicks', String(Number(sessionStorage.getItem('submitClicks') || 0) + 1));
          sessionStorage.setItem('identity', JSON.stringify([document.getElementById('branch').value, document.getElementById('account').value]));
          sessionStorage.setItem('contractFilled', String(document.getElementById('contract').value !== ''));
          sessionStorage.setItem('identityMatched', String(document.getElementById('branch').value === '007' && document.getElementById('account').value === '00001234'));
          sessionStorage.setItem('passwordMatched', String(document.getElementById('password').value === ${JSON.stringify(password)}));
          location.href = '/authenticated';
        });`,
        ),
      );
    } else if (path === "/passkey") {
      // A password form and a passkey sign-in button (ADR 0027). The synthetic button signs
      // in on its own; `?stay` reloads the page instead, so the button is still shown.
      const stay = fixtureUrl.searchParams.has("stay");
      response.end(
        html(
          '<h1>Synthetic passkey sign-in</h1><main id="app"><label>Password<input id="password" type="password"></label><button id="login" type="button">Log in</button><button id="passkey" type="button">Sign in with a passkey</button></main>',
          `document.getElementById('login').addEventListener('click', () => {
          sessionStorage.setItem('submitClicks', String(Number(sessionStorage.getItem('submitClicks') || 0) + 1));
          sessionStorage.setItem('passwordMatched', String(document.getElementById('password').value === ${JSON.stringify(password)}));
          document.getElementById('app').innerHTML = '<p id="authenticated">Authenticated</p>';
          updateFixtureStatus();
        });
        document.getElementById('passkey').addEventListener('click', () => {
          sessionStorage.setItem('passkeyClicks', String(Number(sessionStorage.getItem('passkeyClicks') || 0) + 1));
          ${stay ? "location.reload();" : "setTimeout(() => { document.getElementById('app').innerHTML = '<p id=\"authenticated\">Authenticated</p>'; }, 250);"}
        });`,
        ),
      );
    } else if (path === "/totp" || path === "/totp-typed") {
      // Only the known flags go on, never the query as written.
      const flags = new URLSearchParams();
      for (const flag of ["wrong", "auto", "slow", "split"])
        if (fixtureUrl.searchParams.has(flag)) flags.set(flag, "");
      const spa = fixtureUrl.searchParams.get("spa");
      if (spa === "status" || spa === "replace") flags.set("spa", spa);
      const ui = fixtureUrl.searchParams.get("ui");
      if (
        ui === "disabled" ||
        ui === "rerender" ||
        ui === "counter" ||
        ui === "disauto" ||
        ui === "flicker" ||
        ui === "partial" ||
        ui === "mutate" ||
        ui === "seven" ||
        ui === "drop"
      )
        flags.set("ui", ui);
      // `/totp-typed` goes on to a code page without Verify that submits the code on its
      // sixth digit, in six one-digit inputs as Slack's two-factor page does (#916), or in
      // one input with `?single`; `ui=drop` keeps the digit 3 out of the input.
      if (path === "/totp-typed") {
        const typed = ["auto", "nobutton"];
        if (!fixtureUrl.searchParams.has("single")) typed.push("split");
        for (const flag of typed) flags.set(flag, "");
      }
      const next = flags.size === 0 ? "/totp-code" : `/totp-code?${flags.toString()}`;
      // A password page followed by an authenticator app code page (ADR 0027). The query
      // goes on to the code page: `?split` asks for it in six one-digit inputs, the first of
      // them `#code` (with `ui=seven`, seven; with `ui=partial`, Verify is disabled only
      // while some but not all digits are in; with `ui=mutate`, the first digit makes the
      // second input a plain text input), `?wrong` shows it again after Verify, `?auto` submits the
      // code by itself on its sixth digit, as some sites do. With `?auto`, `slow` verifies
      // it for 1.2 seconds before the next document loads, `spa=status` says "Verifying…"
      // in the form and disables Verify for that long, `spa=clear` does so and also empties
      // the code input, and `spa=replace` renders the form again as verifying, before each
      // signs in without a new document. Without `?auto`,
      // `ui` makes an ordinary page that only Verify submits: `disabled` keeps Verify
      // disabled until six digits are in, `rerender` replaces it on every input, and
      // `counter` counts the digits in a polite live region. `ui=disauto` keeps Verify
      // disabled and checks the code itself on its sixth digit for a second; a right code
      // signs in, a wrong one (`wrong`) enables Verify again for another code. `ui=flicker`
      // does the same after enabling Verify for 5 ms, as a page whose Verify is disabled
      // while the code is short or while it checks the code does.
      response.end(
        html(
          '<h1>Synthetic sign-in with a code</h1><label>Password<input id="password" type="password"></label><button id="login" type="button">Log in</button>',
          `document.getElementById('login').addEventListener('click', () => {
          sessionStorage.setItem('submitClicks', String(Number(sessionStorage.getItem('submitClicks') || 0) + 1));
          sessionStorage.setItem('identityMatched', 'true');
          sessionStorage.setItem('passwordMatched', String(document.getElementById('password').value === ${JSON.stringify(password)}));
          location.href = ${JSON.stringify(next)};
        });`,
        ),
      );
    } else if (path === "/totp-code") {
      // Records how often the code was typed, submitted by the page and Verify clicked, and
      // whether the code was the synthetic one; never the code itself.
      const auto = fixtureUrl.searchParams.has("auto");
      const slow = fixtureUrl.searchParams.has("slow");
      const spa = fixtureUrl.searchParams.get("spa");
      const ui = fixtureUrl.searchParams.get("ui");
      const split = fixtureUrl.searchParams.has("split");
      const nobutton = fixtureUrl.searchParams.has("nobutton");
      const again = fixtureUrl.searchParams.has("wrong") ? "/totp-code?wrong" : "/totp-code";
      response.end(
        html(
          `<h1>Two-factor authentication</h1><p>Enter the code from your authenticator app.</p><form id="code-form">${split ? `<fieldset><legend>Authentication code</legend><input id="code" inputmode="numeric" maxlength="1" aria-label="Digit 1">${(ui === "seven" ? [2, 3, 4, 5, 6, 7] : [2, 3, 4, 5, 6]).map((digit) => `<input id="code-${digit}" inputmode="numeric" maxlength="1" aria-label="Digit ${digit}">`).join("")}</fieldset>` : '<label>Authentication code<input id="code" autocomplete="one-time-code" inputmode="numeric" maxlength="6"></label>'}${nobutton ? "" : `<button id="verify" type="button"${ui === "disabled" || ui === "disauto" || ui === "flicker" ? " disabled" : ""}>Verify</button>`}<p role="status" id="code-status"></p>${ui === "counter" ? '<p id="code-counter" aria-live="polite"></p>' : ""}</form>`,
          `const digits = [...document.querySelectorAll('#code-form input')];
          const codeValue = () => digits.map((digit) => digit.value).join('');
          function count(name) {
            sessionStorage.setItem(name, String(Number(sessionStorage.getItem(name) || 0) + 1));
          }
          function submitCode(source) {
            count(source);
            count('codeSubmits');
            sessionStorage.setItem('codeMatched', String(codeValue() === '012345'));
            const signedIn = codeValue() === '012345' && ${JSON.stringify(again)} === '/totp-code';
            ${
              spa
                ? `${
                    spa === "replace"
                      ? `document.getElementById('code-form').innerHTML = '<input id="code" autocomplete="one-time-code" inputmode="numeric" maxlength="6" disabled><button id="verify" type="button" disabled>Verify</button><p>Verifying…</p>';`
                      : `document.getElementById('code-status').textContent = 'Verifying…';
                        document.getElementById('verify')?.setAttribute('disabled', '');${spa === "clear" ? " for (const digit of digits) digit.value = '';" : ""}`
                  }
                setTimeout(() => {
                  history.pushState({}, '', '/authenticated');
                  document.body.innerHTML = signedIn
                    ? '<h2 id="authenticated">Authenticated synthetic account</h2>'
                    : '<h2 id="rejected">Code rejected</h2>';
                }, 1200);`
                : `location.href = ${slow ? "'/totp-verify?to=' + encodeURIComponent(signedIn ? '/authenticated' : " + JSON.stringify(again) + ")" : `signedIn ? '/authenticated' : ${JSON.stringify(again)}`};`
            }
          }
          function wire(button) {
            button.addEventListener('click', () => submitCode('verifyClicks'));
          }
          for (const digit of digits) digit.addEventListener('input', () => {
            count('codeInputs');
            ${ui === "disabled" ? "document.getElementById('verify').disabled = codeValue().length !== 6;" : ""}
            ${ui === "partial" ? "document.getElementById('verify').disabled = codeValue().length > 0 && codeValue().length < 6;" : ""}
            ${ui === "mutate" ? "if (codeValue().length === 1) document.getElementById('code-2')?.removeAttribute('inputmode');" : ""}
            ${ui === "rerender" ? "const old = document.getElementById('verify'); const button = old.cloneNode(true); old.replaceWith(button); wire(button);" : ""}
            ${ui === "counter" ? "document.getElementById('code-counter').textContent = codeValue().length + ' of 6 digits';" : ""}
            ${auto ? "if (codeValue().length === 6) submitCode('autoSubmits');" : ""}
            ${
              ui === "disauto" || ui === "flicker"
                ? `if (codeValue().length === 6) {
                ${
                  ui === "flicker"
                    ? `Promise.resolve().then(() => {
                  document.getElementById('verify').disabled = false;
                  setTimeout(() => { document.getElementById('verify').disabled = true; }, 5);
                });`
                    : ""
                }
                count('autoSubmits');
                count('codeSubmits');
                sessionStorage.setItem('codeMatched', String(codeValue() === '012345'));
                const signedIn = codeValue() === '012345' && ${JSON.stringify(again)} === '/totp-code';
                setTimeout(() => {
                  if (signedIn) location.href = '/authenticated';
                  else document.getElementById('verify').disabled = false;
                }, 1000);
              }`
                : ""
            }
          });
          ${ui === "drop" ? "digits[0].addEventListener('keydown', (event) => { if (event.key === '3') event.preventDefault(); });" : ""}
          ${nobutton ? "" : "wire(document.getElementById('verify'));"}`,
        ),
      );
    } else if (path === "/password") {
      // `?slow=1` renders the form four seconds after load, past the old three-second budget.
      // `?email=1` also asks for an email, as a form for another account does (ADR 0049).
      const slow = fixtureUrl.searchParams.has("slow");
      const form = `${fixtureUrl.searchParams.has("email") ? '<label>Email<input id="other-email" type="email"></label>' : ""}<label>Password<input id="password" type="password"></label><button id="login" type="button">Log in</button>`;
      response.end(
        html(
          slow
            ? `<h1>Synthetic password step</h1><main id="app"></main><template id="login-form">${form}</template>`
            : `<h1>Synthetic password step</h1><main id="app">${form}</main>`,
          `${slow ? "setTimeout(() => { document.getElementById('app').append(document.getElementById('login-form').content.cloneNode(true)); bindLogin(); }, 4000);" : ""}
          function bindLogin() { document.getElementById('login').addEventListener('click', () => {
          sessionStorage.setItem('submitClicks', String(Number(sessionStorage.getItem('submitClicks') || 0) + 1));
          sessionStorage.setItem('passwordMatched', String(document.getElementById('password').value === ${JSON.stringify(password)}));
          ${issuedRunId === undefined ? "" : `void fetch('/effect/${issuedRunId}', {method:'POST', keepalive:true, body:new URLSearchParams({source:'click', password:document.getElementById('password').value})});`}
          location.href = '/authenticated';
        }); }
          ${slow ? "" : "bindLogin();"}`,
        ),
      );
    } else if (
      path === "/single" ||
      path === "/rejection" ||
      path === "/unknown" ||
      path === "/delayed-result"
    ) {
      // Masked login IDs such as `****1234`; anything else is left out.
      const shown = fixtureUrl.searchParams.get("shown");
      const switchTo = fixtureUrl.searchParams.get("switch");
      const masked = /^[A-Za-z0-9@.*]+$/u;
      // `?shown-late` shows the account only after a loading text changes for 1.6 s, as
      // Duolingo's remembered account shows after its password field (2026-10-23).
      const shownLate = fixtureUrl.searchParams.get("shown-late");
      // `?maxlength` limits the password input, such as below the synthetic password.
      const maxLength = fixtureUrl.searchParams.get("maxlength");
      // `?form` puts the login in a form: `same-origin` posts to this page with its submit
      // button, `script` does the same in a form whose action is a `javascript:` URL,
      // `off-origin` holds the password in a form posting to another origin, and
      // `submit-off-origin` leaves the password outside while the submit button's
      // `formaction` names another origin. Nothing submits: the page keeps every form, and
      // the `script` form's `javascript:` action does nothing.
      const form = fixtureUrl.searchParams.get("form");
      // Another site: another port of 127.0.0.1 is the same site, which the login's item
      // could allow (ADR 0051).
      const elsewhere = "http://localhost:1/collect";
      const formStart =
        {
          "same-origin": '<form action="/single">',
          script: '<form action="javascript:void(0)">',
          "off-origin": `<form action="${elsewhere}">`,
        }[form ?? ""] ?? "";
      const loginButton =
        {
          "same-origin": '<button id="login">Log in</button></form>',
          script: '<button id="login">Log in</button></form>',
          "off-origin": '<button id="login" type="button">Log in</button></form>',
          "submit-off-origin": `<form action="/single"><button id="login" formaction="${elsewhere}">Log in</button></form>`,
        }[form ?? ""] ?? '<button id="login" type="button">Log in</button>';
      response.end(
        html(
          `<h1>Synthetic single-page login</h1>${
            shown !== null && masked.test(shown) ? `<p>Signed in as ${shown}</p>` : ""
          }${shownLate !== null && masked.test(shownLate) ? `<p id="account" data-shown="Signed in as ${shownLate}">Loading</p>` : ""}${
            // `switch` names the account the "Use another account" link shows next;
            // `switch-submit` makes it the submit button of its own form instead.
            switchTo === null || !masked.test(switchTo)
              ? ""
              : fixtureUrl.searchParams.has("switch-submit")
                ? `<form action="/single"><input type="hidden" name="shown" value="${switchTo}"><button>Use another account</button></form>`
                : `<a href="/single?${new URLSearchParams({ shown: switchTo, switch: switchTo }).toString().replace(/&/gu, "&amp;")}">Use another account</a>`
          }${
            // `?reject-fill=shown` shows an alert before any fill, and re-renders it on input.
            fixtureUrl.searchParams.get("reject-fill") === "shown"
              ? '<div id="notice"><p role="alert">Your session expired</p></div>'
              : ""
          }${formStart}<label>Password<input id="password" ${
            {
              text: 'type="text"',
              "text-current-password": 'type="text" autocomplete="current-password"',
            }[fixtureUrl.searchParams.get("password-input") ?? ""] ?? 'type="password"'
          }${
            maxLength !== null && /^\d{1,3}$/u.test(maxLength) ? ` maxlength="${maxLength}"` : ""
          }></label>${
            // `?reject-fill=switch-form` keeps a second password field hidden until a fill.
            fixtureUrl.searchParams.get("reject-fill") === "switch-form"
              ? '<label>Security number<input id="security" type="password" hidden></label>'
              : ""
          }${loginButton}${
            // `?ad` embeds an unrelated frame beside the form, like an advertisement.
            fixtureUrl.searchParams.has("ad")
              ? '<iframe id="ad" title="Synthetic advertisement" src="/ad"></iframe>'
              : ""
          }${
            // `?captcha` shows a CAPTCHA widget's frame beside the form; the test serves its
            // address, so no request leaves the test browser.
            fixtureUrl.searchParams.has("captcha")
              ? '<iframe id="captcha" title="Synthetic CAPTCHA" src="https://www.google.com/recaptcha/api2/anchor?k=synthetic" width="304" height="78"></iframe>'
              : ""
          }`,
          `${
            // `?reject-fill` makes the page's own input handler reject any value: with a new
            // alert, `aria-invalid` or a custom validity message.
            {
              alert:
                "document.getElementById('password').addEventListener('input', () => setTimeout(() => document.body.insertAdjacentHTML('beforeend', '<p role=\"alert\">Enter a valid password</p>'), 100));",
              invalid:
                "document.getElementById('password').addEventListener('input', (event) => event.target.setAttribute('aria-invalid', 'true'));",
              custom:
                "document.getElementById('password').addEventListener('change', (event) => event.target.setCustomValidity('Not accepted'));",
              shown:
                "document.getElementById('password').addEventListener('input', () => { document.getElementById('notice').innerHTML = '<p role=\"alert\">Your session expired</p>'; });",
              // Switches the form under the fill, as St.George's logon with a remembered
              // access number does: every field is cleared and another one shows.
              "switch-form":
                "document.getElementById('password').addEventListener('change', (event) => { event.target.value = ''; document.getElementById('security').hidden = false; });",
            }[fixtureUrl.searchParams.get("reject-fill") ?? ""] ?? ""
          }
          ${
            shownLate !== null && masked.test(shownLate)
              ? `{ let ticks = 0; const loading = setInterval(() => { ticks += 1; document.getElementById('account').textContent = 'Loading' + '.'.repeat(ticks % 4); if (ticks === 8) { clearInterval(loading); document.getElementById('account').textContent = document.getElementById('account').dataset.shown; } }, 200); }`
              : ""
          }
          ${form === null || form === "script" ? "" : "document.getElementById('login').form?.addEventListener('submit', (event) => event.preventDefault());"}
          document.getElementById('login').addEventListener('click', () => {
          sessionStorage.setItem('submitClicks', String(Number(sessionStorage.getItem('submitClicks') || 0) + 1));
          sessionStorage.setItem('passwordMatched', String(document.getElementById('password').value === ${JSON.stringify(password)}));
          ${issuedRunId === undefined ? "" : `void fetch('/effect/${issuedRunId}', {method:'POST', keepalive:true, body:new URLSearchParams({source:'click', password:document.getElementById('password').value})});`}
          ${path === "/rejection" ? "document.body.insertAdjacentHTML('beforeend', '<p id=\"rejected\">Credentials rejected</p>');" : path === "/single" ? "document.body.insertAdjacentHTML('beforeend', sessionStorage.getItem('passwordMatched') === 'true' ? '<p id=\"authenticated\">Authenticated</p>' : '<p id=\"rejected\">Credentials rejected</p>');" : ""}
          ${path === "/delayed-result" ? `setTimeout(() => { document.body.insertAdjacentHTML('beforeend', ${fixtureUrl.searchParams.has("reject") ? "'<p id=\"rejected\">Credentials rejected</p>'" : "sessionStorage.getItem('passwordMatched') === 'true' ? '<p id=\"authenticated\">Authenticated</p>' : '<p id=\"rejected\">Credentials rejected</p>'"}); updateFixtureStatus(); }, 250);` : ""}
          updateFixtureStatus();
        });`,
        ),
      );
    } else if (path === "/text-submit") {
      // The submit button has no id or name; the recipe names it by its text.
      const variant = fixtureUrl.searchParams.get("button");
      const button =
        variant === "image"
          ? '<input class="login" type="image" src="data:," alt="Log in" width="40" height="20">'
          : '<button class="login" type="button"> Log <span>in</span> </button>';
      response.end(
        html(
          `<h1>Synthetic text-located login</h1><label>Password<input id="password" type="password"></label>${button}${variant === "duplicate" ? '<button class="login" type="button">Log in</button>' : ""}`,
          `document.querySelectorAll('.login').forEach((button) => button.addEventListener('click', (event) => {
          event.preventDefault();
          sessionStorage.setItem('submitClicks', String(Number(sessionStorage.getItem('submitClicks') || 0) + 1));
          sessionStorage.setItem('passwordMatched', String(document.getElementById('password').value === ${JSON.stringify(password)}));
          document.body.insertAdjacentHTML('beforeend', sessionStorage.getItem('passwordMatched') === 'true' ? '<p id="authenticated">Authenticated</p>' : '<p id="rejected">Credentials rejected</p>');
          updateFixtureStatus();
        }));`,
        ),
      );
    } else if (path === "/enter-submit") {
      // A form that shows no button to press (ADR 0064). `?late` adds a submit button once
      // the password has a value, as x.com's sign-in does; `?shown` shows a "Sign up"
      // submit button from the start, and `?image` a "Sign up" image input, which Enter
      // would press and Pateat never does.
      const variant = fixtureUrl.searchParams.has("late")
        ? "late"
        : fixtureUrl.searchParams.has("shown")
          ? "shown"
          : fixtureUrl.searchParams.has("image")
            ? "image"
            : "none";
      response.end(
        html(
          `<h1>Synthetic form without a button</h1><form>${variant === "shown" ? '<button id="sign-up" type="submit">Sign up</button>' : variant === "image" ? '<input id="sign-up" type="image" src="data:," alt="Sign up" width="60" height="20">' : ""}<label>Password<input id="password" type="password"></label></form>`,
          `const form = document.querySelector('form');
          const count = (key) => sessionStorage.setItem(key, String(Number(sessionStorage.getItem(key) || 0) + 1));
          ${
            variant === "late"
              ? `document.getElementById('password').addEventListener('input', () => {
            if (document.getElementById('login')) return;
            form.append(Object.assign(document.createElement('button'), { id: 'login', type: 'submit', textContent: 'Log in' }));
            document.getElementById('login').addEventListener('click', () => count('buttonClicks'));
          });`
              : ""
          }
          form.addEventListener('submit', (event) => {
            event.preventDefault();
            count('submitClicks');
            if (event.submitter?.id === 'sign-up') count('signUpClicks');
            sessionStorage.setItem('passwordMatched', String(document.getElementById('password').value === ${JSON.stringify(password)}));
            document.body.insertAdjacentHTML('beforeend', sessionStorage.getItem('passwordMatched') === 'true' ? '<p id="authenticated">Authenticated</p>' : '<p id="rejected">Credentials rejected</p>');
            updateFixtureStatus();
          });`,
        ),
      );
    } else if (path === "/delayed") {
      response.end(
        html(
          "<h1>Synthetic delayed login</h1>",
          `
        window.releaseDelayedLogin = () => {
          document.body.insertAdjacentHTML('afterbegin', '<label>Password<input id="password" type="password"></label><button id="login" type="button">Log in</button>');
          document.getElementById('login').addEventListener('click', () => {
            sessionStorage.setItem('submitClicks', String(Number(sessionStorage.getItem('submitClicks') || 0) + 1));
            sessionStorage.setItem('passwordMatched', String(document.getElementById('password').value === ${JSON.stringify(password)}));
            document.body.insertAdjacentHTML('beforeend', sessionStorage.getItem('passwordMatched') === 'true' ? '<p id="authenticated">Authenticated</p>' : '<p id="rejected">Credentials rejected</p>');
            updateFixtureStatus();
          });
        };
      `,
        ),
      );
    } else if (
      path === "/spa" ||
      path === "/spa-login" ||
      path === "/dialog" ||
      path === "/slow-button"
    ) {
      // Forms that appear after load: a same-document URL change, an opened dialog and a
      // submit button that renders late (`?never` keeps it absent).
      const form =
        '<label>Password<input id="password" type="password"></label><button id="login" type="button">Log in</button>';
      const body = {
        // `?static` renders the form at load, so only the URL change can start the login.
        "/spa": fixtureUrl.searchParams.has("static")
          ? `<h1>Synthetic app home</h1><button id="open-login" type="button">Go to sign-in</button><main id="app">${form}</main>`
          : `<h1>Synthetic app home</h1><button id="open-login" type="button">Go to sign-in</button><main id="app"></main><template id="login-form">${form}</template>`,
        "/spa-login": `<h1>Synthetic app sign-in</h1><main id="app">${form}</main>`,
        "/dialog": `<h1>Synthetic dialog login</h1><button id="open-login" type="button">Sign in</button><div id="app" hidden>${form}</div>`,
        "/slow-button":
          '<h1>Synthetic slow button</h1><main id="app"><label>Password<input id="password" type="password"></label></main>',
      }[path];
      response.end(
        html(
          body,
          `
        function bindLogin() {
          document.getElementById('login').addEventListener('click', () => {
            sessionStorage.setItem('submitClicks', String(Number(sessionStorage.getItem('submitClicks') || 0) + 1));
            sessionStorage.setItem('passwordMatched', String(document.getElementById('password').value === ${JSON.stringify(password)}));
            document.body.insertAdjacentHTML('beforeend', sessionStorage.getItem('passwordMatched') === 'true' ? '<p id="authenticated">Authenticated</p>' : '<p id="rejected">Credentials rejected</p>');
            updateFixtureStatus();
          });
        }
        ${
          path === "/spa"
            ? fixtureUrl.searchParams.has("static")
              ? `bindLogin();
        document.getElementById('open-login').addEventListener('click', () => {
          history.pushState({}, '', '/spa-login');
        });`
              : `document.getElementById('open-login').addEventListener('click', () => {
          history.pushState({}, '', '/spa-login');
          setTimeout(() => {
            document.getElementById('app').append(document.getElementById('login-form').content.cloneNode(true));
            bindLogin();
          }, 300);
        });`
            : path === "/dialog"
              ? `bindLogin();
        document.getElementById('open-login').addEventListener('click', () => {
          document.getElementById('app').hidden = false;
        });`
              : path === "/slow-button"
                ? fixtureUrl.searchParams.has("never")
                  ? ""
                  : `setTimeout(() => {
          document.getElementById('app').insertAdjacentHTML('beforeend', '<button id="login" type="button">Log in</button>');
          bindLogin();
        }, ${Number(fixtureUrl.searchParams.get("delay") ?? 2000)});`
                : "bindLogin();"
        }`,
        ),
      );
    } else if (path === "/frame-host") {
      // The single-page login inside a frame. `?port` embeds another fixture server's page,
      // so the frame is on another origin than the tab's page.
      const address = server.address();
      const framePort =
        Number(fixtureUrl.searchParams.get("port")) ||
        (address && typeof address !== "string" ? address.port : 0);
      response.end(
        html(
          `<h1>Synthetic frame host</h1><iframe id="login-frame" title="Synthetic sign-in" src="http://127.0.0.1:${framePort}/single" width="600" height="300"></iframe>`,
        ),
      );
    } else if (path === "/sign-in") {
      // A page with no recipe: a generated one fills the password and opens /account. The
      // page reads its run ID itself, so nothing from the request URL is written into it.
      // `?button=anchor` makes the login button a link without href, as MyJCB's passkey
      // button; `?button=script-link` a `javascript:` link without an id, as SMBC Direct's;
      // `?button=script-url` a link whose `javascript:` URL alone copies the shown password
      // into a hidden input and submits the form, as SMBC Trust Bank's, so only the hidden
      // input reaches the server; `?button=labelled` a submit input without id, name or
      // value, laid over the `aria-hidden` text that labels it, as Amazon.co.jp's.
      // `?marker=link` makes /account show an account link without an id instead of a
      // sign-out button, as ポイントインカム's header. `?optional` signs in to /checkup, an
      // optional page that can be put off (ADR 0065).
      // `?redesign` gives the form other element IDs, as a site's new login page does, and
      // `?maintenance` answers 503 with a page whose only input is no login field (ADR 0041).
      const variant = fixtureUrl.searchParams.get("button");
      const account = fixtureUrl.searchParams.has("optional")
        ? "/checkup"
        : fixtureUrl.searchParams.get("marker") === "link"
          ? "/account?marker=link"
          : "/account";
      const redesign = fixtureUrl.searchParams.has("redesign");
      const field = redesign ? "passcode" : "password";
      if (maintenance) {
        response.end(
          html(
            '<h1>Synthetic maintenance</h1><p>Back soon.</p><label>Admin key<input id="admin-key" type="password"></label>',
          ),
        );
        return;
      }
      const button = redesign
        ? '<button id="continue" type="button">Log in</button>'
        : variant === "anchor"
          ? '<a id="login" onclick="return false">Log in</a>'
          : variant === "script-link"
            ? '<a href="javascript:;" onclick="return false"><span>Log in</span></a>'
            : variant === "script-url"
              ? '<input type="hidden" name="source" value="click"><input type="hidden" name="password"><a href="javascript:copyAndSubmit()"><span>Log in</span></a>'
              : variant === "labelled"
                ? '<span style="position:relative;display:inline-block"><input type="submit" aria-labelledby="login-say" style="position:absolute;inset:0;opacity:0.01"><span id="login-say" aria-hidden="true">Log in</span></span>'
                : '<button id="login" type="button">Log in</button>';
      response.end(
        html(
          `<h1>Synthetic sign-in</h1><form${variant === "script-url" ? ' method="post"' : ""}><label>Password<input id="${field}" type="password"></label>${button}</form>`,
          variant === "script-url"
            ? `function copyAndSubmit() {
          const form = document.querySelector('form');
          const shown = document.getElementById('password').value;
          form.querySelector('input[type=hidden][name=password]').value = shown;
          sessionStorage.setItem('submitClicks', String(Number(sessionStorage.getItem('submitClicks') || 0) + 1));
          sessionStorage.setItem('passwordMatched', String(shown === ${JSON.stringify(password)}));
          const query = new URLSearchParams(location.search);
          form.action = '/sign-in-submit?' + new URLSearchParams({runId: query.get('runId') || '', marker: query.get('marker') || ''});
          form.submit();
        }`
            : `document.querySelector('form').addEventListener('submit', (event) => event.preventDefault());
        document.querySelector('form button, form a, form input[type=submit]').addEventListener('click', () => {
          const shown = document.getElementById(${JSON.stringify(field)}).value;
          sessionStorage.setItem('submitClicks', String(Number(sessionStorage.getItem('submitClicks') || 0) + 1));
          sessionStorage.setItem('passwordMatched', String(shown === ${JSON.stringify(password)}));
          const runId = new URLSearchParams(location.search).get('runId');
          if (runId) void fetch('/effect/' + encodeURIComponent(runId), {method:'POST', keepalive:true, body:new URLSearchParams({source:'click', password:shown})});
          location.href = ${JSON.stringify(account)};
        });`,
        ),
      );
    } else if (path === "/checkup") {
      // An optional page after the sign-in, as a periodic prompt to verify two-factor
      // settings (ADR 0065): each button is counted, and "Remind me later" opens /account.
      response.end(
        html(
          "<h1>Synthetic checkup</h1>",
          `document.body.insertAdjacentHTML('afterbegin', sessionStorage.getItem('passwordMatched') === 'true'
          ? '<h2 id="optional-page">Verify your two-factor authentication settings</h2><button id="verify-now" type="button">Verify now</button><button id="remind-later" type="button">Remind me later</button>'
          : '<h2 id="rejected">Credentials rejected</h2>');
        const count = (key) => sessionStorage.setItem(key, String(Number(sessionStorage.getItem(key) || 0) + 1));
        document.getElementById('verify-now')?.addEventListener('click', () => count('verifyClicks'));
        document.getElementById('remind-later')?.addEventListener('click', () => {
          count('laterClicks');
          location.href = '/account';
        });`,
        ),
      );
    } else if (path === "/account") {
      const marker =
        fixtureUrl.searchParams.get("marker") === "link"
          ? '<header><a href="/my/">My page</a></header>'
          : '<button id="sign-out" type="button">Sign out</button>';
      response.end(
        html(
          "<h1>Synthetic account</h1>",
          `document.body.insertAdjacentHTML('afterbegin', sessionStorage.getItem('passwordMatched') === 'true' && sessionStorage.getItem('identityMatched') !== 'false'
          ? ${JSON.stringify(`<h2 id="signed-in">Your synthetic account</h2>${marker}`)}
          : '<h2 id="rejected">Credentials rejected</h2>');`,
        ),
      );
    } else if (path === "/confirm-transfer") {
      // A transfer confirmed with the account's password in a form that shows its amount,
      // the page a recipe generated as `confirm` starts on (ADR 0035). Its form goes to the
      // account result page.
      response.end(
        html(
          '<h1>Synthetic transfer confirmation</h1><form id="transfer" action="/authenticated"><p>Total ¥1,200</p><label>Password<input id="confirm-password" type="password"></label><button id="confirm">Confirm</button></form>',
        ),
      );
    } else if (path === "/ambiguous") {
      response.end(
        html(
          '<h1>Synthetic ambiguous login</h1><input name="password" type="password"><input name="password" type="password"><button id="login" type="button">Log in</button>',
        ),
      );
    } else if (path === "/shared-input") {
      // One input that both of the recipe's locators name (its ID and its name): filling
      // both slots would leave only the second value in it, which the page rejects.
      response.end(
        html(
          '<h1>Synthetic shared input</h1><main id="app"><form><label>Password<input id="account" name="password" type="password"></label><button id="login" type="button">Log in</button></form></main>',
          `document.getElementById('login').addEventListener('click', () => {
          sessionStorage.setItem('submitClicks', String(Number(sessionStorage.getItem('submitClicks') || 0) + 1));
          document.getElementById('app').innerHTML = '<p id="rejected">Wrong account or password</p>';
          updateFixtureStatus();
        });`,
        ),
      );
    } else if (path === "/authenticated") {
      response.end(
        html(
          "<h1>Synthetic account result</h1>",
          `
        document.body.insertAdjacentHTML('afterbegin', sessionStorage.getItem('identityMatched') === 'true' && sessionStorage.getItem('passwordMatched') === 'true'
          ? '<h2 id="authenticated">Authenticated synthetic account</h2>'
          : '<h2 id="rejected">Credentials or prior stage rejected</h2>');
      `,
        ),
      );
    } else {
      response.end(html("<h1>Synthetic unrelated page</h1>"));
    }
  });
  await new Promise<void>((done, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", done);
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("No synthetic fixture port");
  return {
    server,
    origin: `http://127.0.0.1:${address.port}`,
    createRun: (outcome = "authenticated", holdResult = false) => {
      const runId = randomUUID();
      runs.set(runId, {
        outcome,
        holdResult,
        evidence: { posts: 0, inputPosts: 0, clickPosts: 0, allMatched: true },
        pending: [],
      });
      return runId;
    },
    evidence: (runId) => ({ ...getRun(runId).evidence }),
    releaseResult: (runId) => {
      const run = getRun(runId);
      run.holdResult = false;
      for (const finish of run.pending.splice(0)) finish();
    },
    close: () => {
      for (const runId of runs.keys()) {
        const run = getRun(runId);
        for (const finish of run.pending.splice(0)) finish();
      }
      return new Promise<void>((done, reject) =>
        server.close((error) => (error ? reject(error) : done())),
      );
    },
  };
}
