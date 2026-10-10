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
      response.end(
        html(
          fixtureUrl.searchParams.has("split-forms")
            ? '<h1>Synthetic identity step</h1><form><label>Branch<input id="branch"></label></form><form><label>Account<input id="account"></label></form><button id="next" type="button">Next</button>'
            : '<h1>Synthetic identity step</h1><label>Branch<input id="branch"></label><label>Account<input id="account"></label><button id="next" type="button">Next</button>',
          `document.getElementById('next').addEventListener('click', () => {
          sessionStorage.setItem('identityClicks', String(Number(sessionStorage.getItem('identityClicks') || 0) + 1));
          sessionStorage.setItem('identity', JSON.stringify([document.getElementById('branch').value, document.getElementById('account').value]));
          sessionStorage.setItem('identityMatched', String(document.getElementById('branch').value === '007' && document.getElementById('account').value === '00001234'));
          ${fixtureUrl.searchParams.has("runId") && runs.has(fixtureUrl.searchParams.get("runId")!) ? `void fetch('/effect/${fixtureUrl.searchParams.get("runId")}', {method:'POST', keepalive:true, body:new URLSearchParams({source:'click', stage:'identity', branch:document.getElementById('branch').value, account:document.getElementById('account').value})});` : ""}
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
          sessionStorage.setItem('passwordMatched', String(document.getElementById('password').value === ${JSON.stringify(password)}));
          ${fixtureUrl.searchParams.has("runId") && runs.has(fixtureUrl.searchParams.get("runId")!) ? `void fetch('/effect/${fixtureUrl.searchParams.get("runId")}', {method:'POST', keepalive:true, body:new URLSearchParams({source:'click', password:document.getElementById('password').value})});` : ""}
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
          `<h1>Synthetic single-page login</h1><label>Password<input id="password" ${
            {
              text: 'type="text"',
              "text-current-password": 'type="text" autocomplete="current-password"',
            }[fixtureUrl.searchParams.get("password-input") ?? ""] ?? 'type="password"'
          }></label><button id="login" type="button">Log in</button>`,
          `document.getElementById('login').addEventListener('click', () => {
          sessionStorage.setItem('submitClicks', String(Number(sessionStorage.getItem('submitClicks') || 0) + 1));
          sessionStorage.setItem('passwordMatched', String(document.getElementById('password').value === ${JSON.stringify(password)}));
          ${fixtureUrl.searchParams.has("runId") && runs.has(fixtureUrl.searchParams.get("runId")!) ? `void fetch('/effect/${fixtureUrl.searchParams.get("runId")}', {method:'POST', keepalive:true, body:new URLSearchParams({source:'click', password:document.getElementById('password').value})});` : ""}
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
            sessionStorage.setItem('passwordMatched', String(document.getElementById('password').value === ${JSON.stringify(password)}));
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
