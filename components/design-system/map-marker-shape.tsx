"use client"

/**
 * Static SVG approximations of each Mapbox marker shape used by the
 * map. The real markers are drawn into canvas ImageData via
 * createRatingIcon() in components/map.tsx, so they're not directly
 * addressable from the DS — these SVGs reproduce the silhouettes
 * close enough to communicate the design.
 *
 * `colorVar` accepts a CSS variable name (e.g. "--primary") so the
 * shape inherits theme behaviour. Stroke colour is fixed white in
 * the actual app for light mode and black for dark; we use
 * currentColor here so the parent's text-color decides.
 */

type Shape =
  | "star"
  | "triangle-up"
  | "hexagon"
  | "triangle-down"
  | "circle"
  | "square"
  | "diamond"

export function MapMarkerShape({
  shape,
  colorVar = "--primary",
  size = 40,
}: {
  shape: Shape
  colorVar?: string
  size?: number
}) {
  // Inline style for fill — Tailwind can't generate arbitrary CSS-var
  // utilities, so we set fill via style. stroke uses currentColor so
  // the parent decides outline contrast.
  const fill = `var(${colorVar})`

  // We render every shape inside a 24×24 viewBox so they line up
  // visually when listed in a grid. Stroke width 1.5 matches the
  // real app's marker stroke at typical zoom.
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill={fill}
      stroke="currentColor"
      strokeWidth={1.5}
      strokeLinejoin="round"
      strokeLinecap="round"
    >
      {shape === "star" && (
        // 5-point star — the highest-rated stations.
        <polygon points="12,2 14.5,9 22,9 16,13.5 18,21 12,16.5 6,21 8,13.5 2,9 9.5,9" />
      )}
      {shape === "triangle-up" && (
        <polygon points="12,3 22,21 2,21" />
      )}
      {shape === "hexagon" && (
        <polygon points="12,2 21,7 21,17 12,22 3,17 3,7" />
      )}
      {shape === "triangle-down" && (
        <polygon points="2,4 22,4 12,21" />
      )}
      {shape === "circle" && (
        <circle cx="12" cy="12" r="9" />
      )}
      {shape === "square" && (
        <rect x="3" y="3" width="18" height="18" rx="1" />
      )}
      {shape === "diamond" && (
        <polygon points="12,2 22,12 12,22 2,12" />
      )}
    </svg>
  )
}
