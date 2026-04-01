// StationModal — full-viewport modal showing station info + Flickr photo grid.
//
// Opens when a station dot is clicked on the map. Dismissed by clicking the
// overlay backdrop or the close button (both handled by Radix Dialog).
//
// Photos are fetched lazily on first open, same as before.

"use client"

import { useEffect, useRef, useState } from "react"
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog"
import { fetchFlickrPhotos, type FlickrPhoto } from "@/lib/flickr"
import { Button } from "@/components/ui/button"
import { HugeiconsIcon } from "@hugeicons/react"
import { Cancel01Icon, MapingIcon } from "@hugeicons/core-free-icons"

export type { FlickrPhoto }

type Rating = 'highlight' | 'verified' | 'unverified' | 'not-recommended'

type StationModalProps = {
  open: boolean
  onClose: () => void
  lat: number
  lng: number
  stationName: string
  minutes: number
  flickrCount: number | null
  /** When true, the dev tools section is shown in the modal */
  devMode?: boolean
  /** The station's current universal rating, or null if unrated */
  currentRating?: Rating | null
  /** Sets or clears the station's rating — null means "unrated" */
  onRate?: (rating: Rating | null) => void
  /** Excludes (deletes) the station */
  onExclude?: () => void
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
}

// Formats minutes as "Xh Ym" or "Xm"
function formatMinutes(minutes: number): string {
  if (minutes < 60) return `${minutes} minutes`
  const h = Math.floor(minutes / 60)
  const m = minutes % 60
  return m === 0 ? `${h} hour` : `${h} hour and ${m} minutes`
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
    `&max_distance=5000&pageNumber=1`
  )
}

export default function StationModal({
  open,
  onClose,
  lat,
  lng,
  stationName,
  minutes,
  flickrCount,
  devMode = false,
  currentRating = null,
  onRate,
  onExclude,
  approvedPhotos = [],
  rejectedIds = new Set(),
  onApprovePhoto,
  onRejectPhoto,
  onUnapprovePhoto,
}: StationModalProps) {
  // allPhotos = full buffer from Flickr (more than we display, for replacements)
  const [allPhotos, setAllPhotos] = useState<FlickrPhoto[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const hasApiKey = Boolean(process.env.NEXT_PUBLIC_FLICKR_API_KEY)

  // How many Flickr photos to display (approved photos are added on top)
  const DISPLAY_COUNT = 30

  // Snapshot fetch parameters at dialog-open time so that approving/rejecting
  // photos during this session doesn't trigger re-fetches (which cause scroll jumps).
  // The broader tag set and extra buffer pages only kick in the *next* time the overlay opens.
  const hasCurationsRef = useRef(false)
  const rejectedCountRef = useRef(0)
  // Snapshot of approved photo IDs at open time — photos approved *before* this
  // session get promoted to the top; photos approved *during* this session stay
  // in their original grid position so the layout doesn't shift.
  const initialApprovedIdsRef = useRef<Set<string>>(new Set())

  // Reset when a different station is selected
  useEffect(() => {
    setAllPhotos([])
  }, [lat, lng])

  // Capture fetch parameters each time the dialog opens (not on every edit)
  useEffect(() => {
    if (open) {
      hasCurationsRef.current = approvedPhotos.length > 0 || rejectedIds.size > 0
      rejectedCountRef.current = rejectedIds.size
      initialApprovedIdsRef.current = new Set(approvedPhotos.map((p) => p.id))
    }
    // Only re-run when the dialog opens, not when approvedPhotos/rejectedIds change
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, lat, lng])

  // Fetch photos once when the dialog opens. No re-fetches during the session —
  // approvals/rejections are handled at display time by filtering allPhotos,
  // so scroll position is preserved. Updated counts take effect on next open.
  useEffect(() => {
    if (!open || !hasApiKey) return

    // Only show the loading skeleton on the very first fetch for this station
    if (allPhotos.length === 0) setLoading(true)
    setError(null)

    console.log(`[photos] fetching: hasCurations=${hasCurationsRef.current}, rejectedCount=${rejectedCountRef.current}, approvedCount=${approvedPhotos.length}`)
    fetchFlickrPhotos(lat, lng, hasCurationsRef.current, rejectedCountRef.current)
      .then((result) => {
        console.log(`[photos] fetched ${result.length} photos from Flickr`)
        setAllPhotos(result)
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

  return (
    // onOpenChange fires on overlay click or Escape — close the modal
    <Dialog open={open} onOpenChange={(v) => { if (!v) onClose() }}>
      {/* Large modal: 5xl width, up to 90% viewport height */}
      {/* w/h use dvw/dvh so the modal scales with the viewport on any screen size.
          sm:max-w-none overrides the sm:max-w-md baked into DialogContent's base styles. */}
      {/* max-sm: overrides make the modal fullscreen on small viewports (no margins, no rounded corners).
          inset-0 replaces the top-1/2/left-1/2 centering from the base DialogContent. */}
      <DialogContent className="flex h-[92dvh] w-[94dvw] max-w-none sm:max-w-none flex-col overflow-hidden p-0 max-sm:inset-0 max-sm:h-dvh max-sm:w-full max-sm:translate-x-0 max-sm:translate-y-0 max-sm:rounded-none">

        {/* ── Header: station info left, Komoot button right ── */}
        <DialogHeader className="shrink-0 px-6 pt-6 pb-0">
          {/* On mobile: single column stack. On sm+: row with title/subtitle left, button right. */}
          <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between sm:gap-5">

            {/* Left group: title + description always stacked together.
                On mobile the title row also contains the X button (hidden on sm+). */}
            <div className="flex flex-col gap-2">
              <div className="flex items-start justify-between">
                <DialogTitle className="text-3xl">
                  {stationName} Station
                </DialogTitle>
                <DialogClose asChild className="sm:hidden">
                  <Button variant="outline" size="icon" className="text-foreground mt-0 cursor-pointer">
                    <HugeiconsIcon icon={Cancel01Icon} strokeWidth={2} />
                    <span className="sr-only">Close</span>
                  </Button>
                </DialogClose>
              </div>
              <DialogDescription className="text-sm">
                {formatMinutes(minutes)} from central London
              </DialogDescription>
            </div>

            {/* max-sm:w-full makes the button stretch full-width in the single-column mobile layout */}
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
          </div>
        </DialogHeader>

        {/* ── Dev tools: rating buttons + delete ── */}
        {devMode && (
          <div className="shrink-0 border-t px-6 py-3">
            <div className="flex items-center gap-1.5">
              {/* Delete — adds station to excluded list */}
              <DevActionButton
                label="Delete"
                active={false}
                onClick={() => onExclude?.()}
                icon={
                  /* Trash icon (Lucide) */
                  <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <polyline points="3 6 5 6 21 6" />
                    <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
                    <line x1="10" y1="11" x2="10" y2="17" />
                    <line x1="14" y1="11" x2="14" y2="17" />
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

              {/* Unverified recommendation — triangle-up, grey-green */}
              <DevActionButton
                label="Unverified"
                active={currentRating === 'unverified'}
                onClick={() => onRate?.(currentRating === 'unverified' ? null : 'unverified')}
                icon={
                  <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24"
                    fill={currentRating === 'unverified' ? '#aed0b8' : 'none'}
                    stroke={currentRating === 'unverified' ? '#aed0b8' : 'currentColor'}
                    strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <polygon points="12 3, 22.39 21, 1.61 21" />
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
            <div className="grid grid-cols-1 gap-2 sm:grid-cols-2 sm:gap-4 lg:grid-cols-4 max-sm:-mx-6">
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
              <div className="grid grid-cols-1 gap-2 sm:grid-cols-2 sm:gap-4 lg:grid-cols-4 max-sm:-mx-6">
                {photos.slice(0, Math.floor(photos.length / 12) * 12 || 12).map((photo) => (
                  <PhotoCard
                    key={photo.id}
                    photo={photo}
                    devMode={devMode}
                    isApproved={approvedIds.has(photo.id)}
                    onApprove={() => onApprovePhoto?.(photo)}
                    onReject={() => onRejectPhoto?.(photo.id)}
                    onUnapprove={() => onUnapprovePhoto?.(photo.id)}
                  />
                ))}
              </div>

              {/* "X photos" link — shown below the grid if we have a count */}
              {flickrCount != null && flickrCount > 0 && (
                <p className="mt-4 text-center text-sm text-muted-foreground">
                  <a
                    href={`https://www.flickr.com/search/?tags=landscape&lat=${lat}&lon=${lng}&radius=7&sort=interestingness-desc`}
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

function PhotoCard({ photo, devMode, isApproved, onApprove, onReject, onUnapprove }: {
  photo: FlickrPhoto
  devMode: boolean
  isApproved: boolean
  onApprove: () => void
  onReject: () => void
  onUnapprove: () => void
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
