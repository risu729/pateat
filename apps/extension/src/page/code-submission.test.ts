import { afterEach, describe, expect, it } from "vitest";
import { watchCodeSubmission } from "./code-submission";

afterEach(() => {
  document.body.innerHTML = "";
});

const code = { by: "id", value: "code" } as const;
const verify = { by: "id", value: "verify" } as const;
/** Lets mutation observer callbacks and other microtasks run. */
const settle = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

/**
 * A code form with a fake clock, so a late poll, as in a background tab whose timers
 * Chrome throttles, is a clock step rather than a real wait. `react` runs on the code's
 * input event, as the page's own handler.
 */
function codePage(button: string, react: (form: HTMLFormElement) => void = () => undefined) {
  document.body.innerHTML = `<form><input id="code" autocomplete="one-time-code" inputmode="numeric" maxlength="6">${button}<p role="status" id="state"></p></form>`;
  const form = document.querySelector("form")!;
  const input = document.querySelector<HTMLInputElement>("#code")!;
  input.addEventListener("input", () => react(form));
  const clock = { now: 0 };
  const watch = watchCodeSubmission(input, code, verify, location.pathname, () => clock.now);
  const type = () => {
    input.value = "012345";
    watch.typed();
    input.dispatchEvent(new Event("input", { bubbles: true }));
  };
  return { watch, clock, type, form };
}

describe("watchCodeSubmission (ADR 0027)", () => {
  it("counts a Verify button enabled in a microtask as enabled in time, however late the poll", async () => {
    const { watch, clock, type } = codePage(
      '<button id="verify" type="button" disabled>Verify</button>',
      () =>
        queueMicrotask(() => {
          document.querySelector<HTMLButtonElement>("#verify")!.disabled = false;
        }),
    );
    type();
    // The first check runs before the page's microtask.
    expect(watch.submitted()).toBe(false);
    await settle();
    clock.now = 1_000;
    expect(watch.submitted()).toBe(false);
    watch.stop();
  });

  it("counts a button enabled at the first check after the code went in", () => {
    const { watch, clock, type } = codePage('<button id="verify" type="button">Verify</button>');
    type();
    clock.now = 1_000;
    expect(watch.submitted()).toBe(false);
    watch.stop();
  });

  it("reads a Verify button still disabled half a second later as the page checking the code", async () => {
    const kept = codePage('<button id="verify" type="button" disabled>Verify</button>');
    kept.type();
    expect(kept.watch.submitted()).toBe(false);
    kept.clock.now = 400;
    expect(kept.watch.submitted()).toBe(false);
    kept.clock.now = 501;
    expect(kept.watch.submitted()).toBe(true);
    kept.watch.stop();
    // Enabled only after that, as for another code once the page refused this one.
    const late = codePage('<button id="verify" type="button" disabled>Verify</button>');
    late.type();
    expect(late.watch.submitted()).toBe(false);
    late.clock.now = 900;
    document.querySelector<HTMLButtonElement>("#verify")!.disabled = false;
    await settle();
    late.clock.now = 1_000;
    expect(late.watch.submitted()).toBe(true);
    late.watch.stop();
  });

  it("takes neither a Verify button rendered again nor a status message for a submission", async () => {
    const { watch, clock, type } = codePage(
      '<button id="verify" type="button">Verify</button>',
      (form) => {
        const old = form.querySelector("#verify")!;
        old.replaceWith(old.cloneNode(true));
        form.querySelector("#state")!.textContent = "6 of 6 digits";
      },
    );
    type();
    await settle();
    clock.now = 2_000;
    expect(watch.submitted()).toBe(false);
    // A button disabled after it was enabled is the page's own submission.
    document.querySelector<HTMLButtonElement>("#verify")!.disabled = true;
    expect(watch.submitted()).toBe(true);
    watch.stop();
  });
});
