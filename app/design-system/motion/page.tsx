/**
 * Motion page — every meaningful animation in the app, grouped by
 * what the motion communicates.
 *
 * Why grouping matters: motion isn't tokenised in this codebase, so
 * the only way to spot "two modal openings with different durations"
 * is to put them next to each other on the same page. Each section
 * here is one functional bucket; each card surfaces duration +
 * easing prominently so cross-card consistency is visible.
 *
 * Inconsistencies surfaced here become entries on the Anomalies
 * page (see m1ex, m2dur, etc.).
 */

import { CopyableCode } from "@/components/design-system/copyable-code"
import { PageHeader, Section } from "@/components/design-system/section"
import {
  ButtonHoverScaleDemo,
  BreakpointMarkerDemo,
  CheckboxTickDrawEraseDemo,
  DialogEnterDemo,
  DropdownMenuOpenCloseDemo,
  FilterIconJumpDemo,
  FilterPanelChevronDemo,
  FilterPanelCollapseDemo,
  MapFadeInDemo,
  MapHoverGlowDemo,
  MapPolylineDrawDemo,
  OrbitDemo,
  PhotoHoverOverlayDemo,
  ShimmerDemo,
  StationModalEntryExitDemo,
  TransitionOpacityDemo,
  WelcomeBannerEntryExitDemo,
} from "@/components/design-system/motion-demos"
import {
  motionCategoryInfo,
  motionEntries,
  type MotionCategory,
  type MotionEntry,
} from "@/lib/design-system/motion"

// id → demo. Centralised so adding a new entry is a single place
// to wire up.
function pickDemo(id: string): React.ReactNode {
  switch (id) {
    case "shimmer": return <ShimmerDemo />
    case "orbit": return <OrbitDemo />
    case "dialog-enter": return <DialogEnterDemo />
    case "welcome-banner-entry-exit": return <WelcomeBannerEntryExitDemo />
    case "station-modal-entry-exit": return <StationModalEntryExitDemo />
    case "dropdown-menu-open-close": return <DropdownMenuOpenCloseDemo />
    case "checkbox-tick-draw-erase": return <CheckboxTickDrawEraseDemo />
    case "button-hover-scale": return <ButtonHoverScaleDemo />
    case "filter-icon-jump": return <FilterIconJumpDemo />
    case "filter-panel-collapse": return <FilterPanelCollapseDemo />
    case "filter-panel-chevron": return <FilterPanelChevronDemo />
    case "map-fade-in": return <MapFadeInDemo />
    case "map-hover-glow": return <MapHoverGlowDemo />
    case "map-polyline-draw": return <MapPolylineDrawDemo />
    case "transition-opacity-default": return <TransitionOpacityDemo />
    case "photo-hover-overlay": return <PhotoHoverOverlayDemo />
    case "breakpoint-marker-slide": return <BreakpointMarkerDemo />
    default:
      return (
        <p className="text-sm text-muted-foreground">Demo not yet wired up.</p>
      )
  }
}

// Stable category order on the page.
const CATEGORY_ORDER: MotionCategory[] = [
  "loading",
  "modal",
  "state",
  "map",
  "feedback",
]

function MotionCard({ entry }: { entry: MotionEntry }) {
  return (
    <article id={entry.id} className="scroll-mt-24 overflow-hidden rounded-lg border border-border bg-card">
      {/* Demo region — same chrome as TokenCard's visualisation
          row. min-h-32 stops short demos from collapsing the area. */}
      <div className="flex min-h-32 items-center justify-center bg-muted/30 px-5 py-6">
        {pickDemo(entry.id)}
      </div>

      <div className="space-y-3 p-4">
        <p className="text-sm font-semibold">{entry.name}</p>
        <p className="text-xs text-foreground/80">{entry.description}</p>

        {/* Trigger + type are always single-valued, so they live at
            the top in their own grid. Duration + easing render
            differently depending on whether the entry has phases. */}
        <dl className="grid grid-cols-[5rem_1fr] gap-y-1 font-mono text-xs">
          <dt className="text-muted-foreground">trigger</dt>
          <dd className="text-foreground/80">{entry.trigger}</dd>
          <dt className="text-muted-foreground">type</dt>
          <dd>{entry.type}</dd>
        </dl>

        {entry.phases ? (
          // Multi-phase entry (entry/exit, draw/erase, open/close).
          // Each phase gets its own block with a small uppercase
          // sub-header and an HR divider between phases — keeps
          // values from getting mashed together.
          <div className="space-y-3">
            {entry.phases.map((phase, i) => (
              <div key={phase.label}>
                {i > 0 && <hr className="my-3 border-border" />}
                <p className="mb-1.5 font-mono text-[0.65rem] font-semibold tracking-wider text-muted-foreground uppercase">
                  {phase.label}
                </p>
                <dl className="grid grid-cols-[5rem_1fr] gap-y-1 font-mono text-xs">
                  <dt className="text-muted-foreground">duration</dt>
                  <dd className="font-medium">{phase.duration}</dd>
                  <dt className="text-muted-foreground">easing</dt>
                  <dd>{phase.easing}</dd>
                </dl>
              </div>
            ))}
          </div>
        ) : (
          // Single-direction entry — duration + easing as plain rows.
          <dl className="grid grid-cols-[5rem_1fr] gap-y-1 font-mono text-xs">
            <dt className="text-muted-foreground">duration</dt>
            <dd className="font-medium">{entry.duration ?? "—"}</dd>
            <dt className="text-muted-foreground">easing</dt>
            <dd>{entry.easing ?? "—"}</dd>
          </dl>
        )}

        {/* Source as a copyable chip — usually file:line, sometimes a
            descriptive note. Click-to-copy parallels the anomaly
            codes pattern. */}
        <div>
          <p className="mb-1 text-xs text-muted-foreground">Source</p>
          <CopyableCode value={entry.source} />
        </div>
      </div>
    </article>
  )
}

export default function MotionPage() {
  // Filter to public entries — one or two demos are admin-or-DS-only.
  const visible = motionEntries.filter((e) => e.isPublic)
  // Group by category for rendering. Map preserves insertion order;
  // we iterate CATEGORY_ORDER explicitly so layout is stable.
  const byCategory = new Map<MotionCategory, MotionEntry[]>()
  for (const e of visible) {
    const list = byCategory.get(e.category) ?? []
    list.push(e)
    byCategory.set(e.category, list)
  }

  return (
    <>
      <PageHeader
        title="Motion"
        subtitle="Every meaningful animation in the app, grouped by what the motion communicates rather than by where it's implemented. Putting related effects next to each other makes consistency (and inconsistency) visible — flag mismatches as anomalies."
      />

      {/* Brief framing note — the premise of grouping. Same dashed
          chrome as the Anomalies legend, so the two pages feel
          stylistically connected. */}
      <p className="mb-8 rounded-md border border-dashed border-border bg-card p-4 text-sm text-muted-foreground">
        Motion isn&apos;t tokenised in this codebase. Durations and easings live
        as inline values in CSS keyframes, tw-animate-css class strings, Tailwind
        transition utilities, manual setTimeout chains, Mapbox layer transitions,
        and rAF loops. This page is a curated catalogue — not exhaustive, but
        complete enough that two animations belonging to the same group should
        feel like the same kind of moment. When they don&apos;t, that&apos;s an{" "}
        <a href="/design-system/anomalies" className="text-foreground/80 underline">anomaly</a>.
      </p>

      {CATEGORY_ORDER.map((cat) => {
        const list = byCategory.get(cat)
        if (!list || list.length === 0) return null
        const info = motionCategoryInfo[cat]
        return (
          <Section
            key={cat}
            title={info.name}
            description={info.description}
          >
            <div className="grid gap-3 [grid-template-columns:repeat(auto-fill,minmax(20rem,1fr))]">
              {list.map((entry) => (
                <MotionCard key={entry.id} entry={entry} />
              ))}
            </div>
          </Section>
        )
      })}
    </>
  )
}
