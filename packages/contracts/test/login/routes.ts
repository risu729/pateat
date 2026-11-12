import { describe, expect, it } from "vitest";
import * as v from "valibot";
import {
  chooseLoginRoute,
  extendsRecipe,
  passkeyAnswersRequest,
  passwordVariants,
  recipeHasRoute,
  recipeSlots,
  recipeStartSteps,
  routeFillTargets,
  routePaths,
  routeSignInPaths,
  routeSignInTargets,
  routeSlots,
  routeSteps,
  loginRecipeSchema,
  parseLoginAccountBinding,
  parseLoginRecipe,
  resolveLoginPlan,
  type LoginAccountBinding,
} from "../../src/login";
import { DUMMY_VAULT_CATALOG } from "../../src/settings";
import type { LoginTestContext } from "./context";

export function registerPasswordVariants({
  binding,
  snapshot,
}: Pick<LoginTestContext, "binding" | "snapshot">): void {
  describe("password route variants (ADR 0027)", () => {
    const id = (value: string) => ({ by: "id" as const, value });
    const fill = (slots: string[], path = "/login") => ({
      kind: "fill" as const,
      effect: "prepare" as const,
      path,
      fields: slots.map((slot) => ({ slot, target: id(slot) })),
    });
    const submit = (path = "/login", value = "login") => ({
      kind: "click" as const,
      path,
      target: id(value),
      purpose: "submit" as const,
    });
    const variant = (slots: string[], path = "/login") => ({
      slots,
      steps: [fill(slots, path), submit(path)],
    });
    /** Branch and account numbers, or a contract number, with the same password and button. */
    const varied = (change: Record<string, unknown> = {}) => ({
      version: 1,
      id: "bank-variants",
      revision: 1,
      origin: "https://bank.example",
      pageKind: "sign-in",
      slots: ["branch", "account", "password"],
      steps: [fill(["branch", "account", "password"]), submit()],
      alternatives: [variant(["contract", "password"])],
      completion: [{ target: id("welcome") }],
      rejection: id("rejected"),
      maxSubmissions: 1,
      ...change,
    });
    const valid = (change: Record<string, unknown> = {}) => v.is(loginRecipeSchema, varied(change));

    it("keeps the recipe's own slots and steps as variant 0 and adds up to 3 alternatives", () => {
      const parsed = parseLoginRecipe(varied());
      expect(passwordVariants(parsed).map((entry) => entry.slots)).toEqual([
        ["branch", "account", "password"],
        ["contract", "password"],
      ]);
      expect(routeSteps(parsed, { route: "password", variant: 1 })).toEqual(
        variant(["contract", "password"]).steps,
      );
      expect(routeSlots(parsed, { route: "password", variant: 0 })).toEqual(parsed.slots);
      expect(routeSlots(parsed, { route: "password", variant: 1 })).toEqual([
        "contract",
        "password",
      ]);
      // An unknown variant has no steps, so no attempt can be created on it.
      expect(routeSteps(parsed, { route: "password", variant: 2 })).toEqual([]);
      expect(recipeSlots(parsed)).toEqual(["branch", "account", "password", "contract"]);
      expect(routeFillTargets(parsed, "password")).toEqual(
        ["branch", "account", "password", "contract"].map(id),
      );
      expect(routePaths(parsed, "password")).toEqual(["/login"]);
      expect(recipeStartSteps(parsed)).toEqual([
        fill(["branch", "account", "password"]),
        fill(["contract", "password"]),
      ]);
      const four = [variant(["contract", "password"]), variant(["card", "password"])];
      expect(valid({ alternatives: [...four, variant(["member", "password"])] })).toBe(true);
      expect(
        valid({ alternatives: [...four, variant(["member", "password"]), variant(["id"])] }),
      ).toBe(false);
      expect(valid({ alternatives: [] })).toBe(false);
    });

    it.each<[string, Record<string, unknown>]>([
      [
        "an alternative's unknown slot",
        { alternatives: [{ slots: ["contract"], steps: [fill(["contract", "pin"]), submit()] }] },
      ],
      [
        "slots its fill steps do not use",
        { alternatives: [{ slots: ["contract", "pin"], steps: [fill(["contract"]), submit()] }] },
      ],
      [
        "unused top-level slots once alternatives exist",
        { slots: ["branch", "account", "password", "pin"] },
      ],
      ["another start path", { alternatives: [variant(["contract", "password"], "/contract")] }],
      ["the same slots", { alternatives: [variant(["password", "account", "branch"])] }],
      ["a subset of another variant's slots", { alternatives: [variant(["branch", "password"])] }],
      [
        "an element another variant fills as another slot",
        {
          alternatives: [
            {
              slots: ["contract", "password"],
              steps: [
                {
                  ...fill([]),
                  fields: [
                    { slot: "contract", target: id("branch") },
                    { slot: "password", target: id("password") },
                  ],
                },
                submit(),
              ],
            },
          ],
        },
      ],
      [
        "the same elements under other slots",
        {
          slots: ["branch", "password"],
          steps: [fill(["branch", "password"]), submit()],
          alternatives: [
            {
              slots: ["contract", "password"],
              steps: [
                {
                  ...fill([]),
                  fields: [
                    { slot: "contract", target: id("branch") },
                    { slot: "password", target: id("password") },
                  ],
                },
                submit(),
              ],
            },
          ],
        },
      ],
      [
        "a variant that advances",
        {
          alternatives: [
            {
              slots: ["contract"],
              steps: [fill(["contract"]), { ...submit(), purpose: "advance" }],
            },
          ],
        },
      ],
      [
        "a first variant that advances",
        { steps: [fill(["branch", "account", "password"]), { ...submit(), purpose: "advance" }] },
      ],
      [
        "an alternative beyond the effect budget",
        {
          alternatives: [
            {
              slots: ["contract", "password"],
              steps: [
                fill(["contract"]),
                { ...submit("/login", "next"), purpose: "advance" },
                fill(["password"], "/password"),
                submit("/password"),
              ],
            },
          ],
        },
      ],
      [
        "an alternative's fallback click after an input-triggered effect",
        {
          maxSubmissions: 2,
          alternatives: [
            {
              slots: ["contract"],
              steps: [{ ...fill(["contract"]), effect: "submit", event: "input" }, submit()],
            },
          ],
        },
      ],
      [
        "an account switch that is an alternative's button",
        {
          accountSwitch: id("contract-login"),
          alternatives: [
            {
              slots: ["contract", "password"],
              steps: [fill(["contract", "password"]), submit("/login", "contract-login")],
            },
          ],
        },
      ],
    ])("refuses %s", (_label, change) => {
      expect(valid()).toBe(true);
      expect(valid(change)).toBe(false);
    });

    it("chooses the first variant the binding fills, and only for an item with a password", () => {
      const parsed = parseLoginRecipe(varied());
      expect(
        chooseLoginRoute(parsed, { password: true, discoverablePasskey: false }, [true, true]),
      ).toEqual({
        route: "password",
        variant: 0,
      });
      expect(
        chooseLoginRoute(parsed, { password: true, discoverablePasskey: false }, [false, true]),
      ).toEqual({
        route: "password",
        variant: 1,
      });
      expect(
        chooseLoginRoute(parsed, { password: true, discoverablePasskey: false }, [false, false]),
      ).toBeUndefined();
      expect(
        chooseLoginRoute(parsed, { password: false, discoverablePasskey: false }, [true, true]),
      ).toBeUndefined();
      // A fit reported for a variant the parsed lacks chooses nothing.
      expect(
        chooseLoginRoute(parsed, { password: true, discoverablePasskey: false }, [
          false,
          false,
          true,
        ]),
      ).toBeUndefined();
    });

    it("keeps the alternatives fixed when a revision is taken over", () => {
      const base = parseLoginRecipe(varied({ completion: undefined }));
      const next = (change: Record<string, unknown>) =>
        parseLoginRecipe({ ...base, revision: 2, ...change });
      expect(
        extendsRecipe(
          base,
          next({ handlers: [{ kind: "passkey", path: "/webauthn", target: id("key") }] }),
        ),
      ).toBe(true);
      expect(extendsRecipe(base, next({ completion: [{ target: id("welcome") }] }))).toBe(true);
      expect(extendsRecipe(base, next({ alternatives: undefined }))).toBe(false);
      expect(
        extendsRecipe(
          base,
          next({
            alternatives: [variant(["contract", "password"]), variant(["card", "password"])],
          }),
        ),
      ).toBe(false);
      expect(extendsRecipe(base, next({ alternatives: [variant(["card", "password"])] }))).toBe(
        false,
      );
      const single = parseLoginRecipe(varied({ alternatives: undefined, completion: undefined }));
      expect(
        extendsRecipe(
          single,
          parseLoginRecipe({
            ...single,
            revision: 2,
            alternatives: [variant(["contract", "password"])],
          }),
        ),
      ).toBe(false);
    });

    it("authorizes a binding that covers exactly the chosen variant's slots", () => {
      const parsed = varied({ origin: "https://bank.example" });
      const contract = {
        ...binding(),
        slots: [
          { slot: "contract", fieldId: "username" },
          { slot: "password", fieldId: "password" },
        ],
      };
      const resolve = (value: LoginAccountBinding, slots: string[]) =>
        resolveLoginPlan(
          snapshot(),
          DUMMY_VAULT_CATALOG,
          "https://bank.example/login",
          parsed,
          value,
          slots,
        );
      expect(resolve(contract, ["contract", "password"])).toMatchObject({ ok: true });
      expect(resolve(contract, ["branch", "account", "password"])).toMatchObject({
        ok: false,
        reason: "binding-slots-mismatch",
      });
      expect(resolve(binding(), ["branch", "account", "password"])).toMatchObject({ ok: true });
      expect(resolve(binding(), ["contract", "password"])).toMatchObject({
        ok: false,
        reason: "binding-slots-mismatch",
      });
    });

    it("refuses a variant whose slots contain another's, in either direction", () => {
      // Variant 0 is a subset of the alternative.
      expect(valid({ alternatives: [variant(["branch", "account", "password", "pin"])] })).toBe(
        false,
      );
      // Two alternatives, one a subset of the other, apart from variant 0.
      expect(
        valid({
          alternatives: [
            variant(["contract", "password"]),
            variant(["contract", "pin", "password"]),
          ],
        }),
      ).toBe(false);
      // Overlapping sets that neither contain the other are distinct variants.
      expect(valid({ alternatives: [variant(["branch", "contract", "password"])] })).toBe(true);
    });

    it("accepts exactly 20 slots over all variants and 24 observed elements", () => {
      const named = (prefix: string, count: number) =>
        Array.from({ length: count }, (_, index) => `${prefix}-${index}`);
      // 3 + 10 + 7 distinct slots.
      expect(
        valid({ alternatives: [variant(named("first", 10)), variant(named("second", 7))] }),
      ).toBe(true);
      expect(
        valid({ alternatives: [variant(named("first", 10)), variant(named("second", 8))] }),
      ).toBe(false);
      // The completion with 4 absent elements and the rejection take 6 of the 24 elements, so
      // an alternative's fill step may hold 18 fields. The union stays within 20 slots, so
      // only the observation bound decides.
      const result = {
        completion: [{ target: id("welcome"), absent: ["a", "b", "c", "d"].map(id) }],
      };
      const wide = (count: number) => [variant(["account", "password", ...named("extra", count)])];
      expect(valid({ ...result, alternatives: wide(16) })).toBe(true);
      expect(valid({ ...result, alternatives: wide(17) })).toBe(false);
      expect(valid({ alternatives: wide(17) })).toBe(true);
    });

    it("refuses a marker or rejection that is any variant's element", () => {
      // A marker proves a sign-in on any path, so no variant's field or button is one.
      expect(valid({ completion: [{ target: id("welcome") }] })).toBe(true);
      expect(valid({ completion: [{ target: id("contract") }] })).toBe(false);
      expect(valid({ completion: [{ target: id("welcome") }, { target: id("login") }] })).toBe(
        false,
      );
      // The rejection is checked on every page, so no variant's button may be it.
      expect(valid({ rejection: id("login") })).toBe(false);
      expect(valid({ rejection: id("contract") })).toBe(false);
    });

    it("validates a single-variant recipe as before alternatives existed", () => {
      const single = (change: Record<string, unknown>) =>
        v.is(loginRecipeSchema, varied({ alternatives: undefined, ...change }));
      expect(single({})).toBe(true);
      // A slot no step fills yet, and a last step that advances to a page still to be learned.
      expect(single({ slots: ["branch", "account", "password", "pin"] })).toBe(true);
      expect(
        single({
          steps: [fill(["branch", "account", "password"]), { ...submit(), purpose: "advance" }],
        }),
      ).toBe(true);
      // A rejection on the recipe's own elements is left to the recipe's author, but a marker
      // proves a sign-in wherever it shows (ADR 0029), so it is never a step's element.
      expect(single({ completion: [{ target: id("branch") }] })).toBe(false);
      expect(single({ rejection: id("login") })).toBe(true);
    });

    it("chooses a variant only from fits reported true, as a sparse list leaves them", () => {
      const parsed = parseLoginRecipe(
        varied({
          alternatives: [variant(["contract", "password"]), variant(["card", "password"])],
        }),
      );
      // planFor fills `fits` only at the index it checked, so earlier entries are holes.
      const sparse: boolean[] = [];
      sparse[2] = true;
      expect(
        chooseLoginRoute(parsed, { password: true, discoverablePasskey: false }, sparse),
      ).toEqual({
        route: "password",
        variant: 2,
      });
      expect(
        chooseLoginRoute(parsed, { password: true, discoverablePasskey: false }, []),
      ).toBeUndefined();
      expect(
        chooseLoginRoute(parsed, { password: true, discoverablePasskey: false }, [
          false,
          true,
          true,
        ]),
      ).toEqual({
        route: "password",
        variant: 1,
      });
    });
  });
}

export function registerPasskeyRoute({
  recipe,
  binding,
  snapshot,
}: Pick<LoginTestContext, "recipe" | "binding" | "snapshot">): void {
  describe("the passkey route (ADR 0027)", () => {
    const id = (value: string) => ({ by: "id" as const, value });
    const passkey = { path: "/identity", target: id("passkey-login") };
    const withPasskey = (change: Record<string, unknown> = {}) => ({
      ...recipe(),
      passkey,
      ...change,
    });
    const valid = (change: Record<string, unknown> = {}) =>
      v.is(loginRecipeSchema, withPasskey(change));
    const click = {
      kind: "click",
      path: "/identity",
      target: id("passkey-login"),
      purpose: "submit",
    };

    it("adds one click on the start page that fills nothing", () => {
      const parsed = parseLoginRecipe(withPasskey());
      expect(recipeHasRoute(parsed, "passkey")).toBe(true);
      expect(recipeHasRoute(parsed, "password")).toBe(true);
      expect(routeSteps(parsed, { route: "passkey" })).toEqual([click]);
      expect(routeSlots(parsed, { route: "passkey" })).toEqual([]);
      expect(routeFillTargets(parsed, "passkey")).toEqual([]);
      expect(routePaths(parsed, "passkey")).toEqual(["/identity"]);
      // The passkey route's page is still the sign-in page while the button or the password
      // form shows, on its own path or any of the password route's.
      expect(routeSignInTargets(parsed, "passkey")).toEqual([
        id("passkey-login"),
        ...routeFillTargets(parsed, "password"),
      ]);
      expect(routeSignInTargets(parsed, "password")).toEqual(routeFillTargets(parsed, "password"));
      expect(routeSignInPaths(parsed, "passkey")).toEqual([
        "/identity",
        ...routePaths(parsed, "password").filter((path) => path !== "/identity"),
      ]);
      expect(routeSignInPaths(parsed, "passkey")).toEqual(
        expect.arrayContaining(routePaths(parsed, "password")),
      );
      expect(routeSignInPaths(parsed, "password")).toEqual(routePaths(parsed, "password"));
      // The passkey click is watched first, beside the password route's first step.
      expect(recipeStartSteps(parsed)).toEqual([click, parsed.steps[0]]);
      // The password route is unchanged, and the recipe's slots are only its own.
      expect(routeSteps(parsed, { route: "password", variant: 0 })).toEqual(parsed.steps);
      expect(recipeSlots(parsed)).toEqual(parsed.slots);
      // A recipe without the button has no route of its own to start; its passkey route
      // only answers the start page's own request (ADR 0034).
      const plain = parseLoginRecipe(recipe());
      expect(recipeHasRoute(plain, "passkey")).toBe(false);
      expect(passkeyAnswersRequest(parsed)).toBe(false);
      expect(passkeyAnswersRequest(plain)).toBe(true);
      expect(routeSteps(plain, { route: "passkey" })).toEqual([
        { kind: "click", path: "/identity", target: id("branch"), purpose: "submit" },
      ]);
      expect(routeSlots(plain, { route: "passkey" })).toEqual([]);
      expect(routeFillTargets(plain, "passkey")).toEqual([]);
      expect(routePaths(plain, "passkey")).toEqual(["/identity"]);
      expect(routeSignInTargets(plain, "passkey")).toEqual(routeFillTargets(plain, "password"));
      expect(routeSignInPaths(plain, "passkey")).toEqual(routePaths(plain, "password"));
      expect(recipeStartSteps(plain)).toEqual([plain.steps[0]]);
    });

    it("answers the start page's own request on the first step's target (ADR 0034)", () => {
      // A recipe whose first step is a click stands for the answer on that button.
      const clickFirst = parseLoginRecipe({
        ...recipe(),
        steps: [
          { kind: "click", path: "/start", target: id("open-login"), purpose: "advance" },
          ...recipe().steps,
        ],
        maxSubmissions: 3,
      });
      expect(passkeyAnswersRequest(clickFirst)).toBe(true);
      expect(routeSteps(clickFirst, { route: "passkey" })).toEqual([
        { kind: "click", path: "/start", target: id("open-login"), purpose: "submit" },
      ]);
      expect(routePaths(clickFirst, "passkey")).toEqual(["/start"]);
      expect(routeSignInPaths(clickFirst, "passkey")).toEqual(["/start", "/identity", "/password"]);
      // The step stands for the answer only: the password route keeps its own steps.
      expect(routeSteps(clickFirst, { route: "password", variant: 0 })).toEqual(clickFirst.steps);
    });

    it("chooses the passkey route for a page's own request only with a discoverable passkey", () => {
      const plain = parseLoginRecipe(recipe());
      const facts = (discoverablePasskey: boolean, password = true) => ({
        password,
        discoverablePasskey,
      });
      // Without the page's request a recipe without the button takes the password route.
      expect(chooseLoginRoute(plain, facts(true), [true])).toEqual({
        route: "password",
        variant: 0,
      });
      expect(chooseLoginRoute(plain, facts(true), [true], false)).toEqual({
        route: "password",
        variant: 0,
      });
      expect(chooseLoginRoute(plain, facts(true), [true], true)).toEqual({ route: "passkey" });
      // An item without a password still answers the request.
      expect(chooseLoginRoute(plain, facts(true, false), [], true)).toEqual({ route: "passkey" });
      // A passkey that is not discoverable never answers it.
      expect(chooseLoginRoute(plain, facts(false), [true], true)).toEqual({
        route: "password",
        variant: 0,
      });
      expect(chooseLoginRoute(plain, facts(false, false), [true], true)).toBeUndefined();
      // A recipe with the button takes its route either way.
      const button = parseLoginRecipe(withPasskey());
      expect(chooseLoginRoute(button, facts(true), [true], true)).toEqual({ route: "passkey" });
      expect(chooseLoginRoute(button, facts(true), [true], false)).toEqual({ route: "passkey" });
      // An item without a password, or whose binding fills no variant, still takes it.
      expect(chooseLoginRoute(button, facts(true, false), [])).toEqual({ route: "passkey" });
    });

    it.each<[string, Record<string, unknown>]>([
      ["on another path than the start path", { passkey: { ...passkey, path: "/password" } }],
      ["on a variant's fill field", { passkey: { ...passkey, target: id("branch") } }],
      ["on a variant's button", { passkey: { ...passkey, target: id("next") } }],
      ["on the account switch", { accountSwitch: id("passkey-login") }],
      ["on the rejection", { rejection: id("passkey-login") }],
      [
        "on a handler on its path",
        { handlers: [{ kind: "passkey", path: "/identity", target: id("passkey-login") }] },
      ],
      ["with a value", { passkey: { ...passkey, value: "synthetic-only" } }],
      ["with CSS", { passkey: { ...passkey, target: { by: "css", value: "#passkey" } } }],
    ])("refuses a passkey button %s", (_label, change) => {
      expect(valid()).toBe(true);
      expect(valid(change)).toBe(false);
    });

    it("keeps its button apart from every password variant on the start page", () => {
      const contract = {
        slots: ["contract", "pin"],
        steps: [
          {
            kind: "fill",
            path: "/identity",
            fields: [
              { slot: "contract", target: id("contract") },
              { slot: "pin", target: id("pin") },
            ],
          },
          { kind: "click", path: "/identity", target: id("contract-login"), purpose: "submit" },
        ],
      };
      const varied = (change: Record<string, unknown> = {}) =>
        withPasskey({ alternatives: [contract], ...change });
      expect(v.is(loginRecipeSchema, varied())).toBe(true);
      // An alternative's field or button is not the passkey button either.
      for (const value of ["contract", "pin", "contract-login"])
        expect(
          v.is(loginRecipeSchema, varied({ passkey: { ...passkey, target: id(value) } })),
          value,
        ).toBe(false);
      const parsed = parseLoginRecipe(varied());
      // The button is watched first, then every variant's first step.
      expect(recipeStartSteps(parsed)).toEqual([
        click,
        parsed.steps[0],
        parsed.alternatives![0]!.steps[0],
      ]);
      expect(parsed.alternatives![0]!.steps[0]).toMatchObject(contract.steps[0]!);
      // The password route's sign-in elements are its fill fields, never the button.
      expect(routeSignInTargets(parsed, "password")).not.toContainEqual(id("passkey-login"));
      expect(routeSignInTargets(parsed, "password")).toContainEqual(id("contract"));
      // The passkey route wins over any fitting variant, and a second factor leaves them.
      const facts = (discoverablePasskey: boolean) => ({ password: true, discoverablePasskey });
      expect(chooseLoginRoute(parsed, facts(true), [false, true])).toEqual({ route: "passkey" });
      expect(chooseLoginRoute(parsed, facts(false), [false, true])).toEqual({
        route: "password",
        variant: 1,
      });
      expect(
        chooseLoginRoute(parsed, { password: false, discoverablePasskey: false }, [true, true]),
      ).toBeUndefined();
    });

    it("counts its button as one element within the observation bound", () => {
      // 18 fields, a completion with 4 absent elements and the rejection fill the 24.
      const fields = (count: number) =>
        Array.from({ length: count }, (_, index) => ({
          slot: `s${index}`,
          target: id(`field${index}`),
        }));
      const wide = (count: number) =>
        withPasskey({
          slots: fields(count).map((field) => field.slot),
          steps: [
            { kind: "fill", path: "/identity", fields: fields(count) },
            { kind: "click", path: "/identity", target: id("go"), purpose: "submit" },
          ],
          completion: [{ target: id("welcome"), absent: ["a", "b", "c", "d"].map(id) }],
          maxSubmissions: 1,
        });
      // The button is observed with the start page's step, not on top of its fields.
      expect(v.is(loginRecipeSchema, wide(18))).toBe(true);
      expect(v.is(loginRecipeSchema, wide(19))).toBe(false);
    });

    it("allows the same locator where another path uses it, but never as a marker", () => {
      // The password page's button and a handler on other paths are other elements than the
      // start page's passkey button.
      expect(valid({ passkey: { ...passkey, target: id("login") } })).toBe(true);
      // A marker proves a sign-in on any path, the start page included (ADR 0029).
      expect(valid({ completion: [{ target: id("passkey-login") }] })).toBe(false);
      expect(
        valid({
          handlers: [{ kind: "passkey", path: "/webauthn", target: id("passkey-login") }],
        }),
      ).toBe(true);
    });

    it("keeps the route fixed when a revision is taken over", () => {
      const base = parseLoginRecipe(withPasskey({ completion: undefined }));
      const next = (change: Record<string, unknown>) =>
        parseLoginRecipe({ ...base, revision: 2, ...change });
      expect(
        extendsRecipe(
          base,
          next({ handlers: [{ kind: "passkey", path: "/webauthn", target: id("key") }] }),
        ),
      ).toBe(true);
      expect(extendsRecipe(base, next({ completion: [{ target: id("welcome") }] }))).toBe(true);
      expect(extendsRecipe(base, next({ passkey: undefined }))).toBe(false);
      expect(extendsRecipe(base, next({ passkey: { ...passkey, target: id("other") } }))).toBe(
        false,
      );
      const plain = parseLoginRecipe({ ...recipe(), completion: undefined });
      expect(extendsRecipe(plain, parseLoginRecipe({ ...plain, revision: 2, passkey }))).toBe(
        false,
      );
    });

    it("authorizes a binding without slots for the route's empty slot list only", () => {
      const empty = { ...binding(), slots: [] };
      expect(parseLoginAccountBinding(empty)).toEqual(empty);
      const resolve = (value: LoginAccountBinding, slots: string[]) =>
        resolveLoginPlan(
          snapshot(),
          DUMMY_VAULT_CATALOG,
          "https://bank.example/identity",
          withPasskey(),
          value,
          slots,
        );
      expect(resolve(empty, [])).toMatchObject({ ok: true, binding: empty });
      expect(resolve(binding(), [])).toMatchObject({ ok: false, reason: "binding-slots-mismatch" });
      expect(resolve(empty, ["branch", "account", "password"])).toMatchObject({
        ok: false,
        reason: "binding-slots-mismatch",
      });
    });
  });
}

export function registerTotpRecipeChecks({ recipe }: Pick<LoginTestContext, "recipe">): void {
  describe("totp handler recipe checks, probed independently (ADR 0027)", () => {
    const verify = { by: "text", value: "Verify" } as const;
    const totp = (change: Record<string, unknown> = {}) => ({
      kind: "totp" as const,
      path: "/two-factor",
      field: { by: "id" as const, value: "otp" },
      target: verify,
      ...change,
    });
    const key = (change: Record<string, unknown> = {}) => ({
      kind: "passkey" as const,
      path: "/two-factor",
      target: { by: "text" as const, value: "Use security key" },
      ...change,
    });
    const parses = (value: Record<string, unknown>) =>
      v.safeParse(loginRecipeSchema, { ...recipe(), ...value }).success;

    it("refuses a field equal to its button under every attribute locator", () => {
      for (const element of [
        { by: "id", value: "code" },
        { by: "name", value: "code" },
        { by: "test-id", value: "code" },
      ])
        expect(parses({ handlers: [totp({ field: element, target: element })] })).toBe(false);
      // The same value under another locator is another element.
      expect(
        parses({
          handlers: [
            totp({ field: { by: "id", value: "code" }, target: { by: "name", value: "code" } }),
          ],
        }),
      ).toBe(true);
      expect(
        parses({
          handlers: [
            totp({ field: { by: "id", value: "code" }, target: { by: "text", value: "code" } }),
          ],
        }),
      ).toBe(true);
    });

    it("accepts name and test-id code fields and refuses a text-located one", () => {
      for (const field of [
        { by: "name", value: "otp" },
        { by: "test-id", value: "otp-input" },
      ])
        expect(parses({ handlers: [totp({ field })] })).toBe(true);
      expect(parses({ handlers: [totp({ field: { by: "text", value: "otp" } })] })).toBe(false);
      // The field is required, and the passkey shape carries none.
      expect(parses({ handlers: [{ kind: "totp", path: "/two-factor", target: verify }] })).toBe(
        false,
      );
      expect(parses({ handlers: [key({ field: { by: "id", value: "otp" } })] })).toBe(false);
    });

    it("lets a passkey and a totp handler share a path in either order", () => {
      for (const handlers of [
        [totp(), key()],
        [key(), totp()],
      ])
        expect(parseLoginRecipe({ ...recipe(), handlers }).handlers).toEqual(handlers);
      // Two code pages on different paths are two handlers.
      expect(parses({ handlers: [totp(), totp({ path: "/two-factor/again" })] })).toBe(true);
    });

    it("refuses a second handler of the same kind on one path, whatever its elements", () => {
      expect(
        parses({
          handlers: [
            totp(),
            totp({ field: { by: "id", value: "other" }, target: { by: "id", value: "go" } }),
          ],
        }),
      ).toBe(false);
      expect(
        parses({ handlers: [key(), totp(), key({ target: { by: "id", value: "k2" } })] }),
      ).toBe(false);
    });

    it("refuses an account switch that is the code field or its button, on any path", () => {
      expect(parses({ handlers: [totp()], accountSwitch: { by: "id", value: "otp" } })).toBe(false);
      expect(parses({ handlers: [totp()], accountSwitch: verify })).toBe(false);
      expect(
        parses({
          handlers: [totp({ path: "/elsewhere" })],
          accountSwitch: { by: "id", value: "otp" },
        }),
      ).toBe(false);
      // An unrelated switch is fine.
      expect(parses({ handlers: [totp()], accountSwitch: { by: "id", value: "switch" } })).toBe(
        true,
      );
    });

    it("refuses a signed-in marker that is either of the handler's elements, on any path", () => {
      const marker = { by: "id", value: "authenticated" } as const;
      expect(parses({ handlers: [totp({ path: "/authenticated", target: marker })] })).toBe(false);
      expect(parses({ handlers: [totp({ path: "/authenticated", field: marker })] })).toBe(false);
      expect(parses({ handlers: [totp({ target: marker })] })).toBe(false);
      expect(parses({ handlers: [totp({ field: marker })] })).toBe(false);
    });

    it("refuses a passkey route button that is either of the handler's elements on its path", () => {
      const button = { by: "id", value: "passkey-login" } as const;
      const passkey = { path: "/identity", target: button };
      expect(parses({ passkey, handlers: [totp({ path: "/identity", target: button })] })).toBe(
        false,
      );
      expect(parses({ passkey, handlers: [totp({ path: "/identity", field: button })] })).toBe(
        false,
      );
      // On another path the same element is not the route's button.
      expect(parses({ passkey, handlers: [totp({ target: button })] })).toBe(true);
      expect(parses({ passkey, handlers: [totp({ field: button })] })).toBe(true);
    });
  });
}
