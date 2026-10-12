/** Pateat's mark, as in icons/icon.svg; decorative beside a heading that names the page. */
export function Logo({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 128 128" aria-hidden="true" className={className ?? "size-5 shrink-0"}>
      <path
        fill="#1c9a7e"
        d="M18 116V68A46 46 0 0 1 46.77 25.35L53.89 42.97A27 27 0 0 0 37 68V116ZM110 116V68A46 46 0 0 0 81.23 25.35L74.11 42.97A27 27 0 0 1 91 68V116Z"
      />
      <path fill="#e0a100" d="M57.71 42.77L47.63 12H80.37L70.29 42.77Z" />
    </svg>
  );
}
