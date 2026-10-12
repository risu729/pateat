// Adapted from shadcn/ui base-nova Button (MIT); see THIRD-PARTY-NOTICES.md.
// The same adaptation as the extension's settings page, kept in this program.
import { Button as ButtonPrimitive } from "@base-ui/react/button";

export function Button({
  variant = "default",
  className,
  ...props
}: Omit<ButtonPrimitive.Props, "className"> & {
  variant?: "default" | "outline";
  className?: string;
}) {
  const classes =
    "inline-flex min-h-10 shrink-0 items-center justify-center rounded-lg border px-4 py-2 text-sm font-semibold transition-colors outline-none focus-visible:outline-solid focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus disabled:opacity-50";
  return (
    <ButtonPrimitive
      data-slot="button"
      className={`${classes} ${variant === "outline" ? "border-border-strong bg-surface text-ink hover:bg-surface-sunken" : "border-accent bg-accent text-on-accent hover:border-accent-hover hover:bg-accent-hover"} ${className ?? ""}`}
      {...props}
    />
  );
}
