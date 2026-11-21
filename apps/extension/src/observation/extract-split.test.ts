import type { LoginObservation } from "@pateat/contracts";
import { afterEach, describe, expect, it } from "vitest";
import { extractLoginObservation, extractSignedInObservation } from "./extract";

// An identifier split over several inputs on a login page's description (ADR 0089): each
// box stays a candidate of its own and carries its place in the group. Synthetic page,
// shaped like a bank's first login page that asks for a customer number in three boxes.
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

const observe = (html: string): LoginObservation => {
  document.body.innerHTML = html;
  const result = extractLoginObservation();
  if (!result.ok) throw new Error(`no observation: ${result.reason}`);
  return result.observation;
};

describe("a split identifier on a login page", () => {
  it("marks each box with its group and place, and labels the first by the sentence above", () => {
    const observation = observe(customerNumberPage);
    expect(observation.complete).toBe(true);
    const fields = observation.candidates.filter((candidate) => candidate.role === "text");
    expect(fields).toEqual([
      {
        id: "c1",
        role: "text",
        target: { by: "id", value: "focus1" },
        label: "以下の欄に、お客さま番号を入力してください。",
        placeholder: "半角数字4桁",
        maxLength: 4,
        split: { group: "s1", part: 1, of: 3 },
        group: "f1",
      },
      {
        id: "c2",
        role: "text",
        target: { by: "id", value: "focus2" },
        placeholder: "半角数字4桁",
        maxLength: 4,
        split: { group: "s1", part: 2, of: 3 },
        group: "f1",
      },
      {
        id: "c3",
        role: "text",
        target: { by: "id", value: "focus3_off" },
        placeholder: "半角数字5桁",
        maxLength: 5,
        split: { group: "s1", part: 3, of: 3 },
        group: "f1",
      },
    ]);
    expect(observation.candidates.filter((candidate) => candidate.role === "button")).toEqual([
      expect.objectContaining({ target: { by: "name", value: "U010103" } }),
      expect.objectContaining({ target: { by: "name", value: "U010107" } }),
    ]);
  });

  it("marks no one-digit code boxes and no lone input", () => {
    const code = observe(
      `<form><p>認証コード</p>${Array.from(
        { length: 6 },
        (_, at) => `<input type="tel" name="otp${at + 1}" maxlength="1">`,
      ).join("")}<button>Verify</button></form>`,
    );
    expect(code.candidates.some((candidate) => candidate.split !== undefined)).toBe(false);
    const lone = observe(`<form><input name="no1" maxlength="4"><button>Next</button></form>`);
    expect(lone.candidates.some((candidate) => candidate.split !== undefined)).toBe(false);
  });

  it("keeps a part's own label and leaves the signed-in page's description unmarked", () => {
    const own = observe(
      `<form><label>前半<input name="no1" maxlength="4"></label><label>後半<input name="no2" maxlength="4"></label><button>Next</button></form>`,
    );
    expect(
      own.candidates.slice(0, 2).map((candidate) => [candidate.label, candidate.split]),
    ).toEqual([
      ["前半", { group: "s1", part: 1, of: 2 }],
      ["後半", { group: "s1", part: 2, of: 2 }],
    ]);
    document.body.innerHTML = customerNumberPage;
    const signedIn = extractSignedInObservation(document);
    expect(
      signedIn.ok && signedIn.observation.candidates.some((candidate) => candidate.split),
    ).toBe(false);
  });
});
