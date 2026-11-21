import { afterEach, describe, expect, it } from "vitest";
import { identifierInput } from "./identifier-field";
import { splitGroupFrom, splitGroups } from "./split-identifier";

// Identifiers split over several inputs (ADR 0089). Synthetic pages; the first is shaped
// like a bank's first login page that asks for a customer number in three boxes (#1758).
const customerNumberPage = `<form name="submitData">
  <div class="m_top_10">以下の欄に、お客さま番号を入力してください。</div>
  <div class="w80 boxCenter">
    <p class="mt10"><input type="text" name="okyakusamaBangou1" id="focus1" maxlength="4" placeholder="半角数字4桁">
      - <input type="text" name="okyakusamaBangou2" id="focus2" maxlength="4" placeholder="半角数字4桁">
      - <input type="text" name="okyakusamaBangou3" id="focus3_off" maxlength="5" placeholder="半角数字5桁"></p>
    <p class="mt10"><label><input type="checkbox" name="okyakusamaBangouHozonFlag">お客さま番号を保存する</label></p>
  </div>
  <button type="submit" name="U010103">ログインパスワードを入力してログイン</button>
  <button type="submit" name="U010107">アプリでログイン</button>
</form>`;

afterEach(() => {
  document.body.innerHTML = "";
});

/** The names (else ids) of each group on `html`. */
const groupsOf = (html: string) => {
  document.body.innerHTML = html;
  return splitGroups(document).map((group) => group.map((input) => input.name || input.id));
};
const boxes = (stem: string, lengths: number[], type = "text", by: "name" | "id" = "name") =>
  lengths
    .map((length, at) => `<input type="${type}" ${by}="${stem}${at + 1}" maxlength="${length}">`)
    .join(" - ");

describe("splitGroups", () => {
  it("finds the boxes of a customer number by their numbered names", () => {
    expect(groupsOf(customerNumberPage)).toEqual([
      ["okyakusamaBangou1", "okyakusamaBangou2", "okyakusamaBangou3"],
    ]);
    const first = document.querySelector<HTMLInputElement>("[name='okyakusamaBangou1']")!;
    expect(splitGroupFrom(first)?.map((input) => input.maxLength)).toEqual([4, 4, 5]);
    // Only from the first part.
    expect(
      splitGroupFrom(document.querySelector<HTMLInputElement>("[name='okyakusamaBangou2']")!),
    ).toBeUndefined();
  });

  it("reads ids without names, tel inputs, and inputs outside every form", () => {
    expect(groupsOf(`<div>${boxes("acct", [3, 7], "text", "id")}</div>`)).toEqual([
      ["acct1", "acct2"],
    ]);
    expect(groupsOf(`<form>${boxes("tel", [3, 4, 4], "tel")}</form>`)).toEqual([
      ["tel1", "tel2", "tel3"],
    ]);
  });

  it("never takes a code's one-digit boxes, number inputs or lengths out of range", () => {
    expect(groupsOf(`<form>${boxes("otp", [1, 1, 1, 1, 1, 1], "tel")}</form>`)).toEqual([]);
    expect(groupsOf(`<form>${boxes("code", [1, 1, 1, 1, 1, 1])}</form>`)).toEqual([]);
    expect(groupsOf(`<form>${boxes("no", [4, 4], "number")}</form>`)).toEqual([]);
    expect(groupsOf(`<form>${boxes("no", [4, 9])}</form>`)).toEqual([]);
    expect(groupsOf(`<form><input name="no1"><input name="no2"></form>`)).toEqual([]);
    expect(groupsOf(`<form>${boxes("no", [2, 2, 2, 2, 2, 2, 2])}</form>`)).toEqual([]);
    expect(
      groupsOf(
        `<form><input name="code1" maxlength="3" autocomplete="one-time-code"><input name="code2" maxlength="3"></form>`,
      ),
    ).toEqual([]);
  });

  it("needs names numbered from 1 in order, side by side in one form", () => {
    expect(groupsOf(`<form>${boxes("no", [4, 4]).replaceAll("no1", "no0")}</form>`)).toEqual([]);
    expect(
      groupsOf(`<form><input name="no1" maxlength="4"><input name="no3" maxlength="4"></form>`),
    ).toEqual([]);
    expect(
      groupsOf(`<form><input name="no2" maxlength="4"><input name="no1" maxlength="4"></form>`),
    ).toEqual([]);
    expect(
      groupsOf(`<form><input name="a1" maxlength="4"><input name="b2" maxlength="4"></form>`),
    ).toEqual([]);
    // Another text-like input between two parts.
    expect(
      groupsOf(
        `<form><input name="no1" maxlength="4"><input type="password" name="pw"><input name="no2" maxlength="4"></form>`,
      ),
    ).toEqual([]);
    expect(
      groupsOf(
        `<form><input name="no1" maxlength="4"></form><form><input name="no2" maxlength="4"></form>`,
      ),
    ).toEqual([]);
    // A hidden, disabled or read-only part.
    for (const attribute of ['style="display: none"', "disabled", "readonly"])
      expect(
        groupsOf(
          `<form><input name="no1" maxlength="4"><input name="no2" maxlength="4" ${attribute}></form>`,
        ),
      ).toEqual([]);
  });

  it("finds a postal code's boxes too, which only the identifier rule then leaves out", () => {
    expect(groupsOf(`<form>${boxes("zip", [3, 4])}</form>`)).toEqual([["zip1", "zip2"]]);
  });
});

describe("identifierInput with a split identifier", () => {
  const asks = (html: string) => {
    document.body.innerHTML = html;
    return identifierInput(document);
  };

  it("takes the customer number's boxes alone on the page by the sentence above them", () => {
    expect(asks(customerNumberPage)).toBe("sole");
    expect(
      asks(`<form><label>会員番号</label><span>${boxes("member", [4, 4])}</span></form>`),
    ).toBe("sole");
    expect(asks(`<form>${boxes("loginId", [4, 4])}</form>`)).toBe("sole");
  });

  it("leaves out a phone number, a postal code and boxes with no identifier word", () => {
    expect(asks(`<form><p>電話番号</p><div>${boxes("tel", [3, 4, 4], "tel")}</div></form>`)).toBe(
      undefined,
    );
    expect(asks(`<form><p>番号</p><div>${boxes("tel", [3, 4, 4], "tel")}</div></form>`)).toBe(
      undefined,
    );
    expect(asks(`<form><p>郵便番号</p><div>${boxes("zip", [3, 4])}</div></form>`)).toBe(undefined);
    expect(asks(`<form><p>お名前</p><div>${boxes("field", [4, 4])}</div></form>`)).toBe(undefined);
    // Marked by an autofill field name.
    expect(
      asks(
        `<form><p>お客さま番号</p><div><input name="no1" maxlength="4" autocomplete="tel-area-code"><input name="no2" maxlength="4"></div></form>`,
      ),
    ).toBe(undefined);
  });

  it("counts the group as one input beside the page's others", () => {
    expect(asks(customerNumberPage.replace("</form>", '<input name="company"></form>'))).toBe(
      undefined,
    );
    // A one-digit code's boxes are no group: six inputs.
    expect(
      asks(`<form><p>お客さま番号</p><div>${boxes("no", [1, 1, 1, 1, 1, 1])}</div></form>`),
    ).toBe(undefined);
  });
});
