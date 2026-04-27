"use client"

/**
 * SVG demo of one Mapbox line layer. Renders a horizontal stroke
 * with the same stroke-width, color, opacity and dash pattern that
 * the real layer uses, so a designer can see what each line type
 * looks like in isolation.
 *
 * The colour is set via inline style with var() so it tracks tokens
 * if/when these literal hex values get migrated.
 */

export function MapPolylineSample({
  color,
  width,
  opacity = 1,
  dashArray,
  // Whether colour is a CSS variable name (e.g. "--tree-800") or a
  // literal hex/rgb. We render literals as-is and var() values via
  // var(...). Distinguishing the two also drives the "deviation"
  // styling — literals get a subtle warning marker.
  isLiteral = false,
}: {
  color: string
  width: number
  opacity?: number
  dashArray?: string
  isLiteral?: boolean
}) {
  const stroke = isLiteral ? color : `var(${color})`

  return (
    <div className="flex items-center gap-3">
      {/* Wide, short SVG so the line reads horizontally. The line is
          drawn at exactly the paint width — no scaling — so what you
          see matches what's painted on the map. */}
      <svg
        width={120}
        height={Math.max(width + 6, 16)}
        className="shrink-0"
      >
        <line
          x1={4}
          y1={Math.max(width + 6, 16) / 2}
          x2={116}
          y2={Math.max(width + 6, 16) / 2}
          stroke={stroke}
          strokeWidth={width}
          strokeOpacity={opacity}
          strokeDasharray={dashArray}
          strokeLinecap="round"
        />
      </svg>
    </div>
  )
}
