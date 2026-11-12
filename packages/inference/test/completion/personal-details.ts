import { expect, it } from "vitest";
import { completionInstructions, completionStopInstructions } from "../../src/completion";
import type { CompletionFixtures } from "../../src/completion.test";

type Candidate = Record<string, unknown>;
type Judge = ReturnType<CompletionFixtures["judgeReturning"]>["judge"];
type PersonalContext = {
  birth: Candidate;
  phone: Candidate;
  next: Candidate;
  judged: (candidates: Candidate[], result: Candidate) => ReturnType<Judge>;
  both: Candidate[];
  answer: (
    details?: unknown[],
    detailSubmit?: string,
  ) => { decision: string; details: unknown[]; detailSubmit: string };
  kept: Candidate;
  keptPhone: Candidate;
  hasDetail: (outcome: Awaited<ReturnType<Judge>>) => boolean;
  select: (id: string, label?: string) => Candidate & { id: string };
  box: (id: string, maxLength?: number) => Candidate & { id: string };
  dateSelects: Candidate[];
  datePage: Candidate[];
  dateAnswer: { field: string; value: string; part: string; format: string }[];
  boxes: (Candidate & { id: string })[];
  cardAnswer: Candidate[];
  name: (value: string) => { by: string; value: string };
};

export function registerPersonalDetailCases({
  birth,
  phone,
  next,
  judged,
  both,
  answer,
  kept,
  keptPhone,
  hasDetail,
}: Pick<
  PersonalContext,
  "birth" | "phone" | "next" | "judged" | "both" | "answer" | "kept" | "keptPhone" | "hasDetail"
>) {
  it("names each input, the detail it asks for, and the button that submits them", async () => {
    const outcome = await judged([birth, phone, next], answer());
    expect(outcome).toEqual(
      expect.objectContaining({
        status: "ok",
        value: {
          decision: "challenge",
          detail: { fields: [kept, keptPhone], target: { by: "id", value: "next" } },
        },
      }),
    );
    // The answer is logged as the model gave it.
    expect(outcome.answer).toEqual(answer());
  });

  it("keeps a card's whole number, its expiry date and a PIN in the inputs their rules admit", async () => {
    const number = {
      id: "number",
      role: "password",
      target: { by: "name", value: "card_no" },
      label: "Card number",
      maxLength: 16,
      group: "form-1",
    };
    const expiry = {
      id: "expiry",
      role: "tel",
      target: { by: "name", value: "exp" },
      label: "MM/YY",
      maxLength: 5,
      group: "form-1",
    };
    const pin = {
      id: "pin",
      role: "password",
      target: { by: "name", value: "pin" },
      label: "PIN",
      maxLength: 4,
      group: "form-1",
    };
    expect(
      await judged(
        [number, expiry, pin, next],
        answer([
          { field: "number", value: "card-number" },
          { field: "expiry", value: "card-expiry", format: "mm/yy" },
          { field: "pin", value: "pin" },
        ]),
      ),
    ).toEqual(
      expect.objectContaining({
        status: "ok",
        value: {
          decision: "challenge",
          detail: {
            fields: [
              { detail: "card-number", target: number.target },
              { detail: "card-expiry", format: "mm/yy", target: expiry.target },
              { detail: "pin", target: pin.target },
            ],
            target: { by: "id", value: "next" },
          },
        },
      }),
    );
    // An expiry date without a format of its own, or one written as mm/yyyy in 5
    // characters, is dropped.
    expect(
      await judged(
        [number, expiry, pin, next],
        answer([
          { field: "expiry", value: "card-expiry", format: "yyyymm" },
          { field: "number", value: "card-number" },
        ]),
      ),
    ).toEqual(
      expect.objectContaining({
        value: {
          decision: "challenge",
          detail: {
            fields: [{ detail: "card-number", target: number.target }],
            target: { by: "id", value: "next" },
          },
          detailsDropped: ["format"],
        },
      }),
    );
    expect(
      await judged(
        [number, expiry, pin, next],
        answer([
          { field: "expiry", value: "card-expiry", format: "mm/yyyy" },
          { field: "pin", value: "pin" },
        ]),
      ),
    ).toEqual(
      expect.objectContaining({
        value: {
          decision: "challenge",
          detail: {
            fields: [{ detail: "pin", target: pin.target }],
            target: { by: "id", value: "next" },
          },
          detailsDropped: ["too-short"],
        },
      }),
    );
  });

  it("keeps a detail beside a code and a passkey button", async () => {
    const code = {
      id: "code",
      role: "text",
      target: { by: "id", value: "otp" },
      autocomplete: "one-time-code",
      group: "form-2",
    };
    const verify = {
      ...next,
      id: "verify",
      target: { by: "id", value: "verify" },
      group: "form-2",
    };
    const key = { id: "key", role: "button", target: { by: "id", value: "key" }, label: "Key" };
    expect(
      await judged([birth, phone, next, code, verify, key], {
        ...answer([both[1]]),
        passkeyButton: "key",
        code: { field: "code", submit: "verify", source: "authenticator-app" },
      }),
    ).toMatchObject({
      status: "ok",
      value: {
        decision: "challenge",
        passkey: { by: "id", value: "key" },
        totp: { field: { by: "id", value: "otp" }, target: { by: "id", value: "verify" } },
        detail: { fields: [keptPhone], target: { by: "id", value: "next" } },
      },
    });
  });

  it("drops the input the page's code is typed into, even a code sent to the person", async () => {
    expect(
      await judged([birth, phone, next], {
        ...answer(),
        code: { field: "phone", submit: "next", source: "sms" },
      }),
    ).toEqual(
      expect.objectContaining({
        status: "ok",
        value: {
          decision: "challenge",
          totpDropped: "source-sms",
          detail: { fields: [kept], target: { by: "id", value: "next" } },
          detailsDropped: ["code-field"],
        },
      }),
    );
  });

  it.each([
    [
      "an input the page lacks",
      [birth, phone, next],
      answer([{ field: "missing", value: "phone-last-4" }, both[0]]),
      ["unknown-field"],
      [kept],
    ],
    [
      "a birth date without a format",
      [birth, phone, next],
      answer([{ field: "birth", value: "birth-date" }, both[1]]),
      ["format"],
      [keptPhone],
    ],
    [
      "another detail with a format",
      [birth, phone, next],
      answer([both[0], { field: "phone", value: "phone-last-4", format: "mmdd" }]),
      ["format"],
      [kept],
    ],
    [
      "an input named twice",
      [birth, phone, next],
      answer([...both, { field: "phone", value: "card-last-4" }]),
      ["duplicate"],
      [kept, keptPhone],
    ],
    [
      "an input shorter than its value",
      [birth, { ...phone, maxLength: 3 }, next],
      answer(),
      ["too-short"],
      [kept],
    ],
    [
      "a sign-in field",
      [birth, { ...phone, autocomplete: "one-time-code" }, next],
      answer(),
      ["sign-in-field"],
      [kept],
    ],
    [
      "a card's security code in a text input without a length",
      [birth, { ...phone, role: "text", maxLength: undefined }, next],
      answer([both[0], { field: "phone", value: "card-code" }]),
      ["not-input"],
      [kept],
    ],
    [
      "an input of another form",
      [birth, { ...phone, group: "form-2" }, next],
      answer(),
      ["submit-other-form"],
      [kept],
    ],
  ])("drops %s, saying why", async (_label, candidates, result, why, fields) => {
    expect(await judged(candidates, result)).toEqual(
      expect.objectContaining({
        status: "ok",
        value: {
          decision: "challenge",
          detail: { fields, target: { by: "id", value: "next" } },
          detailsDropped: why,
        },
      }),
    );
  });

  it.each([
    ["a button the page lacks", [birth, phone, next], answer(both, "missing"), "unknown-submit"],
    [
      "a button named by its accessible name",
      [
        birth,
        phone,
        { ...next, target: { by: "accessible-name", value: "Next, confirm the details." } },
      ],
      answer(),
      "step-locator",
    ],
    [
      "a link as the button",
      [birth, phone, { ...next, role: "link" }],
      answer(),
      "submit-not-button",
    ],
    [
      "the input as its own button",
      [birth, phone, next],
      answer(both, "phone"),
      "submit-not-button",
    ],
  ])("keeps no detail for %s", async (_label, candidates, result, why) => {
    const outcome = await judged(candidates, result);
    expect(outcome).toEqual(
      expect.objectContaining({
        status: "ok",
        value: { decision: "challenge", detailsDropped: [why, why] },
      }),
    );
    expect(hasDetail(outcome)).toBe(false);
  });

  it("keeps a plain challenge for details without a button, or a button without details", async () => {
    for (const [result, dropped] of [
      [{ decision: "challenge", details: both }, ["unknown-submit", "unknown-submit"]],
      [{ decision: "challenge", detailSubmit: "next" }, undefined],
      [{ decision: "challenge", details: [], detailSubmit: "next" }, undefined],
    ] as const) {
      // oxlint-disable-next-line no-await-in-loop -- Each answer is judged on its own.
      const outcome = await judged([birth, phone, next], result);
      expect(outcome).toEqual(
        expect.objectContaining({
          status: "ok",
          value: { decision: "challenge", ...(dropped ? { detailsDropped: dropped } : {}) },
        }),
      );
      expect(hasDetail(outcome)).toBe(false);
    }
  });

  it("fails closed on an unknown detail, format or part, more than twelve inputs, or details beside another decision", async () => {
    for (const result of [
      answer([{ field: "phone", value: "password" }]),
      answer([{ field: "birth", value: "birth-date", format: "ddmmyyyy" }]),
      answer([{ field: "birth", value: "birth-date", format: "yyyy", part: "week" }]),
      answer([{ field: "phone", value: "card-number", part: "7" }]),
      answer(Array.from({ length: 13 }, () => both[1])),
      { decision: "rejected", details: both, detailSubmit: "next" },
      { decision: "signed-in", marker: "next", detailSubmit: "next" },
    ])
      // oxlint-disable-next-line no-await-in-loop -- Each answer is judged on its own.
      expect(await judged([birth, phone, next], result)).toMatchObject({
        status: "failed",
        error: "invalid-output",
      });
  });

  it("logs the answer with IDs the page lacks as ?", async () => {
    const outcome = await judged(
      [birth, phone, next],
      answer(
        [
          { field: "birth", value: "birth-date", format: "yyyymm" },
          { field: "Phone number", value: "phone-last-4" },
        ],
        "Next",
      ),
    );
    expect(outcome.answer).toEqual({
      decision: "challenge",
      details: [
        { field: "birth", value: "birth-date", format: "yyyymm" },
        { field: "?", value: "phone-last-4" },
      ],
      detailSubmit: "?",
    });
  });

  it("tells the model the nine details, their formats, and that a security code is never code", () => {
    expect(completionInstructions).toMatch(
      /A challenge that asks for a fact about the person instead of a code fills details and detailSubmit\./u,
    );
    expect(completionInstructions).toMatch(
      /value is birth-date for a birth date asked in one input, whole or as its year and month or its month and day, with format yyyymmdd, yyyymm, yyyy-mm-dd, yyyy\/mm\/dd or mmdd as the page says or shows; a birth date written in a form none of these formats match, such as a two-digit or era year or a separator the format lacks, is no detail; phone-last-4 for the last four digits of a phone number; card-last-4 for the last four digits of a card number; card-code for a card's security code; card-number for a card's whole number; card-expiry for a card's expiry month and year, in one input with format mmyy, mm\/yy, mmyyyy or mm\/yyyy as the page says or shows; pin for a PIN or passcode made of digits, such as a card's or an account's, never the account's password; secret-answer for the answer to a secret question the page shows; member-id for a member, customer or contract number that is not the account's sign-in ID\./u,
    );
    // A value split over several inputs is a detail now (owner, 2026-10-23 12:26 UTC).
    expect(completionInstructions).not.toMatch(/split over several inputs(?:,| is) no detail/u);
    expect(completionInstructions).toMatch(
      /A value split over several inputs or selects lists each of them with the same value and its part\. A birth date's year, month and day \(all three, the year and month, or the month and day\) and a card expiry date's month and year are part year, month and day\. Every date part also names its format: yyyy for a year, or yy for a card expiry year written with two digits; mm or m for a month and dd or d for a day, m and d when the page writes them without a leading zero; a select, whose options are not shown here, takes yyyy, mm and dd\. A card number's or PIN's boxes are part 1, 2 and so on in the order the digits go, with no format\. A birth year asked with two digits or as an era year is no detail\./u,
    );
    // A whole card number and a PIN are details now (owner, 2026-10-23 11:41 UTC); a
    // password and a code sent to the person are still none.
    expect(completionInstructions).toMatch(
      /Any other fact, a whole phone number, a password or a code sent to the person is no detail\. A card's security code is a detail, never code\./u,
    );
    expect(completionInstructions).not.toMatch(/a PIN, a password/u);
    // The stop's instructions extend them.
    expect(completionStopInstructions.startsWith(completionInstructions)).toBe(true);
  });
}

export function registerSplitPersonalDetailCases({
  birth,
  phone,
  next,
  judged,
  both,
  answer,
  keptPhone,
  hasDetail,
  select,
  box,
  dateSelects,
  datePage,
  dateAnswer,
  boxes,
  cardAnswer,
  name,
}: Pick<
  PersonalContext,
  | "birth"
  | "phone"
  | "next"
  | "judged"
  | "both"
  | "answer"
  | "keptPhone"
  | "hasDetail"
  | "select"
  | "box"
  | "dateSelects"
  | "datePage"
  | "dateAnswer"
  | "boxes"
  | "cardAnswer"
  | "name"
>) {
  it("keeps a birth date in three selects as one field in place of its first part", async () => {
    const outcome = await judged(datePage, answer([...dateAnswer, both[1]]));
    expect(outcome).toEqual(
      expect.objectContaining({
        status: "ok",
        value: {
          decision: "challenge",
          detail: {
            fields: [
              {
                detail: "birth-date",
                parts: [
                  { part: "year", format: "yyyy", target: name("year") },
                  { part: "month", format: "m", target: name("month") },
                  { part: "day", format: "dd", target: name("day") },
                ],
              },
              keptPhone,
            ],
            target: { by: "id", value: "next" },
          },
        },
      }),
    );
    // The answer is logged with its parts.
    expect(outcome.answer).toEqual(answer([...dateAnswer, both[1]]));
  });

  it("gives a date part named without a format a four-digit year and a padded month and day", async () => {
    // The judge often leaves a part's format out (paid run, 2026-10-23).
    const unformatted = dateAnswer.map(({ format: _format, ...rest }) => rest);
    const outcome = await judged(datePage, answer(unformatted));
    expect(outcome).toMatchObject({
      status: "ok",
      value: {
        detail: {
          fields: [
            {
              detail: "birth-date",
              parts: [
                { part: "year", format: "yyyy", target: name("year") },
                { part: "month", format: "mm", target: name("month") },
                { part: "day", format: "dd", target: name("day") },
              ],
            },
          ],
        },
      },
    });
    const unnamed = (ids: string[], value: string, parts: string[]) =>
      parts.map((part, at) => ({ field: ids[at]!, value, part }));
    // A text input's maxlength must hold the part so made.
    const short = await judged(
      [box("y", 2), box("m", 2), box("d", 2), next],
      answer(unnamed(["y", "m", "d"], "birth-date", ["year", "month", "day"])),
    );
    expect(short).toMatchObject({
      status: "ok",
      value: { detailsDropped: ["too-short", "parts", "parts"] },
    });
    // A card expiry year in a two-character box is written with two digits.
    const expiry = await judged(
      [box("em", 2), box("ey", 2), next],
      answer(unnamed(["em", "ey"], "card-expiry", ["month", "year"])),
    );
    expect(expiry).toMatchObject({
      status: "ok",
      value: {
        detail: {
          fields: [
            {
              detail: "card-expiry",
              parts: [
                { part: "month", format: "mm", target: name("em") },
                { part: "year", format: "yy", target: name("ey") },
              ],
            },
          ],
        },
      },
    });
    // A four-character box takes four digits.
    const long = await judged(
      [box("em", 2), box("ey", 4), next],
      answer(unnamed(["em", "ey"], "card-expiry", ["month", "year"])),
    );
    expect(long).toMatchObject({
      status: "ok",
      value: {
        detail: {
          fields: [
            {
              parts: [
                { part: "month", format: "mm" },
                { part: "year", format: "yyyy" },
              ],
            },
          ],
        },
      },
    });
    // A box that declares no length gives no hint which the page wants: the year is not
    // filled unless the judge names its format, and the month goes with it.
    const open = await judged(
      [box("em", 2), box("ey"), next],
      answer(unnamed(["em", "ey"], "card-expiry", ["month", "year"])),
    );
    expect(open).toMatchObject({
      status: "ok",
      value: { detailsDropped: ["format", "parts"] },
    });
    expect(open.status === "ok" && open.value).not.toHaveProperty("detail");
    const named = await judged(
      [box("em", 2), box("ey"), next],
      answer([
        { field: "em", value: "card-expiry", part: "month" },
        { field: "ey", value: "card-expiry", part: "year", format: "yy" },
      ]),
    );
    expect(named).toMatchObject({
      status: "ok",
      value: {
        detail: {
          fields: [{ parts: [{ part: "month" }, { part: "year", format: "yy" }] }],
        },
      },
    });
  });

  it("matches a year in a select by its four digits whatever format the judge names", async () => {
    const outcome = await judged(
      datePage,
      answer(
        dateAnswer.map((entry) => (entry.part === "year" ? { ...entry, format: "yy" } : entry)),
      ),
    );
    expect(outcome).toMatchObject({
      status: "ok",
      value: {
        detail: {
          fields: [
            {
              detail: "birth-date",
              parts: [{ part: "year", format: "yyyy", target: name("year") }, {}, {}],
            },
          ],
        },
      },
    });
  });

  it("keeps a card number's boxes in their numbers' order, each as long as its maxlength", async () => {
    const outcome = await judged(
      [...boxes, next],
      // Named out of order: the numbers decide.
      answer([cardAnswer[2], cardAnswer[0], cardAnswer[3], cardAnswer[1]]),
    );
    expect(outcome).toEqual(
      expect.objectContaining({
        status: "ok",
        value: {
          decision: "challenge",
          detail: {
            fields: [
              {
                detail: "card-number",
                parts: boxes.map((entry, at) => ({
                  part: at + 1,
                  length: 4,
                  target: name(entry.id),
                })),
              },
            ],
            target: { by: "id", value: "next" },
          },
        },
      }),
    );
  });

  it("keeps a card expiry date in month and year selects and a PIN in four boxes of one digit", async () => {
    const pinBoxes = [1, 2, 3, 4].map((at) => box(`p${at}`, 1));
    const outcome = await judged(
      [select("exp_m"), select("exp_y"), ...pinBoxes, next],
      answer([
        { field: "exp_m", value: "card-expiry", part: "month", format: "mm" },
        { field: "exp_y", value: "card-expiry", part: "year", format: "yy" },
        ...pinBoxes.map((entry, at) => ({ field: entry.id, value: "pin", part: String(at + 1) })),
      ]),
    );
    expect(outcome).toEqual(
      expect.objectContaining({
        value: {
          decision: "challenge",
          detail: {
            fields: [
              {
                detail: "card-expiry",
                parts: [
                  { part: "month", format: "mm", target: name("exp_m") },
                  // A select's year is matched by its four digits, though named `yy`.
                  { part: "year", format: "yyyy", target: name("exp_y") },
                ],
              },
              {
                detail: "pin",
                parts: pinBoxes.map((entry, at) => ({
                  part: at + 1,
                  length: 1,
                  target: name(entry.id),
                })),
              },
            ],
            target: { by: "id", value: "next" },
          },
        },
      }),
    );
  });

  it.each([
    [
      "a birth date without its day's select, which a year and month alone would not miss",
      datePage,
      [dateAnswer[0], dateAnswer[2]],
      ["parts", "parts"],
    ],
    [
      "a birth date with its month named twice",
      [...datePage, select("month2")],
      [...dateAnswer, { ...dateAnswer[1], field: "month2" }],
      ["parts", "parts", "parts", "parts"],
    ],
    [
      // A select's year is matched by its four digits instead, whatever the judge names.
      "a two-digit birth year in a box",
      [box("year", 2), box("month", 2), box("day", 2), next],
      [{ ...dateAnswer[0], format: "yy" }, dateAnswer[1], dateAnswer[2]],
      ["format", "parts", "parts"],
    ],
    [
      // A box left out of a number that still has 12 digits is caught at the fill, where
      // the card's digits must fill the boxes exactly.
      "card number boxes of fewer than 12 digits",
      [box("c1", 3), box("c2", 3), box("c3", 3), next],
      cardAnswer.slice(0, 3),
      ["parts", "parts", "parts"],
    ],
    [
      "a card number's box without a maxlength",
      [...boxes.slice(0, 3), box("c4"), next],
      cardAnswer,
      ["no-length", "parts", "parts", "parts"],
    ],
    [
      "a card number's box that is a select",
      [...boxes.slice(0, 3), select("c4"), next],
      cardAnswer,
      ["not-input", "parts", "parts", "parts"],
    ],
    [
      "a phone's last four digits split over two boxes",
      [box("t1", 2), box("t2", 2), next],
      [
        { field: "t1", value: "phone-last-4", part: "1" },
        { field: "t2", value: "phone-last-4", part: "2" },
      ],
      ["part", "part"],
    ],
    [
      "a card expiry month without its part, which no one-input format names",
      [select("exp_m"), next],
      [{ field: "exp_m", value: "card-expiry", format: "mm" }],
      ["format"],
    ],
    [
      "a select asked for a whole birth date",
      [select("dob"), next],
      [{ field: "dob", value: "birth-date", format: "yyyymmdd" }],
      ["not-input"],
    ],
  ])("keeps no handler for %s", async (_label, candidates, details, why) => {
    const outcome = await judged(candidates, answer(details));
    expect(outcome).toEqual(
      expect.objectContaining({
        status: "ok",
        value: { decision: "challenge", detailsDropped: why },
      }),
    );
    expect(hasDetail(outcome)).toBe(false);
  });

  it("keeps three fields at most", async () => {
    const outcome = await judged(
      [...dateSelects, ...boxes, birth, phone, next],
      answer([...dateAnswer, ...cardAnswer, both[0], both[1]]),
    );
    expect(outcome).toEqual(
      expect.objectContaining({
        value: expect.objectContaining({ detailsDropped: ["too-many"] }),
      }),
    );
    const value = outcome.status === "ok" ? outcome.value : undefined;
    expect(
      value?.decision === "challenge" && value.detail?.fields.map((field) => field.detail),
    ).toEqual(["birth-date", "card-number", "birth-date"]);
  });
}
