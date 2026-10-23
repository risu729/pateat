import { afterEach, describe, expect, it } from "vitest";
import {
  clickDestinations,
  clickRefusal,
  formDestination,
  formDestinations,
  formRefusal,
  submitsForm,
} from "./form-destination";

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
 * element pointer across a closed container; a document's own parser does. Its elements
 * belong to the frame's realm, so `instanceof` checks such as `submitsForm`'s do not hold.
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
      form(
        `<form${action === undefined ? "" : ` action="${action}"`}><input name="password"></form>`,
      );
      expect(formRefusal(control(), "fill"), String(action)).toBeUndefined();
    }
  });

  it("refuses a form that submits to another origin", () => {
    for (const action of [
      attacker,
      otherPort(),
      otherHost(),
      "//attacker.example/collect",
      // Not a URL a submission can send values to on this origin.
      "data:text/html,collected",
      "vbscript:collect",
      "http://[unparsable/",
    ]) {
      form(`<form action="${action}"><input name="password"></form>`);
      expect(formRefusal(control(), "fill"), action).toBe("form-off-origin");
    }
  });

  it("allows a form whose destination is a javascript: URL", () => {
    // A legacy form whose own handler posts the values; submitting it sends them nowhere.
    for (const action of [
      "javascript:void(0)",
      "javascript:;",
      " JavaScript:login()",
      "java&#9;script:void(0)",
    ]) {
      form(`<form action="${action}"><input name="password"><button>Log in</button></form>`);
      expect(formRefusal(control(), "fill"), action).toBeUndefined();
      expect(formRefusal(control("button"), "click"), action).toBeUndefined();
    }
    // A javascript: formaction stands in for an off-origin action on a click only.
    form(
      `<form action="${attacker}"><input name="password"><button formaction="javascript:void(0)">Log in</button></form>`,
    );
    expect(formRefusal(control("button"), "click")).toBeUndefined();
    expect(formRefusal(control(), "fill")).toBe("form-off-origin");
    // An off-origin formaction still refuses the click on a javascript: form.
    form(
      `<form action="javascript:void(0)"><input name="password"><button formaction="${attacker}">Log in</button></form>`,
    );
    expect(formRefusal(control(), "fill")).toBeUndefined();
    expect(formRefusal(control("button"), "click")).toBe("form-off-origin");
    // A <base href> does not move a javascript: URL, which is absolute.
    document.head.insertAdjacentHTML(
      "beforeend",
      '<base data-test href="https://attacker.example/">',
    );
    form('<form action="javascript:void(0)"><input name="password"></form>');
    expect(formRefusal(control(), "fill")).toBeUndefined();
  });

  it("resolves a relative action against the document's base URL", () => {
    document.head.insertAdjacentHTML(
      "beforeend",
      '<base data-test href="https://attacker.example/">',
    );
    expect(document.baseURI).toBe("https://attacker.example/");
    form('<form action="login"><input name="password"></form>');
    expect(formRefusal(control(), "fill")).toBe("form-off-origin");
    form('<form action="/login"><input name="password"></form>');
    expect(formRefusal(control(), "fill")).toBe("form-off-origin");
    // A missing or empty action is the document's URL, which no base element moves.
    form('<form><input name="password"></form>');
    expect(formRefusal(control(), "fill")).toBeUndefined();
    form('<form action=""><input name="password"></form>');
    expect(formRefusal(control(), "fill")).toBeUndefined();
    // An absolute same-origin action stays on the origin.
    form(`<form action="${location.origin}/login"><input name="password"></form>`);
    expect(formRefusal(control(), "fill")).toBeUndefined();
  });

  it("reads the submitter's formaction for a click", () => {
    form(
      `<form action="/login"><input name="password"><button formaction="${attacker}">Log in</button></form>`,
    );
    expect(formRefusal(control("button"), "click")).toBe("form-off-origin");
    // A fill sends nothing through the button, so its formaction does not apply there.
    expect(formRefusal(control(), "fill")).toBeUndefined();
    expect(formRefusal(control("button"), "fill")).toBeUndefined();
    // A same-origin formaction overrides an off-origin action.
    form(
      `<form action="${attacker}"><input name="password"><button formaction="/login">Log in</button></form>`,
    );
    expect(formRefusal(control("button"), "click")).toBeUndefined();
    // An empty formaction submits to the document's URL, not to the form's action.
    form(
      `<form action="${attacker}"><input name="password"><button formaction="">Log in</button></form>`,
    );
    expect(formRefusal(control("button"), "click")).toBeUndefined();
    // Without a formaction, the form's action decides.
    form(
      `<form action="${attacker}"><input name="password"><input type="submit" value="Log in"></form>`,
    );
    expect(formRefusal(control('input[type="submit"]'), "click")).toBe("form-off-origin");
  });

  it("is not fooled by an input named action", () => {
    const element = form(
      `<form action="${attacker}"><input name="action" value="/login"><input name="password"></form>`,
    );
    // The named input shadows the form's `action` property.
    expect(element.action).toBeInstanceOf(HTMLInputElement);
    expect(formRefusal(control('[name="password"]'), "fill")).toBe("form-off-origin");
    form(
      `<form action="/login"><input name="action" value="${attacker}"><input name="password"></form>`,
    );
    expect(formRefusal(control('[name="password"]'), "fill")).toBeUndefined();
  });

  it("is not fooled by a button named formAction", () => {
    form(
      `<form action="/login"><input name="password"><button name="formAction" formaction="${attacker}">Log in</button></form>`,
    );
    expect(formRefusal(control("button"), "click")).toBe("form-off-origin");
  });

  it("is not fooled by inputs that shadow the form's methods and document", () => {
    for (const name of ["getAttribute", "ownerDocument"]) {
      const element = form(
        `<form action="/login"><input name="${name}"><input name="password"><button>Log in</button></form>`,
      );
      // The named input replaces the form's own property.
      expect(Reflect.get(element, name), name).toBeInstanceOf(HTMLInputElement);
      expect(formRefusal(control('[name="password"]'), "fill"), name).toBeUndefined();
      expect(formRefusal(control("button"), "click"), name).toBeUndefined();
      form(
        `<form action="${attacker}"><input name="${name}"><input name="password"><button>Log in</button></form>`,
      );
      expect(formRefusal(control('[name="password"]'), "fill"), name).toBe("form-off-origin");
      expect(formRefusal(control("button"), "click"), name).toBe("form-off-origin");
    }
  });

  it("is not fooled by images that shadow the document's URLs", () => {
    for (const name of ["URL", "baseURI"]) {
      form(`<img name="${name}" alt=""><form action="/login"><input name="password"></form>`);
      // A named image replaces the document's own property.
      expect(Reflect.get(document, name), name).toBeInstanceOf(HTMLImageElement);
      expect(formRefusal(control('[name="password"]'), "fill"), name).toBeUndefined();
      form(`<img name="${name}" alt=""><form><input name="password"></form>`);
      expect(formRefusal(control('[name="password"]'), "fill"), name).toBeUndefined();
      form(`<img name="${name}" alt=""><form action="${attacker}"><input name="password"></form>`);
      expect(formRefusal(control('[name="password"]'), "fill"), name).toBe("form-off-origin");
    }
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
    // is the injected form, which is not their ancestor.
    expect(page.querySelector("#page")).toBeNull();
    expect(password.form?.id).toBe("injected");
    expect(user.form?.id).toBe("injected");
    expect(password.closest("form")).toBeNull();
    expect(new URL(page.URL).origin).toBe(location.origin);
    // The injected form's action is what a submission would use, and it is off the origin.
    expect(formRefusal(user, "fill")).toBe("form-off-origin");
    expect(formRefusal(password, "fill")).toBe("form-off-origin");
    // The page's submit button submits the injected form.
    expect(login.form?.id).toBe("injected");
    expect(formRefusal(login, "click")).toBe("form-off-origin");
  });

  it("allows a dangling injected form that submits to the document's origin", () => {
    // Only the destination is checked: an injected form whose action stays on the page's
    // origin sends the values nowhere a refusal could keep them from.
    const page = parsed(
      '<div><form id="injected" action="/elsewhere"></div><form id="page" action="/login"><input id="password" type="password"></form>',
    );
    const password = page.querySelector<HTMLInputElement>("#password")!;
    expect(new URL(page.URL).origin).toBe(location.origin);
    expect(password.form?.id).toBe("injected");
    expect(password.closest("form")).toBeNull();
    expect(formRefusal(password, "fill")).toBeUndefined();
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
    expect(formRefusal(password, "fill")).toBe("form-off-origin");
  });

  it("checks a form placed directly in a table by its destination", () => {
    // The parser moves a `<form>` in a `<table>` out of the rows it wraps, yet its rows'
    // inputs still belong to it.
    for (const [action, refusal] of [
      ["/login", undefined],
      [attacker, "form-off-origin"],
    ] as const) {
      const page = parsed(
        `<table><form id="page" action="${action}"><tr><td><input id="password" type="password"></td></tr><tr><td><button id="login">Log in</button></td></tr></form></table>`,
      );
      const password = page.querySelector<HTMLInputElement>("#password")!;
      const login = page.querySelector<HTMLButtonElement>("#login")!;
      expect(password.form?.id, action).toBe("page");
      expect(password.closest("form"), action).toBeNull();
      expect(formRefusal(password, "fill"), action).toBe(refusal);
      expect(formRefusal(login, "click"), action).toBe(refusal);
    }
  });

  it("checks a form left open in a table cell by its destination", () => {
    // A legacy layout opens the form in one cell and its inputs in the next rows: the cell's
    // end closes the form element, and the parser still gives it the later inputs.
    for (const [action, refusal] of [
      ["/login", undefined],
      [attacker, "form-off-origin"],
    ] as const) {
      const page = parsed(
        `<table><tr><td><form id="page" action="${action}"></td></tr><tr><td><input id="password" type="password"></td></tr><tr><td><input id="login" type="submit" value="Log in"></td></tr></table>`,
      );
      const password = page.querySelector<HTMLInputElement>("#password")!;
      const login = page.querySelector<HTMLInputElement>("#login")!;
      expect(password.form?.id, action).toBe("page");
      expect(password.closest("form"), action).toBeNull();
      expect(formRefusal(password, "fill"), action).toBe(refusal);
      expect(formRefusal(login, "click"), action).toBe(refusal);
    }
  });

  it("allows a control whose form attribute names its form", () => {
    document.body.innerHTML =
      '<form id="login" action="/login"></form><input id="password" form="login"><button id="submit" form="login">Log in</button>';
    const password = control("#password");
    const button = control("#submit");
    expect(password.form?.id).toBe("login");
    expect(password.closest("form")).toBeNull();
    expect(formRefusal(password, "fill")).toBeUndefined();
    expect(submitsForm(button)).toBe(true);
    expect(formRefusal(button, "click")).toBeUndefined();
    // The form it names still has to stay on the origin.
    document.body.innerHTML = `<form id="login" action="${attacker}"></form><input id="password" form="login">`;
    expect(formRefusal(control("#password"), "fill")).toBe("form-off-origin");
  });

  it("has nothing to check for controls outside any form", () => {
    document.body.innerHTML =
      '<input id="password" type="password"><button id="login">Log in</button>';
    expect(control("#password").form).toBeNull();
    expect(formRefusal(control("#password"), "fill")).toBeUndefined();
    expect(formRefusal(control("#login"), "click")).toBeUndefined();
  });
});

describe("formDestination", () => {
  it("leaves an HTTP(S) destination on another origin to the background", () => {
    for (const [action, url] of [
      [attacker, attacker],
      [otherHost(), otherHost()],
      [otherPort(), otherPort()],
      ["//attacker.example/collect", `${location.protocol}//attacker.example/collect`],
      ["http://attacker.example/collect", "http://attacker.example/collect"],
    ]) {
      form(`<form action="${action}"><input name="password"></form>`);
      expect(formDestination(control(), "fill"), action).toEqual({ kind: "other-origin", url });
    }
  });

  it("allows the document's origin and javascript: URLs and refuses other schemes", () => {
    for (const [action, kind] of [
      ["/login", "allowed"],
      ["javascript:void(0)", "allowed"],
      ["data:text/html,collected", "refused"],
      ["vbscript:collect", "refused"],
      ["mailto:collect@attacker.example", "refused"],
      ["ftp://attacker.example/collect", "refused"],
      ["http://[unparsable/", "refused"],
    ] as const) {
      form(`<form action="${action}"><input name="password"></form>`);
      expect(formDestination(control(), "fill"), action).toEqual({ kind });
    }
  });

  it("checks a component's field against every form around it (ADR 0070)", () => {
    // A field in a component's shadow tree inside an off-origin form.
    document.body.innerHTML = `<form action="${attacker}"><x-field id="host"></x-field></form>`;
    const root = document.querySelector("#host")!.attachShadow({ mode: "open" });
    root.innerHTML =
      '<input name="password"><button id="submit" formaction="/login">Log in</button>';
    const password = root.querySelector("input")!;
    expect(password.form).toBeNull();
    expect(formDestination(password, "fill")).toEqual({ kind: "other-origin", url: attacker });
    // The button's `formaction` is not the outer form's own, so the form's action counts.
    const button = root.querySelector("button")!;
    expect(submitsForm(button)).toBe(true);
    expect(formDestination(button, "click")).toEqual({ kind: "other-origin", url: attacker });
    // A form of the component's own on the origin does not hide the one around it.
    const inner = document.createElement("form");
    inner.action = "/login";
    const field = document.createElement("input");
    inner.append(field);
    root.append(inner);
    expect(field.form).toBe(inner);
    expect(formDestination(field, "fill")).toEqual({ kind: "other-origin", url: attacker });
    document.querySelector("form")!.setAttribute("action", "/login");
    expect(formDestination(field, "fill")).toEqual({ kind: "allowed" });
    // Each form gets its own destination, so one the background allows hides no other.
    inner.action = otherHost();
    document.querySelector("form")!.setAttribute("action", attacker);
    expect(formDestinations(field, "fill")).toEqual([
      { kind: "other-origin", url: otherHost() },
      { kind: "other-origin", url: attacker },
    ]);
    const submit = document.createElement("button");
    inner.append(submit);
    expect(clickDestinations(submit)).toEqual([
      { kind: "other-origin", url: otherHost() },
      { kind: "other-origin", url: attacker },
    ]);
  });

  it("names each control a click submits through", () => {
    document.body.innerHTML = `<form action="${otherHost()}"><label for="other" role="button"><button id="submit" formaction="/login"><span id="inner">Log in</span></button></label></form><form action="${attacker}"><input id="other" type="submit"></form>`;
    expect(clickDestinations(document.getElementById("inner")!)).toEqual([
      { kind: "allowed" },
      { kind: "other-origin", url: attacker },
    ]);
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

describe("clickRefusal", () => {
  it("checks the submit button around or labelled by the clicked element", () => {
    for (const [action, refusal] of [
      [attacker, "form-off-origin"],
      ["/login", undefined],
    ] as const) {
      document.body.innerHTML = `<form action="${action}"><input id="q" name="q"><button id="submit"><span id="inner" role="button">Log in</span><label id="bare-in-button" role="button">Log in</label><label id="text-in-button" for="q" role="button">Log in</label></button><label id="label" for="other" role="button">Log in</label><input id="other" type="submit"><label role="button"><span id="in-label">Log in</span><input type="image" alt="Log in"></label></form>`;
      for (const id of ["inner", "bare-in-button", "text-in-button", "label", "in-label"])
        expect(clickRefusal(document.getElementById(id)!), `${action} ${id}`).toBe(refusal);
    }
  });

  it("checks a label's submit button in another form", () => {
    document.body.innerHTML = `<form action="/login"><label id="label" for="other" role="button">Log in</label></form><form action="${attacker}"><input id="other" type="submit"></form>`;
    expect(clickRefusal(document.getElementById("label")!)).toBe("form-off-origin");
  });

  it("has nothing to check for a click that submits no form", () => {
    document.body.innerHTML = `<form action="${attacker}"><div id="div" role="button">Log in</div><a id="link" href="/next"><span id="in-link">Next</span></a><label id="bare" role="button">Log in</label><button id="button" type="button">Next</button></form>`;
    for (const id of ["div", "in-link", "bare", "button"])
      expect(clickRefusal(document.getElementById(id)!), id).toBeUndefined();
  });
});
