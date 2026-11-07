/** Synthetic responses to a refused login, without a recipe rejection marker. */
export function credentialFailurePage(url: URL): string | undefined {
  const identifier = url.pathname === "/identifier-failure";
  if (!identifier && url.pathname !== "/credential-failure") return undefined;
  const style = url.searchParams.get("error");
  const alert = style === "alert";
  const message =
    style === "plain" || alert
      ? `<p id="failure-message"${alert ? ' role="alert"' : ""}>${identifier ? "Account not found" : "Username or password was not accepted"}</p>`
      : "";
  const answered = url.searchParams.has("answered");
  const newDocument = url.searchParams.has("new-document");
  const nextUrl = new URL(url.pathname, url.origin);
  if (style === "alert" || style === "plain") nextUrl.searchParams.set("error", style);
  nextUrl.searchParams.set("answered", "1");
  return `<!doctype html><html lang="en"><meta charset="utf-8">
    <title>Synthetic refused login</title><main><h1>Sign in</h1>
    <form id="signin"><label>${identifier ? "Account" : "Password"}
    ${identifier ? '<input id="account" autocomplete="username" inputmode="numeric" maxlength="8">' : '<input id="password" type="password" autocomplete="current-password">'}
    </label><button id="${identifier ? "next" : "login"}" type="button">${identifier ? "Next" : "Sign in"}</button>
    <div id="answer">${answered ? message : ""}</div></form>
    <p id="response-state">${answered ? "Answer received" : "Waiting for submission"}</p></main>
    <script>
      document.querySelector('button').addEventListener('click', () => {
        const key = ${JSON.stringify(identifier ? "identityClicks" : "submitClicks")};
        sessionStorage.setItem(key, String(Number(sessionStorage.getItem(key) || 0) + 1));
        ${
          newDocument
            ? `location.assign(${JSON.stringify(nextUrl.pathname + nextUrl.search)});`
            : `document.getElementById('answer').innerHTML = ${JSON.stringify(message)};
            document.getElementById('response-state').textContent = 'Answer received';`
        }
      });
    </script></html>`;
}
