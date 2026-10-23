import { CircleCheck, CircleX } from "lucide-react";
import type { ComponentProps, ReactNode } from "react";

/** A bordered list whose rows are separated by lines (the design system's ListRow). */
export function RowList({ className, ...props }: ComponentProps<"ul">) {
  return (
    <ul
      className={`divide-y divide-border rounded-xl border border-border bg-surface ${className ?? ""}`}
      {...props}
    />
  );
}

export const PAGE_TITLE_CLASSES = "text-[1.75rem]/9 font-bold tracking-[-0.02em]";

export const ROW_CLASSES = "flex flex-wrap items-center gap-3 px-4 py-3";

/** A row's title and secondary line; the row's controls follow it. */
export function RowMain({ title, sub }: { title: ReactNode; sub?: ReactNode }) {
  return (
    <div className="flex min-w-0 flex-[1_1_6rem] flex-col">
      <span className="font-semibold [overflow-wrap:anywhere]">{title}</span>
      {sub && <div className="text-[13px]/5 text-ink-muted [overflow-wrap:anywhere]">{sub}</div>}
    </div>
  );
}

/** A square holding a row's icon. */
export function RowIcon({ children }: { children: ReactNode }) {
  return (
    <span className="grid size-8 flex-none place-items-center rounded-lg border border-border bg-surface-sunken text-ink-muted">
      {children}
    </span>
  );
}

const BADGE_TONES = {
  accent: "bg-accent-tint text-accent-ink",
  danger: "bg-danger-tint text-danger",
  muted: "border border-border bg-surface-sunken text-ink-muted",
  warning: "bg-warning-tint text-warning",
} as const;

export function Badge({
  tone = "accent",
  children,
}: {
  tone?: keyof typeof BADGE_TONES;
  children: ReactNode;
}) {
  return (
    <span
      className={`inline-flex items-center gap-1 rounded-md px-2 max-w-full text-xs/5 font-semibold [overflow-wrap:anywhere] [&>svg]:flex-none ${BADGE_TONES[tone]}`}
    >
      {children}
    </span>
  );
}

/** Icon-led facts, one per line (the design system's StatusLines). */
export function Lines({ children }: { children: ReactNode }) {
  return <ul className="flex flex-col gap-2">{children}</ul>;
}

export function Line({ icon, children }: { icon: ReactNode; children: ReactNode }) {
  return (
    <li className="flex items-start gap-2 text-sm text-ink-muted [&>svg]:mt-0.5 [&>svg]:flex-none">
      {icon}
      <span>{children}</span>
    </li>
  );
}

/** A titled section of a page (the design system's Panel). */
export function Panel({ id, title, children }: { id: string; title: string; children: ReactNode }) {
  return (
    <section
      aria-labelledby={id}
      className="space-y-4 rounded-xl border border-border bg-surface p-4 shadow-[var(--shadow-panel)] sm:p-6"
    >
      {/* Focus lands here when the control the owner used is gone. */}
      <h2 id={id} tabIndex={-1} className="text-xl/7 font-[650] outline-none">
        {title}
      </h2>
      {children}
    </section>
  );
}

/** Label and value pairs, one per line (the design system's KeyValue). */
export function KeyValues({ entries }: { entries: [label: string, value: ReactNode][] }) {
  return (
    <dl>
      {entries.map(([label, value]) => (
        <div
          key={label}
          className="flex flex-wrap justify-between gap-x-6 gap-y-1 border-t border-border py-2.5 first:border-t-0 first:pt-0"
        >
          <dt className="text-sm text-ink-muted">{label}</dt>
          <dd className="font-mono text-[13px]/5 [overflow-wrap:anywhere] sm:text-right">
            {value}
          </dd>
        </div>
      ))}
    </dl>
  );
}

/**
 * The result of the last action, inside a live region that stays in the page so the
 * change is announced. While empty it takes no space in a `space-y-*` stack.
 */
export function SuccessNotice({ id, message }: { id: string; message: string | false }) {
  return (
    <output id={id} className="block empty:mb-0">
      {message && (
        <span className="flex items-start gap-2 rounded-xl bg-accent-tint px-3 py-2.5 text-sm">
          <CircleCheck size={16} aria-hidden className="mt-0.5 flex-none text-accent-ink" />
          {message}
        </span>
      )}
    </output>
  );
}

export function ErrorNotice({ id, children }: { id?: string; children: ReactNode }) {
  return (
    <p
      role="alert"
      id={id}
      className="flex items-start gap-2 rounded-xl bg-danger-tint px-3 py-2.5 text-sm"
    >
      <CircleX size={16} aria-hidden className="mt-0.5 flex-none text-danger" />
      <span>{children}</span>
    </p>
  );
}
