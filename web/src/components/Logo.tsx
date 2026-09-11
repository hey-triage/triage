/**
 * The Triage mark: three strokes at sixty degrees, bottom-aligned, each shorter
 * than the last, ending in a dot. Drawn on a 48-unit grid at a single 5.5 stroke
 * with round caps; fills from `currentColor` so it takes the surrounding text
 * colour. The source of truth for the geometry is assets/brand/triage-mark.svg.
 */
export function TriageMark({ size = 18, className }: { size?: number; className?: string }) {
  return (
    <svg
      className={className}
      width={size}
      height={size}
      viewBox="0 0 48 48"
      fill="none"
      stroke="currentColor"
      strokeWidth={5.5}
      strokeLinecap="round"
      aria-hidden="true"
    >
      <path d="M9 40 L25 12.3" />
      <path d="M20 40 L30 22.7" />
      <path d="M31 40 L36 31.3" />
      <circle cx="42.5" cy="40" r="2.9" fill="currentColor" stroke="none" />
    </svg>
  )
}

/** Mark + wordmark lockup (the "F2" ratio: mark box ≈ 1.03× the type size, gap ≈ 0.31em). */
export function TriageLogo({ className }: { className?: string }) {
  return (
    <span className={`logo${className ? ` ${className}` : ''}`} aria-label="triage">
      <TriageMark className="logoMark" />
      <span className="logoWord" aria-hidden="true">
        triage
      </span>
    </span>
  )
}
