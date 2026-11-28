import { afterEach, describe, expect, it } from "vitest";
import { isClickLayer, overlaidLabel } from "./overlaid-control";

// Click layers named by the text laid over them (ADR 0090). Runs in Chromium (vitest
// browser mode) so layout, computed cursors and the hit test decide. Synthetic page, a
// reduced copy of UNSW Endeavour's sign-in dialog: every `<div>` carries `tabindex="-1"`,
// and "log on" takes its clicks on an empty layer under a sibling that holds the text.
const dialog = ({
  layer = `tabindex="-1" style="position:absolute;inset:0;cursor:pointer;pointer-events:auto"`,
  text = "log on",
  textStyle = "position:absolute;left:2px;top:2px",
  space = "position:absolute;left:165px;top:185px;width:99px;height:20px",
  wrapper = "position:absolute;inset:0;z-index:1;pointer-events:none",
  inLayer = "",
  beside = "",
  after = "",
} = {}) => `<div id="dialog" tabindex="-1" style="position:absolute;left:0;top:0;width:500px;height:234px">
  <div tabindex="-1"><input id="232:credentialElement" autocomplete="username"></div>
  <div tabindex="-1"><input id="240:credentialElement" type="password" autocomplete="current-password"></div>
  <div id="214:spaceElement" tabindex="-1" style="${space}">
    <div id="274" tabindex="-1" style="${wrapper}"><div id="274:areaElement" ${layer}>${inLayer}</div></div>
    <div id="276" tabindex="-1" style="position:absolute;inset:0;z-index:2;pointer-events:none;background:#ddd"></div>
    <div id="284" tabindex="-1" style="position:absolute;inset:0;z-index:6;pointer-events:none"><div tabindex="-1" style="${textStyle}">${text}</div></div>
    ${beside}
  </div>
  ${after}
</div>`;

const page = (html: string) => {
  document.body.innerHTML = html;
  return document.getElementById("274:areaElement")!;
};
afterEach(() => {
  document.body.innerHTML = "";
});

describe("isClickLayer", () => {
  it("takes the empty layer with a negative tabindex and its own pointer", () => {
    expect(isClickLayer(page(dialog()))).toBe(true);
    expect(
      isClickLayer(
        page(dialog({ layer: `tabindex="-2" style="position:absolute;inset:0;cursor:pointer"` })),
      ),
    ).toBe(true);
    // Its container, the text and the inputs are no layers.
    for (const id of ["214:spaceElement", "274", "284", "232:credentialElement"])
      expect(isClickLayer(document.getElementById(id)!), id).toBe(false);
  });

  it("refuses a tab stop, no tabindex, a role, text inside and an inherited cursor", () => {
    const style = `style="position:absolute;inset:0;cursor:pointer;pointer-events:auto"`;
    for (const options of [
      // A tab stop is a script button's business, not a layer's.
      { layer: `tabindex="0" ${style}` },
      // `-0` parses as 0, a tab stop too.
      { layer: `tabindex="-0" ${style}` },
      { layer: style },
      { layer: `tabindex="-1" role="button" ${style}` },
      { layer: `tabindex="-1" ${style}`, inLayer: "log on" },
      { layer: `tabindex="-1" ${style}`, inLayer: `<span tabindex="-1"></span>` },
      // The cursor comes from the wrapper around it, as a clickable card's would.
      {
        layer: `tabindex="-1" style="position:absolute;inset:0;pointer-events:auto"`,
        wrapper: "position:absolute;inset:0;z-index:1;pointer-events:none;cursor:pointer",
      },
      // Neither may it set the pointer when the wrapper sets it too.
      { wrapper: "position:absolute;inset:0;z-index:1;pointer-events:none;cursor:pointer" },
      { layer: `tabindex="-1" style="position:absolute;inset:0;cursor:pointer;display:none"` },
    ]) {
      const layer = page(dialog(options));
      expect(isClickLayer(layer), JSON.stringify(options)).toBe(false);
      expect(overlaidLabel(layer, { hit: false }), JSON.stringify(options)).toBeUndefined();
      expect(overlaidLabel(layer, { hit: true }), JSON.stringify(options)).toBeUndefined();
    }
  });

  it("refuses form controls, links and an element inside a link", () => {
    for (const html of [
      `<button id="x" tabindex="-1" style="cursor:pointer;width:50px;height:20px"></button>`,
      `<a id="x" href="/go" tabindex="-1" style="display:block;cursor:pointer;width:50px;height:20px"></a>`,
      `<a href="/go"><div id="x" tabindex="-1" style="cursor:pointer;width:50px;height:20px"></div></a>`,
      `<div id="x" tabindex="-1" contenteditable style="cursor:pointer;width:50px;height:20px"></div>`,
    ]) {
      document.body.innerHTML = html;
      expect(isClickLayer(document.getElementById("x")!), html).toBe(false);
    }
  });
});

describe("overlaidLabel", () => {
  it("reads the text laid over the layer, with the hit test and without", () => {
    const layer = page(dialog());
    expect(overlaidLabel(layer, { hit: true })).toBe("log on");
    expect(overlaidLabel(layer, { hit: false })).toBe("log on");
  });

  it("refuses text whose centre lies outside the layer's box", () => {
    const layer = page(dialog({ textStyle: "position:absolute;left:200px;top:2px" }));
    expect(overlaidLabel(layer, { hit: false })).toBeUndefined();
    expect(overlaidLabel(layer, { hit: true })).toBeUndefined();
    // One piece of text inside and another outside is refused as well.
    const split = page(
      dialog({ text: `log on<div style="position:absolute;left:0;top:60px">exit</div>` }),
    );
    expect(overlaidLabel(split, { hit: false })).toBeUndefined();
  });

  it("refuses a container that holds another pointer layer or a control", () => {
    const other = `<div tabindex="-1" style="position:absolute;left:0;top:0;width:10px;height:10px;cursor:pointer"></div>`;
    for (const beside of [
      other,
      `<button type="button" style="position:absolute;left:0;top:0">x</button>`,
      `<a href="/exit" style="position:absolute;left:0;top:0"></a>`,
      `<span role="img" style="position:absolute;left:0;top:0"></span>`,
    ]) {
      const layer = page(dialog({ beside }));
      expect(overlaidLabel(layer, { hit: false }), beside).toBeUndefined();
      expect(overlaidLabel(layer, { hit: true }), beside).toBeUndefined();
    }
    // A layer without the pointer beside it does not count.
    const plain = `<div tabindex="-1" style="position:absolute;left:0;top:0;width:10px;height:10px"></div>`;
    expect(overlaidLabel(page(dialog({ beside: plain })), { hit: true })).toBe("log on");
  });

  it("asks the hit test only with `hit`, so a cover over the centre refuses it then alone", () => {
    const layer = page(
      dialog({
        after: `<div id="cover" style="position:absolute;inset:0;z-index:20;pointer-events:auto"></div>`,
      }),
    );
    expect(document.elementFromPoint(214, 195)?.id).toBe("cover");
    expect(overlaidLabel(layer, { hit: true })).toBeUndefined();
    expect(overlaidLabel(layer, { hit: false })).toBe("log on");
  });

  it("reads at most 120 characters", () => {
    const wide = "position:absolute;left:0;top:100px;width:500px;height:40px";
    const textStyle = "position:absolute;left:0;top:0;font-size:3px;white-space:nowrap";
    const at = (text: string) =>
      overlaidLabel(page(dialog({ text, space: wide, textStyle })), {
        hit: true,
      });
    expect(at("a".repeat(120))).toBe("a".repeat(120));
    expect(at("a".repeat(121))).toBeUndefined();
    expect(at(`${"log on ".repeat(30)}`)).toBeUndefined();
  });

  it("finds no text more than three levels above, nor in the body", () => {
    // The text two wrappers further out is beyond the container's reach.
    document.body.innerHTML = `<div style="position:relative;width:99px;height:20px">
      <div><div><div><div id="deep" tabindex="-1" style="position:absolute;inset:0;cursor:pointer"></div></div></div></div>
      <div style="position:absolute;left:2px;top:2px;pointer-events:none">log on</div>
    </div>`;
    expect(overlaidLabel(document.getElementById("deep")!, { hit: true })).toBeUndefined();
    document.body.innerHTML = `<div id="top" tabindex="-1" style="position:absolute;left:0;top:0;width:99px;height:20px;cursor:pointer"></div><div style="position:absolute;left:2px;top:2px;pointer-events:none">log on</div>`;
    expect(overlaidLabel(document.getElementById("top")!, { hit: false })).toBeUndefined();
  });
});
