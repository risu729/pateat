import { afterEach, describe, expect, it } from "vitest";
import { listedAccounts, noInputOffer } from "./no-input-offer";

afterEach(() => {
  document.body.innerHTML = "";
});

const page = (html: string) => {
  document.body.innerHTML = html;
};
const passkeyPage = `<main><h1>Welcome back</h1>
  <button id="login-key">Sign in with a passkey</button></main>`;

describe("what a page without a sign-in input is offered as (ADR 0053)", () => {
  it("offers a heading beside a passkey button as a passkey page with its list of names", () => {
    page(passkeyPage);
    // The heading alone reads as a short text beside the buttons; the runtime uses it only
    // when no matching item holds a passkey.
    const accounts = listedAccounts(document);
    expect(accounts?.names).toBeDefined();
    expect(noInputOffer(document, false)).toEqual({ kind: "passkey", accounts, entry: false });
  });

  it("still offers it as a passkey page with a support address in the footer", () => {
    page(`${passkeyPage}<footer>Contact support@example.com</footer>`);
    const accounts = listedAccounts(document);
    expect(accounts).toBeDefined();
    expect(noInputOffer(document, false)).toEqual({ kind: "passkey", accounts, entry: false });
  });

  it("offers a list of accounts by email as the list", () => {
    page(`<h1>Choose an account</h1>
      <button><span>a@example.com</span></button>
      <button><span>b@example.com</span></button>
      <button id="login-key">Sign in with a passkey</button>`);
    expect(noInputOffer(document, false)).toMatchObject({
      kind: "list",
      accounts: { path: expect.any(String) },
      entry: false,
    });
  });

  it("offers a page that asks for an identifier as that, never as a passkey page", () => {
    page(`<h1>Sign in</h1><label>Email <input type="email" name="email"></label>
      <button>Continue</button><button id="login-key">Sign in with a passkey</button>`);
    expect(noInputOffer(document, false)).toEqual({ kind: "identifier" });
  });

  it("offers the passkey page together with the site's sign-in entry", () => {
    // The runtime sends the entry when no matching item holds a passkey (owner 2026-10-19
    // 22:44 UTC).
    page(`<main><h1>Welcome</h1><a href="/login">Log in</a>
      <button id="login-key">Sign in with a passkey</button></main>`);
    expect(noInputOffer(document, true)).toMatchObject({ kind: "passkey", entry: true });
    // Without a passkey button the entry is offered as before.
    page(`<main><h1>Welcome</h1><a href="/login">Log in</a></main>`);
    expect(noInputOffer(document, true)).toMatchObject({ kind: "list", entry: true });
  });

  it.each([
    `<button>Create a passkey</button>`,
    `<button hidden>Sign in with a passkey</button>`,
    `<main><h1>Home</h1><button>Continue</button></main>`,
  ])("offers nothing for a registration, hidden or other button: %s", (html) => {
    page(html);
    expect(noInputOffer(document, false)?.kind).not.toBe("passkey");
  });
});
