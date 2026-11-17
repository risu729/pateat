import { afterEach, describe, expect, it, vi } from "vitest";
import { userEvent } from "vitest/browser";
import { watchPersonSteps } from "./person-step";

// The person's own sign-in step in the tab's top document (ADR 0034 amendment of
// 2026-11-17), read in Chromium for real trusted events and transient activation. The test
// page is a frame of the runner, so `top` stands in for the tab's top document.
let stop: (() => void) | undefined;
afterEach(() => {
  stop?.();
  stop = undefined;
  document.body.innerHTML = "";
});

function page(html: string, top = true) {
  document.body.innerHTML = html;
  // The test page itself stays.
  for (const form of document.forms) form.addEventListener("submit", (e) => e.preventDefault());
  const report = vi.fn();
  stop = watchPersonSteps(document, report, { top });
  return report;
}
const emailForm = `<form id="email"><input id="address" type="email">
  <button id="next">Next</button><button id="show" type="button">Show</button></form>`;

describe("a person's sign-in step", () => {
  // First, before any input gives the page activation.
  it("is no event a script makes, even a submit the browser fires for it", async () => {
    const report = page(emailForm);
    const form = document.querySelector<HTMLFormElement>("#email")!;
    form.dispatchEvent(new SubmitEvent("submit", { bubbles: true, cancelable: true }));
    form.requestSubmit();
    document.querySelector<HTMLButtonElement>("#next")!.click();
    document
      .querySelector("#address")!
      .dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    expect(report).not.toHaveBeenCalled();
  });

  it("is a click on the submit button of a form with an identifier input", async () => {
    const report = page(emailForm);
    await userEvent.click(document.querySelector("#show")!);
    expect(report).not.toHaveBeenCalled();
    await userEvent.click(document.querySelector("#next")!);
    expect(report).toHaveBeenCalled();
  });

  it("is Enter in an input of such a form", async () => {
    const report = page(`<form><input id="user" autocomplete="username"></form>`);
    await userEvent.type(document.querySelector("#user")!, "{Enter}");
    expect(report).toHaveBeenCalled();
  });

  it("is a password form's too, and no other form's", async () => {
    const password = page(
      `<form><input id="secret" type="password"><button id="go">Go</button></form>`,
    );
    await userEvent.click(document.querySelector("#go")!);
    expect(password).toHaveBeenCalled();
    stop?.();
    const search = page(
      `<form><input id="q"><input type="hidden" autocomplete="username"><button id="find">Find</button></form>`,
    );
    await userEvent.click(document.querySelector("#find")!);
    await userEvent.type(document.querySelector("#q")!, "{Enter}");
    expect(search).not.toHaveBeenCalled();
  });

  it("is never a frame's", async () => {
    const report = page(emailForm, false);
    await userEvent.click(document.querySelector("#next")!);
    expect(report).not.toHaveBeenCalled();
  });
});
