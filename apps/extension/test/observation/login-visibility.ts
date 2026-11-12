import type { LoginObservation } from "@pateat/contracts";
import { describe, expect, it } from "vitest";
import { findTargets } from "../../src/page/targets";
import { extractLoginObservation } from "../../src/observation/extract";
import type { ObservationTestContext } from "./context";

export function registerLoginVisibility({
  page,
  shadow,
  observe,
  summary,
}: Pick<ObservationTestContext, "page" | "shadow" | "observe" | "summary">) {
  describe("a form fading in from opacity 0 (Microsoft Entra, 2026-10-17)", () => {
    const keyframes = `<style>
      @keyframes in { from { opacity: 0 } }
      @keyframes out { to { opacity: 0 } }
      @keyframes hold { from, to { opacity: 0 } }
      @keyframes show { from { opacity: 0 } to { opacity: 1 } }
      @keyframes outhold { 0% { opacity: 1 } 5%, 100% { opacity: 0 } }
      @keyframes slide { 0%, 30% { opacity: 1 } 33%, 100% { opacity: 0 } }
    </style>`;
    const fields = `<input id="u" type="email"><input id="p" type="password">
      <button id="go">Next</button>`;
    const ids = (observation: LoginObservation) =>
      observation.candidates.map((candidate) => candidate.target.value);
    const container = () => document.querySelector<HTMLElement>("#fade")!;
    /** A container whose opacity transitions from 0 to 1 over 5 seconds. */
    const transition = () => {
      page(`<div id="fade" style="opacity:0"><form id="f">${fields}</form></div>`);
      const fade = container();
      // Read the style so the change below starts a transition.
      expect(getComputedStyle(fade).opacity).toBe("0");
      fade.style.transition = "opacity 5s";
      fade.style.opacity = "1";
      return fade;
    };

    it("is complete while a CSS animation or transition is still at opacity 0", () => {
      for (const animation of [
        "in 5s",
        // Held at its start, as an animation stays while the tab is not rendered.
        "in 5s 1000s both",
        "in 5s paused",
      ]) {
        page(
          `${keyframes}<div id="fade" style="animation:${animation}"><form id="f">${fields}</form></div>`,
        );
        expect(getComputedStyle(container()).opacity, animation).toBe("0");
        const observation = observe();
        expect(observation.complete, animation).toBe(true);
        expect(ids(observation), animation).toEqual(["u", "p", "go"]);
        expect(observation.candidates.at(-1), animation).toMatchObject({ label: "Next" });
      }
      transition();
      expect(getComputedStyle(container()).opacity).toBe("0");
      expect(observe().complete).toBe(true);
      // Transparent by its own style until a delayed animation without a fill starts.
      page(`${keyframes}<div id="fade" style="opacity:0;animation:show 5s 1000s">
        <form id="f">${fields}</form></div>`);
      expect(getComputedStyle(container()).opacity).toBe("0");
      expect(observe().complete).toBe(true);
      // Paused at its start by a script.
      const fade = transition();
      const [running] = fade.getAnimations();
      running!.pause();
      running!.currentTime = 0;
      expect(running!.playState).toBe("paused");
      expect(getComputedStyle(fade).opacity).toBe("0");
      expect(ids(observe())).toEqual(["u", "p", "go"]);
    });

    it("counts an animation on an ancestor further up and in a script's animate()", () => {
      page(`<main id="fade"><div><form id="f">${fields}</form></div></main>`);
      container()
        .animate([{ opacity: 0 }, { opacity: 1 }], { duration: 5000 })
        .pause();
      expect(getComputedStyle(container()).opacity).toBe("0");
      expect(observe().complete).toBe(true);
    });

    it("keeps transparent inputs that are not fading in unfillable", () => {
      const outcome = (html: string) => {
        page(`${keyframes}${html}`);
        for (const animation of container().getAnimations())
          if (animation.effect?.getTiming().fill === "forwards") animation.finish();
        const result = extractLoginObservation();
        return result.ok ? [result.observation.complete, result.gap] : result.reason;
      };
      // A trap at opacity 0 of its own inside a form that fades in.
      expect(
        outcome(`<div id="fade" style="animation:in 5s paused"><form id="f">${fields}
          <input id="trap" style="opacity:0"></form></div>`),
      ).toEqual([false, "unfillable-field"]);
      // A form at opacity 0 is refused alike with no animation, with one that holds the
      // opacity at 0, after a fade-out finished, halfway through a fade-out that then
      // holds for 100 seconds, and as a carousel's slide hidden until its next cycle.
      const still = outcome(`<div id="fade" style="opacity:0"><form id="f">${fields}</form></div>`);
      expect(still).toBe("no-candidates");
      for (const animation of [
        "hold 5s infinite",
        "out 5s forwards",
        "outhold 100s -50s",
        "slide 10s -5s infinite",
      ]) {
        const html = `<div id="fade" style="animation:${animation}"><form id="f">${fields}</form></div>`;
        expect(outcome(html), animation).toEqual(still);
        expect(getComputedStyle(container()).opacity, animation).toBe("0");
      }
    });
  });
  it("reads an input transparent only under its own shown label as visible (Airbnb, 2026-10-23)", () => {
    // A floating label: the label's text shows, its input appears once focused.
    const field = (label: string, input = "") =>
      `<label for="email" style="display:block;position:relative">${label}
        <div style="opacity:0"><input id="email" type="email" ${input}></div></label>`;
    const rest = `<input id="p" type="password"><button id="go">Log in</button>`;
    page(`<form id="f">${field("<div style='position:absolute'>Email</div>")}${rest}</form>`);
    let observation = observe();
    expect(observation.complete).toBe(true);
    expect(observation.candidates.map((candidate) => candidate.target.value)).toEqual([
      "email",
      "p",
      "go",
    ]);
    // A label whose text is transparent too, an input at opacity 0 itself, or a
    // transparent input outside its label is still faint, as a trap.
    for (const html of [
      `<div style="opacity:0">${field("Email")}</div>`,
      field("Email", `style="opacity:0"`),
      field("<span style='opacity:0'>Email</span>"),
      `<label for="email">Email</label><div style="opacity:0"><input id="email" type="email"></div>`,
      field(" "),
      // A label clipped to one pixel, as a screen-reader-only one.
      `<label for="email" style="position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0)">
        Email<div style="opacity:0"><input id="email" type="email"></div></label>`,
      // A label naming another field holds no label of this one.
      `<label for="other">Email<div style="opacity:0"><input id="email" type="email"></div></label>
        <input id="other">`,
    ]) {
      page(`<form id="f">${html}${rest}</form>`);
      observation = observe();
      expect(observation.complete, html).toBe(false);
    }
  });

  it("names the first cause of an incomplete observation, without page text (ADR 0019)", () => {
    const gap = (html: string, inShadow?: string) => {
      page(html);
      if (inShadow !== undefined) shadow("#host", inShadow);
      const result = extractLoginObservation();
      if (!result.ok) throw new Error(`no observation: ${result.reason}`);
      return [result.observation.complete, result.gap];
    };
    const form = (extra: string, button = `<button id="go">Log in</button>`) =>
      `<form id="f"><input id="u"><input id="p" type="password">${extra}${button}</form>`;
    expect(gap(form(""))).toEqual([true, undefined]);
    for (const [html, inShadow, expected] of [
      // A shadow tree's controls count as the page's own (ADR 0070): a second password
      // field outside every form, and a select in the login form.
      [`${form("")}<div id="host"></div>`, `<input type="password">`, "unlocated-field"],
      [form(`<div id="host"></div>`), `<select><option>A</option></select>`, "unsupported-control"],
      // On a page without a form, a banner's required check box joins the login's fields
      // wherever its markup sits, as one in the document's own tree does.
      [
        `<input id="u"><input id="p" type="password"><button id="go">Log in</button><div id="host"></div>`,
        `<input type="checkbox" required>`,
        "unlocated-checkbox",
      ],
      [
        `<input id="u"><input id="p" type="password"><button id="go">Log in</button><div><input type="checkbox" required></div>`,
        undefined,
        "unlocated-checkbox",
      ],
      [form(`<input id="pin" type="password" readonly>`), undefined, "unfillable-field"],
      [form(`<input id="pin" type="password" disabled>`), undefined, "unfillable-field"],
      [form(`<input id="pin" style="opacity:0">`), undefined, "unfillable-field"],
      [form(`<select id="kind"><option>A</option></select>`), undefined, "unsupported-control"],
      [form(`<input type="radio" id="kind">`), undefined, "unsupported-control"],
      [form(`<input>`), undefined, "unlocated-field"],
      [form(`<input type="checkbox" required>`), undefined, "unlocated-checkbox"],
      [form("", `<button>Log in</button><button>Log in</button>`), undefined, "unlocated-button"],
      // An icon button may be the form's only, script-run submit.
      [
        form(
          "",
          `<button type="button" aria-label="Show"><svg width="16" height="16"></svg></button>`,
        ),
        undefined,
        "unlocated-button",
      ],
      [
        `<form id="f">${Array.from({ length: 50 }, (_, at) => `<input id="i${at}">`).join("")}</form>`,
        undefined,
        "too-many-candidates",
      ],
      // The first cause in a fixed order, whatever the document order.
      [
        form(`<input>${"<select id='k'><option>A</option></select>"}`),
        undefined,
        "unsupported-control",
      ],
      [
        form(`<input type="checkbox" required><input id="r" readonly>`),
        undefined,
        "unfillable-field",
      ],
      // A field outside the login form leaves its causes.
      [
        `${form("<select id='k'></select>")}<div id="host"></div>`,
        `<input>`,
        "unsupported-control",
      ],
    ] as const)
      expect(gap(html, inShadow), html).toEqual([false, expected]);
  });

  it("names a login form's button by its accessible name when nothing else does (ADR 0048 amendment of 2026-10-23)", () => {
    // A submit input without a value, laid over the text that labels it (Amazon.co.jp,
    // 2026-10-23).
    const submit = (label: string, extra = "") =>
      `<form id="f"><input id="email" type="email" autocomplete="username">
        <span style="position:relative;display:inline-block">
          <input type="submit" aria-labelledby="say" style="position:absolute;inset:0;opacity:0.01">
          <span id="say" aria-hidden="true">${label}</span>
        </span>${extra}</form>`;
    page(submit("次に進む"));
    const named = { by: "accessible-name", value: "次に進む" } as const;
    const observation = observe();
    expect(observation.complete).toBe(true);
    expect(summary(observation).find((candidate) => candidate.role === "button")).toMatchObject({
      role: "button",
      target: named,
    });
    expect(findTargets(document, named)).toEqual([document.querySelector("input[type=submit]")]);
    const gap = (html: string) => {
      page(html);
      const result = extractLoginObservation();
      return result.ok ? [result.observation.complete, result.gap] : result.reason;
    };
    // Never a name holding a number, one another control shares, or one redaction changes.
    for (const html of [
      submit("Step 2 next"),
      submit("次に進む", `<button type="button" aria-label="次に進む">›</button>`),
      submit("taro@example.com"),
    ])
      expect(gap(html), html).toEqual([false, "unlocated-button"]);
    // A unique text or ID names it first.
    page(submit("次に進む").replace(`type="submit"`, `type="submit" id="continue"`));
    expect(summary(observe()).find((candidate) => candidate.role === "button")?.target).toEqual({
      by: "id",
      value: "continue",
    });
    // It comes before an ID another load may change, as a field's visible name does.
    page(submit("次に進む").replace(`type="submit"`, `type="submit" id="mantine-4p5f7ku4o"`));
    expect(summary(observe()).find((candidate) => candidate.role === "button")?.target).toEqual(
      named,
    );
    // A script button or an icon button that nothing else names is still left out or flaws
    // its form as before.
    expect(
      gap(`<form id="f"><input id="u"><input id="p" type="password">
        <button type="button" aria-label="Log in"><svg width="16" height="16"></svg></button></form>`),
    ).toEqual([false, "unlocated-button"]);
  });

  it("counts a control outside every form only near the sign-in fields outside one", () => {
    const outcome = (html: string) => {
      page(html);
      const result = extractLoginObservation();
      if (!result.ok) throw new Error(`no observation: ${result.reason}`);
      return [result.observation.complete, result.gap];
    };
    const login = `<div><div><dl><dt>ID</dt><dd><input id="u" autocomplete="username"></dd></dl>
      <div><button id="next">Next</button></div></div></div>`;
    const picker = `<select id="lang"><option>日本語</option></select>`;
    // A language picker in the page's footer, without footer markup, as on dアカウント's
    // login page (2026-10-23).
    expect(
      outcome(`<div><div>${login}</div><div><ul><li><div>${picker}</div></li></ul></div></div>`),
    ).toEqual([true, undefined]);
    // Beside the fields, the same select is one the sign-in may need.
    expect(
      outcome(`<div><div><dl><dd><input id="u" autocomplete="username"></dd>
        <dd>${picker}</dd></dl><button id="next">Next</button></div></div>`),
    ).toEqual([false, "unsupported-control"]);
    // When the fields' area would take the whole page, every control outside a form counts.
    expect(
      outcome(`<input id="u" autocomplete="username">${picker}<button id="n">Next</button>`),
    ).toEqual([false, "unsupported-control"]);
    // Rows of a grid layout: the select's row sits beside the fields' rows.
    const row = (cell: string) => `<div class="row"><div class="col">${cell}</div></div>`;
    expect(
      outcome(`<div><main><div class="container">${row(`<input id="u" autocomplete="username">`)}
        ${row(`<input id="p" type="password">`)}${row(picker)}${row(`<button id="go">Log in</button>`)}
        </div></main></div>`),
    ).toEqual([false, "unsupported-control"]);
    expect(
      outcome(`<div><main><div class="container">${row(`<input id="u" autocomplete="username">`)}
        ${row(`<input type="radio" id="kind">`)}${row(`<button id="go">Log in</button>`)}</div></main></div>`),
    ).toEqual([false, "unsupported-control"]);
    // A text area far from two fields, such as a feedback box at the page's foot.
    expect(
      outcome(`<div><div><div><div><div><div><input id="u"><input id="p" type="password">
        <button id="go">Log in</button></div></div></div></div></div>
        <div><div><div><textarea id="feedback"></textarea></div></div></div></div>`),
    ).toEqual([true, undefined]);
    // A field that cannot be filled counts anywhere outside a form.
    expect(
      outcome(
        `<div><div>${login}</div><div><div><div><input id="r" readonly></div></div></div></div>`,
      ),
    ).toEqual([false, "unfillable-field"]);
  });
}
