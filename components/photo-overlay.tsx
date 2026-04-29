// StationModal — full-viewport modal showing station info + Flickr photo grid.
//
// Opens when a station dot is clicked on the map. Dismissed by clicking the
// overlay backdrop or the close button (both handled by Radix Dialog).
//
// Photos are fetched lazily on first open, same as before.

"use client"

import { useCallback, useEffect, useRef, useState, type RefCallback } from "react"
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog"
import { MAX_GALLERY_PHOTOS, type FlickrPhoto } from "@/lib/flickr"
import { getEffectiveJourney, prettifyStationLabel } from "@/lib/effective-journey"
import { categorizePlaceNames } from "@/lib/extract-place-names"
import londonTerminalsData from "@/data/london-terminals.json"
// CRS allowlist for the TfL Oyster / contactless PAYG zone. Same data
// the map.tsx Feature filter consumes — see data/oyster-stations.json.
// Used here to gate the "no National Rail ticket needed" hint at the
// bottom of the train-info block.
import oysterStationsData from "@/data/oyster-stations.json"

// Calls our server-side proxy at /api/flickr/photos instead of Flickr directly.
// Why: Safari + iCloud Private Relay shares egress IPs that Flickr sometimes
// rate-limits, causing empty/failed responses. Same-origin requests bypass
// Private Relay entirely — and our server reaches Flickr from a clean IP.
//
// Fetches ONE algo per call. The client orchestrates fallback filling (see
// the useEffect below) when the default algo returns fewer than 12 photos.
type Algo = "landscapes" | "hikes" | "station" | "custom"
type FlickrSort = "relevance" | "interestingness-desc"
type CustomSettings = { includeTags: string[]; excludeTags: string[]; radius: number; sort?: FlickrSort }
async function fetchPhotosViaProxy(
  lat: number,
  lng: number,
  algo: Algo,
  custom?: CustomSettings,
  // Cache-busting token. When truthy, the server treats this as a distinct
  // cache key (so the admin's "Refresh gallery" click always hits Flickr).
  // Zero/undefined = normal cached behaviour.
  bust?: number,
): Promise<FlickrPhoto[]> {
  const params = new URLSearchParams({
    lat: String(lat),
    lng: String(lng),
    algo,
  })
  if (algo === "custom" && custom) {
    params.set("includeTags", custom.includeTags.join(", "))
    params.set("excludeTags", custom.excludeTags.join(", "))
    params.set("radius", String(custom.radius))
    if (custom.sort) params.set("sort", custom.sort)
  }
  if (bust) params.set("bust", String(bust))
  const res = await fetch(`/api/flickr/photos?${params}`)
  if (!res.ok) throw new Error(`photos proxy ${res.status}`)
  const data = (await res.json()) as { photos?: FlickrPhoto[] }
  return data.photos ?? []
}
import { Button } from "@/components/ui/button"
import { LogoSpinner } from "@/components/logo-spinner"
import WalksAdminPanel from "@/components/walks-admin-panel"
import { ConfirmDialog } from "@/components/confirm-dialog"
import { HugeiconsIcon } from "@hugeicons/react"
import { ArrowDown01Icon, Cancel01Icon, MapingIcon } from "@hugeicons/core-free-icons"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"

export type { FlickrPhoto }

// Numeric rating shared with map.tsx — derived from the station's walks.
type Rating = 1 | 2 | 3 | 4

/** Journey info for a single origin, as stored in the GeoJSON.
 * `legs[]` fields are populated by scripts/fetch-journeys.mjs from Google's
 * Routes API — vehicleType + timestamps are optional because older records
 * (written before those fields were added to the field mask) won't have them. */
export type JourneyInfo = {
  durationMinutes: number
  changes: number
  legs: {
    departureStation: string
    arrivalStation: string
    /** "SUBWAY" | "WALK" | "HEAVY_RAIL" | "BUS" | etc. — from Routes API */
    vehicleType?: string
    /** ISO timestamps — used to compute effective durations when cluster logic strips a leg */
    departureTime?: string
    arrivalTime?: string
  }[]
  /**
   * Intermediate London-area calling points for RTT-sourced direct journeys.
   * Lets the user see "I could board at Bromley South and save 18 min rather
   * than go to Victoria first". Populated only when the journey is a direct
   * train (changes === 0) AND came from RTT data with a resolvable calling
   * sequence. Undefined for stitched or Routes-API-only journeys.
   */
  londonCallingPoints?: {
    name: string
    crs: string
    /** Minutes from the journey's start (origin) to this calling point. */
    minutesFromOrigin: number
  }[]
  /**
   * London-area stations the winning direct train calls at BEFORE the origin.
   * Lets a user say to a friend further out, "join me at Kentish Town, it's
   * the same train". Hints show "(Nm longer)" since boarding earlier adds
   * that many minutes to the total journey. Sourced from RTT, London-filtered
   * at the map layer; undefined when not a direct/RTT journey or when no
   * upstream London stations exist on the route.
   */
  londonUpstreamCallingPoints?: {
    name: string
    crs: string
    /** Minutes ADDED to the total trip by boarding at this upstream station. */
    minutesExtra: number
  }[]
  /**
   * When set, the arrivalStation of the HEAVY_RAIL leg that the calling-points
   * arrays describe. Map.tsx uses this to pin the calling-points to a specific
   * leg of a multi-leg custom-primary journey (e.g. for a KT→Shoeburyness
   * journey routed via [KT→Farringdon OTHER, Farringdon→Stratford HEAVY,
   * Stratford→Shoeburyness HEAVY] we pin to the final leg's arrival
   * "Shoeburyness" so the calling-points narrative describes LST/Barking/
   * Upminster — the alternative boarding points for the Shoeburyness-bound
   * train — rather than the first HEAVY_RAIL leg's change station.) Absent
   * when the calling-points describe the journey's first HEAVY_RAIL leg
   * (the existing behaviour for non-custom primaries).
   */
  callingPointsLegArrival?: string
  /**
   * Alternative direct-train routes from OTHER London termini, within
   * +30 min of this journey's duration. Only populated when the active
   * primary is the synthetic London cluster (not for standalone-terminus
   * or custom primaries — there's no ambiguity about where to start
   * from in those cases). Each entry describes a distinct terminus's
   * direct train to the same destination, with its own calling points
   * so the modal can render a parallel paragraph beneath the main route.
   */
  alternativeRoutes?: {
    terminusName: string
    durationMinutes: number
    /** 0 = direct train; 1+ = that many changes. */
    changes: number
    /** When changes > 0, the change-station names in order (typically
     *  one entry — we cap indirect alternatives at 1 change). Used by
     *  the modal to render "with 1 change at Foo." after the time. */
    changeStations: string[]
    londonCallingPoints: { name: string; crs: string; minutesFromOrigin: number }[]
    londonUpstreamCallingPoints: { name: string; crs: string; minutesExtra: number }[]
  }[]
}

type StationModalProps = {
  open: boolean
  onClose: () => void
  lat: number
  lng: number
  stationName: string
  minutes: number
  flickrCount: number | null
  /** Screen-pixel position of the station icon — the modal animates from/to here */
  originX?: number
  originY?: number
  /** When true, the dev tools section is shown in the modal */
  devMode?: boolean
  /** The station's derived rating (1..4), or null if no walks. Display-
   *  only — there is no admin UI for setting it any more. */
  currentRating?: Rating | null
  /** Toggles the station's "buried" flag (right-click equivalent). */
  onBury?: () => void
  /** True when this station is currently buried (admin-only). */
  isBuried?: boolean
  /** Photos the admin has approved for this station (always displayed) */
  approvedPhotos?: FlickrPhoto[]
  /** Ids of approved photos that are also pinned (show the pin badge) */
  pinnedIds?: Set<string>
  /** Called when the admin approves a photo (lands at end of approved queue) */
  onApprovePhoto?: (photo: FlickrPhoto) => void
  /** Called when the admin "jump to tops" an unapproved photo — approve +
   *  place at the top of the non-pinned section (just below the last pin). */
  onApprovePhotoAtTop?: (photo: FlickrPhoto) => void
  /** Called when the admin un-approves a photo (also removes any pin) */
  onUnapprovePhoto?: (photoId: string) => void
  /** Called when the admin pins a photo (implicitly approves + moves to top of pins) */
  onPinPhoto?: (photo: FlickrPhoto) => void
  /** Called when the admin removes a pin (photo stays approved & in place) */
  onUnpinPhoto?: (photoId: string) => void
  /** Called when the admin moves an approved photo */
  onMovePhoto?: (photoId: string, direction: "up" | "down" | "top" | "bottom") => void
  /** Public note for this station — visible to everyone */
  publicNote?: string
  /** Private note — only visible in admin mode */
  privateNote?: string
  /** Admin's full unfiltered single-block walk prose (every walk +
   *  every note, joined). Rendered as one block when adminMode is on. */
  adminWalksAll?: string
  /** Public sectioned walk prose — station-to-station walks. Filtered
   *  to 3 walks per section by the build script. */
  publicWalksS2S?: string
  /** Public sectioned walk prose — circular walks (start === end). */
  publicWalksCircular?: string
  /** Saves the user-editable notes when the overlay closes. The walk
   *  prose fields are build-only and not edited here. */
  onSaveNotes?: (publicNote: string, privateNote: string) => void
  /** The default Flickr algo for this station. Decided by the parent based on
   *  cluster/excluded membership — Central London terminals + excluded
   *  stations default to "station"; everything else defaults to "landscapes". */
  defaultAlgo?: "landscapes" | "station"
  /** Per-station custom tag config. null when no custom feed is set up. */
  customSettings?: CustomSettings | null
  /** Save per-station custom config. Pass null to clear. */
  onSaveCustom?: (custom: CustomSettings | null) => void
  /** Global presets for landscapes/hikes/station. Hydrated on mount. */
  presets?: {
    landscapes: CustomSettings
    hikes: CustomSettings
    station: CustomSettings
  } | null
  /** Save a global preset (affects every station that uses it). */
  onSavePreset?: (name: "landscapes" | "hikes" | "station", preset: CustomSettings) => void
  /** Reset a global preset to its hardcoded default. */
  /** Journey data keyed by origin station name (e.g. "Farringdon") */
  journeys?: Record<string, JourneyInfo>
  /** Friend origin station name — when set, shows dual journey info */
  friendOrigin?: string | null
  /** Which origin station is the primary (default "Farringdon", or "Stratford" via URL) */
  primaryOrigin?: string
  /** When true, this station is a friend origin — hides travel info and hike button */
  isFriendOrigin?: boolean
  /** When true, this station is a primary origin (or a clustered sibling) — same
   *  simplified view as isFriendOrigin: no journey info, no Hike button. Also
   *  triggers the origin-specific Flickr search algorithm (smaller radius). */
  isPrimaryOrigin?: boolean
  /** When true, the station name represents a PLACE rather than a specific
   *  station (e.g. "City of London"). Suppresses the " Station" title suffix. */
  isSynthetic?: boolean
  /** Display names of the synthetic cluster's member stations, in declared
   *  order. When set (i.e. the modal is open for a synthetic primary or
   *  friend) we render a one-line header below the title:
   *  "A cluster of N stations: A, B, and C". */
  clusterMemberNames?: string[]
  /** Cluster members with full coords + names — used to render the
   *  "Hikes from stations" dropdown (one menu item per member, sorted
   *  alphabetically by full name). Each item links to the same
   *  Komoot URL the single-station Hike button would, just for that
   *  member's coords. Undefined for non-synthetic stations; in that
   *  case the single-station Hike button is rendered instead. */
  clusterMembers?: { name: string; lat: number; lng: number }[]
  /** When the destination is a synthetic, the journey description is
   *  ambiguous ("1h19 from Euston" doesn't say which Birmingham
   *  station). This prop gives the top-ranked cluster member name
   *  per origin so we can prepend "{member} is " to each side's
   *  description: "Birmingham New Street is 1h19 from Euston."
   *  Different origins can pick different members because "best
   *  from London" and "best from Manchester" aren't always the same. */
  syntheticJourneyMember?: {
    primary?: string
    friend?: string
  }
  /** Cluster-member full station names of the ACTIVE FRIEND, when the
   *  friend is synthetic. Used to extra-bold the full station name in
   *  the friend journey paragraph: e.g. "Birmingham New Street" rather
   *  than just "Birmingham". Different from clusterMemberNames above,
   *  which is for the OVERLAY's own synthetic (cluster header copy). */
  friendClusterMemberNames?: string[]
  /** Admin-only: 3-letter CRS code (e.g. "CLJ"). When present AND
   *  adminMode is true, the title is prefixed with the code — helps
   *  cross-reference the admin RTT status panel and origin-routes.json. */
  stationCrs?: string
  /** Admin-only: extra CRS codes for cluster members. Synthetic
   *  overlays pass their members' CRS codes here so the
   *  WalksAdminPanel fetches and displays every member's walks in
   *  one place. Undefined for non-synthetic stations. */
  clusterMemberCrsCodes?: string[]
  /** True when the user is currently in admin mode. Gates the CRS prefix. */
  adminMode?: boolean
  /** True when the active primary is the synthetic Central London
   *  cluster. Gates the terminus-highlight feature (bolder text for
   *  any London terminus mentioned in the journey info). Computed in
   *  map.tsx against the cluster's coord rather than re-derived here
   *  because the `primaryOrigin` string below is a display NAME
   *  ("London"), not the coord — the comparison would be fragile if
   *  driven off the name. */
  isLondonHome?: boolean
  /** Admin-only: true when the station is flagged as having an issue.
   *  Station-global — same flag regardless of which primary is selected. */
  hasIssue?: boolean
  /** Admin-only: toggles the hasIssue flag for this station. */
  onToggleIssue?: (hasIssue: boolean) => void
  /** Admin-only: called after a structured walk edit saves + rebuilds.
   *  Parent should refetch station-notes so the updated ramblerNote
   *  flows back into this overlay via the `ramblerNote` prop. */
  onWalkSaved?: () => void | Promise<void>
}

// Pairs of stations linked by a walking concourse — when both appear as
// consecutive change stations in a journey description, they're rendered
// as "A/B" rather than "A and B" because the underlying journey already
// counts them as one change. See singleOriginDescription's merge loop.
const WALKING_PAIRS: Array<[string, string]> = [
  ["Waterloo", "Waterloo East"],
]

// Canonical London-terminus names (+ their aliases) used by the
// highlighter. Built once at module load from london-terminals.json so
// the regex below covers every form the journey text might contain —
// "London Bridge", "St Pancras", "Kings Cross" (canonical) AND "St.
// Pancras", "London Waterloo" (common aliases). Waterloo East is its
// own entry in the terminals file, so it gets highlighted distinctly
// from Waterloo (matters when a calling-points line shows both).
const LONDON_TERMINUS_FORMS: string[] = (() => {
  const forms = new Set<string>()
  for (const t of londonTerminalsData as Array<{ name: string; aliases: string[] }>) {
    forms.add(t.name)
    for (const a of t.aliases) forms.add(a)
  }
  // Sort longest-first so the regex prefers "Waterloo East" over
  // "Waterloo" when both could match (leftmost alternation is greedy
  // on length in JS regex — longest-first alternatives win).
  return [...forms].sort((a, b) => b.length - a.length)
})()
const LONDON_TERMINUS_RE = new RegExp(
  `\\b(${LONDON_TERMINUS_FORMS.map((f) => f.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|")})\\b`,
  "g",
)

// Wrap station-name occurrences in the given text with styled spans.
// Two classes of highlighting, driven by the opts config:
//   • Termini (when isLondonHome) — font-medium + text-muted-foreground.
//     Subtle two-axis label for London-terminus names.
//   • extraBoldNames — font-medium alone (no muted tint). Used to
//     distinguish the HOME and FRIEND origin stations from each other
//     when friend mode is active. Muted would make them blend in with
//     the termini highlights; plain font-medium keeps them visually
//     distinct while still differentiated from regular body text.
//
// When a name matches BOTH a terminus AND an extraBoldNames entry
// (e.g. home = Paddington + friend mode on), the terminus rule wins
// so we get the consistent muted+medium treatment.
function highlightTermini(
  text: string,
  isLondonHome: boolean,
  extraBoldNames: string[] = [],
): React.ReactNode {
  if (!text) return text
  const terminusForms = isLondonHome ? LONDON_TERMINUS_FORMS : []
  const terminusSet = new Set(terminusForms)
  const allForms = [...new Set([...terminusForms, ...extraBoldNames])]
    .filter(Boolean)
    .sort((a, b) => b.length - a.length)
  if (allForms.length === 0) return text
  const re = new RegExp(
    `\\b(${allForms.map((f) => f.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|")})\\b`,
    "g",
  )
  const parts: React.ReactNode[] = []
  let last = 0
  let match: RegExpExecArray | null
  while ((match = re.exec(text)) !== null) {
    if (match.index > last) parts.push(text.slice(last, match.index))
    const isTerminus = terminusSet.has(match[0])
    const cls = isTerminus ? "font-medium text-muted-foreground" : "font-medium"
    parts.push(<span key={parts.length} className={cls}>{match[0]}</span>)
    last = match.index + match[0].length
  }
  if (last < text.length) parts.push(text.slice(last))
  return parts
}

// "Ghost stations" — request stops with such minimal service that a
// normal Saturday-morning RTT fetch (09:00–12:00) almost never captures
// them. They have no usable journey time from London; instead of
// rendering "null minutes from London" or a misleading time we surface
// a dedicated message in their station modal.
//
// FIN (Finstock) — Cotswold Line; ~2 trains/day, frequently no Saturday
//   service in the sampled window.
// PSW (Polesworth) — WCML; one train per week (Saturday morning) on a
//   request-stop basis. Famously the least-served station in Britain.
const GHOST_STATIONS = new Set(["FIN", "PSW"])
const GHOST_STATION_MESSAGE = "Ghost station — minimal service on weekends."

// Z-prefix CRS codes that ARE real National Rail stations despite
// looking like our Underground/DLR convention. These are interchanges
// where OSM kept the Z-prefix tag even though the station also has NR
// service (Thameslink at Farringdon, Elizabeth line at Whitechapel,
// etc.). Without this allowlist, they'd be falsely flagged "Not a
// National Rail Station". Extend if a future origin-routes fetch
// surfaces another Z-prefix CRS in real RTT data.
const NR_Z_PREFIX_CRS = new Set(["ZFD", "ZLW", "ZEL", "ZCW", "ZTU"])
function isNonNrStation(crs: string | undefined): boolean {
  if (!crs) return true
  if (!crs.startsWith("Z")) return false
  return !NR_Z_PREFIX_CRS.has(crs)
}

// Oyster CRS lookup. Combines the curated NR allowlist with the
// "Z-prefix → Oyster" rule (covers Underground / DLR / most Elizabeth
// line entries OSM tagged with Z*). Module-scope so the Set is built
// once at import time, not per render.
const OYSTER_CRS_SET = new Set(oysterStationsData.nrStations as string[])
function isInOysterZone(crs: string | undefined): boolean {
  if (!crs) return false
  if (crs.startsWith("Z")) return true
  return OYSTER_CRS_SET.has(crs)
}

// Formats minutes as human-readable text, pluralising "hour"/"minute" correctly.
// Edge cases handled: "1 minute", "1 hour", "2 hours", "1 hour and 1 minute".
function formatMinutes(minutes: number): string {
  const pluralMin = (m: number) => `${m} ${m === 1 ? "minute" : "minutes"}`
  const pluralHr = (h: number) => `${h} ${h === 1 ? "hour" : "hours"}`
  if (minutes < 60) return pluralMin(minutes)
  const h = Math.floor(minutes / 60)
  const m = minutes % 60
  return m === 0 ? pluralHr(h) : `${pluralHr(h)} and ${pluralMin(m)}`
}

// Formats a single origin's journey, e.g.
// "1 hour from Farringdon. Two changes: St Pancras and South Croydon."
// Cluster-aware: when the primary origin is Kings X / Euston / Euston Square,
// strips the initial tube hop so the reported time and change count reflect
// starting at the actual train's departure station (e.g. "1 hour from Euston"
// rather than "1 hour and 10 minutes from Kings Cross, one change: Euston").
function singleOriginDescription(origin: string, journey: JourneyInfo): string {
  const effective = getEffectiveJourney(journey, origin)
  const time = formatMinutes(effective.effectiveMinutes)
  const displayOrigin = effective.effectiveOrigin
  const changes = effective.effectiveChanges
  // When cluster adjustment fired, we only want the changes AFTER the stripped
  // first leg — so we slice legs accordingly.
  const legs = effective.isClusterHop ? journey.legs.slice(1) : journey.legs

  // Direct-train phrasing: inline "direct" instead of a second sentence, so
  // a tap on a direct-reachable destination reads like
  //   "1 hour and 9 minutes direct from Kings Cross."
  // rather than the previous two-sentence form.
  if (changes === 0) return `${time} direct from ${displayOrigin}.`

  // Pretty-print each intermediate station name so the rendered sentence
  // reads naturally (no curly apostrophes, no "(COV)" codes, no "International").
  const rawChangeStations = legs.slice(0, -1).map((leg) => prettifyStationLabel(leg.arrivalStation))
  // Collapse consecutive walking-pair stations (e.g. "Waterloo" then
  // "Waterloo East" via the WAT↔WAE concourse link) into a single
  // slash-joined entry. The underlying journey already counts them as
  // ONE change in journey.changes (the walking leg is treated as part
  // of the WAT interchange), so listing both names sounded like an
  // extra change. Slash phrasing — "Waterloo/Waterloo East" — implies
  // they're the same station complex.
  const changeStations: string[] = []
  for (let i = 0; i < rawChangeStations.length; i++) {
    const cur = rawChangeStations[i]
    const next = rawChangeStations[i + 1]
    const pair = WALKING_PAIRS.find(
      ([a, b]) => (a === cur && b === next) || (b === cur && a === next),
    )
    if (pair) {
      changeStations.push(`${cur}/${next}`)
      i++ // skip the second half — already merged
    } else {
      changeStations.push(cur)
    }
  }
  const changeList =
    changeStations.length <= 2
      ? changeStations.join(" and ")
      : changeStations.slice(0, -1).join(", ") + " and " + changeStations.at(-1)

  // 1-change journeys read more naturally as "Change at X" than
  // "One change: X" — the prior wording felt over-formal for the
  // common case. Multi-change keeps the numbered list-style copy
  // ("Two changes: X and Y.") so the change count stays explicit.
  if (changes === 1) {
    return `${time} from ${displayOrigin}. Change at ${changeList}.`
  }
  const changeNumber = ["Zero", "One", "Two", "Three", "Four", "Five"][changes] ?? String(changes)
  return `${time} from ${displayOrigin}. ${changeNumber} changes: ${changeList}.`
}

// Builds travel description — shows both origins when friend mode is active.
// primaryOrigin controls which journey is shown first (e.g. "Farringdon" or "Stratford").
function journeyDescription(
  minutes: number,
  journeys?: Record<string, JourneyInfo>,
  friendOrigin?: string | null,
  primaryOrigin: string = "Farringdon"
): string {
  const journey = journeys?.[primaryOrigin]
  if (!journey) return `${formatMinutes(minutes)} from central London.`

  let desc = singleOriginDescription(primaryOrigin, journey)

  if (friendOrigin && journeys?.[friendOrigin]) {
    desc += " " + singleOriginDescription(friendOrigin, journeys[friendOrigin])
  }

  return desc
}

// Builds a Komoot discover URL for hiking near a station.
// The station name goes in the path, and lat/lng are used for the
// startLocation + @ parameters so Komoot centres the map correctly.
//
// SHARED between the regular single-station Hike button and the
// synthetic-overlay dropdown — change the URL shape here and both
// surfaces follow.
function komootUrl(name: string, lat: number, lng: number): string {
  const slug = encodeURIComponent(name)
  return (
    `https://www.komoot.com/discover/${slug}/@${lat},${lng}/tours` +
    `?sport=hike&map=true` +
    `&startLocation=${lat}%2C${lng}` +
    // min_length is in metres — 10000 = 10 km minimum hike length
    `&max_distance=5000&min_length=10000&pageNumber=1`
  )
}

// Hike control — three render modes:
//   • clusterMembers set → "Hikes from stations ▾" dropdown
//     (one menu item per member, alphabetically sorted by name).
//   • non-synthetic, non-origin station → single "Hikes from station"
//     button linking to komootUrl(stationName, lat, lng).
//   • non-synthetic primary or friend origin → renders nothing (these
//     overlays don't get a Hike action).
//
// Used twice in the modal: pinned to the title row on desktop, and as
// a full-width button below the notes/walks block on mobile.
function HikesControl({
  className,
  stationName,
  lat,
  lng,
  clusterMembers,
  isFriendOrigin,
  isPrimaryOrigin,
}: {
  className?: string
  stationName: string
  lat: number
  lng: number
  clusterMembers?: { name: string; lat: number; lng: number }[]
  isFriendOrigin?: boolean
  isPrimaryOrigin?: boolean
}) {
  // Synthetic dropdown — preferred when cluster members are present,
  // even for the active primary/friend (those overlays still expose
  // hikes from each member station).
  if (clusterMembers && clusterMembers.length > 0) {
    // Alphabetical by full name — matches signage. e.g. "Birmingham
    // New Street", "Birmingham Snow Hill", "Charing Cross".
    const sorted = [...clusterMembers].sort((a, b) => a.name.localeCompare(b.name))
    return (
      <DropdownMenu>
        {/* DropdownMenuTrigger asChild lets us style the trigger as a
            normal Button while still wiring up Radix's keyboard /
            ARIA / open-on-click behaviour. */}
        <DropdownMenuTrigger asChild>
          <Button className={className}>
            <HugeiconsIcon icon={MapingIcon} />
            Hikes from stations
            {/* Down-chevron sits at the right of the label, matching
                shadcn's typical Select / Combobox affordance. */}
            <HugeiconsIcon icon={ArrowDown01Icon} />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="z-[60]">
          {sorted.map((m) => (
            <DropdownMenuItem key={`${m.lng},${m.lat}`} asChild>
              {/* Each item opens Komoot in a new tab using the SHARED
                  komootUrl helper — keeps the per-station URL shape
                  identical to the single-station button. */}
              <a
                href={komootUrl(m.name, m.lat, m.lng)}
                target="_blank"
                rel="noopener noreferrer"
              >
                {m.name}
              </a>
            </DropdownMenuItem>
          ))}
        </DropdownMenuContent>
      </DropdownMenu>
    )
  }
  // Non-synthetic primary/friend overlays: no Hike action.
  if (isFriendOrigin || isPrimaryOrigin) return null
  // Regular single-station Hike button.
  return (
    <Button asChild className={className}>
      <a
        href={komootUrl(stationName, lat, lng)}
        target="_blank"
        rel="noopener noreferrer"
      >
        <HugeiconsIcon icon={MapingIcon} />
        Hikes from station
      </a>
    </Button>
  )
}

/** Reset a textarea's height so it exactly fits its content (no scrollbar). */
function autoResize(el: HTMLTextAreaElement) {
  el.style.height = "auto"        // shrink first so scrollHeight recalculates
  el.style.height = `${el.scrollHeight}px`  // expand to fit content
}

/**
 * Invoke `cb` while pinning the dialog's scroll position in place.
 *
 * Why: admin curation actions (pin/unpin/approve/move) trigger a React
 * re-render of the photo grid. Even when the photo's array index doesn't
 * change, focus shifts and layout micro-adjustments (pin badge
 * appearing, button style flipping) can cause the browser to auto-scroll
 * — most noticeably jumping the viewport to the top. Capturing scrollTop
 * on both scroll containers (inner `[data-modal-scroll]` on desktop,
 * outer `[data-slot="dialog-content"]` on mobile) and restoring it in
 * the next animation frame makes the scroll position immovable across
 * the action, so the admin keeps their place in the gallery.
 */
function withPreservedScroll(cb: () => void) {
  if (typeof document === "undefined") { cb(); return }
  const inner = document.querySelector('[data-modal-scroll]')
  const outer = document.querySelector('[data-slot="dialog-content"]')
  const snapshots: Array<{ el: HTMLElement; top: number }> = []
  if (inner instanceof HTMLElement) snapshots.push({ el: inner, top: inner.scrollTop })
  if (outer instanceof HTMLElement) snapshots.push({ el: outer, top: outer.scrollTop })
  cb()
  // rAF runs after React commits the update, so setting scrollTop here
  // lands on the post-render layout — any browser-triggered jump during
  // the commit is undone on the very next frame.
  requestAnimationFrame(() => {
    for (const { el, top } of snapshots) el.scrollTop = top
  })
}

/**
 * Turn markdown-style [text](url) links into clickable <a> elements.
 * Plain text passes through unchanged.
 */
// Render a short inline-markdown string into React nodes. Supports three
// constructs:
//   [text](url)   — external link
//   **text**      — bold
//   *text*        — italic
//
// Patterns may combine at the leaves (e.g. `[**bold**](url)` or
// `**[link](url)**`) — the function recurses on the inner match so
// nested formatting works. We intentionally DO NOT call into a full
// markdown parser: notes are one-paragraph admin-editable strings and
// keeping it React-rendered (no dangerouslySetInnerHTML) avoids XSS
// without a sanitizer dependency.
function renderWithLinks(text: string): React.ReactNode[] {
  // Split on any of the three patterns. The regex engine picks the
  // leftmost match at each position and tries alternatives in order,
  // so longer patterns (link, **bold**) win against the single-asterisk
  // italic pattern when they'd both match at the same position.
  //
  // `[^*]+` inside the bold/italic branches means "no asterisks in the
  // span", which prevents `**a*b**` from mis-matching and lets the
  // leaves contain only flat text + other patterns resolved recursively.
  const parts = text.split(/(\[[^\]]+\]\([^)]+\)|\*\*[^*]+\*\*|\*[^*]+\*)/g)
  return parts
    .filter((p) => p !== "")
    .map((part, i) => {
      const linkMatch = part.match(/^\[([^\]]+)\]\(([^)]+)\)$/)
      if (linkMatch) {
        // No text-primary override — links inherit the surrounding text
        // color by default (underline is the link indicator) and pick
        // up the global a:hover rule in globals.css for hover feedback.
        return (
          <a
            key={i}
            href={linkMatch[2]}
            target="_blank"
            rel="noopener noreferrer"
            className="underline"
          >
            {renderWithLinks(linkMatch[1])}
          </a>
        )
      }
      const boldMatch = part.match(/^\*\*([^*]+)\*\*$/)
      if (boldMatch) {
        // Tailwind preflight resets <strong> to font-weight: bolder.
        // We explicitly pin to font-medium (500) — the design calls for
        // a lighter emphasis than the browser-default bold, so **…**
        // reads as a gentle accent rather than heavy weight.
        return (
          <strong key={i} className="font-medium">
            {renderWithLinks(boldMatch[1])}
          </strong>
        )
      }
      const italicMatch = part.match(/^\*([^*]+)\*$/)
      if (italicMatch) {
        return (
          <em key={i} className="italic">
            {renderWithLinks(italicMatch[1])}
          </em>
        )
      }
      return part
    })
}

export default function StationModal({
  open,
  onClose,
  lat,
  lng,
  stationName,
  minutes,
  flickrCount,
  originX,
  originY,
  devMode = false,
  currentRating = null,
  onBury,
  isBuried = false,
  approvedPhotos = [],
  pinnedIds = new Set(),
  onApprovePhoto,
  onApprovePhotoAtTop,
  onUnapprovePhoto,
  onPinPhoto,
  onUnpinPhoto,
  onMovePhoto,
  publicNote = "",
  privateNote = "",
  adminWalksAll = "",
  publicWalksS2S = "",
  publicWalksCircular = "",
  onSaveNotes,
  defaultAlgo = "landscapes",
  customSettings,
  onSaveCustom,
  presets,
  onSavePreset,
  journeys,
  friendOrigin,
  primaryOrigin = "Farringdon",
  isFriendOrigin = false,
  isPrimaryOrigin = false,
  isSynthetic = false,
  clusterMemberNames,
  clusterMembers,
  syntheticJourneyMember,
  friendClusterMemberNames,
  stationCrs,
  clusterMemberCrsCodes,
  adminMode = false,
  isLondonHome = false,
  hasIssue = false,
  onToggleIssue,
  onWalkSaved,
}: StationModalProps) {
  // allPhotos = full buffer from Flickr (more than we display, for replacements)
  const [allPhotos, setAllPhotos] = useState<FlickrPhoto[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const hasApiKey = Boolean(process.env.NEXT_PUBLIC_FLICKR_API_KEY)

  // Diagnostic log: when the modal opens for a station for which we have no
  // journey data from the active primary, emit a console.warn. This makes it
  // easy to spot (and grep) how often we land in the "NO CALLING POINT DATA"
  // branch of the render below — which helps decide whether a fresh
  // fetch-journeys.mjs run is needed or a code-path bug is at fault.
  // Gated on `open` + `!isFriendOrigin && !isPrimaryOrigin` so we only log
  // for stations that actually render the journey-narrative section.
  useEffect(() => {
    if (!open) return
    if (isFriendOrigin || isPrimaryOrigin) return
    if (journeys?.[primaryOrigin]) return
    // eslint-disable-next-line no-console
    console.warn(
      `[ttg:no-journey-data] ${stationName} — no journey from "${primaryOrigin}" in pre-fetched data`,
    )
  }, [open, isFriendOrigin, isPrimaryOrigin, journeys, primaryOrigin, stationName])

  // ── Local note editing state — synced from props when a new station opens ──
  const [localPublicNote, setLocalPublicNote] = useState(publicNote)
  const [localPrivateNote, setLocalPrivateNote] = useState(privateNote)
  // ramblerNote is read-only here (prose is a build output; admins
  // edit the structured walk data via WalksAdminPanel below). Read
  // the prop directly so a post-save refetch of stationNotes flows
  // through immediately without needing a local copy to be resynced.
  // Per-note "is the admin currently editing?" flags. Default false so
  // admins see the same formatted render a regular user does, and click
  // into a note to enter edit mode. Blur (click-away) returns to view.
  // Reset when a new station opens so each modal starts in view mode.
  const [isEditingPublic, setIsEditingPublic] = useState(false)
  const [isEditingPrivate, setIsEditingPrivate] = useState(false)
  useEffect(() => {
    if (open) {
      setLocalPublicNote(publicNote)
      setLocalPrivateNote(privateNote)
      setIsEditingPublic(false)
      setIsEditingPrivate(false)
    }
  // Only reset when the dialog opens with new data, not on every prop change
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, lat, lng])

  // ── Manual close animation ──
  // Radix Dialog's exit-animation detection can fail on mobile Safari (it checks
  // getAnimations() before the browser has evaluated the new CSS). To work around
  // this, we keep the Dialog open={true} while playing the exit animation ourselves,
  // then actually close after the animation duration.
  const ANIM_DURATION = 400 // ms — must match --tw-duration in animationStyle below
  const [isClosing, setIsClosing] = useState(false)
  const closingTimer = useRef<ReturnType<typeof setTimeout>>(null)

  // Reset closing state whenever the dialog opens (e.g. user clicks another station)
  useEffect(() => {
    if (open) setIsClosing(false)
    return () => { if (closingTimer.current) clearTimeout(closingTimer.current) }
  }, [open])

  const handleAnimatedClose = useCallback(() => {
    if (isClosing) return
    // Save public/private notes if anything changed. Walk prose is a
    // build output; not user-editable here.
    if (
      onSaveNotes &&
      (localPublicNote !== publicNote || localPrivateNote !== privateNote)
    ) {
      onSaveNotes(localPublicNote, localPrivateNote)
    }
    setIsClosing(true)
    closingTimer.current = setTimeout(() => {
      setIsClosing(false)
      onClose()
    }, ANIM_DURATION * 0.65)
  }, [isClosing, onClose, onSaveNotes, localPublicNote, localPrivateNote, publicNote, privateNote])

  // Swipe-down-to-dismiss for the mobile sheet. Attached only to the drag
  // handle bar (see <div className="mx-auto ... bg-muted" /> near the top
  // of DialogContent) so panning/scrolling the photos below doesn't trigger
  // dismissal. Commits the close when the drag exceeds 80px OR the velocity
  // at release is a downward flick (≥0.4 px/ms). Otherwise snaps back.
  // While dragging, the whole DialogContent translates with the finger 1:1
  // for that "grab the bottom sheet" feel.
  const dragStartY = useRef<number | null>(null)
  const dragStartAt = useRef<number>(0)
  const [dragOffset, setDragOffset] = useState(0)
  const handleDragPointerDown = useCallback((e: React.PointerEvent) => {
    if (e.pointerType !== "touch" && e.pointerType !== "pen") return
    dragStartY.current = e.clientY
    dragStartAt.current = performance.now()
    setDragOffset(0)
  }, [])
  const handleDragPointerMove = useCallback((e: React.PointerEvent) => {
    if (dragStartY.current == null) return
    const dy = e.clientY - dragStartY.current
    // Clamp to 0 — upward pulls do nothing (don't want to let the user
    // yank the sheet upward above its natural position).
    setDragOffset(Math.max(0, dy))
  }, [])
  const handleDragPointerUp = useCallback((e: React.PointerEvent) => {
    if (dragStartY.current == null) return
    const dy = e.clientY - dragStartY.current
    const dt = performance.now() - dragStartAt.current
    const velocity = dt > 0 ? dy / dt : 0
    dragStartY.current = null
    if (dy > 80 || velocity > 0.4) {
      // Commit dismiss. Use the existing animated-close path so the exit
      // animation + note-save fire as normal. The residual dragOffset is
      // cleared by handleAnimatedClose → parent → unmount.
      setDragOffset(0)
      handleAnimatedClose()
    } else {
      setDragOffset(0)  // snap back
    }
  }, [handleAnimatedClose])
  const handleDragPointerCancel = useCallback(() => {
    dragStartY.current = null
    setDragOffset(0)
  }, [])

  // Alias the shared constant to the short local name used throughout this
  // file. Single source of truth lives in lib/flickr.ts — change it there.
  const MAX_PHOTOS = MAX_GALLERY_PHOTOS

  // Per-session set of photo IDs whose <img> failed to load (404, taken down,
  // etc). Reset every time the overlay closes/re-opens — a temporary Flickr
  // outage shouldn't permanently drop a photo from the curation.
  const [brokenIds, setBrokenIds] = useState<Set<string>>(new Set())
  const handleImageError = useCallback((id: string) => {
    setBrokenIds((prev) => {
      if (prev.has(id)) return prev
      const next = new Set(prev)
      next.add(id)
      return next
    })
  }, [])

  // Snapshot of approved photo IDs at open time — photos approved BEFORE this
  // session get promoted to the top; photos approved DURING this session stay
  // in their original grid position so the layout doesn't shift.
  const initialApprovedIdsRef = useRef<Set<string>>(new Set())

  // Tracks which fetch key is currently in `allPhotos` — used to decide
  // whether opening the overlay is for a NEW station/tab (reset + show skeleton)
  // or the SAME one being re-opened (keep existing photos, refetch silently).
  const lastFetchKeyRef = useRef<string | null>(null)

  // Admin-only tab state. Non-admin users don't see tabs; they get the
  // approved-first + fallback-fill view that matches the old non-admin behaviour.
  // Default to "approved" so most stations open to an empty grid for admins.
  type TabKey = "approved" | "custom" | "landscapes" | "hikes" | "station"
  const [selectedTab, setSelectedTab] = useState<TabKey>("approved")

  // Cache-busting counter for the admin's "Refresh gallery" button. When > 0
  // the next fetch passes it to the server as ?bust=<counter> so the server
  // skips its in-memory cache. Without this, editing a preset and re-fetching
  // can hit the warm cache before the preset file write has finished (the
  // auto-refetch fires on optimistic state update, which beats the POST).
  const [refreshCounter, setRefreshCounter] = useState(0)

  // Reset per-open state when the dialog opens (new station or re-open).
  useEffect(() => {
    if (open) {
      initialApprovedIdsRef.current = new Set(approvedPhotos.map((p) => p.id))
      // Transient 404 tracking resets each session — a photo that failed last
      // time might just have been a transient Flickr outage.
      setBrokenIds(new Set())
      // Always land on the Approved tab when opening a new station.
      setSelectedTab("approved")
    }
    // Only re-run when the dialog opens, not when approvedPhotos changes
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, lat, lng])

  // How many approved photos are actually usable right now — excludes broken
  // (image 404'd this session). Drives whether the non-admin / Approved-tab
  // view needs any Flickr calls at all (≥12 usable = self-sufficient).
  const usableApprovedCount = approvedPhotos.filter(
    (p) => !brokenIds.has(p.id),
  ).length

  // Build the fallback order: default first, then the canonical
  // landscapes → hikes → custom → station order (skipping whichever is the
  // default, and skipping "custom" if no per-station config exists).
  const buildFallbackChain = useCallback((): Algo[] => {
    const order: Algo[] = ["landscapes", "hikes", "custom", "station"]
    const chain: Algo[] = [defaultAlgo, ...order.filter((a) => a !== defaultAlgo)]
    return chain.filter((a) => a !== "custom" || !!customSettings)
  }, [defaultAlgo, customSettings])

  // Hold the latest customSettings in a ref so the admin single-algo effect
  // can read the current value at fetch time WITHOUT re-running when custom
  // settings change. This implements "only update tab pages on Refresh click"
  // for admins — editing the textarea saves the setting but doesn't refetch
  // the gallery until the admin explicitly hits Refresh.
  const customSettingsRef = useRef(customSettings)
  useEffect(() => { customSettingsRef.current = customSettings }, [customSettings])

  // Case 1 — admin viewing a single-algo tab. Refires ONLY on station/tab/
  // refresh change; preset and custom-setting edits don't trigger a refetch.
  // The admin hits "Refresh gallery" to see their edits.
  useEffect(() => {
    if (!open || !hasApiKey) return
    if (!devMode || selectedTab === "approved") return
    const algo = selectedTab as Algo
    const key = `${lat},${lng}:${algo}`
    const latestCustom = customSettingsRef.current
    if (algo === "custom" && !latestCustom) {
      setAllPhotos([])
      setLoading(false)
      lastFetchKeyRef.current = key
      return
    }
    if (lastFetchKeyRef.current !== key) {
      setAllPhotos([])
      setLoading(true)
    }
    setError(null)
    fetchPhotosViaProxy(lat, lng, algo, latestCustom ?? undefined, refreshCounter || undefined)
      .then((result) => {
        setAllPhotos(result)
        lastFetchKeyRef.current = key
      })
      .catch((err) => {
        console.error("[photos] fetch error:", err)
        setError("Couldn't load photos. Try again later.")
      })
      .finally(() => setLoading(false))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, hasApiKey, lat, lng, selectedTab, devMode, refreshCounter])

  // Case 2 — non-admin OR admin viewing the Approved tab. Runs the fallback
  // chain until approved + flickr hits 12. Skips Flickr entirely when
  // approved alone already covers all 12 slots. This path DOES react to
  // custom/preset changes so the non-admin view stays in sync when admins
  // edit from another tab (or across sessions).
  useEffect(() => {
    if (!open || !hasApiKey) return
    if (devMode && selectedTab !== "approved") return

    if (usableApprovedCount >= MAX_PHOTOS) {
      setAllPhotos([])
      setLoading(false)
      return
    }

    const key = `${lat},${lng}:fallback`
    if (lastFetchKeyRef.current !== key) {
      setAllPhotos([])
      setLoading(true)
    }
    setError(null)

    const chain = buildFallbackChain()
    const approvedIdSet = new Set(approvedPhotos.map((p) => p.id))
    const need = MAX_PHOTOS - usableApprovedCount

    let cancelled = false
    ;(async () => {
      const accumulated: FlickrPhoto[] = []
      const seen = new Set<string>()
      try {
        for (const algo of chain) {
          const batch = await fetchPhotosViaProxy(lat, lng, algo, customSettings ?? undefined, refreshCounter || undefined)
          for (const p of batch) {
            if (seen.has(p.id)) continue
            if (approvedIdSet.has(p.id)) continue
            seen.add(p.id)
            accumulated.push(p)
          }
          if (accumulated.length >= need) break
        }
        if (!cancelled) {
          setAllPhotos(accumulated)
          lastFetchKeyRef.current = key
        }
      } catch (err) {
        if (!cancelled) {
          console.error("[photos] fallback fetch error:", err)
          setError("Couldn't load photos. Try again later.")
        }
      } finally {
        if (!cancelled) setLoading(false)
      }
    })()
    return () => { cancelled = true }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, hasApiKey, lat, lng, selectedTab, devMode, customSettings, usableApprovedCount, presets, refreshCounter])

  // Display-list builders — what appears depends on tab (admin) or the
  // approved-first fallback view (non-admin + admin Approved tab).
  const approvedIds = new Set(approvedPhotos.map((p) => p.id))

  // Non-admin / Approved-tab path: approved first (capped at 12), then flickr
  // fallback fills the remainder.
  const preApproved = approvedPhotos.filter(
    (p) => initialApprovedIdsRef.current.has(p.id) && !brokenIds.has(p.id),
  )
  const flickrOnly = allPhotos.filter(
    (p) => !initialApprovedIdsRef.current.has(p.id) && !brokenIds.has(p.id),
  )
  const preApprovedCapped = preApproved.slice(0, MAX_PHOTOS)
  const remainingSlots = MAX_PHOTOS - preApprovedCapped.length
  const nonAdminPhotos = [...preApprovedCapped, ...flickrOnly.slice(0, remainingSlots)]

  // Admin Approved-tab path: ALL approved photos (no cap, divider drawn
  // after the 12th in the render code).
  const approvedOnly = approvedPhotos.filter((p) => !brokenIds.has(p.id))

  // What to render right now.
  const photos: FlickrPhoto[] =
    devMode && selectedTab === "approved"
      ? approvedOnly
      : devMode && selectedTab !== "approved"
        ? allPhotos
        : nonAdminPhotos

  // ── Open/close animation ──
  // Desktop: grow from / shrink to the clicked station icon.
  // Mobile: slide up from / down to the bottom of the screen.
  const hasOrigin = originX != null && originY != null
  const isMobile = typeof window !== "undefined" && window.innerWidth < 640

  // Desktop offset: from station icon position relative to viewport center
  const enterX = hasOrigin ? originX - window.innerWidth / 2 : 0
  const enterY = hasOrigin ? originY - window.innerHeight / 2 : 0

  // These CSS custom properties are read by tw-animate-css's enter/exit keyframes.
  //
  // When isClosing we set the `animation` property directly in the inline style.
  // This is necessary because the Dialog is still technically "open" (so Radix keeps
  // the content mounted), which means data-open:animate-in is active and would
  // conflict with a class-based animate-out. Inline style wins over any class.
  let animationStyle: React.CSSProperties

  if (isMobile) {
    // Mobile: simple slide up/down from bottom edge
    animationStyle = isClosing
      ? {
          "--tw-exit-translate-y": "100%",
          animation: `exit ${ANIM_DURATION * 0.65}ms cubic-bezier(0.4, 0, 1, 1) forwards`,
        } as React.CSSProperties
      : {
          "--tw-enter-translate-y": "100%",
          "--tw-duration": `${ANIM_DURATION}ms`,
          "--tw-ease": "cubic-bezier(0.16, 1, 0.3, 1)",
        } as React.CSSProperties
  } else {
    // Desktop: grow from / shrink to station icon
    animationStyle = isClosing
      ? {
          "--tw-exit-translate-x": `${enterX}px`,
          "--tw-exit-translate-y": `${enterY}px`,
          "--tw-exit-scale": "0.02",
          "--tw-exit-opacity": "0",
          animation: `exit ${ANIM_DURATION * 0.65}ms cubic-bezier(0.4, 0, 1, 1) forwards`,
        } as React.CSSProperties
      : {
          "--tw-enter-translate-x": `${enterX}px`,
          "--tw-enter-translate-y": `${enterY}px`,
          "--tw-enter-scale": "0.02",
          "--tw-enter-opacity": "0",
          "--tw-duration": `${ANIM_DURATION}ms`,
          "--tw-ease": "cubic-bezier(0.16, 1, 0.3, 1)",
        } as React.CSSProperties
  }

  return (
    // Dialog stays open during isClosing so the content remains in the DOM.
    // The actual close (onClose → setSelectedStation(null)) fires after the timer.
    <Dialog open={open || isClosing} onOpenChange={(v) => { if (!v) handleAnimatedClose() }}>
      {/* Large modal: 5xl width, up to 90% viewport height */}
      {/* w/h use dvw/dvh so the modal scales with the viewport on any screen size.
          sm:max-w-none overrides the sm:max-w-md baked into DialogContent's base styles. */}
      {/* max-sm: overrides make the modal fullscreen on small viewports (no margins, no rounded corners).
          inset-0 replaces the top-1/2/left-1/2 centering from the base DialogContent. */}
      <DialogContent
        // While a drag is in progress, merge the translateY into the style
        // object. Disable the transition so the sheet tracks the finger
        // 1:1; once released, dragOffset resets to 0 and the base CSS
        // transition handles the snap-back or the close animation takes
        // over.
        style={
          dragOffset > 0
            ? {
                ...animationStyle,
                transform: `translateY(${dragOffset}px)`,
                transition: "none",
              }
            : animationStyle
        }
        overlayStyle={isClosing ? {
          animation: "exit 300ms ease forwards",
          "--tw-exit-opacity": "0",
        } as React.CSSProperties : undefined}
        // max-sm:overflow-y-auto makes the whole modal scroll on mobile (vs the
        // desktop behaviour where only the photo grid below scrolls). Combined
        // with max-sm:sticky on the title and the photos section dropping its
        // own scroll container on mobile, everything flows through one
        // continuous scroll path and tapping the title jumps back to the top.
        // gap-0 overrides DialogContent's default gap-6 (24px) from the shadcn
        // base — that was adding a large unwanted gap between the title
        // wrapper, DialogHeader, and the photos section. We want to manage
        // inter-section spacing explicitly via padding inside each child.
        className="flex h-[92dvh] w-[94dvw] max-w-none sm:max-w-none flex-col gap-0 overflow-hidden p-0 max-sm:overflow-y-auto max-sm:top-auto max-sm:right-0 max-sm:bottom-0 max-sm:left-0 max-sm:h-[92dvh] max-sm:w-full max-sm:translate-x-0 max-sm:translate-y-0 max-sm:rounded-t-2xl max-sm:rounded-b-none">

        {/* Mobile-only drag handle + swipe-to-dismiss grip. Appears as a
            small pill-shaped bar at the very top of the sheet — matches
            the iOS sheet visual language and the mobile search sheet's
            own handle. Attaches pointer handlers that slide the sheet
            with the finger; release past 80px or at decent downward
            velocity dismisses via the same handleAnimatedClose path
            that the overlay tap / Escape key use.
            touch-none prevents the browser from also interpreting the
            drag as a scroll gesture; px-6 widens the grab target beyond
            the visible 40px pill so the swipe is forgiving. sm:hidden
            hides the whole thing on desktop (no sheet metaphor there). */}
        <div
          className="sm:hidden shrink-0 px-6 py-2 touch-none"
          onPointerDown={handleDragPointerDown}
          onPointerMove={handleDragPointerMove}
          onPointerUp={handleDragPointerUp}
          onPointerCancel={handleDragPointerCancel}
          aria-hidden="true"
        >
          <div className="mx-auto h-1 w-10 rounded-full bg-muted" />
        </div>

        {/* ── Header layout ──
            Desktop ≥sm (per user spec):
              1. Title row (full width)
              2. Primary-journey-info on the left + Hike button on the right, top-aligned
              3. Friend-journey row (full width)
              4. Public note row (full width)
              5. Private note row (admin only, full width)
            Mobile: everything collapses to a single-column stack; the Hike button
            renders as a separate block below the notes (see the <Button max-sm>
            block after DialogHeader).
            max-sm:pt-0 removes the top padding on mobile so the sticky title sits
            flush at the top of the scroll area (title adds its own py-3). */}
        {/* Row 1 — title on the left, Hike button on the right (desktop only),
            vertically centred. On mobile the button is hidden here and renders
            as a full-width button after the notes (see below).
            The WRAPPER is the sticky element on mobile (not the DialogTitle) —
            this way, on desktop, the title + button share a row while on
            mobile the whole row sticks. Sticky is scoped to DialogContent
            (the scroll container on mobile via max-sm:overflow-y-auto) so the
            header pins through the entire scroll range including the photos.
            onClick ignores taps on the button (e.target.closest("a")) so the
            desktop Hike link still navigates normally; any other tap on the
            row scrolls back to the top (iOS nav-bar convention). */}
        <div
          onClick={(e) => {
            const target = e.target as HTMLElement | null
            if (target?.closest("a,button")) return
            if (typeof document === "undefined") return
            const el = document.querySelector('[data-slot="dialog-content"]')
            if (el instanceof HTMLElement) el.scrollTo({ top: 0, behavior: "smooth" })
          }}
          className="shrink-0 flex items-center justify-between gap-5 px-6 pt-6 pb-2 max-sm:sticky max-sm:top-0 max-sm:z-10 max-sm:cursor-pointer max-sm:bg-popover max-sm:pt-3 max-sm:pb-2"
        >
          <div className="flex flex-col gap-1 min-w-0">
            <DialogTitle className="text-2xl sm:text-3xl">
              {adminMode && stationCrs ? `${stationCrs} ` : ""}{stationName}{isSynthetic ? "" : " Station"}
            </DialogTitle>
            {/* Cluster header — only when the modal is open for a synthetic
                primary or friend (e.g. "Stratford", "Birmingham"). Lists
                the underlying member stations using the standard "A, B,
                and C" English serial form. */}
            {clusterMemberNames && clusterMemberNames.length > 0 && (
              <p className="text-sm text-muted-foreground">
                {`A cluster of ${clusterMemberNames.length} stations: ${
                  clusterMemberNames.length === 1
                    ? clusterMemberNames[0]
                    : clusterMemberNames.length === 2
                      ? `${clusterMemberNames[0]} and ${clusterMemberNames[1]}`
                      : `${clusterMemberNames.slice(0, -1).join(", ")}, and ${clusterMemberNames[clusterMemberNames.length - 1]}`
                }.`}
              </p>
            )}
          </div>
          {/* Desktop-only Hike control — either a single-station button
              (regular stations) or a "Hikes from stations ▾" dropdown
              (synthetics). The dropdown is shown for synthetics even
              when they're the active primary or friend, since each
              cluster member is still a real, hikeable station; the
              single button stays hidden for non-synthetic primary/
              friend overlays. min-w-0 isn't needed on the title
              because the control has shrink-0 and the row has gap. */}
          <HikesControl
            className="hidden sm:inline-flex shrink-0"
            stationName={stationName}
            lat={lat}
            lng={lng}
            clusterMembers={clusterMembers}
            isFriendOrigin={isFriendOrigin}
            isPrimaryOrigin={isPrimaryOrigin}
          />
        </div>

        {/* ── Scroll region (desktop) ──
            On desktop, body text + photos share a single scroll area beneath
            the title row. Everything below this wrapper scrolls together.
            Only the title row (above) stays pinned at the top of the modal.
            On mobile, the outer DialogContent is the scroll container (see
            max-sm:overflow-y-auto up there), so this wrapper reverts to
            flex-none + overflow-visible and content flows inline. */}
        <div data-modal-scroll className="min-h-0 flex-1 overflow-y-auto max-sm:flex-none max-sm:overflow-visible">
        {/* gap-0 override: shadcn's DialogHeader defaults to flex-col
            gap-2, which stacks flex-gap on top of the explicit mt-*
            margins on each child (alts, subheaders, notes). Letting
            both apply made the alt paragraphs look ~14px apart while
            the notes div — which isn't a flex container — rendered
            at the intended 4px. Killing the gap here means every
            child's mt-[var(--para-gap)] (or mt-[calc…]) alone
            controls its spacing, so alts and notes match. */}
        {/* Synthetic-with-active-side gate: when the destination is a
            synthetic AND it's also the active primary/friend, we still
            want the journey block visible IF the OTHER origin is set,
            so we can show the cross-journey ("Euston is 1h19 from
            Birmingham New Street" when London is the primary synthetic
            and Birmingham is the friend). For non-synthetic primary/
            friend overlays we keep the prior behaviour: no journey
            block. */}
        <DialogHeader className="shrink-0 px-6 pt-0 pb-0 gap-0">
          {(!isFriendOrigin && !isPrimaryOrigin) ||
           (isSynthetic && isPrimaryOrigin && friendOrigin && journeys?.[friendOrigin]) ||
           (isSynthetic && isFriendOrigin && journeys?.[primaryOrigin]) ? (
            <>
              {/* Primary journey info — ALWAYS full width now (both desktop
                  and mobile). The Hike button has moved up into the title
                  row, freeing this paragraph to use the overlay's full width.
                  [overflow-wrap:anywhere] on the outer <p> so long station names (e.g.
                  "Stratford International" in the change list) always wrap
                  within the dialog's content-box — the span-nested hint line
                  has its own [overflow-wrap:anywhere], but the main line's text lives
                  directly inside DialogDescription so it needs the class
                  here too.
                  Skipped when this overlay IS the active primary (a
                  station can't have a journey from itself); for synthetic
                  primaries we still want the friend journey below to
                  render, so we just hide the primary description rather
                  than the whole block. */}
              {!isPrimaryOrigin && (
              <DialogDescription className="text-sm [overflow-wrap:anywhere]">
                {highlightTermini(
                  journeys?.[primaryOrigin]
                    ? (syntheticJourneyMember?.primary
                        ? `${syntheticJourneyMember.primary} is ${singleOriginDescription(primaryOrigin, journeys[primaryOrigin])}`
                        : singleOriginDescription(primaryOrigin, journeys[primaryOrigin]))
                    // No pre-stored journey for this primary → happens for
                    // custom primaries (any NR station picked via the search
                    // bar — e.g. Kentish Town). Fall back to the primary's
                    // own name so the narrative reads "X from Kentish Town."
                    // rather than "from central London" (which was misleading
                    // when the user had explicitly chosen a non-London origin).
                    // Three special-case overrides ahead of the generic
                    // "X minutes from Y" fallback:
                    //   - Non-NR stations: admin-only readout calling out
                    //     why there's no time. Detected by either no CRS
                    //     (e.g. DLR features) OR a Z-prefix code (this
                    //     codebase's convention for Underground/DLR
                    //     stations: ZHM Hampstead, ZTH Tower Hill, etc).
                    //   - Ghost stations (FIN, PSW): dedicated "minimal
                    //     service on weekends" message; quoting a time would
                    //     mislead.
                    //   - Otherwise no-travel-time NR stations (admin-only):
                    //     real stations whose journey data hasn't been
                    //     fetched yet — usually because they're beyond our
                    //     Saturday-morning RTT coverage from this origin.
                    : (adminMode && isNonNrStation(stationCrs))
                      ? "Not a National Rail Station: no RTT data."
                      : (stationCrs && GHOST_STATIONS.has(stationCrs))
                        ? GHOST_STATION_MESSAGE
                        : adminMode
                          ? "No travel times — destination outside our journey-data coverage from this origin."
                          : `${formatMinutes(minutes)} from ${primaryOrigin}.`,
                  isLondonHome,
                  // extraBold home origin when friend mode is on, so
                  // the home/friend sentences visually distinguish.
                  // Already implicit when home is Central London
                  // (the actual terminus gets terminus-highlighted),
                  // so the extra bold only needs to fire when !isLondonHome.
                  friendOrigin && !isLondonHome ? [primaryOrigin] : [],
                )}
                {(() => {
                  // Three distinct outcomes in this section, each getting
                  // its own copy in the same visual slot beneath the main
                  // journey line:
                  //   A. No journey data at all for this primary → "NO
                  //      CALLING POINT DATA". Emits a console.warn (see
                  //      useEffect above) so the user can track how often
                  //      we're missing data and why.
                  //   B. Journey data exists but both upstream + downstream
                  //      arrays are empty → "No London calling points."
                  //      The train legitimately doesn't call at any other
                  //      London station on the way (e.g. a non-stop
                  //      Paddington → Swindon express).
                  //   C. Journey data with ≥1 calling point → the standard
                  //      "Can also start same route at: …" / "The X train
                  //      also calls at: …" list with signed minute deltas.
                  // Separation via <br /> + small muted copy matches the
                  // style already used for case C so the three outcomes
                  // feel like variants of one UI element.
                  const j = journeys?.[primaryOrigin]
                  const hintClass =
                    "block [overflow-wrap:anywhere] text-xs text-muted-foreground"
                  // Case A — we don't have the journey data. Admin-only
                  // diagnostic: non-admin users would find "NO CALLING
                  // POINT DATA" confusing (it looks like a bug, not an
                  // information hint) so the message is gated on devMode.
                  // The console.warn still fires regardless so missing-data
                  // events are always auditable via DevTools.
                  if (!j) {
                    if (!devMode) return null
                    return (
                      <>
                        <br />
                        <span className={hintClass}>NO CALLING POINT DATA</span>
                      </>
                    )
                  }
                  const up = (j.londonUpstreamCallingPoints ?? [])
                    .slice()
                    .sort((a, b) => b.minutesExtra - a.minutesExtra)
                    .map((s) => ({ key: s.crs, name: s.name, label: `+${s.minutesExtra}m` }))
                  const down = (j.londonCallingPoints ?? [])
                    .slice()
                    .sort((a, b) => a.minutesFromOrigin - b.minutesFromOrigin)
                    .map((s) => ({ key: s.crs, name: s.name, label: `-${s.minutesFromOrigin}m` }))
                  const items = [...up, ...down]
                  // Case B — we have the journey but it has no other London
                  // stops. Distinct message so admins can trust that the
                  // absence of a list is the real answer, not a data gap.
                  // Also gated on devMode: for non-admin users an empty
                  // state reads better than a tombstone "No London calling
                  // points." message next to every express-service modal.
                  if (items.length === 0) {
                    if (!devMode) return null
                    return (
                      <>
                        <br />
                        <span className={hintClass}>No London calling points.</span>
                      </>
                    )
                  }
                  // Prefix choice:
                  //   • If the described HEAVY_RAIL leg's arrival IS the
                  //     feature's destination (i.e. the train goes DIRECTLY
                  //     to where the user is travelling): "Alternative
                  //     starts for the direct train to {destination}".
                  //   • Otherwise (the described leg arrives at a change
                  //     station, not the final destination): "The train to
                  //     {change station} can also be boarded at". Anchors
                  //     the sentence on where the train is heading rather
                  //     than where it started — reads more naturally when
                  //     talking about alternative boarding points.
                  //
                  // Which leg IS the described one? By default, the first
                  // HEAVY_RAIL leg (matches the non-custom-primary flow).
                  // For custom primaries with multi-leg synth journeys,
                  // map.tsx sets callingPointsLegArrival explicitly — that
                  // wins because map.tsx picked that leg specifically for
                  // its richer calling-points list (e.g. for KT→Shoeburyness
                  // we want the last leg Stratford→Shoeburyness, not the
                  // first Farringdon→Stratford leg).
                  const mainlineLeg = j.legs?.find((l) => l.vehicleType === "HEAVY_RAIL")
                  const towardsStation = j.callingPointsLegArrival ?? mainlineLeg?.arrivalStation
                  // Station display in photo-overlay always appends " Station"
                  // via stationName, while legs strip it. Compare against the
                  // raw property name to decide if the leg terminates at the
                  // user's destination.
                  const reachesDest =
                    towardsStation != null &&
                    towardsStation === stationName.replace(/ Station$/, "")
                  // Prefix choice:
                  //   • reachesDest (direct train to the user's
                  //     destination): "Alternative starts on this route:"
                  //     — deliberately generic so the same copy works
                  //     across main + alt paragraphs.
                  //   • otherwise (train terminates at a change
                  //     station): "The train to X can also be boarded
                  //     at:" — unchanged.
                  const prefix = towardsStation
                    ? reachesDest
                      ? `Alternative starts on this route: `
                      : `The train to ${towardsStation} can also be boarded at: `
                    : "Can also start same route at: "
                  return (
                    <>
                      <br />
                      {/* [overflow-wrap:anywhere] flips overflow-wrap to break-word so a
                          long station name + label pair (e.g. "Stratford
                          International (-7m)") wraps at every available
                          boundary, preventing horizontal overflow of the
                          containing dialog. Without this, some browsers
                          treat a multi-word station + adjacent parenthesised
                          label as a single unbreakable unit once the
                          parentheses anchor themselves to the word — the
                          inline-span wrapper seems to encourage that
                          behaviour. block display guarantees the span forms
                          its own wrappable line box rather than inheriting
                          quirks from the inline flow. */}
                      <span className="block [overflow-wrap:anywhere] text-xs text-muted-foreground">
                        {prefix}
                        {items.map((item, i) => {
                          // Separator before item i>0: "," for middle
                          // items, " & " before the LAST item of a 2-item
                          // list, ", & " before the LAST of a 3+ list
                          // (Oxford comma).
                          let sep = ""
                          if (i > 0) {
                            if (i === items.length - 1) {
                              sep = items.length > 2 ? ", & " : " & "
                            } else {
                              sep = ", "
                            }
                          }
                          return (
                            <span key={item.key}>
                              {sep}{highlightTermini(item.name, isLondonHome)} ({item.label})
                            </span>
                          )
                        })}
                        {/* Trailing full stop so the calling-points line
                            reads as a complete sentence matching the style
                            of the main journey line above ("1h 54m from
                            Farringdon. Two changes: East Croydon and
                            Lewes."). Both the 0-change ("Can also start
                            same route at: …") and >0-change ("The train to
                            X can also be boarded at: …") variants end
                            here, so the period lives outside the items map. */}
                        .
                      </span>
                    </>
                  )
                })()}
              </DialogDescription>
              )}

              {/* Friend journey info — full width, separate row below
                  the home journey. Rendered ABOVE the Alternative
                  routes block so the narrative reads: home journey →
                  friend journey → alts-from-home (with "from London"
                  disambiguation suffix on the subheader when friend
                  is visible). mt uses --para-gap for consistent
                  rhythm with everything else. Mirror gate to the
                  primary block above: skipped when this overlay IS
                  the active friend (no journey from-itself). */}
              {!isFriendOrigin && friendOrigin && journeys?.[friendOrigin] && (
                <p className="mt-[var(--para-gap)] text-sm">
                  {highlightTermini(
                    syntheticJourneyMember?.friend
                      ? `${syntheticJourneyMember.friend} is ${singleOriginDescription(friendOrigin, journeys[friendOrigin])}`
                      : singleOriginDescription(friendOrigin, journeys[friendOrigin]),
                    isLondonHome,
                    // Friend origin always extraBold so it stands out
                    // from the home journey paragraph above. Termini
                    // in the friend's path still get the muted +
                    // medium treatment when home is Central London.
                    // For synthetic friends, also include the full
                    // cluster-member station names ("Birmingham New
                    // Street", "Birmingham Moor Street", etc.) so the
                    // entire station name reads bold rather than just
                    // the first matching word ("Birmingham").
                    [friendOrigin, ...(friendClusterMemberNames ?? [])],
                  )}
                </p>
              )}

              {/* Alternative terminus routes (London synthetic primary
                  only — map.tsx populates `alternativeRoutes` on the
                  active journey when the user's home is the whole
                  London cluster). Each renders as its own small-muted
                  paragraph mirroring the main journey's structure:
                  "Alternative route: X min direct from Y." plus a
                  calling-points line with the same separator logic.
                  Hidden for non-London primaries and whenever the list
                  is empty, so no visual footprint in those cases. */}
              {/* Modal-wide paragraph-spacing token. A typography rule
                  rather than per-paragraph overrides: every paragraph
                  in this region inherits the same small top gap, so
                  the journey info reads as one tight block. Subheaders
                  within the block get a LARGER top gap (see the
                  "Alternative routes" heading) so they feel like
                  section labels, not another body paragraph. */}
              {(() => {
                const alts = journeys?.[primaryOrigin]?.alternativeRoutes
                if (!alts || alts.length === 0) return null
                // Copy shape depends on alt count:
                //   • 1 alt  → single paragraph prefixed "Alternative
                //              route: {sentence}" (keeps the line short
                //              when there's only one alternative).
                //   • 2+ alts → one muted "Alternative routes" subheader
                //              followed by N paragraphs WITHOUT the
                //              prefix (avoids repeating the same label).
                // mt-1 across both shapes matches the small gap between
                // the main journey DialogDescription and the public
                // notes block below — brings the whole "journey info"
                // region into one visually unified cluster.
                const grouped = alts.length >= 2
                const renderAlt = (alt: typeof alts[number], idx: number) => {
                  const up = (alt.londonUpstreamCallingPoints ?? [])
                    .slice()
                    .sort((a, b) => b.minutesExtra - a.minutesExtra)
                    .map((s) => ({ key: s.crs, name: s.name, label: `+${s.minutesExtra}m` }))
                  const down = (alt.londonCallingPoints ?? [])
                    .slice()
                    .sort((a, b) => a.minutesFromOrigin - b.minutesFromOrigin)
                    .map((s) => ({ key: s.crs, name: s.name, label: `-${s.minutesFromOrigin}m` }))
                  const items = [...up, ...down]
                  const terminusLabel = prettifyStationLabel(alt.terminusName)
                  const changeLabels = (alt.changeStations ?? []).map(prettifyStationLabel)
                  const mainSentence = alt.changes === 0
                    ? `${formatMinutes(alt.durationMinutes)} direct from ${terminusLabel}.`
                    : alt.changes === 1 && changeLabels.length > 0
                      ? `${formatMinutes(alt.durationMinutes)} from ${terminusLabel}. Change at ${changeLabels[0]}.`
                      : `${formatMinutes(alt.durationMinutes)} from ${terminusLabel} with ${alt.changes} changes at ${changeLabels.join(", ")}.`
                  return (
                    <p
                      key={`${alt.terminusName}-${idx}`}
                      className="mt-[var(--para-gap)] text-sm [overflow-wrap:anywhere]"
                    >
                      {grouped
                        ? highlightTermini(mainSentence, isLondonHome)
                        : <>Alternative route: {highlightTermini(mainSentence, isLondonHome)}</>}
                      {items.length > 0 && (
                        <span className="block [overflow-wrap:anywhere] text-xs text-muted-foreground">
                          Alternative starts on this route:{" "}
                          {items.map((item, i) => {
                            let sep = ""
                            if (i > 0) {
                              sep = i === items.length - 1
                                ? (items.length > 2 ? ", & " : " & ")
                                : ", "
                            }
                            return (
                              <span key={item.key}>
                                {sep}{highlightTermini(item.name, isLondonHome)} ({item.label})
                              </span>
                            )
                          })}
                          .
                        </span>
                      )}
                    </p>
                  )
                }
                return (
                  <>
                    {grouped && (
                      // Subheader's top margin is THREE paragraph gaps,
                      // tying the section-break spacing to the same
                      // --para-gap variable that drives every other
                      // vertical rhythm in the modal. The 3× multiplier
                      // renders visually greater than a normal para gap
                      // (that's the point — subheaders need breathing
                      // room above so they feel like section labels).
                      // Tune --para-gap in globals.css to scale the
                      // whole rhythm proportionally; the 3:1 ratio
                      // between subheader-above-gap and regular
                      // paragraph gap holds.
                      <p className="mt-[calc(var(--para-gap)*3)] text-xs font-medium text-muted-foreground">
                        {/* When a friend route is also on-screen below,
                            disambiguate by suffixing "from London" so
                            it's clear these alts belong to the home
                            origin (London synthetic primary — alts only
                            render in that mode) and NOT the friend. */}
                        {friendOrigin && journeys?.[friendOrigin]
                          ? "Alternative train routes from London"
                          : "Alternative train routes"}
                      </p>
                    )}
                    {alts.map(renderAlt)}
                  </>
                )
              })()}

              {/* Oyster zone hint — sits at the foot of the train-info
                  block, before any user notes / walks. Detection mirrors
                  the Feature dropdown's Oyster filter: curated NR list
                  + "Z-prefix → Oyster" rule. */}
              {isInOysterZone(stationCrs) && (
                <p className="mt-[var(--para-gap)] text-sm italic text-foreground">
                  {stationName} is within London&rsquo;s Oyster fare zone — no National Rail ticket needed when travelling from within London
                </p>
              )}

            </>
          ) : null}

          {/* ── Notes: full-width, below the title/button row ── */}

          {/* "Notes" subheader — visible whenever the public note has
              content, OR in admin mode (so admins always see the block
              even when empty, to edit it). The note is a single free-
              form text field, so the header label is always "Notes"
              (no singular variant). */}
          {(devMode || localPublicNote) && (
            <p className="mt-[calc(var(--para-gap)*3)] text-xs font-medium text-muted-foreground">
              Notes
            </p>
          )}

          {/* Public note — visible to everyone when content exists.
              Admin mode unlocks the editor (click-to-edit + textarea
              + "Click to add" placeholder). Three render paths:
               (a) admin editing → textarea with autoFocus, exits on blur.
               (b) note has content → rendered markdown view; admins get
                   click-to-edit affordance, public visitors get plain text.
               (c) admin + empty + not editing → "Click to add" placeholder.
                   Public visitors with no content see nothing.

               Split on any run of newlines into separate paragraphs. Users
               author notes with a single Enter keypress (one \n), so we
               treat each line as its own paragraph. `filter(Boolean)` drops
               the empty strings that "\n\n" produces. */}
          {devMode && isEditingPublic ? (
            <textarea
              ref={(el) => { if (el) autoResize(el) }}
              value={localPublicNote}
              onChange={(e) => {
                setLocalPublicNote(e.target.value)
                autoResize(e.target)
              }}
              onBlur={() => setIsEditingPublic(false)}
              autoFocus
              placeholder="Public notes..."
              className="mt-[var(--para-gap)] w-full resize-none overflow-hidden rounded-md border border-border bg-background px-3 py-2 text-sm text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-ring"
              rows={2}
            />
          ) : localPublicNote ? (
            // Public-readable rendered view. Click-to-edit is a no-op for
            // non-admins (the onClick fires but state is admin-gated, so
            // it just silently doesn't enter edit mode). Cleaner than
            // wrapping the whole block in a devMode ternary because the
            // markdown rendering / paragraph splitting is identical for
            // both audiences — only the interaction differs.
            <div
              className={`mt-[var(--para-gap)] text-sm text-foreground [&>p+p]:mt-[var(--para-gap)] ${
                devMode ? "cursor-text rounded-md hover:bg-muted/40 px-3 py-2 -mx-3" : ""
              }`}
              onClick={devMode ? () => setIsEditingPublic(true) : undefined}
              role={devMode ? "button" : undefined}
              tabIndex={devMode ? 0 : undefined}
              onKeyDown={devMode
                ? (e) => { if (e.key === "Enter") { e.preventDefault(); setIsEditingPublic(true) } }
                : undefined}
            >
              {localPublicNote.split(/\n+/).filter(Boolean).map((para, i) => (
                <p key={i}>{renderWithLinks(para)}</p>
              ))}
            </div>
          ) : devMode ? (
            <button
              type="button"
              onClick={() => setIsEditingPublic(true)}
              className="mt-[var(--para-gap)] w-full cursor-text rounded-md border border-dashed border-border px-3 py-2 text-left text-sm italic text-muted-foreground hover:bg-muted/40"
            >
              Click to add public notes…
            </button>
          ) : null}

          {/* ── Walks (prose preview) ──
              Same rendering for admin and public — TWO sectioned blocks
              under their own headers ("Circular walks",
              "Station-to-station walks") plus an unheadered extras
              block. Admins see exactly what the public sees; the
              full unfiltered walk list with editing controls lives in
              the WalksAdminPanel below. Each block is built from
              \n\n-joined paragraphs in station-notes.json. */}
          {(() => {
            const renderParas = (text: string) => {
              const paras = text.split(/\n+/).filter(Boolean)
              return (
                <div className="mt-[var(--para-gap)] text-sm text-foreground [&>p+p]:mt-[var(--para-gap)]">
                  {paras.map((para, i) => (
                    <p key={i}>{renderWithLinks(para)}</p>
                  ))}
                </div>
              )
            }
            const sectionHeader = (label: string) => (
              <p className="mt-[calc(var(--para-gap)*3)] text-xs font-medium text-muted-foreground">
                {label}
              </p>
            )
            const countParas = (text: string) =>
              text ? text.split(/\n+/).filter(Boolean).length : 0

            // Up to two walk sections. Each section only renders when
            // it has content; the section header is singular when its
            // block contains exactly one walk.
            const s2sCount = countParas(publicWalksS2S)
            const circularCount = countParas(publicWalksCircular)
            const hasS2S = s2sCount > 0
            const hasCircular = circularCount > 0
            // Empty state when nothing's there yet. Admins see a
            // placeholder header so the section's location is visible
            // in the modal even before walks are added; public users
            // see nothing.
            if (!hasS2S && !hasCircular) {
              // No public-facing walk paragraphs. Admins still get the
              // walks editor below (which has its own header), so we
              // skip rendering anything here in either mode.
              return null
            }
            return (
              <>
                {hasCircular && (
                  <>
                    {sectionHeader(
                      circularCount === 1 ? "Circular walk" : "Circular walks",
                    )}
                    {renderParas(publicWalksCircular)}
                  </>
                )}
                {hasS2S && (
                  <>
                    {sectionHeader(
                      s2sCount === 1 ? "Station-to-station walk" : "Station-to-station walks",
                    )}
                    {renderParas(publicWalksS2S)}
                  </>
                )}
              </>
            )
          })()}

          {/* Structured walk editor — admin only. Fetches every walk
              variant attached to this station's CRS and surfaces the
              Phase 5 editable fields (Komoot URL, mud warning, best
              seasons, free-text miscellany, train tips). Saving a card
              rewrites the source JSON and re-runs the build, so the
              prose above refreshes on the next station-notes fetch. */}
          {devMode && stationCrs && (
            <WalksAdminPanel
              stationCrs={stationCrs}
              extraCrsCodes={clusterMemberCrsCodes}
              onSaved={onWalkSaved}
            />
          )}

          {/* Private note — admin-only. Same click-to-edit pattern, with
              the distinctive orange-dashed styling from before. The view
              path renders markdown too so links inside the issue
              annotations (appended by scripts/append-walk-issues-to-
              private-notes.mjs) are clickable without entering edit
              mode. */}
          {devMode && isEditingPrivate ? (
            <textarea
              ref={(el) => { if (el) autoResize(el) }}
              value={localPrivateNote}
              onChange={(e) => {
                setLocalPrivateNote(e.target.value)
                autoResize(e.target)
              }}
              onBlur={() => setIsEditingPrivate(false)}
              autoFocus
              placeholder="Private notes (admin only)..."
              className="w-full resize-none overflow-hidden rounded-md border border-dashed border-orange-400 bg-orange-50 px-3 py-2 text-sm text-foreground placeholder:text-muted-foreground/60 focus:outline-none focus:ring-1 focus:ring-orange-400 dark:bg-orange-950/20"
              rows={2}
            />
          ) : devMode && localPrivateNote ? (
            <div
              className="cursor-text rounded-md border border-dashed border-orange-400 bg-orange-50 px-3 py-2 text-sm text-foreground hover:bg-orange-100 [&>p+p]:mt-[var(--para-gap)] dark:bg-orange-950/20 dark:hover:bg-orange-950/40"
              onClick={() => setIsEditingPrivate(true)}
              role="button"
              tabIndex={0}
              onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); setIsEditingPrivate(true) } }}
            >
              {localPrivateNote.split(/\n+/).filter(Boolean).map((para, i) => (
                <p key={i}>{renderWithLinks(para)}</p>
              ))}
            </div>
          ) : devMode ? (
            <button
              type="button"
              onClick={() => setIsEditingPrivate(true)}
              className="w-full cursor-text rounded-md border border-dashed border-orange-400 bg-orange-50/50 px-3 py-2 text-left text-sm italic text-muted-foreground hover:bg-orange-50 dark:bg-orange-950/10 dark:hover:bg-orange-950/20"
            >
              Click to add private notes…
            </button>
          ) : null}

          {/* Mobile-only Hike button, anchored at the bottom of all the text.
              Desktop uses the inline button in the title row above instead.
              Top gap is 4× --para-gap — visually equivalent to the
              section-break gap above subheaders, which is the right
              rhythm for a clear separation between text content and an
              action button. Without this (the prior `mt-1`), the
              button sat too close to the notes after the DialogHeader
              gap-0 override removed the flex-gap buffer. */}
          {/* Mobile-only Hike control — same single-button-or-dropdown
              behaviour as the desktop one above, just full-width and
              positioned after the notes/walks section. */}
          <HikesControl
            className="mt-[calc(var(--para-gap)*4)] w-full sm:hidden"
            stationName={stationName}
            lat={lat}
            lng={lng}
            clusterMembers={clusterMembers}
            isFriendOrigin={isFriendOrigin}
            isPrimaryOrigin={isPrimaryOrigin}
          />
        </DialogHeader>

        {/* ── Dev tools: rating buttons + delete ── */}
        {devMode && (
          <div className="shrink-0 border-t px-6 py-3">
            <div className="flex items-center gap-1.5">
              {/* Bury toggle — primary-green when the station is currently
                  buried. Buried unrated stations are zoom-gated (see map.tsx
                  for the rules). Cross icon matches the buried map marker. */}
              <DevActionButton
                label={isBuried ? "Unbury" : "Bury"}
                active={isBuried}
                onClick={() => onBury?.()}
                icon={
                  /* Latin cross — horizontal raised to the upper third, matching
                     the buried map marker. */
                  <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none"
                    stroke={isBuried ? 'var(--primary)' : 'currentColor'}
                    strokeWidth="3" strokeLinecap="butt">
                    <line x1="4" y1="9" x2="20" y2="9" />
                    <line x1="12" y1="4" x2="12" y2="20" />
                  </svg>
                }
              />

              {/* Issue flag — admin-only. Station-global: toggling affects
                  this station under every primary, not just the current home. */}
              {onToggleIssue && (
                <DevActionButton
                  label={hasIssue ? "Clear issue" : "Flag issue"}
                  active={hasIssue}
                  onClick={() => onToggleIssue(!hasIssue)}
                  icon={
                    /* Exclamation mark — highlighted primary when flagged. */
                    <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none"
                      stroke={hasIssue ? 'var(--primary)' : 'currentColor'}
                      strokeWidth="3" strokeLinecap="round" strokeLinejoin="round">
                      <line x1="12" y1="4" x2="12" y2="14" />
                      <line x1="12" y1="19" x2="12" y2="19.01" />
                    </svg>
                  }
                />
              )}

              {/* Read-only rating display — derived from the station's walks.
                  No setter; admins set ratings on individual walks instead. */}
              <div className="mx-1 h-6 w-px bg-border" />
              <span className="px-2 text-xs text-muted-foreground">
                Rating: {currentRating ?? "—"} <span className="opacity-50">(from walks)</span>
              </span>
            </div>
          </div>
        )}

        {/* ── Photo area — now just a padded block ──
            The parent scroll wrapper (opened above, right after the title
            row) handles the actual overflow. This used to own
            `min-h-0 flex-1 overflow-y-auto`, but moving those onto the
            outer wrapper lets the notes/journey section scroll with the
            photos on desktop — which is what the user wants (title + Hike
            button stay pinned; everything else scrolls together). */}
        <div className="px-6 pt-6 pb-6">

          {/* No API key */}
          {!hasApiKey && (
            <div className="rounded-lg bg-muted px-4 py-6 text-center">
              <p className="text-sm font-medium">Flickr API key not configured</p>
              <p className="mt-1 text-xs text-muted-foreground">
                Add{" "}
                <code className="rounded bg-background px-1 py-0.5 font-mono text-[11px]">
                  NEXT_PUBLIC_FLICKR_API_KEY=your_key
                </code>{" "}
                to <code className="rounded bg-background px-1 py-0.5 font-mono text-[11px]">.env.local</code>{" "}
                to enable photos.
              </p>
            </div>
          )}

          {/* Loading state — logo-glyph spinner centered in the
              blank photo-grid area. min-height approximates the
              3-row photo grid that lands here once loaded, so the
              spinner sits visually where the photos will appear
              rather than floating near the top. 20% opacity keeps
              it as "quiet background activity" rather than a
              prominent focal element. Replaces the previous
              shimmer-skeleton grid. */}
          {hasApiKey && loading && (
            <div className="flex items-start justify-center pt-16 pb-[25vh] min-h-[50vh] text-primary">
              <LogoSpinner className="h-10" label="Loading photos" />
            </div>
          )}

          {/* Error */}
          {hasApiKey && !loading && error && (
            <p className="text-sm text-destructive">{error}</p>
          )}

          {/* Admin-only tabs + per-tab settings panel. Tabs live ABOVE the
              photos so the admin can switch views without scrolling. The
              Approved tab is the default — most stations open to an empty
              grid for admins, reflecting "only approved photos are canonical". */}
          {hasApiKey && devMode && (
            <AdminTabsAndSettings
              selectedTab={selectedTab}
              onSelectTab={setSelectedTab}
              approvedCount={approvedPhotos.length}
              customSettings={customSettings ?? null}
              onSaveCustom={onSaveCustom}
              stationName={stationName}
              publicNote={publicNote}
              adminWalksAll={adminWalksAll}
              presets={presets ?? null}
              onSavePreset={onSavePreset}
              // Refreshing bumps the counter, which changes the fetch effect's
              // dep → forces a refetch with ?bust=<counter> so the server
              // skips its cache for this request.
              onRefresh={() => setRefreshCounter((n) => n + 1)}
            />
          )}

          {/* No photos found — only shown when we've actually finished
              fetching and have nothing (includes admin tabs that legitimately
              return nothing, e.g. a "custom" tab with no config). */}
          {hasApiKey && !loading && !error && photos.length === 0 && (
            <p className="text-sm text-muted-foreground">
              {devMode && selectedTab === "approved"
                ? "No approved photos for this station yet."
                : devMode && selectedTab === "custom" && !customSettings
                  ? "No custom config for this station — save tags below to populate this feed."
                  : "No photos found near this station on Flickr."}
            </p>
          )}

          {/* Photo grid — 1 col → 2 → 3. In admin Approved tab, a horizontal
              divider splits the first 12 approved (the public gallery) from
              everything beyond (the "bench"). Non-admin and other tabs don't
              need that divider. */}
          {hasApiKey && !loading && photos.length > 0 && (
            <>
              {(() => {
                const showDivider = devMode && selectedTab === "approved" && photos.length > MAX_PHOTOS
                const reorderable = devMode && selectedTab === "approved"
                const firstGroup = showDivider ? photos.slice(0, MAX_PHOTOS) : photos
                const secondGroup = showDivider ? photos.slice(MAX_PHOTOS) : []
                const renderCards = (list: FlickrPhoto[]) => list.map((photo) => {
                  const isApproved = approvedIds.has(photo.id)
                  const approvedIndex = approvedPhotos.findIndex((p) => p.id === photo.id)
                  const isPinned = pinnedIds.has(photo.id)
                  // Movability depends on whether the photo itself is pinned:
                  //   - A PINNED photo can swap with any adjacent photo (pins
                  //     can bump other pins), so movability reduces to "is
                  //     there ANY photo in that direction".
                  //   - A NON-pinned photo still treats pins as fixed blockers,
                  //     so it needs at least one non-pinned slot (or self) in
                  //     that direction to swap into.
                  // Non-approved photos always allow "jump to top" since it
                  // approves + inserts into the list.
                  const hasMovableSlotBefore = isApproved && (
                    isPinned
                      ? approvedIndex > 0
                      : approvedPhotos
                          .slice(0, approvedIndex)
                          .some((p) => !pinnedIds.has(p.id) || p.id === photo.id)
                  )
                  const hasMovableSlotAfter = isApproved && (
                    isPinned
                      ? approvedIndex < approvedPhotos.length - 1
                      : approvedPhotos
                          .slice(approvedIndex + 1)
                          .some((p) => !pinnedIds.has(p.id) || p.id === photo.id)
                  )
                  const canMoveUp = !isApproved ? true : hasMovableSlotBefore
                  const canMoveDown = hasMovableSlotAfter
                  // Pin button shows only on Approved tab, only for photos
                  // within the public-visible first MAX_PHOTOS slots. (Non-
                  // approved photos never show it; approved-but-past-#12
                  // "bench" photos never show it.)
                  const showPin = selectedTab === "approved"
                    && isApproved
                    && approvedIndex >= 0
                    && approvedIndex < MAX_PHOTOS
                  // onMoveToTop branches on approval state:
                  //   - Approved photo → in-place section-aware move (server "top" action).
                  //   - Non-approved photo → approve + place at top of non-pinned.
                  const handleJumpToTop = () => {
                    if (isApproved) onMovePhoto?.(photo.id, "top")
                    else onApprovePhotoAtTop?.(photo)
                  }
                  // All curation actions reorder or re-style the grid,
                  // which can jolt the viewport — wrap every click in
                  // withPreservedScroll so the admin's scroll position
                  // survives pin / unpin / approve / move operations.
                  return (
                    <PhotoCard
                      key={photo.id}
                      photo={photo}
                      devMode={devMode}
                      isApproved={isApproved}
                      isPinned={isPinned}
                      showPin={showPin}
                      showReorder={reorderable && approvedIndex >= 0}
                      onApprove={() => withPreservedScroll(() => onApprovePhoto?.(photo))}
                      onUnapprove={() => withPreservedScroll(() => onUnapprovePhoto?.(photo.id))}
                      onPin={() => withPreservedScroll(() => onPinPhoto?.(photo))}
                      onUnpin={() => withPreservedScroll(() => onUnpinPhoto?.(photo.id))}
                      onMoveToBottom={() => withPreservedScroll(() => onMovePhoto?.(photo.id, "bottom"))}
                      onMoveUp={() => withPreservedScroll(() => onMovePhoto?.(photo.id, "up"))}
                      onMoveDown={() => withPreservedScroll(() => onMovePhoto?.(photo.id, "down"))}
                      onMoveToTop={() => withPreservedScroll(handleJumpToTop)}
                      canMoveUp={canMoveUp}
                      canMoveDown={canMoveDown}
                      onImageError={() => handleImageError(photo.id)}
                    />
                  )
                })
                return (
                  <>
                    <div className="grid grid-cols-1 gap-2 sm:grid-cols-2 sm:gap-4 lg:grid-cols-3 max-sm:-mx-6">
                      {renderCards(firstGroup)}
                    </div>
                    {showDivider && (
                      <>
                        {/* Divider separating the public-visible first 12 from
                            the admin-only "bench" (extras beyond slot 12). */}
                        <div className="my-6 border-t-2 border-foreground/70" aria-label="Public gallery cutoff — everything below is admin-only" />
                        <div className="grid grid-cols-1 gap-2 sm:grid-cols-2 sm:gap-4 lg:grid-cols-3 max-sm:-mx-6">
                          {renderCards(secondGroup)}
                        </div>
                      </>
                    )}
                  </>
                )
              })()}

            </>
          )}

          {/* "Back to top" — in admin mode it's always visible on every tab
              and every viewport (the tab header + settings panel make the
              page long; admins want a fast scroll-to-top shortcut regardless
              of whether photos have loaded). For non-admins we keep the
              original mobile-only behaviour, and only render it when there
              are photos above to scroll past. */}
          {hasApiKey && (devMode || photos.length > 0) && (
            <div className={`mt-4 flex justify-center ${devMode ? "" : "md:hidden"}`}>
              <Button
                variant="ghost"
                size="sm"
                className="cursor-pointer"
                onClick={() => {
                  if (typeof document === "undefined") return
                  // Desktop: the real scroll container is the inner
                  // `[data-modal-scroll]` div (DialogContent itself is
                  // overflow-hidden). Mobile: the outer DialogContent is
                  // the scroll container. Scroll both so "top" works on
                  // every breakpoint without a width check.
                  const inner = document.querySelector('[data-modal-scroll]')
                  if (inner instanceof HTMLElement) inner.scrollTo({ top: 0, behavior: "smooth" })
                  const outer = document.querySelector('[data-slot="dialog-content"]')
                  if (outer instanceof HTMLElement) outer.scrollTo({ top: 0, behavior: "smooth" })
                }}
              >
                <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24"
                  fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                  <polyline points="18 15 12 9 6 15" />
                </svg>
                Back to top
              </Button>
            </div>
          )}
        </div>
        </div>{/* /scroll region */}
      </DialogContent>
    </Dialog>
  )
}

// ── Admin tabs + per-tab settings panel ───────────────────────────────────
// Admin-only. Sits ABOVE the photo grid. Replaces the old bottom-of-modal
// Flickr settings panel. Tabs:
//   - Approved (N/12) — shows all approved photos, divider after the 12th.
//   - Custom           — raw feed for the per-station custom config.
//   - Landscapes       — raw feed for the global landscapes preset.
//   - Hikes            — raw feed for the global hikes preset.
//   - Station          — raw feed for the global station preset.
// When selected tab ≠ Approved, the settings fields for that tab render
// directly below the tab row (above the photos). Custom saves per-station;
// landscapes/hikes/station saves are GLOBAL and affect every station.

function AdminTabsAndSettings({
  selectedTab,
  onSelectTab,
  approvedCount,
  customSettings,
  onSaveCustom,
  stationName,
  publicNote,
  adminWalksAll,
  presets,
  onSavePreset,
  onRefresh,
}: {
  selectedTab: "approved" | "custom" | "landscapes" | "hikes" | "station"
  onSelectTab: (t: "approved" | "custom" | "landscapes" | "hikes" | "station") => void
  approvedCount: number
  customSettings: CustomSettings | null
  onSaveCustom?: (custom: CustomSettings | null) => void
  stationName: string
  publicNote: string
  adminWalksAll: string
  presets: { landscapes: CustomSettings; hikes: CustomSettings; station: CustomSettings } | null
  onSavePreset?: (name: "landscapes" | "hikes" | "station", preset: CustomSettings) => void
  onRefresh?: () => void
}) {
  const TABS: { key: typeof selectedTab; label: string }[] = [
    { key: "approved", label: `Approved (${approvedCount}/${MAX_GALLERY_PHOTOS})` },
    { key: "custom", label: "Custom" },
    { key: "landscapes", label: "Landscapes" },
    { key: "hikes", label: "Hikes" },
    { key: "station", label: "Station" },
  ]

  // Is the current tab a preset tab (global edit) or the custom (per-station) tab?
  const isPresetTab = selectedTab === "landscapes" || selectedTab === "hikes" || selectedTab === "station"
  const presetName = isPresetTab ? (selectedTab as "landscapes" | "hikes" | "station") : null

  // What config are we editing? For custom: per-station settings. For preset
  // tabs: the global preset (or null while presets are loading).
  const activeSettings: CustomSettings | null =
    selectedTab === "custom" ? customSettings
    : presetName && presets ? presets[presetName]
    : null

  // Snapshot each preset on first open of this modal instance. "Reset" reverts
  // to this snapshot — i.e. it undoes THIS SESSION'S edits. Once the modal
  // closes and re-opens, whatever values were saved last time become the new
  // snapshot (the "new default"). Radix Dialog unmounts content on close so
  // the ref resets naturally each open.
  const presetSnapshotRef = useRef<typeof presets>(null)
  useEffect(() => {
    if (presets && !presetSnapshotRef.current) {
      presetSnapshotRef.current = presets
    }
  }, [presets])
  // The snapshot for the currently-viewed preset tab (null for custom tab).
  const activeSnapshot = presetName && presetSnapshotRef.current
    ? presetSnapshotRef.current[presetName]
    : null

  return (
    <>
      {/* Tabs row — scrolls horizontally on narrow viewports. Selected tab
          gets a solid background; others are ghost-style. */}
      <div
        role="tablist"
        aria-label="Photo source"
        className="mb-4 flex gap-1 overflow-x-auto border-b border-border/50 pb-0"
      >
        {TABS.map((t) => {
          const active = t.key === selectedTab
          return (
            <button
              key={t.key}
              type="button"
              role="tab"
              aria-selected={active}
              onClick={() => onSelectTab(t.key)}
              className={
                "cursor-pointer whitespace-nowrap rounded-t-md px-3 py-2 text-sm transition-colors " +
                (active
                  ? "border-b-2 border-foreground bg-muted/60 font-medium text-foreground"
                  : "text-muted-foreground hover:bg-muted/30 hover:text-foreground")
              }
            >
              {t.label}
            </button>
          )
        })}
      </div>

      {/* Per-tab settings panel. The Approved tab has no settings (just shows
          the list of approved photos). Custom + preset tabs share the same
          editor; differences are the save target (per-station vs global) and
          the reset button (preset only). */}
      {selectedTab !== "approved" && (
        <TabSettingsPanel
          key={selectedTab}
          mode={selectedTab === "custom" ? "custom" : "preset"}
          presetName={presetName}
          settings={activeSettings}
          sessionSnapshot={activeSnapshot}
          stationName={stationName}
          publicNote={publicNote}
          adminWalksAll={adminWalksAll}
          onSaveCustom={onSaveCustom}
          onSavePreset={onSavePreset}
          onRefresh={onRefresh}
        />
      )}
    </>
  )
}

// Expand a station name into one or more place-name tags for Flickr search.
// Compound names like "Goring & Streatley" or "Windsor and Eton Central" map to
// multiple tags so each town is searchable on its own. Common UK station
// disambiguators (Central, Riverside, Parkway, etc.) are stripped — they aren't
// part of the actual place name. The helper is conservative: words like "Hill"
// or "Spa" stay because they CAN be part of a real name (e.g. Box Hill, Bath Spa).
function expandStationTags(stationName: string): string[] {
  // Drop a trailing " Station" / " station" suffix if present.
  const cleaned = stationName.replace(/\s+station$/i, "").trim()
  // Split compound names on "&" or the word "and" (with surrounding spaces, so
  // we don't split inside actual place names that happen to contain "and").
  const parts = cleaned.split(/\s+&\s+|\s+and\s+/i)
  // Suffixes that are pure rail-network disambiguators, never part of a town
  // name. Add carefully — anything ambiguous (Hill, Spa, North/South) stays out.
  const SUFFIX = /\s+(central|parkway|riverside|international|junction|cross)$/i
  return parts
    .map((p) => p.trim().replace(SUFFIX, "").trim().toLowerCase())
    .filter(Boolean)
}

// Per-tab settings editor. Identical fields for custom and preset modes —
// the difference is purely where the save goes (per-station vs global).
function TabSettingsPanel({
  mode,
  presetName,
  settings,
  sessionSnapshot,
  stationName,
  publicNote,
  adminWalksAll,
  onSaveCustom,
  onSavePreset,
  onRefresh,
}: {
  mode: "custom" | "preset"
  presetName: "landscapes" | "hikes" | "station" | null
  settings: CustomSettings | null
  /** The preset values at modal-open. "Reset to defaults" reverts to this
   *  snapshot — it undoes THIS SESSION'S edits. Null for the custom tab. */
  sessionSnapshot: CustomSettings | null
  stationName: string
  publicNote: string
  adminWalksAll: string
  onSaveCustom?: (custom: CustomSettings | null) => void
  onSavePreset?: (name: "landscapes" | "hikes" | "station", preset: CustomSettings) => void
  onRefresh?: () => void
}) {
  // Local state mirrors the saved config — typing doesn't round-trip on every
  // keystroke; we save on blur (or change for radius/sort).
  const [include, setInclude] = useState(settings?.includeTags.join(", ") ?? "")
  const [exclude, setExclude] = useState(settings?.excludeTags.join(", ") ?? "")
  const [radius, setRadius] = useState(settings?.radius ?? 7)
  const [sort, setSort] = useState<FlickrSort>(settings?.sort ?? "relevance")

  // Resync when the parent pushes new settings (e.g. preset loaded / reset).
  useEffect(() => {
    setInclude(settings?.includeTags.join(", ") ?? "")
    setExclude(settings?.excludeTags.join(", ") ?? "")
    setRadius(settings?.radius ?? 7)
    setSort(settings?.sort ?? "relevance")
  }, [settings])

  // Seed the per-station custom config on first use from extracted place names
  // in the station's notes — same ordering logic as before.
  const buildInitialCustom = (): CustomSettings => {
    const { trails, terrains, sights, settlements } = categorizePlaceNames(publicNote, adminWalksAll)
    const seen = new Set<string>()
    const includeTags: string[] = []
    const pushUnique = (t: string) => {
      if (!t || seen.has(t)) return
      seen.add(t)
      includeTags.push(t)
    }
    for (const t of expandStationTags(stationName)) pushUnique(t)
    for (const t of trails) pushUnique(t)
    for (const t of terrains) pushUnique(t)
    for (const t of sights) pushUnique(t)
    for (const t of settlements) pushUnique(t)
    return {
      includeTags: includeTags.slice(0, 20),
      excludeTags: [],
      radius: 7,
      sort: "relevance",
    }
  }

  const commit = (overrides?: { sort?: FlickrSort; radius?: number }) => {
    const payload: CustomSettings = {
      includeTags: include.split(",").map((t) => t.trim()).filter(Boolean),
      excludeTags: exclude.split(",").map((t) => t.trim()).filter(Boolean),
      radius: overrides?.radius ?? radius,
      sort: overrides?.sort ?? sort,
    }
    if (mode === "custom") onSaveCustom?.(payload)
    else if (presetName) onSavePreset?.(presetName, payload)
  }

  // Auto-seed the custom config on first visit to the Custom tab — mirrors
  // the old dropdown behaviour where picking "Custom" immediately populated
  // the fields from the station's notes. Only fires when:
  //   - this is the per-station Custom tab (mode === "custom")
  //   - no config exists yet (settings === null)
  //   - the parent wired up a save handler
  // Subsequent edits are saved on blur via commit() below.
  useEffect(() => {
    if (mode === "custom" && !settings && onSaveCustom) {
      onSaveCustom(buildInitialCustom())
    }
    // Only fires on mount / when mode or settings flip — not on every render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mode, settings])

  const includeCount = include.split(",").map((t) => t.trim()).filter(Boolean).length
  const excludeCount = exclude.split(",").map((t) => t.trim()).filter(Boolean).length
  const overIncludeCap = includeCount > 20

  return (
    <section className="mb-6 rounded-md border border-border/50 bg-muted/30 p-4 text-sm">
      {/* Header — explains the scope of edits (per-station vs global). */}
      <div className="mb-3">
        {mode === "custom" ? (
          <p className="text-xs text-muted-foreground">
            Per-station custom feed. Edits here only affect this station.
          </p>
        ) : (
          <p className="text-xs text-amber-700 dark:text-amber-400">
            Editing <span className="font-medium text-foreground">{presetName}</span> — affects every station that uses this algo.
          </p>
        )}
      </div>

      {(settings || mode === "preset") && (
        <div className="space-y-3">
          <div>
            <label className="mb-1 block text-xs font-medium">
              Include tags (comma-separated)
              <span className={`ml-2 font-normal ${overIncludeCap ? "text-amber-600 dark:text-amber-400" : "text-muted-foreground"}`}>
                ({includeCount}/20)
              </span>
            </label>
            <textarea
              value={include}
              onChange={(e) => setInclude(e.target.value)}
              onBlur={() => commit()}
              rows={3}
              className="w-full resize-y rounded border border-input bg-background px-2 py-1 font-mono text-xs focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50"
            />
            {overIncludeCap && (
              <p className="mt-1 text-xs text-amber-600 dark:text-amber-400">
                Flickr only accepts 20 include tags. Extras will be dropped — prune or reorder.
              </p>
            )}
          </div>
          <div>
            <label className="mb-1 block text-xs font-medium">
              Exclude tags (comma-separated)
              <span className="ml-2 font-normal text-muted-foreground">({excludeCount})</span>
            </label>
            <textarea
              value={exclude}
              onChange={(e) => setExclude(e.target.value)}
              onBlur={() => commit()}
              rows={3}
              className="w-full resize-y rounded border border-input bg-background px-2 py-1 font-mono text-xs focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50"
            />
          </div>
          <div className="flex items-center gap-2">
            <label className="text-xs font-medium">Radius</label>
            <input
              type="number"
              min={0.1}
              max={30}
              step={0.5}
              value={radius}
              onChange={(e) => setRadius(Number(e.target.value))}
              onBlur={() => commit()}
              className="w-16 rounded border border-input bg-background px-2 py-1 text-xs focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50"
            />
            <span className="text-xs text-muted-foreground">km</span>
          </div>
          <div className="flex items-center gap-2">
            <label htmlFor="sort-select" className="text-xs font-medium">Sort</label>
            <select
              id="sort-select"
              value={sort}
              onChange={(e) => {
                const next = e.target.value as FlickrSort
                setSort(next)
                commit({ sort: next })
              }}
              className="cursor-pointer rounded border border-input bg-background px-1 py-0.5 text-xs focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50"
            >
              <option value="relevance">Relevance (tag match)</option>
              <option value="interestingness-desc">Interestingness (engagement)</option>
            </select>
          </div>
        </div>
      )}

      {/* Footer actions. All non-approved tabs get a Refresh button — the tab
          photo grid doesn't auto-update as you edit settings, so the admin
          clicks Refresh to see the effect of their edits. Custom tabs also
          get a Clear config button; preset tabs also get Reset. */}
      <div className="mt-3 flex justify-end gap-2">
        {onRefresh && (
          // shadcn Button with variant="default" gives us the built-in hover
          // + active (pressed) states and the consistent focus ring. size="sm"
          // keeps it proportional to the small textareas above. The ↻ glyph
          // + label reads clearly at this size without needing a full SVG.
          <Button
            type="button"
            variant="default"
            size="sm"
            onClick={onRefresh}
            title="Fetch fresh photos from Flickr (bypass server cache)"
            className="cursor-pointer"
          >
            ↻ Refresh gallery
          </Button>
        )}
        {mode === "custom" && settings && (
          <button
            type="button"
            onClick={() => onSaveCustom?.(null)}
            className="cursor-pointer rounded border border-input px-2 py-1 text-xs text-muted-foreground transition-colors hover:bg-background hover:text-foreground"
          >
            Clear custom config
          </button>
        )}
        {/* "Reset to defaults" only appears when THIS SESSION has edited the
            preset — i.e. the current value differs from the snapshot captured
            on modal open. Reverts to that snapshot (undoes session edits).
            When the modal closes and re-opens, the saved values become the
            new snapshot, so they're effectively the new default. */}
        {mode === "preset" && presetName && sessionSnapshot && settings &&
          JSON.stringify(sessionSnapshot) !== JSON.stringify(settings) && (
          <button
            type="button"
            onClick={() => onSavePreset?.(presetName, sessionSnapshot)}
            title="Revert to the values this preset had when you opened the modal"
            className="cursor-pointer rounded border border-input px-2 py-1 text-xs text-muted-foreground transition-colors hover:bg-background hover:text-foreground"
          >
            Reset to defaults
          </button>
        )}
      </div>
    </section>
  )
}

// ── Dev action button ──────────────────────────────────────────────────────
// Small icon button used in the dev tools row. Shows a tooltip-style label
// and highlights with a subtle ring when the action is currently active.

function DevActionButton({ label, icon, active, onClick }: {
  label: string
  icon: React.ReactNode
  active: boolean
  onClick: () => void
}) {
  return (
    <button
      onClick={onClick}
      title={label}
      className={`flex h-8 w-8 items-center justify-center rounded-md transition-colors
        ${active
          ? "bg-muted ring-2 ring-foreground/20"  /* subtle ring highlights the active rating */
          : "hover:bg-muted"
        }`}
    >
      {icon}
    </button>
  )
}

// ── Photo card ─────────────────────────────────────────────────────────────
// Uses largeUrl (1024px) when available, falls back to thumbnailUrl (240px).
// 4:3 aspect ratio gives photos a scenic landscape feel at this size.
//
// In admin mode, approve + pin buttons sit in the top-left cluster. Reorder
// buttons sit in the top-right cluster and only show for approved photos in
// the Approved tab (gated by `showReorder`).

function PhotoCard({ photo, devMode, isApproved, isPinned, showPin = false, showReorder = false, onApprove, onUnapprove, onPin, onUnpin, onMoveToTop, onMoveToBottom, onMoveUp, onMoveDown, canMoveUp, canMoveDown, onImageError }: {
  photo: FlickrPhoto
  devMode: boolean
  isApproved: boolean
  isPinned: boolean
  /** When true, the pin button renders. Gated to Approved tab + first MAX_PHOTOS slots by the caller. */
  showPin?: boolean
  /** When true AND the photo is approved, reorder buttons render. */
  showReorder?: boolean
  onApprove: () => void
  onUnapprove: () => void
  onPin?: () => void
  onUnpin?: () => void
  onMoveToTop?: () => void
  onMoveToBottom?: () => void
  onMoveUp?: () => void
  onMoveDown?: () => void
  canMoveUp?: boolean
  canMoveDown?: boolean
  onImageError?: () => void
}) {
  return (
    // `group` lets child elements react to this container's hover state.
    // We use a <div> wrapper instead of making the <a> the group so that
    // the approve/reject buttons can intercept clicks without navigating.
    <div className="group relative overflow-hidden rounded-none sm:rounded-lg bg-muted">
      <a
        href={photo.flickrUrl}
        target="_blank"
        rel="noopener noreferrer"
        className="block"
      >
        {/* Landscape-ratio photo — object-cover fills the box without distortion.
            onError bubbles a "this photo is dead" signal to the parent so it can
            drop it from the display list and pull in a backfill / re-fetch Flickr. */}
        <img
          src={photo.largeUrl ?? photo.thumbnailUrl}
          alt={photo.title}
          onError={onImageError}
          className="aspect-[4/3] w-full object-cover transition-opacity duration-150 group-hover:opacity-90"
          loading="lazy"
        />
      </a>

      {/* Admin actions — two clusters, so moderation and reorder don't crowd each other:
            - top-left: approve + reject (moderation)
            - top-right: reorder controls (only on approved photos — reordering the curated set)
          Visibility rules (per button, because the approve button breaks the pattern when approved):
            - mobile (< md): always visible (touch devices have no hover)
            - md and up: fade in only on hover of the parent .group (the photo card)
          EXCEPTION: the approve button on an already-approved photo gets a solid emerald background
          (same colour as its hover state) and stays fully visible at every breakpoint, to act as
          the approval indicator. Clicking it un-approves. */}
      {devMode && (
        <>
          {/* Top-left cluster: approve + pin. Approve is leftmost — it's the
              baseline moderation action; pin sits next to it as the "promote"
              action (which also approves implicitly). Wrapper has no opacity
              classes; per-button styling below lets the active-state
              indicators (green check / amber pin) stay visible. */}
          <div className="absolute top-0 left-0 flex gap-1 p-2">
            {/* Approve button — doubles as the approval indicator when isApproved.
                When approved: solid emerald bg (same colour as unapproved-hover), always visible,
                click un-approves. When not approved: semi-opaque black, hover-only on desktop,
                click approves. */}
            <button
              onClick={(e) => { e.stopPropagation(); (isApproved ? onUnapprove() : onApprove()) }}
              title={isApproved ? 'Remove approval' : 'Approve photo'}
              className={
                isApproved
                  // Approved state: emerald always, darker emerald on hover for affordance
                  ? 'flex h-7 w-7 items-center justify-center rounded-md bg-emerald-600/90 text-white backdrop-blur-sm transition-colors hover:bg-emerald-700 cursor-pointer opacity-100'
                  // Unapproved state: matches the old look, hover-only visibility on desktop
                  : 'flex h-7 w-7 items-center justify-center rounded-md bg-black/60 text-white backdrop-blur-sm transition-all duration-150 hover:bg-emerald-600/90 cursor-pointer opacity-100 md:opacity-0 md:group-hover:opacity-100'
              }
            >
              <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24"
                fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                <polyline points="20 6 9 17 4 12" />
              </svg>
            </button>
            {/* Pin button — doubles as the pin indicator when isPinned.
                Only rendered when `showPin` is true (gated by the parent to
                the Approved tab + first MAX_PHOTOS slots).
                When pinned: solid emerald bg (matches the approve indicator),
                always visible, click unpins. When not pinned: semi-opaque
                black, hover-only on desktop, click pins (locks the photo at
                its current position so other photos skip over it on reorder). */}
            {showPin && (
              <button
                onClick={(e) => { e.stopPropagation(); (isPinned ? onUnpin?.() : onPin?.()) }}
                title={isPinned ? 'Remove pin' : 'Pin photo at this position'}
                className={
                  isPinned
                    ? 'flex h-7 w-7 items-center justify-center rounded-md bg-emerald-600/90 text-white backdrop-blur-sm transition-colors hover:bg-emerald-700 cursor-pointer opacity-100'
                    : 'flex h-7 w-7 items-center justify-center rounded-md bg-black/60 text-white backdrop-blur-sm transition-all duration-150 hover:bg-emerald-600/90 cursor-pointer opacity-100 md:opacity-0 md:group-hover:opacity-100'
                }
              >
                {/* Pushpin icon — simple silhouette that reads clearly at 14px */}
                <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24"
                  fill="currentColor" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M12 2 L14 2 L15 8 L19 11 L19 13 L13 13 L13 22 L11 22 L11 13 L5 13 L5 11 L9 8 L10 2 Z" />
                </svg>
              </button>
            )}
          </div>

          {/* Top-right cluster: reorder controls.
              The "jump to top" (double chevron up) button shows for EVERY
              photo on EVERY tab. For approved photos it does the section-
              aware in-place jump; for non-approved photos it implicitly
              approves and places at the top of the non-pinned section.
              The within-list buttons (single chevrons + jump to bottom)
              only show on the Approved tab for approved photos, where
              admins are doing the detailed list reordering. */}
          {(
            <div className="absolute top-0 right-0 flex gap-1 p-2 opacity-100 transition-opacity duration-150 md:opacity-0 md:group-hover:opacity-100">
              {/* Jump to top — available on all tabs. Bubbles the photo up,
                  skipping past any pinned photos (which stay at their slots)
                  and stopping at the topmost reachable position. */}
              <button
                onClick={(e) => { e.stopPropagation(); onMoveToTop?.() }}
                title="Jump to top (skipping past pinned photos)"
                disabled={!canMoveUp}
                className="flex h-7 w-7 items-center justify-center rounded-md bg-black/60 text-white backdrop-blur-sm transition-colors hover:bg-white/30 cursor-pointer disabled:opacity-30 disabled:cursor-default"
              >
                <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24"
                  fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                  <polyline points="18 11 12 5 6 11" />
                  <polyline points="18 19 12 13 6 19" />
                </svg>
              </button>
              {showReorder && isApproved && (
                <>
                  <button
                    onClick={(e) => { e.stopPropagation(); onMoveUp?.() }}
                    title="Move photo up"
                    disabled={!canMoveUp}
                    className="flex h-7 w-7 items-center justify-center rounded-md bg-black/60 text-white backdrop-blur-sm transition-colors hover:bg-white/30 cursor-pointer disabled:opacity-30 disabled:cursor-default"
                  >
                    {/* Chevron up */}
                    <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24"
                      fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                      <polyline points="18 15 12 9 6 15" />
                    </svg>
                  </button>
                  <button
                    onClick={(e) => { e.stopPropagation(); onMoveDown?.() }}
                    title="Move photo down"
                    disabled={!canMoveDown}
                    className="flex h-7 w-7 items-center justify-center rounded-md bg-black/60 text-white backdrop-blur-sm transition-colors hover:bg-white/30 cursor-pointer disabled:opacity-30 disabled:cursor-default"
                  >
                    {/* Chevron down */}
                    <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24"
                      fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                      <polyline points="6 9 12 15 18 9" />
                    </svg>
                  </button>
                  {/* Jump to bottom — mirror of jump-up. Bubbles the photo
                      down past any pinned photos (which stay put). */}
                  <button
                    onClick={(e) => { e.stopPropagation(); onMoveToBottom?.() }}
                    title="Jump to bottom (skipping past pinned photos)"
                    disabled={!canMoveDown}
                    className="flex h-7 w-7 items-center justify-center rounded-md bg-black/60 text-white backdrop-blur-sm transition-colors hover:bg-white/30 cursor-pointer disabled:opacity-30 disabled:cursor-default"
                  >
                    {/* Double chevron down — mirror of the jump-to-top icon */}
                    <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24"
                      fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                      <polyline points="6 13 12 19 18 13" />
                      <polyline points="6 5 12 11 18 5" />
                    </svg>
                  </button>
                </>
              )}
            </div>
          )}
        </>
      )}

      {/* Attribution overlay — slides up on hover */}
      <div className="pointer-events-none absolute inset-x-0 bottom-0 translate-y-full bg-gradient-to-t from-black/70 to-transparent px-2.5 pb-2 pt-5 transition-transform duration-150 group-hover:translate-y-0">
        <p className="truncate text-xs font-medium leading-tight text-white">
          {photo.title}
        </p>
        <p className="truncate text-[10px] text-white/70">{photo.ownerName}</p>
      </div>
    </div>
  )
}
