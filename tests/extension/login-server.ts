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

/** `password` selects the expected synthetic value, such as a fixture vault's login password. */
export async function startLoginFixture(
  port = 0,
  { password = "Pateat-synthetic-only!" }: { password?: string } = {},
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
    if (path.startsWith("/effect/") && request.method === "POST") {
      const run = runs.get(path.slice("/effect/".length));
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
    response.writeHead(200, {
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
      // the password form from the start. Only those known flags are read, and the query
      // is never written into the page.
      const push = fixtureUrl.searchParams.has("push");
      const shown = fixtureUrl.searchParams.has("shown");
      response.end(
        html(
          `<h1>Synthetic identifier-first sign-in</h1><form id="account-form"><label>Account<input id="account" autocomplete="username"></label><button id="next" type="button">Next</button></form><form id="password-form"${shown ? "" : " hidden"}><label>Password<input id="password" type="password" autocomplete="current-password"></label><button id="login" type="button">Log in</button></form>`,
          `document.getElementById('next').addEventListener('click', () => {
          sessionStorage.setItem('identityClicks', String(Number(sessionStorage.getItem('identityClicks') || 0) + 1));
          sessionStorage.setItem('identityMatched', String(document.getElementById('account').value === '00001234'));
          document.getElementById('account-form').hidden = true;
          ${push ? "history.pushState({}, '', '/identifier-first?push=1&step=password');" : ""}
          setTimeout(() => { document.getElementById('password-form').hidden = false; }, 300);
          updateFixtureStatus();
        });
        document.getElementById('login').addEventListener('click', () => {
          sessionStorage.setItem('submitClicks', String(Number(sessionStorage.getItem('submitClicks') || 0) + 1));
          sessionStorage.setItem('passwordMatched', String(document.getElementById('password').value === ${JSON.stringify(password)}));
          location.href = '/authenticated';
        });`,
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
    } else if (path === "/totp") {
      // Only the known flags go on, never the query as written.
      const flags = new URLSearchParams();
      for (const flag of ["wrong", "auto", "slow"])
        if (fixtureUrl.searchParams.has(flag)) flags.set(flag, "");
      const spa = fixtureUrl.searchParams.get("spa");
      if (spa === "status" || spa === "replace") flags.set("spa", spa);
      const ui = fixtureUrl.searchParams.get("ui");
      if (
        ui === "disabled" ||
        ui === "rerender" ||
        ui === "counter" ||
        ui === "disauto" ||
        ui === "flicker"
      )
        flags.set("ui", ui);
      const next = flags.size === 0 ? "/totp-code" : `/totp-code?${flags.toString()}`;
      // A password page followed by an authenticator app code page (ADR 0027). The query
      // goes on to the code page: `?wrong` shows it again after Verify, `?auto` submits the
      // code by itself on its sixth digit, as some sites do. With `?auto`, `slow` verifies
      // it for 1.2 seconds before the next document loads, `spa=status` says "Verifying…"
      // in the form and disables Verify for that long and `spa=replace` renders the form
      // again as verifying, before both sign in without a new document. Without `?auto`,
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
      const again = fixtureUrl.searchParams.has("wrong") ? "/totp-code?wrong" : "/totp-code";
      response.end(
        html(
          `<h1>Two-factor authentication</h1><p>Enter the code from your authenticator app.</p><form id="code-form"><label>Authentication code<input id="code" autocomplete="one-time-code" inputmode="numeric" maxlength="6"></label><button id="verify" type="button"${ui === "disabled" || ui === "disauto" || ui === "flicker" ? " disabled" : ""}>Verify</button><p role="status" id="code-status"></p>${ui === "counter" ? '<p id="code-counter" aria-live="polite"></p>' : ""}</form>`,
          `const code = document.getElementById('code');
          function count(name) {
            sessionStorage.setItem(name, String(Number(sessionStorage.getItem(name) || 0) + 1));
          }
          function submitCode(source) {
            count(source);
            count('codeSubmits');
            sessionStorage.setItem('codeMatched', String(code.value === '012345'));
            const signedIn = code.value === '012345' && ${JSON.stringify(again)} === '/totp-code';
            ${
              spa
                ? `${
                    spa === "replace"
                      ? `document.getElementById('code-form').innerHTML = '<input id="code" autocomplete="one-time-code" inputmode="numeric" maxlength="6" disabled><button id="verify" type="button" disabled>Verify</button><p>Verifying…</p>';`
                      : `document.getElementById('code-status').textContent = 'Verifying…';
                        document.getElementById('verify').disabled = true;`
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
          code.addEventListener('input', () => {
            count('codeInputs');
            ${ui === "disabled" ? "document.getElementById('verify').disabled = code.value.length !== 6;" : ""}
            ${ui === "rerender" ? "const old = document.getElementById('verify'); const button = old.cloneNode(true); old.replaceWith(button); wire(button);" : ""}
            ${ui === "counter" ? "document.getElementById('code-counter').textContent = code.value.length + ' of 6 digits';" : ""}
            ${auto ? "if (code.value.length === 6) submitCode('autoSubmits');" : ""}
            ${
              ui === "disauto" || ui === "flicker"
                ? `if (code.value.length === 6) {
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
                sessionStorage.setItem('codeMatched', String(code.value === '012345'));
                const signedIn = code.value === '012345' && ${JSON.stringify(again)} === '/totp-code';
                setTimeout(() => {
                  if (signedIn) location.href = '/authenticated';
                  else document.getElementById('verify').disabled = false;
                }, 1000);
              }`
                : ""
            }
          });
          wire(document.getElementById('verify'));`,
        ),
      );
    } else if (path === "/password") {
      // `?slow=1` renders the form four seconds after load, past the old three-second budget.
      const slow = fixtureUrl.searchParams.has("slow");
      const form =
        '<label>Password<input id="password" type="password"></label><button id="login" type="button">Log in</button>';
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
      // `?maxlength` limits the password input, such as below the synthetic password.
      const maxLength = fixtureUrl.searchParams.get("maxlength");
      response.end(
        html(
          `<h1>Synthetic single-page login</h1>${
            shown !== null && masked.test(shown) ? `<p>Signed in as ${shown}</p>` : ""
          }${
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
          }<label>Password<input id="password" ${
            {
              text: 'type="text"',
              "text-current-password": 'type="text" autocomplete="current-password"',
            }[fixtureUrl.searchParams.get("password-input") ?? ""] ?? 'type="password"'
          }${
            maxLength !== null && /^\d{1,3}$/u.test(maxLength) ? ` maxlength="${maxLength}"` : ""
          }></label><button id="login" type="button">Log in</button>${
            // `?ad` embeds an unrelated frame beside the form, like an advertisement.
            fixtureUrl.searchParams.has("ad")
              ? '<iframe id="ad" title="Synthetic advertisement" src="/ad"></iframe>'
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
            }[fixtureUrl.searchParams.get("reject-fill") ?? ""] ?? ""
          }
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
      // button; `?button=script-link` a `javascript:` link without an id, as SMBC Direct's.
      const variant = fixtureUrl.searchParams.get("button");
      const button =
        variant === "anchor"
          ? '<a id="login" onclick="return false">Log in</a>'
          : variant === "script-link"
            ? '<a href="javascript:;" onclick="return false"><span>Log in</span></a>'
            : '<button id="login" type="button">Log in</button>';
      response.end(
        html(
          `<h1>Synthetic sign-in</h1><form><label>Password<input id="password" type="password"></label>${button}</form>`,
          `document.querySelector('#login, form a').addEventListener('click', () => {
          sessionStorage.setItem('submitClicks', String(Number(sessionStorage.getItem('submitClicks') || 0) + 1));
          sessionStorage.setItem('passwordMatched', String(document.getElementById('password').value === ${JSON.stringify(password)}));
          const runId = new URLSearchParams(location.search).get('runId');
          if (runId) void fetch('/effect/' + encodeURIComponent(runId), {method:'POST', keepalive:true, body:new URLSearchParams({source:'click', password:document.getElementById('password').value})});
          location.href = '/account';
        });`,
        ),
      );
    } else if (path === "/account") {
      response.end(
        html(
          "<h1>Synthetic account</h1>",
          `document.body.insertAdjacentHTML('afterbegin', sessionStorage.getItem('passwordMatched') === 'true'
          ? '<h2 id="signed-in">Your synthetic account</h2><button id="sign-out" type="button">Sign out</button>'
          : '<h2 id="rejected">Credentials rejected</h2>');`,
        ),
      );
    } else if (path === "/ambiguous") {
      response.end(
        html(
          '<h1>Synthetic ambiguous login</h1><input name="password" type="password"><input name="password" type="password"><button id="login" type="button">Log in</button>',
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
