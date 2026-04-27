"use client"

/**
 * Map page — the visual design tokens used by the Mapbox map: style
 * URLs, marker shapes, polyline paint, label styling, hover state.
 *
 * Most map paint values live inside components/map.tsx as inline
 * Mapbox layer-paint objects rather than as CSS tokens, which is
 * why several of them are flagged as deviations on this page (and
 * will appear on the dedicated Deviations page later).
 *
 * The admin-only "issue indicator" (a red dot at #dc2626) is
 * deliberately excluded — it's behind admin and isPublic === false.
 */

import { CopyableCode } from "@/components/design-system/copyable-code"
import { MapMarkerShape } from "@/components/design-system/map-marker-shape"
import { MapPolylineSample } from "@/components/design-system/map-polyline-sample"
import { PageHeader, Section } from "@/components/design-system/section"

// --- Marker registry --------------------------------------------------
// Hand-built from the createRatingIcon() callsites in map.tsx. Order
// matches the on-map visual hierarchy — best-rated first, then less,
// then origin/terminus markers at the end.
type MarkerEntry = {
  shape:
    | "star"
    | "triangle-up"
    | "hexagon"
    | "triangle-down"
    | "circle"
    | "square"
    | "diamond"
  name: string
  colorVar: string
  description: string
}

const MARKERS: MarkerEntry[] = [
  { shape: "star", name: "Rating 4 — best", colorVar: "--primary", description: "Top-rated stations. Shown as a 5-point star in --primary." },
  { shape: "triangle-up", name: "Rating 3", colorVar: "--primary", description: "Solid four-star. Up-pointing triangle." },
  { shape: "hexagon", name: "Rating 2", colorVar: "--primary", description: "Three-star. Hexagon." },
  { shape: "triangle-down", name: "Rating 1", colorVar: "--secondary", description: "Two-star. Down-pointing triangle in --secondary (the dimmer green)." },
  { shape: "circle", name: "Unrated", colorVar: "--secondary", description: "Stations not yet rated. Plain circle in --secondary." },
  { shape: "square", name: "Origin / London terminus", colorVar: "--primary", description: "The origin terminus you're hiking from. Square in --primary." },
  { shape: "diamond", name: "London terminus inner", colorVar: "--tree-800", description: "Inner mark on the London terminus icon. Drawn at literal #2f6544 — see deviations." },
]

// --- Polyline registry ----------------------------------------------
// Each line layer in the map has its own paint object. Snapshots:
type PolylineEntry = {
  name: string
  description: string
  // These values are exactly what's passed to Mapbox's line-paint.
  color: string
  isLiteral: boolean
  width: number
  opacity: number
  dashArray?: string
}

const POLYLINES: PolylineEntry[] = [
  {
    name: "Inter-terminal",
    description: "Connection between London terminuses on the map. 1.5px, opacity driven by hover.",
    color: "#2f6544",
    isLiteral: true,
    width: 1.5,
    opacity: 0.9,
  },
  {
    name: "Journey",
    description: "The route polyline shown when you click a station — from London to that station.",
    color: "#2f6544",
    isLiteral: true,
    width: 2.5,
    opacity: 1,
  },
  {
    name: "Friend journey",
    description: "Same paint as the user's journey, distinguished only by which feature property is set.",
    color: "#2f6544",
    isLiteral: true,
    width: 2.5,
    opacity: 1,
  },
  {
    name: "Radius circle outline",
    description: "Dashed circle showing the active travel-time radius around London. 4-3 dash pattern.",
    color: "#2f6544",
    isLiteral: true,
    width: 1,
    opacity: 0.25,
    dashArray: "4 3",
  },
]

// --- Label registry --------------------------------------------------
// Mapbox label paint is theme-aware via the matching style file
// (we have separate light + dark styles registered with niczap on
// Mapbox Studio).
type LabelEntry = {
  name: string
  description: string
  fontSize: number
  // Pair of [light, dark] colours so we can render both side by side.
  colorLight: string
  colorDark: string
  // Matching halo. Halo width is 1.5 across the board.
  haloLight: string
  haloDark: string
  // Whether the colours are CSS-variable references in the source
  // (e.g. "--beach-100") or literal hexes (deviation).
  literalColors: boolean
}

const LABELS: LabelEntry[] = [
  {
    name: "Station label",
    description: "Below each station marker. 11px, theme-aware text + halo from globals.css.",
    fontSize: 11,
    colorLight: "#166534",
    colorDark: "#fdfcf8",
    haloLight: "#fff",
    haloDark: "#000",
    literalColors: true,
  },
  {
    name: "County label",
    description: "Region names painted into the map style itself. 11–13px depending on zoom.",
    fontSize: 12,
    colorLight: "#6b7280",
    colorDark: "#a1a1aa",
    haloLight: "#fff",
    haloDark: "#000",
    literalColors: true,
  },
  {
    name: "Park / landscape label",
    description: "National Parks, AONBs and similar named landscapes — distinct green tone so they pop against terrain.",
    fontSize: 12,
    colorLight: "#15803d",
    colorDark: "#86efac",
    haloLight: "#dcfce7",
    haloDark: "#14532d",
    literalColors: true,
  },
]

// --- Reusable card chrome -------------------------------------------
// Same look as the colour swatch / token cards but for arbitrary
// content. Local to this page since none of the other pages need
// exactly this shape.
function MapCard({
  title,
  visualisation,
  meta,
  description,
  deviation,
}: {
  title: string
  visualisation: React.ReactNode
  // Two-column metadata table — label / value pairs.
  meta: { label: string; value: React.ReactNode }[]
  description?: string
  // When present, renders a small "deviation" badge — literal
  // hex values that should ideally be tokens.
  deviation?: string
}) {
  return (
    <div className="overflow-hidden rounded-lg border border-border bg-card">
      <div className="flex min-h-24 items-center justify-center bg-muted/30 p-6">
        {visualisation}
      </div>
      <div className="space-y-3 p-4">
        <div className="flex items-center gap-2">
          <p className="text-sm font-semibold">{title}</p>
          {deviation && (
            <span
              className="rounded-md bg-destructive/15 px-1.5 py-0.5 font-mono text-[0.6rem] text-destructive uppercase tracking-wider"
              title={deviation}
            >
              deviation
            </span>
          )}
        </div>
        <dl className="grid grid-cols-[6rem_1fr] gap-y-1 font-mono text-xs">
          {meta.map(({ label, value }) => (
            <div key={label} className="contents">
              <dt className="text-muted-foreground">{label}</dt>
              <dd>{value}</dd>
            </div>
          ))}
        </dl>
        {description && (
          <p className="text-xs text-foreground/80">{description}</p>
        )}
        {deviation && (
          <p className="border-t border-border pt-2 text-[0.7rem] text-muted-foreground italic">
            {deviation}
          </p>
        )}
      </div>
    </div>
  )
}

// Light + dark side-by-side label preview. Same pattern as the logo
// page's surface panes.
function LabelPreview({ entry }: { entry: LabelEntry }) {
  return (
    <div className="grid gap-3 sm:grid-cols-2">
      <LabelPane entry={entry} dark={false} />
      <LabelPane entry={entry} dark />
    </div>
  )
}

function LabelPane({ entry, dark }: { entry: LabelEntry; dark: boolean }) {
  return (
    <div
      className="rounded-lg border border-border p-6"
      style={{
        background: dark ? "var(--tree-950)" : "var(--beach-500)",
      }}
    >
      <p
        className="mb-4 font-mono text-[0.65rem] uppercase tracking-wider opacity-60"
        style={{ color: dark ? "var(--beach-100)" : "var(--tree-950)" }}
      >
        {dark ? "Dark style" : "Light style"}
      </p>
      <p
        // The label sample. We approximate Mapbox's text-halo via
        // CSS text-shadow (4 cardinal offsets) — close enough that
        // the visual reads.
        style={{
          fontSize: entry.fontSize,
          color: dark ? entry.colorDark : entry.colorLight,
          textShadow: (() => {
            const halo = dark ? entry.haloDark : entry.haloLight
            return `1.5px 0 0 ${halo}, -1.5px 0 0 ${halo}, 0 1.5px 0 ${halo}, 0 -1.5px 0 ${halo}`
          })(),
        }}
      >
        Charing Cross
      </p>
    </div>
  )
}

export default function MapPage() {
  return (
    <>
      <PageHeader
        title="Map"
        subtitle="Visual tokens used by the Mapbox map — style URLs, marker shapes, polyline paint, label styling, hover state. Several of these values are inline literals rather than CSS tokens — flagged as deviations below."
      />

      {/* --- Mapbox style URLs -------------------------------------- */}
      <Section
        title="Mapbox style"
        description="Two custom Mapbox Studio styles, one per theme. Loaded by react-map-gl based on the active theme."
      >
        <div className="space-y-3">
          <div className="rounded-lg border border-border bg-card p-4">
            <p className="mb-2 text-sm font-medium">Light</p>
            <CopyableCode value="mapbox://styles/niczap/cmneh11gr001q01qxeu1leyuc" />
          </div>
          <div className="rounded-lg border border-border bg-card p-4">
            <p className="mb-2 text-sm font-medium">Dark</p>
            <CopyableCode value="mapbox://styles/niczap/cmnepmfm2001p01sfe63j3ktq" />
          </div>
        </div>
      </Section>

      {/* --- Station markers --------------------------------------- */}
      <Section
        title="Station markers"
        description="Seven public marker shapes. Each is rendered to a canvas via createRatingIcon() in components/map.tsx and registered with the Mapbox style as an image asset."
      >
        <div className="grid gap-3 [grid-template-columns:repeat(auto-fill,minmax(15rem,1fr))]">
          {MARKERS.map((m) => (
            <MapCard
              key={m.name}
              title={m.name}
              visualisation={
                <div className="text-foreground">
                  <MapMarkerShape shape={m.shape} colorVar={m.colorVar} size={48} />
                </div>
              }
              meta={[
                { label: "shape", value: m.shape },
                { label: "fill", value: m.colorVar },
                { label: "stroke", value: "currentColor (#fff light, #000 dark)" },
              ]}
              description={m.description}
              // Diamond uses a literal hex — flag it.
              deviation={
                m.shape === "diamond"
                  ? "Inner diamond fill is the literal hex #2f6544 instead of var(--tree-800)."
                  : undefined
              }
            />
          ))}
        </div>
      </Section>

      {/* --- Polylines --------------------------------------------- */}
      <Section
        title="Polylines"
        description="Line layers drawn over the basemap. Every public line uses #2f6544 (the value of --tree-800), but as a literal hex — see deviations."
      >
        <div className="grid gap-3 md:grid-cols-2">
          {POLYLINES.map((p) => (
            <MapCard
              key={p.name}
              title={p.name}
              visualisation={
                <MapPolylineSample
                  color={p.color}
                  isLiteral={p.isLiteral}
                  width={p.width}
                  opacity={p.opacity}
                  dashArray={p.dashArray}
                />
              }
              meta={[
                { label: "color", value: p.color },
                { label: "width", value: `${p.width}px` },
                { label: "opacity", value: p.opacity },
                ...(p.dashArray
                  ? [{ label: "dash", value: p.dashArray }]
                  : []),
              ]}
              description={p.description}
              deviation={
                p.isLiteral
                  ? `Literal hex ${p.color} — should reference var(--tree-800).`
                  : undefined
              }
            />
          ))}
        </div>
      </Section>

      {/* --- Labels ------------------------------------------------- */}
      <Section
        title="Labels"
        description="Text styling applied to map labels. Defined in the Mapbox style files (light + dark) — what's listed below mirrors what those style JSONs serve."
      >
        <div className="space-y-6">
          {LABELS.map((l) => (
            <div key={l.name}>
              <div className="mb-2 flex items-center gap-2">
                <p className="text-sm font-semibold">{l.name}</p>
                {l.literalColors && (
                  <span className="rounded-md bg-destructive/15 px-1.5 py-0.5 font-mono text-[0.6rem] text-destructive uppercase tracking-wider">
                    deviation
                  </span>
                )}
              </div>
              <p className="mb-3 text-xs text-foreground/80">{l.description}</p>
              <LabelPreview entry={l} />
              <dl className="mt-3 grid grid-cols-[6rem_1fr] gap-y-1 font-mono text-xs">
                <dt className="text-muted-foreground">size</dt>
                <dd>{l.fontSize}px</dd>
                <dt className="text-muted-foreground">light</dt>
                <dd>{l.colorLight} on halo {l.haloLight}</dd>
                <dt className="text-muted-foreground">dark</dt>
                <dd>{l.colorDark} on halo {l.haloDark}</dd>
                <dt className="text-muted-foreground">font</dt>
                <dd>Open Sans Regular, Arial Unicode MS Regular</dd>
              </dl>
            </div>
          ))}
        </div>
        <p className="mt-4 rounded-md border border-border bg-muted/40 p-3 text-xs text-muted-foreground">
          All label colours are literal hexes inside the Mapbox style JSON. They sit in Mapbox Studio rather than this codebase, so &quot;moving them to tokens&quot; is harder than swapping a className — the deviation is real but the fix is two-step.
        </p>
      </Section>

      {/* --- Hover state -------------------------------------------- */}
      <Section
        title="Hover state"
        description="When the cursor enters a marker, the map adds a soft glow ring around the icon. Animated: opacity oscillates 0.3 → 0.75 via requestAnimationFrame."
      >
        <MapCard
          title="Hovered station glow"
          visualisation={
            <div className="relative flex h-24 w-24 items-center justify-center">
              {/* Approximated glow — same color, blur, and pulsing
                  opacity range as the actual map. The orbit-style
                  animation isn't a CSS keyframe in the real app; we
                  use a CSS-only pulse here because the DS preview
                  doesn't need to match frame-for-frame. */}
              <div
                className="absolute h-12 w-12 rounded-full"
                style={{
                  background: "#22c55e",
                  filter: "blur(2px)",
                  animation: "ds-glow-pulse 1.4s ease-in-out infinite",
                }}
              />
              <style>{`
                @keyframes ds-glow-pulse {
                  0%, 100% { opacity: 0.3; transform: scale(1); }
                  50% { opacity: 0.75; transform: scale(1.15); }
                }
              `}</style>
              {/* The marker the glow surrounds. */}
              <div className="relative z-10 text-foreground">
                <MapMarkerShape shape="star" colorVar="--primary" size={32} />
              </div>
            </div>
          }
          meta={[
            { label: "color", value: "#22c55e" },
            { label: "radius", value: "23px" },
            { label: "opacity", value: "0.3 → 0.75 (animated)" },
            { label: "blur", value: "2" },
          ]}
          description="Driven by requestAnimationFrame in components/map.tsx, not CSS keyframes — the rAF approach lets the animation pause cleanly when the hover state ends."
          deviation="Literal hex #22c55e (Tailwind green-500). No matching token exists in globals.css — pick whether to add one or alias to --primary/--accent."
        />
      </Section>
    </>
  )
}
