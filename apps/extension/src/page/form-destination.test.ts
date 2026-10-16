import { afterEach, describe, expect, it } from "vitest";
import { formRefusal, submitsForm } from "./form-destination";

afterEach(() => {
  document.body.innerHTML = "";
  for (const base of document.head.querySelectorAll("base[data-test]")) base.remove();
});

// Another origin: another host and another port of the test page's own host.
const attacker = "https://attacker.example/collect";
const otherPort = () => `${location.protocol}//${location.hostname}:1/collect`;
const otherHost = () => `${location.protocol}//login.${location.host}/collect`;

function form(html: string): HTMLFormElement {
  document.body.innerHTML = html;
  return document.querySelector("form")!;
}

function control(selector = "input"): HTMLInputElement | HTMLButtonElement {
  return document.querySelector<HTMLInputElement | HTMLButtonElement>(selector)!;
}

/**
 * Parses `markup` as a page load does, in a frame on the test page's URL, so its form
 * owners are the parser's. Chromium's `DOMParser` and `innerHTML` do not keep a form
 * element pointer across a closed container; a document's own parser does.
 */
function parsed(markup: string): Document {
  const frame = document.createElement("iframe");
  document.body.append(frame);
  const page = frame.contentDocument!;
  page.open();
  page.write(`<!doctype html><body>${markup}`);
  page.close();
  return page;
}

describe("formRefusal", () => {
  it("allows a form that submits to the document's origin", () => {
    for (const action of [
      "/login",
      "login",
      "?step=password",
      "#password",
      `${location.origin}/login`,
      // An empty or missing action submits to the document's own URL.
      "",
      undefined,
    ]) {
      const element = form(
        `<form${action === undefined ? "" : ` action="${action}"`}><input name="password"></form>`,
      );
      expect(formRefusal(element, [control()]), String(action)).toBeUndefined();
    }
  });

  it("refuses a form that submits to another origin", () => {
    for (const action of [
      attacker,
      otherPort(),
      otherHost(),
      "//attacker.example/collect",
      // Not a URL a submission can send values to on this origin.
      "javascript:alert(1)",
      "data:text/html,collected",
      "http://[unparsable/",
    ]) {
      const element = form(`<form action="${action}"><input name="password"></form>`);
      expect(formRefusal(element, [control()]), action).toBe("form-off-origin");
    }
  });

  it("resolves a relative action against the document's base URL", () => {
    document.head.insertAdjacentHTML(
      "beforeend",
      '<base data-test href="https://attacker.example/">',
    );
    expect(document.baseURI).toBe("https://attacker.example/");
    const relative = form('<form action="login"><input name="password"></form>');
    expect(formRefusal(relative, [control()])).toBe("form-off-origin");
    const rooted = form('<form action="/login"><input name="password"></form>');
    expect(formRefusal(rooted, [control()])).toBe("form-off-origin");
    // A missing or empty action is the document's URL, which no base element moves.
    const missing = form('<form><input name="password"></form>');
    expect(formRefusal(missing, [control()])).toBeUndefined();
    const empty = form('<form action=""><input name="password"></form>');
    expect(formRefusal(empty, [control()])).toBeUndefined();
    // An absolute same-origin action stays on the origin.
    const absolute = form(`<form action="${location.origin}/login"><input name="password"></form>`);
    expect(formRefusal(absolute, [control()])).toBeUndefined();
  });

  it("reads the submitter's formaction for a click", () => {
    const element = form(
      `<form action="/login"><input name="password"><button formaction="${attacker}">Log in</button></form>`,
    );
    const button = control("button");
    expect(formRefusal(element, [button], button)).toBe("form-off-origin");
    // A fill sends nothing through the button, so its formaction does not apply there.
    expect(formRefusal(element, [control()])).toBeUndefined();
    // A same-origin formaction overrides an off-origin action.
    const overridden = form(
      `<form action="${attacker}"><input name="password"><button formaction="/login">Log in</button></form>`,
    );
    const own = control("button");
    expect(formRefusal(overridden, [own], own)).toBeUndefined();
    // An empty formaction submits to the document's URL, not to the form's action.
    const emptied = form(
      `<form action="${attacker}"><input name="password"><button formaction="">Log in</button></form>`,
    );
    const empty = control("button");
    expect(formRefusal(emptied, [empty], empty)).toBeUndefined();
    // Without a formaction, the form's action decides.
    const plain = form(
      `<form action="${attacker}"><input name="password"><input type="submit" value="Log in"></form>`,
    );
    const submit = control('input[type="submit"]');
    expect(formRefusal(plain, [submit], submit)).toBe("form-off-origin");
  });

  it("is not fooled by an input named action", () => {
    const element = form(
      `<form action="${attacker}"><input name="action" value="/login"><input name="password"></form>`,
    );
    // The named input shadows the form's `action` property.
    expect(element.action).toBeInstanceOf(HTMLInputElement);
    expect(formRefusal(element, [control('[name="password"]')])).toBe("form-off-origin");
    const own = form(
      `<form action="/login"><input name="action" value="${attacker}"><input name="password"></form>`,
    );
    expect(formRefusal(own, [control('[name="password"]')])).toBeUndefined();
  });

  it("is not fooled by a button named formAction", () => {
    const element = form(
      `<form action="/login"><input name="password"><button name="formAction" formaction="${attacker}">Log in</button></form>`,
    );
    const button = control("button");
    expect(formRefusal(element, [button], button)).toBe("form-off-origin");
  });

  it("refuses inputs a dangling injected form takes from the page's form", () => {
    // The injected form is closed with its container, but stays the parser's form element:
    // the page's own `<form>` start tag is ignored and its inputs join the injected form.
    const page = parsed(
      `<div><form id="injected" action="${attacker}"></div><form id="page" action="/login"><input id="user" name="user"><input id="password" type="password" name="password"><button id="login">Log in</button></form>`,
    );
    const password = page.querySelector<HTMLInputElement>("#password")!;
    const user = page.querySelector<HTMLInputElement>("#user")!;
    const login = page.querySelector<HTMLButtonElement>("#login")!;
    // The parse is as the attack needs: the page's form is gone and the inputs' form owner
    // is not their ancestor.
    expect(page.querySelector("#page")).toBeNull();
    expect(password.form?.id).toBe("injected");
    expect(password.closest("form")).toBeNull();
    expect(new URL(page.URL).origin).toBe(location.origin);
    expect(formRefusal(password.form, [user, password])).toBe("form-owner-detached");
    // The page's submit button submits the injected form.
    expect(login.form?.id).toBe("injected");
    expect(formRefusal(login.form, [login], login)).toBe("form-owner-detached");
  });

  it("refuses a detached form owner even when it submits to the document's origin", () => {
    const page = parsed(
      '<div><form id="injected" action="/elsewhere"></div><form id="page" action="/login"><input id="password" type="password"></form>',
    );
    const password = page.querySelector<HTMLInputElement>("#password")!;
    expect(new URL(page.URL).origin).toBe(location.origin);
    expect(password.form?.id).toBe("injected");
    expect(formRefusal(password.form, [password])).toBe("form-owner-detached");
    // One detached input among several refuses them all.
    const other = parsed(
      '<form id="own" action="/login"><input id="user"></form><div><form id="injected" action="/elsewhere"></div><input id="password" type="password">',
    );
    const user = other.querySelector<HTMLInputElement>("#user")!;
    const detached = other.querySelector<HTMLInputElement>("#password")!;
    expect(formRefusal(user.form, [user])).toBeUndefined();
    expect(formRefusal(detached.form, [user, detached])).toBe("form-owner-detached");
  });

  it("refuses inputs an unclosed injected form takes in as its own", () => {
    // Left open, the injected form holds the page's inputs as descendants: their owner is
    // their ancestor, and the injected form's action decides.
    const page = parsed(
      `<form id="injected" action="${attacker}"><form id="page" action="/login"><input id="password" type="password"></form>`,
    );
    const password = page.querySelector<HTMLInputElement>("#password")!;
    expect(password.form?.id).toBe("injected");
    expect(password.closest("form")).toBe(password.form);
    expect(formRefusal(password.form, [password])).toBe("form-off-origin");
  });

  it("refuses a page's own form placed directly in a table, a documented limitation", () => {
    // The parser moves a `<form>` in a `<table>` out of the rows it wraps, as it does a
    // dangling form, so a legacy table layout is refused too.
    const page = parsed(
      '<table><form id="page" action="/login"><tr><td><input id="password" type="password"></td></tr></form></table>',
    );
    const password = page.querySelector<HTMLInputElement>("#password")!;
    expect(password.form?.id).toBe("page");
    expect(password.closest("form")).toBeNull();
    expect(formRefusal(password.form, [password])).toBe("form-owner-detached");
  });

  it("allows a control whose form attribute names its form", () => {
    document.body.innerHTML =
      '<form id="login" action="/login"></form><input id="password" form="login"><button id="submit" form="login">Log in</button>';
    const password = control("#password");
    const button = control("#submit");
    expect(password.form?.id).toBe("login");
    expect(password.closest("form")).toBeNull();
    expect(formRefusal(password.form, [password])).toBeUndefined();
    expect(submitsForm(button)).toBe(true);
    expect(formRefusal(button.form, [button], button)).toBeUndefined();
    // The form it names still has to stay on the origin.
    document.body.innerHTML = `<form id="login" action="${attacker}"></form><input id="password" form="login">`;
    const named = control("#password");
    expect(formRefusal(named.form, [named])).toBe("form-off-origin");
  });

  it("has nothing to check for controls outside any form", () => {
    document.body.innerHTML =
      '<input id="password" type="password"><button id="login">Log in</button>';
    expect(control("#password").form).toBeNull();
    expect(formRefusal(null, [control("#password")])).toBeUndefined();
    expect(formRefusal(null, [control("#login")], control("#login"))).toBeUndefined();
  });
});

describe("submitsForm", () => {
  it("is true for a submit button or image input in a form", () => {
    document.body.innerHTML =
      '<form><button id="default">Log in</button><button id="submit" type="submit">Log in</button><input id="input" type="submit"><input id="image" type="image" alt="Log in"><button id="odd" type="unknown">Log in</button></form>';
    for (const id of ["default", "submit", "input", "image", "odd"])
      expect(submitsForm(control(`#${id}`)), id).toBe(true);
  });

  it("is false for other controls and for submit controls outside a form", () => {
    document.body.innerHTML =
      '<form><button id="button" type="button">Next</button><button id="reset" type="reset">Clear</button><input id="input-button" type="button" value="Next"><input id="text"><a id="link" href="/login">Log in</a><div id="div" role="button">Log in</div></form><button id="outside">Log in</button><input id="outside-submit" type="submit"><input id="outside-image" type="image" alt="Log in"><button id="orphan" form="missing">Log in</button>';
    for (const id of [
      "button",
      "reset",
      "input-button",
      "text",
      "link",
      "div",
      "outside",
      "outside-submit",
      "outside-image",
      "orphan",
    ])
      expect(submitsForm(document.getElementById(id)!), id).toBe(false);
  });
});
