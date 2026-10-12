// Layout pieces of the settings page, after the Pateat design system's components.
import type { LucideIcon } from "lucide-react";
import type { ReactNode } from "react";

/** A labelled field: the label text above its control. */
export const fieldClass = "m-0 flex flex-col gap-1.5 text-sm font-semibold";
/** Inputs and selects inside a field keep the body text style. */
export const controlClass =
  "mt-0 min-h-10 w-full rounded-lg border border-border-strong bg-surface px-3 py-2 text-[0.95rem] font-normal text-ink";
/** A checkbox and its label on one line. */
export const checkClass = "checkbox-row m-0 text-[0.95rem]";

export function Panel({
  id,
  headingId,
  title,
  actions,
  children,
}: {
  id: string;
  headingId: string;
  title: string;
  actions?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section
      id={id}
      aria-labelledby={headingId}
      className="flex scroll-mt-6 flex-col gap-4 rounded-xl border border-border bg-surface p-6 shadow-[var(--shadow-panel)] max-sm:p-4"
    >
      <div className="flex flex-wrap items-center justify-between gap-4">
        <h2 id={headingId} className="m-0 text-xl leading-7 font-[650]">
          {title}
        </h2>
        {actions}
      </div>
      {children}
    </section>
  );
}

/** Rows separated by borders, inside one rounded box. */
export function RowList({ id, children }: { id?: string; children: ReactNode }) {
  return (
    <ul
      id={id}
      className="m-0 list-none rounded-xl border border-border bg-surface p-0 empty:hidden [&>li+li]:border-t [&>li+li]:border-border"
    >
      {children}
    </ul>
  );
}

/** One row: what it is (`main`), then its controls (`actions`), then anything below both. */
export function Row({
  icon: Icon,
  main,
  actions,
  children,
  className,
}: {
  icon?: LucideIcon;
  main: ReactNode;
  actions?: ReactNode;
  children?: ReactNode;
  className?: string;
}) {
  return (
    <li className={`flex flex-wrap items-center gap-3 px-4 py-3 ${className ?? ""}`}>
      {Icon && (
        <span className="grid size-8 flex-none place-items-center self-start rounded-lg border border-border bg-surface-sunken text-ink-muted">
          <Icon aria-hidden size={16} strokeWidth={2} />
        </span>
      )}
      <div className="flex min-w-0 flex-[1_1_200px] flex-col gap-1.5">{main}</div>
      {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
      {children}
    </li>
  );
}

export function RowTitle({ children }: { children: ReactNode }) {
  return (
    <span className="flex flex-wrap items-center gap-2 font-semibold [overflow-wrap:anywhere]">
      {children}
    </span>
  );
}

export function RowSub({ children, id }: { children: ReactNode; id?: string }) {
  return (
    <span id={id} className="text-[0.8125rem] leading-5 text-ink-muted [overflow-wrap:anywhere]">
      {children}
    </span>
  );
}

export type Tone = "ok" | "warn" | "err" | "idle";
const toneClass: Record<Tone, string> = {
  ok: "text-accent-ink",
  warn: "text-warning",
  err: "text-danger",
  idle: "text-ink-muted",
};

/** Several facts as icon-led lines; the icon carries the tone, the text stays readable. */
export function StatusLines({
  lines,
  id,
  muted = false,
  small = false,
}: {
  lines: { tone: Tone; icon: LucideIcon; text: ReactNode }[];
  id?: string;
  muted?: boolean;
  /** Secondary lines under a row's title. */
  small?: boolean;
}) {
  return (
    <ul id={id} className={`m-0 flex list-none flex-col p-0 ${small ? "gap-1" : "gap-2"}`}>
      {lines.map(({ tone, icon: Icon, text }, index) => (
        <li
          // The lines are fixed per render; their order is their identity.
          // oxlint-disable-next-line react/no-array-index-key
          key={index}
          className={`flex items-start gap-2 leading-5 ${small ? "text-[0.8125rem]" : "text-sm"} ${toneClass[tone]}`}
        >
          <Icon
            aria-hidden
            size={small ? 14 : 16}
            strokeWidth={2}
            className={`flex-none ${small ? "mt-[3px]" : "mt-0.5"}`}
          />
          <span className={muted ? "text-ink-muted" : "text-ink"}>{text}</span>
        </li>
      ))}
    </ul>
  );
}

export function Badge({
  children,
  muted = false,
  icon: Icon,
}: {
  children: ReactNode;
  muted?: boolean;
  icon?: LucideIcon;
}) {
  return (
    <span
      className={`inline-flex items-center gap-1 rounded-md px-2 text-xs leading-5 font-semibold whitespace-nowrap ${muted ? "border border-border bg-surface-sunken text-ink-muted" : "bg-accent-tint text-accent-ink"}`}
    >
      {Icon && <Icon aria-hidden size={12} strokeWidth={2} />}
      {children}
    </span>
  );
}

/** A nested group on the sunken ground, such as a form inside a panel. */
export const groupClass =
  "m-0 flex min-w-0 flex-col gap-3 rounded-xl border border-border bg-surface-sunken p-4";
