import type { ManageDashboard } from "@pateat/contracts";
import { Bar, BarChart, CartesianGrid, Line, LineChart, XAxis, YAxis } from "recharts";
import {
  ChartContainer,
  ChartLegend,
  ChartLegendContent,
  ChartTooltip,
  ChartTooltipContent,
} from "./chart";
import { formatMs, PART_CONFIG, PARTS, ROLE_CONFIG } from "./dashboard-series";

// Loaded only by the dashboard (React.lazy), so the other pages never download Recharts.
// Each chart is hidden from assistive technology; the page shows the same numbers in a
// table next to it.

/** Seconds with one decimal for an axis tick. */
const seconds = (value: number) => `${(value / 1000).toFixed(1)} s`;

/** The median of each part of the server time, one stacked bar per role. */
export function BreakdownChart({ llm }: { llm: ManageDashboard["llm"] }) {
  const data = llm
    .filter((role) => role.parts.n > 0)
    .map((role) => ({ role: role.role === "generate" ? "Generate" : "Judge", ...role.parts }));
  return (
    <ChartContainer
      config={PART_CONFIG}
      aria-hidden
      className="h-44 w-full"
      initialDimension={{ width: 640, height: 176 }}
    >
      <BarChart data={data} layout="vertical" accessibilityLayer={false} barCategoryGap={12}>
        <CartesianGrid horizontal={false} />
        <XAxis type="number" tickFormatter={seconds} tickLine={false} axisLine={false} />
        <YAxis type="category" dataKey="role" width={72} tickLine={false} axisLine={false} />
        <ChartTooltip
          cursor={false}
          content={<ChartTooltipContent indicator="dot" valueFormatter={formatMs} />}
        />
        <ChartLegend itemSorter={null} content={<ChartLegendContent />} />
        {PARTS.map((key, index, keys) => (
          <Bar
            key={key}
            dataKey={key}
            stackId="server"
            fill={`var(--color-${key})`}
            // A surface-colored gap between segments; only the outer ends are rounded.
            stroke="var(--surface)"
            strokeWidth={2}
            radius={index === keys.length - 1 ? [0, 4, 4, 0] : index === 0 ? [4, 0, 0, 4] : 0}
            isAnimationActive={false}
          />
        ))}
      </BarChart>
    </ChartContainer>
  );
}

/** The median model time per UTC day and role; a day without requests is a gap. */
export function TrendChart({ daily }: { daily: ManageDashboard["daily"] }) {
  const data = daily.map((day) => ({ ...day, label: day.day.slice(5) }));
  return (
    <ChartContainer
      config={ROLE_CONFIG}
      aria-hidden
      className="h-56 w-full"
      initialDimension={{ width: 640, height: 224 }}
    >
      <LineChart data={data} accessibilityLayer={false} margin={{ left: 4, right: 12, top: 8 }}>
        <CartesianGrid vertical={false} />
        <XAxis dataKey="label" tickLine={false} axisLine={false} minTickGap={16} />
        <YAxis tickFormatter={seconds} tickLine={false} axisLine={false} width={48} />
        <ChartTooltip
          content={<ChartTooltipContent indicator="line" valueFormatter={formatMs} />}
        />
        <ChartLegend itemSorter={null} content={<ChartLegendContent />} />
        {Object.keys(ROLE_CONFIG).map((key) => (
          <Line
            key={key}
            dataKey={key}
            type="linear"
            stroke={`var(--color-${key})`}
            strokeWidth={2}
            dot={{ r: 4, fill: `var(--color-${key})`, stroke: "var(--surface)", strokeWidth: 2 }}
            activeDot={{ r: 5 }}
            connectNulls={false}
            isAnimationActive={false}
          />
        ))}
      </LineChart>
    </ChartContainer>
  );
}
