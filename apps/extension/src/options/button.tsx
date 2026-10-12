// Adapted from shadcn/ui base-nova Button (MIT); see THIRD-PARTY-NOTICES.md.
// Keep only the variants used here; Base UI owns button interaction behavior.
import { Button as ButtonPrimitive } from "@base-ui/react/button";

const VARIANTS = {
  default: "border-accent bg-accent text-on-accent hover:border-accent-hover hover:bg-accent-hover",
  outline: "border-border-strong bg-surface text-ink hover:bg-surface-sunken",
  // Destructive actions: revoking or removing an entry.
  danger: "border-danger bg-surface text-danger hover:bg-danger-tint",
} as const;

export function Button({
  variant = "default",
  className,
  ...props
}: Omit<ButtonPrimitive.Props, "className"> & {
  variant?: keyof typeof VARIANTS;
  className?: string;
}) {
  const classes =
    "inline-flex min-h-10 shrink-0 items-center justify-center rounded-lg border px-4 py-2 text-sm font-semibold transition-colors outline-none focus-visible:outline-solid focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus disabled:opacity-50";
  return (
    <ButtonPrimitive
      data-slot="button"
      className={`${classes} ${VARIANTS[variant]} ${className ?? ""}`}
      {...props}
    />
  );
}
