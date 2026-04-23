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
import { type FlickrPhoto } from "@/lib/flickr"
import { getEffectiveJourney, prettifyStationLabel } from "@/lib/effective-journey"
import londonTerminalsData from "@/data/london-terminals.json"

// Calls our server-side proxy at /api/flickr/photos instead of Flickr directly.
// Why: Safari + iCloud Private Relay shares egress IPs that Flickr sometimes
// rate-limits, causing empty/failed responses. Same-origin requests bypass
// Private Relay entirely — and our server reaches Flickr from a clean IP.
async function fetchPhotosViaProxy(
  lat: number,
  lng: number,
  hasCurations: boolean,
  rejectedCount: number,
  isOrigin: boolean,
): Promise<FlickrPhoto[]> {
  const params = new URLSearchParams({
    lat: String(lat),
    lng: String(lng),
    hasCurations: hasCurations ? "1" : "0",
    isOrigin: isOrigin ? "1" : "0",
    rejectedCount: String(rejectedCount),
  })
  const res = await fetch(`/api/flickr/photos?${params}`)
  if (!res.ok) throw new Error(`photos proxy ${res.status}`)
  const data = (await res.json()) as { photos?: FlickrPhoto[] }
  return data.photos ?? []
}
import { Button } from "@/components/ui/button"
import { LogoSpinner } from "@/components/logo-spinner"
import { HugeiconsIcon } from "@hugeicons/react"
import { Cancel01Icon, MapingIcon } from "@hugeicons/core-free-icons"

export type { FlickrPhoto }

type Rating = 'highlight' | 'verified' | 'unverified' | 'not-recommended'

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
  /** The station's current universal rating, or null if unrated */
  currentRating?: Rating | null
  /** Sets or clears the station's rating — null means "unrated" */
  onRate?: (rating: Rating | null) => void
  /** Excludes (deletes) the station */
  onExclude?: () => void
  /** True when this station is currently excluded (admin-only) */
  isExcluded?: boolean
  /** Photos the admin has approved for this station (always displayed) */
  approvedPhotos?: FlickrPhoto[]
  /** Flickr IDs the admin has rejected for this station (never displayed) */
  rejectedIds?: Set<string>
  /** Called when the admin approves a photo */
  onApprovePhoto?: (photo: FlickrPhoto) => void
  /** Called when the admin rejects a photo */
  onRejectPhoto?: (photoId: string) => void
  /** Called when the admin un-approves a photo (removes from approved, does not reject) */
  onUnapprovePhoto?: (photoId: string) => void
  /** Called when the admin moves an approved photo up or down in the display order */
  onMovePhoto?: (photoId: string, direction: "up" | "down" | "top") => void
  /** Public note for this station — visible to everyone */
  publicNote?: string
  /** Private note — only visible in admin mode */
  privateNote?: string
  /** Rambler recommendations — visible to everyone, sourced from walkingclub.org.uk extractions */
  ramblerNote?: string
  /** Saves all three note types when the overlay closes */
  onSaveNotes?: (publicNote: string, privateNote: string, ramblerNote: string) => void
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
  /** Admin-only: 3-letter CRS code (e.g. "CLJ"). When present AND
   *  adminMode is true, the title is prefixed with the code — helps
   *  cross-reference the admin RTT status panel and origin-routes.json. */
  stationCrs?: string
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
}

// Canonical London-terminus names (+ their aliases) used by the
// highlighter. Built once at module load from london-terminals.json so
// the regex below covers every form the journey text might contain —
// "London Bridge", "St Pancras", "Kings Cross" (canonical) AND "St.
// Pancras", "London Waterloo", "Waterloo East" (common aliases).
// Waterloo East is intentionally retained as a distinct alias even
// though it canonicalises to Waterloo — when the user sees "Waterloo
// East (+6m)" in a calling-points line, we want THAT exact text
// highlighted (not "Waterloo East" split into parts).
const LONDON_TERMINUS_FORMS: string[] = (() => {
  const forms = new Set<string>()
  // Farringdon is listed in london-terminals.json (it's a recognised
  // London-area stitching anchor for the stitcher) but it's a
  // through-station, NOT a true terminus. User's highlight feature
  // targets true termini only, so skip it here.
  const NOT_A_TERMINUS = new Set(["Farringdon"])
  for (const t of londonTerminalsData as Array<{ name: string; aliases: string[] }>) {
    if (NOT_A_TERMINUS.has(t.name)) continue
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
  const changeStations = legs.slice(0, -1).map((leg) => prettifyStationLabel(leg.arrivalStation))
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

/** Reset a textarea's height so it exactly fits its content (no scrollbar). */
function autoResize(el: HTMLTextAreaElement) {
  el.style.height = "auto"        // shrink first so scrollHeight recalculates
  el.style.height = `${el.scrollHeight}px`  // expand to fit content
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
  onRate,
  onExclude,
  isExcluded = false,
  approvedPhotos = [],
  rejectedIds = new Set(),
  onApprovePhoto,
  onRejectPhoto,
  onUnapprovePhoto,
  onMovePhoto,
  publicNote = "",
  privateNote = "",
  ramblerNote = "",
  onSaveNotes,
  journeys,
  friendOrigin,
  primaryOrigin = "Farringdon",
  isFriendOrigin = false,
  isPrimaryOrigin = false,
  isSynthetic = false,
  stationCrs,
  adminMode = false,
  isLondonHome = false,
  hasIssue = false,
  onToggleIssue,
}: StationModalProps) {
  // allPhotos = full buffer from Flickr (more than we display, for replacements)
  const [allPhotos, setAllPhotos] = useState<FlickrPhoto[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const hasApiKey = Boolean(process.env.NEXT_PUBLIC_FLICKR_API_KEY)

  // Dev-only: suppress the automatic Flickr fetch on modal open. In
  // production this is a no-op (photosLoadRequested starts true →
  // fetch runs immediately, same as before). On `npm run dev`, a
  // "Load photos" button appears where the grid would be; clicking
  // flips the flag and kicks off the usual fetch. Purpose: stop
  // burning Flickr API quota while iterating on UI locally.
  //
  // process.env.NODE_ENV is replaced at build time by Next.js, so
  // `isLocalDev` becomes a literal `false` in the prod bundle —
  // the button branch is tree-shaken out, zero runtime cost.
  const isLocalDev = process.env.NODE_ENV === "development"
  const [photosLoadRequested, setPhotosLoadRequested] = useState(!isLocalDev)
  // Reset the request flag whenever the modal opens for a new station
  // (dev only). Prod renders this effect as a no-op — setState with
  // the same value doesn't re-render.
  useEffect(() => {
    if (isLocalDev) setPhotosLoadRequested(false)
  }, [open, lat, lng, isLocalDev])

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
  const [localRamblerNote, setLocalRamblerNote] = useState(ramblerNote)
  // Per-note "is the admin currently editing?" flags. Default false so
  // admins see the same formatted render a regular user does, and click
  // into a note to enter edit mode. Blur (click-away) returns to view.
  // Reset when a new station opens so each modal starts in view mode.
  const [isEditingPublic, setIsEditingPublic] = useState(false)
  const [isEditingRambler, setIsEditingRambler] = useState(false)
  const [isEditingPrivate, setIsEditingPrivate] = useState(false)
  useEffect(() => {
    if (open) {
      setLocalPublicNote(publicNote)
      setLocalPrivateNote(privateNote)
      setLocalRamblerNote(ramblerNote)
      setIsEditingPublic(false)
      setIsEditingRambler(false)
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
    // Save notes if anything changed (fire-and-forget — optimistic update in parent)
    if (
      onSaveNotes &&
      (localPublicNote !== publicNote ||
        localPrivateNote !== privateNote ||
        localRamblerNote !== ramblerNote)
    ) {
      onSaveNotes(localPublicNote, localPrivateNote, localRamblerNote)
    }
    setIsClosing(true)
    closingTimer.current = setTimeout(() => {
      setIsClosing(false)
      onClose()
    }, ANIM_DURATION * 0.65)
  }, [isClosing, onClose, onSaveNotes, localPublicNote, localPrivateNote, localRamblerNote, publicNote, privateNote, ramblerNote])

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

  // How many Flickr photos to display (approved photos are added on top)
  const DISPLAY_COUNT = 30

  // Snapshot fetch parameters at dialog-open time so that approving/rejecting
  // photos during this session doesn't trigger re-fetches (which cause scroll jumps).
  // The broader tag set and extra buffer pages only kick in the *next* time the overlay opens.
  const hasCurationsRef = useRef(false)
  const rejectedCountRef = useRef(0)
  // Snapshot whether this station uses the urban (origin-style) photo set —
  // changing it mid-session shouldn't re-fetch with different params until
  // the overlay is re-opened.
  const isOriginRef = useRef(false)
  // Snapshot of approved photo IDs at open time — photos approved *before* this
  // session get promoted to the top; photos approved *during* this session stay
  // in their original grid position so the layout doesn't shift.
  const initialApprovedIdsRef = useRef<Set<string>>(new Set())

  // Tracks which station's photos are currently in `allPhotos` — used to decide
  // whether opening the overlay is for a NEW station (reset + show skeleton) or
  // the SAME station being re-opened (keep existing photos, refetch silently).
  const lastFetchKeyRef = useRef<string | null>(null)

  // Capture fetch parameters each time the dialog opens (not on every edit)
  useEffect(() => {
    if (open) {
      hasCurationsRef.current = approvedPhotos.length > 0 || rejectedIds.size > 0
      rejectedCountRef.current = rejectedIds.size
      // Friend AND primary origins use the origin-specific Flickr algorithm
      // (smaller radius, different tag set, urban rather than rural).
      isOriginRef.current = isFriendOrigin || isPrimaryOrigin
      initialApprovedIdsRef.current = new Set(approvedPhotos.map((p) => p.id))
    }
    // Only re-run when the dialog opens, not when approvedPhotos/rejectedIds change
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, lat, lng])

  // Fetch photos when the dialog opens. Approvals/rejections during the session
  // are handled at display time by filtering allPhotos (no re-fetch, preserves scroll).
  //
  // IMPORTANT: when the target station changes, we reset allPhotos and flip loading=true
  // SYNCHRONOUSLY with kicking off the fetch. This matters because otherwise the "No
  // photos found" text flashes during the render gap — stale allPhotos gets cleared
  // but loading hasn't flipped yet, so the empty-state branch renders briefly.
  useEffect(() => {
    // Extra gate: in dev, wait for the user to click the "Load photos"
    // button before firing the fetch. In prod, photosLoadRequested is
    // always true so this behaves exactly like before.
    if (!open || !hasApiKey || !photosLoadRequested) return

    const key = `${lat},${lng}`
    const isNewStation = lastFetchKeyRef.current !== key

    // New station: show skeleton immediately. Same station re-opened: keep current
    // photos visible and refresh silently in the background.
    if (isNewStation) {
      setAllPhotos([])
      setLoading(true)
    }
    setError(null)

    console.log(`[photos] fetching: hasCurations=${hasCurationsRef.current}, rejectedCount=${rejectedCountRef.current}, approvedCount=${approvedPhotos.length}`)
    fetchPhotosViaProxy(lat, lng, hasCurationsRef.current, rejectedCountRef.current, isOriginRef.current)
      .then((result) => {
        console.log(`[photos] fetched ${result.length} photos from Flickr`)
        setAllPhotos(result)
        lastFetchKeyRef.current = key
      })
      .catch((err) => {
        console.error('[photos] fetch error:', err)
        setError("Couldn't load photos. Try again later.")
      })
      .finally(() => setLoading(false))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, hasApiKey, lat, lng, photosLoadRequested])

  // Build the display list. Photos approved *before* this session are promoted
  // to the top. Photos approved *during* this session stay in their original
  // grid position (just get the badge) so the layout doesn't jump around.
  const approvedIds = new Set(approvedPhotos.map((p) => p.id))
  // Photos that were already approved when the dialog opened — shown at the top
  const preApproved = approvedPhotos.filter((p) => initialApprovedIdsRef.current.has(p.id))
  // Flickr results minus rejected and pre-approved (newly approved stay in place)
  const flickrOnly = allPhotos.filter((p) => !initialApprovedIdsRef.current.has(p.id) && !rejectedIds.has(p.id))
  const photos = [...preApproved, ...flickrOnly.slice(0, DISPLAY_COUNT)]

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
          <DialogTitle className="text-2xl sm:text-3xl">
            {adminMode && stationCrs ? `${stationCrs} ` : ""}{stationName}{isSynthetic ? "" : " Station"}
          </DialogTitle>
          {/* Desktop-only Hike button. Hidden for friend/primary origins
              (they don't get a Hike action). min-w-0 isn't needed on the
              title because the button has shrink-0 and the row has gap. */}
          {!isFriendOrigin && !isPrimaryOrigin && (
            <Button asChild className="hidden sm:inline-flex shrink-0">
              <a
                href={komootUrl(stationName, lat, lng)}
                target="_blank"
                rel="noopener noreferrer"
              >
                <HugeiconsIcon icon={MapingIcon} />
                Hikes from station
              </a>
            </Button>
          )}
        </div>

        {/* ── Scroll region (desktop) ──
            On desktop, body text + photos share a single scroll area beneath
            the title row. Everything below this wrapper scrolls together.
            Only the title row (above) stays pinned at the top of the modal.
            On mobile, the outer DialogContent is the scroll container (see
            max-sm:overflow-y-auto up there), so this wrapper reverts to
            flex-none + overflow-visible and content flows inline. */}
        <div className="min-h-0 flex-1 overflow-y-auto max-sm:flex-none max-sm:overflow-visible">
        {/* gap-0 override: shadcn's DialogHeader defaults to flex-col
            gap-2, which stacks flex-gap on top of the explicit mt-*
            margins on each child (alts, subheaders, notes). Letting
            both apply made the alt paragraphs look ~14px apart while
            the notes div — which isn't a flex container — rendered
            at the intended 4px. Killing the gap here means every
            child's mt-[var(--para-gap)] (or mt-[calc…]) alone
            controls its spacing, so alts and notes match. */}
        <DialogHeader className="shrink-0 px-6 pt-0 pb-0 gap-0">
          {!isFriendOrigin && !isPrimaryOrigin && (
            <>
              {/* Primary journey info — ALWAYS full width now (both desktop
                  and mobile). The Hike button has moved up into the title
                  row, freeing this paragraph to use the overlay's full width.
                  [overflow-wrap:anywhere] on the outer <p> so long station names (e.g.
                  "Stratford International" in the change list) always wrap
                  within the dialog's content-box — the span-nested hint line
                  has its own [overflow-wrap:anywhere], but the main line's text lives
                  directly inside DialogDescription so it needs the class
                  here too. */}
              <DialogDescription className="text-sm [overflow-wrap:anywhere]">
                {highlightTermini(
                  journeys?.[primaryOrigin]
                    ? singleOriginDescription(primaryOrigin, journeys[primaryOrigin])
                    // No pre-stored journey for this primary → happens for
                    // custom primaries (any NR station picked via the search
                    // bar — e.g. Kentish Town). Fall back to the primary's
                    // own name so the narrative reads "X from Kentish Town."
                    // rather than "from central London" (which was misleading
                    // when the user had explicitly chosen a non-London origin).
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

              {/* Friend journey info — full width, separate row below
                  the home journey. Rendered ABOVE the Alternative
                  routes block so the narrative reads: home journey →
                  friend journey → alts-from-home (with "from London"
                  disambiguation suffix on the subheader when friend
                  is visible). mt uses --para-gap for consistent
                  rhythm with everything else. */}
              {friendOrigin && journeys?.[friendOrigin] && (
                <p className="mt-[var(--para-gap)] text-sm">
                  {highlightTermini(
                    singleOriginDescription(friendOrigin, journeys[friendOrigin]),
                    isLondonHome,
                    // Friend origin always extraBold so it stands out
                    // from the home journey paragraph above. Termini
                    // in the friend's path still get the muted +
                    // medium treatment when home is Central London.
                    [friendOrigin],
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
                          ? "Alternative routes from London"
                          : "Alternative routes"}
                      </p>
                    )}
                    {alts.map(renderAlt)}
                  </>
                )
              })()}

            </>
          )}

          {/* ── Notes: full-width, below the title/button row ── */}

          {/* "Notes" subheader — same treatment as the "Alternative
              routes" subheader. Top margin scales with --para-gap
              (3×) so tuning that single var retunes both subheaders
              in lockstep. Appears above the public note whenever a
              note is being shown; admin mode always has the textarea
              visible, so the gate includes devMode to label the empty
              textarea too. */}
          {(devMode || localPublicNote) && (
            <p className="mt-[calc(var(--para-gap)*3)] text-xs font-medium text-muted-foreground">
              {/* Singular when exactly one paragraph of content,
                  plural otherwise (including the admin empty state). */}
              Trains to Green recommendation{localPublicNote.split(/\n+/).filter(Boolean).length === 1 ? "" : "s"}
            </p>
          )}

          {/* Public note — three render paths:
               (a) devMode + editing → textarea with autoFocus, exits on blur.
               (b) note has content → rendered markdown view; in devMode the
                   wrapper is click-to-edit.
               (c) devMode + empty + not editing → "Click to add" placeholder.
               Non-admin with empty note: renders nothing (as before).

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
            <div
              className={`mt-[var(--para-gap)] text-sm text-foreground [&>p+p]:mt-[var(--para-gap)] ${devMode ? "cursor-text rounded-md hover:bg-muted/40 px-3 py-2 -mx-3" : ""}`}
              onClick={devMode ? () => setIsEditingPublic(true) : undefined}
              role={devMode ? "button" : undefined}
              tabIndex={devMode ? 0 : undefined}
              onKeyDown={devMode ? (e) => { if (e.key === "Enter") { e.preventDefault(); setIsEditingPublic(true) } } : undefined}
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

          {/* ── Rambler recommendations: same format/behaviour as the
              Trains to Green recommendations block above — subheader gated on
              devMode || content so non-admins never see an empty
              label, admins always do so they know where to type. */}
          {(devMode || localRamblerNote) && (
            <p className="mt-[calc(var(--para-gap)*3)] text-xs font-medium text-muted-foreground">
              Rambler recommendation{localRamblerNote.split(/\n+/).filter(Boolean).length === 1 ? "" : "s"}
            </p>
          )}

          {/* Rambler note — same three-path render as the public note above
              (edit textarea / formatted view / empty placeholder). */}
          {devMode && isEditingRambler ? (
            <textarea
              ref={(el) => { if (el) autoResize(el) }}
              value={localRamblerNote}
              onChange={(e) => {
                setLocalRamblerNote(e.target.value)
                autoResize(e.target)
              }}
              onBlur={() => setIsEditingRambler(false)}
              autoFocus
              placeholder="Rambler recommendations..."
              className="mt-[var(--para-gap)] w-full resize-none overflow-hidden rounded-md border border-border bg-background px-3 py-2 text-sm text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-ring"
              rows={2}
            />
          ) : localRamblerNote ? (
            <div
              className={`mt-[var(--para-gap)] text-sm text-foreground [&>p+p]:mt-[var(--para-gap)] ${devMode ? "cursor-text rounded-md hover:bg-muted/40 px-3 py-2 -mx-3" : ""}`}
              onClick={devMode ? () => setIsEditingRambler(true) : undefined}
              role={devMode ? "button" : undefined}
              tabIndex={devMode ? 0 : undefined}
              onKeyDown={devMode ? (e) => { if (e.key === "Enter") { e.preventDefault(); setIsEditingRambler(true) } } : undefined}
            >
              {localRamblerNote.split(/\n+/).filter(Boolean).map((para, i) => (
                <p key={i}>{renderWithLinks(para)}</p>
              ))}
            </div>
          ) : devMode ? (
            <button
              type="button"
              onClick={() => setIsEditingRambler(true)}
              className="mt-[var(--para-gap)] w-full cursor-text rounded-md border border-dashed border-border px-3 py-2 text-left text-sm italic text-muted-foreground hover:bg-muted/40"
            >
              Click to add Rambler recommendations…
            </button>
          ) : null}

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
          {!isFriendOrigin && !isPrimaryOrigin && (
            <Button asChild className="mt-[calc(var(--para-gap)*4)] w-full sm:hidden">
              <a
                href={komootUrl(stationName, lat, lng)}
                target="_blank"
                rel="noopener noreferrer"
              >
                <HugeiconsIcon icon={MapingIcon} />
                Hikes from station
              </a>
            </Button>
          )}
        </DialogHeader>

        {/* ── Dev tools: rating buttons + delete ── */}
        {devMode && (
          <div className="shrink-0 border-t px-6 py-3">
            <div className="flex items-center gap-1.5">
              {/* Exclude toggle — active (primary-green plus) when the station is currently excluded.
                  St George-style "+" cross matches the map marker for excluded stations. */}
              <DevActionButton
                label={isExcluded ? "Un-exclude" : "Exclude"}
                active={isExcluded}
                onClick={() => onExclude?.()}
                icon={
                  /* Latin/grave cross — horizontal raised to read as a headstone */
                  <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none"
                    stroke={isExcluded ? 'var(--primary)' : 'currentColor'}
                    strokeWidth="3" strokeLinecap="butt">
                    <line x1="4" y1="9" x2="20" y2="9" />
                    <line x1="12" y1="4" x2="12" y2="20" />
                  </svg>
                }
              />

              {/* Approve home→destination pair — admin-only journey
                  testing flag. Hidden for excluded stations (they keep
                  their normal colour in admin mode and don't participate
                  in the approval workflow). Only rendered when a toggle
                  handler is wired (map.tsx passes one whenever the
                  station is a normal destination). Active = approved
                  (green check). */}
              {/* Issue flag — admin-only. Visible for every station (including
                  excluded ones) so admins can triage without needing to
                  un-exclude first. Active (highlighted) = "has issue".
                  Station-global: toggling affects this station under every
                  primary, not just the current home. */}
              {onToggleIssue && (
                <DevActionButton
                  label={hasIssue ? "Clear issue" : "Flag issue"}
                  active={hasIssue}
                  onClick={() => onToggleIssue(!hasIssue)}
                  icon={
                    /* Exclamation mark — highlighted primary when flagged,
                       grey outline when clear. Built from two rounded-cap
                       line segments so the dot below the stem reads as a
                       small disc (strokeLinecap="round" + a 0.01-long
                       line = a disc of radius strokeWidth/2). */
                    <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none"
                      stroke={hasIssue ? 'var(--primary)' : 'currentColor'}
                      strokeWidth="3" strokeLinecap="round" strokeLinejoin="round">
                      <line x1="12" y1="4" x2="12" y2="14" />
                      <line x1="12" y1="19" x2="12" y2="19.01" />
                    </svg>
                  }
                />
              )}

              {/* Thin vertical separator between delete and rating buttons */}
              <div className="mx-1 h-6 w-px bg-border" />

              {/* Highlight — star, full green */}
              <DevActionButton
                label="Highlight"
                active={currentRating === 'highlight'}
                onClick={() => onRate?.(currentRating === 'highlight' ? null : 'highlight')}
                icon={
                  <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24"
                    fill={currentRating === 'highlight' ? 'var(--primary)' : 'none'}
                    stroke={currentRating === 'highlight' ? 'var(--primary)' : 'currentColor'}
                    strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2" />
                  </svg>
                }
              />

              {/* Verified recommendation — triangle-up, full green */}
              <DevActionButton
                label="Verified"
                active={currentRating === 'verified'}
                onClick={() => onRate?.(currentRating === 'verified' ? null : 'verified')}
                icon={
                  <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24"
                    fill={currentRating === 'verified' ? 'var(--primary)' : 'none'}
                    stroke={currentRating === 'verified' ? 'var(--primary)' : 'currentColor'}
                    strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    {/* Equilateral triangle pointing up */}
                    <polygon points="12 3, 22.39 21, 1.61 21" />
                  </svg>
                }
              />

              {/* Probably (unverified) — hexagon, grey-green. Shape matches the
                  filter panel's "Probably" icon for design-system consistency. */}
              <DevActionButton
                label="Probably"
                active={currentRating === 'unverified'}
                onClick={() => onRate?.(currentRating === 'unverified' ? null : 'unverified')}
                icon={
                  <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="1 2 22 20"
                    fill={currentRating === 'unverified' ? '#aed0b8' : 'none'}
                    stroke={currentRating === 'unverified' ? '#aed0b8' : 'currentColor'}
                    strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    {/* Hexagon — same 6 vertices as filter-panel.tsx */}
                    <polygon points="22,12 17,20.66 7,20.66 2,12 7,3.34 17,3.34" />
                  </svg>
                }
              />

              {/* Not recommended — triangle-down, grey-green */}
              <DevActionButton
                label="Not recommended"
                active={currentRating === 'not-recommended'}
                onClick={() => onRate?.(currentRating === 'not-recommended' ? null : 'not-recommended')}
                icon={
                  <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24"
                    fill={currentRating === 'not-recommended' ? '#aed0b8' : 'none'}
                    stroke={currentRating === 'not-recommended' ? '#aed0b8' : 'currentColor'}
                    strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    {/* Equilateral triangle pointing down */}
                    <polygon points="12 21, 22.39 3, 1.61 3" />
                  </svg>
                }
              />

              {/* Unrated — circle, grey-green (clears any existing rating) */}
              <DevActionButton
                label="Unrated"
                active={currentRating === null}
                onClick={() => onRate?.(null)}
                icon={
                  <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24"
                    fill={currentRating === null ? '#aed0b8' : 'none'}
                    stroke={currentRating === null ? '#aed0b8' : 'currentColor'}
                    strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <circle cx="12" cy="12" r="9" />
                  </svg>
                }
              />
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

          {/* Dev-only "Load photos" button. Rendered where the grid
              would be so the user can request photos explicitly
              rather than triggering an auto-fetch on every modal
              open (saves Flickr API quota during local testing).
              In prod, isLocalDev is compiled to `false` and this
              entire branch is dead code. */}
          {hasApiKey && isLocalDev && !photosLoadRequested && (
            <div className="flex items-center justify-center rounded-lg bg-muted px-4 py-12">
              <button
                type="button"
                onClick={() => setPhotosLoadRequested(true)}
                // Matching shadcn Button's outline-variant vibe but
                // inlined so we don't pull in another import for a
                // dev-only widget. cursor-pointer is explicit because
                // buttons without it feel unresponsive to mouse users.
                className="cursor-pointer rounded-md border border-input bg-background px-4 py-2 text-sm font-medium shadow-sm transition-colors hover:bg-accent hover:text-accent-foreground"
              >
                Load photos
              </button>
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

          {/* No photos found — gated on photosLoadRequested so dev
              users don't see "no photos" before clicking the button. */}
          {hasApiKey && photosLoadRequested && !loading && !error && allPhotos.length === 0 && photos.length === 0 && (
            <p className="text-sm text-muted-foreground">
              No hiking photos found near this station on Flickr.
            </p>
          )}

          {/* Photo grid — 2 cols → 3 → 4. Trim to a multiple of 12 (LCM of 2,3,4)
              so the last row is always full at every breakpoint. */}
          {hasApiKey && !loading && photos.length > 0 && (
            <>
              <div className="grid grid-cols-1 gap-2 sm:grid-cols-2 sm:gap-4 lg:grid-cols-3 max-sm:-mx-6">
                {/* Trim to a multiple of 6 (LCM of 1,2,3) so the last row is always full */}
                {photos.slice(0, Math.floor(photos.length / 6) * 6 || 6).map((photo) => {
                  const approvedIndex = approvedPhotos.findIndex((p) => p.id === photo.id)
                  return (
                  <PhotoCard
                    key={photo.id}
                    photo={photo}
                    devMode={devMode}
                    isApproved={approvedIds.has(photo.id)}
                    onApprove={() => onApprovePhoto?.(photo)}
                    onReject={() => onRejectPhoto?.(photo.id)}
                    onUnapprove={() => onUnapprovePhoto?.(photo.id)}
                    onMoveToTop={() => onMovePhoto?.(photo.id, "top")}
                    onMoveUp={() => onMovePhoto?.(photo.id, "up")}
                    onMoveDown={() => onMovePhoto?.(photo.id, "down")}
                    canMoveUp={approvedIndex > 0}
                    canMoveDown={approvedIndex >= 0 && approvedIndex < approvedPhotos.length - 1}
                  />
                  )
                })}
              </div>

              {/* "X photos" link — shown below the grid if we have a count */}
              {flickrCount != null && flickrCount > 0 && (
                <p className="mt-4 text-center text-sm text-muted-foreground">
                  <a
                    href={`https://www.flickr.com/search/?tags=landscape&lat=${lat}&lon=${lng}&radius=7&sort=relevance`}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="underline underline-offset-2 hover:text-foreground"
                  >
                    View all photos
                  </a>
                </p>
              )}
            </>
          )}
        </div>
        </div>{/* /scroll region */}
      </DialogContent>
    </Dialog>
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
// In admin mode, hovering shows approve (✓) and reject (✕) icon buttons.
// Approved photos display a persistent tick badge in the top-right corner.

function PhotoCard({ photo, devMode, isApproved, onApprove, onReject, onUnapprove, onMoveToTop, onMoveUp, onMoveDown, canMoveUp, canMoveDown }: {
  photo: FlickrPhoto
  devMode: boolean
  isApproved: boolean
  onApprove: () => void
  onReject: () => void
  onUnapprove: () => void
  onMoveToTop?: () => void
  onMoveUp?: () => void
  onMoveDown?: () => void
  canMoveUp?: boolean
  canMoveDown?: boolean
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
        {/* Landscape-ratio photo — object-cover fills the box without distortion */}
        <img
          src={photo.largeUrl ?? photo.thumbnailUrl}
          alt={photo.title}
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
          {/* Top-left cluster: approve / reject. Wrapper has no opacity classes — visibility is
              controlled per-button below so the approved-state approve button can override. */}
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
            {/* Reject button — standard hover-only-on-desktop behaviour regardless of approval state */}
            <button
              onClick={(e) => { e.stopPropagation(); onReject() }}
              title="Reject photo"
              className="flex h-7 w-7 items-center justify-center rounded-md bg-black/60 text-white backdrop-blur-sm transition-all duration-150 hover:bg-red-600/90 cursor-pointer opacity-100 md:opacity-0 md:group-hover:opacity-100"
            >
              <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24"
                fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                <line x1="18" y1="6" x2="6" y2="18" />
                <line x1="6" y1="6" x2="18" y2="18" />
              </svg>
            </button>
          </div>

          {/* Top-right cluster: reorder controls — only on approved photos */}
          {isApproved && (
            <div className="absolute top-0 right-0 flex gap-1 p-2 opacity-100 transition-opacity duration-150 md:opacity-0 md:group-hover:opacity-100">
              {/* Jump to top — double chevron icon */}
              <button
                onClick={(e) => { e.stopPropagation(); onMoveToTop?.() }}
                title="Move photo to top"
                disabled={!canMoveUp}
                className="flex h-7 w-7 items-center justify-center rounded-md bg-black/60 text-white backdrop-blur-sm transition-colors hover:bg-white/30 cursor-pointer disabled:opacity-30 disabled:cursor-default"
              >
                <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24"
                  fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                  <polyline points="18 11 12 5 6 11" />
                  <polyline points="18 19 12 13 6 19" />
                </svg>
              </button>
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
