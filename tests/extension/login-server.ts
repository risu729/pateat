import { createServer, type Server } from "node:http";

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

export async function startLoginFixture(
  port = 0,
): Promise<{ server: Server; origin: string; close: () => Promise<void> }> {
  const server = createServer((request, response) => {
    const fixtureUrl = new URL(request.url ?? "/", "http://fixture.test");
    const path = fixtureUrl.pathname;
    response.writeHead(200, {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store",
    });
    if (path === "/identity") {
      response.end(
        html(
          '<h1>Synthetic identity step</h1><label>Branch<input id="branch"></label><label>Account<input id="account"></label><button id="next" type="button">Next</button>',
          `document.getElementById('next').addEventListener('click', () => {
          sessionStorage.setItem('identityClicks', String(Number(sessionStorage.getItem('identityClicks') || 0) + 1));
          sessionStorage.setItem('identity', JSON.stringify([document.getElementById('branch').value, document.getElementById('account').value]));
          sessionStorage.setItem('identityMatched', String(document.getElementById('branch').value === '007' && document.getElementById('account').value === '00001234'));
          location.href = '/password';
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
        }`,
        ),
      );
    } else if (path === "/password") {
      response.end(
        html(
          '<h1>Synthetic password step</h1><label>Password<input id="password" type="password"></label><button id="login" type="button">Log in</button>',
          `document.getElementById('login').addEventListener('click', () => {
          sessionStorage.setItem('submitClicks', String(Number(sessionStorage.getItem('submitClicks') || 0) + 1));
          sessionStorage.setItem('passwordMatched', String(document.getElementById('password').value === 'Pateat-synthetic-only!'));
          location.href = '/authenticated';
        });`,
        ),
      );
    } else if (
      path === "/single" ||
      path === "/rejection" ||
      path === "/unknown" ||
      path === "/delayed-result"
    ) {
      response.end(
        html(
          '<h1>Synthetic single-page login</h1><label>Password<input id="password" type="password"></label><button id="login" type="button">Log in</button>',
          `document.getElementById('login').addEventListener('click', () => {
          sessionStorage.setItem('submitClicks', String(Number(sessionStorage.getItem('submitClicks') || 0) + 1));
          sessionStorage.setItem('passwordMatched', String(document.getElementById('password').value === 'Pateat-synthetic-only!'));
          ${path === "/rejection" ? "document.body.insertAdjacentHTML('beforeend', '<p id=\"rejected\">Credentials rejected</p>');" : path === "/single" ? "document.body.insertAdjacentHTML('beforeend', sessionStorage.getItem('passwordMatched') === 'true' ? '<p id=\"authenticated\">Authenticated</p>' : '<p id=\"rejected\">Credentials rejected</p>');" : ""}
          ${path === "/delayed-result" ? `setTimeout(() => { document.body.insertAdjacentHTML('beforeend', ${fixtureUrl.searchParams.has("reject") ? "'<p id=\"rejected\">Credentials rejected</p>'" : "sessionStorage.getItem('passwordMatched') === 'true' ? '<p id=\"authenticated\">Authenticated</p>' : '<p id=\"rejected\">Credentials rejected</p>'"}); updateFixtureStatus(); }, 250);` : ""}
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
            sessionStorage.setItem('passwordMatched', String(document.getElementById('password').value === 'Pateat-synthetic-only!'));
            document.body.insertAdjacentHTML('beforeend', sessionStorage.getItem('passwordMatched') === 'true' ? '<p id="authenticated">Authenticated</p>' : '<p id="rejected">Credentials rejected</p>');
            updateFixtureStatus();
          });
        };
      `,
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
    close: () =>
      new Promise<void>((done, reject) =>
        server.close((error) => (error ? reject(error) : done())),
      ),
  };
}
