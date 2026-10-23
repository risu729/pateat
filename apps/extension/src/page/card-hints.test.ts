import { afterEach, describe, expect, it, vi } from "vitest";
import { cardBrandOf, cardHints, cardHintsIn } from "./card-hints";

// What a page shows about the card it asks for (ADR 0061, owner 2026-10-23 12:26 UTC).
// Synthetic numbers only.
vi.mock("wxt/browser", () => ({
  browser: { dom: { openOrClosedShadowRoot: (element: HTMLElement) => element.shadowRoot } },
}));

afterEach(() => {
  document.body.innerHTML = "";
});

describe("cardHintsIn", () => {
  it.each([
    ["****9876", "a run of asterisks"],
    ["•••• 9876", "bullets and a space"],
    ["●●●● ●●●● ●●●● 9876", "groups of circles"],
    ["XXXX-XXXX-XXXX-9876", "groups of X and hyphens"],
    ["xxxx9876", "lowercase x"],
    ["＊＊＊＊９８７６", "full-width asterisks and digits"],
    ["4242-****-****-9876", "a number with its first digits shown"],
    ["カード番号****9876", "a mask right after Japanese text"],
    ["カード番号末尾 9876", "末尾"],
    ["下４桁：９８７６", "下4桁 in full width"],
    ["末尾が9876のカード", "末尾が"],
    ["Visa ending in 9876", "ending in"],
    ["Card ends with 9876.", "ends with"],
    ["Last 4 digits: 9876", "last 4 digits"],
  ])("reads the last four digits of %s (%s)", (text) => {
    expect(cardHintsIn(text).last4).toEqual(["9876"]);
  });

  it.each([
    ["9876", "digits alone"],
    ["box 9876", "an x ending a word"],
    ["x 9876", "a lone x"],
    ["****98765", "five digits after a mask"],
    ["•••• 987", "three digits"],
    ["090-9876-5432", "a phone number"],
    ["末尾 98765", "five digits after 末尾"],
  ])("reads no last four digits from %s (%s)", (text) => {
    expect(cardHintsIn(text).last4).toEqual([]);
  });

  it("reads every run once, in the order shown", () => {
    expect(cardHintsIn("****1111 / ****9876 / 末尾 1111").last4).toEqual(["1111", "9876"]);
  });

  it("names each brand as Bitwarden spells it", () => {
    expect(
      cardHintsIn("VISA, MasterCard, JCB, American Express, Diners Club, Discover and UnionPay")
        .brands,
    ).toEqual(["Visa", "Mastercard", "Amex", "Diners Club", "Discover", "JCB", "UnionPay"]);
    expect(cardHintsIn("AMEX").brands).toEqual(["Amex"]);
    expect(cardHintsIn("マスターカード・アメックス・ダイナース・銀聯").brands).toEqual([
      "Mastercard",
      "Amex",
      "Diners Club",
      "UnionPay",
    ]);
    // A brand only as a word of its own.
    expect(cardHintsIn("Visavis, jcbx, discovered").brands).toEqual([]);
  });
});

describe("cardHints", () => {
  it("reads the text beside the input and the page's title only", () => {
    document.body.innerHTML = `<p>Your other card ****1111 (JCB)</p>
      <form>
        <div><p>Security code of VISA •••• 9876</p><input id="code"></div>
        <div><p>Mastercard ****2222</p><input id="other"></div>
        <p hidden>****3333</p>
      </form>`;
    const code = document.getElementById("code") as HTMLInputElement;
    code.value = "****4444";
    expect(cardHints(code, "Card ending in 5555 | Amex")).toEqual({
      last4: ["9876", "5555"],
      brands: ["Visa", "Amex"],
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
