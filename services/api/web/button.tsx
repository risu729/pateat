// Adapted from shadcn/ui base-nova Button (MIT); see THIRD-PARTY-NOTICES.md.
// The same adaptation as the extension's settings page, kept in this program.
import { Button as ButtonPrimitive } from "@base-ui/react/button";

const VARIANTS = {
  default:
    "gap-2 border-accent bg-accent text-on-accent hover:border-accent-hover hover:bg-accent-hover",
  outline: "gap-2 border-border-strong bg-surface text-ink hover:bg-surface-sunken",
  // Secondary actions inside a panel header or a row: refresh, reload.
  ghost: "gap-2 border-transparent bg-transparent text-accent-ink hover:bg-surface-sunken",
  // Destructive actions: revoking or removing an entry.
  danger: "gap-2 border-danger bg-surface text-danger hover:bg-danger-tint",
} as const;

export function Button({
  variant = "default",
  className,
  ...props
}: Omit<ButtonPrimitive.Props, "className"> & {
  variant?: keyof typeof VARIANTS;
  className?: string;
}) {
  // Chrome moves focus off a focused control that becomes disabled, so a button that starts
  // an operation stays focusable while it runs (focusableWhenDisabled): Base UI marks it
  // aria-disabled instead, which looks the same.
  const classes =
    "inline-flex min-h-10 shrink-0 items-center justify-center rounded-lg border px-4 py-2 text-sm font-semibold transition-colors outline-none focus-visible:outline-solid focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus disabled:opacity-50 aria-disabled:opacity-50";
  return (
    <ButtonPrimitive
      data-slot="button"
      className={`${classes} ${VARIANTS[variant]} ${className ?? ""}`}
      {...props}
    />
  );
}
