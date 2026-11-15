import { CircleX, Info, TriangleAlert } from "lucide-react";
import type { ReactNode } from "react";

/** An icon-led status line. */
export function Line({
  tone,
  id,
  children,
}: {
  tone: "idle" | "warn" | "err";
  id?: string;
  children: ReactNode;
}) {
  const Icon = { idle: Info, warn: TriangleAlert, err: CircleX }[tone];
  return (
    <li id={id} className={`popup-line popup-line--${tone}`}>
      <Icon size={16} strokeWidth={2} aria-hidden="true" />
      <span>{children}</span>
    </li>
  );
}
