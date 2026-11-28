import * as v from "valibot";
import { describe, expect, it } from "vitest";
import { loginStepSchema } from "./login/targets";
import { loginObservationSchema } from "./observation";

// A click layer named by the text laid over it (ADR 0090): the login page's candidate and
// the recipe's click step. Synthetic page, shaped like UNSW Endeavour's sign-in dialog.
describe("an overlaid candidate", () => {
  const layer = {
    id: "c3",
    role: "button",
    target: { by: "id", value: "274:areaElement" },
    label: "log on",
    overlaid: true,
  };
  const parse = (candidate: Record<string, unknown>) =>
    v.safeParse(loginObservationSchema, {
      version: 1,
      origin: "https://sign-in.example.test",
      path: "/Apps/Endeavour/",
      language: "en",
      complete: true,
      candidates: [
        { id: "c1", role: "text", target: { by: "id", value: "232:credentialElement" } },
        { id: "c2", role: "password", target: { by: "id", value: "240:credentialElement" } },
        candidate,
      ],
    }).success;

  it("is a button with a label", () => {
    expect(parse(layer)).toBe(true);
    expect(parse({ ...layer, overlaid: undefined })).toBe(true);
    const { label: _, ...unnamed } = layer;
    expect(parse(unnamed)).toBe(false);
    for (const role of ["link", "checkbox", "text", "password"])
      expect(parse({ ...layer, role }), role).toBe(false);
  });

  it("is marked true or not at all", () => {
    expect(parse({ ...layer, overlaid: false })).toBe(false);
    expect(parse({ ...layer, overlaid: "true" })).toBe(false);
  });
});

describe("a click step's `shows`", () => {
  const click = (step: Record<string, unknown>) =>
    v.safeParse(loginStepSchema, {
      kind: "click",
      path: "/Apps/Endeavour/",
      target: { by: "id", value: "274:areaElement" },
      purpose: "submit",
      ...step,
    }).success;

  it("names the text laid over a click layer located by an attribute", () => {
    expect(click({ shows: "log on" })).toBe(true);
    expect(click({ shows: "log on", purpose: "advance" })).toBe(true);
    expect(click({ shows: "log on", target: { by: "name", value: "logOn" } })).toBe(true);
    expect(click({ shows: "log on", target: { by: "test-id", value: "log-on" } })).toBe(true);
  });

  it("goes with no key press", () => {
    expect(click({ press: "enter" })).toBe(true);
    expect(click({ shows: "log on", press: "enter" })).toBe(false);
  });

  it("never goes with a text, accessible-name or password-form-text target", () => {
    for (const by of ["text", "accessible-name", "password-form-text"]) {
      expect(click({ target: { by, value: "log on" } }), by).toBe(true);
      expect(click({ shows: "log on", target: { by, value: "log on" } }), by).toBe(false);
    }
  });

  it("is 1 to 120 characters", () => {
    expect(click({ shows: "x" })).toBe(true);
    expect(click({ shows: "x".repeat(120) })).toBe(true);
    expect(click({ shows: "" })).toBe(false);
    expect(click({ shows: "x".repeat(121) })).toBe(false);
    expect(click({ shows: 1 })).toBe(false);
  });
});
