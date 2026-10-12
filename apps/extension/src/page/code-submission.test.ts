import { afterEach, describe, expect, it } from "vitest";
import { splitCodeInputs, watchCodeSubmission } from "./code-submission";

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
function codePage(
  button: string,
  react: (form: HTMLFormElement) => void = () => undefined,
  outside = "",
) {
  document.body.innerHTML = `<form id="code-form"><input id="code" autocomplete="one-time-code" inputmode="numeric" maxlength="6">${button}<p role="status" id="state"></p></form>${outside}`;
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

  it("keeps a Verify button the input handler enables at once clickable", async () => {
    const { watch, clock, type } = codePage(
      '<button id="verify" type="button" disabled>Verify</button>',
      () => {
        document.querySelector<HTMLButtonElement>("#verify")!.disabled = false;
      },
    );
    type();
    // The poll runs before the observer gets the change; the change is still read in order.
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

  it("catches an enable the page undoes at once to check the code itself", async () => {
    const button = () => document.querySelector<HTMLButtonElement>("#verify")!;
    // Within one task, before the observer runs, and across two tasks.
    const sameTask = codePage('<button id="verify" type="button" disabled>Verify</button>', () =>
      queueMicrotask(() => {
        button().disabled = false;
        button().disabled = true;
      }),
    );
    sameTask.type();
    await settle();
    expect(sameTask.watch.submitted()).toBe(true);
    sameTask.watch.stop();
    const twoTasks = codePage('<button id="verify" type="button" disabled>Verify</button>', () =>
      queueMicrotask(() => {
        button().disabled = false;
        setTimeout(() => {
          button().disabled = true;
        }, 5);
      }),
    );
    twoTasks.type();
    expect(twoTasks.watch.submitted()).toBe(false);
    await new Promise((resolve) => setTimeout(resolve, 20));
    // A poll that runs after the page enabled Verify again for another code.
    button().disabled = false;
    await settle();
    twoTasks.clock.now = 1_000;
    expect(twoTasks.watch.submitted()).toBe(true);
    twoTasks.watch.stop();
  });

  it("watches a Verify button outside its form", async () => {
    const { watch, clock, type } = codePage(
      "",
      () =>
        queueMicrotask(() => {
          document.querySelector<HTMLButtonElement>("#verify")!.disabled = false;
        }),
      '<button id="verify" type="button" form="code-form" disabled>Verify</button>',
    );
    type();
    expect(watch.submitted()).toBe(false);
    await settle();
    clock.now = 1_000;
    expect(watch.submitted()).toBe(false);
    watch.stop();
  });
});

describe("watchCodeSubmission on a split code (ADR 0027, owner decision 2026-10-12)", () => {
  /**
   * Six one-digit inputs typed as the executor does, the watch marked typed just before
   * the last digit's input event; `react` runs on every digit's input event.
   */
  function splitPage(button: string, react: (code: string) => void) {
    document.body.innerHTML = `<form>${[1, 2, 3, 4, 5, 6].map((digit) => `<input id="${digit === 1 ? "code" : `code-${digit}`}" inputmode="numeric" maxlength="1">`).join("")}${button}</form>`;
    const inputs = [...document.querySelectorAll("input")];
    for (const input of inputs)
      input.addEventListener("input", () => react(inputs.map((box) => box.value).join("")));
    const clock = { now: 0 };
    const watch = watchCodeSubmission(inputs[0]!, code, verify, location.pathname, () => clock.now);
    const type = async () => {
      for (const [index, input] of inputs.entries()) {
        input.value = "012345"[index]!;
        if (index === inputs.length - 1) watch.typed();
        input.dispatchEvent(new Event("input", { bubbles: true }));
        // The page's mutation records may be delivered between digits.
        // eslint-disable-next-line no-await-in-loop
        await settle();
      }
    };
    return { watch, clock, type };
  }

  it("does not read Verify disabled while the code is partial as a submission", async () => {
    const { watch, clock, type } = splitPage(
      '<button id="verify" type="button">Verify</button>',
      (typed) => {
        document.querySelector<HTMLButtonElement>("#verify")!.disabled = typed.length !== 6;
      },
    );
    await type();
    clock.now = 1_000;
    expect(watch.submitted()).toBe(false);
    watch.stop();
  });

  it("does not read a busy indicator shown while the code is partial as a submission", async () => {
    const { watch, clock, type } = splitPage(
      '<button id="verify" type="button">Verify</button>',
      (typed) => {
        if (typed.length === 2)
          document
            .querySelector("form")!
            .insertAdjacentHTML("beforeend", '<progress id="hint"></progress>');
      },
    );
    await type();
    clock.now = 1_000;
    expect(watch.submitted()).toBe(false);
    watch.stop();
  });

  it("still reads Verify disabled by the last digit as a submission", async () => {
    const { watch, clock, type } = splitPage(
      '<button id="verify" type="button">Verify</button>',
      (typed) => {
        if (typed.length === 6)
          document.querySelector<HTMLButtonElement>("#verify")!.disabled = true;
      },
    );
    await type();
    clock.now = 1_000;
    expect(watch.submitted()).toBe(true);
    watch.stop();
  });
});

describe("splitCodeInputs (ADR 0027, owner decision 2026-10-12)", () => {
  const boxes = (count: number, attributes = 'inputmode="numeric" maxlength="1"') =>
    Array.from({ length: count }, (_, index) => `<input id="d${index + 1}" ${attributes}>`).join(
      "",
    );
  const first = () => document.querySelector<HTMLInputElement>("#d1")!;
  const usable = () => true;

  it("returns the one-digit inputs of the form in page order", () => {
    document.body.innerHTML = `<form><input id="name">${boxes(6)}<button>Verify</button></form>`;
    expect(splitCodeInputs(first(), 6, usable)?.map((input) => input.id)).toEqual([
      "d1",
      "d2",
      "d3",
      "d4",
      "d5",
      "d6",
    ]);
  });

  it("takes inputs outside any form together, and tel or one-time-code inputs", () => {
    document.body.innerHTML = `${boxes(3, 'type="tel" maxlength="1"')}${boxes(8, 'autocomplete="one-time-code" maxlength="1"').replace(/id="d/gu, 'id="e')}`;
    expect(splitCodeInputs(first(), 6, usable)).toBeUndefined();
    document.body.innerHTML = `${boxes(3, 'type="tel" maxlength="1"')}${boxes(3, 'autocomplete="one-time-code" maxlength="1"').replace(/id="d/gu, 'id="e')}`;
    expect(splitCodeInputs(first(), 6, usable)).toHaveLength(6);
    document.body.innerHTML = boxes(8, 'type="tel" maxlength="1"');
    expect(splitCodeInputs(first(), 8, usable)).toHaveLength(8);
  });

  it.each([
    ["a code of another length", boxes(6), 7],
    ["five inputs", boxes(5), 5],
    ["nine inputs", boxes(9), 9],
    ["inputs that take two characters", boxes(6, 'inputmode="numeric" maxlength="2"'), 6],
    ["inputs the TOTP fill rule refuses", boxes(6, 'maxlength="1"'), 6],
  ])("refuses %s", (_label, html, length) => {
    document.body.innerHTML = `<form>${html}</form>`;
    expect(splitCodeInputs(first(), length, usable)).toBeUndefined();
  });

  it("refuses a first input that is not the first usable one", () => {
    document.body.innerHTML = `<form>${boxes(6)}</form>`;
    const second = document.querySelector<HTMLInputElement>("#d2")!;
    expect(splitCodeInputs(second, 6, usable)).toBeUndefined();
    expect(splitCodeInputs(first(), 6, (input) => input.id !== "d4")).toBeUndefined();
  });

  it("leaves out inputs of another form", () => {
    document.body.innerHTML = `<form>${boxes(6)}</form><form><input inputmode="numeric" maxlength="1"></form>`;
    expect(splitCodeInputs(first(), 6, usable)).toHaveLength(6);
  });
});
