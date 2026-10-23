import { afterEach, describe, expect, it } from "vitest";
import { chooseOption, optionFor, type WantedOption } from "./select-option";

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
const year = (value: string): WantedOption => ({ value, part: "year" });
const month = (value: string): WantedOption => ({ value, part: "month" });
const day = (value: string): WantedOption => ({ value, part: "day" });
const expiryYear = (value: string): WantedOption => ({ value, part: "year", shortYear: true });
/** The position of the option `optionFor` found, or undefined. */
const at = (control: HTMLSelectElement, wanted: WantedOption) => {
  const found = optionFor(control, wanted);
  return found && [...control.options].indexOf(found);
};
const monthNames = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
];

describe("optionFor", () => {
  it("finds a year by its value or text, never by its position", () => {
    const years80 = select(years);
    expect(at(years80, year("1990"))).toBe(2026 - 1990 + 1);
    // The same years written without values, newest last.
    const ascending = select(
      Array.from({ length: 80 }, (_, index) => `<option>${1947 + index}</option>`).join(""),
    );
    expect(at(ascending, year("1990"))).toBe(1990 - 1947 + 1);
    expect(at(years80, year("1899"))).toBeUndefined();
  });

  it("finds a month or a day with or without its leading zero, after NFKC", () => {
    const months = select(
      Array.from(
        { length: 12 },
        (_, index) => `<option value="${index + 1}">${index + 1}月</option>`,
      ).join(""),
    );
    expect(at(months, month("04"))).toBe(4);
    expect(at(months, month("4"))).toBe(4);
    expect(at(months, month("12"))).toBe(12);
    // Full-width texts with values that say nothing.
    const wide = select(
      ["０１", "０２", "０３", "０４"]
        .map((text) => `<option value="x">${text}日</option>`)
        .join(""),
    );
    expect(at(wide, day("4"))).toBe(4);
    const padded = select(`<option value="05"> 05 </option><option value="06">06</option>`);
    expect(at(padded, day("5"))).toBe(1);
  });

  it("reads an option's value only when its text says no number and the values fit the part", () => {
    // Month names with values from 1: the values say the month.
    const named = select(
      monthNames.map((name, index) => `<option value="${index + 1}">${name}</option>`).join(""),
    );
    expect(optionFor(named, month("4"))?.text).toBe("April");
    expect(optionFor(named, month("05"))?.text).toBe("May");
    // Month names with values that count from 0: a value of 0 says they are no months, so
    // April is never taken for May.
    const zeroBased = select(
      monthNames.map((name, index) => `<option value="${index}">${name}</option>`).join(""),
    );
    for (const wanted of ["1", "4", "5", "11"])
      expect(at(zeroBased, month(wanted))).toBeUndefined();
    // Values beyond the part's range are no month or day numbers either.
    const coded = select(
      monthNames.map((name, index) => `<option value="${101 + index}">${name}</option>`).join(""),
    );
    expect(at(coded, month("4"))).toBeUndefined();
    const days = select(
      Array.from({ length: 31 }, (_, index) => `<option value="${index + 1}">-</option>`).join(""),
    );
    expect(at(days, day("31"))).toBe(31);
    expect(at(days, month("4"))).toBeUndefined();
    // Without its part a value never counts.
    expect(at(named, { value: "4" })).toBeUndefined();
    // A text that says a number decides, whatever the value says.
    const shifted = select(
      Array.from(
        { length: 12 },
        (_, index) => `<option value="${index}">${index + 1}</option>`,
      ).join(""),
    );
    expect(optionFor(shifted, month("4"))?.text).toBe("4");
  });

  it("never takes an era year or a two-digit option for a birth year", () => {
    // Japanese era years with their own codes as values: no option says 1980.
    const era = select(
      Array.from(
        { length: 20 },
        (_, index) => `<option value="S${45 + index}">昭和${45 + index}年</option>`,
      ).join(""),
    );
    expect(at(era, year("1980"))).toBeUndefined();
    expect(at(era, year("1955"))).toBeUndefined();
    expect(at(select(options(26, 36)), year("2031"))).toBeUndefined();
    expect(at(select(`<option>2031</option>`), year("31"))).toBeUndefined();
  });

  it("matches a card expiry year written with the other number of digits", () => {
    // A card expiry year written with two digits takes the four-digit year, but only when
    // no option says the whole year.
    const short = select(options(26, 36));
    expect(at(short, expiryYear("2031"))).toBe(31 - 26 + 1);
    expect(at(short, expiryYear("31"))).toBe(31 - 26 + 1);
    expect(at(select(`<option>2031</option><option>31</option>`), expiryYear("2031"))).toBe(1);
    // A two-digit year takes the year 20 and those digits.
    const long = select(options(2026, 2036));
    expect(at(long, expiryYear("31"))).toBe(2031 - 2026 + 1);
    expect(at(select(`<option>1931</option>`), expiryYear("31"))).toBeUndefined();
    // Two-digit values with no text take part as the year's own.
    const valued = select(
      Array.from({ length: 10 }, (_, index) => `<option value="${26 + index}">-</option>`).join(""),
    );
    expect(at(valued, expiryYear("2031"))).toBe(31 - 26 + 1);
    expect(at(valued, year("2031"))).toBeUndefined();
  });

  it("refuses when no option or several say the number", () => {
    const twice = select(`<option>4</option><option value="4">April</option>`);
    expect(at(twice, month("4"))).toBeUndefined();
    const named = select(`<option value="apr">April</option><option value="may">May</option>`);
    expect(at(named, month("4"))).toBeUndefined();
    // A text with two numbers says none of them; its value can still say one when every
    // value is a year.
    const era = select(
      `<option value="1990">1990 (H2)</option><option value="1991">1991 (H3)</option>`,
    );
    expect(at(era, year("1990"))).toBe(1);
    const unvalued = select(
      `<option value="x">1990 (H2)</option><option value="1991">1991 (H3)</option>`,
    );
    expect(at(unvalued, year("1990"))).toBeUndefined();
    expect(at(select(years), year(""))).toBeUndefined();
    expect(at(select(years), year("19900"))).toBeUndefined();
    expect(at(select(years), year("x"))).toBeUndefined();
  });

  it("skips disabled and hidden options and those in a disabled group", () => {
    const skipped = select(
      `<option value="4" disabled>4</option><option value="5" hidden>5</option>
       <optgroup label="Later" disabled><option value="6">6</option></optgroup>
       <option value="7">7</option>`,
    );
    expect(at(skipped, day("4"))).toBeUndefined();
    expect(at(skipped, day("5"))).toBeUndefined();
    expect(at(skipped, day("6"))).toBeUndefined();
    expect(at(skipped, day("7"))).toBe(4);
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
    const may = months.options[2]!;
    expect(chooseOption(months, may)).toBe(true);
    expect(months.value).toBe("5");
    expect(seen).toEqual(["input:5", "change:5"]);
    expect(document.activeElement).not.toBe(months);
    // An option already shown is left as it is, with no events.
    expect(chooseOption(months, may)).toBe(true);
    expect(seen).toHaveLength(2);
  });

  it("finds the option again after the page's focus handlers moved it", () => {
    const months = select(`<option value="4">4</option><option value="5">5</option>`);
    const may = months.options[2]!;
    // A page that fills the select's options when it gets focus, before the chosen one.
    months.addEventListener("focus", () => {
      months.insertBefore(new Option("3", "3"), months.options[1]!);
    });
    expect(chooseOption(months, may)).toBe(true);
    expect(months.value).toBe("5");
    expect(months.selectedOptions[0]).toBe(may);
  });

  it("reports a page that changes the choice back or removes the option", () => {
    const months = select(`<option value="4">4</option>`);
    months.addEventListener("change", () => {
      months.selectedIndex = 0;
    });
    expect(chooseOption(months, months.options[1]!)).toBe(false);
    const days = select(`<option value="4">4</option>`);
    const fourth = days.options[1]!;
    days.addEventListener("focus", () => fourth.remove());
    expect(chooseOption(days, fourth)).toBe(false);
  });
});
