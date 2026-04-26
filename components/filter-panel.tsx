"use client"

import { IconTrainFilled, IconChevronDown, IconPlus, IconX } from "@tabler/icons-react"
import SearchBar from "@/components/search-bar"
import { Button } from "@/components/ui/button"
import { Checkbox } from "@/components/ui/checkbox"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
} from "@/components/ui/dropdown-menu"
import { cn } from "@/lib/utils"
import { Slider } from "@/components/ui/slider"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import { Fragment, useEffect, useMemo, useRef, useState } from "react"

// Wraps any inline content with a tooltip that works on both desktop (hover)
// and touchscreens (tap toggles open/closed). Uses controlled `open` state
// so Radix honours our state while still closing on blur.
// On touch devices, tapping the label only shows the tooltip — it won't
// bubble up to toggle a parent <label>'s checkbox.
function LabelTip({ text, icon, children }: { text: string; icon?: React.ReactNode; children: React.ReactNode }) {
  const [open, setOpen] = useState(false)
  // Tracks whether the click originated from a touch event
  const touchedRef = useRef(false)
  // After a manual close-via-click, briefly ignore Radix's open signals
  // (hover, focus, pointerdown) so the tooltip doesn't flicker back open.
  const lockUntilRef = useRef(0)
  // When true, the icon hops upward; a timeout flips it back to false,
  // and the CSS transition eases it back down — a small "jump" effect.
  const [jumped, setJumped] = useState(false)
  return (
    <Tooltip
      open={open}
      onOpenChange={(next) => {
        if (next && Date.now() < lockUntilRef.current) return
        setOpen(next)
      }}
    >
      <TooltipTrigger asChild>
        <button
          type="button"
          className="cursor-default appearance-none border-0 bg-transparent p-0 text-left font-inherit text-inherit"
          // Flag that a touch just happened
          onTouchStart={() => { touchedRef.current = true }}
          // pointerDown fires before Radix's handler and before click.
          // Close + lock here so there's no gap where Radix can re-open.
          onPointerDown={() => {
            if (open) {
              lockUntilRef.current = Date.now() + 300
              setOpen(false)
            }
            // Trigger jump: move up immediately, then ease back down after 120ms
            if (icon) {
              setJumped(true)
              setTimeout(() => setJumped(false), 120)
            }
          }}
          onClick={(e) => {
            if (touchedRef.current) {
              // Stop the click from reaching the parent <label>,
              // so the checkbox doesn't toggle on tap
              e.preventDefault()
              touchedRef.current = false
            }
            // Only open — closing already happened in onPointerDown
            if (!open) setOpen(true)
          }}
        >
          <span className="flex items-center gap-3 text-sm font-medium">
            {icon && (
              /* Only the icon jumps — translateY shifts it upward then the
                 CSS transition eases it back. inline-block is required
                 because transforms are ignored on plain inline elements. */
              <span
                style={{
                  display: "inline-block",
                  transform: jumped ? "translateY(-3px)" : "translateY(0)",
                  transition: "transform 150ms ease-out",
                }}
              >
                {icon}
              </span>
            )}
            {children}
          </span>
        </button>
      </TooltipTrigger>
      {/* Tapping the tooltip bubble itself also dismisses it */}
      <TooltipContent
        onPointerDown={() => {
          lockUntilRef.current = Date.now() + 300
          setOpen(false)
        }}
      >
        {text}
      </TooltipContent>
    </Tooltip>
  )
}

// Each rating category with its display label, colour, and inline SVG icon
// matching the map markers exactly: star, triangle-up, triangle-down, circle.
// `adminOnly` entries only render when admin mode is active.
const RATING_FILTERS: { key: string; label: string; icon: React.ReactNode; tooltip: string; secondary?: boolean; adminOnly?: boolean }[] = [
  {
    key: "highlight", label: "Sublime", tooltip: "Among the very best stations for walking — an area you could visit forever",
    icon: (
      /* w-[0.75rem] h-[0.75rem] uses rem so the icon scales with the root font-size; scale-125 makes the star a bit bigger than the rest */
      <svg viewBox="1 1 22 22" fill="var(--primary)" stroke="var(--primary)" strokeWidth="1.5" className="w-[1rem] h-[1rem]">
        <polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2" />
      </svg>
    ),
  },
  {
    key: "verified", label: "Charming", tooltip: "A station with real character and lovely walks nearby — well worth the journey",
    icon: (
      <svg viewBox="0 0 24 24" fill="var(--primary)" stroke="var(--primary)" strokeWidth="1.5" className="w-[1rem] h-[1rem]">
        <polygon points="12 3, 22.39 21, 1.61 21" />
      </svg>
    ),
  },
  {
    // "Probably" was previously styled with --secondary (grey-green) to
    // group it with Okay/Unknown. It now uses --primary so it reads as a
    // positive-curation tier alongside Heavenly and Good — distinct from
    // the duller Unknown dot beneath it. `secondary: true` would still
    // drive a secondary-tinted checkbox, so drop that flag too.
    key: "unverified", label: "Pleasant", tooltip: "Some good walks in the area — enjoyable without being unmissable",
    icon: (
      // Filter-menu only — same hexagon points as before, rotated 90°
      // for visual variety and scaled to 90% (w-[0.9rem]) to feel less
      // dominant next to the star/triangle/diamond/circle siblings. Map
      // icons are separate raster sprites (icon-unverified PNG) and are
      // unaffected.
      <svg viewBox="1 2 22 20" fill="var(--primary)" stroke="var(--primary)" strokeWidth="1.5" className="w-[0.9rem] h-[0.9rem] rotate-90">
        {/* Hexagon: 6 vertices at radius 10, wider than tall */}
        <polygon points="22,12 17,20.66 7,20.66 2,12 7,3.34 17,3.34" />
      </svg>
    ),
  },
  {
    key: "not-recommended", label: "Flawed", secondary: true, tooltip: "Some worthwhile walks here, but the area has drawbacks — check the notes before making the trip",
    icon: (
      <svg viewBox="0 0 24 24" fill="var(--secondary)" stroke="var(--secondary)" strokeWidth="1.5" className="w-[1rem] h-[1rem]">
        <polygon points="12 21, 22.39 3, 1.61 3" />
      </svg>
    ),
  },
  {
    key: "unrated", label: "Unknown", secondary: true, tooltip: "No walk information found for this station yet",
    icon: (
      <svg viewBox="0 0 24 24" fill="var(--secondary)" stroke="var(--secondary)" strokeWidth="1.5" className="w-[1rem] h-[1rem]">
        <circle cx="12" cy="12" r="9" />
      </svg>
    ),
  },
  {
    // Admin-only: shows stations that have been hidden from the destination list.
    key: "excluded", label: "Excluded", adminOnly: true,
    tooltip: "Visible only in admin mode",
    icon: (
      /* Latin/grave cross — horizontal raised to the upper third so it reads as a
         headstone (appropriate for "excluded") rather than a generic "+" add icon. */
      <svg viewBox="0 0 24 24" fill="none" stroke="var(--primary)" strokeWidth="3" className="w-[1rem] h-[1rem]">
        <line x1="4" y1="9" x2="20" y2="9" />
        <line x1="12" y1="4" x2="12" y2="20" />
      </svg>
    ),
  },
]

type FilterPanelProps = {
  maxMinutes: number
  onChange: (value: number) => void
  /** Admin-only minimum travel time — hides stations closer than this */
  minMinutes: number
  onMinChange: (value: number) => void
  showTrails: boolean
  onToggleTrails: (value: boolean) => void
  /** Region labels (counties, parks, AONBs/National Landscapes) toggle. */
  showRegions: boolean
  onToggleRegions: (value: boolean) => void
  /** Admin-only "Show all" button — fired from filter panel, executed in
   *  map.tsx where all the resetting state setters live. Clears every
   *  filter back to "show everything". */
  onShowAll: () => void
  visibleRatings: Set<string>
  onToggleRating: (key: string) => void
  searchQuery: string
  onSearchChange: (value: string) => void
  adminMode: boolean
  /** Whether the welcome banner is currently showing */
  bannerVisible: boolean
  /** Currently selected primary origin station name */
  primaryOrigin: string
  /** Pinned primary coords — always rendered at the top of the dropdown,
   *  always present, never evicted. Counted against the cap. */
  pinnedPrimaries: string[]
  /** Admin-only primary entries — rendered as a separate group below the
   *  pinned items when adminMode is on. NOT counted against the cap. */
  adminOnlyPrimaries: string[]
  /** Switch the primary origin */
  onPrimaryOriginChange: (origin: string) => void
  /** Maps a canonical station name to a shorter display name for the trigger (e.g. "Birmingham New Street" → "Birmingham") */
  originDisplayName: (name: string) => string
  /** Optional extra-short "super-shorthand" used on mobile only (e.g. "Charing Cross" → "Charing X", "City of London" → "City"). Falls back to originDisplayName when not provided. */
  originMobileDisplayName?: (name: string) => string | undefined
  /** Maps a canonical name to a longer label for dropdown menu items (e.g. "Kings Cross St Pancras" → "Kings X, St Pancras, Euston") */
  originMenuName: (name: string) => string
  /** All NR stations — drives the primary-dropdown search bar autocomplete. Only used when adminMode is on. */
  searchableStations?: {
    coord: string
    name: string
    crs: string
    // primaryCoord: the cluster primary this station belongs to, or
    // the station's own coord for isolated stations. Used to dedupe
    // matches — two cluster members that both match ("Waterloo" +
    // "Waterloo East") collapse to a single row.
    primaryCoord: string
    // displayLabel: what renders in the dropdown. For cluster
    // members this is the cluster's menuName ("Waterloo & Waterloo
    // East"); for isolated stations it's the station's own name.
    displayLabel: string
    // hasData: whether the station has full RTT origin-routes data.
    // Rows without data render disabled (greyed out, not selectable)
    // with a "Coming soon" tooltip on desktop hover.
    hasData: boolean
  }[]
  /** Coord keys of custom primaries the user has previously selected via search. Shown as quick-picks beneath the main origin list in admin mode. */
  recentPrimaries?: string[]
  /** Called when the user picks a station via the search bar or a recent entry. */
  onCustomPrimarySelect?: (coord: string) => void
  /** Resolves a coord key to a human-readable station name — used to label recents. */
  coordToName?: Record<string, string>
  /** Friend origin station name, or null if not active */
  friendOrigin: string | null
  /** Pinned friend coords — same role as pinnedPrimaries on the friend
   *  side. Currently empty; reserved for future always-visible picks. */
  pinnedFriends: string[]
  /** Friend recents — user picks (top) merged with curated defaults. */
  recentFriends: string[]
  /** All available friend origin options */
  friendOrigins: string[]
  /** Switch the friend origin (without deactivating) */
  onFriendOriginChange: (origin: string) => void
  friendMaxMinutes: number
  onFriendMaxMinutesChange: (value: number) => void
  onActivateFriend: () => void
  onDeactivateFriend: () => void
  /** "Direct trains only" toggle for the primary origin */
  primaryDirectOnly: boolean
  onPrimaryDirectOnlyChange: (value: boolean) => void
  /** Admin-only interchange filter. Values:
   *   "off"     — no filter (non-admin default, dropdown hidden)
   *   "direct"  — zero interchanges (supersedes the hidden "Direct
   *               trains only" checkbox in admin mode)
   *   "any"     — ≥1 interchange
   *   "inner"   — ≥1 interchange at a central-London terminus
   *   "outer"   — ≥1 interchange at a non-London-terminus station
   *   "lowdata" — ≥1 interchange at a station with no RTT data yet */
  primaryInterchangeFilter: "off" | "direct" | "any" | "inner" | "outer" | "lowdata" | "gooddata"
  onPrimaryInterchangeFilterChange: (
    value: "off" | "direct" | "any" | "inner" | "outer" | "lowdata" | "gooddata",
  ) => void
  /** Admin-only feature filter — slices destinations by which
   *  optional modal features they'd surface. "off" = no filter.
   *  "alt-routes" = only destinations with ≥1 alternative route.
   *  "private-notes" = only destinations with a non-empty admin
   *  private note.
   *  "sloppy-pics" = stations that aren't fully photo-curated yet
   *  (< 12 approved photos — includes never-touched stations).
   *  "all-sloppy-pics" = the subset of sloppy-pics that have zero
   *  curation at all (no approvals AND no rejections yet). */
  primaryFeatureFilter: "off" | "alt-routes" | "private-notes" | "sloppy-pics" | "all-sloppy-pics" | "undiscovered" | "komoot" | "issues" | "no-travel-data" | "oyster"
  onPrimaryFeatureFilterChange: (value: "off" | "alt-routes" | "private-notes" | "sloppy-pics" | "all-sloppy-pics" | "undiscovered" | "komoot" | "issues" | "no-travel-data" | "oyster") => void
  /** Admin-only season filter — hides destinations whose recommended
   *  seasons don't include the selected one. "off" = no filter. */
  seasonFilter: "off" | "Spring" | "Summer" | "Autumn" | "Winter" | "None"
  onSeasonFilterChange: (value: "off" | "Spring" | "Summer" | "Autumn" | "Winter" | "None") => void
  /** The calendar-derived current season — labels the public checkbox
   *  ("Spring highlights", etc) and is what that checkbox filters against. */
  currentSeason: "Spring" | "Summer" | "Autumn" | "Winter"
  /** Public "[current-season] highlights" checkbox (visible to all users). */
  currentSeasonHighlight: boolean
  onCurrentSeasonHighlightChange: (value: boolean) => void
  /** "Direct trains only" toggle for the friend origin */
  friendDirectOnly: boolean
  onFriendDirectOnlyChange: (value: boolean) => void
}

export default function FilterPanel({ maxMinutes, onChange, minMinutes, onMinChange, showTrails, onToggleTrails, showRegions, onToggleRegions, onShowAll, visibleRatings, onToggleRating, searchQuery, onSearchChange, adminMode, bannerVisible, primaryOrigin, pinnedPrimaries, adminOnlyPrimaries, onPrimaryOriginChange, originDisplayName, originMobileDisplayName, originMenuName, searchableStations = [], recentPrimaries = [], onCustomPrimarySelect, coordToName = {}, friendOrigin, pinnedFriends, recentFriends = [], friendOrigins, onFriendOriginChange, friendMaxMinutes, onFriendMaxMinutesChange, onActivateFriend, onDeactivateFriend, primaryDirectOnly, onPrimaryDirectOnlyChange, primaryInterchangeFilter, onPrimaryInterchangeFilterChange, primaryFeatureFilter, onPrimaryFeatureFilterChange, seasonFilter, onSeasonFilterChange, currentSeason, currentSeasonHighlight, onCurrentSeasonHighlightChange, friendDirectOnly, onFriendDirectOnlyChange }: FilterPanelProps) {
  // Helper: renders the trigger's origin label, using the mobile super-shorthand
  // on narrow viewports (via sm:hidden / hidden sm:inline siblings) where one
  // is defined. Keeps the markup tidy at each of the several call-sites.
  //
  // For custom primaries (an arbitrary NR station picked via the search box)
  // originDisplayName returns the raw coord key because the coord isn't in
  // PRIMARY_ORIGINS. Fall back to coordToName so we show the station's name
  // instead of "-0.842,51.412…". The outer span has `truncate` so overly
  // long names ellipsis cleanly rather than breaking the "Max time from …"
  // row onto a second line.
  const renderOriginLabel = (key: string) => {
    const resolved = originDisplayName(key)
    const full = resolved === key && coordToName[key] ? coordToName[key] : resolved
    const mobile = originMobileDisplayName?.(key) ?? full
    return mobile === full ? (
      <>{full}</>
    ) : (
      <>
        <span className="sm:hidden">{mobile}</span>
        <span className="hidden sm:inline">{full}</span>
      </>
    )
  }
  // Collapsed state — only meaningful on mobile; desktop never shows the toggle button
  const [collapsed, setCollapsed] = useState(false)

  // Primary-origin dropdown: search state. When the user types 3+ chars, the
  // dropdown's normal origin list is REPLACED with a filtered list of NR
  // stations (Phase 2 custom primary). Only shown when admin mode is active.
  const [primarySearch, setPrimarySearch] = useState("")
  const isPrimarySearchActive = primarySearch.trim().length >= 3

  // Friend-side equivalent. Filter universe is the merged friend recents
  // (pinned + recents) — typing "edin" reveals Edinburgh even if it's
  // past the visible cap. Threshold matches the primary side (3 chars)
  // so neither dropdown spams results on a single keystroke.
  const [friendSearch, setFriendSearch] = useState("")
  const isFriendSearchActive = friendSearch.trim().length >= 3

  // Mobile-only: when the user taps the inline "Other stations" input, the
  // native keyboard pops up and obscures the dropdown's results. To avoid
  // typing blind, we promote the input into a full-viewport sheet that puts
  // the field at the top and results below — so the remaining UI stays
  // visible above the keyboard.
  // Kept outside the dropdown's open/close cycle: closing the dropdown (e.g.
  // by tapping outside or selecting an item) does NOT reset this state; the
  // user's explicit close (X button or result tap) is the only way out.
  const [mobileSearchOpen, setMobileSearchOpen] = useState(false)
  // Ref to the sheet's own input — used to programmatically blur (dismiss
  // the keyboard) when the user pans/taps the results area. Separate from
  // the dropdown's inline input, which only exists on desktop in practice.
  const mobileSheetInputRef = useRef<HTMLInputElement>(null)
  // Controlled open-state for the dropdown so we can programmatically
  // close it while the mobile search sheet is up AND reopen it when the
  // sheet is dismissed without a selection.
  //
  // Why close the dropdown when the sheet opens? Radix DropdownMenu runs
  // a FOCUS TRAP while open — any focus() call outside the dropdown's
  // DOM subtree gets yanked back to the dropdown. That breaks our
  // "focus the sheet input synchronously inside the gesture" trick: the
  // focus lands on the sheet input for a split-second, Radix notices,
  // pulls focus back to the dropdown input, and iOS sees a focus flap
  // without a stable visible focus target → refuses to raise the
  // keyboard, no blinking caret.
  //
  // Closing the dropdown releases the focus trap. The sheet input keeps
  // its focus; keyboard rises; caret blinks. On dismiss (X tap), we
  // REOPEN the dropdown so the user is back in the state they were in
  // before opening the sheet. Selection paths leave the dropdown closed
  // (since picking a primary origin is itself a completion).
  const [primaryDropdownOpen, setPrimaryDropdownOpen] = useState(false)
  // Dismiss the sheet only — reopens the dropdown so the user is back to
  // where they were before tapping search. Clears the search text so the
  // next open shows the blank empty-state again.
  const closeMobileSearchOnly = () => {
    setMobileSearchOpen(false)
    setPrimarySearch("")
    setPrimaryDropdownOpen(true)
  }
  // Dismiss both sheet AND dropdown — called after a result is selected.
  const closeAllAfterSelection = () => {
    setMobileSearchOpen(false)
    setPrimaryDropdownOpen(false)
    setPrimarySearch("")
  }
  // Sheet mount animation: the sheet renders off-screen (translate-y-full)
  // on mount, then on next frame flips to translate-y-0 so the browser
  // animates the transform. Matches the photo-overlay's slide-up-from-bottom
  // style. `sheetEntered` stays in sync with mobileSearchOpen via an effect
  // rather than derived inline so the initial render commits at full-
  // offscreen and the transform-change happens on the NEXT frame (a state
  // update inside useEffect triggers a re-render after paint).
  const [sheetEntered, setSheetEntered] = useState(false)
  useEffect(() => {
    if (!mobileSearchOpen) {
      setSheetEntered(false)
      return
    }
    // Clear stale state from the last close (search text + any residual
    // drag offset). setDragOffset(0) resets the inline translateY so a
    // sheet that was swipe-dismissed with a leftover offset re-opens
    // from a clean translate(100%+0) baseline.
    setPrimarySearch("")
    setDragOffset(0)
    const raf1 = requestAnimationFrame(() => {
      setSheetEntered(true)
      // Imperative focus — belt-and-braces with the synchronous focus
      // inside the trigger's onFocus handler. rAF keeps us within the
      // user-gesture window iOS needs to raise the keyboard if the
      // trigger's synchronous focus didn't stick.
      mobileSheetInputRef.current?.focus()
    })
    return () => cancelAnimationFrame(raf1)
  }, [mobileSearchOpen, setPrimarySearch])

  // iOS visual-viewport tracking. When iOS raises the keyboard, it
  // doesn't just shrink the window — it often ALSO scrolls the layout
  // viewport upward to try to bring the focused input into view,
  // setting visualViewport.offsetTop > 0. Because the sheet is
  // `position: fixed` against the LAYOUT viewport, that offset pushes
  // the sheet's top edge ABOVE the user's visible area — exactly the
  // "pushed up into outer space" symptom. The fix is to stop using
  // Tailwind's `top-8 bottom-0` (layout-viewport-relative) and instead
  // drive `top` and `height` via inline style using visualViewport
  // metrics, which describe the VISIBLE area. Result: the sheet
  // always hugs the actual visible viewport, regardless of keyboard
  // state or iOS's scroll antics.
  const [vvMetrics, setVvMetrics] = useState<{ top: number; height: number }>(
    () => ({
      top: 0,
      // SSR-safe fallback — on server, window is undefined; use 0 and
      // let the first client effect populate real numbers.
      height: typeof window !== "undefined" ? window.innerHeight : 0,
    }),
  )
  useEffect(() => {
    if (typeof window === "undefined" || !window.visualViewport) return
    const vv = window.visualViewport
    const update = () => setVvMetrics({ top: vv.offsetTop, height: vv.height })
    update()
    // Both events matter: resize fires when the keyboard shows/hides
    // (viewport height changes); scroll fires when iOS pans the visual
    // viewport within the layout viewport (e.g. after the page
    // scrolls to reveal a focused input).
    vv.addEventListener("resize", update)
    vv.addEventListener("scroll", update)
    return () => {
      vv.removeEventListener("resize", update)
      vv.removeEventListener("scroll", update)
    }
  }, [])

  // Swipe-down-to-dismiss state machine for the mobile sheet. Attaches
  // only to the top-bar region (drag handle + input row) so scrolling the
  // results area doesn't double-duty as dismissal. Commits the dismiss if
  // the drag exceeds ~80px OR velocity is noticeably downward at release.
  const dragStartY = useRef<number | null>(null)
  const dragStartAt = useRef<number>(0)
  const [dragOffset, setDragOffset] = useState(0)
  // isDragging is a derived flag — mirrored as state (not ref) so the
  // sheet's className re-evaluates when the drag starts/ends and the
  // transition class flips. transition is OFF during drag (so finger
  // tracking is 1:1) and ON otherwise (so open/close/snap-back animate).
  const [isDragging, setIsDragging] = useState(false)
  const mobileSheetDragHandlers = useMemo(() => ({
    onPointerDown: (e: React.PointerEvent) => {
      // Only react to primary touches/clicks; ignore mousewheel etc.
      if (e.pointerType !== "touch" && e.pointerType !== "pen") return
      dragStartY.current = e.clientY
      dragStartAt.current = performance.now()
      setDragOffset(0)
      setIsDragging(true)
    },
    onPointerMove: (e: React.PointerEvent) => {
      if (dragStartY.current == null) return
      const dy = e.clientY - dragStartY.current
      // Only track downward drags — upward pulls do nothing.
      setDragOffset(Math.max(0, dy))
    },
    onPointerUp: (e: React.PointerEvent) => {
      if (dragStartY.current == null) return
      const dy = e.clientY - dragStartY.current
      const dt = performance.now() - dragStartAt.current
      const velocity = dt > 0 ? dy / dt : 0 // px per ms
      dragStartY.current = null
      setIsDragging(false)  // re-enable CSS transition for the release animation
      // Commit the dismiss if the drag was big enough OR fast-downward.
      // 80px threshold is small enough to feel responsive without firing
      // on accidental taps; 0.4px/ms ≈ 400px/s is a gentle flick.
      if (dy > 80 || velocity > 0.4) {
        // Keep the dragOffset set to its current value — the transition
        // will interpolate from translateY(current+dragOffset) down to
        // translateY(100%+dragOffset) in one smooth slide. Zeroing the
        // offset now would cause a snap-up before the close animation
        // (the old bug). After the close transition completes the offset
        // clears in the useEffect below (gated on mobileSearchOpen).
        closeMobileSearchOnly()
      } else {
        // Didn't clear threshold — snap back to the open position. The
        // inline transform interpolates from translateY(N) back to
        // translateY(0) via the re-enabled CSS transition.
        setDragOffset(0)
      }
    },
    onPointerCancel: () => {
      dragStartY.current = null
      setIsDragging(false)
      setDragOffset(0)
    },
  }), [])
  const matchingStations = useMemo(() => {
    if (!isPrimarySearchActive) return []
    // normalise() strips punctuation and collapses whitespace so
    // user queries match station names regardless of apostrophes /
    // hyphens / curly quotes. Without this, "kings cross" misses
    // "London King's Cross" (apostrophe in "King's"), "st pancras"
    // misses "St. Pancras" if anywhere written with a dot, and so on.
    // Applied to BOTH the query and each station name.
    const normalise = (s: string) =>
      s
        .toLowerCase()
        // Strip curly + straight apostrophes, dots, and hyphens.
        // Keep spaces so word order still matters.
        .replace(/['\u2019.\-]/g, "")
        // Collapse any run of whitespace into a single space.
        .replace(/\s+/g, " ")
        .trim()
    const q = normalise(primarySearch)
    // Split matches into four buckets so the final list is ordered:
    //   1. hasData + starts-with
    //   2. hasData + contains
    //   3. disabled + starts-with
    //   4. disabled + contains
    // Available stations always appear above disabled ones regardless
    // of how relevant the match is — the user's intent is to find a
    // working home station, so offering a weaker-relevance "Richmond"
    // above a stronger-relevance "Richmond-upon-Rosedale" (if it had
    // no data) is correct. Within each bucket we still prefer
    // starts-with over contains, because that ordering felt natural
    // before we introduced the data tier.
    const availStarts: typeof searchableStations = []
    const availContains: typeof searchableStations = []
    const disabledStarts: typeof searchableStations = []
    const disabledContains: typeof searchableStations = []
    for (const s of searchableStations) {
      const n = normalise(s.name)
      // CRS prefix match (e.g. "swl" → Swale) counts as a starts-with
      // hit so typing the code surfaces the station at the top of the
      // list, same as typing the start of its name. CRS codes have no
      // punctuation so we don't need to run them through normalise().
      const crsMatch = !!s.crs && s.crs.toLowerCase().startsWith(q)
      const startsMatch = crsMatch || n.startsWith(q)
      const containsMatch = !startsMatch && n.includes(q)
      if (!startsMatch && !containsMatch) continue
      const bucket = s.hasData
        ? (startsMatch ? availStarts : availContains)
        : (startsMatch ? disabledStarts : disabledContains)
      bucket.push(s)
      if (availStarts.length + availContains.length + disabledStarts.length + disabledContains.length >= 40) break
    }
    // Dedupe by primaryCoord — multiple cluster members matching the
    // same search (e.g. "waterloo" matching both "Waterloo" AND
    // "Waterloo East") collapse to a single row showing the cluster
    // name. Happens AFTER the name-match step so that searching by
    // an individual cluster-member name (e.g. "euston") still finds
    // the right cluster, but only ONE entry shows up.
    const seen = new Set<string>()
    const deduped: typeof searchableStations = []
    for (const s of [...availStarts, ...availContains, ...disabledStarts, ...disabledContains]) {
      if (seen.has(s.primaryCoord)) continue
      seen.add(s.primaryCoord)
      deduped.push(s)
    }
    return deduped.slice(0, 15)
  }, [primarySearch, isPrimarySearchActive, searchableStations])

  // Friend search matches. Filters across the merged friend list
  // (pinned + recents) by display name. Returns coord strings rather
  // than richer station records — friend rendering already does its own
  // label resolution via originMenuName / coordToName.
  const matchingFriends = useMemo(() => {
    if (!isFriendSearchActive) return [] as string[]
    const q = friendSearch.toLowerCase().trim()
    const universe = [...pinnedFriends, ...recentFriends.filter((c) => !pinnedFriends.includes(c))]
    return universe.filter((coord) => {
      const menu = originMenuName(coord)
      const label = menu !== coord ? menu : coordToName[coord] ?? coord
      return label.toLowerCase().includes(q)
    }).slice(0, 15)
  }, [friendSearch, isFriendSearchActive, pinnedFriends, recentFriends, originMenuName, coordToName])

  // --- Train arrival animation ---
  // Purely visual: after the banner is dismissed, a fake slider overlay
  // animates the train icon smoothly from 0% → the real thumb position.
  // The real slider stays hidden underneath so maxMinutes never changes,
  // the label stays at "2h", and station filtering isn't affected.
  // Once the animation ends we hide the fake and reveal the real slider.
  //
  // We drive the animation with requestAnimationFrame updating a percentage
  // ref, because CSS keyframe animations on custom properties weren't
  // rendering reliably across browsers.
  const [trainArriving, setTrainArriving] = useState(false)
  // Tracks whether the train animation has completed at least once,
  // so we know when to stop showing the blank placeholder track
  const hasAnimatedRef = useRef(false)
  const trainProgressRef = useRef(0)
  const rangeRef = useRef<HTMLDivElement>(null)
  const thumbRef = useRef<HTMLDivElement>(null)
  const sliderWrapperRef = useRef<HTMLDivElement>(null)
  const prevBannerRef = useRef(bannerVisible)

  useEffect(() => {
    if (prevBannerRef.current && !bannerVisible) {
      // Read the real Radix thumb's actual left value so the animation
      // lands in exactly the same spot — avoids a 1px jump on handoff.
      let targetPercent = ((maxMinutes - 30) / (sliderMax - 30)) * 100
      const realThumb = sliderWrapperRef.current?.querySelector<HTMLSpanElement>("[data-slot='slider-thumb']")
      if (realThumb) {
        // Radix wraps the thumb in a <span style="left: calc(X% + Ypx)">;
        // the parent of the [data-slot] element has the actual position.
        const parent = realThumb.parentElement
        if (parent) {
          const track = sliderWrapperRef.current?.querySelector<HTMLSpanElement>("[data-slot='slider-track']")
          if (track) {
            const trackRect = track.getBoundingClientRect()
            const parentRect = parent.getBoundingClientRect()
            // Centre of the thumb relative to the track, as a percentage
            const thumbCentre = parentRect.left + parentRect.width / 2 - trackRect.left
            targetPercent = (thumbCentre / trackRect.width) * 100
          }
        }
      }
      const duration = 3000
      let cancelled = false

      trainProgressRef.current = 0
      setTrainArriving(true)

      // 300ms pause so the banner exit settles before the train moves
      const delayTimer = setTimeout(() => {
        let startTime: number | null = null

        function step(timestamp: number) {
          if (cancelled) return
          if (!startTime) startTime = timestamp
          const progress = Math.min((timestamp - startTime) / duration, 1)
          // Cubic ease-out: starts fast, decelerates into the station
          const eased = 1 - Math.pow(1 - progress, 3)
          const percent = targetPercent * eased

          // Update DOM directly (no re-render) for buttery-smooth animation
          if (rangeRef.current) rangeRef.current.style.width = `${percent}%`
          if (thumbRef.current) thumbRef.current.style.left = `${percent}%`

          if (progress < 1) {
            requestAnimationFrame(step)
          } else {
            hasAnimatedRef.current = true
            setTrainArriving(false)
          }
        }

        requestAnimationFrame(step)
      }, 300)

      prevBannerRef.current = bannerVisible
      return () => { cancelled = true; clearTimeout(delayTimer) }
    }
    prevBannerRef.current = bannerVisible
  }, [bannerVisible]) // eslint-disable-line react-hooks/exhaustive-deps

  // Convert minutes to hours + minutes for display (e.g. 90 → "1h 30m")
  function formatDuration(mins: number) {
    if (mins < 60) return `${mins}m`
    const h = Math.floor(mins / 60)
    const m = mins % 60
    return m === 0 ? `${h}h` : `${h}h ${m}m`
  }

  // Slider max constants. Non-admin users are capped at 2h30m. Admin
  // mode extends to 10h — effectively unlimited for GB rail; the
  // filter treats values at this cap as "no maximum".
  const NON_ADMIN_MAX = 150
  const ADMIN_MAX = 600
  const sliderMax = adminMode ? ADMIN_MAX : NON_ADMIN_MAX

  // Format the max-slider value label. In admin mode, show "Max" when the
  // slider is pinned to its upper limit so it reads as "no limit" rather than "10h".
  function formatMax(mins: number) {
    if (adminMode && mins >= ADMIN_MAX) return "Max"
    return formatDuration(mins)
  }

  // Friend dropdown content — rendered in BOTH the active and inactive
  // friend states. Mirrors the primary dropdown's pinned + capped-recents
  // + search shape. The active friend renders as a ghost-styled row with
  // an X icon on the right; clicking it removes the friend (i.e. clears
  // friendOrigin). Cap matches the primary side (12/5) — there's no
  // separate "Remove" row eating a slot anymore.
  function renderFriendDropdownContent() {
    const dedup = recentFriends.filter((c) => !pinnedFriends.includes(c))
    const desktopRoom = Math.max(0, 12 - pinnedFriends.length)
    const mobileRoom = Math.max(0, 5 - pinnedFriends.length)
    // Helper that renders a single friend row. Branches on whether it's
    // the active friend: active rows get muted text + an X icon and
    // remove-on-click; inactive rows are normal selectable picks.
    const renderRow = (coord: string, idx?: number) => {
      const menu = originMenuName(coord)
      const label = menu !== coord ? menu : coordToName[coord] ?? coord
      const isActive = coord === friendOrigin
      const hiddenOnMobile = idx != null && mobileRoom != null && idx >= mobileRoom
      if (isActive) {
        return (
          <DropdownMenuItem
            key={coord}
            onSelect={() => onDeactivateFriend()}
            className={cn(
              // flex items-center keeps the label and the X aligned on
              // the same baseline; justify-between pushes the X to the
              // right edge of the row. Normal text colour — the X icon
              // alone signals the remove affordance.
              "flex items-center justify-between gap-2 whitespace-normal leading-tight cursor-pointer",
              hiddenOnMobile && "hidden sm:flex",
            )}
            aria-label={`Remove ${label} as friend's station`}
          >
            <span>{label}</span>
            <IconX size={14} className="shrink-0" />
          </DropdownMenuItem>
        )
      }
      return (
        <DropdownMenuItem
          key={coord}
          onSelect={() => onFriendOriginChange(coord)}
          className={cn(
            "whitespace-normal leading-tight cursor-pointer",
            hiddenOnMobile && "hidden sm:flex",
          )}
        >
          {label}
        </DropdownMenuItem>
      )
    }
    return (
      <>
        {/* Pinned friends — always shown, always near the top. Currently
            empty; reserved for future curated picks. */}
        {pinnedFriends.map((coord) => renderRow(coord))}
        {/* Recents — capped at 12 (≥sm) / 5 (<sm) total INCLUDING any
            pinned items above. Items past the mobile slice get
            `hidden sm:flex` so the small-viewport list stays scannable. */}
        {dedup.slice(0, desktopRoom).map((coord, idx) => renderRow(coord, idx))}
        {/* Search input + matches. Same pattern as the primary side —
            stopPropagation keeps Radix's typeahead from hijacking
            keystrokes. Universe is currently the merged recents list, so
            typing the name of a friend buried past the cap reveals it. */}
        <div className="px-1.5 py-1">
          <Input
            type="text"
            placeholder="Other stations"
            value={friendSearch}
            onChange={(e) => setFriendSearch(e.target.value)}
            onKeyDown={(e) => e.stopPropagation()}
            className="h-7 text-xs px-2"
          />
        </div>
        {isFriendSearchActive && (
          matchingFriends.length > 0 ? (
            matchingFriends.map((coord) => {
              const menu = originMenuName(coord)
              const label = menu !== coord ? menu : coordToName[coord] ?? coord
              return (
                <DropdownMenuItem
                  key={coord}
                  onSelect={() => {
                    onFriendOriginChange(coord)
                    setFriendSearch("")
                  }}
                  className={cn(
                    "whitespace-normal leading-tight cursor-pointer",
                    coord === friendOrigin && "bg-accent/50 focus:bg-accent/50"
                  )}
                >
                  {label}
                </DropdownMenuItem>
              )
            })
          ) : (
            <div className="px-2 py-1.5 text-sm text-muted-foreground">
              No matches
            </div>
          )
        )}
      </>
    )
  }

  // Fragment wrapper so we can render the mobile-search sheet as a sibling
  // of the main card. The sheet overlays the entire viewport (fixed inset-0)
  // so it needs to be outside the absolutely-positioned card — otherwise
  // the sheet would inherit the card's transform/positioning context.
  // Card classes: on mobile inset-x-2/top-2 (0.5rem margins) stretches the
  // card nearly to the viewport edges; on sm+ we restore the 1rem margins
  // + fixed sidebar width.
  return (
    <>
    <div className="absolute inset-x-2 top-2 z-10 rounded-lg bg-card p-4 text-card-foreground shadow-md sm:inset-x-auto sm:left-4 sm:top-4 sm:w-64">

      {/* Header row — single button wrapping logo + chevron so the entire
          row is one continuous hit area for toggling collapse */}
      <button
        id="LOGO_AND_COLLAPSE_STACK"
        type="button"
        onClick={() => setCollapsed((v) => !v)}
        className="mb-0 sm:mb-1 flex w-full cursor-pointer items-center justify-between gap-2 border-0 bg-transparent p-0"
        aria-label={collapsed ? "Expand filters" : "Collapse filters"}
      >
        {/* Logo — mask-image uses the SVG as a stencil filled by bg-primary */}
        <div
          className="w-full aspect-[597/51] bg-primary"
          role="img"
          aria-label="Trains to Green"
          style={{
            maskImage: "url(/trainstogreen-logo.svg)",
            maskSize: "contain",
            maskRepeat: "no-repeat",
            WebkitMaskImage: "url(/trainstogreen-logo.svg)",
            WebkitMaskSize: "contain",
            WebkitMaskRepeat: "no-repeat",
          }}
        />
        <IconChevronDown
          size={24} stroke={4.5}
          strokeLinecap="square" strokeLinejoin="miter"
          className={`shrink-0 text-primary transition-transform duration-200 ${collapsed ? "rotate-0" : "rotate-180"}`}
        />
      </button>
      {/* Extra bottom breathing room when collapsed — the card's p-4 is there but feels tight */}
      {/* {collapsed && <div className="h-2 sm:hidden" />} */}

      {/* Collapsible content wrapper — uses the CSS grid row trick to animate
          height between 0 and "auto". grid-rows-[0fr] collapses to zero height,
          grid-rows-[1fr] expands to the content's natural height, and
          transition-[grid-template-rows] animates smoothly between them.
          Clicking the logo toggles collapsed on both mobile and desktop. */}
      <div className={`grid transition-[grid-template-rows] duration-300 ease-in-out ${
        collapsed ? "grid-rows-[0fr]" : "grid-rows-[1fr]"
      }`}>
        {/* overflow-y-clip clips content vertically for the collapse animation
            while allowing horizontal overflow (e.g. negative-margin buttons).
            min-w-0 is CRITICAL: grid items default to min-width:auto, which
            refuses to shrink below content intrinsic size. Without this, a
            long origin name like "Stratford International" would push the
            whole row wider than the card, spilling the "2h 30m" duration
            off-screen. With min-w-0, the grid child respects its column's
            available width and the inner `truncate` class actually kicks
            in early enough to clip to "Stratford Interna…". */}
        <div className="min-h-0 min-w-0 overflow-y-clip">
          {/* mt-3 on mobile adds the space that was previously on the header row;
              sm:mt-0 removes it since desktop never collapsed */}
          {/* Search bar only shows when admin mode is toggled on */}
          {adminMode && (
            <div className="mb-4 mt-4 sm:mt-2">
              <SearchBar value={searchQuery} onChange={onSearchChange} />
            </div>
          )}
          <div id="SLIDER-LABEL" className="mt-4 mb-2 flex items-baseline justify-between gap-2">
            {/* min-w-0 lets the inner truncation actually bite — without it the
                flex child refuses to shrink below its content and text wraps. */}
            <span className="flex min-w-0 items-center gap-1 text-sm font-medium">
              {/* whitespace-nowrap + shrink-0 ensures "Max time from" always
                  renders on one line and never loses width to a long origin name. */}
              <span className="relative whitespace-nowrap shrink-0">Max time from</span>
              {/* Chevron dropdown — clicking the origin name or chevron opens it */}
              {/* Dropdown trigger is always rendered. The previous
                  `primaryOriginGroups.flat().length > 1` gate made sense
                  when multiple curated London termini lived in the
                  dropdown — if only one origin existed, no need for a
                  picker. With the restructure, the dropdown now holds
                  the recents list + search input regardless of how
                  many curated groups are present, so the gate was
                  hiding the trigger even though plenty of picks are
                  still available inside. */}
              {(
                <DropdownMenu
                  open={primaryDropdownOpen}
                  onOpenChange={(open) => {
                    setPrimaryDropdownOpen(open)
                    // Reset the search box every time the menu closes, so
                    // re-opening it shows the normal origin list (not the
                    // last search result state).
                    if (!open) setPrimarySearch("")
                  }}
                >
                  <DropdownMenuTrigger asChild>
                    {/* relative + before: pseudo-element creates the hover background
                        BEHIND adjacent text. -z-10 on the pseudo puts it below sibling
                        spans that have `relative`, while the button itself stays clickable.
                        min-w-0 allows the inner origin-name span to truncate. */}
                    <button type="button" className="group/trigger relative inline-flex min-w-0 cursor-pointer items-center gap-0.5 rounded-md border-0 bg-transparent px-1.5 -mx-1.5 py-0.5 font-inherit text-inherit outline-none hover:text-accent-foreground focus-visible:ring-[3px] focus-visible:ring-ring/50 data-[state=open]:cursor-pointer before:absolute before:inset-0 before:rounded-md before:-z-10 hover:before:bg-accent">
                      {/* truncate = overflow-hidden + text-ellipsis + whitespace-nowrap.
                          Long origin names like "Charing Cross" shrink to "Charing C…" on
                          narrow mobile rather than wrapping onto a second line. */}
                      <span className="truncate">{renderOriginLabel(primaryOrigin)}</span>
                      <IconChevronDown size={12} className="shrink-0 text-muted-foreground group-hover/trigger:text-accent-foreground" />
                    </button>
                  </DropdownMenuTrigger>
                  {/* On mobile: force a viewport-minus-2rem width so Radix's
                      collision detection clamps the content to 1rem from each
                      edge, effectively centring it with equal margins.
                      On desktop: cap at 22rem so long menu names (City cluster)
                      wrap to two lines rather than stretching the menu.
                      collisionPadding ensures Radix respects the 1rem gutter.

                      Height cap: Radix fills the custom CSS variable
                      --radix-dropdown-menu-content-available-height with the
                      pixel distance from the trigger to the nearest viewport
                      edge (minus collisionPadding). Using it as max-height
                      guarantees the dropdown never clips below the viewport,
                      even when the list is long (many termini + recents +
                      search results). overflow-y-auto makes the extra content
                      scrollable — overrides the base component's
                      overflow-hidden via Tailwind-merge (last overflow-*
                      class wins). overscroll-contain prevents touch scroll
                      chaining — once the user hits the top/bottom of the
                      dropdown list, further swipes don't scroll the map
                      behind it. */}
                  <DropdownMenuContent
                    align="start"
                    collisionPadding={16}
                    className="max-sm:w-[calc(100vw-2rem)] sm:max-w-[19rem] max-h-[var(--radix-dropdown-menu-content-available-height)] overflow-y-auto overscroll-contain"
                    // CRITICAL for mobile keyboard: prevent Radix from
                    // restoring focus to the dropdown trigger button when
                    // the dropdown closes. Without this, when we
                    // synchronously move focus to the mobile sheet's input
                    // (see onFocus below) and then call
                    // setPrimaryDropdownOpen(false), Radix's unmount
                    // cleanup yanks focus BACK to the trigger button — iOS
                    // sees focus transferred away from the input it was
                    // about to raise the keyboard for and cancels the
                    // keyboard. Calling preventDefault on the restoration
                    // event leaves focus wherever we put it.
                    onCloseAutoFocus={(e) => e.preventDefault()}
                  >
                    {/* Desktop layout — single flat section, no separator:
                          1. Synthetic primaries (Central London pinned first,
                             then Stratford, then any other synthetics)
                          2. Recents (default-seeded on first load, max 10) —
                             ALWAYS visible, even while searching. Same flat
                             list as the synthetics.
                          3. Search input (admin only; placeholder
                             "Other London stations")
                          4. Search matches — rendered BELOW the input so
                             they flow naturally from where the user is
                             typing.

                        On mobile the full-screen sheet takes over on input
                        focus and has its own top-down layout, so this
                        change only affects desktop.

                        London termini like Charing Cross, Victoria, Waterloo
                        et al. used to have permanent dropdown slots. They
                        no longer do — they're found via search, and promoted
                        into the recents list when picked. */}
                    {/* Pinned items (always shown, always at top) — the
                        first slot is reserved for Central London. Counted
                        against the cap below: pinned.length + visible
                        recents = 12 (≥sm) / 5 (<sm). */}
                    {pinnedPrimaries.map((origin) => (
                      <DropdownMenuItem
                        key={origin}
                        onSelect={() => onPrimaryOriginChange(origin)}
                        // Selected state shown via a muted background tint
                        // (accent colour at 50% opacity) rather than a
                        // left-side checkmark, which ate precious horizontal
                        // space and made long cluster names even harder to
                        // read on mobile.
                        className={cn(
                          "whitespace-normal leading-tight cursor-pointer",
                          origin === primaryOrigin && "bg-accent/50 focus:bg-accent/50"
                        )}
                      >
                        {originMenuName(origin)}
                      </DropdownMenuItem>
                    ))}

                    {/* Recents — user picks (top) merged with curated
                        defaults (below). Cap on TOTAL items (pinned +
                        recents) is 12 (≥sm) / 5 (<sm); items past the
                        mobile slice get `hidden sm:flex`. */}
                    {(() => {
                      const dedup = recentPrimaries.filter((c) => !pinnedPrimaries.includes(c))
                      const desktopRoom = Math.max(0, 12 - pinnedPrimaries.length)
                      const mobileRoom = Math.max(0, 5 - pinnedPrimaries.length)
                      return dedup.slice(0, desktopRoom).map((coord, idx) => {
                        // Label resolution, in order:
                        //   1. originMenuName(coord) if coord is a known origin
                        //      — picks up the rich "Kings Cross, St Pancras,
                        //      & Euston" label instead of just "Kings Cross".
                        //   2. coordToName[coord] — the station's own name
                        //      from stations.json (covers Stratford,
                        //      Farringdon, Kentish Town, etc.).
                        //   3. raw coord as last-ditch fallback.
                        const menu = originMenuName(coord)
                        const label = menu !== coord
                          ? menu
                          : coordToName[coord] ?? coord
                        return (
                          <DropdownMenuItem
                            key={coord}
                            onSelect={() => onCustomPrimarySelect?.(coord)}
                            className={cn(
                              "whitespace-normal leading-tight cursor-pointer",
                              coord === primaryOrigin && "bg-accent/50 focus:bg-accent/50",
                              idx >= mobileRoom && "hidden sm:flex",
                            )}
                          >
                            {label}
                          </DropdownMenuItem>
                        )
                      })
                    })()}

                    {/* Admin-only primaries — separate group below
                        the cap-counted section. Only rendered when
                        adminMode is on and there's at least one
                        entry. Not capped (admin tooling). */}
                    {adminOnlyPrimaries.length > 0 && (
                      <>
                        <DropdownMenuSeparator />
                        {adminOnlyPrimaries.map((origin) => (
                          <DropdownMenuItem
                            key={origin}
                            onSelect={() => onPrimaryOriginChange(origin)}
                            className={cn(
                              "whitespace-normal leading-tight cursor-pointer",
                              origin === primaryOrigin && "bg-accent/50 focus:bg-accent/50"
                            )}
                          >
                            {originMenuName(origin)}
                          </DropdownMenuItem>
                        ))}
                      </>
                    )}

                    {/* Search input + matches. Stations without full
                        RTT/TfL coverage still appear in matches but render
                        as disabled rows with a "Coming soon" tooltip — see
                        the !s.hasData branch below. */}
                    <>
                        {/* Search input at the bottom of the dropdown.
                            stopPropagation on keydown keeps Radix's built-in
                            typeahead from hijacking our keystrokes. */}
                        <div className="px-1.5 py-1">
                          <Input
                            type="text"
                            placeholder="Other London stations"
                            value={primarySearch}
                            onChange={(e) => setPrimarySearch(e.target.value)}
                            onKeyDown={(e) => e.stopPropagation()}
                            // On mobile (< sm), open the dedicated search sheet
                            // and transfer focus to its input SYNCHRONOUSLY
                            // within this gesture — that's the only reliable
                            // way iOS will keep the keyboard up and show the
                            // blinking caret when the sheet renders.
                            onFocus={() => {
                              if (typeof window !== "undefined" &&
                                  window.matchMedia("(max-width: 639px)").matches) {
                                mobileSheetInputRef.current?.focus()
                                setPrimaryDropdownOpen(false)
                                setMobileSearchOpen(true)
                              }
                            }}
                            className="h-7 text-xs px-2"
                          />
                        </div>

                        {/* Search matches — rendered BELOW the input so the
                            list flows naturally from where the user is typing.
                            Only appears when the search is active (3+ chars);
                            empty input keeps the dropdown to recents only.
                            Rows without data are wrapped in a Tooltip with
                            "Coming soon" content, rendered disabled, and their
                            onSelect is a no-op. */}
                        {isPrimarySearchActive && (
                          matchingStations.length > 0 ? (
                            matchingStations.map((s) => {
                          const isActive =
                            s.coord === primaryOrigin || s.primaryCoord === primaryOrigin
                          // Disabled rendering path: DropdownMenuItem's
                          // `disabled` prop handles keyboard/pointer
                          // selection blocking and applies data-disabled
                          // styling; we wrap it in a Tooltip for the
                          // hover hint. asChild on the trigger keeps
                          // the DOM flat.
                          if (!s.hasData) {
                            return (
                              <Tooltip key={s.primaryCoord}>
                                <TooltipTrigger asChild>
                                  {/* span wrapper because disabled
                                      DropdownMenuItems don't fire
                                      pointer events — Radix's Tooltip
                                      needs something focusable/hoverable
                                      as the trigger. */}
                                  <span className="block">
                                    <DropdownMenuItem
                                      disabled
                                      onSelect={(e) => e.preventDefault()}
                                      className="flex items-baseline gap-2 whitespace-normal leading-tight text-muted-foreground opacity-60 data-[disabled]:pointer-events-auto cursor-not-allowed"
                                    >
                                      <span>{s.name}</span>
                                      {/* Inline "Coming soon" suffix —
                                          smaller + further muted than the
                                          already-dimmed row text so it reads
                                          as a secondary status label, not a
                                          second line of the station name. */}
                                      <span className="text-xs text-muted-foreground/70">
                                        Coming soon
                                      </span>
                                    </DropdownMenuItem>
                                  </span>
                                </TooltipTrigger>
                                <TooltipContent side="right">
                                  Coming soon
                                </TooltipContent>
                              </Tooltip>
                            )
                          }
                          return (
                            <DropdownMenuItem
                              // key uses primaryCoord because dedupe collapses
                              // multiple cluster members into a single row.
                              key={s.primaryCoord}
                              onSelect={() => {
                                // Pass the station's own coord (not primaryCoord) —
                                // selectCustomPrimary's clusterMemberToPrimary
                                // redirect handles the rest, and preserves the
                                // historical behaviour where a cluster-member
                                // pick routes to its parent primary.
                                onCustomPrimarySelect?.(s.coord)
                                setPrimarySearch("")
                              }}
                              className={cn(
                                "whitespace-normal leading-tight cursor-pointer",
                                // Highlight the row if EITHER the matched
                                // station's coord OR its cluster primary is
                                // currently active.
                                isActive && "bg-accent/50 focus:bg-accent/50"
                              )}
                            >
                              {s.displayLabel}
                            </DropdownMenuItem>
                          )
                        })
                          ) : (
                            <div className="px-2 py-1.5 text-sm text-muted-foreground">
                              No matches
                            </div>
                          )
                        )}
                    </>
                  </DropdownMenuContent>
                </DropdownMenu>
              )}
            </span>
            {/* Shows the current value, styled as secondary info.
                shrink-0 keeps the max-time value at full width — the origin
                name on the left truncates instead. */}
            <span className="shrink-0 text-sm font-extrabold text-primary">
              {formatMax(maxMinutes)}
            </span>
          </div>
          {/* Wrapper gives position context for the fake animation overlay */}
          <div className="relative">
            {/* Real slider — invisible during the arrival animation so it
                doesn't flash at full width before the train has arrived */}
            <div ref={sliderWrapperRef} className={trainArriving || (bannerVisible && !hasAnimatedRef.current) ? "invisible" : ""}>
              <Slider
                // Non-admin: 30m floor — below ~30m even central London
                // destinations aren't useful. Admin: 15m floor for
                // debugging/filtering very-close destinations.
                min={adminMode ? 15 : 30}
                max={sliderMax}
                step={15}
                value={[maxMinutes]}
                // Slider returns an array (it supports multiple thumbs), so we take index 0
                onValueChange={([value]) => onChange(value)}
                /* Custom train-track styling — classes defined in globals.css */
                trackClassName="train-track-track"
                rangeClassName="train-track-range bg-transparent"
                thumbClassName="train-thumb"
                thumbContent={
                  /* Tabler TrainFilled icon — uses text-primary to inherit
                     the design system green via stroke="currentColor". */
                  <IconTrainFilled size={24} className="text-primary drop-shadow-sm" />
                }
              />
            </div>

            {/* Blank track placeholder — shows before the animation has ever run,
                so the slider area isn't empty but also doesn't reveal the train */}
            {bannerVisible && !hasAnimatedRef.current && !trainArriving && (
              <div className="absolute inset-0 flex items-center" aria-hidden="true">
                <div className="h-[1.1rem] w-full rounded-full bg-muted" />
              </div>
            )}

            {/* Fake slider overlay — purely cosmetic, plays the arrival animation.
                Mimics the real slider's structure: a muted track, a patterned range
                that grows, and a train icon that slides along with it.
                Positions are updated via refs in the rAF loop above — no re-renders. */}
            {trainArriving && (
              <div className="absolute inset-0 flex items-center" aria-hidden="true">
                {/* Track background — matches .train-track-track height + muted bg */}
                <div className="relative h-[1.1rem] w-full rounded-full bg-muted overflow-hidden">
                  {/* Range fill — starts at width:0%, JS animates to target */}
                  <div
                    ref={rangeRef}
                    className="train-track-range absolute inset-y-0 left-0"
                    style={{ width: "0%" }}
                  />
                </div>
                {/* Train icon — starts at left:0%, JS animates to target.
                    z-10 keeps the icon above the track pattern.
                    train-thumb reuses the real thumb's ::before pseudo-element
                    (a muted-colour block that hides the track behind the icon). */}
                <div
                  ref={thumbRef}
                  className="absolute top-1/2 z-10 -translate-y-1/2 -translate-x-1/2"
                  style={{ left: "0%" }}
                >
                  {/* Track-hiding block — sits behind the icon, same colour as
                      the unfilled track so the track pattern is hidden underneath */}
                  <span className="absolute inset-0 top-1/2 -translate-y-1/2 h-[1.1rem] rounded-full bg-muted -z-10" />
                  <IconTrainFilled size={24} className="relative z-10 text-primary drop-shadow-sm" />
                </div>
              </div>
            )}
          </div>

          {/* "Direct trains only" toggle for the primary origin.
              Hidden in admin mode — the "Direct" option in the
              Interchange dropdown below supersedes this checkbox there.
              Placed directly under the slider so the constraint is visually associated with it.
              Checkbox-first layout + text-xs makes this read as a secondary constraint, smaller than the main labels.
              size-3 shrinks the checkbox to 12px (from default 16px) to match the smaller label.
              gap-1.5 tightens the space between checkbox and label. */}
          {!adminMode && (
            <div className="mt-3 flex items-center gap-[0.4rem]">
              <Checkbox
                id="primary-direct-only"
                checked={primaryDirectOnly}
                onCheckedChange={(checked) => onPrimaryDirectOnlyChange(checked === true)}
                className="cursor-pointer size-3 data-checked:!bg-secondary data-checked:!border-secondary"
              />
              <Label htmlFor="primary-direct-only" className="cursor-pointer text-xs text-muted-foreground">Direct trains only</Label>
            </div>
          )}

          {/* Admin-only: "Interchange" filter. Slices destinations by
              where the user would CHANGE trains — each category has a
              distinct bug profile:
                —        Off (non-admin value; dropdown hidden there)
                Any      Any ≥1-change journey
                Inner    Change at a central-London terminus
                Outer    Change at a non-London-terminus station
                Low data Change at a station with no RTT data — the
                         most likely to contain routing bugs (admin-
                         mode default, for prioritising fetch work). */}
          {adminMode && (
            <div className="mt-1.5 flex items-center gap-[0.4rem]">
              <Label htmlFor="primary-interchange-filter" className="cursor-pointer text-xs text-muted-foreground">
                Interchange
              </Label>
              <select
                id="primary-interchange-filter"
                value={primaryInterchangeFilter}
                onChange={(e) => onPrimaryInterchangeFilterChange(
                  e.target.value as "off" | "direct" | "any" | "inner" | "outer" | "lowdata" | "gooddata",
                )}
                className="cursor-pointer rounded border border-input bg-transparent px-1 py-0.5 text-xs text-muted-foreground focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50"
              >
                <option value="off">—</option>
                <option value="direct">Direct</option>
                <option value="any">Any</option>
                <option value="inner">Inner</option>
                <option value="outer">Outer</option>
                <option value="lowdata">Low data</option>
                <option value="gooddata">Good data</option>
              </select>
            </div>
          )}

          {/* Admin-only: "Feature" filter. Slices destinations by
              which optional modal feature they'd surface on click
              (alt routes, private notes, etc). Useful for spot-
              checking coverage of specific features without clicking
              through every station. Label is singular on purpose —
              the dropdown picks ONE feature at a time. */}
          {adminMode && (
            <div className="mt-1.5 flex items-center gap-[0.4rem]">
              <Label htmlFor="primary-feature-filter" className="cursor-pointer text-xs text-muted-foreground">
                Feature
              </Label>
              <select
                id="primary-feature-filter"
                value={primaryFeatureFilter}
                onChange={(e) => onPrimaryFeatureFilterChange(
                  e.target.value as "off" | "alt-routes" | "private-notes" | "sloppy-pics" | "all-sloppy-pics" | "undiscovered" | "komoot" | "issues" | "no-travel-data" | "oyster",
                )}
                className="cursor-pointer rounded border border-input bg-transparent px-1 py-0.5 text-xs text-muted-foreground focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50"
              >
                <option value="off">—</option>
                <option value="alt-routes">Alternative routes</option>
                <option value="private-notes">Private notes</option>
                <option value="sloppy-pics">Sloppy pics</option>
                <option value="all-sloppy-pics">All sloppy pics</option>
                {/* "Undiscovered" — hides any station with at least one walk
                    we've personally logged in previousWalkDates. Surfaces
                    destinations still to explore. */}
                <option value="undiscovered">Undiscovered</option>
                {/* "Komoot" — keeps only stations with ≥1 attached walk
                    variant carrying a Komoot tour URL. Surfaces
                    destinations that already have a planned route. */}
                <option value="komoot">Komoot</option>
                {/* "Issues" — keeps only stations flagged via the admin
                    issue button. The flag is station-global, so the same
                    set shows regardless of which primary origin is selected. */}
                <option value="issues">Issues</option>
                {/* "No travel data" — keeps only stations whose
                    `londonMinutes` is null (no journey time from any
                    primary origin). Selecting this option auto-opens
                    both time sliders (max → admin ceiling, min → 0)
                    because passesTimeFilter() hides null-time stations
                    under any explicit constraint. */}
                <option value="no-travel-data">No travel data</option>
                {/* "Oyster" — keeps only stations within the TfL Oyster /
                    contactless PAYG fare zone. Includes Underground / DLR
                    / Elizabeth (Z-prefix CRS) plus the curated NR list
                    in data/oyster-stations.json. Auto-opens the time
                    sliders so no-RTT-data Underground stations still show. */}
                <option value="oyster">Oyster</option>
              </select>
            </div>
          )}

          {/* Admin-only: "Season" filter. Hides destinations whose
              recommended-seasons metadata doesn't include the selected
              season. Same style as the Feature dropdown — single-select
              native <select> sharing the interchange/feature styling. */}
          {adminMode && (
            <div className="mt-1.5 flex items-center gap-[0.4rem]">
              <Label htmlFor="primary-season-filter" className="cursor-pointer text-xs text-muted-foreground">
                Season
              </Label>
              <select
                id="primary-season-filter"
                value={seasonFilter}
                onChange={(e) => onSeasonFilterChange(
                  e.target.value as "off" | "Spring" | "Summer" | "Autumn" | "Winter" | "None",
                )}
                className="cursor-pointer rounded border border-input bg-transparent px-1 py-0.5 text-xs text-muted-foreground focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50"
              >
                <option value="off">—</option>
                <option value="Spring">Spring</option>
                <option value="Summer">Summer</option>
                <option value="Autumn">Autumn</option>
                <option value="Winter">Winter</option>
                {/* "None" = stations with zero month-flagged walks. Useful for
                    finding destinations that still need seasonality data. */}
                <option value="None">None</option>
              </select>
            </div>
          )}

          {/* Admin-only "Show all" — single-click reset that wipes every
              filter so the map shows the full station set. Useful when the
              admin has a dense filter combo applied and wants a clean
              slate. The actual state-setter calls live in map.tsx (where
              all the relevant useStates are declared); this button just
              fires the prop. Sits right under the admin dropdowns it
              resets, so the relationship reads spatially. */}
          {adminMode && (
            <div className="mt-1.5">
              <button
                onClick={onShowAll}
                className="rounded bg-primary px-2 py-1 font-mono text-xs text-primary-foreground transition-colors hover:bg-primary/90"
              >
                Show all
              </button>
            </div>
          )}

          {/* Admin-only: min travel time. Hides stations closer than this from the primary origin.
              Simpler styling than the max slider — no arrival animation, shares the train track visuals. */}
          {adminMode && (
            <div className="mt-3">
              <div className="mb-2 flex items-baseline justify-between">
                <span className="text-sm font-medium">Min time from {renderOriginLabel(primaryOrigin)}</span>
                <span className="text-sm font-extrabold text-primary">
                  {minMinutes === 0 ? "Off" : formatDuration(minMinutes)}
                </span>
              </div>
              <Slider
                min={0}
                // 600m = 10h. Admin-only slider (the whole block is
                // gated on adminMode further up) and this ceiling
                // matches the admin MAX slider's own 10h cap. Lets
                // an admin isolate destinations very far from London
                // for diffing algorithm output on edge-of-reach
                // stations in the north/west/south-west.
                max={600}
                step={15}
                value={[minMinutes]}
                onValueChange={([value]) => onMinChange(value)}
                trackClassName="train-track-track"
                rangeClassName="train-track-range bg-transparent"
                thumbClassName="train-thumb"
                thumbContent={
                  <IconTrainFilled size={24} className="text-primary drop-shadow-sm" />
                }
              />
            </div>
          )}

          {/* Friend origin: show slider when active, "Add friend" dropdown
              when not. Both states render the SAME unified dropdown
              content (pinned + recents + search), differing only in the
              trigger button and the "Remove friend's station" entry that
              appears at the top when a friend is currently active. */}
          {!friendOrigin && (
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button variant="ghost" size="xs" className="mt-1 -ml-2.5 cursor-pointer text-muted-foreground">
                  <IconPlus size={14} />
                  Add friend&apos;s home station
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent
                align="start"
                collisionPadding={16}
                className="max-sm:w-[calc(100vw-2rem)] sm:max-w-[19rem] max-h-[var(--radix-dropdown-menu-content-available-height)] overflow-y-auto overscroll-contain"
              >
                {renderFriendDropdownContent()}
              </DropdownMenuContent>
            </DropdownMenu>
          )}
          {friendOrigin && (
            <>
              {/* Label row with dropdown switcher and dismiss button.
                  Same layout tweaks as the primary row: min-w-0 on the flex
                  containers so long origin names truncate rather than wrap,
                  whitespace-nowrap on the label, shrink-0 on the value span. */}
              <div className="group mt-3 mb-2 flex items-baseline justify-between gap-2">
                <span className="flex min-w-0 items-center gap-1 text-sm font-medium">
                  <span className="relative whitespace-nowrap shrink-0">Max time from</span>
                  {/* Clicking the origin name or chevron opens the dropdown */}
                  <DropdownMenu>
                    <DropdownMenuTrigger asChild>
                      <button type="button" className="group/trigger relative inline-flex min-w-0 cursor-pointer items-center gap-0.5 rounded-md border-0 bg-transparent px-1.5 -mx-1.5 py-0.5 font-inherit text-inherit outline-none hover:text-accent-foreground focus-visible:ring-[3px] focus-visible:ring-ring/50 data-[state=open]:cursor-pointer before:absolute before:inset-0 before:rounded-md before:-z-10 hover:before:bg-accent">
                        <span className="truncate">{renderOriginLabel(friendOrigin)}</span>
                        <IconChevronDown size={12} className="shrink-0 text-muted-foreground group-hover/trigger:text-accent-foreground" />
                      </button>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent
                      align="start"
                      collisionPadding={16}
                      className="max-sm:w-[calc(100vw-2rem)] sm:max-w-[19rem] max-h-[var(--radix-dropdown-menu-content-available-height)] overflow-y-auto overscroll-contain"
                    >
                      {renderFriendDropdownContent()}
                    </DropdownMenuContent>
                  </DropdownMenu>
                </span>
                <span className="shrink-0 whitespace-nowrap text-sm font-extrabold text-primary">
                  {formatMax(friendMaxMinutes)}
                </span>
              </div>
              <Slider
                // Matches the home slider's floor — admin drops to 15m.
                min={adminMode ? 15 : 30}
                max={sliderMax}
                step={15}
                value={[friendMaxMinutes]}
                onValueChange={([value]) => onFriendMaxMinutesChange(value)}
                trackClassName="train-track-track"
                rangeClassName="train-track-range bg-transparent"
                thumbClassName="train-thumb"
                thumbContent={
                  <IconTrainFilled size={24} className="text-primary drop-shadow-sm" />
                }
              />
              {/* "Direct trains only" toggle for the friend origin — mirrors the primary one */}
              <div className="mt-3 flex items-center gap-[0.4rem]">
                <Checkbox
                  id="friend-direct-only"
                  checked={friendDirectOnly}
                  onCheckedChange={(checked) => onFriendDirectOnlyChange(checked === true)}
                  /* Same secondary-fill override as the primary direct-only checkbox */
                  className="cursor-pointer size-3 data-checked:!bg-secondary data-checked:!border-secondary"
                />
                {/* Shadcn Label — same pattern as the primary one */}
                <Label htmlFor="friend-direct-only" className="cursor-pointer text-xs text-muted-foreground">Direct trains only</Label>
              </div>
            </>
          )}

          {/* Rating visibility toggles — one checkbox per rating category */}
          <div className="mt-4 border-t pt-3 flex flex-col gap-1 sm:gap-0">
            {/* <span className="mb-2 block text-sm font-medium">Ratings</span> */}
            {RATING_FILTERS
              // adminOnly rows (e.g. "Excluded") only render when the secret admin toggle is on
              .filter(({ adminOnly }) => !adminOnly || adminMode)
              .map(({ key, label, icon, tooltip, secondary }) => (
              <div key={key} className="mt-1.5 flex items-center justify-between">
                {/* Tooltip wraps the icon + label so hovering/tapping them shows the description */}
                <LabelTip text={tooltip} icon={icon}>
                  {label}
                </LabelTip>
                <Checkbox
                  checked={visibleRatings.has(key)}
                  onCheckedChange={() => onToggleRating(key)}
                  /* secondary ratings get --secondary fill instead of --primary */
                  className={secondary
                    ? "cursor-pointer data-checked:!bg-secondary data-checked:!border-secondary"
                    : "cursor-pointer"
                  }
                />
              </div>
            ))}
          </div>

          {/* Map-layer toggles — admin-only. The whole block (including
             the border-t divider above it) hides for non-admin users so
             the public filter panel ends at the ratings section. */}
          {adminMode && (
            <div className="mt-4 border-t pt-3">
              {/* Current-season highlights toggle. Label updates
                 dynamically based on `currentSeason` from map.tsx. */}
              <div className="flex items-center justify-between">
                <LabelTip text={`Stations with walks recommended for ${currentSeason}`}>
                  <span className="text-sm font-medium">{currentSeason} highlights</span>
                </LabelTip>
                <Checkbox
                  checked={currentSeasonHighlight}
                  onCheckedChange={(checked) => onCurrentSeasonHighlightChange(checked === true)}
                  className="cursor-pointer"
                />
              </div>

              {/* Trails toggle — <div> instead of <label> so tapping the
                 gap on touchscreens doesn't toggle the checkbox.
                 mt-1.5 matches the rating-checkbox row spacing above so
                 the three map-layer toggles read as one tight stack. */}
              <div className="mt-1.5 flex items-center justify-between">
                <LabelTip text="Show sign-posted walking routes from OpenStreetMaps">
                  <span className="text-sm font-medium">Waymarked trails</span>
                </LabelTip>
                <Checkbox
                  checked={showTrails}
                  onCheckedChange={(checked) => onToggleTrails(checked === true)}
                  className="cursor-pointer"
                />
              </div>

              {/* Regions toggle — labels for English, Welsh and Scottish
                  counties + national parks + AONBs / National Landscapes.
                  Off by default. */}
              <div className="mt-1.5 flex items-center justify-between">
                <LabelTip text="Show labels for counties, national parks, and AONBs / National Landscapes">
                  <span className="text-sm font-medium">Counties &amp; landscapes</span>
                </LabelTip>
                <Checkbox
                  checked={showRegions}
                  onCheckedChange={(checked) => onToggleRegions(checked === true)}
                  className="cursor-pointer"
                />
              </div>
            </div>
          )}
        </div>
      </div>
    </div>

    {/* Mobile-only search sheet. Opens when the dropdown's inline "Other
        stations" input is focused on a < sm viewport. Put at the end of
        the return so it overlays everything, including the Radix dropdown
        portal. Hidden on sm+ (sm:hidden).

        The sheet is ALWAYS MOUNTED on mobile (not conditionally rendered)
        so its input ref is valid before `mobileSearchOpen` flips. That
        matters for iOS: the keyboard only rises when focus() is called
        synchronously inside the user's gesture. Mounting the sheet
        lazily on state change pushes the focus() call a few ticks past
        the gesture boundary and iOS refuses to raise the keyboard. With
        the sheet always present, the dropdown input's onFocus handler
        can focus the sheet input directly before the state change —
        inside the gesture — and the keyboard comes up reliably with a
        blinking caret.

        Visibility is controlled via translate-y (off-screen vs on-screen)
        + pointer-events (nothing can be clicked while "closed").
          • translate-y-full + pointer-events-none: closed, invisible.
          • translate-y-0: open, interactive.
        Transition duration 280ms matches the photo-overlay's mobile
        slide-up. */}
      {/* Backdrop — dark semi-transparent scrim + blur behind the sheet.
          Matches the photo-overlay's DialogOverlay visual. Rendered as a
          sibling of the sheet at a slightly lower z so the sheet floats
          above it. The backdrop's own fade-in is tied to sheetEntered so
          it transitions in with the sheet's slide-up. Tapping the backdrop
          is NOT a dismiss vector here (the X button is the dismiss path)
          — pointer-events-none while closed so it doesn't eat touches
          intended for the app underneath; auto while open. */}
      <div
        className={cn(
          "fixed inset-0 z-[59] bg-black/50 backdrop-blur-sm sm:hidden",
          "transition-opacity duration-[280ms] ease-out",
          sheetEntered ? "opacity-100 pointer-events-auto" : "opacity-0 pointer-events-none",
        )}
        aria-hidden="true"
      />
      <div
        className={cn(
          // `fixed inset-x-0 z-[60]` — full width, above everything. top
          // and height are driven by inline style below (from
          // visualViewport) so the sheet tracks the VISIBLE viewport,
          // not the layout viewport. Dropping the old Tailwind `top-8
          // bottom-0` is what prevents iOS from pushing the sheet above
          // the top of the visible area when the keyboard is up.
          "fixed inset-x-0 z-[60] flex flex-col bg-background rounded-t-2xl shadow-2xl",
          // Transition is enabled except while a live drag is in progress
          // — during active dragging the sheet must track the finger 1:1
          // with no animation lag. When the drag is released OR the
          // open/closed state changes, the transition runs on the inline
          // transform below.
          !isDragging && "transition-transform duration-[280ms] ease-out",
          "sm:hidden",
          !mobileSearchOpen && dragOffset === 0 && "pointer-events-none",
        )}
        // CRITICAL: drive all translate-Y via a SINGLE inline transform,
        // not Tailwind classes. The transform stacks the open/closed
        // position with the active drag offset so CSS transitions see a
        // single interpolating value. With the old class-based approach
        // (translate-y-0 vs translate-y-full), releasing a drag mid-way
        // caused a brief frame where the class transform said "open" but
        // the inline transform was gone — the sheet visibly snapped up
        // before the effect-driven close animation took over, producing
        // the juddery feel. Stacking both into the inline transform means
        // any state change animates smoothly from the current screen
        // position.
        //
        // `top` and `height` come from visualViewport — see vvMetrics
        // effect above. The 32px offset on top matches the old `top-8`
        // spacing (1 rem × 2). `height - 32` keeps the sheet's bottom
        // exactly at the top edge of the keyboard when it's up, so
        // nothing extends behind the keyboard.
        style={{
          top: vvMetrics.top + 32,
          height: Math.max(0, vvMetrics.height - 32),
          transform: sheetEntered
            ? `translateY(${dragOffset}px)`
            : `translateY(calc(100% + ${dragOffset}px))`,
        }}
        // NOTE: deliberately NO aria-hidden here. The sheet's input is
        // focused SYNCHRONOUSLY from the dropdown trigger's onFocus
        // handler (to give iOS an unbroken gesture → focus → keyboard
        // chain). Marking the subtree aria-hidden at that moment
        // prevents Safari/iOS from accepting the programmatic focus,
        // so the keyboard never appears. Pointer-events-none on the
        // class above already keeps the closed sheet from blocking
        // taps behind it.
      >
        {/* Top bar. The input has the clear/dismiss X BUILT-IN as an
            absolute-positioned button — always visible so users can dismiss
            even before typing. Wrapper is relative so the X positions over
            the input's right edge.

            The whole top area (drag handle + input row) is a swipe-down
            dismiss target: pointerDown captures the start Y, pointerMove
            progressively translates the sheet down as the user drags,
            pointerUp commits if the drag exceeded ~80px or the velocity
            was downward, otherwise the sheet snaps back. See
            mobileSheetDragHandlers below for the underlying state machine. */}
        <div
          className="px-3 pt-3 pb-2 shrink-0 touch-none"
          {...mobileSheetDragHandlers}
        >
          {/* Drag-handle hint bar at the top centre — same visual language
              as the photo-overlay mobile sheet. Acts as the primary
              swipe-down grab target. */}
          <div className="mx-auto mb-3 h-1 w-10 rounded-full bg-muted" />
          <div className="relative">
            <input
              ref={mobileSheetInputRef}
              type="text"
              // Deliberately NO autoFocus — the sheet is permanently
              // mounted, so autoFocus would only fire once (at app
              // load, when the sheet is offscreen and closed) and do
              // nothing on subsequent opens. Focus is driven
              // imperatively from the dropdown trigger's onFocus
              // handler instead, which runs inside the user's tap
              // gesture and therefore lets iOS raise the keyboard.
              value={primarySearch}
              placeholder="Search"
              onChange={(e) => setPrimarySearch(e.target.value)}
              // pr-10 reserves space for the always-visible clear/dismiss
              // X button (absolute-positioned over the right edge).
              className="w-full h-10 rounded-lg border border-input bg-input/30 pl-3 pr-10 text-sm outline-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50"
            />
            {/* Always-visible X. Two behaviours:
                  • If the input has content → clear the input (keep sheet
                    open, keep keyboard up for continued typing).
                  • If the input is empty → dismiss the sheet entirely.
                Handled on **pointerDown** rather than click so the action
                fires immediately, even if iOS is about to dismiss the
                keyboard or transfer focus. With onClick the browser first
                processes the focus change + keyboard dismissal (a layout
                shift), which on iOS delays or even swallows the click —
                the dreaded "tap once to dismiss keyboard, tap again to
                activate the button" pattern. onPointerDown runs before
                any of that, guaranteeing the close/clear commits on the
                user's very first touch. preventDefault stops the browser
                from then transferring focus to the button (which would
                un-focus the input and flicker the keyboard). */}
            <button
              type="button"
              tabIndex={-1}
              aria-label={primarySearch ? "Clear search" : "Close search"}
              onPointerDown={(e) => {
                e.preventDefault()
                if (primarySearch) {
                  setPrimarySearch("")
                  mobileSheetInputRef.current?.focus()
                } else {
                  closeMobileSearchOnly()
                }
              }}
              className="absolute right-1 top-1/2 flex h-8 w-8 -translate-y-1/2 items-center justify-center rounded-md text-muted-foreground hover:text-foreground"
            >
              <IconX size={18} />
            </button>
          </div>
        </div>

        {/* Results / empty-state area. overflow-y-auto lets long result
            lists scroll inside the sheet; onScroll blurs the input when
            the user actually scrolls (matching iOS native "scroll-to-
            dismiss-keyboard" UX). We use onScroll rather than onTouchStart
            because the latter fires on every tap — including taps on
            result buttons — which caused iOS to eat the first click
            dismissing the keyboard before registering the button press.
            Scrolling doesn't fire on discrete taps, so tapping a button
            stays a single-tap action. */}
        <div
          className="flex-1 overflow-y-auto overscroll-contain"
          onScroll={() => mobileSheetInputRef.current?.blur()}
        >
          {isPrimarySearchActive ? (
            matchingStations.length > 0 ? (
              matchingStations.map((s) => {
                // Stations without RTT data render as a non-interactive
                // div instead of a button — no hover tooltip on mobile
                // (touch has no hover), just the visual disabled state
                // and the row showing only the station name. Per design:
                // mobile users learn from context that grey rows aren't
                // selectable yet.
                if (!s.hasData) {
                  return (
                    <div
                      key={s.primaryCoord}
                      className="flex items-baseline gap-2 w-full text-left px-4 py-3 text-sm border-b border-border/30 text-muted-foreground opacity-60 cursor-not-allowed"
                    >
                      <span>{s.name}</span>
                      {/* Same "Coming soon" suffix as the desktop path —
                          small + further muted than the row text. Mobile
                          can't show a tooltip on hover, so this inline
                          label is the only signal for why the row is
                          disabled. */}
                      <span className="text-xs text-muted-foreground/70">
                        Coming soon
                      </span>
                    </div>
                  )
                }
                return (
                  <button
                    // key uses primaryCoord because dedupe may collapse
                    // multiple cluster members to one row.
                    key={s.primaryCoord}
                    type="button"
                    tabIndex={-1}
                    onClick={() => {
                      // Pass the station's own coord — selectCustomPrimary
                      // canonicalises to the cluster primary via
                      // clusterMemberToPrimary.
                      onCustomPrimarySelect?.(s.coord)
                      closeAllAfterSelection()
                    }}
                    className={cn(
                      "block w-full text-left px-4 py-3 text-sm border-b border-border/30",
                      // Highlight when either the match's own coord OR its
                      // cluster primary is the active primary.
                      (s.coord === primaryOrigin || s.primaryCoord === primaryOrigin) && "bg-accent/50",
                    )}
                  >
                    {s.displayLabel}
                  </button>
                )
              })
            ) : (
              <div className="px-4 py-3 text-sm text-muted-foreground">No matches</div>
            )
          ) : (
            // Empty state. User requested the sheet always opens blank —
            // no recents pre-populated, even when the currently-active
            // primary is a custom one. Recents still show if the user
            // searches for them (they appear among matching stations).
            <div className="px-4 py-6 text-center text-sm text-muted-foreground">
              Search for any National Rail station in London
            </div>
          )}
        </div>
      </div>
    </>
  )
}
