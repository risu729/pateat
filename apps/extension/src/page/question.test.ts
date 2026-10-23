import { afterEach, describe, expect, it, vi } from "vitest";
import { askedQuestion, questionText } from "./question";

vi.mock("wxt/browser", () => ({
  browser: { dom: { openOrClosedShadowRoot: (element: HTMLElement) => element.shadowRoot } },
}));

afterEach(() => {
  document.body.innerHTML = "";
});

const input = (html: string, id = "answer") => {
  document.body.innerHTML = html;
  return document.getElementById(id) as HTMLInputElement;
};

describe("questionText", () => {
  it("compares without case, width, curly apostrophes, extra spaces or a trailing mark", () => {
    expect(questionText("  Mother’s   Maiden Name? ")).toBe("mother's maiden name");
    expect(questionText("母親の旧姓は？")).toBe("母親の旧姓は");
    expect(questionText("ＰＥＴ　ＮＡＭＥ：")).toBe("pet name");
  });
});

describe("askedQuestion", () => {
  it("finds the field named as the question shown with the input", () => {
    const answer = input(
      `<form><p>秘密の質問：母親の旧姓は？</p><input id="answer" type="text"><button>次へ</button></form>`,
    );
    expect(askedQuestion(answer, ["好きな食べ物は？", "母親の旧姓は?"])).toBe(1);
  });

  it("finds none when no name is shown", () => {
    const answer = input(`<form><label>Answer <input id="answer"></label></form>`);
    expect(askedQuestion(answer, ["What was your first pet's name?"])).toBeUndefined();
  });

  it("reads only the question beside its own input when a form asks several", () => {
    document.body.innerHTML = `<form>
      <div><label>First pet's name?</label><input id="one"></div>
      <div><label>City you were born in?</label><input id="two"></div>
    </form>`;
    const names = ["City you were born in", "First pet's name"];
    expect(askedQuestion(document.getElementById("one") as HTMLInputElement, names)).toBe(1);
    expect(askedQuestion(document.getElementById("two") as HTMLInputElement, names)).toBe(0);
  });

  it("prefers the longest name shown and refuses a tie", () => {
    const answer = input(
      `<form><p>Name of your first school teacher</p><input id="answer"></form>`,
    );
    expect(askedQuestion(answer, ["first school", "first school teacher"])).toBe(1);
    expect(askedQuestion(answer, ["first school", "your first s"])).toBeUndefined();
  });

  it("ignores names too short to stand for a question", () => {
    const answer = input(`<form><p>回答</p><input id="answer"></form>`);
    expect(askedQuestion(answer, ["回答"])).toBeUndefined();
  });

  it("ignores text that is not shown", () => {
    const answer = input(
      `<form><p hidden>母親の旧姓は？</p><p>好きな色は？</p><input id="answer"></form>`,
    );
    expect(askedQuestion(answer, ["母親の旧姓は？"])).toBeUndefined();
    expect(askedQuestion(answer, ["好きな色は？"])).toBe(0);
  });
});
