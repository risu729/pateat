import type { LoginObservation } from "@pateat/contracts";
import { afterEach, describe, expect, it } from "vitest";
import { extractLoginObservation, extractSignedInObservation } from "./extract";

// A click layer named by the text laid over it (ADR 0090). Synthetic page, a reduced copy
// of UNSW Endeavour's sign-in dialog: no form, button, role or label, every `<div>` carries
// `tabindex="-1"`, and "log on" takes its clicks on an empty layer under the text.
const logOn = `<div id="214:spaceElement" tabindex="-1" style="position:absolute;left:165px;top:185px;width:99px;height:20px">
    <div id="274" tabindex="-1" style="position:absolute;inset:0;z-index:1;pointer-events:none"><div id="274:areaElement" tabindex="-1" style="position:absolute;inset:0;cursor:pointer;pointer-events:auto"></div></div>
    <div id="276" tabindex="-1" style="position:absolute;inset:0;z-index:2;pointer-events:none;background:#ddd"></div>
    <div id="284" tabindex="-1" style="position:absolute;inset:0;z-index:6;pointer-events:none"><div tabindex="-1" style="position:absolute;left:2px;top:2px">log on</div></div>
  </div>`;
const fields = `<div tabindex="-1"><input id="232:credentialElement" autocomplete="username"></div>
  <div tabindex="-1"><input id="240:credentialElement" type="password" autocomplete="current-password"></div>`;
const dialog = (inside = `${fields}${logOn}`) =>
  `<div id="dialog" tabindex="-1" style="position:absolute;left:0;top:0;width:500px;height:234px">${inside}</div>`;

afterEach(() => {
  document.body.innerHTML = "";
});

const observe = (html: string): LoginObservation => {
  document.body.innerHTML = html;
  const result = extractLoginObservation();
  if (!result.ok) throw new Error(`no observation: ${result.reason}`);
  return result.observation;
};
const layers = (observation: LoginObservation) =>
  observation.candidates.filter((candidate) => candidate.overlaid);

describe("a click layer beside fields outside every form", () => {
  it("describes the two inputs and the layer as a button named by its overlaid text", () => {
    const observation = observe(dialog());
    expect(observation.candidates).toEqual([
      expect.objectContaining({
        role: "text",
        target: { by: "id", value: "232:credentialElement" },
        autocomplete: "username",
      }),
      expect.objectContaining({
        role: "password",
        target: { by: "id", value: "240:credentialElement" },
        autocomplete: "current-password",
      }),
      expect.objectContaining({
        role: "button",
        label: "log on",
        overlaid: true,
        target: { by: "id", value: "274:areaElement" },
      }),
    ]);
    // The layer's candidate carries nothing else, and no group, as the fields have none.
    const [button] = layers(observation);
    expect(button).toEqual({
      id: button!.id,
      role: "button",
      label: "log on",
      overlaid: true,
      target: { by: "id", value: "274:areaElement" },
    });
  });

  it("describes none beside a real button near the formless fields", () => {
    const observation = observe(
      dialog(
        `${fields}${logOn}<button id="go" type="button" style="position:absolute;left:300px;top:185px">Sign in</button>`,
      ),
    );
    expect(layers(observation)).toEqual([]);
    expect(observation.candidates).toContainEqual(
      expect.objectContaining({ role: "button", target: { by: "id", value: "go" } }),
    );
  });

  it("describes none when the fields are inside a form", () => {
    const observation = observe(dialog(`<form>${fields}</form>${logOn}`));
    expect(layers(observation)).toEqual([]);
    const inForm = observe(dialog(`<form>${fields}${logOn}</form>`));
    expect(layers(inForm)).toEqual([]);
  });

  it("describes none whose text a click does not reach", () => {
    const observation = observe(
      dialog(
        `${fields}${logOn}<div style="position:absolute;inset:0;z-index:20;pointer-events:auto"></div>`,
      ),
    );
    expect(layers(observation)).toEqual([]);
  });
});

// A signed-in page with nothing else to describe shows only click layers (ADR 0029
// amendment of 2026-11-28), as Endeavour's student record chooser after "log on".
describe("a signed-in page of click layers only", () => {
  const refusal = (html: string) => {
    document.body.innerHTML = html;
    return extractSignedInObservation();
  };

  it("says it shows only click layers", () => {
    expect(refusal(dialog(logOn))).toEqual({
      ok: false,
      reason: "no-candidates",
      layersOnly: true,
    });
  });

  it("does not say so with no click layer, as a page still loading", () => {
    expect(refusal(`<div style="width:200px;height:40px">Loading…</div>`)).toEqual({
      ok: false,
      reason: "no-candidates",
    });
  });

  it("does not say so beside a radio button its description leaves out", () => {
    expect(refusal(dialog(`${logOn}<input type="radio" name="via" aria-label="SMS">`))).toEqual({
      ok: false,
      reason: "no-candidates",
    });
  });
});
