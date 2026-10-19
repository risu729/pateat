import { afterEach, expect, test } from "vitest";
import { cdp, userEvent } from "vitest/browser";
import { cleanup, render } from "vitest-browser-react";
// oxlint-disable-next-line import/no-unassigned-import -- Apply the options page stylesheet.
import "../../apps/extension/entrypoints/options/style.css";
import extensionStyles from "../../apps/extension/entrypoints/options/style.css?raw";
import { Button } from "../../apps/extension/src/options/button";
import { PAGE_CSS } from "../../services/api/src/page-styles";
import manageStyles from "../../services/api/web/styles.css?raw";

// The extension pages, /manage and the service's script-free pages keep separate copies of
// the design tokens, and the first two of the Button; these checks keep the copies equal
// and the focus ring visible.

const buttonSources = import.meta.glob<string>(
  ["../../apps/extension/src/options/button.tsx", "../../services/api/web/button.tsx"],
  { query: "?raw", import: "default", eager: true },
);
const extensionButton = buttonSources["../../apps/extension/src/options/button.tsx"] ?? "";
const manageButton = buttonSources["../../services/api/web/button.tsx"] ?? "";

afterEach(async () => {
  await cleanup();
  await cdp().send("Emulation.setEmulatedMedia", { features: [] });
});

/** The custom properties a rule's block sets, in order. */
function tokens(css: string, selector: string): string[] {
  const start = css.indexOf(`${selector} {`);
  if (start === -1) throw new Error(`Missing ${selector}`);
  const block = css.slice(css.indexOf("{", start) + 1, css.indexOf("}", start));
  return block
    .split(";")
    .map((declaration) => declaration.trim())
    .filter(Boolean);
}

function withoutComments(source: string): string {
  return source
    .split("\n")
    .filter((line) => !line.startsWith("//"))
    .join("\n");
}

test("every stylesheet defines the same paired tokens and explicit scheme overrides", () => {
  for (const selector of [":root", ':root[data-theme="light"]', ':root[data-theme="dark"]']) {
    expect(tokens(manageStyles, selector)).toEqual(tokens(extensionStyles, selector));
    expect(tokens(PAGE_CSS, selector)).toEqual(tokens(extensionStyles, selector));
  }
  expect(tokens(extensionStyles, ':root[data-theme="light"]')).toEqual(["color-scheme: light"]);
  expect(tokens(extensionStyles, ':root[data-theme="dark"]')).toEqual(["color-scheme: dark"]);
  expect(tokens(extensionStyles, ":root")[0]).toBe("color-scheme: light dark");
});

// The approved palette, independent of how any stylesheet expresses its tokens.
const palette = {
  "--bg": ["#f1f5f9", "#0e1316"],
  "--surface": ["#ffffff", "#161d21"],
  "--surface-sunken": ["#f8fafc", "#11171a"],
  "--border": ["#d6e0e8", "#2a353c"],
  "--border-strong": ["#7a8899", "#5c6b76"],
  "--ink": ["#1e293b", "#e4ebf0"],
  "--ink-muted": ["#4f5d6f", "#9fb0bc"],
  "--accent": ["#115e59", "#5cc7ad"],
  "--accent-hover": ["#134e4a", "#7fd8c2"],
  "--on-accent": ["#ffffff", "#04201a"],
  "--accent-tint": ["#e6f6f2", "#123029"],
  "--accent-ink": ["#115e59", "#7fd8c2"],
  "--focus": ["#0f766e", "#7fd8c2"],
  "--danger": ["#b42318", "#ff8a7a"],
  "--danger-tint": ["#fdecea", "#3a1814"],
  "--warning": ["#8a5a00", "#f2c14e"],
  "--warning-tint": ["#fff6dc", "#33280d"],
} as const;

for (const [name, css] of Object.entries({
  extension: extensionStyles,
  manage: manageStyles,
  worker: PAGE_CSS,
})) {
  test.each(["light", "dark"] as const)(
    `${name} preserves every resolved color and shadow under a %s browser scheme`,
    async (scheme) => {
      await cdp().send("Emulation.setEmulatedMedia", {
        features: [{ name: "prefers-color-scheme", value: scheme }],
      });
      // A separate document prevents the three copies from overriding one another.
      const frame = document.createElement("iframe");
      document.body.append(frame);
      try {
        const doc = frame.contentDocument;
        const view = frame.contentWindow;
        if (!doc || !view) throw new Error("Missing palette frame");
        const style = doc.createElement("style");
        style.textContent = css.replaceAll(/^@(?:import|source).*;$/gm, "");
        doc.head.append(style);
        const probe = doc.createElement("span");
        const expected = doc.createElement("span");
        doc.body.append(probe, expected);
        for (const choice of ["system", "light", "dark"]) {
          if (choice === "system") doc.documentElement.removeAttribute("data-theme");
          else doc.documentElement.setAttribute("data-theme", choice);
          const dark = choice === "dark" || (choice === "system" && scheme === "dark");
          for (const [token, colors] of Object.entries(palette)) {
            probe.style.backgroundColor = `var(${token})`;
            expected.style.backgroundColor = colors[dark ? 1 : 0];
            expect(view.getComputedStyle(probe).backgroundColor, `${choice}: ${token}`).toBe(
              view.getComputedStyle(expected).backgroundColor,
            );
          }
          for (const [token, shape, lightColor, darkColor] of [
            ["--shadow-panel", "0 1px 2px", "rgb(15 23 42 / 5%)", "rgb(0 0 0 / 40%)"],
            ["--shadow-menu", "0 8px 24px", "rgb(15 23 42 / 15%)", "rgb(0 0 0 / 50%)"],
          ]) {
            probe.style.boxShadow = `var(${token})`;
            expected.style.boxShadow = `${shape} ${dark ? darkColor : lightColor}`;
            expect(view.getComputedStyle(probe).boxShadow, `${choice}: ${token}`).toBe(
              view.getComputedStyle(expected).boxShadow,
            );
          }
          probe.style.borderColor = "color-mix(in srgb, var(--accent) 50%, transparent)";
          expected.style.borderColor = `color-mix(in srgb, ${palette["--accent"][dark ? 1 : 0]} 50%, transparent)`;
          expect(view.getComputedStyle(probe).borderColor).toBe(
            view.getComputedStyle(expected).borderColor,
          );
        }
      } finally {
        frame.remove();
      }
    },
  );
}

test.each(["light", "dark"] as const)(
  "Tailwind token colors retain opacity modifiers in the %s theme",
  async (theme) => {
    const root = document.documentElement;
    const previous = root.getAttribute("data-theme");
    root.setAttribute("data-theme", theme);
    try {
      await render(<span className="bg-accent/50 border-accent/50">Tint</span>);
      const probe = document.querySelector("span.bg-accent\\/50");
      if (!probe) throw new Error("Missing opacity probe");
      const expected = document.createElement("span");
      expected.style.backgroundColor = `color-mix(in oklab, ${palette["--accent"][theme === "dark" ? 1 : 0]} 50%, transparent)`;
      document.body.append(expected);
      const color = getComputedStyle(expected).backgroundColor;
      expected.remove();
      expect(getComputedStyle(probe).backgroundColor).toBe(color);
      expect(getComputedStyle(probe).borderColor).toBe(color);
    } finally {
      if (previous === null) root.removeAttribute("data-theme");
      else root.setAttribute("data-theme", previous);
    }
  },
);

test("both Button copies are the same apart from their header comment", () => {
  expect(withoutComments(manageButton)).toBe(withoutComments(extensionButton));
});

test("a Button reached with the keyboard shows a solid 2px focus ring", async () => {
  await render(<Button>Save</Button>);
  await userEvent.keyboard("{Tab}");
  const button = document.querySelector("button");
  if (!button) throw new Error("Missing button");
  expect(document.activeElement).toBe(button);
  const style = getComputedStyle(button);
  expect(style.outlineStyle).toBe("solid");
  expect(style.outlineWidth).toBe("2px");
});
