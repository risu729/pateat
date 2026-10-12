import { afterEach, expect, test } from "vitest";
import { userEvent } from "vitest/browser";
import { cleanup, render } from "vitest-browser-react";
// oxlint-disable-next-line import/no-unassigned-import -- Apply the options page stylesheet.
import "../../apps/extension/entrypoints/options/style.css";
import extensionStyles from "../../apps/extension/entrypoints/options/style.css?raw";
import { Button } from "../../apps/extension/src/options/button";
import manageStyles from "../../services/api/web/styles.css?raw";

// The extension pages and /manage keep separate copies of the design tokens and the
// Button; these checks keep the copies equal and the focus ring visible.

const buttonSources = import.meta.glob<string>(
  ["../../apps/extension/src/options/button.tsx", "../../services/api/web/button.tsx"],
  { query: "?raw", import: "default", eager: true },
);
const extensionButton = buttonSources["../../apps/extension/src/options/button.tsx"] ?? "";
const manageButton = buttonSources["../../services/api/web/button.tsx"] ?? "";

afterEach(async () => {
  await cleanup();
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

test("both stylesheets define the same light and dark tokens", () => {
  for (const selector of [":root", ':root[data-theme="dark"]', ':root:not([data-theme="light"])']) {
    expect(tokens(manageStyles, selector)).toEqual(tokens(extensionStyles, selector));
  }
});

test("a browser that prefers dark gets the same tokens as the dark theme", () => {
  for (const css of [extensionStyles, manageStyles]) {
    expect(tokens(css, ':root:not([data-theme="light"])')).toEqual(
      tokens(css, ':root[data-theme="dark"]'),
    );
  }
});

test("both Button copies are the same apart from their header comment", () => {
  expect(extensionButton).toContain("focus-visible:outline-solid");
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
