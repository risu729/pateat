import { afterEach, describe, expect, it, vi } from "vitest";
import { cardBrandOf, cardBrandsIn, cardHints, cardLastFours } from "./card-hints";

// What a page shows about the card it asks for (ADR 0061, owner 2026-10-23 12:26 UTC).
// Synthetic numbers only.
vi.mock("wxt/browser", () => ({
  browser: { dom: { openOrClosedShadowRoot: (element: HTMLElement) => element.shadowRoot } },
}));

afterEach(() => {
  document.body.innerHTML = "";
});

describe("cardLastFours", () => {
  it.each([
    ["****9876", "a run of asterisks"],
    ["\u2022\u2022\u2022\u2022 9876", "bullets and a space"],
    [
      "\u25CF\u25CF\u25CF\u25CF \u25CF\u25CF\u25CF\u25CF \u25CF\u25CF\u25CF\u25CF 9876",
      "groups of circles",
    ],
    ["XXXX-XXXX-XXXX-9876", "groups of X and hyphens"],
    ["xxxx9876", "lowercase x"],
    ["**9876", "two mask characters"],
    ["\uFF0A\uFF0A\uFF0A\uFF0A９８７６", "full-width asterisks and digits"],
    ["4242-****-****-9876", "a number with its first digits shown"],
    ["カード番号****9876", "a mask right after Japanese text"],
    ["カード番号末尾 9876", "末尾"],
    ["下４桁：９８７６", "下4桁 in full width"],
    ["末尾が9876のカード", "末尾が"],
    ["Visa ending in 9876", "ending in"],
    ["Card ends with 9876.", "ends with"],
    ["Last 4 digits: 9876", "last 4 digits"],
    ["Expires 12/30, ****9876", "a mask after a date"],
  ])("reads the last four digits of %s (%s)", (text) => {
    expect(cardLastFours(text)).toEqual(["9876"]);
  });

  it.each([
    ["9876", "digits alone"],
    ["box 9876", "an x ending a word"],
    ["x 9876", "a lone x"],
    ["*9876", "a lone asterisk"],
    ["****98765", "five digits after a mask"],
    ["\u2022\u2022\u2022\u2022 987", "three digits"],
    ["090-9876-5432", "a phone number"],
    ["末尾 98765", "five digits after 末尾"],
    ["\u2022 2025年10月以降", "a bulleted year"],
    ["生年月日 * 1990", "a required mark before a year"],
    ["\u2022 1500円以上", "a bulleted amount"],
    ["Order *1234-5678", "an order number"],
    ["Order ****1234-5678", "an order number after a mask"],
    ["ending in 2026-10-23", "a date after ending in"],
    ["**** 2026/10/23", "a date after a mask"],
  ])("reads no last four digits from %s (%s)", (text) => {
    expect(cardLastFours(text)).toEqual([]);
  });

  it("reads every run once, in the order shown", () => {
    expect(cardLastFours("****1111 / ****9876 / 末尾 1111")).toEqual(["1111", "9876"]);
  });
});

describe("cardBrandsIn", () => {
  it.each([
    ["VISA", "Visa"],
    ["MasterCard", "Mastercard"],
    ["JCB", "JCB"],
    ["American Express", "Amex"],
    ["AMEX", "Amex"],
    ["Diners Club", "Diners Club"],
    ["Discover", "Discover"],
    ["UnionPay", "UnionPay"],
    ["マスターカード", "Mastercard"],
    ["アメックス", "Amex"],
    ["ダイナース", "Diners Club"],
    ["銀聯", "UnionPay"],
  ])("names %s as Bitwarden spells it", (text, brand) => {
    expect(cardBrandsIn(`Your ${text} card`)).toEqual([brand]);
  });

  it("names no brand when the page names several, as a list of accepted cards does", () => {
    expect(cardBrandsIn("We accept VISA, Mastercard and JCB")).toEqual([]);
  });

  it("names a brand only as a word of its own, and Discover only as the brand writes it", () => {
    expect(cardBrandsIn("Visavis, jcbx, Discovered")).toEqual([]);
    expect(cardBrandsIn("discover more, DISCOVER")).toEqual([]);
  });
});

describe("cardHints", () => {
  it("reads digits beside the input and in the title, and a brand only beside the input", () => {
    document.body.innerHTML = `<p>Your other card ****1111 (JCB)</p>
      <form>
        <div><p>Security code of VISA \u2022\u2022\u2022\u2022 9876</p><input id="code"></div>
        <div><p>Mastercard ****2222</p><input id="other"></div>
        <p hidden>****3333</p>
      </form>`;
    const code = document.getElementById("code") as HTMLInputElement;
    code.value = "****4444";
    expect(cardHints(code, "Card ending in 5555 | Amex")).toEqual({
      last4: ["9876", "5555"],
      brands: ["Visa"],
    });
  });

  it("reads the whole page when the input is its only fillable input outside a form", () => {
    document.body.innerHTML = `<p>Mastercard ****9876</p><div><input id="code"></div>`;
    expect(cardHints(document.getElementById("code") as HTMLInputElement, "")).toEqual({
      last4: ["9876"],
      brands: ["Mastercard"],
    });
  });

  it("reads nothing from a page that shows no card", () => {
    document.body.innerHTML = `<form><label>Security code <input id="code"></label></form>`;
    expect(cardHints(document.getElementById("code") as HTMLInputElement, "Sign in")).toEqual({
      last4: [],
      brands: [],
    });
  });
});

describe("cardBrandOf", () => {
  it("reads a vault card's brand as Bitwarden stores it", () => {
    expect(cardBrandOf("Visa")).toBe("Visa");
    expect(cardBrandOf("Mastercard")).toBe("Mastercard");
    expect(cardBrandOf("Amex")).toBe("Amex");
    expect(cardBrandOf("American Express")).toBe("Amex");
    expect(cardBrandOf("Diners Club")).toBe("Diners Club");
    expect(cardBrandOf("JCB")).toBe("JCB");
    expect(cardBrandOf("UnionPay")).toBe("UnionPay");
    expect(cardBrandOf("Other")).toBeUndefined();
    expect(cardBrandOf("")).toBeUndefined();
  });
});
