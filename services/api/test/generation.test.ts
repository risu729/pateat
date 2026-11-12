import {
  isLoginRouteRecipe,
  storedLayoutRecipe,
  toLoginLayout,
  type LoginObservation,
  type LoginRecipe,
  type ObservedCandidate,
  type RecipeCompletionResult,
  type RecipeGenerationResult,
  type SemanticSlot,
  type StoredLoginRecipe,
} from "@pateat/contracts";
import { env, exports } from "cloudflare:workers";
import { afterAll, beforeAll, beforeEach, describe, expect, vi } from "vitest";
import { createDeviceToken, hashDeviceToken } from "../src/auth";
import { saveWifCredential } from "../src/claude/credentials";
import type { GenerationContext, GenerationState } from "./generation/context";
import { registerRecipeGeneration1 } from "./generation/recipe-generation-1";
import { registerRecipeGeneration2 } from "./generation/recipe-generation-2";
import { registerRecipeGeneration3 } from "./generation/recipe-generation-3";
import { registerCustomFields } from "./generation/custom-fields";
import { registerSavedSlotNames } from "./generation/saved-slot-names";
import { registerCompletion } from "./generation/completion";
import { registerPageJudgement1 } from "./generation/page-judgement-1";
import { registerPageJudgement2 } from "./generation/page-judgement-2";
import { registerPageJudgement3 } from "./generation/page-judgement-3";
import { registerPageJudgement4 } from "./generation/page-judgement-4";
import { registerPasswordVariants } from "./generation/password-variants";
import { registerPasskeyRoute } from "./generation/passkey-route";
import { registerChooserBranches } from "./generation/chooser-branches";
import { registerEntryPages } from "./generation/entry-pages";
import { registerWithoutModel } from "./generation/without-model";
import { registerTiming } from "./generation/timing";
import { registerPageSamples } from "./generation/page-samples";
import { registerPasskeyOnly } from "./generation/passkey-only";
import { registerLayouts } from "./generation/layouts";
import { registerRepair } from "./generation/repair";
import { registerProvenance } from "./generation/provenance";
import { registerPopupRetries } from "./generation/popup-retries";
import { registerSso } from "./generation/sso";

// Synthetic owners, devices, federation identifiers and pages only. Anthropic's token
// endpoint and the Messages API are answered locally; no request leaves the test.

const TOKEN_URL = "https://api.anthropic.com/v1/oauth/token";
const MESSAGES_URL = "https://api.anthropic.com/v1/messages";
const ORIGIN = "https://shop.example.test";
const DAY_MS = 24 * 60 * 60 * 1000;
const WORST_CASE = 64 * 1024 * 4 + 1_024 * 20;

const slots: SemanticSlot[] = [
  { id: "email", kind: "identifier", description: "account email address" },
  { id: "password", kind: "secret", description: "account password" },
];
const element = (id: string, role: ObservedCandidate["role"], label: string) => ({
  id,
  role,
  target: { by: "id" as const, value: id },
  label,
});
const observation = (
  path: string,
  candidates: ObservedCandidate[],
  origin = ORIGIN,
): LoginObservation => ({
  version: 1,
  origin,
  path,
  language: "en",
  complete: true,
  candidates,
});
const emailPage = observation("/login", [
  element("email", "email", "Email"),
  element("next", "button", "Next"),
]);
const passwordPage = observation("/password", [
  element("password", "password", "Password"),
  element("sign-in", "button", "Sign in"),
]);
const homePage = observation("/home", [
  element("logout", "button", "Sign out"),
  element("help", "link", "Help"),
]);

/**
 * A page with every field at its bound: a request for it fits the route's 128 KiB body
 * limit but not a role's 64 KiB input bound.
 */
const WIDE = "\u3042".repeat(120);
const bigPage = (): LoginObservation => ({
  ...observation("/" + "a".repeat(200), [
    {
      id: "p".repeat(64),
      role: "password",
      target: { by: "name", value: "n".repeat(120) },
      label: WIDE,
      placeholder: WIDE,
      autocomplete: "current-password",
      group: "g".repeat(64),
      maxLength: 1024,
      minLength: 1000,
      inputMode: "text",
    },
    ...Array.from({ length: 47 }, (_, index) => ({
      id: `${"b".repeat(60)}${String(index).padStart(4, "0")}`,
      role: "button" as const,
      target: { by: "text" as const, value: `${"\u3044".repeat(116)}${index}` },
      label: WIDE,
      placeholder: WIDE,
      group: "g".repeat(64),
    })),
  ]),
  title: WIDE,
  headings: Array.from({ length: 8 }, () => WIDE),
});

/**
 * A stored recipe's newest layout as the route recipe a login runs (ADR 0060), as every
 * form page's answer has.
 */
const route = (recipe: StoredLoginRecipe | LoginRecipe): LoginRecipe => {
  if ("steps" in recipe) return recipe;
  const layout = storedLayoutRecipe(recipe);
  if (!layout || !isLoginRouteRecipe(layout)) throw new Error("Expected a route recipe");
  return layout;
};
const plan = (fields: [string, string][], action: string, purpose: "advance" | "submit") =>
  JSON.stringify({
    result: {
      decision: "plan",
      pageKind: "sign-in",
      irreversible: "no",
      fields: fields.map(([slot, candidate]) => ({ slot, candidate })),
      action: { candidate: action, purpose },
    },
  });

type Usage = { input_tokens: number; output_tokens: number };
/** A text answer, a refusal with its category, or an HTTP error status. */
type Reply = { text: string; usage?: Usage } | { refusal: string; usage?: Usage } | number;
let replies: Reply[] = [];
/** Runs while a model call is in flight, before its answer. */
let during: (() => Promise<void>) | undefined;
/** While set, every model call waits for it before its answer. */
let held: Promise<void> | undefined;
let tokenStatus = 200;
/** How long the synthetic token exchange takes. */
let tokenDelayMs = 0;
/** Runs on each token exchange before its answer. */
let tokenHook: (() => Promise<void>) | undefined;
let sent: { authorization: string | null; apiKey: string | null; body: unknown }[] = [];
const originalFetch = globalThis.fetch;

beforeAll(() => {
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const outbound = new Request(input, init);
    if (outbound.url === TOKEN_URL && tokenDelayMs > 0)
      await new Promise((resolve) => setTimeout(resolve, tokenDelayMs));
    if (outbound.url === TOKEN_URL) await tokenHook?.();
    if (outbound.url === TOKEN_URL && tokenStatus !== 200)
      return Response.json({ error: "synthetic" }, { status: tokenStatus });
    if (outbound.url === TOKEN_URL)
      return Response.json({
        access_token: "synthetic-access-token",
        token_type: "Bearer",
        expires_in: 600,
      });
    if (outbound.url === MESSAGES_URL) {
      const body = (await outbound.json()) as { model: string };
      sent.push({
        authorization: outbound.headers.get("authorization"),
        apiKey: outbound.headers.get("x-api-key"),
        body,
      });
      const reply = replies.shift();
      if (reply === undefined) throw new Error("No synthetic reply queued");
      const hook = during;
      during = undefined;
      await hook?.();
      await held;
      if (typeof reply === "number")
        return Response.json(
          { type: "error", error: { type: "api_error", message: "synthetic" } },
          { status: reply },
        );
      return Response.json({
        id: "msg_synthetic",
        type: "message",
        role: "assistant",
        model: body.model,
        ...("refusal" in reply
          ? {
              content: [],
              stop_reason: "refusal",
              stop_details: { type: "refusal", category: reply.refusal, explanation: "synthetic" },
            }
          : { content: [{ type: "text", text: reply.text }], stop_reason: "end_turn" }),
        stop_sequence: null,
        usage: reply.usage ?? { input_tokens: 3_000, output_tokens: 900 },
      });
    }
    return originalFetch(input, init);
  });
});

afterAll(() => {
  vi.restoreAllMocks();
});

beforeEach(() => {
  replies = [];
  sent = [];
  during = undefined;
  held = undefined;
  tokenStatus = 200;
  tokenDelayMs = 0;
  tokenHook = undefined;
});

type Device = { ownerId: string; deviceId: string; token: string };

/** The owner's call slots (ADR 0018), held by another request for the next minute. */
const holdSlots = (ownerId: string, taken = [0, 1, 2, 3, 4]) =>
  env.DB.batch(
    taken.map((slot) =>
      env.DB.prepare(
        "INSERT INTO inference_locks (owner_id, slot, lock_id, expires_at) VALUES (?, ?, 'other', ?)",
      ).bind(ownerId, slot, Date.now() + 60_000),
    ),
  );

async function owner({ claude = true } = {}): Promise<Device> {
  const ownerId = crypto.randomUUID();
  const deviceId = `device-${crypto.randomUUID()}`;
  const token = createDeviceToken();
  await env.DB.batch([
    env.DB.prepare("INSERT INTO owners (id, created_at) VALUES (?, ?)").bind(ownerId, Date.now()),
    env.DB.prepare("INSERT INTO profiles (owner_id, id, name) VALUES (?, ?, 'Default')").bind(
      ownerId,
      ownerId,
    ),
    env.DB.prepare(
      "INSERT INTO devices (id, owner_id, profile_id, token_hash, created_at, last_used_at) VALUES (?, ?, ?, ?, ?, ?)",
    ).bind(deviceId, ownerId, ownerId, await hashDeviceToken(token), Date.now(), Date.now()),
  ]);
  if (claude)
    await saveWifCredential(env.DB, ownerId, {
      federationRuleId: "fdrl_01SyntheticRule",
      organizationId: "00000000-0000-4000-8000-000000000000",
      serviceAccountId: "svac_01SyntheticAccount",
      workspaceId: "wrkspc_01SyntheticWorkspace",
    });
  return { ownerId, deviceId, token };
}

/**
 * The key of the newest layout (ADR 0060) of the owner's recipe head, or `undefined`
 * without one. Generation writes one layout, keyed by when it was made.
 */
async function layoutKey(ownerId: string, recipeId: string): Promise<string | undefined> {
  const key = await env.DB.prepare(
    `SELECT COALESCE(json_extract(r.document, '$.layouts[#-1].key'),
        json_extract(r.document, '$.chooser.layouts[#-1].key')) AS key
      FROM recipe_heads h JOIN recipe_revisions r
        ON r.owner_id = h.owner_id AND r.recipe_id = h.recipe_id AND r.revision = h.revision
      WHERE h.owner_id = ? AND h.recipe_id = ?`,
  )
    .bind(ownerId, recipeId)
    .first<string | null>("key");
  return key ?? undefined;
}
/** The branch name of the recipe's newest layout and a chooser branch, if any (ADR 0060). */
async function branchOf(ownerId: string, recipeId: string, side?: "account" | "other") {
  const key = (await layoutKey(ownerId, recipeId)) ?? "0";
  return side ? `${key}:${side}` : key;
}

/**
 * A device request. A request about a recipe's layout names it as the device does (ADR
 * 0060): these tests leave that to here, which names the head's newest layout, after it
 * the chooser branch a test names as `account` or `other`. `raw` sends the body as it is.
 */
async function post(device: Device, path: string, body: unknown, method = "POST", raw = false) {
  let payload = body;
  const named = /^\/v1\/recipes\/([^/]+)\/(?:completion|page-sample)$/u.exec(path)?.[1];
  const request = body as { base?: { recipeId?: unknown }; branch?: unknown } | undefined;
  const recipeId =
    path === "/v1/recipes/generate" && typeof request?.base?.recipeId === "string"
      ? request.base.recipeId
      : named === undefined
        ? undefined
        : decodeURIComponent(named);
  if (!raw && recipeId !== undefined && typeof body === "object" && body !== null) {
    const branch = request?.branch;
    if (branch === undefined || branch === "account" || branch === "other")
      payload = {
        ...body,
        branch: await branchOf(device.ownerId, recipeId, branch as "account" | "other" | undefined),
      };
  }
  return exports.default.fetch(`https://pateat.invalid${path}`, {
    method,
    headers: { Authorization: `Bearer ${device.token}`, "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
}

/** The owner's stored head document of a recipe, as the service keeps it. */
async function storedHead(ownerId: string, recipeId: string): Promise<unknown> {
  const document = await env.DB.prepare(
    `SELECT r.document FROM recipe_heads h JOIN recipe_revisions r
      ON r.owner_id = h.owner_id AND r.recipe_id = h.recipe_id AND r.revision = h.revision
      WHERE h.owner_id = ? AND h.recipe_id = ?`,
  )
    .bind(ownerId, recipeId)
    .first<string>("document");
  return document === null ? null : JSON.parse(document);
}

/** A route recipe stored back as a recipe document with that one layout (ADR 0060). */
const documentOf = (recipe: LoginRecipe): StoredLoginRecipe => ({
  version: 1,
  id: recipe.id,
  revision: recipe.revision,
  origin: recipe.origin,
  layouts: [toLoginLayout(recipe, { key: recipe.layout ?? "1000", createdAt: 1000 })],
});

/**
 * An answer with its recipe as the login runs it: the newest layout of a stored login or
 * chooser recipe (ADR 0060), which the tests below describe; an entry recipe as it is.
 */
function projected<Answer>(answer: Answer): Answer {
  const change = (answer as { change?: { recipe?: StoredLoginRecipe } } | null)?.change;
  const recipe = change?.recipe && storedLayoutRecipe(change.recipe);
  return recipe ? ({ ...answer, change: { ...change, recipe } } as Answer) : answer;
}

async function generate(device: Device, page: LoginObservation, base?: unknown) {
  const response = await post(device, "/v1/recipes/generate", {
    version: 1,
    observation: page,
    // A list of accounts is sent without slots (ADR 0028, owner 2026-10-23 11:48 UTC).
    slots: page.accounts === undefined ? slots : [],
    // A first page that lists no accounts carries the signedIn hint (ADR 0035).
    ...(base === undefined ? (page.accounts === undefined ? { signedIn: false } : {}) : { base }),
  });
  expect(response.status).toBe(200);
  return projected((await response.json()) as RecipeGenerationResult);
}

async function complete(
  device: Device,
  recipeId: string,
  revision: number,
  page = homePage,
  partial?: true,
) {
  const response = await post(device, `/v1/recipes/${recipeId}/completion`, {
    version: 1,
    slots: [],
    revision,
    route: "password",
    observation: page,
    ...(partial ? { partial } : {}),
  });
  return {
    status: response.status,
    body: projected((await response.json()) as RecipeCompletionResult | { error: string }),
  };
}

/** Each `Server-Timing` metric's duration by name; Cloudflare may add its own entries. */
function serverTiming(response: Response) {
  return Object.fromEntries(
    (response.headers.get("Server-Timing") ?? "").split(",").map((entry) => {
      const [name = "", ...params] = entry.trim().split(";");
      const duration = params.find((param) => param.startsWith("dur="));
      return [name, duration === undefined ? undefined : Number(duration.slice(4))];
    }),
  );
}

/** The columns the assertions read by name; other columns are compared whole. */
type Row = Record<string, unknown> &
  Partial<Record<"id" | "role" | "path" | "outcome" | "request" | "result", unknown>>;
const rows = (sql: string, ...values: unknown[]) =>
  env.DB.prepare(sql)
    .bind(...values)
    .all<Row>()
    .then((result) => result.results);
const month = () => new Date().toISOString().slice(0, 7);
const day = () => new Date().toISOString().slice(0, 10);

/** Only the retention delete fails; inserts, spend corrections and recipe reads use D1. */
function failLogPurge() {
  const prepare = env.DB.prepare.bind(env.DB);
  return vi.spyOn(env.DB, "prepare").mockImplementation((query) => {
    if (/^delete from "inference_log"/iu.test(query))
      throw new Error("synthetic private log values");
    return prepare(query);
  });
}

/** Only the request log's update of `column` fails; everything else uses D1. */
function failLogUpdate(column: "revision" | "server_ms") {
  const prepare = env.DB.prepare.bind(env.DB);
  return vi.spyOn(env.DB, "prepare").mockImplementation((query) => {
    if (query.toLowerCase().startsWith(`update "inference_log" set "${column}"`))
      throw new Error("synthetic private log values");
    return prepare(query);
  });
}

/** The request log columns that tie a row to its recipe (ADR 0012, owner 2026-10-18). */
const logRows = async (ownerId: string, role = "generate") =>
  (
    await rows(
      "SELECT recipe_id, branch, base_revision, revision, recipe_page, build, observation_hash, answer, request FROM inference_log WHERE owner_id = ? AND role = ? ORDER BY created_at",
      ownerId,
      role,
    )
  ).map(({ answer, request, ...row }) => ({
    ...(row as Record<
      "recipe_id" | "branch" | "base_revision" | "revision" | "recipe_page" | "build",
      unknown
    > & { observation_hash: unknown }),
    answer: answer === null ? null : (JSON.parse(String(answer)) as unknown),
    request: JSON.parse(String(request)) as { observation: unknown },
  }));
const hashOf = async (value: unknown) =>
  new Uint8Array(
    await crypto.subtle.digest("SHA-256", new TextEncoder().encode(JSON.stringify(value))),
  )
    .toHex()
    .slice(0, 12);

/** Generates the two-page recipe and returns its last change. */
async function twoPageRecipe(device: Device) {
  replies.push({ text: plan([["email", "email"]], "next", "advance") });
  const first = await generate(device, emailPage);
  if (first.status !== "recipe") throw new Error(first.status);
  replies.push({ text: plan([["password", "password"]], "sign-in", "submit") });
  const second = await generate(device, passwordPage, {
    recipeId: first.change.recipeId,
    revision: first.change.revision,
  });
  if (second.status !== "recipe") throw new Error(second.status);
  return second.change;
}

/** Eight offers, each naming a different vault field, at their bounds. */
const bigSlots = Array.from({ length: 8 }, (_, index) => ({
  id: `${"s".repeat(62)}${index}`,
  kind: "identifier" as const,
  description: WIDE,
  fieldName: `${"\u3042".repeat(119)}${index}`,
}));

const state: GenerationState = {
  get replies() {
    return replies;
  },
  set replies(value: GenerationState["replies"]) {
    replies = value;
  },
  get during() {
    return during;
  },
  set during(value: GenerationState["during"]) {
    during = value;
  },
  get held() {
    return held;
  },
  set held(value: GenerationState["held"]) {
    held = value;
  },
  get tokenStatus() {
    return tokenStatus;
  },
  set tokenStatus(value: GenerationState["tokenStatus"]) {
    tokenStatus = value;
  },
  get tokenDelayMs() {
    return tokenDelayMs;
  },
  set tokenDelayMs(value: GenerationState["tokenDelayMs"]) {
    tokenDelayMs = value;
  },
  get tokenHook() {
    return tokenHook;
  },
  set tokenHook(value: GenerationState["tokenHook"]) {
    tokenHook = value;
  },
  get sent() {
    return sent;
  },
  set sent(value: GenerationState["sent"]) {
    sent = value;
  },
};
const context = {
  ORIGIN,
  DAY_MS,
  WORST_CASE,
  slots,
  element,
  observation,
  emailPage,
  passwordPage,
  homePage,
  WIDE,
  bigPage,
  route,
  plan,
  holdSlots,
  owner,
  layoutKey,
  branchOf,
  post,
  storedHead,
  documentOf,
  projected,
  generate,
  complete,
  serverTiming,
  rows,
  month,
  day,
  failLogPurge,
  failLogUpdate,
  logRows,
  hashOf,
  twoPageRecipe,
  bigSlots,
  state,
} satisfies GenerationContext;

describe("recipe generation", () => {
  registerRecipeGeneration1(context);

  const choice = (model: string, effort: "low" | "medium", speed: "standard" | "fast") => ({
    provider: "anthropic" as const,
    model,
    effort,
    speed,
  });
  const asked = () =>
    sent.map(({ body }) => {
      const { model, speed, output_config } = body as {
        model: string;
        speed?: string;
        output_config?: { effort?: string };
      };
      return { model, effort: output_config?.effort, speed };
    });
  registerRecipeGeneration2({ ...context, choice, asked });
  registerRecipeGeneration3(context);
});

describe("custom-field slots (ADR 0027)", () => {
  registerCustomFields(context);
});

describe("slot names carried from the saved bindings (ADR 0027, 2026-10-19)", () => {
  registerSavedSlotNames(context);
});

describe("completion judgement", () => {
  registerCompletion(context);
});

describe("page judgement (ADR 0027)", () => {
  const judgeReply = (result: unknown) => ({ text: JSON.stringify({ result }) });
  const webauthnPage = observation("/login/webauthn", [
    element("key", "button", "Use security key"),
    element("recovery", "link", "Use a recovery code"),
  ]);
  // One clock read: the clock can tick between two, which gives the previous day's last
  // millisecond and lets the judgement purge delete a row seeded as today's.
  const dayStart = () => {
    const now = Date.now();
    return now - (now % DAY_MS);
  };
  const judgements = (device: Device) =>
    rows(
      "SELECT recipe_id, revision, path FROM page_judgements WHERE owner_id = ? ORDER BY recipe_id, revision, path",
      device.ownerId,
    );
  /** A judgement row; without a prompt version, as an earlier judge left it. */
  const seed = (
    device: Device,
    recipeId: string,
    revision: number,
    path: string,
    at: number,
    {
      promptVersion = "",
      verdict = null,
      inputs = null,
    }: { promptVersion?: string; verdict?: string | null; inputs?: string | null } = {},
  ) =>
    // A row of the layout the recipe's logins run (ADR 0060).
    layoutKey(device.ownerId, recipeId).then((branch) =>
      env.DB.prepare(
        "INSERT INTO page_judgements (owner_id, recipe_id, branch, revision, origin, path, prompt_version, judged_at, verdict, inputs) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      )
        .bind(
          device.ownerId,
          recipeId,
          branch ?? "",
          revision,
          ORIGIN,
          path,
          promptVersion,
          at,
          verdict,
          inputs,
        )
        .run(),
    );
  const seedUsage = async (
    device: Device,
    recipeId: string,
    revision: number,
    path: string,
    at: number,
  ) => {
    await seed(device, recipeId, revision, path, at);
    await env.DB.prepare(`INSERT INTO judgement_reservations
      (owner_id, id, device_id, recipe_id, branch, revision, origin, path, prompt_version,
       fingerprint, started_at, day, state)
      VALUES (?, ?, ?, ?, '', ?, ?, ?, '', 'synthetic', ?, ?, 'finished')`)
      .bind(
        device.ownerId,
        crypto.randomUUID(),
        device.deviceId,
        recipeId,
        revision,
        ORIGIN,
        path,
        at,
        at - (at % DAY_MS),
      )
      .run();
  };
  const spend = (device: Device) =>
    rows(
      "SELECT period, calls, cost_micro_usd FROM inference_spend WHERE owner_id = ? ORDER BY period",
      device.ownerId,
    );
  const head = async (device: Device, recipeId: string) =>
    (
      await rows(
        "SELECT revision FROM recipe_heads WHERE owner_id = ? AND recipe_id = ?",
        device.ownerId,
        recipeId,
      )
    )[0]?.["revision"];
  registerPageJudgement1({
    ...context,
    judgeReply,
    webauthnPage,
    dayStart,
    judgements,
    seed,
    seedUsage,
    spend,
    head,
  });
  registerPageJudgement2({
    ...context,
    judgeReply,
    webauthnPage,
    dayStart,
    judgements,
    seed,
    seedUsage,
    spend,
    head,
  });
  registerPageJudgement3({
    ...context,
    judgeReply,
    webauthnPage,
    dayStart,
    judgements,
    seed,
    seedUsage,
    spend,
    head,
  });
  registerPageJudgement4({
    ...context,
    judgeReply,
    webauthnPage,
    dayStart,
    judgements,
    seed,
    seedUsage,
    spend,
    head,
  });
});

describe("password route variants (ADR 0027)", () => {
  registerPasswordVariants(context);
});

describe("the passkey route (ADR 0027)", () => {
  registerPasskeyRoute(context);
});

describe("account lists and chooser branches (ADR 0028)", () => {
  registerChooserBranches(context);
});

describe("sign-in entry pages (ADR 0031)", () => {
  registerEntryPages(context);
});

describe("requests answered without a model call (ADR 0012)", () => {
  registerWithoutModel(context);
});

describe("request timing", () => {
  registerTiming(context);
});

describe("signed-in page samples (ADR 0029, owner 2026-10-18 08:05 UTC)", () => {
  registerPageSamples(context);
});

describe("passkey-only authenticated recipe generation", () => {
  registerPasskeyOnly(context);
});

describe("recipe layouts (ADR 0060)", () => {
  registerLayouts(context);
});

describe("recipe repair (ADR 0041)", () => {
  registerRepair(context);
});

describe("generation provenance (ADR 0060)", () => {
  registerProvenance(context);
});

describe("explicit first-page retries from the popup", () => {
  registerPopupRetries(context);
});

describe("label-only declarative SSO generation", () => {
  registerSso(context);
});
