// Adapted from shadcn/ui base-nova Chart (MIT); see public/manage/assets/notices.md.
// Changes: the page's Content Security Policy allows no inline <style>, so each series
// color is set as a custom property on the container's style (applied through the CSSOM)
// instead of a generated stylesheet; colors are the page's tokens, which already follow
// the theme, so the per-theme color option is gone; `cn` is a join without
// tailwind-merge, so the container sets no aspect ratio and each chart gives its height;
// Tailwind classes use Pateat's tokens; a tooltip can format its values; only the parts
// the dashboard uses are kept.
import {
  createContext,
  useContext,
  useId,
  useMemo,
  type ComponentProps,
  type CSSProperties,
  type ReactNode,
} from "react";
import * as RechartsPrimitive from "recharts";
import type { TooltipValueType } from "recharts";

const cn = (...classes: (string | false | undefined)[]) => classes.filter(Boolean).join(" ");

const INITIAL_DIMENSION = { width: 320, height: 200 } as const;
type TooltipNameType = number | string;

/** Each series' label and color (a CSS color, usually a `var(--chart-N)` token). */
export type ChartConfig = Record<string, { label?: ReactNode; color?: string }>;

const ChartContext = createContext<{ config: ChartConfig } | null>(null);

function useChart() {
  const context = useContext(ChartContext);
  if (!context) throw new Error("useChart must be used within a <ChartContainer />");
  return context;
}

export function ChartContainer({
  id,
  className,
  children,
  config,
  style,
  initialDimension = INITIAL_DIMENSION,
  ...props
}: ComponentProps<"div"> & {
  config: ChartConfig;
  children: ComponentProps<typeof RechartsPrimitive.ResponsiveContainer>["children"];
  initialDimension?: { width: number; height: number };
}) {
  const uniqueId = useId();
  const chartId = `chart-${id ?? uniqueId.replace(/:/g, "")}`;
  // `--color-<key>` for each series, which marks reference as `var(--color-<key>)`.
  const colors = Object.fromEntries(
    Object.entries(config).flatMap(([key, item]) =>
      item.color ? [[`--color-${key}`, item.color]] : [],
    ),
  ) as CSSProperties;
  const context = useMemo(() => ({ config }), [config]);
  return (
    <ChartContext.Provider value={context}>
      <div
        data-slot="chart"
        data-chart={chartId}
        className={cn(
          "flex justify-center text-xs [&_.recharts-cartesian-axis-tick_text]:fill-ink-muted [&_.recharts-cartesian-grid_line[stroke='#ccc']]:stroke-border [&_.recharts-curve.recharts-tooltip-cursor]:stroke-border [&_.recharts-dot[stroke='#fff']]:stroke-transparent [&_.recharts-layer]:outline-hidden [&_.recharts-rectangle.recharts-tooltip-cursor]:fill-surface-sunken [&_.recharts-reference-line_[stroke='#ccc']]:stroke-border [&_.recharts-surface]:outline-hidden",
          className,
        )}
        style={{ ...colors, ...style }}
        {...props}
      >
        <RechartsPrimitive.ResponsiveContainer initialDimension={initialDimension}>
          {children}
        </RechartsPrimitive.ResponsiveContainer>
      </div>
    </ChartContext.Provider>
  );
}

export const ChartTooltip = RechartsPrimitive.Tooltip;

export function ChartTooltipContent({
  active,
  payload,
  className,
  indicator = "dot",
  hideLabel = false,
  hideIndicator = false,
  label,
  labelFormatter,
  labelClassName,
  formatter,
  color,
  nameKey,
  labelKey,
  valueFormatter,
}: ComponentProps<typeof RechartsPrimitive.Tooltip> &
  ComponentProps<"div"> & {
    /** Writes a numeric value (Pateat addition); otherwise it is localized. */
    valueFormatter?: (value: number) => string;
    hideLabel?: boolean;
    hideIndicator?: boolean;
    indicator?: "line" | "dot" | "dashed";
    nameKey?: string;
    labelKey?: string;
  } & Omit<
    RechartsPrimitive.DefaultTooltipContentProps<TooltipValueType, TooltipNameType>,
    "accessibilityLayer"
  >) {
  const { config } = useChart();

  const tooltipLabel = useMemo(() => {
    if (hideLabel || !payload?.length) return null;
    const [item] = payload;
    const key = `${labelKey ?? item?.dataKey ?? item?.name ?? "value"}`;
    const itemConfig = getPayloadConfigFromPayload(config, item, key);
    const value =
      !labelKey && typeof label === "string" ? (config[label]?.label ?? label) : itemConfig?.label;
    if (labelFormatter)
      return (
        <div className={cn("font-medium", labelClassName)}>{labelFormatter(value, payload)}</div>
      );
    if (!value) return null;
    return <div className={cn("font-medium", labelClassName)}>{value}</div>;
  }, [label, labelFormatter, payload, hideLabel, labelClassName, config, labelKey]);

  if (!active || !payload?.length) return null;

  const nestLabel = payload.length === 1 && indicator !== "dot";

  return (
    <div
      className={cn(
        "grid min-w-32 items-start gap-1.5 rounded-lg border border-border bg-surface px-2.5 py-1.5 text-xs text-ink shadow-[var(--shadow-menu)]",
        className,
      )}
    >
      {!nestLabel ? tooltipLabel : null}
      <div className="grid gap-1.5">
        {payload
          .filter((item) => item.type !== "none")
          .map((item, index) => {
            const key = `${nameKey ?? item.name ?? item.dataKey ?? "value"}`;
            const itemConfig = getPayloadConfigFromPayload(config, item, key);
            const indicatorColor = color ?? item.payload?.fill ?? item.color;
            return (
              <div
                key={key}
                className={cn(
                  "flex w-full flex-wrap items-stretch gap-2 [&>svg]:h-2.5 [&>svg]:w-2.5 [&>svg]:text-ink-muted",
                  indicator === "dot" && "items-center",
                )}
              >
                {formatter && item?.value !== undefined && item.name ? (
                  formatter(item.value, item.name, item, index, item.payload)
                ) : (
                  <>
                    {!hideIndicator && (
                      <div
                        className={cn(
                          "shrink-0 rounded-[2px] border-(--color-border) bg-(--color-bg)",
                          indicator === "dot" && "h-2.5 w-2.5",
                          indicator === "line" && "w-1",
                          indicator === "dashed" &&
                            "w-0 border-[1.5px] border-dashed bg-transparent",
                          nestLabel && indicator === "dashed" && "my-0.5",
                        )}
                        style={
                          {
                            "--color-bg": indicatorColor,
                            "--color-border": indicatorColor,
                          } as CSSProperties
                        }
                      />
                    )}
                    <div
                      className={cn(
                        "flex flex-1 justify-between gap-3 leading-none",
                        nestLabel ? "items-end" : "items-center",
                      )}
                    >
                      <div className="grid gap-1.5">
                        {nestLabel ? tooltipLabel : null}
                        <span className="text-ink-muted">{itemConfig?.label ?? item.name}</span>
                      </div>
                      {item.value != null && (
                        <span className="font-mono font-medium text-ink tabular-nums">
                          {typeof item.value === "number"
                            ? (valueFormatter?.(item.value) ?? item.value.toLocaleString())
                            : String(item.value)}
                        </span>
                      )}
                    </div>
                  </>
                )}
              </div>
            );
          })}
      </div>
    </div>
  );
}

export const ChartLegend = RechartsPrimitive.Legend;

export function ChartLegendContent({
  className,
  hideIcon = false,
  payload,
  verticalAlign = "bottom",
  nameKey,
}: ComponentProps<"div"> & {
  hideIcon?: boolean;
  nameKey?: string;
} & RechartsPrimitive.DefaultLegendContentProps) {
  const { config } = useChart();
  if (!payload?.length) return null;
  return (
    <div
      className={cn(
        "flex flex-wrap items-center justify-center gap-x-4 gap-y-1",
        verticalAlign === "top" ? "pb-3" : "pt-3",
        className,
      )}
    >
      {payload
        .filter((item) => item.type !== "none")
        .map((item) => {
          const key = `${nameKey ?? item.dataKey ?? "value"}`;
          const itemConfig = getPayloadConfigFromPayload(config, item, key);
          return (
            <div key={key} className="flex items-center gap-1.5 text-ink-muted">
              {!hideIcon && (
                <div
                  className="h-2 w-2 shrink-0 rounded-[2px]"
                  style={{ backgroundColor: item.color }}
                />
              )}
              {itemConfig?.label}
            </div>
          );
        })}
    </div>
  );
}

function getPayloadConfigFromPayload(config: ChartConfig, payload: unknown, key: string) {
  if (typeof payload !== "object" || payload === null) return undefined;
  const payloadPayload =
    "payload" in payload && typeof payload.payload === "object" && payload.payload !== null
      ? payload.payload
      : undefined;
  let configLabelKey: string = key;
  if (key in payload && typeof payload[key as keyof typeof payload] === "string") {
    configLabelKey = payload[key as keyof typeof payload] as string;
  } else if (
    payloadPayload &&
    key in payloadPayload &&
    typeof payloadPayload[key as keyof typeof payloadPayload] === "string"
  ) {
    configLabelKey = payloadPayload[key as keyof typeof payloadPayload] as string;
  }
  return configLabelKey in config ? config[configLabelKey] : config[key];
}
