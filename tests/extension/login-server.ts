import { createServer, type Server } from "node:http";
import { randomUUID } from "node:crypto";
import { credentialFailurePage } from "./credential-failure-fixture";
import { html } from "./login-html";
import {
  identityPage,
  identifierFirstPage,
  identifierKeptPage,
  identifierSwapPage,
  methodChoicePage,
  identifierPage,
  identifierPasswordPage,
} from "./login-identity-pages";

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
    const failurePage = credentialFailurePage(fixtureUrl);
    if (failurePage !== undefined) {
      response.writeHead(200, {
        "content-type": "text/html; charset=utf-8",
        "cache-control": "no-store",
      });
      response.end(failurePage);
      return;
    }
    if (path === "/slow-image") {
      // An image that takes 1.5 s, so the page's `load` comes late (`?shown-late`).
      setTimeout(() => {
        response.writeHead(200, { "content-type": "image/gif" });
        response.end(Buffer.from("R0lGODlhAQABAAAAACw=", "base64"));
      }, 1500);
      return;
    }
    if (path === "/slow-switch") {
      // An account switch whose next page takes 2.5 s, as a server-side sign-out does.
      const shown = fixtureUrl.searchParams.get("shown") ?? "";
      setTimeout(() => {
        response.writeHead(302, {
          location: /^[A-Za-z0-9@.*]+$/u.test(shown)
            ? `/delayed-result?${new URLSearchParams({ shown }).toString()}`
            : "/delayed-result",
        });
        response.end();
      }, 2500);
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
      response.end(identityPage(fixtureUrl, issuedRunId));
    } else if (path === "/identifier-first") {
      response.end(identifierFirstPage(fixtureUrl, password, accountName));
    } else if (path === "/identifier-kept") {
      response.end(identifierKeptPage(fixtureUrl, password, accountName));
    } else if (path === "/identifier-swap") {
      response.end(identifierSwapPage(password));
    } else if (path === "/method-choice" || path === "/method-choice-named") {
      response.end(methodChoicePage(fixtureUrl, path, password, accountName));
    } else if (path === "/identifier" || path === "/identifier/again") {
      response.end(identifierPage(fixtureUrl, path, accountName));
    } else if (path === "/identifier/password") {
      response.end(identifierPasswordPage(password));
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
        ui === "drop" ||
        ui === "unmarked"
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
      // them `#code` (with `ui=seven`, seven; with `ui=unmarked`, six text inputs marked
      // numeric that declare no `maxlength`, only the first marked `one-time-code`, each
      // keeping one character and moving the focus on, as Notion's do; with `ui=partial`, Verify is disabled only
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
          `<h1>Two-factor authentication</h1><p>Enter the code from your authenticator app.</p><form id="code-form">${split && ui === "unmarked" ? `<div><input id="code" type="text" inputmode="numeric" autocomplete="one-time-code" aria-label="Enter verification code digit 1">${[2, 3, 4, 5, 6].map((digit) => `<input id="code-${digit}" type="text" inputmode="numeric" autocomplete="off" aria-label="Digit ${digit}">`).join("")}</div>` : split ? `<fieldset><legend>Authentication code</legend><input id="code" inputmode="numeric" maxlength="1" aria-label="Digit 1">${(ui === "seven" ? [2, 3, 4, 5, 6, 7] : [2, 3, 4, 5, 6]).map((digit) => `<input id="code-${digit}" inputmode="numeric" maxlength="1" aria-label="Digit ${digit}">`).join("")}</fieldset>` : '<label>Authentication code<input id="code" autocomplete="one-time-code" inputmode="numeric" maxlength="6"></label>'}${nobutton ? "" : `<button id="verify" type="button"${ui === "disabled" || ui === "disauto" || ui === "flicker" ? " disabled" : ""}>Verify</button>`}<p role="status" id="code-status"></p>${ui === "counter" ? '<p id="code-counter" aria-live="polite"></p>' : ""}</form>`,
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
          for (const [place, digit] of digits.entries()) digit.addEventListener('input', () => {
            count('codeInputs');
            ${ui === "unmarked" ? "if (digit.value.length > 1) digit.value = digit.value.slice(0, 1); if (digit.value) digits[place + 1]?.focus();" : ""}
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
      // `?shown-late` shows the account only once the page has loaded, after an image that
      // takes 1.5 s, as Duolingo's remembered account shows after its password field
      // (2026-10-23).
      const shownLate = fixtureUrl.searchParams.get("shown-late");
      // `?switch-pointer` names the account a "Use another account" element with only a
      // pointer cursor, inside the form after the password field, loads next (Duolingo,
      // 2026-10-23); the recipe names no switch for it.
      const switchPointer = fixtureUrl.searchParams.get("switch-pointer");
      // `?switch-in-place` makes that element show the account in place instead, as a
      // single-page app does.
      const inPlace = fixtureUrl.searchParams.has("switch-in-place");
      // `?switch-slow` makes it load its next page through `/slow-switch`.
      const slowSwitch = fixtureUrl.searchParams.has("switch-slow");
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
            shown !== null && masked.test(shown) ? `<p id="shown">Signed in as ${shown}</p>` : ""
          }${shownLate !== null && masked.test(shownLate) ? `<p id="account" data-shown="Signed in as ${shownLate}">Loading</p><img alt="" src="/slow-image">` : ""}${
            // `switch` names the account the "Use another account" link shows next;
            // `switch-submit` makes it the submit button of its own form, with a shown field.
            switchTo === null || !masked.test(switchTo)
              ? ""
              : fixtureUrl.searchParams.has("switch-submit")
                ? `<form action="/single"><input type="hidden" name="shown" value="${switchTo}"><label><input type="checkbox" name="remember"> Remember me</label><button>Use another account</button></form>`
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
          }${fixtureUrl.searchParams.get("reject-fill") === "switch-form" ? " required" : ""}></label>${
            switchPointer !== null && masked.test(switchPointer)
              ? `<div id="use-another" data-test="use-another-account" style="cursor: pointer"${inPlace ? ` data-shown="Signed in as ${switchPointer}"` : ""} data-next="${slowSwitch ? "/slow-switch" : path}?${new URLSearchParams({ shown: switchPointer, ...(form === null ? {} : { form }) }).toString().replace(/&/gu, "&amp;")}"><span>Use another account</span></div>`
              : ""
          }${
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
          document.getElementById('use-another')?.addEventListener('click', (event) => { const { shown, next } = event.currentTarget.dataset; if (shown) { document.getElementById('shown').textContent = shown; event.currentTarget.remove(); } else location.assign(next); });
          ${
            shownLate !== null && masked.test(shownLate)
              ? "addEventListener('load', () => { document.getElementById('account').textContent = document.getElementById('account').dataset.shown; });"
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
      // `?button=shadow` renders the password input in a component's open shadow root and
      // the button in another's closed one, as Reddit's sign-in components do (ADR 0070).
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
      const shadow = variant === "shadow";
      response.end(
        html(
          shadow
            ? "<h1>Synthetic sign-in</h1><form><x-password></x-password><x-login></x-login></form>"
            : `<h1>Synthetic sign-in</h1><form${variant === "script-url" ? ' method="post"' : ""}><label>Password<input id="${field}" type="password"></label>${button}</form>`,
          shadow
            ? `const passwordRoot = document.querySelector('x-password').attachShadow({mode: 'open'});
          passwordRoot.innerHTML = '<label>Password<input id="password" type="password"></label>';
          const loginRoot = document.querySelector('x-login').attachShadow({mode: 'closed'});
          loginRoot.innerHTML = '<button id="login" type="button">Log in</button>';
          const shown = passwordRoot.getElementById('password');
          loginRoot.getElementById('login').addEventListener('click', () => {
          sessionStorage.setItem('submitClicks', String(Number(sessionStorage.getItem('submitClicks') || 0) + 1));
          sessionStorage.setItem('passwordMatched', String(shown.value === ${JSON.stringify(password)}));
          const runId = new URLSearchParams(location.search).get('runId');
          if (runId) void fetch('/effect/' + encodeURIComponent(runId), {method:'POST', keepalive:true, body:new URLSearchParams({source:'click', password:shown.value})});
          location.href = ${JSON.stringify(account)};
        });`
            : variant === "script-url"
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
