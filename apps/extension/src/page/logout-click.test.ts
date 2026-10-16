import { afterEach, describe, expect, it } from "vitest";
import { clickedLogout, logoutName } from "./logout-click";

afterEach(() => {
  document.body.innerHTML = "";
});

/** Clicks the element `selector` names in `html`, or `target`, and reads the click. */
const click = (html: string, selector: string, target?: Element) => {
  document.body.innerHTML = html;
  let read: boolean | undefined;
  const listener = (event: Event) => {
    read = clickedLogout(event);
    // A link would leave the test page.
    event.preventDefault();
  };
  addEventListener("click", listener, true);
  try {
    (target ?? document.querySelector(selector)!).dispatchEvent(
      new MouseEvent("click", { bubbles: true, composed: true }),
    );
  } finally {
    removeEventListener("click", listener, true);
  }
  return read;
};

describe("logoutName", () => {
  it("reads words that log out, in English as whole words and in Japanese anywhere", () => {
    for (const name of [
      "Log out",
      "Logout",
      "LOG-OUT",
      "Sign out",
      "signout",
      "Log off",
      "Sign off",
      "Log out of all accounts",
      "ログアウト",
      "ログアウトする",
      "ｻｲﾝｱｳﾄ",
      "ログオフ",
    ])
      expect(logoutName(name), name).toBe("logout");
  });

  it("reads nothing in other words", () => {
    for (const name of [
      "Logged out",
      "Sign in",
      "Blog outline",
      "Catalog off-season",
      "Switch account",
      "Settings",
      "ログイン",
    ])
      expect(logoutName(name), name).toBeUndefined();
  });

  it("tells a logout of other sessions apart", () => {
    for (const name of [
      "Log out of other devices",
      "Sign out all other sessions",
      "Log out another browser",
      "他の端末からログアウト",
      "ほかのデバイスをログアウト",
      "別のブラウザからサインアウト",
    ])
      expect(logoutName(name), name).toBe("elsewhere");
  });
});

describe("clickedLogout", () => {
  it("reads the clicked control's text", () => {
    expect(click(`<button>Log out</button>`, "button")).toBe(true);
    expect(click(`<a href="#logout"><span>Sign out</span></a>`, "span")).toBe(true);
    expect(click(`<input type="submit" value="Logout">`, "input")).toBe(true);
    expect(click(`<div role="menuitem"><span>ログアウト</span></div>`, "span")).toBe(true);
    expect(click(`<li tabindex="0">サインアウト</li>`, "li")).toBe(true);
    expect(click(`<div style="cursor: pointer"><span>Log off</span></div>`, "span")).toBe(true);
    expect(click(`<button>Sign in</button>`, "button")).toBe(false);
  });

  it("reads an icon's names, as the observation does", () => {
    expect(click(`<button aria-label="Log out"><svg></svg></button>`, "svg")).toBe(true);
    expect(click(`<button title="Sign out"><svg></svg></button>`, "svg")).toBe(true);
    expect(
      click(`<button><svg><title>Log out</title><path d="M0 0"></path></svg></button>`, "path"),
    ).toBe(true);
    expect(click(`<a href="#x"><img alt="Logout" src="data:,"></a>`, "img")).toBe(true);
    expect(click(`<button><i aria-label="ログアウト"></i></button>`, "i")).toBe(true);
    expect(
      click(
        `<span id="label">Sign out</span><button aria-labelledby="label"><svg></svg></button>`,
        "button",
      ),
    ).toBe(true);
    expect(
      click(
        `<span id="tip" hidden>Log out</span><button aria-describedby="tip"><svg></svg></button>`,
        "button",
      ),
    ).toBe(true);
    expect(click(`<button aria-label="Settings"><svg></svg></button>`, "svg")).toBe(false);
  });

  it("reads the text beside a control that names nothing itself", () => {
    expect(click(`<li><button><svg></svg></button><span>Log out</span></li>`, "button")).toBe(true);
    expect(click(`<div><span>ログアウト</span><div><button></button></div></div>`, "button")).toBe(
      true,
    );
    expect(click(`<li><button><svg></svg></button> Sign out</li>`, "button")).toBe(true);
    // Never across another control, nor when the control names itself.
    expect(
      click(`<div><button>Log out</button><button id="icon"><svg></svg></button></div>`, "#icon"),
    ).toBe(false);
    expect(click(`<div><span>Log out</span><button>Cancel</button></div>`, "button")).toBe(false);
  });

  it("does not count a logout of other sessions", () => {
    expect(click(`<button>Log out of other devices</button>`, "button")).toBe(false);
    expect(click(`<button aria-label="他の端末からログアウト">ログアウト</button>`, "button")).toBe(
      false,
    );
  });

  it("does not read a container or text that is no control", () => {
    expect(click(`<p>Log out</p>`, "p")).toBe(false);
    const paragraph = `${"This page explains how to log out of your account safely. ".repeat(3)}`;
    expect(
      click(`<div style="cursor: pointer"><p>${paragraph}</p><button>OK</button></div>`, "p"),
    ).toBe(false);
  });

  it("reads a control in an open shadow root", () => {
    const host = document.createElement("div");
    const root = host.attachShadow({ mode: "open" });
    root.innerHTML = `<button><span>Log out</span></button>`;
    document.body.append(host);
    let read: boolean | undefined;
    const listener = (event: Event) => {
      read = clickedLogout(event);
    };
    addEventListener("click", listener, true);
    root
      .querySelector("span")!
      .dispatchEvent(new MouseEvent("click", { bubbles: true, composed: true }));
    removeEventListener("click", listener, true);
    expect(read).toBe(true);
  });
});
