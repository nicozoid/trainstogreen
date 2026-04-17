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
  /** True when this station is in the origin-stations list (admin-only) */
  isOrigin?: boolean
  /** Toggles this station's origin-station status (admin-only) */
  onToggleOrigin?: () => void
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
  /** Saves both notes when the overlay closes */
  onSaveNotes?: (publicNote: string, privateNote: string) => void
  /** Journey data keyed by origin station name (e.g. "Farringdon") */
  journeys?: Record<string, JourneyInfo>
  /** Friend origin station name — when set, shows dual journey info */
  friendOrigin?: string | null
  /** Which origin station is the primary (default "Farringdon", or "Stratford" via URL) */
  primaryOrigin?: string
  /** When true, this station is a friend origin — hides travel info and hike button */
  isFriendOrigin?: boolean
}

// Formats minutes as "Xh Ym" or "Xm"
function formatMinutes(minutes: number): string {
  if (minutes < 60) return `${minutes} minutes`
  const h = Math.floor(minutes / 60)
  const m = minutes % 60
  return m === 0 ? `${h} hour` : `${h} hour and ${m} minutes`
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

  if (changes === 0) return `${time} from ${displayOrigin}. Direct train.`

  // Pretty-print each intermediate station name so the rendered sentence
  // reads naturally (no curly apostrophes, no "(COV)" codes, no "International").
  const changeStations = legs.slice(0, -1).map((leg) => prettifyStationLabel(leg.arrivalStation))
  const changeList =
    changeStations.length <= 2
      ? changeStations.join(" and ")
      : changeStations.slice(0, -1).join(", ") + " and " + changeStations.at(-1)

  const changeNumber = ["Zero", "One", "Two", "Three", "Four", "Five"][changes] ?? String(changes)
  const changeWord = changes === 1 ? "change" : "changes"
  return `${time} from ${displayOrigin}. ${changeNumber} ${changeWord}: ${changeList}.`
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
function renderWithLinks(text: string) {
  // Match [link text](url) — the standard markdown link syntax
  const parts = text.split(/(\[[^\]]+\]\([^)]+\))/)
  return parts.map((part, i) => {
    const match = part.match(/^\[([^\]]+)\]\(([^)]+)\)$/)
    if (match) {
      return (
        <a
          key={i}
          href={match[2]}
          target="_blank"
          rel="noopener noreferrer"
          className="underline text-primary hover:text-primary/80"
        >
          {match[1]}
        </a>
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
  isOrigin = false,
  onToggleOrigin,
  approvedPhotos = [],
  rejectedIds = new Set(),
  onApprovePhoto,
  onRejectPhoto,
  onUnapprovePhoto,
  onMovePhoto,
  publicNote = "",
  privateNote = "",
  onSaveNotes,
  journeys,
  friendOrigin,
  primaryOrigin = "Farringdon",
  isFriendOrigin = false,
}: StationModalProps) {
  // allPhotos = full buffer from Flickr (more than we display, for replacements)
  const [allPhotos, setAllPhotos] = useState<FlickrPhoto[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const hasApiKey = Boolean(process.env.NEXT_PUBLIC_FLICKR_API_KEY)

  // ── Local note editing state — synced from props when a new station opens ──
  const [localPublicNote, setLocalPublicNote] = useState(publicNote)
  const [localPrivateNote, setLocalPrivateNote] = useState(privateNote)
  useEffect(() => {
    if (open) {
      setLocalPublicNote(publicNote)
      setLocalPrivateNote(privateNote)
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
    if (onSaveNotes && (localPublicNote !== publicNote || localPrivateNote !== privateNote)) {
      onSaveNotes(localPublicNote, localPrivateNote)
    }
    setIsClosing(true)
    closingTimer.current = setTimeout(() => {
      setIsClosing(false)
      onClose()
    }, ANIM_DURATION * 0.65)
  }, [isClosing, onClose, onSaveNotes, localPublicNote, localPrivateNote, publicNote, privateNote])

  // How many Flickr photos to display (approved photos are added on top)
  const DISPLAY_COUNT = 30

  // Snapshot fetch parameters at dialog-open time so that approving/rejecting
  // photos during this session doesn't trigger re-fetches (which cause scroll jumps).
  // The broader tag set and extra buffer pages only kick in the *next* time the overlay opens.
  const hasCurationsRef = useRef(false)
  const rejectedCountRef = useRef(0)
  // Snapshot isOrigin too — changing the station's origin status mid-session
  // shouldn't re-fetch with different params until the overlay is re-opened.
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
      isOriginRef.current = isOrigin
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
    if (!open || !hasApiKey) return

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
  }, [open, hasApiKey, lat, lng])

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
        style={animationStyle}
        overlayStyle={isClosing ? {
          animation: "exit 300ms ease forwards",
          "--tw-exit-opacity": "0",
        } as React.CSSProperties : undefined}
        className="flex h-[92dvh] w-[94dvw] max-w-none sm:max-w-none flex-col overflow-hidden p-0 max-sm:top-auto max-sm:right-0 max-sm:bottom-0 max-sm:left-0 max-sm:h-[92dvh] max-sm:w-full max-sm:translate-x-0 max-sm:translate-y-0 max-sm:rounded-t-2xl max-sm:rounded-b-none">

        {/* ── Header: station info left, Komoot button right ── */}
        <DialogHeader className="shrink-0 px-6 pt-6 pb-0">
          {/* On mobile: single column stack. On sm+: row with title/subtitle left, button right. */}
          <div id="TEXT_BTN_CONTAINER" className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between sm:gap-5">

            {/* Left group: title + description stacked together */}
            <div id="STATION-NAME_DESCRIPTION" className="flex flex-col gap-2">
              <DialogTitle className="text-2xl sm:text-3xl">
                {stationName} Station
              </DialogTitle>
              {/* Friend origin stations don't show travel time — they're not hiking destinations */}
              {!isFriendOrigin && (
                <>
                  {/* Primary origin journey info */}
                  <DialogDescription className="text-sm">
                    {journeys?.[primaryOrigin]
                      ? singleOriginDescription(primaryOrigin, journeys[primaryOrigin])
                      : `${formatMinutes(minutes)} from central London.`}
                  </DialogDescription>
                  {/* Friend origin journey info — separate paragraph underneath */}
                  {friendOrigin && journeys?.[friendOrigin] && (
                    <p className="text-sm">
                      {singleOriginDescription(friendOrigin, journeys[friendOrigin])}
                    </p>
                  )}
                </>
              )}
            </div>

            {/* Hike button hidden for friend origin stations — not relevant for origin points */}
            {!isFriendOrigin && (
              <Button asChild className="max-sm:w-full">
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

          {/* ── Notes: full-width, below the title/button row ── */}

          {/* Public note: editable textarea in admin mode, plain text for everyone else */}
          {devMode ? (
            <textarea
              ref={(el) => { if (el) autoResize(el) }}
              value={localPublicNote}
              onChange={(e) => {
                setLocalPublicNote(e.target.value)
                autoResize(e.target)
              }}
              placeholder="Public notes..."
              className="mt-1 w-full resize-none overflow-hidden rounded-md border border-border bg-background px-3 py-2 text-sm text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-ring"
              rows={2}
            />
          ) : (
            /* Only render the paragraph when there's something to show */
            localPublicNote && (
              <p className="text-sm text-foreground">{renderWithLinks(localPublicNote)}</p>
            )
          )}

          {/* Private note: only visible in admin mode, always as a textarea */}
          {devMode && (
            <textarea
              ref={(el) => { if (el) autoResize(el) }}
              value={localPrivateNote}
              onChange={(e) => {
                setLocalPrivateNote(e.target.value)
                autoResize(e.target)
              }}
              placeholder="Private notes (admin only)..."
              className="w-full resize-none overflow-hidden rounded-md border border-dashed border-orange-400 bg-orange-50 px-3 py-2 text-sm text-foreground placeholder:text-muted-foreground/60 focus:outline-none focus:ring-1 focus:ring-orange-400 dark:bg-orange-950/20"
              rows={2}
            />
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

              {/* Toggle origin — adds/removes this station from the origin-stations list.
                  Active (filled green square) when the station is already an origin. */}
              <DevActionButton
                label={isOrigin ? "Unmark as origin" : "Mark as origin"}
                active={isOrigin}
                onClick={() => onToggleOrigin?.()}
                icon={
                  /* Square — matches the square glyph origin stations use on the map */
                  <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24"
                    fill={isOrigin ? 'var(--primary)' : 'none'}
                    stroke={isOrigin ? 'var(--primary)' : 'currentColor'}
                    strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <rect x="4" y="4" width="16" height="16" />
                  </svg>
                }
              />

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

        {/* ── Scrollable photo area ── */}
        <div className="min-h-0 flex-1 overflow-y-auto px-6 pb-6 pt-">

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

          {/* Loading skeleton — grid of shimmering rectangles matching the photo grid layout. */}
          {hasApiKey && loading && (
            <div className="grid grid-cols-1 gap-2 sm:grid-cols-2 sm:gap-4 lg:grid-cols-3 max-sm:-mx-6">
              {Array.from({ length: 9 }).map((_, i) => (
                <div
                  key={i}
                  /* bg-muted-foreground/20 is a clearly visible medium grey — much more contrast
                     than bg-muted (near-white) so the shimmer sweep is obvious on bright screens */
                  className="relative overflow-hidden aspect-[4/3] rounded-none sm:rounded-lg bg-muted-foreground/20"
                >
                  {/* via-white/80 is a very bright sweep — high contrast against the darker base.
                      staggered animationDelay creates a cascading wave down the list. */}
                  <div
                    className="absolute inset-0 -translate-x-full animate-shimmer bg-gradient-to-r from-transparent via-white/80 to-transparent"
                    style={{ animationDelay: `${(i * 0.12) - 0.8}s` }}
                  />
                </div>
              ))}
            </div>
          )}

          {/* Error */}
          {hasApiKey && !loading && error && (
            <p className="text-sm text-destructive">{error}</p>
          )}

          {/* No photos found */}
          {hasApiKey && !loading && !error && allPhotos.length === 0 && photos.length === 0 && (
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

      {/* Approved badge — clickable to un-approve (admin only, always visible) */}
      {devMode && isApproved && (
        <button
          onClick={(e) => { e.stopPropagation(); onUnapprove() }}
          title="Remove approval"
          className="absolute top-2 right-2 flex h-6 w-6 items-center justify-center rounded-full bg-black/30 shadow-sm cursor-pointer hover:bg-black/50 transition-colors"
        >
          <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24"
            fill="none" stroke="white" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" opacity="0.6">
            <polyline points="20 6 9 17 4 12" />
          </svg>
        </button>
      )}

      {/* Admin hover actions — approve and reject buttons, top-left so they don't overlap the attribution */}
      {devMode && (
        <div className="absolute top-0 left-0 flex gap-1 p-2 opacity-0 transition-opacity duration-150 group-hover:opacity-100">
          {/* Approve button */}
          <button
            onClick={(e) => { e.stopPropagation(); onApprove() }}
            title="Approve photo"
            className="flex h-7 w-7 items-center justify-center rounded-md bg-black/60 text-white backdrop-blur-sm transition-colors hover:bg-emerald-600/90 cursor-pointer"
          >
            <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24"
              fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
              <polyline points="20 6 9 17 4 12" />
            </svg>
          </button>
          {/* Reject button */}
          <button
            onClick={(e) => { e.stopPropagation(); onReject() }}
            title="Reject photo"
            className="flex h-7 w-7 items-center justify-center rounded-md bg-black/60 text-white backdrop-blur-sm transition-colors hover:bg-red-600/90 cursor-pointer"
          >
            <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24"
              fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
              <line x1="18" y1="6" x2="6" y2="18" />
              <line x1="6" y1="6" x2="18" y2="18" />
            </svg>
          </button>
          {/* Reorder — only shown on approved photos (reordering the curated set) */}
          {isApproved && (
            <>
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
            </>
          )}
        </div>
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
