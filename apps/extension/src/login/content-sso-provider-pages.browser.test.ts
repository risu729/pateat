import { afterEach, describe, expect, it } from "vitest";
import { readSsoIdp } from "./content-sso";

// Provider-style wording (Google, Microsoft, Apple and GitHub shapes, English and Japanese),
// written for these tests: no real page or account is used. Only an account list, an
// account confirmation or a stay-signed-in question with no sharing wording is a finite
// step; everything else stops or waits.
const username = "synthetic.person@example.test";
const initialTitle = document.title;
const html = (title: string, body: string) => {
  document.title = title;
  document.body.innerHTML = "<main>" + body + "</main>";
};
afterEach(() => {
  document.title = initialTitle;
  document.body.innerHTML = "";
});

describe("IdP pages that share an account or grant access", () => {
  it.each([
    [
      "a sign-in confirmation that shares the profile",
      "Sign in to Example App",
      `<h1>Sign in to Example App</h1><p>${username}</p><p>By continuing, Google will share your name, email address, language preference, and profile picture with Example App.</p><button id=entry>Continue</button>`,
    ],
    [
      "an account list for a destination app that shares the profile",
      "Choose an account",
      `<h1>Choose an account</h1><p>to continue to Example App</p><button id=entry>${username}</button><p>To continue, Google will share your name, email address, language preference, and profile picture with Example App.</p>`,
    ],
    [
      "a scope grant",
      "Example App wants to access your Google Account",
      `<h1>Example App wants to access your Google Account</h1><p>${username}</p><p>This will allow Example App to:</p><ul><li>See your contacts</li></ul><button id=entry>Continue</button>`,
    ],
    [
      "an account list that names its destination app alone",
      "Pick an account",
      `<h1>Pick an account</h1><p>to continue to Example App</p><button id=entry>${username}</button>`,
    ],
    [
      "a Microsoft-style permission request",
      "Permissions requested",
      `<h1>Permissions requested</h1><p>${username}</p><p>Example App needs access to your profile.</p><button id=entry>Accept</button>`,
    ],
    [
      "an Apple-style data sharing question",
      "Sign in with Apple",
      `<h1>Create an Example App account using your Apple ID</h1><p>${username}</p><p>Share My Email</p><button id=entry>Continue</button>`,
    ],
    [
      "a GitHub-style authorization",
      "Authorize Example App",
      `<h1>Authorize Example App</h1><p>${username}</p><p>Example App by example wants to access your account</p><button id=entry>Continue</button>`,
    ],
    [
      "a confirmation that past-tense shares",
      "Confirm your account",
      `<h1>Confirm your account</h1><p>${username}</p><p>Your profile was shared with Example App before.</p><button id=entry>Continue</button>`,
    ],
    [
      "a Japanese sharing confirmation",
      "Example App にログイン",
      `<h1>Example App にログイン</h1><p>${username}</p><p>続行すると、Google はあなたの名前、メールアドレス、言語設定、プロフィール写真を Example App と共有します。</p><button id=entry>続行</button>`,
    ],
    [
      "a Japanese account list for a destination app",
      "アカウントの選択",
      `<h1>アカウントの選択</h1><p>Example App に移動</p><button id=entry>${username}</button>`,
    ],
    [
      "a Japanese scope grant",
      "Example App が Google アカウントへのアクセスをリクエストしています",
      `<h1>Example App が Google アカウントへのアクセスをリクエストしています</h1><p>${username}</p><p>Example App に次のアクセスを許可します。</p><button id=entry>続行</button>`,
    ],
    [
      "a Continue as page saying what the app will receive",
      "Continue as " + username,
      `<h1>Continue as ${username}</h1><p>Example App will receive your name, email address and profile picture.</p><button id=entry>Continue</button>`,
    ],
    [
      "a Welcome back page saying what it provides",
      "Welcome back",
      `<h1>Welcome back</h1><p>${username}</p><p>We will provide Example App with your email address.</p><button id=entry>Continue</button>`,
    ],
    [
      "a Japanese Continue as page saying what the app obtains",
      username + "として続行",
      `<h1>${username}として続行</h1><p>Example Appがあなたのプロフィール情報とメールアドレスを取得します。</p><button id=entry>続行</button>`,
    ],
  ])("stops on %s", (_name, title, body) => {
    html(title, body);
    expect(readSsoIdp(document, username).kind).toBe("unsafe");
  });
});

describe("IdP pages whose heading names no finite step", () => {
  it.each([
    [
      "a Verify it's you challenge",
      "Verify it's you",
      `<h1>Verify it's you</h1><p>${username}</p><p>To help keep your account safe, Google wants to make sure it's really you trying to sign in.</p><button id=entry>Next</button>`,
    ],
    [
      "a Japanese identity challenge",
      "本人確認",
      `<h1>本人確認</h1><p>${username}</p><p>アカウントを保護するため、ログインしようとしているのがご本人であることを確認します。</p><button id=entry>次へ</button>`,
    ],
    [
      "a generic Continue page",
      "Example",
      `<h1>Example</h1><p>${username}</p><button id=entry>Continue</button>`,
    ],
    [
      "a Welcome back page, which names no account",
      "Welcome back",
      `<h1>Welcome back</h1><p>${username}</p><button id=entry>Continue</button>`,
    ],
    [
      "a Use this account page",
      "Use this account",
      `<h1>Use this account</h1><p>${username}</p><button id=entry>Continue</button>`,
    ],
    [
      "an account button under another heading",
      "Sign in",
      `<h1>Sign in</h1><button id=entry>${username}</button>`,
    ],
  ])("presses nothing on %s", (_name, title, body) => {
    html(title, body);
    expect(readSsoIdp(document, username)).toEqual({ kind: "unknown", controls: true });
  });
});

describe("IdP pages whose heading names a finite step", () => {
  it.each([
    [
      "Choose an account",
      `<h1>Choose an account</h1><button id=entry>${username}</button>`,
      "account",
    ],
    [
      "アカウントの選択",
      `<h1>アカウントの選択</h1><button id=entry>${username}</button>`,
      "account",
    ],
    [
      "Stay signed in?",
      `<h1>Stay signed in?</h1><p>${username}</p><p>Do this to reduce the number of times you are asked to sign in.</p><button id=entry>Yes</button><button>No</button>`,
      "stay-signed-in",
    ],
    [
      "サインインの状態を維持しますか?",
      `<h1>サインインの状態を維持しますか?</h1><p>${username}</p><button id=entry>はい</button><button>いいえ</button>`,
      "stay-signed-in",
    ],
    [
      "Confirm your account",
      `<h1>Confirm your account</h1><p>${username}</p><button id=entry>Continue</button>`,
      "continue",
    ],
    [
      "Continue as " + username,
      `<h1>Continue as ${username}</h1><p>${username}</p><button id=entry>Continue</button>`,
      "continue",
    ],
  ])("acts only on %s", (title, body, kind) => {
    html(title, body);
    expect(readSsoIdp(document, username)).toEqual({
      kind,
      target: { by: "id", value: "entry" },
    });
  });
  it.each([
    [
      "Continue as " + username,
      `<h1>Continue as ${username}</h1><p>Example App will know your birthday and photo albums.</p><button id=entry>Continue</button>`,
    ],
    [
      "Confirm your account",
      `<h1>Confirm your account</h1><p>${username}</p><p>Example App learns your birthday and your photo albums.</p><button id=entry>Continue</button>`,
    ],
    // Text a heading, a link or a button-like element carries counts too.
    [
      "Continue as " + username,
      `<h1>Continue as ${username}</h1><h2>Example App will get your name, email address and profile picture</h2><button id=entry>Continue</button>`,
    ],
    [
      "Continue as " + username,
      `<h1>Continue as ${username}</h1><a href="/about">Example App will get your name, email address and profile picture</a><button id=entry>Continue</button>`,
    ],
    [
      "Continue as " + username,
      `<h1>Continue as ${username}</h1><div role="button">Example App gets your name, email address and contacts</div><button id=entry>Continue</button>`,
    ],
    // A control's label inside a sentence keeps the sentence whole.
    [
      "Confirm your account",
      `<h1>Confirm your account</h1><p>${username}</p><p><a href="https://example.app">Example App</a> gets your email</p><button id=entry>Continue</button>`,
    ],
    // Controls standing alone are set aside only when they offer another account, leaving
    // or the IdP's own help, privacy and terms; ones that list what the app gets count.
    [
      "Confirm your account",
      `<h1>Confirm your account</h1><p>${username}</p><p>This app gets:</p><a href="/name">Your name and photo</a> <a href="/email">Your email address</a> <a href="/contacts">Your contacts list</a><button id=entry>Continue</button>`,
    ],
    [
      "Confirm your account",
      `<h1>Confirm your account</h1><p>${username}</p><p>This app gets:</p><a>Your name and photo</a> <a>Your email address</a> <a>Your contacts list</a><button id=entry>Continue</button>`,
    ],
    [
      "Confirm your account",
      `<h1>Confirm your account</h1><p>${username}</p><div><a href="/app">Example App</a><div>gets your email</div></div><button id=entry>Continue</button>`,
    ],
  ])("presses nothing on a confirmation %s with other text, whatever its words", (title, body) => {
    html(title, body);
    expect(["unknown", "unsafe"]).toContain(readSsoIdp(document, username).kind);
  });
  it("keeps a confirmation's short line beside the account and its controls", () => {
    html(
      "Confirm your account",
      `<h1>Confirm your account</h1><p>${username}</p><p>Not you?</p><button id=entry>Continue</button><a href="/other">Use another account</a><footer><a href="/privacy">Privacy</a> <a href="/terms">Terms</a></footer>`,
    );
    expect(readSsoIdp(document, username)).toEqual({
      kind: "continue",
      target: { by: "id", value: "entry" },
    });
  });
  it.each([
    [
      "a language picker",
      `<div role="combobox" aria-haspopup="listbox" tabindex=0><span>English (United States)</span></div>`,
    ],
    [
      "a language select",
      `<select aria-label="Language"><option selected>English (United States)</option><option>Deutsch</option><option>日本語</option></select>`,
    ],
  ])("keeps a Continue as page with %s, Help, Privacy and Terms in its footer", (_name, picker) => {
    html(
      "Continue as " + username,
      `<h1>Continue as ${username}</h1><p>${username}</p><button id=entry>Continue</button><button>Cancel</button><a href="/other">Use another account</a><footer>${picker}<ul><li><a href="/help">Help</a></li><li><a href="/privacy">Privacy</a></li><li><a href="/terms">Terms</a></li></ul></footer>`,
    );
    expect(readSsoIdp(document, username)).toEqual({
      kind: "continue",
      target: { by: "id", value: "entry" },
    });
  });
  it.each([
    [
      "a Microsoft-style account list",
      "Pick an account",
      `<h1>Pick an account</h1><button id=entry>${username}</button><button>Use another account</button>`,
      "account",
    ],
    [
      "a Microsoft-style account tile with a name and its state",
      "Pick an account",
      `<h1>Pick an account</h1><div role="button" id=entry tabindex=0><div>Synthetic Person</div><div>${username}</div><div>Signed in</div></div><div role="button" tabindex=0>Use another account</div>`,
      "account",
    ],
    [
      "a Microsoft-style stay-signed-in question",
      "Stay signed in?",
      `<h1>Stay signed in?</h1><p>${username}</p><p>Do this to reduce the number of times you are asked to sign in.</p><label><input type=checkbox> Don't show this again</label><button id=entry>Yes</button><button>No</button>`,
      "stay-signed-in",
    ],
  ])("still acts on %s", (_name, title, body, kind) => {
    html(title, body);
    expect(readSsoIdp(document, username)).toEqual({
      kind,
      target: { by: "id", value: "entry" },
    });
  });
  it("refuses a Continue as heading for another account", () => {
    html(
      "Continue as other@example.test",
      `<h1>Continue as other@example.test</h1><p>${username}</p><button id=entry>Continue</button>`,
    );
    expect(["unknown", "unsafe"]).toContain(readSsoIdp(document, username).kind);
  });
});

describe("confirmation text the page shows outside its own words", () => {
  const confirm = (extra: string, button = "<button id=entry>Continue</button>") =>
    html(
      "Confirm your account",
      `<h1>Confirm your account</h1><p>${username}</p>${extra}${button}`,
    );
  const refused = () =>
    expect(["unknown", "unsafe"]).toContain(readSsoIdp(document, username).kind);
  it("sets aside only the label of a pressed control that says more", () => {
    confirm(
      "",
      `<button id=entry aria-label="Continue">Continue: Example App gets your email address and contacts list</button>`,
    );
    refused();
  });
  it.each(['size="4"', "multiple"])("counts every option of a select with %s", (shape) => {
    confirm(
      `<select ${shape} aria-label="Language"><option selected>English</option><option>Your name and photo</option><option>Your email address</option><option>Your contacts list</option></select>`,
    );
    refused();
  });
  it.each([
    [
      "generated content",
      `<style>#note::after{content:"Example App gets your email address and contacts"}</style><p id=note></p>`,
    ],
    [
      "a frame",
      `<iframe srcdoc="<p>Example App gets your email address and contacts</p>"></iframe>`,
    ],
    ["an input button", `<input type=button value="Example App gets your email and contacts">`],
    [
      "generated content of a boxless element",
      `<style>#note{display:contents}#note::before{content:"Example App gets your email address and contacts"}</style><p id=note></p>`,
    ],
    [
      "a list marker",
      `<style>#note::marker{content:"Example App gets your email address and contacts"}</style><ul><li id=note></li></ul>`,
    ],
    [
      "a quoted list style",
      `<ul style='list-style-type:"Example App gets your email address and contacts"'><li></li></ul>`,
    ],
    [
      "an image button",
      `<input type=image src="data:image/png;base64,AAAA" alt="Example App gets your email address and contacts">`,
    ],
    [
      "quotation marks",
      `<style>q{quotes:"Example App gets your email" "address and contacts"}</style><p><q>${username}</q></p>`,
    ],
    [
      "a lettered counter",
      `<style>#mark::before{counter-increment:step;content:counter(step, lower-alpha) ". "}</style><span id=mark></span>`,
    ],
    [
      "a Roman counter",
      `<style>#mark::before{counter-increment:step;content:counters(step, ".", upper-roman)}</style><span id=mark></span>`,
    ],
    [
      "generated content reading an attribute",
      `<style>#note::after{content:attr(data-note)}</style><p id=note data-note="Example App gets your email address and contacts"></p>`,
    ],
  ])("stops on a confirmation that shows text as %s", (_name, extra) => {
    confirm(extra);
    refused();
  });
  it("stops on a confirmation whose image failed and shows its alternative text", async () => {
    confirm(
      `<img id=logo src="data:image/png;base64,AAAA" alt="Example App gets your email address and contacts">`,
    );
    // Once the image has failed, as the check before the press would see it.
    await document
      .querySelector<HTMLImageElement>("#logo")!
      .decode()
      .catch(() => undefined);
    refused();
  });
  it("keeps a confirmation whose logo is still loading", () => {
    // A lazy image far below the page has not started to load: it is not complete and
    // shows no alternative text yet, as a tenant logo still on its way does.
    confirm(
      `<div style="height:20000px"></div><img id=logo loading=lazy src="/still-loading-logo.png" alt="Example tenant logo">`,
    );
    const logo = document.querySelector<HTMLImageElement>("#logo")!;
    expect([logo.complete, logo.naturalWidth]).toEqual([false, 0]);
    expect(readSsoIdp(document, username)).toEqual({
      kind: "continue",
      target: { by: "id", value: "entry" },
    });
  });
  it("stops on a confirmation that shows text in a shadow root", () => {
    confirm("<synthetic-note></synthetic-note>");
    document
      .querySelector("synthetic-note")!
      .attachShadow({ mode: "open" })
      .append("Example App gets your email address and contacts");
    refused();
  });
  it.each([
    [
      "an icon image",
      `<style>#mark::before{content:url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg'/%3E")}</style><span id=mark></span>`,
    ],
    [
      "a counter",
      `<style>ol{counter-reset:step}#mark::before{counter-increment:step;content:counter(step) ". "}</style><span id=mark></span>`,
    ],
    [
      "an empty attribute",
      `<style>#mark::after{content:attr(data-icon)}</style><span id=mark data-icon="→"></span>`,
    ],
    ["a quotation", `<p><q>${username}</q></p>`],
  ])("keeps a confirmation whose generated content is %s", (_name, extra) => {
    confirm(extra);
    expect(readSsoIdp(document, username)).toEqual({
      kind: "continue",
      target: { by: "id", value: "entry" },
    });
  });
  it("keeps a confirmation whose shadow root, generated content and inputs say nothing", () => {
    confirm(
      `<style>#mark::before{content:"\\2192"}</style><span id=mark></span><synthetic-icon></synthetic-icon><input type=button value="Cancel">`,
    );
    document.querySelector("synthetic-icon")!.attachShadow({ mode: "open" }).innerHTML =
      "<style>:host{display:inline-block}</style><svg width=8 height=8></svg>";
    expect(readSsoIdp(document, username)).toEqual({
      kind: "continue",
      target: { by: "id", value: "entry" },
    });
  });
});
