import {
  MAX_RECIPE_DOCUMENT_BYTES,
  type LoginObservation,
  type ObservedCandidate,
  type RecipeGenerationResult,
  type SemanticSlot,
} from "@pateat/contracts";
import { env } from "cloudflare:workers";
import { generateRecipe, generatedRecipeId } from "@pateat/generation";
import { describe, expect, it } from "vitest";
import { d1Backend } from "../../src/recipes/backend";
import type { Device, GenerationContext } from "./context";

// What never takes another recipe's start path, and what keeps it (ADR 0060 amendment of
// 2026-11-18). Synthetic pages in the shape of USI's Student Portal.

export function registerStartAliasGuardCases({
  ORIGIN,
  element,
  observation,
  plan,
  owner,
  post,
  storedHead,
  rows,
  state,
}: Pick<
  GenerationContext,
  "ORIGIN" | "element" | "observation" | "plan" | "owner" | "post" | "storedHead" | "rows" | "state"
>) {
  const LEARNED = "/student/Usi/Forgotten/Success";
  const CODE = "/student/SecondFactor/ChooseAndVerifyOtp";
  const id = (value: string) => ({ by: "id" as const, value });
  const slots: SemanticSlot[] = [
    { id: "username", kind: "identifier", description: "account username" },
    { id: "password", kind: "secret", description: "account password" },
  ];
  /** The sign-in form on `path`. */
  const form = (path: string, extra: ObservedCandidate[] = []): LoginObservation =>
    observation(path, [
      element("UserName", "text", "USI or Email"),
      element("Password", "password", "Password"),
      element("Login", "button", "Login"),
      ...extra,
    ]);
  const signIn = (path: string, user = "UserName") => [
    {
      kind: "fill" as const,
      path,
      effect: "prepare" as const,
      fields: [
        { slot: "username", target: id(user) },
        { slot: "password", target: id("Password") },
      ],
    },
    { kind: "click" as const, path, target: id("Login"), purpose: "submit" as const },
  ];
  const layout = (key: string, steps: object[], extra: object = {}) => ({
    key,
    language: "en" as const,
    createdAt: Number(key),
    pageKind: "sign-in" as const,
    slots: ["username", "password"],
    steps,
    maxSubmissions: 2,
    ...extra,
  });
  const totp = {
    handlers: [{ kind: "totp", path: CODE, field: id("Code"), target: id("nextButton") }],
  };
  /** Writes `document` as a device writes a recipe, under `recipeId`. */
  async function put(device: Device, recipeId: string, document: object, revision = 1) {
    const written = await post(
      device,
      `/v1/recipes/${recipeId}`,
      {
        version: 1,
        expectedRevision: revision - 1,
        state: "active",
        recipe: { version: 1, id: recipeId, revision, origin: ORIGIN, ...document },
      },
      "PUT",
    );
    expect(written.status).toBe(200);
    return recipeId;
  }
  /** A recipe generated for `path`, of `members`. */
  const learned = async (device: Device, path: string, members: object) =>
    put(device, await generatedRecipeId(ORIGIN, path), members);
  async function generate(device: Device, page: LoginObservation, extra: object = {}) {
    const response = await post(device, "/v1/recipes/generate", {
      version: 1,
      observation: page,
      slots: page.accounts ? [] : slots,
      ...(page.accounts ? {} : { signedIn: false }),
      ...extra,
    });
    expect(response.status).toBe(200);
    return (await response.json()) as RecipeGenerationResult;
  }
  /** A page on its own path generated as before: one model call, a recipe of its own. */
  async function generatesOwn(
    device: Device,
    page: LoginObservation,
    extra: object = {},
    reply = plan(
      [
        ["username", "UserName"],
        ["password", "Password"],
      ],
      "Login",
      "submit",
    ),
  ) {
    state.sent = [];
    state.replies.push({ text: reply });
    expect(await generate(device, page, extra)).toMatchObject({
      status: "recipe",
      change: { recipeId: await generatedRecipeId(ORIGIN, page.path), revision: 1 },
    });
    expect(state.sent).toHaveLength(1);
  }

  it("aliases only a page the device read as signed out, never one asked for by hand", async () => {
    // Each on an owner of its own: a page generated on its own path would match too.
    const once = async (send: (device: Device, page: LoginObservation) => Promise<void>) => {
      const device = await owner();
      const recipeId = await learned(device, LEARNED, {
        layouts: [layout("1000", signIn(LEARNED))],
      });
      const before = await storedHead(device.ownerId, recipeId);
      await send(device, form("/student"));
      expect(await storedHead(device.ownerId, recipeId)).toEqual(before);
    };
    await once((device, page) => generatesOwn(device, page, { signedIn: true }));
    await once((device, page) => generatesOwn(device, page, { manual: true }));
    // A device that could not tell whether the site is signed in, as on a step-up page,
    // sends no hint; the route refuses such a request, and a device that runs generation
    // with its own key (ADR 0040) gets no alias for it either.
    await once(async (device, page) => {
      state.sent = [];
      const backend = d1Backend(
        env,
        { ownerId: device.ownerId, deviceId: device.deviceId, profileId: device.ownerId },
        { startedAt: Date.now() },
      );
      const unread = await generateRecipe(backend, { version: 1, observation: page, slots });
      expect(unread).not.toMatchObject({ status: "recipe", change: { revision: 2 } });
      expect(state.sent).toHaveLength(1);
    });
  });

  it("never aliases a path the recipe runs a handler or a later page on", async () => {
    const device = await owner();
    const recipeId = await learned(device, LEARNED, {
      layouts: [layout("1000", signIn(LEARNED), totp)],
    });
    const twoPages = await learned(device, "/student/two", {
      layouts: [
        layout(
          "2000",
          [
            {
              kind: "fill",
              path: "/student/two",
              effect: "prepare",
              fields: [{ slot: "username", target: id("Email") }],
            },
            { kind: "click", path: "/student/two", target: id("Next"), purpose: "advance" },
            {
              kind: "fill",
              path: "/student/password",
              effect: "prepare",
              fields: [{ slot: "password", target: id("Secret") }],
            },
            { kind: "click", path: "/student/password", target: id("Go"), purpose: "submit" },
          ],
          { language: "en" },
        ),
      ],
    });
    const before = [
      await storedHead(device.ownerId, recipeId),
      await storedHead(device.ownerId, twoPages),
    ];
    // The code page shows the learned form, as a site may after a failed code.
    await generatesOwn(device, form(CODE));
    // The password page shows the two-page recipe's first page again.
    const again = observation("/student/password", [
      element("Email", "email", "Email"),
      element("Next", "button", "Next"),
    ]);
    await generatesOwn(device, again, {}, plan([["username", "Email"]], "Next", "advance"));
    expect([
      await storedHead(device.ownerId, recipeId),
      await storedHead(device.ownerId, twoPages),
    ]).toEqual(before);
  });

  it("generates a path two recipes already list, and adds it to neither", async () => {
    const device = await owner();
    const first = await learned(device, LEARNED, {
      layouts: [layout("1000", signIn(LEARNED))],
      starts: ["/student"],
    });
    // Another recipe, of another form, lists it as well, as two devices' writes may.
    const second = await learned(device, "/student/other", {
      layouts: [layout("2000", signIn("/student/other", "Email"))],
      starts: ["/student"],
    });
    const before = [
      await storedHead(device.ownerId, first),
      await storedHead(device.ownerId, second),
    ];
    await generatesOwn(device, form("/student"));
    expect([
      await storedHead(device.ownerId, first),
      await storedHead(device.ownerId, second),
    ]).toEqual(before);
  });

  it("aliases no recipe stored under an ID generated for another path", async () => {
    const device = await owner();
    const recipeId = await put(device, await generatedRecipeId(ORIGIN, "/student/elsewhere"), {
      layouts: [layout("1000", signIn(LEARNED))],
    });
    const before = await storedHead(device.ownerId, recipeId);
    await generatesOwn(device, form("/student"));
    expect(await storedHead(device.ownerId, recipeId)).toEqual(before);
  });

  it("answers a conflict for a path an entry recipe starts on under another ID", async () => {
    const device = await owner();
    await put(device, await generatedRecipeId(ORIGIN, "/student/entry"), {
      entry: { path: "/student", target: { by: "text", value: "Login" } },
    });
    state.sent = [];
    expect(await generate(device, form("/student"))).toEqual({
      version: 1,
      status: "unavailable",
      reason: "recipe-conflict",
    });
    expect(state.sent).toEqual([]);
  });

  it("answers with the recipe another request added the path to during the call", async () => {
    const device = await owner();
    const recipeId = await learned(device, LEARNED, { layouts: [layout("1000", signIn(LEARNED))] });
    // Another device reads the page as signed out and adds the path while this request,
    // which read it as signed in, is with the model.
    state.during = async () => {
      state.during = undefined;
      await put(
        device,
        recipeId,
        { layouts: [layout("1000", signIn(LEARNED))], starts: ["/student"] },
        2,
      );
    };
    state.replies.push({
      text: plan(
        [
          ["username", "UserName"],
          ["password", "Password"],
        ],
        "Login",
        "submit",
      ),
    });
    expect(await generate(device, form("/student"), { signedIn: true })).toMatchObject({
      status: "recipe",
      change: { recipeId, revision: 2 },
    });
    expect(
      await rows("SELECT recipe_id FROM recipe_heads WHERE owner_id = ?", device.ownerId),
    ).toEqual([{ recipe_id: recipeId }]);
  });

  describe("a recipe rebuilt as one kind or both", () => {
    const list = (path: string): LoginObservation => ({
      ...observation(path, [element("other", "button", "Use another account")]),
      accounts: ["Taro [email]"],
    });
    const listAnswer = JSON.stringify({ result: { decision: "account-list", other: "other" } });
    const repair = (device: Device, page: LoginObservation, recipeId: string, revision = 1) =>
      generate(device, page, { repair: { recipeId, revision } });

    it("keeps its other start paths when a list is added beside its form", async () => {
      const device = await owner();
      const recipeId = await learned(device, LEARNED, {
        layouts: [layout("1000", signIn(LEARNED))],
        starts: ["/student"],
      });
      state.replies.push({ text: listAnswer });
      expect(await repair(device, list(LEARNED), recipeId)).toMatchObject({ status: "recipe" });
      expect(await storedHead(device.ownerId, recipeId)).toMatchObject({
        revision: 2,
        layouts: [{ key: "1000" }],
        chooser: { path: LEARNED },
        starts: ["/student"],
      });
    });

    it("keeps them when the list takes the place of a form too large to keep", async () => {
      const device = await owner();
      // A start path and text targets at their longest on every variant, so a list beside
      // the form would pass the document's size limit.
      const LONG = `/student/${"a".repeat(291)}`;
      const text = (value: string) => ({ by: "text" as const, value: value.padEnd(120, "x") });
      const named = (name: string, pad: number) => id(`${name}${"x".repeat(pad)}`);
      const variant = (name: string, asserts: number, pad: number) => ({
        slots: [name],
        steps: [
          {
            kind: "fill" as const,
            path: LONG,
            effect: "prepare" as const,
            fields: [{ slot: name, target: named(`f${name}`, pad) }],
          },
          ...Array.from({ length: asserts }, (_, index) => ({
            kind: "assert" as const,
            path: LONG,
            target: text(`${name}-${index}`),
            present: true,
          })),
          { kind: "click" as const, path: LONG, target: named(`g${name}`, pad), purpose: "submit" },
        ],
      });
      const names = ["1000", "2000", "3000"].flatMap((key) =>
        ["a", "b", "c", "d"].map((name) => `${key}${name}`),
      );
      const recipeId = await generatedRecipeId(ORIGIN, LONG);
      const sized = (counts: number[], pads: number[]) => ({
        version: 1,
        id: recipeId,
        revision: 1,
        origin: ORIGIN,
        layouts: ["1000", "2000", "3000"].map((key, index) => {
          const [first, ...alternatives] = names
            .slice(index * 4, index * 4 + 4)
            .map((name, at) => variant(name, counts[index * 4 + at]!, pads[index * 4 + at]!));
          return { ...layout(key, first!.steps), slots: first!.slots, alternatives };
        }),
        starts: ["/student"],
      });
      const bytes = (document: object) => new TextEncoder().encode(JSON.stringify(document)).length;
      // Just under the limit: a list beside it, a few hundred bytes, would pass it.
      const counts = names.map(() => 0);
      const pads = names.map(() => 0);
      const grow = (values: number[], most: number, limit: number) => {
        for (const index of values.keys())
          while (values[index]! < most) {
            values[index]! += 1;
            if (bytes(sized(counts, pads)) <= limit) continue;
            values[index]! -= 1;
            break;
          }
      };
      grow(counts, 30, MAX_RECIPE_DOCUMENT_BYTES - 1500);
      grow(pads, 100, MAX_RECIPE_DOCUMENT_BYTES - 100);
      const document = sized(counts, pads);
      expect(bytes(document)).toBeGreaterThan(MAX_RECIPE_DOCUMENT_BYTES - 200);
      const {
        version: _version,
        id: _id,
        revision: _revision,
        origin: _origin,
        ...members
      } = document;
      await put(device, recipeId, members);
      state.replies.push({ text: listAnswer });
      expect(await repair(device, list(LONG), recipeId)).toMatchObject({ status: "recipe" });
      const head = (await storedHead(device.ownerId, recipeId)) as Record<string, unknown>;
      expect(head).toMatchObject({ revision: 2, chooser: { path: LONG }, starts: ["/student"] });
      expect(head).not.toHaveProperty("layouts");
    });

    /** A list alone on the learned path, beside `afterOther` if any. */
    const listed = (afterOther?: object) => ({
      chooser: {
        path: LEARNED,
        layouts: [
          {
            key: "1000",
            createdAt: 1000,
            other: id("other"),
            ...(afterOther ? { afterOther } : {}),
          },
        ],
      },
      starts: ["/student"],
    });
    const formAnswer = plan(
      [
        ["username", "UserName"],
        ["password", "Password"],
      ],
      "Login",
      "submit",
    );

    it("keeps them when a form is added beside its list", async () => {
      const device = await owner();
      const recipeId = await learned(device, LEARNED, listed());
      state.replies.push({ text: formAnswer });
      expect(await repair(device, form(LEARNED), recipeId)).toMatchObject({ status: "recipe" });
      expect(await storedHead(device.ownerId, recipeId)).toMatchObject({
        revision: 2,
        layouts: [{ steps: [{ path: LEARNED }, { path: LEARNED }] }],
        chooser: { path: LEARNED },
        starts: ["/student"],
      });
    });

    it("keeps them when the form takes the place of a list whose slots leave no room", async () => {
      const device = await owner();
      // The list's other branch fills 19 slots, so the form's two would pass the 20.
      const names = Array.from({ length: 19 }, (_, index) => `field ${index}`);
      const recipeId = await learned(
        device,
        LEARNED,
        listed({
          pageKind: "sign-in",
          slots: names,
          steps: [
            ...names.map((name, index) => ({
              kind: "fill",
              path: LEARNED,
              effect: "prepare",
              fields: [{ slot: name, target: id(`field-${index}`) }],
            })),
            { kind: "click", path: LEARNED, target: id("go"), purpose: "submit" },
          ],
          maxSubmissions: 1,
        }),
      );
      state.replies.push({ text: formAnswer });
      expect(await repair(device, form(LEARNED), recipeId)).toMatchObject({ status: "recipe" });
      const head = (await storedHead(device.ownerId, recipeId)) as Record<string, unknown>;
      expect(head).toMatchObject({
        revision: 2,
        layouts: [{ steps: [{ path: LEARNED }, { path: LEARNED }] }],
        starts: ["/student"],
      });
      expect(head).not.toHaveProperty("chooser");
    });
  });
}
