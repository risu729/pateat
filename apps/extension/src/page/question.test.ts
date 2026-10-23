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
    expect(questionText("  Mother\u2019s   Maiden Name? ")).toBe("mother's maiden name");
    expect(questionText("母親の旧姓は？")).toBe("母親の旧姓は");
    expect(questionText("ＰＥＴ　ＮＡＭＥ：")).toBe("pet name");
  });
});

const names = (...values: string[]) => values.map((name) => ({ name }));

describe("askedQuestion", () => {
  it("finds the field named as the question shown with the input", () => {
    const answer = input(
      `<form><p>秘密の質問：母親の旧姓は？</p><input id="answer" type="text"><button>次へ</button></form>`,
    );
    expect(askedQuestion(answer, names("好きな食べ物は？", "母親の旧姓は?"))).toBe(1);
  });

  it("finds none when no name is shown", () => {
    const answer = input(`<form><label>Answer <input id="answer"></label></form>`);
    expect(askedQuestion(answer, names("What was your first pet's name?"))).toBeUndefined();
  });

  it("reads only the question beside its own input when a form asks several", () => {
    document.body.innerHTML = `<form>
      <div><label>First pet's name?</label><input id="one"></div>
      <div><label>City you were born in?</label><input id="two"></div>
    </form>`;
    const asked = names("City you were born in", "First pet's name");
    expect(askedQuestion(document.getElementById("one") as HTMLInputElement, asked)).toBe(1);
    expect(askedQuestion(document.getElementById("two") as HTMLInputElement, asked)).toBe(0);
  });

  it("prefers the longest name shown and refuses a tie", () => {
    const answer = input(
      `<form><p>Name of your first school teacher</p><input id="answer"></form>`,
    );
    expect(askedQuestion(answer, names("first school", "first school teacher"))).toBe(1);
    expect(askedQuestion(answer, names("first school", "your first s"))).toBeUndefined();
  });

  it("ignores names too short to stand for a question", () => {
    const answer = input(`<form><p>回答</p><input id="answer"></form>`);
    expect(askedQuestion(answer, names("回答"))).toBeUndefined();
  });

  it("matches a field by the question the owner confirmed for it, as one whole question", () => {
    const answer = input(
      `<form><p>秘密の質問：母親の旧姓は？</p><input id="answer" type="text"><button>次へ</button></form>`,
    );
    // The field's name is not shown; the question stored with its link is, after its label.
    expect(askedQuestion(answer, [{ question: "母親の旧姓は" }])).toBe(0);
    expect(askedQuestion(answer, [{ question: "秘密の質問:母親の旧姓は" }])).toBe(0);
    expect(
      askedQuestion(answer, [...names("好きな食べ物は？"), { question: "母親の旧姓は" }]),
    ).toBe(1);
    // Nothing fuzzy: a question worded otherwise matches no stored one.
    expect(askedQuestion(answer, [{ question: "母の旧姓は" }])).toBeUndefined();
    // Two entries that match at the same length tie.
    expect(
      askedQuestion(answer, [{ question: "母親の旧姓は" }, { question: "母親の旧姓は？" }]),
    ).toBeUndefined();
  });

  it("never takes a question's label or a part of it for the confirmed question", () => {
    const answer = input(
      `<form><p>Security question: What is your mother's maiden name?</p><input id="answer"></form>`,
    );
    expect(askedQuestion(answer, [{ question: "what is your mother's maiden name" }])).toBe(0);
    // A label before the question, a fragment of it, or a word in it is no question.
    for (const question of ["Security question", "your mother's maiden name", "your", "What is"])
      expect(askedQuestion(answer, [{ question }]), question).toBeUndefined();
    // A field named after a part of the question still counts by its name, as before.
    expect(askedQuestion(answer, names("mother's maiden name"))).toBe(0);
  });

  it("reads a label of its own as a label, and each block as its own question", () => {
    const answer = input(
      `<form><div><label for="answer">Security question:</label></div>
        <div><span>What was the name of </span><b>your first pet</b>?</div>
        <input id="answer"></form>`,
    );
    expect(askedQuestion(answer, [{ question: "Security question" }])).toBeUndefined();
    // Inline elements read as one block with the text around them.
    expect(askedQuestion(answer, [{ question: "what was the name of your first pet" }])).toBe(0);
    expect(askedQuestion(answer, [{ question: "your first pet" }])).toBeUndefined();
  });

  it("ignores text that is not shown", () => {
    const answer = input(
      `<form><p hidden>母親の旧姓は？</p><p>好きな色は？</p><input id="answer"></form>`,
    );
    expect(askedQuestion(answer, names("母親の旧姓は？"))).toBeUndefined();
    expect(askedQuestion(answer, names("好きな色は？"))).toBe(0);
    expect(askedQuestion(answer, [{ question: "母親の旧姓は" }])).toBeUndefined();
  });
});
