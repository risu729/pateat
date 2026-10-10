// Adapted from shadcn/ui base-nova Button (MIT); see THIRD-PARTY-NOTICES.md.
// Keep only the two variants used here; Base UI owns button interaction behavior.
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
    "inline-flex min-h-10 shrink-0 items-center justify-center rounded-lg border px-4 py-2 text-sm font-semibold transition-colors outline-none focus-visible:ring-3 focus-visible:ring-teal-700/50 disabled:opacity-50";
  return (
    <ButtonPrimitive
      data-slot="button"
      className={`${classes} ${variant === "outline" ? "border-slate-300 bg-white text-slate-800 hover:bg-slate-100" : "border-teal-800 bg-teal-800 text-white hover:bg-teal-900"} ${className ?? ""}`}
      {...props}
    />
  );
}
