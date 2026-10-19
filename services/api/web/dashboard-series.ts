import type { ChartConfig } from "./chart";

// The dashboard's series: their labels and colors, shared by the lazily loaded charts and
// the tables beside them. Type-only imports keep Recharts out of the page's own bundle.

/** The parts of a request's server time, in the order they happen. */
export const PART_CONFIG = {
  preModelOtherMs: { label: "Before the model", color: "var(--chart-1)" },
  tokenMs: { label: "Token exchange", color: "var(--chart-2)" },
  modelMs: { label: "Model", color: "var(--chart-3)" },
  afterModelMs: { label: "After the model", color: "var(--chart-4)" },
} satisfies ChartConfig;
export type Part = keyof typeof PART_CONFIG;
export const PARTS = Object.keys(PART_CONFIG) as Part[];

/**
 * The parts of a signed-in login's own time: the network part of its service time, the
 * rest of the service time, the wait for the site, and the rest of the login. The person's
 * time is apart.
 */
export const LOGIN_PART_CONFIG = {
  networkMs: { label: "Network", color: "var(--chart-1)" },
  serviceOtherMs: { label: "Service apart from the network", color: "var(--chart-2)" },
  pageMs: { label: "Waiting for the site", color: "var(--chart-3)" },
  otherMs: { label: "Rest of the login", color: "var(--chart-4)" },
} satisfies ChartConfig;
export type LoginPart = keyof typeof LOGIN_PART_CONFIG;
export const LOGIN_PARTS = Object.keys(LOGIN_PART_CONFIG) as LoginPart[];

export const LOGIN_TREND_CONFIG = {
  loginP50: { label: "Login time", color: "var(--chart-1)" },
} satisfies ChartConfig;

export const ROLE_CONFIG = {
  generateModelP50: { label: "Generate", color: "var(--chart-1)" },
  judgeModelP50: { label: "Judge", color: "var(--chart-2)" },
} satisfies ChartConfig;

/** A duration in milliseconds, as milliseconds below a second and seconds above. */
export function formatMs(milliseconds: number) {
  return milliseconds < 1000 ? `${milliseconds} ms` : `${(milliseconds / 1000).toFixed(1)} s`;
}
