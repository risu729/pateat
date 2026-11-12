import { type LoginObservation, type RecipeCompletionResult } from "@pateat/contracts";
import { expect, it } from "vitest";
import type { GenerationContext, Device } from "./context";

export function registerPasskeyRoute(context: GenerationContext) {
  const {
    element,
    observation,
    emailPage,
    passwordPage,
    homePage,
    route,
    plan,
    owner,
    post,
    projected,
    generate,
    complete,
    rows,
    logRows,
    state,
  } = context;

  const passkeyButton = {
    id: "passkey",
    role: "button" as const,
    target: { by: "text" as const, value: "Sign in with a passkey" },
    label: "Sign in with a passkey",
  };
  const signInPage = observation("/login", [
    element("email", "email", "Email"),
    element("password", "password", "Password"),
    element("sign-in", "button", "Sign in"),
    passkeyButton,
    element("add-passkey", "button", "Add a passkey"),
  ]);
  const answer = (button: string | undefined, purpose: "advance" | "submit" = "submit") =>
    JSON.stringify({
      result: {
        decision: "plan",
        pageKind: "sign-in",
        irreversible: "no",
        fields:
          purpose === "submit"
            ? [
                { slot: "email", candidate: "email" },
                { slot: "password", candidate: "password" },
              ]
            : [{ slot: "email", candidate: "email" }],
        action: { candidate: purpose === "submit" ? "sign-in" : "next", purpose },
        ...(button ? { passkeyButton: button } : {}),
      },
    });
  async function judge(device: Device, recipeId: string, revision: number, page: LoginObservation) {
    const response = await post(device, `/v1/recipes/${recipeId}/completion`, {
      version: 1,
      slots: [],
      revision,
      route: "passkey",
      observation: page,
    });
    return projected((await response.json()) as RecipeCompletionResult);
  }

  it("stores the start page's passkey button as the route and logs what the model named", async () => {
    const device = await owner();
    state.replies.push({ text: answer("passkey") });
    const result = await generate(device, signInPage);
    expect(result).toMatchObject({
      status: "recipe",
      change: {
        revision: 1,
        recipe: {
          slots: ["email", "password"],
          passkey: { path: "/login", target: passkeyButton.target },
        },
      },
    });
    const [logged] = await rows(
      "SELECT result FROM inference_log WHERE owner_id = ? AND role = 'generate'",
      device.ownerId,
    );
    expect(JSON.parse(String(logged!.result))).toMatchObject({ passkeyButton: "passkey" });
  });

  it.each([
    ["a registration button", "add-passkey"],
    ["the page action", "sign-in"],
    ["a candidate the page lacks", "missing"],
  ])("drops %s and stores the password route alone", async (_label, button) => {
    const device = await owner();
    state.replies.push({ text: answer(button) });
    const result = await generate(device, signInPage);
    if (result.status !== "recipe") throw new Error(result.status);
    expect(result.change.recipe).not.toHaveProperty("passkey");
    expect(route(result.change.recipe).slots).toEqual(["email", "password"]);
    // The result keeps nothing the plan check dropped; the model's own answer keeps what
    // it named, as `?` when the page lacks it.
    const [row] = await logRows(device.ownerId);
    const [logged] = await rows(
      "SELECT result FROM inference_log WHERE owner_id = ? AND role = 'generate'",
      device.ownerId,
    );
    expect(JSON.parse(String(logged!.result))).not.toHaveProperty("passkeyButton");
    expect(row!.answer).toMatchObject({
      decision: "plan",
      pageKind: "sign-in",
      irreversible: "no",
      passkeyButton: button === "missing" ? "?" : button,
    });
  });

  it("tells the judge every path of the password form on the passkey route", async () => {
    const device = await owner();
    state.replies.push({
      text: JSON.stringify({
        result: {
          decision: "plan",
          pageKind: "sign-in",
          irreversible: "no",
          fields: [{ slot: "email", candidate: "email" }],
          action: { candidate: "next", purpose: "advance" },
          passkeyButton: "passkey",
        },
      }),
    });
    const first = await generate(
      device,
      observation("/login", [...emailPage.candidates, passkeyButton]),
    );
    if (first.status !== "recipe") throw new Error(first.status);
    expect(first.change.recipe).toMatchObject({ passkey: { path: "/login" } });
    state.replies.push({ text: plan([["password", "password"]], "sign-in", "submit") });
    const second = await generate(device, passwordPage, {
      recipeId: first.change.recipeId,
      revision: first.change.revision,
    });
    if (second.status !== "recipe") throw new Error(second.status);
    const { recipeId, revision } = second.change;
    // The password page after the passkey click is the sign-in page, not a page to learn.
    const calls = state.sent.length;
    expect(await judge(device, recipeId, revision, passwordPage)).toMatchObject({
      status: "unavailable",
      reason: "not-judgeable",
    });
    expect(state.sent).toHaveLength(calls);
    state.replies.push({ text: JSON.stringify({ result: { decision: "rejected" } }) });
    expect(await judge(device, recipeId, revision, homePage)).toMatchObject({
      status: "rejected",
    });
    const [logged] = await rows(
      "SELECT request FROM inference_log WHERE owner_id = ? AND role = 'judge'",
      device.ownerId,
    );
    expect(JSON.parse(String(logged!.request))).toMatchObject({
      route: "passkey",
      loginPaths: ["/login", "/password"],
    });
    // A page of another origin of the site the tab moved to is judged on this route too,
    // as on the password route (ADR 0022, owner 2026-11-08).
    state.replies.push({ text: JSON.stringify({ result: { decision: "unclear" } }) });
    expect(
      await judge(device, recipeId, revision, {
        ...homePage,
        origin: "https://www.example.test",
      }),
    ).toMatchObject({ status: "unclear" });
  });

  it("ignores a passkey button on a continued page", async () => {
    const device = await owner();
    state.replies.push({ text: plan([["email", "email"]], "next", "advance") });
    const first = await generate(device, emailPage);
    if (first.status !== "recipe") throw new Error(first.status);
    const passwordWithPasskey = observation("/password", [
      ...passwordPage.candidates,
      passkeyButton,
    ]);
    state.replies.push({
      text: JSON.stringify({
        result: {
          decision: "plan",
          pageKind: "sign-in",
          irreversible: "no",
          fields: [{ slot: "password", candidate: "password" }],
          action: { candidate: "sign-in", purpose: "submit" },
          passkeyButton: "passkey",
        },
      }),
    });
    const second = await generate(device, passwordWithPasskey, {
      recipeId: first.change.recipeId,
      revision: first.change.revision,
    });
    if (second.status !== "recipe") throw new Error(second.status);
    expect(second.change.revision).toBe(2);
    expect(second.change.recipe).not.toHaveProperty("passkey");
  });

  it("judges the passkey route's pages, but not its start page while the button shows", async () => {
    const device = await owner();
    state.replies.push({ text: answer("passkey") });
    const result = await generate(device, signInPage);
    if (result.status !== "recipe") throw new Error(result.status);
    const { recipeId } = result.change;
    const calls = state.sent.length;
    // The passkey exchange may still run on the start page: not judged.
    const stillThere = observation("/login", [passkeyButton, element("help", "link", "Help")]);
    expect(await judge(device, recipeId, 1, stillThere)).toEqual({
      version: 1,
      status: "unavailable",
      reason: "not-judgeable",
    });
    expect(state.sent).toHaveLength(calls);
    // The password form showing again without the button is still the sign-in page, on
    // the start path or any other: judging it would spend the start path's one judgement
    // and could add a handler there (ADR 0027).
    for (const formAgain of [
      observation("/login", [
        element("email", "email", "Email"),
        element("password", "password", "Password"),
        element("sign-in", "button", "Sign in"),
      ]),
      observation("/login", [element("password", "password", "Password")]),
      observation("/retry", [element("email", "email", "Email")]),
    ])
      // Sequential, so each refusal is seen before the next request.
      // eslint-disable-next-line no-await-in-loop
      expect(await judge(device, recipeId, 1, formAgain)).toEqual({
        version: 1,
        status: "unavailable",
        reason: "not-judgeable",
      });
    expect(state.sent).toHaveLength(calls);
    // Another path with the same text is another element, so that page is judged.
    state.replies.push({ text: JSON.stringify({ result: { decision: "rejected" } }) });
    expect(await judge(device, recipeId, 1, observation("/help", [passkeyButton]))).toEqual({
      version: 1,
      status: "rejected",
    });
    state.replies.push({
      text: JSON.stringify({ result: { decision: "signed-in", marker: "logout" } }),
    });
    expect(await judge(device, recipeId, 1, homePage)).toMatchObject({
      status: "signed-in",
      change: {
        revision: 2,
        recipe: {
          completion: [{ target: { by: "id", value: "logout" } }],
          passkey: { path: "/login", target: passkeyButton.target },
        },
      },
    });
    // The four pages not judged are logged unsent, with the same request.
    const logged = await rows(
      "SELECT request, model_id FROM inference_log WHERE owner_id = ? AND role = 'judge'",
      device.ownerId,
    );
    expect(logged.filter((row) => row["model_id"] !== null)).toHaveLength(2);
    expect(logged).toHaveLength(6);
    for (const row of logged)
      expect(JSON.parse(String(row.request))).toMatchObject({
        route: "passkey",
        loginPaths: ["/login"],
      });
    // On the password route, the button alone does not keep the start page from a judgement.
    state.replies.push({ text: JSON.stringify({ result: { decision: "rejected" } }) });
    expect((await complete(device, recipeId, 2, stillThere)).body).toEqual({
      version: 1,
      status: "rejected",
    });
  });

  it("tells the judge every sign-in path on both routes of a recipe of two pages", async () => {
    const device = await owner();
    const start = observation("/login", [
      element("email", "email", "Email"),
      element("next", "button", "Next"),
      passkeyButton,
    ]);
    state.replies.push({ text: answer("passkey", "advance") });
    const first = await generate(device, start);
    if (first.status !== "recipe") throw new Error(first.status);
    state.replies.push({ text: plan([["password", "password"]], "sign-in", "submit") });
    const second = await generate(device, passwordPage, {
      recipeId: first.change.recipeId,
      revision: first.change.revision,
    });
    if (second.status !== "recipe") throw new Error(second.status);
    const { recipeId, revision } = second.change;
    // The continuation keeps the start page's route.
    expect(route(second.change.recipe).passkey).toEqual({
      path: "/login",
      target: passkeyButton.target,
    });
    const rejected = JSON.stringify({ result: { decision: "rejected" } });
    state.replies.push({ text: rejected });
    expect(await judge(device, recipeId, revision, homePage)).toEqual({
      version: 1,
      status: "rejected",
    });
    state.replies.push({ text: rejected });
    const elsewhere = observation("/elsewhere", [element("help", "link", "Help")]);
    expect((await complete(device, recipeId, revision, elsewhere)).body).toEqual({
      version: 1,
      status: "rejected",
    });
    const logged = await rows(
      "SELECT request FROM inference_log WHERE owner_id = ? AND role = 'judge' ORDER BY path",
      device.ownerId,
    );
    expect(logged.map((row) => JSON.parse(String(row.request)))).toMatchObject([
      // `/elsewhere`, on the password route
      { route: "password", loginPaths: ["/login", "/password"] },
      // `/home`, on the passkey route
      { route: "passkey", loginPaths: ["/login", "/password"] },
    ]);
  });
}
