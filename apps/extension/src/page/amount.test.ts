import { afterEach, describe, expect, it } from "vitest";
import { showsAmount } from "./amount";

afterEach(() => {
  document.body.innerHTML = "";
});

const form = (html: string) => {
  document.body.innerHTML = `<form>${html}</form>`;
  return document.querySelector("form")!;
};

describe("showsAmount", () => {
  it("finds a yen, dollar or 円 amount in the form's text", () => {
    expect(showsAmount(form("<p>振込金額 ¥10,000</p><input type=password>"))).toBe(true);
    expect(showsAmount(form("<p>振込金額 10,000円</p>"))).toBe(true);
    expect(showsAmount(form("<p>合計 １，０００ 円</p>"))).toBe(true);
    expect(showsAmount(form("<p>Total: ￥１０００</p>"))).toBe(true);
    expect(showsAmount(form("<dd>US$ 25.00</dd>"))).toBe(true);
  });

  it("needs a digit beside the sign", () => {
    expect(showsAmount(form("<p>円でお支払い</p><p>Pay in $</p>"))).toBe(false);
    expect(showsAmount(form("<label>Password<input type=password></label>"))).toBe(false);
  });

  it("never reads a control's value or hidden text", () => {
    expect(showsAmount(form('<input value="¥10,000"><textarea>$5</textarea>'))).toBe(false);
    expect(showsAmount(form('<p hidden>¥10,000</p><p style="display: none">10円</p>'))).toBe(false);
  });
});
