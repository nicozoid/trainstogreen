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
//   - miscellany (free-text, for non-mud warnings and other notes)
// Everything else (sights, lunchStops, terrain, distance, etc.) is
// view-only for now — list editors are a bigger lift and haven't been
// scoped into Phase 5 v1.

import { useCallback, useEffect, useMemo, useRef, useState } from "react"
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
import { SPOT_TYPES, SPOT_TYPE_LABELS } from "@/lib/spot-types"
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuCheckboxItem,
  DropdownMenuSeparator,
} from "@/components/ui/dropdown-menu"

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
  uphillMetres: number | null
  difficulty: "easy" | "moderate" | "hard" | null
  terrain: string
  sights: { name: string; url?: string | null; description?: string; lat?: number | null; lng?: number | null; kmIntoRoute?: number | null; businessStatus?: string | null; types?: string[] | null }[]
  lunchStops: { name: string; location?: string; url?: string | null; notes?: string; rating?: string; busy?: "busy" | "quiet"; lat?: number | null; lng?: number | null; kmIntoRoute?: number | null; businessStatus?: string | null; types?: string[] | null }[]
  /** Free-text override for the lunch line in the public prose. When
   *  populated, replaces the formatted lunchStops list entirely. */
  lunchOverride: string
  /** Destination pub(s) — same shape as lunchStops. The editor hides
   *  the location field for this section since the walk destination is
   *  implicit. */
  destinationStops: { name: string; location?: string; url?: string | null; notes?: string; rating?: string; busy?: "busy" | "quiet"; lat?: number | null; lng?: number | null; kmIntoRoute?: number | null; businessStatus?: string | null; types?: string[] | null }[]
  /** Free-text override for the destination-pub line, parallels lunchOverride. */
  destinationStopsOverride: string
  miscellany: string
  trainTips: string
  /** Admin-only free-text scratchpad, never rendered to the public. */
  privateNote: string
  mudWarning: boolean
  bestSeasons: string[]
  /** Free-text rationale for the chosen months ("bluebell season",
   *  "wildflowers in bloom", etc.). Public prose appends it as a
   *  parenthetical after the month range: "Best Mar-Apr (bluebell
   *  season)." Empty string when unset. */
  bestSeasonsNote: string
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
  /** Admin-authored sentence rendered after the rating flourish. */
  ratingExplanation: string
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
  pageTags?: string[]
  /** Read-only entry-level "hidden metadata" + admin/build flags.
   *  Surfaced in a collapsed Metadata section on the walk card.
   *  Only present when the source has at least one populated field. */
  meta?: WalkMeta
}

export type WalkMeta = {
  tagline?: string
  notes?: string
  regions?: string[]
  categories?: string[]
  features?: string[]
  places?: {
    villages?: string[]
    landmarks?: string[]
    historic?: string[]
    modern?: string[]
    nature?: string[]
    paths?: string[]
  }
  extracted?: boolean
  onMap?: boolean
  issues?: boolean
  outsideMainlandBritain?: boolean
  resolved?: boolean
  resolution?: string
  sourceIndex?: number
}

// The editable subset — the card's draft state only tracks these. Any
// other field on WalkPayload is read-only, so drift between server and
// UI stays impossible.
// Editable sight row — mirrors the server-side cleanSight() shape.
// lat/lng/kmIntoRoute are populated by the Komoot Pull-data button
// (auto-extracted from way_points) and stay editable so the admin can
// nudge them. Stored as strings here so the inputs are controlled
// even when empty; the server cleaner coerces back to numbers.
type SightDraft = {
  name: string
  url: string
  description: string
  lat: string
  lng: string
  kmIntoRoute: string
  /** OPERATIONAL / CLOSED_TEMPORARILY / CLOSED_PERMANENTLY (or "" when
   *  unknown). Populated by the Places API "Pull URLs" button. Drives
   *  the public-prose filter — CLOSED_PERMANENTLY rows are hidden. */
  businessStatus: string
  /** Multi-select tags drawn from lib/spot-types — pub / cafe /
   *  viewpoint / etc. Auto-filled by Komoot Pull data and Pull URLs
   *  ONLY when the array is empty; manual edits are never overwritten. */
  types: string[]
}
// Editable lunch stop — mirrors cleanLunchStop() shape. `rating` is
// "" when unset so the same empty-string → unset pattern covers all
// the optional text fields uniformly.
type LunchRating = "" | "good" | "fine" | "poor"
// Tri-state busy — mirrors the rating enum shape so the editor can
// reuse the same toggle-button pattern. "" = no opinion.
type LunchBusy = "" | "busy" | "quiet"
type LunchDraft = {
  name: string
  location: string
  url: string
  notes: string
  rating: LunchRating
  busy: LunchBusy
  // Same auto-fill from Komoot Pull data as SightDraft above —
  // stored as strings on the draft so inputs stay controlled.
  lat: string
  lng: string
  kmIntoRoute: string
  /** See SightDraft. */
  businessStatus: string
  /** See SightDraft. */
  types: string[]
}

type EditableFields = {
  name: string       // legacy override — full title replacement
  suffix: string     // appended to derived title: "{start} to {end} {suffix}"
  komootUrl: string
  bestSeasons: string[]
  /** Free-text rationale appended to the public "Best …" sentence. */
  bestSeasonsNote: string
  mudWarning: boolean
  miscellany: string
  trainTips: string
  privateNote: string
  rating: number | null
  ratingExplanation: string
  // Admin-only log of when this walk was personally completed —
  // each entry is a `YYYY-MM-DD` ISO date. Drives the
  // "Undiscovered" admin filter on the map (any non-empty array
  // marks the station as "hiked").
  previousWalkDates: string[]
  terrain: string
  distanceKm: number | null
  hours: number | null
  uphillMetres: number | null
  difficulty: "easy" | "moderate" | "hard" | null
  sights: SightDraft[]
  lunchStops: LunchDraft[]
  lunchOverride: string
  destinationStops: LunchDraft[]
  destinationStopsOverride: string
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
// Numbers serialise to "" when missing/null so empty inputs stay
// controlled. The server cleaner accepts either an empty string or a
// numeric string and normalises to undefined on save.
function num(n: number | null | undefined): string {
  return typeof n === "number" && Number.isFinite(n) ? String(n) : ""
}

// Render a row's lat/lng/km as a single read-only string for the
// bottom-right corner of the spot card. Returns "" when none of the
// three is set, so the consumer can render conditionally without
// ending up with an empty chip. The "·" separator + monospace
// styling are applied at the consumer site.
function formatRowCoords(lat: string, lng: string, kmIntoRoute: string): string {
  const parts: string[] = []
  if (lat.trim() && lng.trim()) parts.push(`${lat.trim()}, ${lng.trim()}`)
  else if (lat.trim()) parts.push(`lat ${lat.trim()}`)
  else if (lng.trim()) parts.push(`lng ${lng.trim()}`)
  if (kmIntoRoute.trim()) parts.push(`${kmIntoRoute.trim()}km`)
  return parts.join(" · ")
}
function sightsToDraft(list: WalkPayload["sights"]): SightDraft[] {
  return list.map((s) => ({
    name: s.name ?? "",
    url: s.url ?? "",
    description: s.description ?? "",
    lat: num(s.lat),
    lng: num(s.lng),
    kmIntoRoute: num(s.kmIntoRoute),
    businessStatus: s.businessStatus ?? "",
    types: Array.isArray(s.types) ? s.types : [],
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
    busy: (s.busy === "busy" || s.busy === "quiet" ? s.busy : "") as LunchBusy,
    lat: num(s.lat),
    lng: num(s.lng),
    kmIntoRoute: num(s.kmIntoRoute),
    businessStatus: s.businessStatus ?? "",
    types: Array.isArray(s.types) ? s.types : [],
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
  { value: "related",     label: "Related to" },
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

// Tiny search-as-you-type station picker for the "+ New walk" form.
//
// UX: the input shows the currently-selected station's "Name (CRS)"
// label. Focusing the input swaps to the raw search query (so the
// admin can edit it freely); typing 2+ chars opens a dropdown of
// matching stations. Clicking a row commits the new CRS and
// collapses the dropdown. Blur reverts the visible label without
// changing the CRS.
//
// We deliberately don't reuse the heavier `searchableStations`
// shape from the filter panel — for picking a CRS in a manual-walk
// form we only need {crs, name}, and threading the full prop down
// would mean piping the cluster + RTT-data fields through a tree
// that doesn't care about them.
function StationPicker({
  label,
  value,
  onChange,
  stations,
}: {
  label: string
  value: string
  onChange: (crs: string) => void
  stations: { crs: string; name: string }[] | null
}) {
  // Shown name for the currently-selected CRS — purely a display
  // helper. If `stations` hasn't loaded yet we fall back to the
  // CRS code so the input never goes blank.
  const selectedLabel = useMemo(() => {
    if (!stations) return value
    const match = stations.find((s) => s.crs === value)
    return match ? `${match.name} (${match.crs})` : value
  }, [stations, value])
  const [query, setQuery] = useState("")
  const [open, setOpen] = useState(false)
  // Match against name OR CRS, case-insensitive. Cap to 12 rows so
  // the dropdown never explodes — admins refine via more keystrokes.
  const matches = useMemo(() => {
    if (!stations || query.trim().length < 2) return []
    const q = query.trim().toLowerCase()
    const out: { crs: string; name: string }[] = []
    for (const s of stations) {
      if (s.name.toLowerCase().includes(q) || s.crs.toLowerCase().includes(q)) {
        out.push(s)
        if (out.length >= 12) break
      }
    }
    return out
  }, [stations, query])
  const inputId = `station-picker-${label.replace(/\s+/g, "-").toLowerCase()}`
  return (
    <div className="relative">
      <Label htmlFor={inputId} className="mb-1 block text-[10px] text-muted-foreground">
        {label}
      </Label>
      <Input
        id={inputId}
        // When focused, show the raw query so the admin types into
        // an empty field. When blurred, show the friendly label of
        // the committed selection.
        value={open ? query : selectedLabel}
        onFocus={() => { setOpen(true); setQuery("") }}
        onBlur={() => {
          // setTimeout so onMouseDown on a row fires before we
          // collapse the dropdown — otherwise the click would land
          // on a vanished element.
          setTimeout(() => setOpen(false), 120)
        }}
        onChange={(e) => setQuery(e.target.value)}
        className="h-7 text-xs"
      />
      {open && matches.length > 0 && (
        <ul
          // Absolute popover — scrolls if there are 12 matches.
          // z-10 keeps it above neighbouring picker columns.
          className="absolute left-0 right-0 z-10 mt-0.5 max-h-48 overflow-y-auto rounded border border-border bg-background py-0.5 text-xs shadow-lg"
        >
          {matches.map((s) => (
            <li key={s.crs}>
              <button
                type="button"
                // onMouseDown fires before the input's blur, so we
                // commit the selection before the popover collapses.
                onMouseDown={(e) => {
                  e.preventDefault()
                  onChange(s.crs)
                  setOpen(false)
                  setQuery("")
                }}
                className="flex w-full items-center justify-between gap-2 px-2 py-1 text-left hover:bg-muted/60"
              >
                <span className="truncate">{s.name}</span>
                <span className="text-[10px] text-muted-foreground">{s.crs}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}

export default function WalksAdminPanel({
  stationCrs,
  extraCrsCodes,
  onSaved,
}: {
  stationCrs: string
  /** Synthetic overlays pass their cluster members' CRS codes here.
   *  Walks attached to ANY listed CRS are fetched and merged into the
   *  panel, so the synthetic admin view shows every member's walks
   *  in one place. New walks created here still attach to
   *  stationCrs by default (the first member's CRS), but admins can
   *  override start/end via the inline picker. */
  extraCrsCodes?: string[]
  /** Called after a successful save so the parent can refresh its
   *  station-notes state and surface the regenerated ramblerNote. */
  onSaved?: () => void | Promise<void>
}) {
  // Merge stationCrs + extraCrsCodes, dropping duplicates and falsy
  // entries. Wrapped in JSON.stringify(extraCrsCodes) for the deps so
  // a parent passing a fresh array each render doesn't trigger a
  // refetch storm — the values matter, not array identity.
  const allCrsKey = JSON.stringify([stationCrs, ...(extraCrsCodes ?? [])])
  const [walks, setWalks] = useState<WalkPayload[] | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  // Dialog visibility flags — plain local booleans so we don't
  // need a whole state machine.
  const [infoOpen, setInfoOpen] = useState(false)
  const [creating, setCreating] = useState(false)
  // "+ New walk" expands an inline form with start/end station
  // pickers (both default to the current station). The form state
  // lives here so the pickers stay controlled. Keep the start/end
  // CRS in state — the actual list of all stations is fetched
  // lazily when the form first opens (see effect below).
  const [createOpen, setCreateOpen] = useState(false)
  const [createStart, setCreateStart] = useState(stationCrs)
  const [createEnd, setCreateEnd] = useState(stationCrs)
  // Lightweight {crs, name} list driving the pickers' search-as-
  // you-type dropdown. Loaded on first open of the create form;
  // null = not yet fetched.
  const [allStations, setAllStations] = useState<{ crs: string; name: string }[] | null>(null)
  // Reset the pickers when the modal switches station — otherwise
  // an old station's CRS would linger as the default.
  useEffect(() => {
    setCreateStart(stationCrs)
    setCreateEnd(stationCrs)
    setCreateOpen(false)
  }, [stationCrs])
  // Lazy-load the full station list the first time the form opens.
  // /stations.json is the public GeoJSON used by the map; we only
  // need name + ref:crs from each feature, so we strip everything
  // else immediately to keep memory in check.
  useEffect(() => {
    if (!createOpen || allStations !== null) return
    let cancelled = false
    fetch("/stations.json")
      .then((r) => r.json())
      .then((d: { features: Array<{ properties?: Record<string, unknown> }> }) => {
        if (cancelled) return
        const list: { crs: string; name: string }[] = []
        for (const f of d.features) {
          const crs = f.properties?.["ref:crs"] as string | undefined
          const name = f.properties?.name as string | undefined
          if (crs && name) list.push({ crs, name })
        }
        list.sort((a, b) => a.name.localeCompare(b.name))
        setAllStations(list)
      })
      .catch(() => { /* best-effort; the picker stays empty if fetch fails */ })
    return () => { cancelled = true }
  }, [createOpen, allStations])

  // Fetch walks for every CRS in the merged list. The endpoint
  // returns [] for stations with no attached walks — still a valid
  // response, so we distinguish "loading" from "no walks here" in
  // the render. For synthetics we fire one request per member CRS in
  // parallel and concat the results — a walk that touches multiple
  // members ends up de-duped by walk id since each walk only attaches
  // to one start station per variant.
  const fetchAllWalks = useCallback(async (): Promise<WalkPayload[]> => {
    const allCrs: string[] = JSON.parse(allCrsKey)
    const allCrsSet = new Set(allCrs)
    const responses = await Promise.all(
      allCrs.map((c) =>
        fetch(`/api/dev/walks-for-station?crs=${encodeURIComponent(c)}`)
          .then((r) => { if (!r.ok) throw new Error(`HTTP ${r.status}`); return r.json() as Promise<WalkPayload[]> })
      ),
    )
    // Dedupe by walk variant id — same walk can in theory be attached
    // to multiple cluster members (start vs end station of the same
    // S2S walk), and we don't want to render it twice.
    const seen = new Set<string>()
    const merged: WalkPayload[] = []
    for (const arr of responses) {
      for (const w of arr) {
        if (seen.has(w.id)) continue
        seen.add(w.id)
        merged.push(w)
      }
    }

    // Re-sort the merged list. The API's per-CRS sort is correct within
    // each batch, but concatenating pre-sorted arrays for synthetics
    // breaks the unified order — a Komoot walk attached to a LATER
    // member CRS would otherwise lose its top spot to non-Komoot walks
    // from the FIRST member's batch. Sort here using the same keys as
    // the API, with sectionPriority computed against the FULL allCrs
    // set so cluster-relative "circular / starting here / ending here"
    // is correct for the merged view.
    const IDEAL_LENGTH_KM = 13
    const RATING_TIERS: Record<string, number> = { "4": 0, "3": 1, "2": 2, "1": 3, unrated: 4 }
    const ratingTier = (r: number | null | undefined) =>
      r == null ? RATING_TIERS.unrated : (RATING_TIERS[String(Math.round(r))] ?? RATING_TIERS.unrated)
    const distanceScore = (km: number | null) =>
      typeof km === "number" && Number.isFinite(km) ? Math.abs(km - IDEAL_LENGTH_KM) : Number.POSITIVE_INFINITY
    const sectionPriority = (w: WalkPayload): number => {
      // Circular = same start & end station, regardless of cluster.
      if (w.startStation && w.startStation === w.endStation) return 0
      // S2S starting here: start CRS is one of the queried CRSes.
      if (w.startStation && allCrsSet.has(w.startStation)) return 1
      // S2S ending here: only the end CRS is in the queried set.
      return 2
    }
    merged.sort((a, b) => {
      // 1. Bus walks sink to the bottom.
      const ba = a.requiresBus ? 1 : 0, bb = b.requiresBus ? 1 : 0
      if (ba !== bb) return ba - bb
      // 2. Komoot walks first.
      const ka = a.komootUrl ? 0 : 1, kb = b.komootUrl ? 0 : 1
      if (ka !== kb) return ka - kb
      // 3. Section priority (circular → starting here → ending here).
      const sa = sectionPriority(a), sb = sectionPriority(b)
      if (sa !== sb) return sa - sb
      // 4. Main walks first.
      const ma = (a.source?.type ?? a.role) === "main" ? 0 : 1
      const mb = (b.source?.type ?? b.role) === "main" ? 0 : 1
      if (ma !== mb) return ma - mb
      // 5. Rating tier (4 → 3 → 2 → 1 → unrated).
      const ta = ratingTier(a.rating), tb = ratingTier(b.rating)
      if (ta !== tb) return ta - tb
      // 6. Distance proximity to IDEAL_LENGTH_KM.
      const da = distanceScore(a.distanceKm), db = distanceScore(b.distanceKm)
      if (da !== db) return da - db
      // 7. Alphabetic tiebreak.
      return a.pageTitle.localeCompare(b.pageTitle)
    })

    return merged
  }, [allCrsKey])

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    setError(null)
    fetchAllWalks()
      .then((data) => { if (!cancelled) setWalks(data) })
      .catch((e: Error) => { if (!cancelled) setError(e.message) })
      .finally(() => { if (!cancelled) setLoading(false) })
    return () => { cancelled = true }
  }, [fetchAllWalks])

  // Per-card save path. We refetch the full walks list on success so
  // the displayed fields reflect the server's canonical shape (e.g.
  // month codes reordered, empty strings dropped).
  const handleSaved = useCallback(async () => {
    // Refetch walks for this station — server-side cleanups might have
    // modified what we sent (e.g. dedupe, sort bestSeasons).
    try {
      const data = await fetchAllWalks()
      setWalks(data)
    } catch { /* best-effort */ }
    if (onSaved) await onSaved()
  }, [fetchAllWalks, onSaved])

  // Create a new manual walk. Start/end CRS come from the inline
  // form pickers (which default to the current station). If the
  // admin picks a different start station, the saved walk attaches
  // there — i.e. it disappears from this station's list after save.
  const handleCreate = useCallback(async () => {
    setCreating(true)
    try {
      const r = await fetch("/api/dev/walk/create", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ startStation: createStart, endStation: createEnd }),
      })
      if (!r.ok) throw new Error(`HTTP ${r.status}`)
      // Collapse the form and reset to defaults for the next create.
      setCreateOpen(false)
      setCreateStart(stationCrs)
      setCreateEnd(stationCrs)
      await handleSaved()
    } catch (e) {
      // eslint-disable-next-line no-console
      console.error("create walk failed:", e)
    } finally {
      setCreating(false)
    }
  }, [createStart, createEnd, stationCrs, handleSaved])

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
          onClick={() => setCreateOpen((v) => !v)}
          disabled={creating}
          className="ml-auto rounded border border-dashed border-border px-2 py-0.5 text-[11px] text-muted-foreground hover:bg-muted/40 disabled:opacity-40"
        >
          {creating ? "Creating…" : createOpen ? "Cancel" : "+ New walk"}
        </button>
      </div>

      {/* Inline create-walk form. Two station pickers (start + end)
          default to the current station. Picking a different start
          station means the walk attaches to that other station after
          save — surfaced via the muted note below. */}
      {createOpen && (
        <div className="mt-2 rounded border border-dashed border-border bg-background/50 p-2">
          <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
            <StationPicker
              label="Start station"
              value={createStart}
              onChange={setCreateStart}
              stations={allStations}
            />
            <StationPicker
              label="End station"
              value={createEnd}
              onChange={setCreateEnd}
              stations={allStations}
            />
          </div>
          {/* Warn the admin when they're about to create a walk that
              will leave this station's list on save. Only renders
              when the start station differs from the modal station. */}
          {createStart !== stationCrs && (
            <p className="mt-1.5 text-[10px] italic text-muted-foreground">
              Heads up: this walk will attach to {createStart}, not this station, so it'll disappear from the list after saving.
            </p>
          )}
          <div className="mt-2 flex justify-end gap-2">
            <button
              type="button"
              onClick={handleCreate}
              disabled={creating || !createStart || !createEnd}
              className="rounded border border-border bg-foreground px-2 py-0.5 text-[11px] text-background hover:opacity-90 disabled:opacity-40"
            >
              {creating ? "Creating…" : "Create"}
            </button>
          </div>
        </div>
      )}
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
              <p className="mb-1 font-medium">How walks are ordered</p>
              <ol className="list-decimal space-y-0.5 pl-5 text-xs text-muted-foreground">
                <li><span className="font-mono text-foreground">bus</span> walks sink to the bottom</li>
                <li>Komoot-linked walks come first</li>
                <li>Circular walks first, then station-to-station starting here, then station-to-station ending here</li>
                <li>Main walks first (no further subtype ordering)</li>
                <li>Higher rating first (4 → 3 → 2 → 1 → unrated)</li>
                <li>Distance closest to 13 km first</li>
                <li>Alphabetic tiebreak</li>
              </ol>
            </div>
            <div>
              <p className="mb-1 font-medium">What the public sees</p>
              <ul className="list-disc space-y-0.5 pl-5 text-xs text-muted-foreground">
                <li>
                  <strong>Cascading station-wide tiers</strong> — the first matching tier wins, the others are hidden:
                  <ol className="mt-0.5 list-decimal space-y-0.5 pl-5">
                    <li>If the station has any <strong>Komoot or GPX</strong> walk → only those are shown.</li>
                    <li>Else if the station has any <strong>main</strong> walk → only mains are shown (no variants).</li>
                    <li>Else show all variants (bus walks are still hidden).</li>
                  </ol>
                </li>
                <li><strong>Never shown:</strong> walks tagged <span className="font-mono">bus</span> (needs a bus/taxi/heritage rail).</li>
                <li>The chosen tier still gets split into three sections — Circular, Station-to-station starting here, Station-to-station ending here. Empty sections are hidden. No per-section limit.</li>
              </ul>
            </div>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  )
}

// Reusable collapsible section. Mirrors the chevron-rotate pattern used
// throughout this panel (Source, Sights, Lunch stops…). Defaults to
// uncontrolled (each instance owns its own open state). For sections
// that need to be opened programmatically from elsewhere — e.g. the
// Source > "Subordinate" button auto-expanding Related Source —
// pass `open` + `onOpenChange` to operate it in controlled mode.
//
// `rightSlot` renders next to the title in the header row. Used for
// header-level actions that should remain reachable when the section
// is collapsed.
function CollapsibleSection({
  title,
  defaultOpen = false,
  bodyId,
  rightSlot,
  count,
  open,
  onOpenChange,
  children,
}: {
  title: string
  defaultOpen?: boolean
  bodyId: string
  rightSlot?: React.ReactNode
  // Optional count rendered as "(n)" after the title — useful for
  // sections backed by an array (Sights, Lunch stops) so the admin
  // sees the row count without expanding. Accepts a string so callers
  // can render a status word instead of a number (e.g. "(override)"
  // for the refreshment-stops section when its override-text mode is
  // active and the venue list is moot).
  count?: number | string
  open?: boolean
  onOpenChange?: (open: boolean) => void
  children: React.ReactNode
}) {
  const [internalOpen, setInternalOpen] = useState(defaultOpen)
  // Controlled-mode toggle: prefer the prop when supplied, otherwise
  // fall back to internal state. `open` being undefined is the cue
  // to use uncontrolled mode (matches Radix's primitive convention).
  const isOpen = open ?? internalOpen
  const setOpen = (v: boolean) => {
    if (open === undefined) setInternalOpen(v)
    onOpenChange?.(v)
  }
  return (
    <div className="mb-3 rounded border border-border/60 bg-muted/30 px-2 py-2">
      <div className="flex items-center gap-1">
        {/* flex-1 stretches the toggle button across the whole header
            row so the entire bar (everything except `rightSlot`) is
            clickable. cursor-pointer is explicit so the affordance is
            obvious even where browser defaults vary. */}
        <button
          type="button"
          onClick={() => setOpen(!isOpen)}
          aria-expanded={isOpen}
          aria-controls={bodyId}
          className="flex flex-1 cursor-pointer items-center gap-1 text-left text-[10px] uppercase tracking-wide text-muted-foreground hover:text-foreground"
        >
          <span
            aria-hidden="true"
            className={`inline-block transition-transform ${isOpen ? "rotate-90" : ""}`}
          >
            ▸
          </span>
          {title}
          {/* Render when a number > 0 OR a non-empty string. Numbers
              render as "(3)"; strings render verbatim ("(override)"). */}
          {((typeof count === "number" && count > 0) ||
            (typeof count === "string" && count.length > 0)) && (
            <span className="italic text-muted-foreground/70 normal-case">({count})</span>
          )}
        </button>
        {rightSlot}
      </div>
      {isOpen && (
        <div id={bodyId} className="mt-1.5">
          {children}
        </div>
      )}
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
  // Informational banner shown alongside the Save button — distinct
  // from `saveError` because the save itself succeeded. Used in
  // production when the in-process rebuild of station-notes.json
  // can't run (Vercel's read-only fs) and the new value will only
  // appear publicly after the next deploy.
  const [saveNotice, setSaveNotice] = useState<string | null>(null)
  const [confirmDeleteOpen, setConfirmDeleteOpen] = useState(false)
  // Pull URLs — bulk Places API resolve for any sight/lunch stop/
  // destination pub that has lat/lng but no URL yet. `pullingUrls` is
  // the spinner; `pullUrlsNotice` shows a short success or
  // "no candidates found" line; `pullUrlsError` shows a hard failure.
  const [pullingUrls, setPullingUrls] = useState(false)
  const [pullUrlsNotice, setPullUrlsNotice] = useState<string | null>(null)
  const [pullUrlsError, setPullUrlsError] = useState<string | null>(null)
  // Brief flash state for the "click id to copy" affordance — flips
  // true for ~1.2s after a successful copy so the chip can render
  // "Copied!" feedback in place of the id.
  const [idCopied, setIdCopied] = useState(false)
  // Sources section — single collapsible holding both Main source
  // and Related source. Always collapsed by default; provenance is
  // rarely edited so the section starts out of the way. Subordinate
  // button stays in the header so it remains reachable without
  // expanding the section.
  const [sourcesExpanded, setSourcesExpanded] = useState(false)
  // "Pull data" button next to the komoot URL field. Spinner +
  // ephemeral error string while the scrape runs. Error is cleared
  // by the next attempt or by editing the URL.
  const [pullingDistance, setPullingDistance] = useState(false)
  const [pullDistanceError, setPullDistanceError] = useState<string | null>(null)

  // Draft state — initialised from the walk prop. useMemo keeps a
  // stable reference to the "server shape" for dirty-comparison.
  const serverState: EditableFields = useMemo(
    () => ({
      name: walk.name,
      suffix: walk.suffix,
      komootUrl: walk.komootUrl,
      bestSeasons: walk.bestSeasons,
      bestSeasonsNote: walk.bestSeasonsNote ?? "",
      mudWarning: walk.mudWarning,
      miscellany: walk.miscellany,
      trainTips: walk.trainTips,
      privateNote: walk.privateNote ?? "",
      rating: walk.rating,
      ratingExplanation: walk.ratingExplanation ?? "",
      previousWalkDates: Array.isArray(walk.previousWalkDates) ? walk.previousWalkDates : [],
      terrain: walk.terrain,
      distanceKm: walk.distanceKm,
      hours: walk.hours,
      uphillMetres: walk.uphillMetres,
      difficulty: walk.difficulty,
      sights: sightsToDraft(walk.sights),
      lunchStops: lunchToDraft(walk.lunchStops),
      lunchOverride: walk.lunchOverride ?? "",
      // lunchToDraft works for both lists since they share the same shape.
      destinationStops: lunchToDraft(walk.destinationStops ?? []),
      destinationStopsOverride: walk.destinationStopsOverride ?? "",
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
        // Default unset relatedSource.type to "adapted" — most
        // cross-references describe a Trains-to-Green walk that's
        // an adaptation of an external page.
        type: walk.relatedSource?.type ?? "adapted",
      },
    }),
    [
      walk.name, walk.suffix, walk.komootUrl, walk.bestSeasons, walk.bestSeasonsNote, walk.mudWarning,
      walk.miscellany, walk.trainTips, walk.privateNote, walk.rating, walk.ratingExplanation, walk.previousWalkDates, walk.terrain,
      walk.distanceKm, walk.hours, walk.uphillMetres, walk.difficulty,
      walk.sights, walk.lunchStops, walk.lunchOverride,
      walk.destinationStops, walk.destinationStopsOverride,
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
      draft.miscellany.trim() !== serverState.miscellany.trim() ||
      draft.trainTips.trim() !== serverState.trainTips.trim() ||
      draft.privateNote.trim() !== serverState.privateNote.trim() ||
      draft.rating !== serverState.rating ||
      draft.ratingExplanation.trim() !== serverState.ratingExplanation.trim() ||
      JSON.stringify(draft.previousWalkDates) !== JSON.stringify(serverState.previousWalkDates) ||
      draft.terrain.trim() !== serverState.terrain.trim() ||
      draft.distanceKm !== serverState.distanceKm ||
      draft.hours !== serverState.hours ||
      draft.uphillMetres !== serverState.uphillMetres ||
      draft.difficulty !== serverState.difficulty ||
      // Array compare — order-sensitive but the server returns them in
      // calendar order, so both sides are stable.
      JSON.stringify(draft.bestSeasons) !== JSON.stringify(serverState.bestSeasons) ||
      draft.bestSeasonsNote.trim() !== serverState.bestSeasonsNote.trim() ||
      // List editors: deep-compare via JSON. The drafts carry empty
      // strings for absent optionals (see sightsToDraft/lunchToDraft)
      // and the server shape strips them, so we compare drafts to
      // drafts by hydrating the server state through the same helpers
      // via useMemo above.
      JSON.stringify(draft.sights) !== JSON.stringify(serverState.sights) ||
      JSON.stringify(draft.lunchStops) !== JSON.stringify(serverState.lunchStops) ||
      draft.lunchOverride.trim() !== serverState.lunchOverride.trim() ||
      JSON.stringify(draft.destinationStops) !== JSON.stringify(serverState.destinationStops) ||
      draft.destinationStopsOverride.trim() !== serverState.destinationStopsOverride.trim() ||
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

  // Pull URLs handler — bulk Google Places resolve. Iterates over the
  // three spot lists, picks rows that have lat/lng but no URL yet,
  // sends the batch to /api/dev/place-url, and merges the results
  // into the draft. URL is only filled when blank; location (on lunch
  // stops) is only filled when blank; businessStatus is overwritten
  // unconditionally because a fresh fetch is always the best source
  // of truth for that field.
  const onPullUrls = useCallback(async () => {
    if (pullingUrls) return
    setPullUrlsError(null)
    setPullUrlsNotice(null)

    type Slot = { kind: "sights" | "lunchStops" | "destinationStops"; index: number }
    const slots: Slot[] = []
    type Spot = { name: string; lat: number; lng: number }
    const spots: Spot[] = []

    // Build the work list. A row is eligible when:
    //   - it has a non-empty name
    //   - it has finite lat/lng (Komoot Pull data already populated)
    //   - it has no URL set
    // Rows missing any of those are silently skipped — the admin can
    // populate the URL by hand or fill in coords first and re-pull.
    const collect = (kind: Slot["kind"], rows: { name: string; url: string; lat: string; lng: string }[]) => {
      rows.forEach((r, i) => {
        const name = r.name.trim()
        if (!name) return
        if (r.url.trim()) return
        const lat = Number(r.lat)
        const lng = Number(r.lng)
        if (!Number.isFinite(lat) || !Number.isFinite(lng)) return
        slots.push({ kind, index: i })
        spots.push({ name, lat, lng })
      })
    }
    collect("sights", draft.sights)
    collect("lunchStops", draft.lunchStops)
    collect("destinationStops", draft.destinationStops)

    if (spots.length === 0) {
      setPullUrlsNotice("No empty-URL rows with coordinates to look up.")
      return
    }
    setPullingUrls(true)
    try {
      const r = await fetch("/api/dev/place-url", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ spots }),
      })
      const j = await r.json()
      if (!r.ok) throw new Error(j?.error || `HTTP ${r.status}`)
      const results = (j?.results ?? []) as ({ url: string; location?: string; businessStatus?: string; types?: string[] } | null)[]

      let filled = 0
      // Track unmatched rows so the status banner can name them. Each
      // entry is "{Section} {1-based index} ({venue name})" so the
      // admin sees exactly which rows need manual attention rather
      // than a bare "3 not matched".
      const missedRows: string[] = []
      // Section labels matching the visible editor headings, used in
      // the unmatched-row report below.
      const SECTION_LABEL: Record<typeof slots[number]["kind"], string> = {
        sights: "Sight",
        lunchStops: "Lunch stop",
        destinationStops: "Destination stop",
      }
      // Apply by kind. We mutate copies of each list so we can build
      // the next draft in one pass.
      const nextSights = [...draft.sights]
      const nextLunch = [...draft.lunchStops]
      const nextPubs = [...draft.destinationStops]
      slots.forEach((slot, i) => {
        const res = results[i]
        if (!res) {
          // Identify the row by section + 1-based index + venue name
          // so the banner reads e.g. "Destination stop 3 (The Two
          // Brewers)" rather than an opaque "3 not matched".
          missedRows.push(`${SECTION_LABEL[slot.kind]} ${slot.index + 1} (${spots[i].name})`)
          return
        }
        filled++
        const apply = <T extends { url: string; businessStatus: string; location?: string; types: string[] }>(row: T): T => ({
          ...row,
          // Only fill URL when blank — preserves admin-entered overrides.
          url: row.url.trim() ? row.url : res.url,
          // Always overwrite businessStatus — a re-pull should reflect
          // the current state of the world, not last week's.
          businessStatus: res.businessStatus ?? row.businessStatus,
          // Only fill location when blank, and only on rows that have
          // a location field at all (sights don't). Server returns
          // just the village/town/suburb (NOT the full address), so
          // this slots in cleanly as a prose-friendly placename.
          ...(typeof row.location === "string" && !row.location.trim() && res.location
            ? { location: res.location }
            : {}),
          // Only fill types when the row's types array is empty —
          // never overwrite manual edits.
          types: row.types.length === 0 && res.types?.length ? res.types : row.types,
        })
        if (slot.kind === "sights") nextSights[slot.index] = apply(nextSights[slot.index])
        else if (slot.kind === "lunchStops") nextLunch[slot.index] = apply(nextLunch[slot.index])
        else nextPubs[slot.index] = apply(nextPubs[slot.index])
      })
      setDraft((d) => ({ ...d, sights: nextSights, lunchStops: nextLunch, destinationStops: nextPubs }))
      setPullUrlsNotice(
        missedRows.length > 0
          ? `Filled ${filled} of ${spots.length}. Couldn't match: ${missedRows.join(", ")}.`
          : `Filled ${filled} of ${spots.length}.`,
      )
    } catch (e) {
      setPullUrlsError((e as Error).message)
    } finally {
      setPullingUrls(false)
    }
  }, [pullingUrls, draft.sights, draft.lunchStops, draft.destinationStops])

  const onSave = useCallback(async () => {
    setSaving(true)
    setSaveError(null)
    setSaveNotice(null)
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
          bestSeasonsNote: draft.bestSeasonsNote,
          mudWarning: draft.mudWarning,
          miscellany: draft.miscellany,
          trainTips: draft.trainTips,
          privateNote: draft.privateNote,
          rating: draft.rating,
          ratingExplanation: draft.ratingExplanation,
          previousWalkDates: draft.previousWalkDates,
          terrain: draft.terrain,
          distanceKm: draft.distanceKm,
          hours: draft.hours,
          uphillMetres: draft.uphillMetres,
          difficulty: draft.difficulty,
          // The server cleanSight/cleanLunchStop drop rows with empty
          // names and strip empty optional fields — we send the raw
          // drafts as-is and trust the server-side filter.
          sights: draft.sights,
          lunchStops: draft.lunchStops,
          lunchOverride: draft.lunchOverride,
          destinationStops: draft.destinationStops,
          destinationStopsOverride: draft.destinationStopsOverride,
          source: draft.source,
          relatedSource: draft.relatedSource,
        }),
      })
      if (!r.ok) throw new Error(`HTTP ${r.status}: ${await r.text()}`)
      // Server may flag `rebuildPending: true` when the save itself
      // succeeded but the in-process rebuild of derived files (notably
      // station-notes.json) couldn't run — the typical production case
      // on Vercel. Surface that as an info notice so the admin knows
      // the value IS saved and roughly when it'll go live publicly.
      const json = await r.json().catch(() => ({}))
      if (json && json.rebuildPending) {
        setSaveNotice("Saved. Public view updates after next deploy (~3-5 min).")
      }
      await onSaved()
    } catch (e) {
      setSaveError(e instanceof Error ? e.message : String(e))
    } finally {
      setSaving(false)
    }
  }, [walk.id, draft, onSaved])

  // Ref on the card root so the Clear-spots button can scrollIntoView
  // back to the top of THIS walk after wiping the spot lists. Without
  // this, the button stays put under the user's cursor and they lose
  // the visual landmark of where the walk starts.
  const cardRootRef = useRef<HTMLDivElement | null>(null)
  return (
    <div ref={cardRootRef} className="rounded border border-border bg-background">
      {/* Card header — click to expand. Walk ordering is automatic
          (rating tier → komoot → most-recently-edited) and can't be
          overridden from here, so the row is purely a toggle. */}
      <button
        type="button"
        onClick={() => setExpanded((v) => !v)}
        className="flex w-full items-center gap-2 px-2 py-1.5 text-left text-xs hover:bg-muted/40"
      >
        <span className={`inline-block transition-transform ${expanded ? "rotate-90" : ""}`}>▸</span>
        {/* Walk id — click-to-copy. Stop event propagation so the
            outer header button doesn't also toggle expand/collapse.
            Rendered as <code role="button"> rather than a nested
            <button> to avoid invalid nested-interactive HTML. */}
        <code
          role="button"
          tabIndex={0}
          aria-label={`Copy walk id ${walk.id}`}
          onClick={(e) => {
            e.stopPropagation()
            navigator.clipboard.writeText(walk.id).then(
              () => {
                setIdCopied(true)
                window.setTimeout(() => setIdCopied(false), 1200)
              },
              () => { /* ignore — clipboard.writeText may reject in non-secure contexts */ },
            )
          }}
          onKeyDown={(e) => {
            // Keyboard parity for screen-reader / keyboard users.
            if (e.key === "Enter" || e.key === " ") {
              e.preventDefault()
              e.stopPropagation()
              navigator.clipboard.writeText(walk.id).then(
                () => {
                  setIdCopied(true)
                  window.setTimeout(() => setIdCopied(false), 1200)
                },
                () => {},
              )
            }
          }}
          title="Click to copy walk id"
          className="cursor-pointer rounded bg-muted px-1 py-0.5 font-mono text-[10px] text-muted-foreground hover:bg-muted/80"
        >
          {idCopied ? "Copied!" : walk.id}
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
          // Month chip — distinct hue keeps the seasonality tags
          // visually separable from the neutral structural tags
          // (km, GPX, TO1/TO2, variant types) when several render
          // side-by-side.
          const monthChip = `${chipBase} bg-green-100 text-green-800 dark:bg-green-900/30 dark:text-green-300`
          // Komoot-branded chip: lime/yellow-green echoes Komoot's own brand
          // colour (~#86c440) so the chip is instantly recognisable. Hard-coded
          // Tailwind palette rather than a theme token because it's tied to an
          // external product, not the app's own visual language. Dark-mode pair
          // keeps contrast acceptable on the dark muted bg.
          const komootChip = `${chipBase} bg-lime-100 text-lime-800 dark:bg-lime-900/30 dark:text-lime-300`
          // Amber chip for the Saturday Walkers Club favourite marker.
          // Echoes the ★ mental model (warm yellow/amber = starred) and
          // keeps it distinct from the green seasonality and lime komoot
          // chips so the row stays scannable.
          const swcFavChip = `${chipBase} bg-amber-100 text-amber-800 dark:bg-amber-900/30 dark:text-amber-300`
          // Sky-blue chip for the "previously hiked" marker. Distinct
          // hue from the green seasonality / amber swc_fav / lime
          // komoot chips so the row stays scannable. Communicates
          // "completed" without implying ongoing/active status.
          const hikedChip = `${chipBase} bg-sky-100 text-sky-800 dark:bg-sky-900/30 dark:text-sky-300`
          const bookTags = (walk.pageTags ?? []).filter((t: string) => t.startsWith("TO1:") || t.startsWith("TO2:"))
          // Latest valid YYYY-MM-DD entry in previousWalkDates. ISO
          // strings sort lexically = chronologically. null when none
          // present so the chip renders conditionally.
          const latestHikedDate = (() => {
            const valid = (walk.previousWalkDates ?? [])
              .filter((d) => typeof d === "string" && /^\d{4}-\d{2}-\d{2}$/.test(d))
              .sort()
            return valid.length > 0 ? valid[valid.length - 1] : null
          })()
          return (
            <>
              {walk.requiresBus && (
                <span className={destructiveChip} title="Requires a bus / taxi / heritage rail — never shown publicly">
                  bus
                </span>
              )}
              {/* main / variant identity. Previously "main" was implicit
                  (no chip rendered) on the theory that main is the
                  default — but that made it hard to spot at a glance
                  whether a card was a main walk or just a card with no
                  source.type set. Render both explicitly now. */}
              {walkType === "main" && <span className={neutralChip} title="Source type: main">main</span>}
              {isVariant && <span className={neutralChip} title={`Source type: ${walkType}`}>{walkType}</span>}
              {/* SWC favourite — set at the entry level by
                  seed-rambler-walks.mjs when the source page row
                  carries title="My Favourites" (the ★ marker on
                  walkingclub.org.uk). Same flag also shows up as the
                  "My Favourites" category in the entry's metadata. */}
              {walk.favourite && (
                <span className={swcFavChip} title="Marked as a Saturday Walkers Club favourite (★ My Favourites)">
                  swc_fav
                </span>
              )}
              {/* Last hiked — sky-blue chip with the most recent
                  YYYY-MM-DD from previousWalkDates rendered as
                  "Hiked 25 May 2025". Hover shows every date in
                  the log so admins can scan history without
                  expanding the card. */}
              {latestHikedDate && (() => {
                const [yyyy, mm, dd] = latestHikedDate.split("-").map((p) => parseInt(p, 10))
                const months = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"]
                const label = `Hiked ${dd} ${months[mm - 1]} ${yyyy}`
                const allDates = (walk.previousWalkDates ?? []).join(", ")
                return (
                  <span className={hikedChip} title={`Most recent hike date. All dates: ${allDates}`}>
                    {label}
                  </span>
                )
              })()}
              {walk.komootUrl && <span className={komootChip} title="Has a Komoot tour URL">komoot</span>}
              {walk.gpx && <span className={neutralChip} title="Source page publishes a GPX track">GPX</span>}
              {typeof walk.distanceKm === "number" && (
                <span className={neutralChip} title={`${walk.distanceKm} km (floored for display)`}>
                  {Math.floor(walk.distanceKm)} km
                </span>
              )}
              {bookTags.map((tag: string) => (
                <span key={tag} className={neutralChip} title={`Time Out ${tag.startsWith("TO1:") ? "Book 1" : "Book 2"}, Walk ${tag.split(":")[1]}`}>
                  {tag}
                </span>
              ))}
              {(walk.bestSeasons ?? []).length > 0 && (walk.bestSeasons as string[]).map((m: string) => (
                <span key={m} className={monthChip}>{m.charAt(0).toUpperCase() + m.slice(1)}</span>
              ))}
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
          {/* Sources — single collapsible holding Main source +
              Related source. The render pipeline uses source.type to
              emit the "A shorter variant of [X](url)." clause;
              relatedSource is admin-only and never appears in public
              prose. */}
          <div className="mb-3 rounded border border-border/60 bg-muted/30 px-2 py-2">
            {/* Header row — chevron toggle on the left, Subordinate
                action on the right. Subordinate stays in the header
                so it's reachable while the section is collapsed. */}
            <div className="mb-1.5 flex items-center gap-1">
              <button
                type="button"
                onClick={() => setSourcesExpanded((v) => !v)}
                aria-expanded={sourcesExpanded}
                aria-controls={`sources-body-${walk.id}`}
                className="flex flex-1 cursor-pointer items-center gap-1 text-left text-[10px] uppercase tracking-wide text-muted-foreground hover:text-foreground"
              >
                <span
                  aria-hidden="true"
                  className={`inline-block transition-transform ${sourcesExpanded ? "rotate-90" : ""}`}
                >
                  ▸
                </span>
                Sources
              </button>
              {/* Subordinate — demote the current external source to a
                  Related Source entry and rebrand this walk as a
                  Trains-to-Green main walk. Used when we're taking
                  ownership of a walk that started life as someone
                  else's route (e.g. a Saturday Walkers Club page
                  we've rewritten). The Related Source `type` is
                  preserved so the admin can pre-set it (e.g.
                  "Adapted from") before clicking. */}
              <button
                type="button"
                onClick={() => {
                  setDraft((d) => ({
                    ...d,
                    relatedSource: {
                      ...d.relatedSource,
                      orgSlug: d.source.orgSlug,
                      pageName: d.source.pageName,
                      pageURL: d.source.pageURL,
                    },
                    source: {
                      ...d.source,
                      orgSlug: "trains-to-green",
                      type: d.source.type === "main" ? d.source.type : "main",
                      pageName: "",
                      pageURL: "",
                    },
                  }))
                  setSourcesExpanded(true)
                }}
                className="ml-auto rounded border border-dashed border-border px-2 py-0.5 text-[10px] text-muted-foreground hover:bg-muted/40"
                title="Move current source into Related Source and mark this walk as a Trains-to-Green main walk"
              >
                Subordinate
              </button>
            </div>
            {sourcesExpanded && (
            <div id={`sources-body-${walk.id}`} className="space-y-2">
              {/* Main source */}
              <div>
                <div className="mb-1 text-[10px] uppercase tracking-wide text-muted-foreground">
                  Main source
                </div>
                <div className="grid grid-cols-2 gap-1.5">
                  {/* Organisation — dropdown of slugs from
                      sources.json. Adding a new org requires editing
                      data/sources.json by hand. */}
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
                  {/* Type — drives the "A longer variant of…" prose. */}
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
                  <div>
                    <Label htmlFor={`src-name-${walk.id}`} className="mb-1 block text-[10px] text-muted-foreground">
                      Page name
                    </Label>
                    <Input
                      id={`src-name-${walk.id}`}
                      value={draft.source.pageName}
                      onChange={(e) => setDraft((d) => ({
                        ...d, source: { ...d.source, pageName: e.target.value },
                      }))}
                      placeholder="e.g. Milford to Haslemere"
                      className="h-7 text-xs"
                    />
                  </div>
                  <div>
                    <Label htmlFor={`src-url-${walk.id}`} className="mb-1 block text-[10px] text-muted-foreground">
                      Page URL
                    </Label>
                    <Input
                      id={`src-url-${walk.id}`}
                      type="url"
                      value={draft.source.pageURL}
                      onChange={(e) => setDraft((d) => ({
                        ...d, source: { ...d.source, pageURL: e.target.value },
                      }))}
                      placeholder="https://…"
                      className="h-7 text-xs"
                    />
                  </div>
                </div>
              </div>

              {/* Related source — same four fields, fully optional.
                  Server drops the whole `relatedSource` key when all
                  fields are blank. Never rendered in public prose. */}
              <div className="border-t border-border/60 pt-2">
                <div className="mb-1 text-[10px] uppercase tracking-wide text-muted-foreground">
                  Related source
                </div>
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
                      {/* Empty option clears the related-source
                          block; the server deletes the field on
                          save. */}
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
                  <div>
                    <Label htmlFor={`rsrc-name-${walk.id}`} className="mb-1 block text-[10px] text-muted-foreground">
                      Page name
                    </Label>
                    <Input
                      id={`rsrc-name-${walk.id}`}
                      value={draft.relatedSource.pageName}
                      onChange={(e) => setDraft((d) => ({
                        ...d, relatedSource: { ...d.relatedSource, pageName: e.target.value },
                      }))}
                      placeholder="e.g. Milford to Haslemere"
                      className="h-7 text-xs"
                    />
                  </div>
                  <div>
                    <Label htmlFor={`rsrc-url-${walk.id}`} className="mb-1 block text-[10px] text-muted-foreground">
                      Page URL
                    </Label>
                    <Input
                      id={`rsrc-url-${walk.id}`}
                      type="url"
                      value={draft.relatedSource.pageURL}
                      onChange={(e) => setDraft((d) => ({
                        ...d, relatedSource: { ...d.relatedSource, pageURL: e.target.value },
                      }))}
                      placeholder="https://…"
                      className="h-7 text-xs"
                    />
                  </div>
                </div>
              </div>
            </div>
            )}
          </div>

          {/* ── Sections ────────────────────────────────────────────
              The editor body is grouped into collapsible sections so
              the admin can scan/jump quickly. All start collapsed.
              Order: Source / Key info / Tips / Sights / Lunch stops /
              Private. Sights and Lunch stops are existing dedicated
              components that already render their own collapsible
              header in the same style as CollapsibleSection. */}

          {/* Key info — the everyday-edit fields: title pieces,
              rating, Komoot URL, distance/hours. These are what
              changes most often when curating a walk. */}
          <CollapsibleSection title="Key info" bodyId={`keyinfo-section-${walk.id}`} defaultOpen>
            {/* Rating — Unrated + four tier icons. Active tier lights
                up; clicking the active tier clears it. */}
            <div className="mb-3">
              <Label className="mb-1 block text-xs text-muted-foreground">Rating</Label>
              <div className="flex items-center gap-1.5">
                {(() => {
                  const active = draft.rating == null
                  return (
                    <button
                      type="button"
                      onClick={() => setDraft((d) => ({ ...d, rating: null }))}
                      title="Unrated"
                      aria-label="Unrated"
                      aria-pressed={active}
                      className={
                        "flex h-7 w-7 items-center justify-center rounded transition-colors " +
                        (active
                          ? "bg-orange-50 text-orange-600 dark:bg-orange-950/20"
                          : "text-muted-foreground hover:bg-muted/50")
                      }
                    >
                      <svg viewBox="0 0 24 24" className="w-4 h-4" fill="none"
                        stroke={active ? "var(--primary)" : "currentColor"} strokeWidth={1.5}>
                        <circle cx="12" cy="12" r="9" />
                      </svg>
                    </button>
                  )
                })()}
                {([1, 2, 3, 4] as const).map((n) => {
                  const active = draft.rating === n
                  return (
                    <button
                      key={n}
                      type="button"
                      onClick={() =>
                        setDraft((d) => ({
                          ...d,
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

            {/* Suffix + Custom title — paired controls. Suffix is
                appended to the derived title; Custom title overrides
                the derived title entirely (and disables Suffix while
                it has a value). Side-by-side because they're
                conceptually two ways to set the same field. */}
            <div className="mb-3 grid grid-cols-2 gap-2">
              <div>
                <Label htmlFor={`suffix-${walk.id}`} className="mb-1 block text-xs text-muted-foreground">
                  Suffix
                  {draft.name.trim() && (
                    <span className="ml-1 italic text-muted-foreground/70">
                      (ignored)
                    </span>
                  )}
                </Label>
                <Input
                  id={`suffix-${walk.id}`}
                  value={draft.suffix}
                  onChange={(e) => setDraft((d) => ({ ...d, suffix: e.target.value }))}
                  className="h-7 text-xs"
                  disabled={!!draft.name.trim()}
                />
              </div>
              <div>
                <Label htmlFor={`name-${walk.id}`} className="mb-1 block text-xs text-muted-foreground">
                  Custom title
                  <span className="ml-1 italic text-muted-foreground/70">
                    (overrides)
                  </span>
                </Label>
                <Input
                  id={`name-${walk.id}`}
                  value={draft.name}
                  onChange={(e) => setDraft((d) => ({ ...d, name: e.target.value }))}
                  className="h-7 text-xs"
                />
              </div>
            </div>

            {/* Komoot tour URL — "Pull data" scrapes the tour page for
                distance, duration, uphill, difficulty, and name, writing
                them into the corresponding fields below. */}
            <div className="mb-3">
              <Label htmlFor={`komoot-${walk.id}`} className="mb-1 block text-xs text-muted-foreground">
                Komoot URL
              </Label>
              <div className="flex items-center gap-1.5">
                <Input
                  id={`komoot-${walk.id}`}
                  type="url"
                  value={draft.komootUrl}
                  onChange={(e) => {
                    setDraft((d) => ({ ...d, komootUrl: e.target.value }))
                    if (pullDistanceError) setPullDistanceError(null)
                  }}
                  className="h-7 text-xs"
                />
                <button
                  type="button"
                  onClick={async () => {
                    if (pullingDistance) return
                    setPullDistanceError(null)
                    setPullingDistance(true)
                    try {
                      const r = await fetch("/api/dev/komoot-distance", {
                        method: "POST",
                        headers: { "Content-Type": "application/json" },
                        body: JSON.stringify({ url: draft.komootUrl }),
                      })
                      const j = await r.json()
                      if (!r.ok) throw new Error(j?.error || `HTTP ${r.status}`)
                      // Normalise a venue name for fuzzy dedup: lowercase,
                      // whitespace collapsed, and apostrophes stripped
                      // (straight, curly, modifier-letter — Komoot mixes
                      // them up). Lets "St Mary's Church" and "St Marys
                      // Church" collapse to the same key.
                      const normName = (s: string) =>
                        s.toLowerCase()
                          .replace(/['‘’ʼ]/g, "")
                          .replace(/\s+/g, " ")
                          .trim()
                      setDraft((d) => {
                        const next = {
                          ...d,
                          distanceKm: Math.round(j.distanceKm * 100) / 100,
                          hours: j.hours,
                          // Uphill, difficulty, and name are optional — only
                          // overwrite when the API returned a value.
                          ...(typeof j.uphillMetres === "number" ? { uphillMetres: Math.round(j.uphillMetres * 100) / 100 } : {}),
                          ...(j.difficulty ? { difficulty: j.difficulty } : {}),
                          ...(j.name ? { name: j.name } : {}),
                        }
                        // Merge auto-extracted waypoints into the three
                        // venue lists. Dedup ACROSS all three (so a name
                        // already saved as a sight won't get re-added as a
                        // lunch stop, and vice versa) using the apostrophe-
                        // insensitive normaliser above.
                        type IncomingWaypoint = {
                          name: string
                          lat: number
                          lng: number
                          kmIntoRoute: number
                          /** Canonical types pre-mapped server-side from Komoot's
                           *  category vocabulary. May be empty when no recognised
                           *  tag was present on the waypoint. */
                          types?: string[]
                        }
                        const wp = j?.waypoints as
                          | undefined
                          | {
                              destinationStops: IncomingWaypoint[]
                              lunchStops: IncomingWaypoint[]
                              sights: IncomingWaypoint[]
                            }
                        if (wp) {
                          const seen = new Set([
                            ...next.sights.map((x) => normName(x.name)),
                            ...next.lunchStops.map((x) => normName(x.name)),
                            ...next.destinationStops.map((x) => normName(x.name)),
                          ])
                          // Filter incoming waypoints, mutating `seen` so
                          // duplicates within the same Pull-data batch
                          // also collapse (e.g. if Komoot lists the same
                          // venue twice, only one gets added).
                          const filterNew = <T extends { name: string }>(arr: T[]) =>
                            arr.filter((w) => {
                              const k = normName(w.name)
                              if (seen.has(k)) return false
                              seen.add(k)
                              return true
                            })
                          const toSight = (w: IncomingWaypoint) => ({
                            name: w.name,
                            url: "",
                            description: "",
                            lat: String(w.lat),
                            lng: String(w.lng),
                            kmIntoRoute: String(w.kmIntoRoute),
                            businessStatus: "",
                            // Auto-populate types from the upstream mapping. For
                            // brand-new rows there's nothing to preserve, so we
                            // can take the incoming list verbatim. (The "don't
                            // overwrite manual edits" rule kicks in only on
                            // re-pulls against existing rows — those are blocked
                            // by the name-dedup above.)
                            types: w.types ?? [],
                          })
                          const toRefreshment = (w: IncomingWaypoint) => ({
                            name: w.name,
                            location: "",
                            url: "",
                            notes: "",
                            rating: "" as LunchRating,
                            busy: "" as LunchBusy,
                            lat: String(w.lat),
                            lng: String(w.lng),
                            kmIntoRoute: String(w.kmIntoRoute),
                            businessStatus: "",
                            types: w.types ?? [],
                          })
                          // Order: destinationStops → lunchStops → sights so
                          // food venues claim a name before sights would.
                          // Within each bucket, Komoot's order (by km along
                          // the route) is preserved.
                          next.destinationStops = [...next.destinationStops, ...filterNew(wp.destinationStops).map(toRefreshment)]
                          next.lunchStops = [...next.lunchStops, ...filterNew(wp.lunchStops).map(toRefreshment)]
                          next.sights = [...next.sights, ...filterNew(wp.sights).map(toSight)]
                        }
                        return next
                      })
                    } catch (e) {
                      setPullDistanceError((e as Error).message)
                    } finally {
                      setPullingDistance(false)
                    }
                  }}
                  disabled={pullingDistance || !draft.komootUrl.trim()}
                  className="shrink-0 rounded border border-border bg-muted/40 px-2 py-0.5 text-[11px] text-foreground hover:bg-muted disabled:opacity-40"
                  title="Fetch distance, duration, uphill, difficulty, name, and waypoints (sights / lunch stops / destination pubs) from the Komoot tour page"
                >
                  {pullingDistance ? (
                    <span className="inline-flex items-center gap-1">
                      <svg
                        aria-hidden="true"
                        className="h-3 w-3 animate-spin"
                        viewBox="0 0 24 24"
                        fill="none"
                      >
                        <circle cx="12" cy="12" r="10" stroke="currentColor" strokeOpacity="0.25" strokeWidth="4" />
                        <path d="M12 2a10 10 0 0 1 10 10" stroke="currentColor" strokeWidth="4" strokeLinecap="round" />
                      </svg>
                      Pulling…
                    </span>
                  ) : (
                    "Pull data"
                  )}
                </button>
              </div>
              {pullDistanceError && (
                <p className="mt-1 text-[11px] text-destructive">
                  {pullDistanceError}
                </p>
              )}
            </div>

            {/* Distance, hours, uphill, difficulty — single row of four
                fields. Empty input maps to null (clears the field). */}
            <div className="grid grid-cols-4 gap-2">
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
              <div>
                <Label htmlFor={`uphill-${walk.id}`} className="mb-1 block text-xs text-muted-foreground">
                  uphill (m)
                </Label>
                <Input
                  id={`uphill-${walk.id}`}
                  type="number"
                  step="1"
                  value={draft.uphillMetres ?? ""}
                  onChange={(e) => {
                    const v = e.target.value
                    setDraft((d) => ({ ...d, uphillMetres: v === "" ? null : Number(v) }))
                  }}
                  className="h-7 text-xs"
                />
              </div>
              <div>
                <Label htmlFor={`difficulty-${walk.id}`} className="mb-1 block text-xs text-muted-foreground">
                  difficulty
                </Label>
                {/* Native <select> — matches the Interchange/Feature/
                    Source/Season dropdowns elsewhere in the admin UI.
                    Empty option clears the field. */}
                <select
                  id={`difficulty-${walk.id}`}
                  value={draft.difficulty ?? ""}
                  onChange={(e) => {
                    const v = e.target.value
                    setDraft((d) => ({ ...d, difficulty: v === "" ? null : (v as "easy" | "moderate" | "hard") }))
                  }}
                  className="h-7 w-full rounded border border-border bg-background px-1 text-xs"
                >
                  <option value="">—</option>
                  <option value="easy">Easy</option>
                  <option value="moderate">Moderate</option>
                  <option value="hard">Hard</option>
                </select>
              </div>
            </div>
          </CollapsibleSection>

          {/* Tips — descriptive prose pieces that flavour the public
              summary: rating-flourish caveat, terrain tags, best
              months chips, mud warning, free-text miscellany, train
              tips. Less frequently edited than Key info. */}
          <CollapsibleSection title="Tips" bodyId={`tips-section-${walk.id}`}>
            {/* Best months + Mud warning — paired on one row. Months
                takes the remaining space (flex-1) so the 12 month
                chips can wrap; Mud warning's checkbox tucks to the
                right at its natural width. items-end keeps the mud
                checkbox aligned with the chip row, not the label. */}
            <div className="mb-3 flex items-end gap-3">
              <div className="flex-1">
                <Label className="mb-1.5 block text-xs text-muted-foreground">Best months</Label>
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
              {/* Best-months rationale — sits between the month chips
                  and the Mud warning checkbox on the same row. When
                  populated, the public prose appends it as a paren:
                  "Best Mar-Apr (bluebell season)." Empty string =
                  no parenthetical. Fixed-ish width so it doesn't
                  swallow the row's flex space when long. */}
              <div className="shrink-0 self-end">
                <Label htmlFor={`best-seasons-note-${walk.id}`} className="mb-1 block text-xs text-muted-foreground">
                  Rationale
                  <span className="ml-1 font-normal italic text-muted-foreground/70">
                    e.g. &quot;bluebell season&quot;
                  </span>
                </Label>
                <Input
                  id={`best-seasons-note-${walk.id}`}
                  value={draft.bestSeasonsNote}
                  onChange={(e) => setDraft((d) => ({ ...d, bestSeasonsNote: e.target.value }))}
                  className="h-7 w-56 text-xs"
                />
              </div>
              {/* Mud warning — single boolean. When true the build
                  emits "Can be muddy." and suppresses any duplicate
                  free-text. shrink-0 keeps it from being squeezed
                  when the seasons row wraps. */}
              <div className="flex shrink-0 items-center gap-2 pb-1">
                <Checkbox
                  id={`mud-${walk.id}`}
                  checked={draft.mudWarning}
                  onCheckedChange={(v) => setDraft((d) => ({ ...d, mudWarning: v === true }))}
                />
                <Label htmlFor={`mud-${walk.id}`} className="cursor-pointer text-xs">
                  Mud warning
                </Label>
              </div>
            </div>

            {/* Rating explanation — appended after the rating
                flourish ("Rambler favourite!" / "An essential walk!")
                in the public prose. */}
            <div className="mb-3">
              <Label htmlFor={`rating-explanation-${walk.id}`} className="mb-1 block text-xs text-muted-foreground">
                Rating explanation
                <span className="ml-1 font-normal italic text-muted-foreground/70">
                  appended after the rating flourish
                </span>
              </Label>
              <Input
                id={`rating-explanation-${walk.id}`}
                value={draft.ratingExplanation}
                onChange={(e) => setDraft((d) => ({ ...d, ratingExplanation: e.target.value }))}
                className="h-7 text-xs"
              />
            </div>

            {/* Terrain — comma-separated short tags. Renderer joins
                with commas + "and" + period. */}
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
                className="h-7 text-xs"
              />
            </div>

            {/* Train tips — booking advice. Renders as its own
                sentence in the public prose. */}
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
                className="h-7 text-xs"
              />
            </div>

            {/* Free-text miscellany — non-mud warnings plus other notes. */}
            <div>
              <Label htmlFor={`misc-${walk.id}`} className="mb-1 block text-xs text-muted-foreground">
                Miscellany
                <span className="ml-1 font-normal italic text-muted-foreground/70">
                  free text
                </span>
              </Label>
              <Input
                id={`misc-${walk.id}`}
                value={draft.miscellany}
                onChange={(e) => setDraft((d) => ({ ...d, miscellany: e.target.value }))}
                className="h-7 text-xs"
              />
            </div>
          </CollapsibleSection>

          {/* Sights — repeatable list with name (required), URL and
              description (both optional). The component owns its own
              collapsible header in the CollapsibleSection style. */}
          <SightsEditor
            walkId={walk.id}
            sights={draft.sights}
            onChange={(sights) => setDraft((d) => ({ ...d, sights }))}
          />

          {/* Lunch stops — name + location + url + notes + rating.
              notes/rating are admin-only; renderer shows only the
              first three. The component owns its collapsible header.
              Override field replaces the formatted venue list in the
              public prose entirely when populated. */}
          <RefreshmentStopsEditor
            walkId={walk.id}
            kind="lunch"
            sectionTitle="Lunch stops"
            itemLabel="Lunch"
            addLabel="+ Add lunch stop"
            stops={draft.lunchStops}
            onStopsChange={(lunchStops) => setDraft((d) => ({ ...d, lunchStops }))}
            override={draft.lunchOverride}
            onOverrideChange={(lunchOverride) => setDraft((d) => ({ ...d, lunchOverride }))}
          />

          {/* Destination stops — venue(s) at the walk's end. Same
              shape and behaviour as Lunch stops, but the editor hides
              the location field (it's implicit — the walk
              destination) and the public prose renders "End-of-walk
              rests: <name>" rather than "Lunch at the X in Y".
              Override field replaces the venue list verbatim, same
              rule as lunch. */}
          <RefreshmentStopsEditor
            walkId={walk.id}
            kind="destinationStops"
            sectionTitle="Destination stops"
            itemLabel="Destination stop"
            addLabel="+ Add destination stop"
            showLocation={false}
            stops={draft.destinationStops}
            onStopsChange={(destinationStops) => setDraft((d) => ({ ...d, destinationStops }))}
            override={draft.destinationStopsOverride}
            onOverrideChange={(destinationStopsOverride) => setDraft((d) => ({ ...d, destinationStopsOverride }))}
          />

          {/* Private — admin-only fields, never rendered publicly:
              the scratchpad note + the personal "previously hiked"
              date log that drives the Undiscovered filter. */}
          <CollapsibleSection title="Private" bodyId={`private-section-${walk.id}`}>
            <div>
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
                className="h-7 text-xs"
              />
            </div>
            <PreviousWalkDatesEditor
              walkId={walk.id}
              dates={draft.previousWalkDates}
              onChange={(previousWalkDates) => setDraft((d) => ({ ...d, previousWalkDates }))}
            />
          </CollapsibleSection>

          {/* Metadata — read-only entry-level fields from the source
              scraper plus admin/build flags. Renders nothing when the
              source has no metadata to show, keeping cards compact. */}
          <MetadataSection walkId={walk.id} meta={walk.meta} />

          {/* Save / delete footer — destructive controls cluster on the
              right. Delete is gated behind a ConfirmDialog (it nukes
              the walk for real); Clear spots is unconfirmed because
              it only mutates draft state — Save still has to be
              clicked to persist. Delete only renders when the parent
              wired onDelete (it's the only surface that knows how to
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
            {/* Info banner — muted, NOT destructive. Only shown when
                rebuildPending came back from the server (production
                save with deferred rebuild). */}
            {saveNotice && <span className="text-xs text-muted-foreground">{saveNotice}</span>}
            {/* Pull URLs status — same muted-banner pattern as save
                notices, mirrored to error styling on hard failures. */}
            {pullUrlsNotice && <span className="text-xs text-muted-foreground">{pullUrlsNotice}</span>}
            {pullUrlsError && <span className="text-xs text-destructive">{pullUrlsError}</span>}
            <div className="ml-auto flex items-center gap-2">
              {/* Pull URLs — bulk Google Places resolve for any spot
                  that has lat/lng but no URL. Disabled when there's
                  nothing eligible (or a pull is already in flight). */}
              <Button
                size="sm"
                variant="outline"
                onClick={onPullUrls}
                disabled={
                  pullingUrls ||
                  ![...draft.sights, ...draft.lunchStops, ...draft.destinationStops].some(
                    (r) => r.name.trim() && !r.url.trim() && r.lat.trim() && r.lng.trim(),
                  )
                }
                className="h-7 text-xs"
                title="Look up each spot on Google Places (uses lat/lng) and fill its URL + address. Skips rows that already have a URL."
              >
                {pullingUrls ? "Pulling URLs…" : "Pull URLs"}
              </Button>
              {/* Clear spots — wipes Sights / Lunch stops / Destination
                  pubs in the draft. Disabled when all three are empty
                  to avoid a no-op click. No confirm dialog: nothing
                  is lost until the user hits Save, so they can still
                  reload the card to recover. */}
              <Button
                size="sm"
                variant="destructive"
                onClick={() => {
                  setDraft((d) => ({
                    ...d,
                    sights: [],
                    lunchStops: [],
                    destinationStops: [],
                  }))
                  // Scroll the user back to the top of this walk so
                  // they can immediately verify the lists collapsed
                  // and start re-curating from the top of the card,
                  // rather than staying parked at the footer.
                  cardRootRef.current?.scrollIntoView({ behavior: "smooth", block: "start" })
                }}
                disabled={
                  draft.sights.length === 0 &&
                  draft.lunchStops.length === 0 &&
                  draft.destinationStops.length === 0
                }
                className="h-7 text-xs"
                title="Clear all sights, lunch stops, and destination pubs (not saved until you click Save)"
              >
                Clear spots
              </Button>
              {onDelete && (
                <Button
                  size="sm"
                  variant="destructive"
                  onClick={() => setConfirmDeleteOpen(true)}
                  className="h-7 text-xs"
                >
                  Delete walk
                </Button>
              )}
            </div>
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

// Compact "previously hiked dates" editor — a row of ISO date chips
// (each with ✕ to remove) followed by a date <input> + Add button.
// Strictly admin-only; the dates never surface in public prose, only
// drive the "Undiscovered" filter on the map.
function PreviousWalkDatesEditor({
  walkId,
  dates,
  onChange,
}: {
  walkId: string
  dates: string[]
  onChange: (next: string[]) => void
}) {
  // Pending-date state — what's currently in the date input but not
  // yet committed to the array. Cleared after Add.
  const [pending, setPending] = useState("")
  const inputId = `prev-walk-dates-${walkId}`
  const addPending = () => {
    const trimmed = pending.trim()
    // Strict ISO format check — matches the server's cleanField rule
    // so we don't push values the server would silently drop.
    if (!/^\d{4}-\d{2}-\d{2}$/.test(trimmed)) return
    if (dates.includes(trimmed)) { setPending(""); return }
    // Keep the chips in chronological order so the user reads them
    // left-to-right as a timeline. Server also sorts on save, so
    // this is purely a UX nicety.
    onChange([...dates, trimmed].sort())
    setPending("")
  }
  return (
    <div className="mt-2">
      <Label htmlFor={inputId} className="mb-1 block text-[10px] text-muted-foreground">
        Previously hiked
        <span className="ml-1 font-normal italic text-muted-foreground/70">
          admin-only — drives the &quot;Undiscovered&quot; filter
        </span>
      </Label>
      {dates.length > 0 && (
        <div className="mb-1.5 flex flex-wrap gap-1">
          {dates.map((d) => (
            <span
              key={d}
              className="inline-flex items-center gap-1 rounded bg-muted px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground"
            >
              {d}
              <button
                type="button"
                aria-label={`Remove ${d}`}
                onClick={() => onChange(dates.filter((x) => x !== d))}
                className="cursor-pointer text-muted-foreground/70 hover:text-destructive"
              >
                ✕
              </button>
            </span>
          ))}
        </div>
      )}
      <div className="flex items-center gap-1.5">
        <Input
          id={inputId}
          type="date"
          value={pending}
          onChange={(e) => setPending(e.target.value)}
          // Pressing Enter inside the date input commits the date —
          // matches the more familiar "type and press enter" pattern
          // for tag inputs even though this one is a date picker.
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault()
              addPending()
            }
          }}
          className="h-7 text-xs"
        />
        <button
          type="button"
          onClick={addPending}
          disabled={!pending}
          className="shrink-0 rounded border border-border bg-muted/40 px-2 py-0.5 text-[11px] text-foreground hover:bg-muted disabled:opacity-40"
        >
          Add
        </button>
      </div>
    </div>
  )
}

// Read-only "hidden metadata" section. Surfaces the entry-level
// fields the source scraper populated (tagline, regions, places, …)
// plus the admin/build flags (extracted, onMap, issues, …) that
// otherwise never reach the editor. Display-only — no inputs, no
// draft state. Section starts collapsed; renders nothing when the
// payload's `meta` is absent or empty (the API skips emitting `meta`
// in that case, so the truthiness check covers both).
function MetadataSection({ walkId, meta }: { walkId: string; meta?: WalkMeta }) {
  if (!meta) return null

  // Reuse the same chip styles the card header uses so visual weight
  // matches. The metadata section is read-only context, so neutral
  // muted chips are right — destructive variants would imply action.
  const chipBase = "shrink-0 rounded px-1 py-0.5 font-mono text-[10px]"
  const neutralChip = `${chipBase} bg-muted text-muted-foreground`

  // Field-row helper: label on the left, content on the right.
  // mb-2 between rows mirrors the spacing used inside other sections.
  const Row = ({ label, children }: { label: string; children: React.ReactNode }) => (
    <div className="mb-2 last:mb-0">
      <div className="mb-1 text-[10px] uppercase tracking-wide text-muted-foreground">
        {label}
      </div>
      <div className="text-xs text-foreground/90">{children}</div>
    </div>
  )

  // Render a string[] as a chip row. Used for the simple list-shaped
  // metadata fields (regions, categories, features) and the per-bucket
  // places lists. flex-wrap keeps long lists tidy without overflowing.
  const ChipRow = ({ items }: { items: string[] }) => (
    <div className="flex flex-wrap gap-1">
      {items.map((v) => (
        <span key={v} className={neutralChip}>{v}</span>
      ))}
    </div>
  )

  // Places get sub-grouped — each populated bucket renders as its own
  // "label: chips" line. Skip buckets the API filtered out (it omits
  // empty arrays so the section can mirror that omission here).
  const placeBuckets = meta.places
    ? (Object.entries(meta.places) as [keyof NonNullable<WalkMeta["places"]>, string[] | undefined][])
        .filter(([, list]) => list && list.length > 0)
    : []

  // Collect the build flags that are explicitly true (or, for
  // resolution, populated). Render as one chip row at the bottom so
  // they don't drown out the substantive entry-level fields above.
  const flagChips: string[] = []
  if (meta.extracted) flagChips.push("extracted")
  if (meta.onMap) flagChips.push("onMap")
  if (meta.issues) flagChips.push("issues")
  if (meta.outsideMainlandBritain) flagChips.push("outsideMainlandBritain")
  if (meta.resolved) flagChips.push("resolved")

  return (
    <CollapsibleSection title="Metadata" bodyId={`metadata-section-${walkId}`}>
      {meta.tagline && <Row label="Tagline">{meta.tagline}</Row>}
      {meta.notes && <Row label="Notes">{meta.notes}</Row>}
      {meta.regions && <Row label="Regions"><ChipRow items={meta.regions} /></Row>}
      {meta.categories && <Row label="Categories"><ChipRow items={meta.categories} /></Row>}
      {meta.features && <Row label="Features"><ChipRow items={meta.features} /></Row>}
      {placeBuckets.length > 0 && (
        <Row label="Places">
          <div className="flex flex-col gap-1.5">
            {placeBuckets.map(([bucket, list]) => (
              <div key={bucket} className="flex flex-wrap items-center gap-1">
                <span className="mr-1 text-[10px] uppercase tracking-wide text-muted-foreground">
                  {bucket}
                </span>
                <ChipRow items={list as string[]} />
              </div>
            ))}
          </div>
        </Row>
      )}
      {meta.resolution && <Row label="Resolution">{meta.resolution}</Row>}
      {typeof meta.sourceIndex === "number" && (
        <Row label="Source index">{meta.sourceIndex}</Row>
      )}
      {flagChips.length > 0 && <Row label="Flags"><ChipRow items={flagChips} /></Row>}
    </CollapsibleSection>
  )
}

// Sights: a simple repeatable list with name (required), URL and
// description (both optional). Rows with empty names are silently
// dropped server-side, so there's no validation UI in the client.
// Small select for the venue's businessStatus. Shared by all three
// list editors (Sights / Lunch stops / Destination pubs). Empty value
// = "(unknown)" — the default for rows that haven't had Pull URLs run
// against them. Permanently-closed venues are hidden from the public
// prose by the build script (see formatLunchStops/Sights/Pubs).
//
// Border tint shifts to amber/red when the row is closed so the admin
// can spot dead venues at a glance without expanding rows.
// Multi-select dropdown for the canonical SPOT_TYPES vocabulary.
// Renders a single button labelled "Types: …" or "Types: pub, café"
// (truncating long lists). Click opens a checkbox list grouped by
// the bands defined in lib/spot-types (Refreshments / Natural /
// Outdoor / Cultural / Settlement / Other) with Separator dividers
// between bands. Toggle order in the source list = visual order in
// the dropdown.
function SpotTypesSelect({
  value,
  onChange,
}: {
  value: string[]
  onChange: (next: string[]) => void
}) {
  // Build the trigger label. Empty selection reads "Types: …" so the
  // button still has a visible affordance; otherwise we render the
  // selected labels comma-joined, truncated to fit narrow row widths.
  const triggerLabel = useMemo(() => {
    if (value.length === 0) return "Types: …"
    const labels = value
      .map((v) => SPOT_TYPE_LABELS[v])
      .filter((l): l is string => Boolean(l))
    return labels.length > 0 ? labels.join(", ") : "Types: …"
  }, [value])
  // Toggle a single value in the selection. Preserves existing order
  // for unchanged items so the rendered chip list stays stable.
  const toggle = (v: string) => {
    onChange(value.includes(v) ? value.filter((x) => x !== v) : [...value, v])
  }
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          title="Tag this spot with one or more types — auto-filled by Pull data when empty"
          className="h-7 min-w-[250px] max-w-[20rem] truncate rounded-lg border border-input bg-input/30 px-2 text-left text-[11px] hover:bg-muted/40"
        >
          {triggerLabel}
        </button>
      </DropdownMenuTrigger>
      {/* className overrides the default min-w so the popover is
          wide enough for two-word labels like "Nature reserve". */}
      <DropdownMenuContent align="end" className="min-w-[12rem]">
        {SPOT_TYPES.map((t, i) => {
          // Insert a Separator at the start of each new group except
          // the very first. SPOT_TYPES is pre-sorted by group order
          // so this works as a single-pass walk.
          const prevGroup = i > 0 ? SPOT_TYPES[i - 1].group : t.group
          const groupChanged = i > 0 && t.group !== prevGroup
          return (
            <div key={t.value}>
              {groupChanged && <DropdownMenuSeparator />}
              <DropdownMenuCheckboxItem
                checked={value.includes(t.value)}
                // Radix would close the menu on every checkbox click
                // by default; preventDefault keeps it open so admins
                // can pick multiple types in one go.
                onSelect={(e) => e.preventDefault()}
                onCheckedChange={() => toggle(t.value)}
                className="text-xs"
              >
                {t.label}
              </DropdownMenuCheckboxItem>
            </div>
          )
        })}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

function BusinessStatusSelect({
  value,
  onChange,
}: {
  value: string
  onChange: (next: string) => void
}) {
  const tint =
    value === "CLOSED_PERMANENTLY"
      ? "border-destructive/60 bg-destructive/5 text-destructive"
      : value === "CLOSED_TEMPORARILY"
        ? "border-amber-500/60 bg-amber-50 text-amber-800 dark:bg-amber-900/20 dark:text-amber-300"
        : "border-input bg-input/30"
  return (
    <select
      value={value}
      onChange={(e) => onChange(e.target.value)}
      title="Business status (auto-filled by Pull URLs; CLOSED_PERMANENTLY hides the venue from public prose)"
      className={`h-7 rounded-lg border px-2 text-[11px] ${tint}`}
    >
      <option value="">Status unknown</option>
      <option value="OPERATIONAL">Operational</option>
      <option value="CLOSED_TEMPORARILY">Closed temporarily</option>
      <option value="CLOSED_PERMANENTLY">Closed permanently</option>
    </select>
  )
}

function SightsEditor({
  walkId,
  sights,
  onChange,
}: {
  walkId: string
  sights: SightDraft[]
  onChange: (next: SightDraft[]) => void
}) {
  // Sights live inside their own CollapsibleSection so the styling
  // matches the new top-level sections (Key info / Tips / Private).
  // Title gets a "(N)" badge when sights exist so the admin sees the
  // row count without expanding.
  return (
    <CollapsibleSection title="Sights" bodyId={`sights-body-${walkId}`} count={sights.length}>
      <div className="flex flex-col gap-2">
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
              {/* Name + URL on one row. Name takes more horizontal
                  space than URL — sights names tend to be shorter
                  than URLs but this matches the way users scan the
                  fields (label first). */}
              <div className="flex gap-1.5">
                <Input
                  value={s.name}
                  onChange={(e) => {
                    const next = [...sights]
                    next[i] = { ...next[i], name: e.target.value }
                    onChange(next)
                  }}
                  placeholder="Name (required)"
                  className="h-7 flex-1 text-xs"
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
                  className="h-7 flex-1 text-xs"
                />
              </div>
              <div className="flex gap-1.5">
                <Input
                  value={s.description}
                  onChange={(e) => {
                    const next = [...sights]
                    next[i] = { ...next[i], description: e.target.value }
                    onChange(next)
                  }}
                  placeholder="Description (optional, admin-only for now)"
                  className="h-7 flex-1 text-xs"
                />
                <BusinessStatusSelect
                  value={s.businessStatus}
                  onChange={(businessStatus) => {
                    const next = [...sights]
                    next[i] = { ...next[i], businessStatus }
                    onChange(next)
                  }}
                />
                <SpotTypesSelect
                  value={s.types}
                  onChange={(types) => {
                    const next = [...sights]
                    next[i] = { ...next[i], types }
                    onChange(next)
                  }}
                />
              </div>
              {/* Read-only coords block — bottom-right of the row,
                  same role as the matching block on lunch / dest
                  rows. Auto-populated by Komoot Pull data; admins
                  don't edit these by hand. */}
              {(() => {
                const coords = formatRowCoords(s.lat, s.lng, s.kmIntoRoute)
                return coords ? (
                  <div className="flex justify-end">
                    <span
                      className="select-text font-mono text-[10px] text-muted-foreground"
                      title="Auto-populated by Pull data — read-only"
                    >
                      {coords}
                    </span>
                  </div>
                ) : null
              })()}
            </div>
          </div>
        ))}
      </div>
      <button
        type="button"
        onClick={() => onChange([...sights, { name: "", url: "", description: "", lat: "", lng: "", kmIntoRoute: "", businessStatus: "", types: [] }])}
        className="mt-2 w-full rounded border border-dashed border-border px-2 py-1 text-xs text-muted-foreground hover:bg-muted/40"
      >
        + Add sight
      </button>
      {/* An invisible anchor gives the label a stable `for` target if
          we later wire the first input up to it; not strictly required
          since each row has its own label via placeholder. */}
      <span id={`sights-${walkId}`} className="sr-only" />
    </CollapsibleSection>
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

// "Reservations recommended?" tri-state (yes / no / no opinion).
// The stored values stay "busy"/"quiet" — same data shape as before,
// just relabelled in the UI. "busy" → "Yes" (popular enough that you
// should book ahead), "quiet" → "No" (walk-up is fine). Active tints
// keep the rating-palette parallel so the controls read as a pair.
const LUNCH_BUSY_OPTIONS: Array<{ value: "busy" | "quiet"; label: string; classes: string }> = [
  { value: "busy",  label: "Yes", classes: "bg-amber-400 text-white hover:bg-amber-500" },
  { value: "quiet", label: "No",  classes: "bg-green-500 text-white hover:bg-green-600" },
]

// Refreshment-stop editor shared between Lunch stops and Last orders.
// Both sections store the same data shape (LunchDraft[]) and present
// the same controls — only the labels change. The optional override
// field at the top, when populated, replaces the formatted venue list
// in the public prose entirely (the rendered text becomes the override
// verbatim). The venue rows below stay editable so the admin can keep
// them as scratch notes when an override is in use.
function RefreshmentStopsEditor({
  walkId,
  kind,
  sectionTitle,
  itemLabel,
  addLabel,
  showLocation = true,
  stops,
  onStopsChange,
  override,
  onOverrideChange,
}: {
  walkId: string
  // Used as a stable id-prefix so the two instances on the same card
  // produce unique DOM ids (lunch-body-XXXX vs destinationStops-body-XXXX).
  kind: "lunch" | "destinationStops"
  sectionTitle: string
  // Per-row prefix shown in each row's header ("Lunch 1", "Destination pub 1").
  itemLabel: string
  addLabel: string
  // Whether to render the per-row Location input. False for destination
  // pubs (the location is implicit — the walk destination — so the prose
  // builder doesn't need it and an extra input would just be noise).
  showLocation?: boolean
  stops: LunchDraft[]
  onStopsChange: (next: LunchDraft[]) => void
  override: string
  onOverrideChange: (next: string) => void
}) {
  // Display badge on the section header. Shows "(override)" when the
  // free-text override is set, otherwise the venue count — so the
  // admin can spot at a glance which mode the section is in without
  // expanding it.
  const headerCount = override.trim() ? "override" : stops.length
  return (
    <CollapsibleSection title={sectionTitle} bodyId={`${kind}-body-${walkId}`} count={headerCount}>
      {/* Override sentence — sits at the TOP of the section so the
          dominant signal (when set, the venue list is moot in public
          prose) reads first. Empty by default; populated value replaces
          the formatted venue list verbatim in the public output. */}
      <div className="mb-3 rounded border border-border/60 bg-background/40 px-2 py-2">
        <Label htmlFor={`${kind}-override-${walkId}`} className="mb-1 block text-[10px] uppercase tracking-wide text-muted-foreground">
          Override sentence
          <span className="ml-1 font-normal italic text-muted-foreground/70">
            replaces the venue list in the public prose when populated
          </span>
        </Label>
        <Input
          id={`${kind}-override-${walkId}`}
          value={override}
          onChange={(e) => onOverrideChange(e.target.value)}
          placeholder='e.g. "BYO — there are no good options on this walk."'
          className="h-7 text-xs"
        />
      </div>
      <div className="flex flex-col gap-2">
        {stops.map((s, i) => (
          <div
            key={i}
            className="rounded border border-border/60 bg-background px-2 py-1.5"
          >
            <div className="mb-1 flex items-center justify-between">
              <span className="text-[10px] uppercase tracking-wide text-muted-foreground">
                {itemLabel} {i + 1}
              </span>
              <div className="flex items-center gap-0.5">
                <button
                  type="button"
                  onClick={() => onStopsChange(arrayMove(stops, i, 0))}
                  disabled={i === 0}
                  className="rounded px-1 text-muted-foreground hover:bg-muted/60 disabled:opacity-30 disabled:hover:bg-transparent"
                  aria-label={`Move ${itemLabel} ${i + 1} to top`}
                  title="Move to top"
                >
                  ⇈
                </button>
                <button
                  type="button"
                  onClick={() => onStopsChange(arrayMove(stops, i, i - 1))}
                  disabled={i === 0}
                  className="rounded px-1 text-muted-foreground hover:bg-muted/60 disabled:opacity-30 disabled:hover:bg-transparent"
                  aria-label={`Move ${itemLabel} ${i + 1} up`}
                  title="Move up"
                >
                  ▲
                </button>
                <button
                  type="button"
                  onClick={() => onStopsChange(arrayMove(stops, i, i + 1))}
                  disabled={i === stops.length - 1}
                  className="rounded px-1 text-muted-foreground hover:bg-muted/60 disabled:opacity-30 disabled:hover:bg-transparent"
                  aria-label={`Move ${itemLabel} ${i + 1} down`}
                  title="Move down"
                >
                  ▼
                </button>
                <button
                  type="button"
                  onClick={() => onStopsChange(stops.filter((_, j) => j !== i))}
                  className="ml-0.5 rounded px-1 text-muted-foreground hover:text-destructive"
                  aria-label={`Delete ${itemLabel} ${i + 1}`}
                  title="Delete"
                >
                  ×
                </button>
              </div>
            </div>
            <div className="space-y-1.5">
              {/* Name (+ optional Location) + URL on one row. Three
                  equal flex cells when Location is shown; two cells
                  when it isn't (destination pubs hide the location
                  since the walk destination is implicit). Longer
                  values truncate inside their input rather than
                  wrapping the row. */}
              <div className="flex gap-1.5">
                <Input
                  value={s.name}
                  onChange={(e) => {
                    const next = [...stops]
                    next[i] = { ...next[i], name: e.target.value }
                    onStopsChange(next)
                  }}
                  placeholder="Name (required)"
                  className="h-7 flex-1 text-xs"
                />
                {showLocation && (
                  <Input
                    value={s.location}
                    onChange={(e) => {
                      const next = [...stops]
                      next[i] = { ...next[i], location: e.target.value }
                      onStopsChange(next)
                    }}
                    placeholder="Location"
                    className="h-7 flex-1 text-xs"
                  />
                )}
                <Input
                  type="url"
                  value={s.url}
                  onChange={(e) => {
                    const next = [...stops]
                    next[i] = { ...next[i], url: e.target.value }
                    onStopsChange(next)
                  }}
                  placeholder="URL (optional)"
                  className="h-7 flex-1 text-xs"
                />
              </div>
              <div className="flex gap-1.5">
                <Input
                  value={s.notes}
                  onChange={(e) => {
                    const next = [...stops]
                    next[i] = { ...next[i], notes: e.target.value }
                    onStopsChange(next)
                  }}
                  placeholder="Notes (optional, admin-only for now)"
                  className="h-7 flex-1 text-xs"
                />
                <BusinessStatusSelect
                  value={s.businessStatus}
                  onChange={(businessStatus) => {
                    const next = [...stops]
                    next[i] = { ...next[i], businessStatus }
                    onStopsChange(next)
                  }}
                />
                <SpotTypesSelect
                  value={s.types}
                  onChange={(types) => {
                    const next = [...stops]
                    next[i] = { ...next[i], types }
                    onStopsChange(next)
                  }}
                />
              </div>
              {/* Rating + busy — small toggle-button rows. Clicking
                  the active button clears it back to "no opinion".
                  Both fields share the same button-row shape so the
                  controls scan as a parallel pair. */}
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
                          onStopsChange(next)
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
                <div className="flex items-center gap-1">
                  <span className="mr-1 text-[10px] uppercase tracking-wide text-muted-foreground">
                    Reservations recommended?
                  </span>
                  {LUNCH_BUSY_OPTIONS.map((b) => {
                    const active = s.busy === b.value
                    return (
                      <button
                        key={b.value}
                        type="button"
                        onClick={() => {
                          const next = [...stops]
                          next[i] = { ...next[i], busy: active ? "" : b.value }
                          onStopsChange(next)
                        }}
                        className={
                          "rounded px-1.5 py-0.5 text-[10px] transition-colors " +
                          (active
                            ? b.classes
                            : "border border-border bg-background text-muted-foreground hover:bg-muted/60")
                        }
                      >
                        {b.label}
                      </button>
                    )
                  })}
                </div>
                {/* Read-only coords block — bottom-right of the row,
                    aligned with the rating/reservations buttons.
                    Auto-populated by Komoot Pull data; admins don't
                    edit these by hand. Empty when no coords/km set,
                    so brand-new manual rows don't render a stray dot. */}
                {(() => {
                  const coords = formatRowCoords(s.lat, s.lng, s.kmIntoRoute)
                  return coords ? (
                    <span
                      className="ml-auto select-text font-mono text-[10px] text-muted-foreground"
                      title="Auto-populated by Pull data — read-only"
                    >
                      {coords}
                    </span>
                  ) : null
                })()}
              </div>
            </div>
          </div>
        ))}
      </div>
      <button
        type="button"
        onClick={() =>
          onStopsChange([
            ...stops,
            { name: "", location: "", url: "", notes: "", rating: "", busy: "", lat: "", lng: "", kmIntoRoute: "", businessStatus: "", types: [] },
          ])
        }
        className="mt-2 w-full rounded border border-dashed border-border px-2 py-1 text-xs text-muted-foreground hover:bg-muted/40"
      >
        {addLabel}
      </button>
      <span id={`${kind}-${walkId}`} className="sr-only" />
    </CollapsibleSection>
  )
}
