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
    expect(readSsoIdp(document, username)).toEqual({ kind: "unknown" });
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
      "a Microsoft-style account list",
      "Pick an account",
      `<h1>Pick an account</h1><button id=entry>${username}</button><button>Use another account</button>`,
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
