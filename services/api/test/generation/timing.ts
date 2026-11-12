import { type LoginObservation } from "@pateat/contracts";
import { env, exports } from "cloudflare:workers";
import { expect, it, vi } from "vitest";
import type { GenerationContext, Device } from "./context";

export function registerTiming(context: GenerationContext) {
  const {
    slots,
    emailPage,
    homePage,
    plan,
    owner,
    post,
    generate,
    serverTiming,
    rows,
    failLogUpdate,
    logRows,
    twoPageRecipe,
    state,
  } = context;

  const timingRows = (ownerId: string, role: string) =>
    rows(
      "SELECT id, outcome, pre_model_ms, token_ms, model_ms, server_ms FROM inference_log WHERE owner_id = ? AND role = ? ORDER BY created_at",
      ownerId,
      role,
    );
  /** The rows once every response's server time update has run. */
  const settledRows = (ownerId: string, role: string) =>
    vi.waitFor(async () => {
      const found = await timingRows(ownerId, role);
      expect(found.every((row) => row["server_ms"] !== null)).toBe(true);
      return found;
    });
  const slowModel = () => {
    state.during = () => new Promise((resolve) => setTimeout(resolve, 40));
  };
  const generateResponse = (device: Device, page: LoginObservation) =>
    post(device, "/v1/recipes/generate", { version: 1, observation: page, slots, signedIn: false });

  it("logs and reports each call's times, for ok, abstained and failed calls", async () => {
    const device = await owner();
    state.tokenDelayMs = 40;
    const answers: unknown[] = [];
    const timings: Record<string, number | undefined>[] = [];
    state.replies.push(
      { text: plan([["email", "email"]], "next", "advance") },
      { text: JSON.stringify({ result: { decision: "abstain", reason: "ambiguous" } }) },
      500,
    );
    for (const path of ["/login", "/other", "/third"]) {
      slowModel();
      // eslint-disable-next-line no-await-in-loop
      const response = await generateResponse(device, { ...emailPage, path });
      expect(response.status).toBe(200);
      // eslint-disable-next-line no-await-in-loop
      answers.push(((await response.json()) as { status: string }).status);
      timings.push(serverTiming(response));
    }
    expect(answers).toEqual(["recipe", "abstained", "failed"]);
    const logged = await settledRows(device.ownerId, "generate");
    expect(logged.map((row) => row["outcome"])).toEqual(["ok", "abstained", "provider-error"]);
    for (const [index, row] of logged.entries()) {
      const {
        pre_model_ms: preModel,
        token_ms: token,
        model_ms: model,
        server_ms: server,
      } = row as Record<"pre_model_ms" | "token_ms" | "model_ms" | "server_ms", number>;
      expect(token).toBeGreaterThanOrEqual(30);
      expect(preModel).toBeGreaterThanOrEqual(token);
      expect(model).toBeGreaterThanOrEqual(30);
      expect(server).toBeGreaterThanOrEqual(preModel + model);
      // The response reports the same call; `total` also covers the request's own work.
      expect(timings[index]).toMatchObject({ token, model });
      expect(timings[index]?.["total"]).toBeGreaterThanOrEqual(token + model);
    }
  });

  it("keeps the server time of a judgement that wrote no recipe", async () => {
    const device = await owner();
    const change = await twoPageRecipe(device);
    state.replies.push({ text: JSON.stringify({ result: { decision: "unclear" } }) });
    slowModel();
    const response = await post(device, `/v1/recipes/${change.recipeId}/completion`, {
      version: 1,
      slots: [],
      revision: 2,
      route: "password",
      observation: homePage,
    });
    expect(await response.json()).toEqual({ version: 1, status: "unclear" });
    expect(serverTiming(response)).toMatchObject({
      total: expect.any(Number),
      token: expect.any(Number),
      model: expect.any(Number),
    });
    const [row] = await settledRows(device.ownerId, "judge");
    expect(row).toMatchObject({ outcome: "abstained", model_ms: expect.any(Number) });
    expect(row?.["model_ms"]).toBeGreaterThanOrEqual(30);
    expect(row?.["server_ms"]).toBeGreaterThanOrEqual(Number(row?.["model_ms"]));
  });

  it("updates the server time on the owner's own row only", async () => {
    const device = await owner();
    const prepare = env.DB.prepare.bind(env.DB);
    const updates: { query: string; values: unknown[] }[] = [];
    const spy = vi.spyOn(env.DB, "prepare").mockImplementation((query) => {
      const statement = prepare(query);
      if (!query.toLowerCase().startsWith('update "inference_log" set "server_ms"'))
        return statement;
      const bind = statement.bind.bind(statement);
      statement.bind = (...values: unknown[]) => {
        updates.push({ query, values });
        return bind(...values);
      };
      return statement;
    });
    try {
      state.replies.push({ text: plan([["email", "email"]], "next", "advance") });
      expect(await generate(device, emailPage)).toMatchObject({ status: "recipe" });
      await settledRows(device.ownerId, "generate");
    } finally {
      spy.mockRestore();
    }
    const [row] = await timingRows(device.ownerId, "generate");
    expect(updates).toEqual([
      {
        query: expect.stringMatching(
          /where \("inference_log"\."id" = \? and "inference_log"\."owner_id" = \?\)$/u,
        ),
        values: [row?.["server_ms"], row?.["id"], device.ownerId],
      },
    ]);
  });

  it("answers in full when the server time update fails", async () => {
    const device = await owner();
    const update = failLogUpdate("server_ms");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      state.replies.push({ text: plan([["email", "email"]], "next", "advance") });
      const response = await generateResponse(device, emailPage);
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({ status: "recipe", change: { revision: 1 } });
      await vi.waitFor(() =>
        expect(warn.mock.calls).toEqual([["Inference log server time not kept"]]),
      );
    } finally {
      update.mockRestore();
      warn.mockRestore();
    }
    expect(await logRows(device.ownerId)).toMatchObject([{ revision: 1 }]);
    expect(await timingRows(device.ownerId, "generate")).toMatchObject([
      { outcome: "ok", model_ms: expect.any(Number), server_ms: null },
    ]);
  });

  it("reports the total of every device response, and the token time of a credential refusal", async () => {
    const device = await owner();
    const feed = await exports.default.fetch("https://pateat.invalid/v1/recipes", {
      headers: { Authorization: `Bearer ${device.token}` },
    });
    expect(feed.status).toBe(200);
    expect(Object.keys(serverTiming(feed))).toEqual(["total"]);
    const unauthenticated = await exports.default.fetch("https://pateat.invalid/v1/recipes");
    expect(unauthenticated.status).toBe(401);
    expect(Object.keys(serverTiming(unauthenticated))).toEqual(["total"]);
    expect(unauthenticated.headers.get("Timing-Allow-Origin")).toBeNull();

    state.tokenStatus = 503;
    const failed = await generateResponse(device, emailPage);
    expect(await failed.json()).toMatchObject({ reason: "token-exchange-failed" });
    expect(Object.keys(serverTiming(failed)).sort()).toEqual(["token", "total"]);
    // A missing credential is refused at the same step, without a model request.
    const unconfigured = await generateResponse(await owner({ claude: false }), emailPage);
    expect(await unconfigured.json()).toMatchObject({ reason: "credentials-not-configured" });
    expect(Object.keys(serverTiming(unconfigured)).sort()).toEqual(["token", "total"]);
  });

  it("keeps the server time of a request answered without a model call, and no call times", async () => {
    const device = await owner();
    // Refused by the credential step inside the call, and by the route before any call.
    state.tokenStatus = 503;
    const failed = await generateResponse(device, emailPage);
    expect(await failed.json()).toMatchObject({ reason: "token-exchange-failed" });
    const incomplete = await generateResponse(device, {
      ...emailPage,
      path: "/other",
      complete: false,
    });
    expect(await incomplete.json()).toMatchObject({ error: "incomplete-observation" });
    expect(Object.keys(serverTiming(incomplete))).toEqual(["total"]);
    const logged = await settledRows(device.ownerId, "generate");
    expect(logged).toEqual([
      expect.objectContaining({
        outcome: "token-exchange-failed",
        pre_model_ms: null,
        token_ms: null,
        model_ms: null,
        server_ms: expect.any(Number),
      }),
      expect.objectContaining({
        outcome: "incomplete-observation",
        pre_model_ms: null,
        token_ms: null,
        model_ms: null,
        server_ms: expect.any(Number),
      }),
    ]);
  });
}
