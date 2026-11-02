import {
  type DatePart,
  type DetailFormat,
  type DetailPartFormat,
  detailFormatFits,
  detailFormatSchema,
  detailInputRefusal,
  detailPartFormatSchema,
  isCodeField,
  type LoginDetail,
  loginDetailSchema,
  type ObservedCandidate,
  observedAutocompleteTokens,
} from "@pateat/contracts";
import { describe, expect, it } from "vitest";
import { detailSecret } from "./details";
import { acceptsSecret, type SecretInput } from "./inputs";
import type { LoginSecretKind } from "./wire";

// The service decides from a page's description which input a TOTP code or a personal
// detail goes into (`isCodeField`, `detailInputRefusal`); the executor checks the live
// input again (`acceptsSecret`). Over every combination of the attributes both read, an
// input the service takes must be one the executor fills, or a learned recipe stops on a
// field it was told to fill.

const inputTypes = ["text", "email", "tel", "number", "password"];
const maxLengths = [-1, 1, 2, 3, 4, 6, 10, 11, 2000];
const minLengths = [-1, 5];
const inputModes = [null, "numeric", "tel", "text"];
const autocompletes = [
  null,
  "off",
  "username",
  "email",
  "current-password",
  "new-password",
  "one-time-code",
  "off one-time-code",
  "bday",
  "bday username",
  "cc-csc",
  "CC-Number",
];

type Input = SecretInput & {
  readonly minLength: number;
  readonly inputModeAttribute: string | null;
};

const inputs: Input[] = [
  ...inputTypes.flatMap((type) =>
    maxLengths.flatMap((maxLength) =>
      minLengths.flatMap((minLength) =>
        inputModes.flatMap((inputModeAttribute) =>
          autocompletes.map((autocomplete) => ({
            type,
            maxLength,
            minLength,
            inputMode: inputModeAttribute ?? "",
            inputModeAttribute,
            getAttribute: (name: string) => (name === "autocomplete" ? autocomplete : null),
          })),
        ),
      ),
    ),
  ),
  ...autocompletes.map((autocomplete) => ({
    type: "select-one",
    minLength: -1,
    inputMode: "",
    inputModeAttribute: null,
    getAttribute: (name: string) => (name === "autocomplete" ? autocomplete : null),
  })),
];

const observedTokens: readonly string[] = observedAutocompleteTokens;
const roles: Record<string, ObservedCandidate["role"]> = {
  text: "text",
  email: "email",
  tel: "tel",
  number: "number",
  password: "password",
  "select-one": "select",
};

/** The input as the page's description shows it (observation/extract.ts). */
function described(input: Input): ObservedCandidate {
  const role = roles[input.type]!;
  const tokens = (input.getAttribute("autocomplete") ?? "")
    .toLowerCase()
    .split(/\s+/u)
    .filter(Boolean);
  const autocomplete =
    tokens.length === 1 && tokens[0] === "off"
      ? "off"
      : observedAutocompleteTokens.find((token) => tokens.includes(token));
  const inRange = (value: number) => value >= 1 && value <= 1024;
  const max = input.maxLength ?? -1;
  const min = input.minLength;
  const lengths =
    role === "select" || role === "number" || (inRange(max) && inRange(min) && min > max)
      ? {}
      : {
          ...(inRange(max) ? { maxLength: max } : {}),
          ...(inRange(min) ? { minLength: min } : {}),
        };
  const mode = ["numeric", "tel", "text"].find((entry) => entry === input.inputModeAttribute);
  return {
    id: "f",
    role,
    target: { by: "id", value: "f" },
    group: "g",
    ...(autocomplete ? { autocomplete } : {}),
    ...lengths,
    ...(mode ? { inputMode: mode as ObservedCandidate["inputMode"] } : {}),
  } as ObservedCandidate;
}

type Entry = {
  detail: LoginDetail;
  format?: DetailFormat | DetailPartFormat;
  part?: DatePart | number;
  length?: number;
};

/** Every whole detail with each format it takes, each date part in every format, and digit groups. */
const entries: Entry[] = [
  ...loginDetailSchema.options.flatMap((detail) =>
    [undefined, ...detailFormatSchema.options]
      .filter((format) => detailFormatFits(detail, format))
      .map((format) => ({ detail, ...(format ? { format } : {}) })),
  ),
  ...(["birth-date", "card-expiry"] as const).flatMap((detail) =>
    (["year", "month", "day"] as const).flatMap((part) =>
      detailPartFormatSchema.options.map((format) => ({ detail, part, format })),
    ),
  ),
  ...(["card-number", "pin"] as const).flatMap((detail) =>
    [undefined, 4].map((length) => ({ detail, part: 0, ...(length ? { length } : {}) })),
  ),
];

/** The kind the executor fills an entry's value as (login/details.ts). */
const secretOf = (entry: Entry): LoginSecretKind =>
  typeof entry.part === "string"
    ? "date-part"
    : entry.detail === "secret-answer"
      ? "answer"
      : detailSecret(entry.detail);

const shown = (input: Input) => ({
  type: input.type,
  maxLength: input.maxLength,
  minLength: input.minLength,
  inputMode: input.inputModeAttribute,
  autocomplete: input.getAttribute("autocomplete"),
});

describe("the service's input checks and the executor's, over every input", () => {
  it("walks every input and entry", () => {
    expect(inputs.length * entries.length).toBeGreaterThan(100_000);
    expect(observedTokens).toContain("one-time-code");
  });

  it("fills a TOTP code into every input the service counts as a code field (ADR 0013)", () => {
    const broken = inputs.filter(
      (input) => isCodeField(described(input)) && !acceptsSecret(input, "otp"),
    );
    expect(broken.slice(0, 5).map(shown)).toEqual([]);
  });

  it("fills a detail into every input the service lets a detail handler use (ADR 0061)", () => {
    const button: ObservedCandidate = {
      id: "b",
      role: "button",
      target: { by: "id", value: "b" },
      group: "g",
    };
    const broken = [];
    for (const input of inputs) {
      const field = described(input);
      for (const entry of entries)
        if (
          detailInputRefusal(entry, field, button) === undefined &&
          !acceptsSecret(input, secretOf(entry))
        )
          broken.push({ entry, input: shown(input) });
    }
    expect(broken.slice(0, 5)).toEqual([]);
  });

  it("lets a detail handler use some input of every entry", () => {
    const button: ObservedCandidate = {
      id: "b",
      role: "button",
      target: { by: "id", value: "b" },
      group: "g",
    };
    expect(
      entries.filter(
        (entry) =>
          !inputs.some(
            (input) => detailInputRefusal(entry, described(input), button) === undefined,
          ),
      ),
    ).toEqual([]);
  });
});
