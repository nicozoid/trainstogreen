/**
 * Logo-shaped loading indicator — the TRAINS TO GREEN glyph with an
 * animated coupling rod between the two wheels. Used by the welcome
 * banner (briefly, on slow paths) and by the Flickr photo panel
 * (while photos are being fetched).
 *
 * The static parts (triangle, stem, wheels, baseline) live in an
 * SVG; the animated rod is a plain HTML <div> absolutely positioned
 * over the SVG. HTML transform animations are reliably promoted to
 * the GPU compositor layer, so the rod keeps ticking even when the
 * main thread is temporarily blocked — crucial for loading-spinner
 * UX. See `orbit` keyframe in app/globals.css.
 */

import { cn } from "@/lib/utils"

type LogoSpinnerProps = {
  /**
   * Tailwind class controlling the overall size. Defaults to `h-8`,
   * which is the size the welcome banner used. Callers using the
   * spinner elsewhere (e.g. Flickr loading) typically want something
   * similar — the spinner is always `w-auto` internally to preserve
   * its 132:50 viewBox aspect.
   */
  className?: string
  /**
   * Accessible label announced by screen readers. Defaults to the
   * generic "Loading"; callers can override with something more
   * specific (e.g. "Loading photos").
   */
  label?: string
}

export function LogoSpinner({ className, label = "Loading" }: LogoSpinnerProps) {
  return (
    <div className={cn("relative inline-block", className)}>
      <svg
        role="status"
        aria-label={label}
        viewBox="-8 -4 132 50"
        className="h-full w-auto block"
        fill="none"
        stroke="currentColor"
        strokeWidth={6}
        strokeLinejoin="round"
      >
        {/* Triangle ("tree" crown) — width 35, height 26 */}
        <polygon points="17.5,4 0,30 35,30" />
        {/* Stem ("trunk") — (17.5, 30) → (17.5, 42). Length 12 */}
        <line x1="17.5" y1="30" x2="17.5" y2="42" />
        {/* Two wheels — r=16, cy=20 (bottoms at y=36) */}
        <circle cx="61" cy="20" r="16" />
        <circle cx="101" cy="20" r="16" />
        {/* Baseline — extends 4 units past the tree/right wheel */}
        <line x1="-4" y1="42" x2="121" y2="42" />
      </svg>
      {/* Animated coupling rod — HTML div, compositor-friendly */}
      <div
        aria-hidden="true"
        className="absolute bg-current"
        style={{
          // rod x: SVG x=61..101 → viewBox x-offset 69..109 of 132
          left: `${(69 / 132) * 100}%`,
          width: `${(40 / 132) * 100}%`,
          // rod y: SVG y=17..23 (centre 20, thickness 6)
          top: `${(21 / 50) * 100}%`,
          height: `${(6 / 50) * 100}%`,
          animation: "orbit 0.8s linear infinite",
          willChange: "transform",
          transform: "translateZ(0)",
        }}
      />
    </div>
  )
}
