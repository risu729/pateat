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

export const ROLE_CONFIG = {
  generateModelP50: { label: "Generate", color: "var(--chart-1)" },
  judgeModelP50: { label: "Judge", color: "var(--chart-2)" },
} satisfies ChartConfig;

/** A duration in milliseconds, as milliseconds below a second and seconds above. */
export function formatMs(milliseconds: number) {
  return milliseconds < 1000 ? `${milliseconds} ms` : `${(milliseconds / 1000).toFixed(1)} s`;
}
