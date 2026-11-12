import { type SemanticSlot } from "@pateat/contracts";
import { env } from "cloudflare:workers";
import { completionInstructions, generationInstructions } from "@pateat/inference";
import { expect, it, vi } from "vitest";
import { generatedRecipeId } from "@pateat/generation";
import type { GenerationContext, Device } from "./context";

export function registerWithoutModel(context: GenerationContext) {
  const {
    ORIGIN,
    DAY_MS,
    slots,
    emailPage,
    passwordPage,
    homePage,
    bigPage,
    holdSlots,
    owner,
    layoutKey,
    post,
    generate,
    complete,
    rows,
    day,
    hashOf,
    twoPageRecipe,
    state,
  } = context;

  /** Each column of the owner's rows answered without a call, oldest first. */
  const unsentRows = async (ownerId: string) =>
    (
      await rows(
        "SELECT role, provider, model_id, outcome, origin, path, recipe_id, branch, base_revision, revision, recipe_page, build, observation_hash, request, result, answer, input_tokens, output_tokens, cost_micro_usd FROM inference_log WHERE owner_id = ? AND model_id IS NULL ORDER BY created_at",
        ownerId,
      )
    ).map((row) => ({ ...row, request: JSON.parse(String(row.request)) as unknown }));
  const unsent = {
    provider: null,
    model_id: null,
    revision: null,
    build: "test-revision",
    result: null,
    answer: null,
    input_tokens: null,
    output_tokens: null,
    cost_micro_usd: 0,
  };

  it("logs a page refused at the daily spend limit, which the limit does not count", async () => {
    const device = await owner();
    await env.DB.prepare(
      "INSERT INTO inference_spend (owner_id, period, calls, cost_micro_usd) VALUES (?, ?, 1, ?)",
    )
      .bind(device.ownerId, day(), 5_000_000)
      .run();
    expect(await generate(device, emailPage)).toEqual({
      version: 1,
      status: "unavailable",
      reason: "daily-limit",
    });
    expect(state.sent).toEqual([]);
    expect(await unsentRows(device.ownerId)).toEqual([
      {
        ...unsent,
        role: "generate",
        outcome: "daily-limit",
        origin: ORIGIN,
        path: "/login",
        recipe_id: await generatedRecipeId(ORIGIN, "/login"),
        branch: "",
        base_revision: 0,
        recipe_page: "first",
        observation_hash: await hashOf(emailPage),
        request: {
          instructions: generationInstructions,
          slots,
          signedIn: false,
          observation: emailPage,
        },
      },
    ]);
    expect(
      await rows("SELECT COUNT(*) AS count FROM inference_log WHERE owner_id = ?", device.ownerId),
    ).toEqual([{ count: 1 }]);
    // Neither the spend nor the number of calls changes.
    expect(
      await rows(
        "SELECT period, calls, cost_micro_usd FROM inference_spend WHERE owner_id = ?",
        device.ownerId,
      ),
    ).toEqual([{ period: day(), calls: 1, cost_micro_usd: 5_000_000 }]);
  });

  it("logs a busy refusal once per page in ten minutes", async () => {
    const device = await owner();
    await holdSlots(device.ownerId);
    const busy = { version: 1, status: "unavailable", reason: "busy" };
    // A client repeating the page adds no row; another page does.
    expect(await generate(device, emailPage)).toEqual(busy);
    expect(await generate(device, emailPage)).toEqual(busy);
    expect(await generate(device, passwordPage)).toEqual(busy);
    expect(
      (await unsentRows(device.ownerId)).map(({ outcome, path }) => ({ outcome, path })),
    ).toEqual([
      { outcome: "busy", path: "/login" },
      { outcome: "busy", path: "/password" },
    ]);
    await env.DB.prepare("UPDATE inference_log SET created_at = ? WHERE owner_id = ?")
      .bind(Date.now() - 10 * 60 * 1000 - 1, device.ownerId)
      .run();
    expect(await generate(device, emailPage)).toEqual(busy);
    expect(await unsentRows(device.ownerId)).toHaveLength(3);
    expect(state.sent).toEqual([]);
    expect(await rows("SELECT * FROM inference_spend WHERE owner_id = ?", device.ownerId)).toEqual(
      [],
    );
    // The other requests' slots stay.
    expect(
      await rows("SELECT lock_id FROM inference_locks WHERE owner_id = ?", device.ownerId),
    ).toEqual(Array(5).fill({ lock_id: "other" }));
  });

  it("logs a page judged before, with the login paths the judge would have got", async () => {
    const device = await owner();
    const change = await twoPageRecipe(device);
    state.replies.push({ text: JSON.stringify({ result: { decision: "rejected" } }) });
    expect((await complete(device, change.recipeId, 2)).body).toEqual({
      version: 1,
      status: "rejected",
    });
    expect((await complete(device, change.recipeId, 2)).body).toEqual({
      version: 1,
      status: "unavailable",
      reason: "judged-rejected",
    });
    expect(state.sent).toHaveLength(3);
    const [called] = await rows(
      "SELECT request FROM inference_log WHERE owner_id = ? AND role = 'judge' AND model_id IS NOT NULL",
      device.ownerId,
    );
    const request = {
      instructions: completionInstructions,
      recipeId: change.recipeId,
      route: "password",
      loginPaths: ["/login", "/password"],
      slots: [],
      observation: homePage,
    };
    expect(JSON.parse(String(called!.request))).toEqual(request);
    expect(await unsentRows(device.ownerId)).toEqual([
      {
        ...unsent,
        role: "judge",
        outcome: "judged-rejected",
        origin: ORIGIN,
        path: "/home",
        recipe_id: change.recipeId,
        branch: await layoutKey(device.ownerId, change.recipeId),
        base_revision: 2,
        recipe_page: null,
        observation_hash: await hashOf(homePage),
        request,
      },
    ]);
  });

  it("logs no request whose body or recipe the route refuses", async () => {
    const device = await owner();
    const invalid = await post(device, "/v1/recipes/generate", {
      version: 1,
      observation: { ...emailPage, version: 2 },
      slots,
    });
    expect(invalid.status).toBe(400);
    // Only a recipe's first page that lists no accounts carries the signedIn hint (ADR 0035).
    for (const body of [
      {
        version: 1,
        observation: emailPage,
        slots,
        base: { recipeId: "gen-1", revision: 1 },
        signedIn: false,
      },
      {
        version: 1,
        observation: { ...emailPage, accounts: ["[email]"] },
        slots: [],
        signedIn: true,
      },
      // A list of accounts carries no slot or value shape (owner 2026-10-23 11:48 UTC).
      ...[
        slots,
        [
          {
            id: "username",
            kind: "identifier",
            description: "account username",
            valueShape: { length: 8, classes: ["ascii-letter"], email: false },
          },
        ],
        [{ id: "custom-1", kind: "identifier", description: "vault field", fieldName: "Branch" }],
      ].map((offered) => ({
        version: 1,
        observation: { ...emailPage, accounts: ["[email]"] },
        slots: offered,
      })),
    ])
      // oxlint-disable-next-line no-await-in-loop -- Each body is refused on its own.
      expect((await post(device, "/v1/recipes/generate", body)).status).toBe(400);
    const unknownRoute = await post(
      device,
      `/v1/recipes/${await generatedRecipeId(ORIGIN, "/login")}/completion`,
      {
        version: 1,
        slots: [],
        revision: 1,
        route: "sso",
        observation: homePage,
      },
    );
    expect(unknownRoute.status).toBe(400);
    expect((await complete(device, await generatedRecipeId(ORIGIN, "/login"), 1)).status).toBe(404);
    expect(await rows("SELECT * FROM inference_log WHERE owner_id = ?", device.ownerId)).toEqual(
      [],
    );
  });

  it("answers the same when the row cannot be written", async () => {
    const device = await owner();
    await holdSlots(device.ownerId);
    const prepare = env.DB.prepare.bind(env.DB);
    const insert = vi.spyOn(env.DB, "prepare").mockImplementation((query) => {
      if (/^insert into "inference_log"/iu.test(query))
        throw new Error("synthetic private log values");
      return prepare(query);
    });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      expect(await generate(device, emailPage)).toEqual({
        version: 1,
        status: "unavailable",
        reason: "busy",
      });
      expect(insert).toHaveBeenCalledWith(expect.stringMatching(/^insert into "inference_log"/iu));
      expect(warn.mock.calls).toEqual([
        ["Inference log row not kept", { role: "generate", outcome: "busy" }],
      ]);
    } finally {
      insert.mockRestore();
      warn.mockRestore();
    }
    expect(await rows("SELECT * FROM inference_log WHERE owner_id = ?", device.ownerId)).toEqual(
      [],
    );
  });

  it("logs the same page offered with other slots again", async () => {
    const device = await owner();
    await holdSlots(device.ownerId);
    const otherSlots: SemanticSlot[] = [
      ...slots,
      { id: "member", kind: "identifier", description: "membership number" },
    ];
    expect(await generate(device, emailPage)).toMatchObject({ reason: "busy" });
    const response = await post(device, "/v1/recipes/generate", {
      version: 1,
      observation: emailPage,
      slots: otherSlots,
      signedIn: false,
    });
    expect(await response.json()).toMatchObject({ reason: "busy" });
    expect((await unsentRows(device.ownerId)).map((row) => row.request)).toEqual([
      { instructions: generationInstructions, slots, signedIn: false, observation: emailPage },
      {
        instructions: generationInstructions,
        slots: otherSlots,
        signedIn: false,
        observation: emailPage,
      },
    ]);
  });

  it("logs at most 500 requests answered without a call per owner and UTC day", async () => {
    const device = await owner();
    await holdSlots(device.ownerId);
    const now = Date.now();
    const insert = (id: string, at: number, modelId: string | null, outcome = "busy") =>
      env.DB.prepare(
        "INSERT INTO inference_log (id, owner_id, role, provider, model_id, origin, path, request, outcome, cost_micro_usd, created_at) VALUES (?, ?, 'generate', NULL, ?, ?, '/', '{}', ?, 0, ?)",
      ).bind(id, device.ownerId, modelId, ORIGIN, outcome, at);
    // 499 of today count; yesterday's, a model call's and signed-in page samples
    // (ADR 0029) do not.
    await env.DB.batch([
      ...Array.from({ length: 499 }, (_, index) => insert(`today-${index}`, now - 1, null)),
      insert("yesterday", now - (now % DAY_MS) - 1, null),
      insert("called", now - 1, "claude-opus-5-5"),
      ...Array.from({ length: 3 }, (_, index) =>
        insert(`sampled-${index}`, now - 1, null, "sampled"),
      ),
    ]);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      expect(await generate(device, emailPage)).toMatchObject({ reason: "busy" });
      expect(warn).not.toHaveBeenCalled();
      // The 501st row of the day is not written, and the answer stays the same.
      expect(await generate(device, passwordPage)).toEqual({
        version: 1,
        status: "unavailable",
        reason: "busy",
      });
      expect(warn.mock.calls).toEqual([
        ["Inference log row over the daily cap", { role: "generate", outcome: "busy" }],
      ]);
    } finally {
      warn.mockRestore();
    }
    expect(
      await rows(
        "SELECT path FROM inference_log WHERE owner_id = ? AND model_id IS NULL AND path != '/'",
        device.ownerId,
      ),
    ).toEqual([{ path: "/login" }]);
  });

  it.each([
    {
      outcome: "recently-tried",
      role: "generate",
      ask: async (device: Device) => {
        state.replies.push({
          text: JSON.stringify({ result: { decision: "abstain", reason: "ambiguous" } }),
        });
        await generate(device, emailPage);
        return generate(device, emailPage);
      },
    },
    {
      outcome: "incomplete-observation",
      role: "generate",
      ask: (device: Device) => generate(device, { ...emailPage, complete: false }),
    },
    {
      outcome: "credentials-not-configured",
      role: "generate",
      claude: false,
      ask: (device: Device) => generate(device, emailPage),
    },
    {
      outcome: "judgement-limit",
      role: "judge",
      ask: async (device: Device) => {
        const change = await twoPageRecipe(device);
        const now = Date.now();
        const dayStart = now - (now % DAY_MS);
        await env.DB.batch(
          Array.from({ length: 20 }, (_, index) =>
            env.DB.prepare(
              `INSERT INTO judgement_reservations
                (owner_id, id, device_id, recipe_id, branch, revision, origin, path, prompt_version, fingerprint, started_at, day, state)
                VALUES (?, ?, ?, ?, '', 1, ?, ?, '', 'synthetic', ?, ?, 'finished')`,
            ).bind(
              device.ownerId,
              crypto.randomUUID(),
              device.deviceId,
              change.recipeId,
              ORIGIN,
              `/p${index}`,
              dayStart + index,
              dayStart,
            ),
          ),
        );
        return (await complete(device, change.recipeId, 2)).body;
      },
    },
    {
      outcome: "input-too-large",
      role: "judge",
      ask: async (device: Device) => {
        const change = await twoPageRecipe(device);
        return (await complete(device, change.recipeId, 2, bigPage())).body;
      },
    },
  ])("logs one row for $outcome", async ({ outcome, role, claude, ask }) => {
    const device = await owner({ claude: claude ?? true });
    const calls = state.sent.length;
    const answer = await ask(device);
    expect(answer).toMatchObject(
      outcome === "incomplete-observation" || outcome === "input-too-large"
        ? { status: "failed", error: outcome }
        : { status: "unavailable", reason: outcome },
    );
    const unsentOfRole = (await unsentRows(device.ownerId)).filter((row) => row.role === role);
    expect(unsentOfRole).toMatchObject([{ ...unsent, outcome }]);
    // Only the calls the case itself made reached the model.
    expect(state.sent.length - calls).toBe(
      (
        await rows(
          "SELECT id FROM inference_log WHERE owner_id = ? AND model_id IS NOT NULL",
          device.ownerId,
        )
      ).length,
    );
  });
}
