import { afterEach, describe, expect, it } from "vitest";
import { createSsoContent } from "./content-sso";
import { idpNames, labeledEntry } from "./sso-entry-label";

// The sign-in form of `flow.idp.hashicorp.com/login` (#1687), as read on the owner's Chrome
// on 2026-11-18, with its form posting to this test page's own origin, as the real one
// posts to its own: one form, an email input, three hidden inputs and four buttons with
// neither a name nor a formaction. No real page or account is used.
const page = () => `
  <h1>Sign in to HashiCorp</h1>
  <form action="${location.origin}/login/lookup/" method="post">
    <input id="email_input" type="email" name="email">
    <input type="hidden" name="login.hashicorp.csrf" value="synthetic">
    <input type="hidden" name="login.hashicorp.challenge" value="synthetic">
    <input type="hidden" name="login.hashicorp.disable-discovery" value="false">
    <button id="sign-in-ibmid" value="/login/ibmid">Sign in with IBMid</button>
    <button id="sign-in-github" value="/login/github">Sign in with GitHub</button>
    <button id="sign-in-sso" value="/login/sso">Sign in with SSO</button>
    <button id="submit-button" type="submit" value="/login/lookup/">Continue</button>
  </form>
  <a href="https://developer.hashicorp.com/hcp/docs">Learn more</a>
  <a href="${location.origin}/register">Create an account</a>`;
const buttons = ["sign-in-ibmid", "sign-in-github", "sign-in-sso", "submit-button"];
const entries = () =>
  buttons.map((id) => ({ id, label: document.getElementById(id)!.textContent!.trim() }));
const pageOrigin = "https://flow.idp.hashicorp.com";
afterEach(() => {
  document.body.innerHTML = "";
});

describe("the HCP broker page's provider buttons", () => {
  it("each submit the page's own form, so none goes anywhere but the page's origin", async () => {
    document.body.innerHTML = page();
    const run = createSsoContent(document, { cancelled: () => false, authorize: async () => true });
    const inspected = await Promise.all(
      buttons.map((id) =>
        run({
          version: 1,
          token: "document-token",
          type: "login.sso.inspect",
          target: { by: "id", value: id },
        }),
      ),
    );
    expect(inspected).toEqual(
      buttons.map(() => ({
        ok: true,
        url: document.URL,
        destinations: [location.origin + "/login/lookup/"],
      })),
    );
  });

  it("names IBMid for a mapping to login.ibm.com and an IdP item called IBMid", () => {
    document.body.innerHTML = page();
    const idp = idpNames({ origin: "https://login.ibm.com", pageOrigin, itemName: "IBMid" });
    expect(labeledEntry(entries(), idp)?.id).toBe("sign-in-ibmid");
  });

  it("names GitHub for a mapping to github.com", () => {
    document.body.innerHTML = page();
    const idp = idpNames({ origin: "https://github.com", pageOrigin, itemName: "GitHub" });
    expect(labeledEntry(entries(), idp)?.id).toBe("sign-in-github");
  });

  it.each(["SSO", "Continue", "HashiCorp", "Sign in"])(
    "never names Sign in with SSO or Continue, for an IdP item called %s",
    (itemName) => {
      document.body.innerHTML = page();
      const idp = idpNames({ origin: "https://sso.hashicorp.com", pageOrigin, itemName });
      expect(labeledEntry(entries(), idp)).toBeUndefined();
    },
  );
});
