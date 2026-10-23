import { afterEach, describe, expect, it } from "vitest";
import { chooseOption, optionFor } from "./select-option";

// Runs in Chromium (vitest browser mode). A split birth date's or card expiry date's part
// is chosen in a select only by an option that says its number (ADR 0061, owner
// 2026-10-23 12:26 UTC). Synthetic pages only.
afterEach(() => {
  document.body.innerHTML = "";
});
const select = (options: string) => {
  document.body.innerHTML = `<select id="s"><option value="">--</option>${options}</select>`;
  return document.getElementById("s") as HTMLSelectElement;
};
const options = (from: number, to: number) =>
  Array.from({ length: to - from + 1 }, (_, at) => `<option>${from + at}</option>`).join("");
const years = Array.from({ length: 80 }, (_, at) => 2026 - at)
  .map((year) => `<option value="${year}">${year}年</option>`)
  .join("");

describe("optionFor", () => {
  it("finds a year by its value or text, never by its position", () => {
    const years80 = select(years);
    expect(optionFor(years80, "1990")).toBe(2026 - 1990 + 1);
    // The same years written without values, newest last.
    const ascending = select(
      Array.from({ length: 80 }, (_, at) => `<option>${1947 + at}</option>`).join(""),
    );
    expect(optionFor(ascending, "1990")).toBe(1990 - 1947 + 1);
    expect(optionFor(years80, "1899")).toBeUndefined();
  });

  it("finds a month or a day with or without its leading zero, after NFKC", () => {
    const months = select(
      Array.from({ length: 12 }, (_, at) => `<option value="${at + 1}">${at + 1}月</option>`).join(
        "",
      ),
    );
    expect(optionFor(months, "04")).toBe(4);
    expect(optionFor(months, "4")).toBe(4);
    expect(optionFor(months, "12")).toBe(12);
    // Full-width texts with values that say nothing.
    const wide = select(
      ["０１", "０２", "０３", "０４"]
        .map((text) => `<option value="x">${text}日</option>`)
        .join(""),
    );
    expect(optionFor(wide, "4")).toBe(4);
    const padded = select(`<option value="05"> 05 </option><option value="06">06</option>`);
    expect(optionFor(padded, "5")).toBe(1);
  });

  it("refuses when no option or several say the number", () => {
    // Values counting from 0 disagree with the texts, so the month is never guessed.
    const zeroBased = select(
      Array.from({ length: 12 }, (_, at) => `<option value="${at}">${at + 1}</option>`).join(""),
    );
    expect(optionFor(zeroBased, "4")).toBeUndefined();
    const twice = select(`<option>4</option><option value="4">April</option>`);
    expect(optionFor(twice, "4")).toBeUndefined();
    const named = select(`<option value="apr">April</option><option value="may">May</option>`);
    expect(optionFor(named, "4")).toBeUndefined();
    // A text with two numbers says none of them; its value can still say one.
    const era = select(
      `<option value="x">1990 (H2)</option><option value="1991">1991 (H3)</option>`,
    );
    expect(optionFor(era, "1990")).toBeUndefined();
    expect(optionFor(era, "1991")).toBe(2);
    expect(optionFor(select(years), "")).toBeUndefined();
    // A card expiry year written with two digits takes the four-digit year, but only when
    // no option says the whole year.
    const short = select(options(26, 36));
    expect(optionFor(short, "2031")).toBe(31 - 26 + 1);
    expect(optionFor(short, "31")).toBe(31 - 26 + 1);
    expect(optionFor(select(`<option>2031</option><option>31</option>`), "2031")).toBe(1);
    expect(optionFor(select(`<option>1931</option>`), "31")).toBeUndefined();
    expect(optionFor(select(years), "19900")).toBeUndefined();
    expect(optionFor(select(years), "x")).toBeUndefined();
  });

  it("skips disabled and hidden options and those in a disabled group", () => {
    const skipped = select(
      `<option value="4" disabled>4</option><option value="5" hidden>5</option>
       <optgroup label="Later" disabled><option value="6">6</option></optgroup>
       <option value="7">7</option>`,
    );
    expect(optionFor(skipped, "4")).toBeUndefined();
    expect(optionFor(skipped, "5")).toBeUndefined();
    expect(optionFor(skipped, "6")).toBeUndefined();
    expect(optionFor(skipped, "7")).toBe(4);
  });
});

describe("chooseOption", () => {
  it("chooses the option and sends input and change events that bubble", () => {
    const months = select(`<option value="4">4</option><option value="5">5</option>`);
    const seen: string[] = [];
    for (const type of ["input", "change"])
      document.body.addEventListener(type, (event) => {
        seen.push(`${event.type}:${(event.target as HTMLSelectElement).value}`);
      });
    expect(chooseOption(months, 2)).toBe(true);
    expect(months.value).toBe("5");
    expect(seen).toEqual(["input:5", "change:5"]);
    expect(document.activeElement).not.toBe(months);
    // An option already shown is left as it is, with no events.
    expect(chooseOption(months, 2)).toBe(true);
    expect(seen).toHaveLength(2);
  });

  it("reports a page that changes the choice back", () => {
    const months = select(`<option value="4">4</option>`);
    months.addEventListener("change", () => {
      months.selectedIndex = 0;
    });
    expect(chooseOption(months, 1)).toBe(false);
  });
});
