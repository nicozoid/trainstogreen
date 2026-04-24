"use client"

// Admin-only editor for the structured walk data behind a station's
// ramblerNote. Replaces the free-text textarea — the prose is now
// purely a build output, so editing happens on the source walk
// variants (data/rambler-walks.json + friends) via their 4-char id.
//
// Flow:
//  1. When the station overlay opens in devMode we fetch every walk
//     variant whose start or end station matches this station's CRS.
//  2. Each walk renders as a collapsed card (id · role · route).
//     Clicking expands it to show the editable fields.
//  3. Save button per card PATCHes /api/dev/walk/[id] with the
//     whitelisted dirty fields. The server rewrites the source JSON
//     and re-runs the build, so station-notes.json is refreshed in
//     the same round-trip. `onSaved` lets the parent pull the
//     regenerated prose back into its state.
//
// Scope of v1 editable fields:
//   - komootUrl (text)
//   - bestSeasons (12 month chips)
//   - mudWarning (checkbox)
//   - warnings (free-text, for non-mud warnings)
// Everything else (sights, lunchStops, terrain, distance, etc.) is
// view-only for now — list editors are a bigger lift and haven't been
// scoped into Phase 5 v1.

import { useCallback, useEffect, useMemo, useState } from "react"
import { Button } from "@/components/ui/button"
import { Checkbox } from "@/components/ui/checkbox"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from "@/components/ui/dialog"
import { ConfirmDialog } from "@/components/confirm-dialog"
// Static import: the sources registry is tiny (a handful of orgs) and
// changes rarely. Importing directly lets the admin UI render the
// dropdown without a separate fetch round-trip.
import sourcesJson from "@/data/sources.json"

// Shape matches the payload from /api/dev/walks-for-station.
export type WalkPayload = {
  slug: string
  pageTitle: string
  pageUrl: string
  favourite: boolean
  id: string
  role: string
  name: string
  suffix: string
  startStation: string | null
  endStation: string | null
  startStationName: string | null
  endStationName: string | null
  startPlace: string
  endPlace: string
  stationToStation: boolean
  distanceKm: number | null
  hours: number | null
  terrain: string
  sights: { name: string; url?: string | null; description?: string }[]
  lunchStops: { name: string; location?: string; url?: string | null; notes?: string; rating?: string; busy?: boolean }[]
  warnings: string
  trainTips: string
  /** Admin-only free-text scratchpad, never rendered to the public. */
  privateNote: string
  mudWarning: boolean
  bestSeasons: string[]
  komootUrl: string
  // Entry-level GPX URL (shared across every variant of this walk's
  // source page). Undefined when the source doesn't publish one.
  gpx?: string
  // True when the walk needs a bus / taxi / heritage rail on the
  // return leg, or when one end isn't a mainline station. Rendered
  // as a destructive `bus` chip and sorts to the bottom of the CMS
  // list — these walks are NEVER shown to the public.
  requiresBus?: boolean
  rating: number | null
  source?: {
    orgSlug: string
    pageName: string
    pageURL: string
    type: string
  }
  /** Admin-only cross-reference. Same shape as `source` but
   *  optional. Never rendered in public prose. */
  relatedSource?: {
    orgSlug: string
    pageName: string
    pageURL: string
    type: string
  }
  previousWalkDates?: string[]
}

// The editable subset — the card's draft state only tracks these. Any
// other field on WalkPayload is read-only, so drift between server and
// UI stays impossible.
// Editable sight row — mirrors the server-side cleanSight() shape.
type SightDraft = { name: string; url: string; description: string }
// Editable lunch stop — mirrors cleanLunchStop() shape. `rating` is
// "" when unset so the same empty-string → unset pattern covers all
// the optional text fields uniformly.
type LunchRating = "" | "good" | "fine" | "poor"
type LunchDraft = {
  name: string
  location: string
  url: string
  notes: string
  rating: LunchRating
  busy: boolean
}

type EditableFields = {
  name: string       // legacy override — full title replacement
  suffix: string     // appended to derived title: "{start} to {end} {suffix}"
  komootUrl: string
  bestSeasons: string[]
  mudWarning: boolean
  warnings: string
  trainTips: string
  privateNote: string
  rating: number | null
  terrain: string
  distanceKm: number | null
  hours: number | null
  sights: SightDraft[]
  lunchStops: LunchDraft[]
  // Source provenance — all four fields editable. orgSlug comes from
  // sources.json (organisation registry); type is a small enum
  // (main/shorter/longer/alternative/variant). We default missing
  // fields to empty strings so the form stays controlled; the server
  // rejects blanks on save.
  source: {
    orgSlug: string
    pageName: string
    pageURL: string
    type: string
  }
  // Related source — admin cross-reference, same shape as `source`
  // but deletable. Draft-level this is always a fully-populated
  // object (defaulting to empty strings) so the form stays
  // controlled; the server deletes the field when all strings are
  // blank via the cleanSource → no-op path.
  relatedSource: {
    orgSlug: string
    pageName: string
    pageURL: string
    type: string
  }
}

// Swap two items in an array by index. Returns a NEW array — never
// mutates. Used by the up/down reorder arrows on sights/lunch/walks
// list editors. Bounds checks are the caller's responsibility
// (button is disabled at edges).
function arrayMove<T>(arr: T[], from: number, to: number): T[] {
  if (from === to) return arr
  const next = [...arr]
  const [item] = next.splice(from, 1)
  next.splice(to, 0, item)
  return next
}

// Hydrate the list-editor draft from the server payload. We fill in
// empty strings for optional fields so the form inputs always have a
// controlled value, mirroring the pattern used for the scalar fields
// above. cleanSight/cleanLunchStop on the server strip them back out.
function sightsToDraft(list: WalkPayload["sights"]): SightDraft[] {
  return list.map((s) => ({
    name: s.name ?? "",
    url: s.url ?? "",
    description: s.description ?? "",
  }))
}
function lunchToDraft(list: WalkPayload["lunchStops"]): LunchDraft[] {
  return list.map((s) => ({
    name: s.name ?? "",
    location: s.location ?? "",
    url: s.url ?? "",
    notes: s.notes ?? "",
    rating: (s.rating === "good" || s.rating === "fine" || s.rating === "poor"
      ? s.rating
      : "") as LunchRating,
    busy: s.busy === true,
  }))
}

// Build the derived title from station names + optional suffix.
// Falls back to source.pageName when stations aren't resolved (rare).
// Mirrors the resolution order in scripts/build-rambler-notes.mjs so
// the admin preview matches the rendered prose.
function derivedTitleOf(
  w: Pick<WalkPayload, "startStation" | "endStation" | "startStationName" | "endStationName" | "source" | "pageTitle">,
  suffix: string,
) {
  let base: string
  if (w.startStationName && w.endStationName) {
    base =
      w.startStation === w.endStation
        ? `${w.startStationName} Circular`
        : `${w.startStationName} to ${w.endStationName}`
  } else {
    base = w.source?.pageName ?? w.pageTitle
  }
  const s = suffix.trim()
  return s ? `${base} ${s}` : base
}

// Derived orgs list from sources.json — filters out the `_readme`
// documentation key so the dropdown only shows real organisations.
const SOURCE_ORGS: { slug: string; name: string }[] = Object.entries(sourcesJson)
  .filter(([k]) => k !== "_readme")
  .map(([slug, meta]) => ({
    slug,
    name: (meta as { name?: string })?.name ?? slug,
  }))
  .sort((a, b) => a.name.localeCompare(b.name))

// Type priority — dictates BOTH the dropdown order and the walk
// sort order (higher-priority types bubble up). Keep this single
// source of truth in step with TYPE_PRIORITY on the server
// (app/api/dev/walks-for-station/route.ts) and the build script
// (scripts/build-rambler-notes.mjs).
const SOURCE_TYPES: { value: string; label: string }[] = [
  { value: "main",        label: "Main walk" },
  { value: "shorter",     label: "Shorter variant" },
  { value: "alternative", label: "Alternative variant" },
  { value: "variant",     label: "Variant" },
  { value: "longer",      label: "Longer variant" },
  { value: "similar",     label: "Similar to" },
  { value: "adapted",     label: "Adapted from" },
]

// Rating-level icons — mirror the map marker shapes used in the
// filter panel (components/filter-panel.tsx:109). Kept inline here
// rather than extracted to a shared module because there's only one
// other consumer today; if a third caller shows up, promote to
// components/rating-icons.tsx and import from both sites.
//
// The `filled` prop drives primary-colour fill when active; otherwise
// the icon renders as a muted outline so the four buttons read as a
// row of pickable tiers rather than a scale.
function RatingIcon({ n, filled }: { n: 1 | 2 | 3 | 4; filled: boolean }) {
  const fill = filled ? "var(--primary)" : "none"
  const stroke = filled ? "var(--primary)" : "currentColor"
  const common = { fill, stroke, strokeWidth: 1.5, className: "w-4 h-4" } as const
  switch (n) {
    case 1: // down-pointing triangle — "Okay"
      return (
        <svg viewBox="0 0 24 24" {...common}>
          <polygon points="12 21, 22.39 3, 1.61 3" />
        </svg>
      )
    case 2: // hexagon — "Probably"
      return (
        <svg viewBox="1 2 22 20" {...common}>
          <polygon points="22,12 17,20.66 7,20.66 2,12 7,3.34 17,3.34" />
        </svg>
      )
    case 3: // up-pointing triangle — "Good"
      return (
        <svg viewBox="0 0 24 24" {...common}>
          <polygon points="12 3, 22.39 21, 1.61 21" />
        </svg>
      )
    case 4: // star — "Heavenly"
      return (
        <svg viewBox="1 1 22 22" {...common}>
          <polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2" />
        </svg>
      )
  }
}

// Walk-rating labels. Deliberately distinct from the station-rating
// tier names in components/filter-panel.tsx (Okay/Probably/Good/
// Heavenly) — these label walks, those label stations, and the user
// wants the vocabulary to read differently.
const RATING_LABELS: Record<1 | 2 | 3 | 4, string> = {
  1: "Flawed",
  2: "Pleasant",
  3: "Charming",
  4: "Sublime",
}

const MONTHS = [
  { code: "jan", short: "J" }, { code: "feb", short: "F" },
  { code: "mar", short: "M" }, { code: "apr", short: "A" },
  { code: "may", short: "M" }, { code: "jun", short: "J" },
  { code: "jul", short: "J" }, { code: "aug", short: "A" },
  { code: "sep", short: "S" }, { code: "oct", short: "O" },
  { code: "nov", short: "N" }, { code: "dec", short: "D" },
] as const

// Collapsed-header headline: prefer the admin's custom override
// (walk.name), then the derived `{start} to {end} {suffix}` title,
// then a bare start→end CRS pair, then the source page name.
function cardHeadline(w: WalkPayload) {
  if (w.name?.trim()) return w.name.trim()
  return derivedTitleOf(w, w.suffix ?? "")
}

export default function WalksAdminPanel({
  stationCrs,
  onSaved,
}: {
  stationCrs: string
  /** Called after a successful save so the parent can refresh its
   *  station-notes state and surface the regenerated ramblerNote. */
  onSaved?: () => void | Promise<void>
}) {
  const [walks, setWalks] = useState<WalkPayload[] | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  // Dialog visibility flags — plain local booleans so we don't
  // need a whole state machine.
  const [infoOpen, setInfoOpen] = useState(false)
  const [creating, setCreating] = useState(false)

  // Fetch walks whenever the station CRS changes. The endpoint returns
  // [] for stations with no attached walks — still a valid response, so
  // we distinguish "loading" from "no walks here" in the render.
  useEffect(() => {
    let cancelled = false
    setLoading(true)
    setError(null)
    fetch(`/api/dev/walks-for-station?crs=${encodeURIComponent(stationCrs)}`)
      .then((r) => { if (!r.ok) throw new Error(`HTTP ${r.status}`); return r.json() })
      .then((data: WalkPayload[]) => { if (!cancelled) setWalks(data) })
      .catch((e) => { if (!cancelled) setError(e.message) })
      .finally(() => { if (!cancelled) setLoading(false) })
    return () => { cancelled = true }
  }, [stationCrs])

  // Per-card save path. We refetch the full walks list on success so
  // the displayed fields reflect the server's canonical shape (e.g.
  // month codes reordered, empty strings dropped).
  const handleSaved = useCallback(async () => {
    // Refetch walks for this station — server-side cleanups might have
    // modified what we sent (e.g. dedupe, sort bestSeasons).
    try {
      const r = await fetch(`/api/dev/walks-for-station?crs=${encodeURIComponent(stationCrs)}`)
      if (r.ok) setWalks(await r.json())
    } catch { /* best-effort */ }
    if (onSaved) await onSaved()
  }, [stationCrs, onSaved])

  // Create a new manual walk at this station (circular — start + end
  // default to the current station's CRS). The admin fills in the
  // details via the normal card editor after it appears in the list.
  const handleCreate = useCallback(async () => {
    setCreating(true)
    try {
      const r = await fetch("/api/dev/walk/create", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ startStation: stationCrs, endStation: stationCrs }),
      })
      if (!r.ok) throw new Error(`HTTP ${r.status}`)
      await handleSaved()
    } catch (e) {
      // eslint-disable-next-line no-console
      console.error("create walk failed:", e)
    } finally {
      setCreating(false)
    }
  }, [stationCrs, handleSaved])

  // Delete a walk. Called from inside a WalkCard's confirm flow.
  const handleDelete = useCallback(async (id: string) => {
    const r = await fetch(`/api/dev/walk/${id}`, { method: "DELETE" })
    if (!r.ok) throw new Error(`HTTP ${r.status}`)
    await handleSaved()
  }, [handleSaved])


  return (
    <div className="mt-[var(--para-gap)] rounded-md border border-dashed border-orange-400 bg-orange-50/50 px-3 py-3 dark:bg-orange-950/10">
      {/* Header row — label on the left, info button + "+ New walk"
          button on the right. flex + items-center keeps the buttons
          baseline-aligned with the label. */}
      <div className="flex items-center gap-2">
        <p className="text-xs font-medium text-muted-foreground">
          Walks{walks ? ` (${walks.length})` : ""}
        </p>
        <button
          type="button"
          onClick={() => setInfoOpen(true)}
          className="flex h-4 w-4 cursor-pointer items-center justify-center rounded-full border border-muted-foreground/40 text-[10px] text-muted-foreground hover:bg-muted/60"
          title="How are walks ordered and filtered?"
          aria-label="How are walks ordered and filtered?"
        >
          i
        </button>
        <button
          type="button"
          onClick={handleCreate}
          disabled={creating}
          className="ml-auto rounded border border-dashed border-border px-2 py-0.5 text-[11px] text-muted-foreground hover:bg-muted/40 disabled:opacity-40"
        >
          {creating ? "Creating…" : "+ New walk"}
        </button>
      </div>
      {loading && <p className="mt-1 text-xs italic text-muted-foreground">Loading…</p>}
      {error && <p className="mt-1 text-xs text-destructive">Failed to load: {error}</p>}
      {walks && walks.length === 0 && (
        <p className="mt-1 text-xs italic text-muted-foreground">
          No walks attached to this station yet.
        </p>
      )}
      {walks && walks.length > 0 && (
        <div className="mt-2 flex flex-col gap-1.5">
          {walks.map((w) => (
            <WalkCard key={w.id} walk={w} onSaved={handleSaved} onDelete={handleDelete} />
          ))}
        </div>
      )}

      {/* Info dialog — explains the ordering + filtering rules so
          the admin can reconcile what they see against what a
          visitor sees. Kept in sync with
          scripts/build-rambler-notes.mjs (filter) and
          app/api/dev/walks-for-station/route.ts (CMS sort). */}
      <Dialog open={infoOpen} onOpenChange={setInfoOpen}>
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>Walks — order + visibility</DialogTitle>
            <DialogDescription>
              How the app decides which walks to show, and in what order.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4 text-sm text-foreground">
            <div>
              <p className="mb-1 font-medium">CMS order (admin-only, this panel)</p>
              <ol className="list-decimal space-y-0.5 pl-5 text-xs text-muted-foreground">
                <li><span className="font-mono text-foreground">bus</span> walks sink to the bottom</li>
                <li>Komoot-linked walks come first</li>
                <li>Main walks first (no further subtype ordering)</li>
                <li>Higher rating first (4 → 3 → 2 → unrated → 1)</li>
                <li>Distance closest to 10 km first</li>
                <li>Alphabetic tiebreak</li>
              </ol>
            </div>
            <div>
              <p className="mb-1 font-medium">What the public sees</p>
              <ul className="list-disc space-y-0.5 pl-5 text-xs text-muted-foreground">
                <li><strong>Always shown:</strong> every main walk + every Note.</li>
                <li><strong>Never shown:</strong> walks tagged <span className="font-mono">bus</span> (needs a bus/taxi/heritage rail).</li>
                <li>
                  <strong>Variants fill the list up to 5 walks total:</strong>
                  <ul className="mt-0.5 list-disc space-y-0.5 pl-5">
                    <li>If the station has <strong>5+ main walks</strong>, no variants are shown.</li>
                    <li>Otherwise we add top-ranked variants until there are 5 walks shown, or until there are no more variants.</li>
                  </ul>
                </li>
              </ul>
            </div>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  )
}

// Single walk card. Collapsed by default — click the header to expand.
// Drafts are kept in local state so keystrokes don't round-trip until
// the user hits Save.
function WalkCard({
  walk,
  onSaved,
  onDelete,
}: {
  walk: WalkPayload
  onSaved: () => void | Promise<void>
  /** Delete this walk by id. Wrapped in a ConfirmDialog so the
   *  admin can't nuke a walk with a single misclick. */
  onDelete?: (id: string) => void | Promise<void>
}) {
  const [expanded, setExpanded] = useState(false)
  const [saving, setSaving] = useState(false)
  const [saveError, setSaveError] = useState<string | null>(null)
  const [confirmDeleteOpen, setConfirmDeleteOpen] = useState(false)
  // Related Source section — admin cross-reference, collapsed by
  // default. Auto-expand when the walk already has a related source
  // set so the admin sees it on open.
  const [relatedSourceExpanded, setRelatedSourceExpanded] = useState(
    !!(walk.relatedSource && (walk.relatedSource.orgSlug || walk.relatedSource.pageName || walk.relatedSource.pageURL)),
  )

  // Draft state — initialised from the walk prop. useMemo keeps a
  // stable reference to the "server shape" for dirty-comparison.
  const serverState: EditableFields = useMemo(
    () => ({
      name: walk.name,
      suffix: walk.suffix,
      komootUrl: walk.komootUrl,
      bestSeasons: walk.bestSeasons,
      mudWarning: walk.mudWarning,
      warnings: walk.warnings,
      trainTips: walk.trainTips,
      privateNote: walk.privateNote ?? "",
      rating: walk.rating,
      terrain: walk.terrain,
      distanceKm: walk.distanceKm,
      hours: walk.hours,
      sights: sightsToDraft(walk.sights),
      lunchStops: lunchToDraft(walk.lunchStops),
      source: {
        orgSlug: walk.source?.orgSlug ?? "",
        pageName: walk.source?.pageName ?? "",
        pageURL: walk.source?.pageURL ?? "",
        type: walk.source?.type ?? "variant",
      },
      relatedSource: {
        orgSlug: walk.relatedSource?.orgSlug ?? "",
        pageName: walk.relatedSource?.pageName ?? "",
        pageURL: walk.relatedSource?.pageURL ?? "",
        type: walk.relatedSource?.type ?? "variant",
      },
    }),
    [
      walk.name, walk.suffix, walk.komootUrl, walk.bestSeasons, walk.mudWarning,
      walk.warnings, walk.trainTips, walk.privateNote, walk.rating, walk.terrain,
      walk.distanceKm, walk.hours,
      walk.sights, walk.lunchStops,
      walk.source?.orgSlug, walk.source?.pageName, walk.source?.pageURL, walk.source?.type,
      walk.relatedSource?.orgSlug, walk.relatedSource?.pageName, walk.relatedSource?.pageURL, walk.relatedSource?.type,
    ],
  )
  const [draft, setDraft] = useState<EditableFields>(serverState)
  // Re-sync draft when the walk prop updates (e.g. after a save refetch
  // reshapes month ordering). Only overwrites if the draft matches the
  // prior server state — otherwise the user has unsaved edits we
  // shouldn't clobber.
  useEffect(() => { setDraft(serverState) }, [serverState])

  const dirty = useMemo(() => {
    return (
      draft.name.trim() !== serverState.name.trim() ||
      draft.suffix.trim() !== serverState.suffix.trim() ||
      draft.komootUrl.trim() !== serverState.komootUrl.trim() ||
      draft.mudWarning !== serverState.mudWarning ||
      draft.warnings.trim() !== serverState.warnings.trim() ||
      draft.trainTips.trim() !== serverState.trainTips.trim() ||
      draft.privateNote.trim() !== serverState.privateNote.trim() ||
      draft.rating !== serverState.rating ||
      draft.terrain.trim() !== serverState.terrain.trim() ||
      draft.distanceKm !== serverState.distanceKm ||
      draft.hours !== serverState.hours ||
      // Array compare — order-sensitive but the server returns them in
      // calendar order, so both sides are stable.
      JSON.stringify(draft.bestSeasons) !== JSON.stringify(serverState.bestSeasons) ||
      // List editors: deep-compare via JSON. The drafts carry empty
      // strings for absent optionals (see sightsToDraft/lunchToDraft)
      // and the server shape strips them, so we compare drafts to
      // drafts by hydrating the server state through the same helpers
      // via useMemo above.
      JSON.stringify(draft.sights) !== JSON.stringify(serverState.sights) ||
      JSON.stringify(draft.lunchStops) !== JSON.stringify(serverState.lunchStops) ||
      JSON.stringify(draft.source) !== JSON.stringify(serverState.source) ||
      JSON.stringify(draft.relatedSource) !== JSON.stringify(serverState.relatedSource)
    )
  }, [draft, serverState])

  const toggleSeason = useCallback((code: string) => {
    setDraft((d) => {
      const has = d.bestSeasons.includes(code)
      const next = has ? d.bestSeasons.filter((c) => c !== code) : [...d.bestSeasons, code]
      // Reorder into calendar order so the chip row is stable as users
      // toggle months in any sequence. Widen to string[] — MONTHS is
      // `as const` so its .code is a literal union, but we're indexing
      // into it with the draft's generic string codes.
      const order: string[] = MONTHS.map((m) => m.code)
      next.sort((a, b) => order.indexOf(a) - order.indexOf(b))
      return { ...d, bestSeasons: next }
    })
  }, [])

  const onSave = useCallback(async () => {
    setSaving(true)
    setSaveError(null)
    try {
      // Send null for cleared numeric fields so the server can delete
      // the key. The whitelist in the PATCH route treats undefined
      // returns from cleanField() as "drop this field", and a null
      // input flows through to that path.
      const r = await fetch(`/api/dev/walk/${walk.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: draft.name,
          suffix: draft.suffix,
          komootUrl: draft.komootUrl,
          bestSeasons: draft.bestSeasons,
          mudWarning: draft.mudWarning,
          warnings: draft.warnings,
          trainTips: draft.trainTips,
          privateNote: draft.privateNote,
          rating: draft.rating,
          terrain: draft.terrain,
          distanceKm: draft.distanceKm,
          hours: draft.hours,
          // The server cleanSight/cleanLunchStop drop rows with empty
          // names and strip empty optional fields — we send the raw
          // drafts as-is and trust the server-side filter.
          sights: draft.sights,
          lunchStops: draft.lunchStops,
          source: draft.source,
          relatedSource: draft.relatedSource,
        }),
      })
      if (!r.ok) throw new Error(`HTTP ${r.status}: ${await r.text()}`)
      await onSaved()
    } catch (e) {
      setSaveError(e instanceof Error ? e.message : String(e))
    } finally {
      setSaving(false)
    }
  }, [walk.id, draft, onSaved])

  return (
    <div className="rounded border border-border bg-background">
      {/* Card header — click to expand. Walk ordering is automatic
          (rating tier → komoot → most-recently-edited) and can't be
          overridden from here, so the row is purely a toggle. */}
      <button
        type="button"
        onClick={() => setExpanded((v) => !v)}
        className="flex w-full items-center gap-2 px-2 py-1.5 text-left text-xs hover:bg-muted/40"
      >
        <span className={`inline-block transition-transform ${expanded ? "rotate-90" : ""}`}>▸</span>
        <code className="rounded bg-muted px-1 py-0.5 font-mono text-[10px] text-muted-foreground">
          {walk.id}
        </code>
        <span className="truncate font-medium text-foreground">{cardHeadline(walk)}</span>
        {/* Inline metadata chips, visible while the card is collapsed
            so admins can scan walk properties at a glance without
            expanding each one.
            - variant / shorter / longer / alternative (nothing for
              "main" — main is the default, no flag needed)
            - komoot / GPX — flag which external route is available
            - distance — floored to km to match the public prose
              rendering in scripts/build-rambler-notes.mjs
            flex-shrink-0 keeps them from being squeezed when the
            title string gets long; the title's `truncate` absorbs
            the overflow instead. */}
        {(() => {
          const walkType = walk.source?.type ?? walk.role
          const isVariant = walkType && walkType !== "main"
          // Base pill styling — muted grey, shared across chip types.
          // Destructive chips (variant, bus) override the bg/text via
          // the same token pair used by the destructive Button variant
          // so the color stays on-theme in both light + dark mode via
          // CSS custom properties.
          const chipBase = "shrink-0 rounded px-1 py-0.5 font-mono text-[10px]"
          const neutralChip = `${chipBase} bg-muted text-muted-foreground`
          const destructiveChip = `${chipBase} bg-destructive/10 text-destructive`
          return (
            <>
              {walk.requiresBus && (
                <span className={destructiveChip} title="Requires a bus / taxi / heritage rail — never shown publicly">
                  bus
                </span>
              )}
              {isVariant && <span className={destructiveChip} title={`Source type: ${walkType}`}>{walkType}</span>}
              {walk.komootUrl && <span className={neutralChip} title="Has a Komoot tour URL">komoot</span>}
              {walk.gpx && <span className={neutralChip} title="Source page publishes a GPX track">GPX</span>}
              {typeof walk.distanceKm === "number" && (
                <span className={neutralChip} title={`${walk.distanceKm} km (floored for display)`}>
                  {Math.floor(walk.distanceKm)} km
                </span>
              )}
            </>
          )
        })()}
        {typeof walk.rating === "number" && walk.rating >= 1 && walk.rating <= 4 && (
          <span
            className="flex items-center text-orange-600"
            title={`${RATING_LABELS[walk.rating as 1 | 2 | 3 | 4]} (${walk.rating}/4)`}
            aria-label={`Rating: ${RATING_LABELS[walk.rating as 1 | 2 | 3 | 4]}`}
          >
            <RatingIcon n={walk.rating as 1 | 2 | 3 | 4} filled />
          </span>
        )}
        {dirty && <span className="ml-auto h-1.5 w-1.5 rounded-full bg-orange-500" aria-label="unsaved changes" />}
      </button>

      {expanded && (
        <div className="border-t border-border px-3 py-3 text-xs">
          {/* Source — editable block: which organisation this walk
              came from, the original page title + URL, and the
              walk's type relative to that page (main / variant). The
              render pipeline uses source.type to emit the "A shorter
              variant of [X](url)." clause; source.pageName/pageURL
              populate the link. */}
          <div className="mb-3 rounded border border-border/60 bg-muted/30 px-2 py-2">
            <div className="mb-1.5 text-[10px] uppercase tracking-wide text-muted-foreground">
              Source
            </div>
            <div className="grid grid-cols-2 gap-1.5">
              {/* Organisation — dropdown of slugs from sources.json.
                  Adding a new org requires editing data/sources.json
                  by hand (no UI for that yet). */}
              <div>
                <Label htmlFor={`src-org-${walk.id}`} className="mb-1 block text-[10px] text-muted-foreground">
                  Organisation
                </Label>
                <select
                  id={`src-org-${walk.id}`}
                  value={draft.source.orgSlug}
                  onChange={(e) => setDraft((d) => ({
                    ...d, source: { ...d.source, orgSlug: e.target.value },
                  }))}
                  className="h-7 w-full rounded-lg border border-input bg-input/30 px-2 text-xs"
                >
                  {!SOURCE_ORGS.some((o) => o.slug === draft.source.orgSlug) && draft.source.orgSlug && (
                    <option value={draft.source.orgSlug}>{draft.source.orgSlug} (unknown)</option>
                  )}
                  {SOURCE_ORGS.map((o) => (
                    <option key={o.slug} value={o.slug}>{o.name}</option>
                  ))}
                </select>
              </div>
              {/* Type — fixed enum. Drives the "A longer variant
                  of…" clause in the rendered prose. */}
              <div>
                <Label htmlFor={`src-type-${walk.id}`} className="mb-1 block text-[10px] text-muted-foreground">
                  Type
                </Label>
                <select
                  id={`src-type-${walk.id}`}
                  value={draft.source.type}
                  onChange={(e) => setDraft((d) => ({
                    ...d, source: { ...d.source, type: e.target.value },
                  }))}
                  className="h-7 w-full rounded-lg border border-input bg-input/30 px-2 text-xs"
                >
                  {SOURCE_TYPES.map((t) => (
                    <option key={t.value} value={t.value}>{t.label}</option>
                  ))}
                </select>
              </div>
            </div>
            <div className="mt-1.5 space-y-1.5">
              <Input
                value={draft.source.pageName}
                onChange={(e) => setDraft((d) => ({
                  ...d, source: { ...d.source, pageName: e.target.value },
                }))}
                placeholder="Page name (e.g. Milford to Haslemere)"
                className="h-7 text-xs"
              />
              <Input
                type="url"
                value={draft.source.pageURL}
                onChange={(e) => setDraft((d) => ({
                  ...d, source: { ...d.source, pageURL: e.target.value },
                }))}
                placeholder="Page URL"
                className="h-7 text-xs"
              />
            </div>

            {/* Related Source — collapsible admin-only cross-reference.
                Same four fields as the primary Source, but entirely
                optional: the server drops the whole `relatedSource`
                key when all fields are blank. Never rendered in
                public prose; purely a curation aid to link related
                walk pages together. */}
            <div className="mt-2 border-t border-border/60 pt-2">
              <button
                type="button"
                onClick={() => setRelatedSourceExpanded((v) => !v)}
                aria-expanded={relatedSourceExpanded}
                aria-controls={`related-source-body-${walk.id}`}
                className="flex w-full items-center gap-1 text-left text-[10px] uppercase tracking-wide text-muted-foreground hover:text-foreground"
              >
                <span
                  aria-hidden="true"
                  className={`inline-block transition-transform ${relatedSourceExpanded ? "rotate-90" : ""}`}
                >
                  ▸
                </span>
                Related source
                {(draft.relatedSource.orgSlug || draft.relatedSource.pageName || draft.relatedSource.pageURL) && (
                  <span className="italic text-muted-foreground/70 normal-case">(set)</span>
                )}
              </button>
              {relatedSourceExpanded && (
                <div id={`related-source-body-${walk.id}`} className="mt-1.5">
                  <div className="grid grid-cols-2 gap-1.5">
                    <div>
                      <Label htmlFor={`rsrc-org-${walk.id}`} className="mb-1 block text-[10px] text-muted-foreground">
                        Organisation
                      </Label>
                      <select
                        id={`rsrc-org-${walk.id}`}
                        value={draft.relatedSource.orgSlug}
                        onChange={(e) => setDraft((d) => ({
                          ...d, relatedSource: { ...d.relatedSource, orgSlug: e.target.value },
                        }))}
                        className="h-7 w-full rounded-lg border border-input bg-input/30 px-2 text-xs"
                      >
                        {/* Empty option so the admin can clear the
                            whole related-source block; server then
                            deletes the field on save. */}
                        <option value="">— none —</option>
                        {!SOURCE_ORGS.some((o) => o.slug === draft.relatedSource.orgSlug) && draft.relatedSource.orgSlug && (
                          <option value={draft.relatedSource.orgSlug}>{draft.relatedSource.orgSlug} (unknown)</option>
                        )}
                        {SOURCE_ORGS.map((o) => (
                          <option key={o.slug} value={o.slug}>{o.name}</option>
                        ))}
                      </select>
                    </div>
                    <div>
                      <Label htmlFor={`rsrc-type-${walk.id}`} className="mb-1 block text-[10px] text-muted-foreground">
                        Type
                      </Label>
                      <select
                        id={`rsrc-type-${walk.id}`}
                        value={draft.relatedSource.type}
                        onChange={(e) => setDraft((d) => ({
                          ...d, relatedSource: { ...d.relatedSource, type: e.target.value },
                        }))}
                        className="h-7 w-full rounded-lg border border-input bg-input/30 px-2 text-xs"
                      >
                        {SOURCE_TYPES.map((t) => (
                          <option key={t.value} value={t.value}>{t.label}</option>
                        ))}
                      </select>
                    </div>
                  </div>
                  <div className="mt-1.5 space-y-1.5">
                    <Input
                      value={draft.relatedSource.pageName}
                      onChange={(e) => setDraft((d) => ({
                        ...d, relatedSource: { ...d.relatedSource, pageName: e.target.value },
                      }))}
                      placeholder="Related page name"
                      className="h-7 text-xs"
                    />
                    <Input
                      type="url"
                      value={draft.relatedSource.pageURL}
                      onChange={(e) => setDraft((d) => ({
                        ...d, relatedSource: { ...d.relatedSource, pageURL: e.target.value },
                      }))}
                      placeholder="Related page URL"
                      className="h-7 text-xs"
                    />
                  </div>
                </div>
              )}
            </div>
          </div>

          {/* Title preview (read-only) + Suffix input + Custom-title
              override. The title is normally derived from the start
              and end station names ("Milford to Haslemere"), plus an
              optional admin-authored suffix ("via Ightham Mote").
              The custom-title input exists for edge cases where the
              walk's name doesn't fit the derived pattern (e.g.
              "Short Walk, omitting Old Warden") — when set it
              replaces the whole title. */}
          {(() => {
            const effectiveTitle = draft.name.trim()
              ? draft.name.trim()
              : derivedTitleOf(walk, draft.suffix)
            return (
              <div className="mb-3 rounded border border-border/60 bg-muted/30 px-2 py-1.5">
                <div className="text-[10px] uppercase tracking-wide text-muted-foreground">
                  Title preview
                </div>
                <div className="text-sm font-medium text-foreground">{effectiveTitle}</div>
              </div>
            )
          })()}

          {/* Suffix — appended to the derived title with a leading
              space. Ignored when a custom title override is set. */}
          <div className="mb-3">
            <Label htmlFor={`suffix-${walk.id}`} className="mb-1 block text-xs text-muted-foreground">
              Suffix
              {draft.name.trim() && (
                <span className="ml-1 italic text-muted-foreground/70">
                  (ignored while custom title is set)
                </span>
              )}
            </Label>
            <Input
              id={`suffix-${walk.id}`}
              value={draft.suffix}
              onChange={(e) => setDraft((d) => ({ ...d, suffix: e.target.value }))}
              placeholder="e.g. via Ightham Mote"
              className="h-7 text-xs"
              disabled={!!draft.name.trim()}
            />
          </div>

          {/* Custom title — full override. Leave blank to use the
              derived title + suffix above. Used mainly by legacy
              walks whose names don't fit the "{start} to {end}"
              pattern (e.g. Leicester Ramblers walks). */}
          <div className="mb-3">
            <Label htmlFor={`name-${walk.id}`} className="mb-1 block text-xs text-muted-foreground">
              Custom title
              <span className="ml-1 italic text-muted-foreground/70">
                (overrides derived title)
              </span>
            </Label>
            <Input
              id={`name-${walk.id}`}
              value={draft.name}
              onChange={(e) => setDraft((d) => ({ ...d, name: e.target.value }))}
              placeholder="Leave blank to use derived title"
              className="h-7 text-xs"
            />
          </div>

          {/* ── Structured editors ─────────────────────────────────── */}

          {/* Rating — five clickable star buttons. Tapping the current
              rating again clears it back to "unrated" (null). Backfill
              seeded every variant of a favourite page with 3, so most
              walks start at 0 or 3 until the admin curates further. */}
          {/* Rating — four tier icons (Okay / Probably / Rambler
              favourite / Heavenly). Unlike a star scale, these are
              distinct symbols for distinct tiers, so only the selected
              tier lights up rather than all icons ≤ N. Clicking the
              active icon clears the rating. */}
          <div className="mb-3">
            <Label className="mb-1 block text-xs text-muted-foreground">Rating</Label>
            <div className="flex items-center gap-1.5">
              {([1, 2, 3, 4] as const).map((n) => {
                const active = draft.rating === n
                return (
                  <button
                    key={n}
                    type="button"
                    onClick={() =>
                      setDraft((d) => ({
                        ...d,
                        // Clicking the current rating again clears it.
                        rating: d.rating === n ? null : n,
                      }))
                    }
                    title={`${RATING_LABELS[n]} (${n}/4)`}
                    aria-label={`${RATING_LABELS[n]} — ${n} of 4`}
                    aria-pressed={active}
                    className={
                      "flex h-7 w-7 items-center justify-center rounded transition-colors " +
                      (active
                        ? "bg-orange-50 text-orange-600 dark:bg-orange-950/20"
                        : "text-muted-foreground hover:bg-muted/50")
                    }
                  >
                    <RatingIcon n={n} filled={active} />
                  </button>
                )
              })}
              {typeof draft.rating === "number" && (
                <span className="ml-1 text-[11px] text-muted-foreground">
                  {RATING_LABELS[draft.rating as 1 | 2 | 3 | 4]}
                </span>
              )}
            </div>
          </div>

          {/* Terrain — comma-separated list of short tags (no
              punctuation). The build script joins them with commas +
              "and" and tacks on a period, so the admin just types the
              items: "Chalk downland, bluebell woods, open farmland".
              The renderer handles the rest ("Chalk downland, bluebell
              woods, and open farmland."). */}
          <div className="mb-3">
            <Label htmlFor={`terrain-${walk.id}`} className="mb-1 block text-xs text-muted-foreground">
              Terrain
              <span className="ml-1 font-normal italic text-muted-foreground/70">
                comma-separated, no punctuation
              </span>
            </Label>
            <Input
              id={`terrain-${walk.id}`}
              value={draft.terrain}
              onChange={(e) => setDraft((d) => ({ ...d, terrain: e.target.value }))}
              placeholder="e.g. chalk downland, bluebell woods, open farmland"
              className="h-7 text-xs"
            />
          </div>

          {/* Sights editor — one row per sight. Name is required; URL
              and description are optional. Description is admin-only
              metadata for now (rendered prose doesn't include it). */}
          <SightsEditor
            walkId={walk.id}
            sights={draft.sights}
            onChange={(sights) => setDraft((d) => ({ ...d, sights }))}
          />

          {/* Lunch stops editor — name + location + url + notes +
              rating. notes/rating are admin-only metadata (the prose
              renderer still shows only the first three). */}
          <LunchStopsEditor
            walkId={walk.id}
            stops={draft.lunchStops}
            onChange={(lunchStops) => setDraft((d) => ({ ...d, lunchStops }))}
          />

          {/* Distance + hours — three number inputs side by side. Empty
              input maps to null (clears the field). Komoot URL, when
              set, suppresses these clauses in the rendered prose. */}
          <div className="mb-3 grid grid-cols-2 gap-2">
            <div>
              <Label htmlFor={`km-${walk.id}`} className="mb-1 block text-xs text-muted-foreground">
                km
              </Label>
              <Input
                id={`km-${walk.id}`}
                type="number"
                step="0.1"
                value={draft.distanceKm ?? ""}
                onChange={(e) => {
                  const v = e.target.value
                  setDraft((d) => ({ ...d, distanceKm: v === "" ? null : Number(v) }))
                }}
                className="h-7 text-xs"
              />
            </div>
            <div>
              <Label htmlFor={`hrs-${walk.id}`} className="mb-1 block text-xs text-muted-foreground">
                hours
              </Label>
              <Input
                id={`hrs-${walk.id}`}
                type="number"
                step="0.25"
                value={draft.hours ?? ""}
                onChange={(e) => {
                  const v = e.target.value
                  setDraft((d) => ({ ...d, hours: v === "" ? null : Number(v) }))
                }}
                className="h-7 text-xs"
              />
            </div>
          </div>

          {/* Month chips — 12 buttons in a row. Clicking toggles.
              Active months get a filled orange fill matching the admin
              accent; inactive are ghost-outlined. */}
          <div className="mb-3">
            <Label className="mb-1.5 block text-xs text-muted-foreground">Best seasons</Label>
            <div className="flex flex-wrap gap-1">
              {MONTHS.map((m) => {
                const active = draft.bestSeasons.includes(m.code)
                return (
                  <button
                    key={m.code}
                    type="button"
                    onClick={() => toggleSeason(m.code)}
                    aria-pressed={active}
                    title={m.code}
                    className={
                      "h-6 w-6 rounded text-[11px] font-medium transition-colors " +
                      (active
                        ? "bg-orange-500 text-white hover:bg-orange-600"
                        : "border border-border bg-background text-muted-foreground hover:bg-muted/60")
                    }
                  >
                    {m.short}
                  </button>
                )
              })}
            </div>
          </div>

          {/* Mud warning — single boolean. When true the build emits
              "Can be muddy." and suppresses any duplicate free-text. */}
          <div className="mb-3 flex items-center gap-2">
            <Checkbox
              id={`mud-${walk.id}`}
              checked={draft.mudWarning}
              onCheckedChange={(v) => setDraft((d) => ({ ...d, mudWarning: v === true }))}
            />
            <Label htmlFor={`mud-${walk.id}`} className="cursor-pointer text-xs">
              Mud warning
            </Label>
          </div>

          {/* Komoot tour URL — when set, the build drops the km/hours
              line because Komoot provides the authoritative figures. */}
          <div className="mb-3">
            <Label htmlFor={`komoot-${walk.id}`} className="mb-1 block text-xs text-muted-foreground">
              Komoot URL
            </Label>
            <Input
              id={`komoot-${walk.id}`}
              type="url"
              value={draft.komootUrl}
              onChange={(e) => setDraft((d) => ({ ...d, komootUrl: e.target.value }))}
              placeholder="https://www.komoot.com/tour/…"
              className="h-7 text-xs"
            />
          </div>

          {/* Free-text warnings — still useful for non-mud stuff like
              "MOD closures apply" or "Chalk paths can be slippery". */}
          <div className="mb-3">
            <Label htmlFor={`warn-${walk.id}`} className="mb-1 block text-xs text-muted-foreground">
              Warnings
              <span className="ml-1 font-normal italic text-muted-foreground/70">
                free text
              </span>
            </Label>
            <Input
              id={`warn-${walk.id}`}
              value={draft.warnings}
              onChange={(e) => setDraft((d) => ({ ...d, warnings: e.target.value }))}
              placeholder="e.g. MOD closures apply"
              className="h-7 text-xs"
            />
          </div>

          {/* Train tips — booking advice (singles vs returns, off-peak
              windows etc). Renders in the public prose as its own
              sentence right after warnings. */}
          <div className="mb-3">
            <Label htmlFor={`tips-${walk.id}`} className="mb-1 block text-xs text-muted-foreground">
              Train tips
              <span className="ml-1 font-normal italic text-muted-foreground/70">
                free text
              </span>
            </Label>
            <Input
              id={`tips-${walk.id}`}
              value={draft.trainTips}
              onChange={(e) => setDraft((d) => ({ ...d, trainTips: e.target.value }))}
              placeholder="e.g. Buy two singles — cheaper than a return"
              className="h-7 text-xs"
            />
          </div>

          {/* Private note — admin-only scratchpad. Never rendered in
              public prose. Useful for curation TODOs ("distance
              conflicts between Komoot and SWC", "check after bridge
              reopens", etc). */}
          <div className="mb-3">
            <Label htmlFor={`priv-${walk.id}`} className="mb-1 block text-xs text-muted-foreground">
              Private note
              <span className="ml-1 font-normal italic text-muted-foreground/70">
                admin-only
              </span>
            </Label>
            <Input
              id={`priv-${walk.id}`}
              value={draft.privateNote}
              onChange={(e) => setDraft((d) => ({ ...d, privateNote: e.target.value }))}
              placeholder="e.g. distance figures disagree with Komoot"
              className="h-7 text-xs"
            />
          </div>

          {/* Save / delete footer — delete sits on the right and is
              gated behind a ConfirmDialog so a misclick doesn't
              nuke a walk. Delete only renders when the parent wired
              onDelete (it's the only surface that knows how to
              refresh the list afterwards). */}
          <div className="mt-3 flex items-center gap-2">
            <Button
              size="sm"
              onClick={onSave}
              disabled={!dirty || saving}
              className="h-7 text-xs"
            >
              {saving ? "Saving…" : "Save"}
            </Button>
            {saveError && <span className="text-xs text-destructive">{saveError}</span>}
            {onDelete && (
              <Button
                size="sm"
                variant="destructive"
                onClick={() => setConfirmDeleteOpen(true)}
                className="ml-auto h-7 text-xs"
              >
                Delete walk
              </Button>
            )}
          </div>
          {onDelete && (
            <ConfirmDialog
              open={confirmDeleteOpen}
              onOpenChange={setConfirmDeleteOpen}
              title="Delete this walk?"
              description={<>This removes <span className="font-mono">{walk.id}</span> from the source data entirely. Can't be undone from the UI.</>}
              confirmLabel="Delete walk"
              onConfirm={() => onDelete(walk.id)}
            />
          )}
        </div>
      )}
    </div>
  )
}

// ── List editors ──────────────────────────────────────────────────────────

// Sights: a simple repeatable list with name (required), URL and
// description (both optional). Rows with empty names are silently
// dropped server-side, so there's no validation UI in the client.
function SightsEditor({
  walkId,
  sights,
  onChange,
}: {
  walkId: string
  sights: SightDraft[]
  onChange: (next: SightDraft[]) => void
}) {
  // Collapsed by default — sights can bloat the card and most edits
  // happen on the scalar fields above. Clicking the header toggles.
  const [expanded, setExpanded] = useState(false)
  return (
    <div className="mb-3">
      <button
        type="button"
        onClick={() => setExpanded((v) => !v)}
        aria-expanded={expanded}
        aria-controls={`sights-body-${walkId}`}
        className="flex w-full items-center gap-1 text-left text-xs text-muted-foreground hover:text-foreground"
      >
        {/* Chevron rotates 0° collapsed / 90° expanded. `inline-block` so
            the transform applies; matches the arrow iconography used
            elsewhere in the card. */}
        <span
          aria-hidden="true"
          className={`inline-block transition-transform ${expanded ? "rotate-90" : ""}`}
        >
          ▸
        </span>
        Sights
        {sights.length > 0 && (
          <span className="italic text-muted-foreground/70">({sights.length})</span>
        )}
      </button>
      {expanded && (
      <div id={`sights-body-${walkId}`}>
      <div className="mt-1 flex flex-col gap-2">
        {sights.map((s, i) => (
          <div
            key={i}
            className="rounded border border-border/60 bg-background px-2 py-1.5"
          >
            {/* Row header: index label on the left, then up/down
                reorder arrows and a delete button. Arrows swap this
                row with its neighbour in the draft array; they're
                disabled at the edges (first row can't move up, last
                can't move down). */}
            <div className="mb-1 flex items-center justify-between">
              <span className="text-[10px] uppercase tracking-wide text-muted-foreground">
                Sight {i + 1}
              </span>
              <div className="flex items-center gap-0.5">
                <button
                  type="button"
                  onClick={() => onChange(arrayMove(sights, i, 0))}
                  disabled={i === 0}
                  className="rounded px-1 text-muted-foreground hover:bg-muted/60 disabled:opacity-30 disabled:hover:bg-transparent"
                  aria-label={`Move sight ${i + 1} to top`}
                  title="Move to top"
                >
                  ⇈
                </button>
                <button
                  type="button"
                  onClick={() => onChange(arrayMove(sights, i, i - 1))}
                  disabled={i === 0}
                  className="rounded px-1 text-muted-foreground hover:bg-muted/60 disabled:opacity-30 disabled:hover:bg-transparent"
                  aria-label={`Move sight ${i + 1} up`}
                  title="Move up"
                >
                  ▲
                </button>
                <button
                  type="button"
                  onClick={() => onChange(arrayMove(sights, i, i + 1))}
                  disabled={i === sights.length - 1}
                  className="rounded px-1 text-muted-foreground hover:bg-muted/60 disabled:opacity-30 disabled:hover:bg-transparent"
                  aria-label={`Move sight ${i + 1} down`}
                  title="Move down"
                >
                  ▼
                </button>
                <button
                  type="button"
                  onClick={() => onChange(sights.filter((_, j) => j !== i))}
                  className="ml-0.5 rounded px-1 text-muted-foreground hover:text-destructive"
                  aria-label={`Delete sight ${i + 1}`}
                  title="Delete"
                >
                  ×
                </button>
              </div>
            </div>
            <div className="space-y-1.5">
              <Input
                value={s.name}
                onChange={(e) => {
                  const next = [...sights]
                  next[i] = { ...next[i], name: e.target.value }
                  onChange(next)
                }}
                placeholder="Name (required)"
                className="h-7 text-xs"
              />
              <Input
                type="url"
                value={s.url}
                onChange={(e) => {
                  const next = [...sights]
                  next[i] = { ...next[i], url: e.target.value }
                  onChange(next)
                }}
                placeholder="URL (optional)"
                className="h-7 text-xs"
              />
              <Input
                value={s.description}
                onChange={(e) => {
                  const next = [...sights]
                  next[i] = { ...next[i], description: e.target.value }
                  onChange(next)
                }}
                placeholder="Description (optional, admin-only for now)"
                className="h-7 text-xs"
              />
            </div>
          </div>
        ))}
      </div>
      <button
        type="button"
        onClick={() => onChange([...sights, { name: "", url: "", description: "" }])}
        className="mt-2 w-full rounded border border-dashed border-border px-2 py-1 text-xs text-muted-foreground hover:bg-muted/40"
      >
        + Add sight
      </button>
      {/* An invisible anchor gives the label a stable `for` target if
          we later wire the first input up to it; not strictly required
          since each row has its own label via placeholder. */}
      <span id={`sights-${walkId}`} className="sr-only" />
      </div>
      )}
    </div>
  )
}

// Lunch stops: name (required), location, url, notes, rating. Rating
// cycles through three named values via small buttons (clearing by
// pressing the active one again), matching the pattern used on the
// walk-level rating picker for consistency.
const LUNCH_RATINGS: Array<{ value: "good" | "fine" | "poor"; label: string; classes: string }> = [
  { value: "good", label: "Good", classes: "bg-green-500 text-white hover:bg-green-600" },
  { value: "fine", label: "Fine", classes: "bg-amber-400 text-white hover:bg-amber-500" },
  { value: "poor", label: "Poor", classes: "bg-red-500 text-white hover:bg-red-600" },
]

function LunchStopsEditor({
  walkId,
  stops,
  onChange,
}: {
  walkId: string
  stops: LunchDraft[]
  onChange: (next: LunchDraft[]) => void
}) {
  // Collapsed by default — same reasoning as SightsEditor above.
  const [expanded, setExpanded] = useState(false)
  return (
    <div className="mb-3">
      <button
        type="button"
        onClick={() => setExpanded((v) => !v)}
        aria-expanded={expanded}
        aria-controls={`lunch-body-${walkId}`}
        className="flex w-full items-center gap-1 text-left text-xs text-muted-foreground hover:text-foreground"
      >
        <span
          aria-hidden="true"
          className={`inline-block transition-transform ${expanded ? "rotate-90" : ""}`}
        >
          ▸
        </span>
        Lunch stops
        {stops.length > 0 && (
          <span className="italic text-muted-foreground/70">({stops.length})</span>
        )}
      </button>
      {expanded && (
      <div id={`lunch-body-${walkId}`}>
      <div className="mt-1 flex flex-col gap-2">
        {stops.map((s, i) => (
          <div
            key={i}
            className="rounded border border-border/60 bg-background px-2 py-1.5"
          >
            <div className="mb-1 flex items-center justify-between">
              <span className="text-[10px] uppercase tracking-wide text-muted-foreground">
                Lunch {i + 1}
              </span>
              <div className="flex items-center gap-0.5">
                <button
                  type="button"
                  onClick={() => onChange(arrayMove(stops, i, 0))}
                  disabled={i === 0}
                  className="rounded px-1 text-muted-foreground hover:bg-muted/60 disabled:opacity-30 disabled:hover:bg-transparent"
                  aria-label={`Move lunch ${i + 1} to top`}
                  title="Move to top"
                >
                  ⇈
                </button>
                <button
                  type="button"
                  onClick={() => onChange(arrayMove(stops, i, i - 1))}
                  disabled={i === 0}
                  className="rounded px-1 text-muted-foreground hover:bg-muted/60 disabled:opacity-30 disabled:hover:bg-transparent"
                  aria-label={`Move lunch ${i + 1} up`}
                  title="Move up"
                >
                  ▲
                </button>
                <button
                  type="button"
                  onClick={() => onChange(arrayMove(stops, i, i + 1))}
                  disabled={i === stops.length - 1}
                  className="rounded px-1 text-muted-foreground hover:bg-muted/60 disabled:opacity-30 disabled:hover:bg-transparent"
                  aria-label={`Move lunch ${i + 1} down`}
                  title="Move down"
                >
                  ▼
                </button>
                <button
                  type="button"
                  onClick={() => onChange(stops.filter((_, j) => j !== i))}
                  className="ml-0.5 rounded px-1 text-muted-foreground hover:text-destructive"
                  aria-label={`Delete lunch stop ${i + 1}`}
                  title="Delete"
                >
                  ×
                </button>
              </div>
            </div>
            <div className="space-y-1.5">
              <Input
                value={s.name}
                onChange={(e) => {
                  const next = [...stops]
                  next[i] = { ...next[i], name: e.target.value }
                  onChange(next)
                }}
                placeholder="Name (required)"
                className="h-7 text-xs"
              />
              <Input
                value={s.location}
                onChange={(e) => {
                  const next = [...stops]
                  next[i] = { ...next[i], location: e.target.value }
                  onChange(next)
                }}
                placeholder="Location (e.g. Keyhaven)"
                className="h-7 text-xs"
              />
              <Input
                type="url"
                value={s.url}
                onChange={(e) => {
                  const next = [...stops]
                  next[i] = { ...next[i], url: e.target.value }
                  onChange(next)
                }}
                placeholder="URL (optional)"
                className="h-7 text-xs"
              />
              <Input
                value={s.notes}
                onChange={(e) => {
                  const next = [...stops]
                  next[i] = { ...next[i], notes: e.target.value }
                  onChange(next)
                }}
                placeholder="Notes (optional, admin-only for now)"
                className="h-7 text-xs"
              />
              {/* Rating + busy flag — small controls on one row.
                  Clicking the active rating clears it; busy is a
                  single checkbox (presence-only — stored as `true`
                  or absent in the JSON). */}
              <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
                <div className="flex items-center gap-1">
                  <span className="mr-1 text-[10px] uppercase tracking-wide text-muted-foreground">
                    Rating
                  </span>
                  {LUNCH_RATINGS.map((r) => {
                    const active = s.rating === r.value
                    return (
                      <button
                        key={r.value}
                        type="button"
                        onClick={() => {
                          const next = [...stops]
                          next[i] = { ...next[i], rating: active ? "" : r.value }
                          onChange(next)
                        }}
                        className={
                          "rounded px-1.5 py-0.5 text-[10px] transition-colors " +
                          (active
                            ? r.classes
                            : "border border-border bg-background text-muted-foreground hover:bg-muted/60")
                        }
                      >
                        {r.label}
                      </button>
                    )
                  })}
                </div>
                <label className="flex cursor-pointer items-center gap-1.5 text-[11px] text-muted-foreground">
                  <Checkbox
                    checked={s.busy}
                    onCheckedChange={(v) => {
                      const next = [...stops]
                      next[i] = { ...next[i], busy: v === true }
                      onChange(next)
                    }}
                    className="cursor-pointer"
                  />
                  Busy
                </label>
              </div>
            </div>
          </div>
        ))}
      </div>
      <button
        type="button"
        onClick={() =>
          onChange([
            ...stops,
            { name: "", location: "", url: "", notes: "", rating: "", busy: false },
          ])
        }
        className="mt-2 w-full rounded border border-dashed border-border px-2 py-1 text-xs text-muted-foreground hover:bg-muted/40"
      >
        + Add lunch stop
      </button>
      <span id={`lunch-${walkId}`} className="sr-only" />
      </div>
      )}
    </div>
  )
}
