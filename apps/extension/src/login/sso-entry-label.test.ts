import { describe, expect, it } from "vitest";
import { idpNames, labeledEntry, labelNamesIdp, labelWords } from "./sso-entry-label";

// The four buttons of `flow.idp.hashicorp.com/login` (#1687), as the page shows them.
const broker = [
  { id: "sign-in-ibmid", label: "Sign in with IBMid" },
  { id: "sign-in-github", label: "Sign in with GitHub" },
  { id: "sign-in-sso", label: "Sign in with SSO" },
  { id: "submit-button", label: "Continue" },
];
const pageOrigin = "https://flow.idp.hashicorp.com";
const names = (origin: string, itemName?: string, uris?: string[]) =>
  idpNames({ origin, pageOrigin, itemName, ...(uris ? { uris } : {}) });

describe("a broker page's entry that names the mapped IdP", () => {
  it("picks IBMid by the IdP item's name, though the origin's label is `ibm`", () => {
    expect(labeledEntry(broker, names("https://login.ibm.com", "IBMid"))?.id).toBe("sign-in-ibmid");
  });

  it("picks IBMid by the origin's label alone, as the first word of `IBMid`", () => {
    expect(labeledEntry(broker, names("https://login.ibm.com", "Work login"))?.id).toBe(
      "sign-in-ibmid",
    );
  });

  it("picks GitHub by the origin's registrable label", () => {
    expect(labeledEntry(broker, names("https://github.com"))?.id).toBe("sign-in-github");
  });

  it("picks Google for accounts.google.com", () => {
    const entries = [
      { id: "google", label: "Continue with Google" },
      { id: "email", label: "Continue with email" },
    ];
    expect(labeledEntry(entries, names("https://accounts.google.com"))?.id).toBe("google");
  });

  it.each([
    ["the origin alone", undefined],
    ["the item's name", "Microsoft"],
  ])("picks Microsoft for login.microsoftonline.com by %s", (_, itemName) => {
    const entries = [
      { id: "microsoft", label: "Sign in with Microsoft" },
      { id: "google", label: "Sign in with Google" },
    ];
    expect(labeledEntry(entries, names("https://login.microsoftonline.com", itemName))?.id).toBe(
      "microsoft",
    );
  });

  it("picks by the IdP item's own URIs", () => {
    const entries = [
      { id: "okta", label: "Log in with Okta" },
      { id: "sso", label: "Use SSO" },
    ];
    expect(
      labeledEntry(entries, names("https://idp.example", "Team", ["https://acme.okta.com"]))?.id,
    ).toBe("okta");
  });

  it("matches case-insensitively and after NFKC, on whole words", () => {
    expect(labelWords("Ｓｉｇｎ ｉｎ with ＧｉｔＨｕｂ")).toEqual(["sign", "in", "with", "github"]);
    expect(labelNamesIdp("SIGN IN WITH GITHUB", names("https://github.com"))).toBe(true);
    // A word that merely contains the name is not it.
    expect(labelNamesIdp("Sign in with NotGitHubAtAll", names("https://github.com"))).toBe(false);
  });

  it.each([
    ["Sign in with SSO", "SSO"],
    ["Continue", "Continue"],
  ])("never picks %s, whatever the IdP item is called", (label, itemName) => {
    for (const origin of ["https://login.ibm.com", "https://github.com", "https://sso.example"])
      expect(labelNamesIdp(label, names(origin, itemName))).toBe(false);
  });

  it("picks nothing when no entry names the IdP", () => {
    expect(labeledEntry(broker, names("https://accounts.google.com", "Google"))).toBeUndefined();
  });

  it("picks nothing when two entries name the IdP", () => {
    const entries = [
      { id: "one", label: "Sign in with GitHub" },
      { id: "two", label: "GitHub Enterprise" },
    ];
    expect(labeledEntry(entries, names("https://github.com"))).toBeUndefined();
  });

  it("picks nothing when another entry matches by a prefix", () => {
    const entries = [
      { id: "ibmid", label: "Sign in with IBMid" },
      { id: "ibmcloud", label: "Sign in with IBMcloud" },
    ];
    expect(labeledEntry(entries, names("https://login.ibm.com"))).toBeUndefined();
  });

  it("leaves out a label of the page's own site", () => {
    const entries = [{ id: "own", label: "Sign in with HashiCorp" }];
    expect(labeledEntry(entries, names("https://auth.hashicorp.com"))).toBeUndefined();
  });

  it("does not take a short or generic word as a prefix", () => {
    // `login` begins `loginradius`, but it names a way to sign in, and `git` is too short.
    expect(labelNamesIdp("Login with email", names("https://accounts.loginradius.com"))).toBe(
      false,
    );
    expect(labelNamesIdp("Use git", names("https://github.com"))).toBe(false);
  });
});
