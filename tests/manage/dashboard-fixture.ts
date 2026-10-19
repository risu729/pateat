import type { ManageDashboard, ManageDurations } from "../../packages/contracts/src/index";

// A synthetic dashboard: invented origins, builds and times only.

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

const few = (values: number[]): ManageDurations => ({
  n: values.length,
  p50: values.length ? values.toSorted((a, b) => a - b)[Math.ceil(values.length / 2) - 1]! : null,
  values: values.toSorted((a, b) => a - b),
});

/** A week ending at `now`, with a gap on the third day and both kinds of failure. */
export function syntheticDashboard(now: number): ManageDashboard {
  const from = now - 7 * DAY_MS;
  const days = Array.from({ length: 8 }, (_, index) =>
    new Date(from + index * DAY_MS).toISOString().slice(0, 10),
  );
  const generateP50 = [9800, 10_400, null, 8900, null, 9400, 11_200, 8700];
  const judgeP50 = [2600, 2400, null, 2900, 3100, 2300, 2700, 2500];
  return {
    version: 1,
    range: "7d",
    from,
    to: now,
    llm: [
      {
        role: "generate",
        calls: 12,
        modelMs: few([
          8100, 8700, 8900, 9400, 9800, 10_400, 11_200, 12_900, 14_100, 7600, 9100, 10_000,
        ]),
        tokenMs: few([310, 290, 330, 305, 300, 315, 340, 298, 280, 360, 301, 299]),
        preModelMs: few([520, 480, 610, 505, 500, 515, 540, 498, 470, 590, 501, 499]),
        serverMs: few([
          9100, 9500, 9800, 10_300, 10_700, 11_400, 12_200, 13_800, 15_000, 8400, 10_000, 11_000,
        ]),
        parts: { n: 12, preModelOtherMs: 200, tokenMs: 305, modelMs: 9400, afterModelMs: 480 },
        inputTokens: 184_320,
        outputTokens: 21_480,
      },
      {
        role: "judge",
        calls: 42,
        modelMs: { n: 42, p50: 2600, p90: 4700 },
        tokenMs: { n: 42, p50: 300, p90: 410 },
        preModelMs: { n: 42, p50: 480, p90: 620 },
        serverMs: { n: 42, p50: 3100, p90: 5200 },
        parts: { n: 41, preModelOtherMs: 180, tokenMs: 300, modelMs: 2600, afterModelMs: 40 },
        inputTokens: 96_600,
        outputTokens: 3_150,
      },
    ],
    daily: days.map((day, index) => ({
      day,
      generateRequests: generateP50[index] === null ? 0 : 2,
      judgeRequests: judgeP50[index] === null ? 0 : 6,
      generateModelP50: generateP50[index] ?? null,
      judgeModelP50: judgeP50[index] ?? null,
      logins: [2, 1, 0, 3, 0, 2, 3, 1][index]!,
      authenticatedLogins: [2, 1, 0, 2, 0, 1, 2, 1][index]!,
    })),
    slowest: [
      {
        at: now - 2 * HOUR_MS,
        role: "generate",
        origin: "https://bank.example",
        outcome: "ok",
        tokenMs: 360,
        modelMs: 14_100,
        serverMs: 15_000,
      },
      {
        at: now - 30 * HOUR_MS,
        role: "generate",
        origin: "https://mail.example",
        outcome: "ok",
        tokenMs: 298,
        modelMs: 12_900,
        serverMs: 13_800,
      },
      {
        at: now - 3 * DAY_MS,
        role: "judge",
        origin: "https://shop.example",
        outcome: "timeout",
        tokenMs: 410,
        modelMs: 6100,
        serverMs: 6900,
      },
    ],
    perSite: [
      {
        origin: "https://bank.example",
        requests: 14,
        serverMs: few([3400, 9800, 15_000]),
        modelMs: few([2900, 9400, 14_100]),
      },
      {
        origin: "https://mail.example",
        requests: 22,
        serverMs: { n: 22, p50: 3200, p90: 12_000 },
        modelMs: { n: 22, p50: 2700, p90: 11_100 },
      },
      {
        origin: "https://shop.example",
        requests: 18,
        serverMs: few([2800, 3000, 6900]),
        modelMs: few([2300, 2500, 6100]),
      },
    ],
    perBuild: [
      {
        build: "031b5aa70d2d5479d4c2c61a4d672872180716b6",
        requests: 30,
        lastAt: now - HOUR_MS,
        modelMs: { n: 30, p50: 2700, p90: 9800 },
        serverMs: { n: 30, p50: 3300, p90: 10_700 },
      },
      {
        build: null,
        requests: 24,
        lastAt: now - 4 * DAY_MS,
        modelMs: few([2500, 8900]),
        serverMs: few([]),
      },
    ],
    stats: {
      requests: [
        { role: "judge", outcome: "ok", count: 38 },
        { role: "generate", outcome: "ok", count: 10 },
        { role: "judge", outcome: "abstained", count: 3 },
        { role: "generate", outcome: "invalid-output", count: 2 },
        { role: "judge", outcome: "timeout", count: 1 },
      ],
      loginsAuthenticated: 9,
      logins: [
        { outcome: "authenticated", count: 9 },
        { outcome: "challenge", count: 2 },
        { outcome: "unknown-submit", count: 1 },
      ],
      inputTokens: 280_920,
      outputTokens: 24_630,
      spend: {
        dayMicroUsd: 420_000,
        monthMicroUsd: 7_350_000,
        dailyLimitMicroUsd: 5_000_000,
        monthlyLimitMicroUsd: 100_000_000,
      },
      activeRecipes: 17,
      recipesGenerated: 4,
    },
    failures: [
      {
        kind: "request",
        code: "abstained",
        count: 3,
        lastAt: now - 5 * HOUR_MS,
        lastOrigin: "https://shop.example",
        lastRecipeId: "gen-shop",
        latest: [
          {
            at: now - 5 * HOUR_MS,
            origin: "https://shop.example",
            recipeId: "gen-shop",
            revision: 2,
            role: "judge",
            cause: null,
          },
          {
            at: now - 2 * DAY_MS,
            origin: "https://mail.example",
            recipeId: "gen-mail",
            revision: 1,
            role: "judge",
            cause: null,
          },
          {
            at: now - 4 * DAY_MS,
            origin: "https://mail.example",
            recipeId: "gen-mail",
            revision: 1,
            role: "judge",
            cause: null,
          },
        ],
      },
      {
        kind: "login",
        code: "unknown-submit",
        count: 1,
        lastAt: now - 6 * HOUR_MS,
        lastOrigin: null,
        lastRecipeId: "gen-gone",
        latest: [
          {
            at: now - 6 * HOUR_MS,
            origin: null,
            recipeId: "gen-gone",
            revision: 3,
            role: null,
            cause: "settled",
          },
        ],
      },
    ],
    needsPerson: [
      {
        kind: "login",
        code: "challenge",
        count: 2,
        lastAt: now - 20 * HOUR_MS,
        lastOrigin: "https://bank.example",
        lastRecipeId: "gen-bank",
        latest: [
          {
            at: now - 20 * HOUR_MS,
            origin: "https://bank.example",
            recipeId: "gen-bank",
            revision: 4,
            role: null,
            cause: null,
          },
          {
            at: now - 3 * DAY_MS,
            origin: "https://bank.example",
            recipeId: "gen-bank",
            revision: 3,
            role: null,
            cause: null,
          },
        ],
      },
    ],
  };
}
