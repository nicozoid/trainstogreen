"use client"

import { IconTrainFilled, IconChevronDown } from "@tabler/icons-react"
import SearchBar from "@/components/search-bar"
import { Checkbox } from "@/components/ui/checkbox"
import { Slider } from "@/components/ui/slider"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import { useEffect, useRef, useState } from "react"

// Wraps any inline content with a tooltip that works on both desktop (hover)
// and touchscreens (tap toggles open/closed). Uses controlled `open` state
// so Radix honours our state while still closing on blur.
// On touch devices, tapping the label only shows the tooltip — it won't
// bubble up to toggle a parent <label>'s checkbox.
function LabelTip({ text, children }: { text: string; children: React.ReactNode }) {
  const [open, setOpen] = useState(false)
  // Tracks whether the click originated from a touch event
  const touchedRef = useRef(false)
  // After a manual close-via-click, briefly ignore Radix's open signals
  // (hover, focus, pointerdown) so the tooltip doesn't flicker back open.
  const lockUntilRef = useRef(0)
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
          {children}
        </button>
      </TooltipTrigger>
      <TooltipContent>{text}</TooltipContent>
    </Tooltip>
  )
}

// Each rating category with its display label, colour, and inline SVG icon
// matching the map markers exactly: star, triangle-up, triangle-down, circle.
const RATING_FILTERS: { key: string; label: string; icon: React.ReactNode; tooltip: string; secondary?: boolean }[] = [
  {
    key: "highlight", label: "Heavenly", tooltip: "One of my favourite hiking spots —TrainToGreen creator",
    icon: (
      /* w-[0.75rem] h-[0.75rem] uses rem so the icon scales with the root font-size; scale-125 makes the star a bit bigger than the rest */
      <svg viewBox="1 1 22 22" fill="var(--primary)" stroke="var(--primary)" strokeWidth="1.5" className="w-[1rem] h-[1rem]">
        <polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2" />
      </svg>
    ),
  },
  {
    key: "verified", label: "Good", tooltip: "A hiking spot I can personally recommend —TrainToGreen creator",
    icon: (
      <svg viewBox="0 0 24 24" fill="var(--primary)" stroke="var(--primary)" strokeWidth="1.5" className="w-[1rem] h-[1rem]">
        <polygon points="12 3, 22.39 21, 1.61 21" />
      </svg>
    ),
  },
  {
    key: "unverified", label: "Probably", secondary: true, tooltip: "Reputably recommended, but unvisited by me —TrainToGreen creator",
    icon: (
      <svg viewBox="1 2 22 20" fill="var(--secondary)" stroke="var(--secondary)" strokeWidth="1.5" className="w-[1rem] h-[1rem]">
        {/* Hexagon: 6 vertices at radius 10, wider than tall */}
        <polygon points="22,12 17,20.66 7,20.66 2,12 7,3.34 17,3.34" />
      </svg>
    ),
  },
  {
    key: "not-recommended", label: "Unworthy", secondary: true, tooltip: "All green is good but I personally wouldn't bother going here again —TrainToGreen creator",
    icon: (
      <svg viewBox="0 0 24 24" fill="var(--secondary)" stroke="var(--secondary)" strokeWidth="1.5" className="w-[1rem] h-[1rem]">
        <polygon points="12 21, 22.39 3, 1.61 3" />
      </svg>
    ),
  },
  {
    key: "unrated", label: "Unknown", secondary: true, tooltip: "I have no opinion about this area —TrainToGreen creator",
    icon: (
      <svg viewBox="0 0 24 24" fill="var(--secondary)" stroke="var(--secondary)" strokeWidth="1.5" className="w-[1rem] h-[1rem]">
        <circle cx="12" cy="12" r="9" />
      </svg>
    ),
  },
]

type FilterPanelProps = {
  maxMinutes: number
  onChange: (value: number) => void
  showTrails: boolean
  onToggleTrails: (value: boolean) => void
  visibleRatings: Set<string>
  onToggleRating: (key: string) => void
  searchQuery: string
  onSearchChange: (value: string) => void
  adminMode: boolean
  /** Whether the welcome banner is currently showing */
  bannerVisible: boolean
}

export default function FilterPanel({ maxMinutes, onChange, showTrails, onToggleTrails, visibleRatings, onToggleRating, searchQuery, onSearchChange, adminMode, bannerVisible }: FilterPanelProps) {
  // Collapsed state — only meaningful on mobile; desktop never shows the toggle button
  const [collapsed, setCollapsed] = useState(false)

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
  const trainProgressRef = useRef(0)
  const rangeRef = useRef<HTMLDivElement>(null)
  const thumbRef = useRef<HTMLDivElement>(null)
  const sliderWrapperRef = useRef<HTMLDivElement>(null)
  const prevBannerRef = useRef(bannerVisible)

  useEffect(() => {
    if (prevBannerRef.current && !bannerVisible) {
      // Read the real Radix thumb's actual left value so the animation
      // lands in exactly the same spot — avoids a 1px jump on handoff.
      let targetPercent = ((maxMinutes - 45) / (180 - 45)) * 100
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

  return (
    // On mobile: left-4 right-4 stretches the card to full width minus margin on both sides.
    // On sm+: right-auto + w-64 revert to the fixed sidebar width.
    <div className="absolute left-4 right-4 top-4 z-10 rounded-lg bg-card p-4 text-card-foreground shadow-md sm:right-auto sm:w-64">

      {/* Header row: logo on the left, collapse toggle on the right (mobile only) */}
      {/* gap-4 on mobile for breathing room between logo and button; sm:gap-0 removes it */}
      <div id="LOGO_AND_COLLAPSE_STACK" className="mb-0 sm:mb-1 flex items-center justify-between gap-2">
        {/* Logo — mask-image uses the SVG as a stencil filled by bg-primary */}
        <div
          className="w-full aspect-[597/51] cursor-pointer bg-primary sm:cursor-default"
          role="img"
          aria-label="Trains to Green"
          onClick={() => setCollapsed((v) => !v)}
          style={{
            maskImage: "url(/trainstogreen-logo.svg)",
            maskSize: "contain",
            maskRepeat: "no-repeat",
            WebkitMaskImage: "url(/trainstogreen-logo.svg)",
            WebkitMaskSize: "contain",
            WebkitMaskRepeat: "no-repeat",
          }}
        />
        {/* sm:hidden — this button is only relevant on narrow viewports */}
        <button
          type="button"
          onClick={() => setCollapsed((v) => !v)}
          className="shrink-0 rounded p-0 text-primary sm:hidden cursor-pointer -translate-y-0"
          aria-label={collapsed ? "Expand filters" : "Collapse filters"}
        >
          {/* transition-transform + duration-200 animates the rotation smoothly */}
          {/* rotate-180 flips the chevron to point up when expanded */}
          <IconChevronDown
            size={24} stroke={4.5}
            strokeLinecap="square" strokeLinejoin="miter"
            className={`transition-transform duration-200 ${collapsed ? "rotate-0" : "rotate-180"}`}
          />
        </button>
      </div>
      {/* Extra bottom breathing room when collapsed — the card's p-4 is there but feels tight */}
      {/* {collapsed && <div className="h-2 sm:hidden" />} */}

      {/* Collapsible content wrapper — uses the CSS grid row trick to animate
          height between 0 and "auto". grid-rows-[0fr] collapses to zero height,
          grid-rows-[1fr] expands to the content's natural height, and
          transition-[grid-template-rows] animates smoothly between them.
          On sm+ the panel never collapses, so we force grid-rows-[1fr]. */}
      <div className={`grid transition-[grid-template-rows] duration-300 ease-in-out sm:grid-rows-[1fr] ${
        collapsed ? "grid-rows-[0fr]" : "grid-rows-[1fr]"
      }`}>
        {/* overflow-hidden clips the content as the grid row shrinks to 0 */}
        <div className="overflow-hidden">
          {/* mt-3 on mobile adds the space that was previously on the header row;
              sm:mt-0 removes it since desktop never collapsed */}
          {/* Search bar only shows when admin mode is toggled on */}
          {adminMode && (
            <div className="mb-4 mt-3 sm:mt-0">
              <SearchBar value={searchQuery} onChange={onSearchChange} />
            </div>
          )}
          <div id="SLIDER-LABEL" className="mt-4 mb-2 flex items-baseline justify-between">
            <LabelTip text={`Showing all stations within ${formatDuration(maxMinutes)} public transport travel from central London on a Saturday morning`}>
              <span className="text-sm font-medium">Max time from London</span>
            </LabelTip>
            {/* Shows the current value, styled as secondary info */}
            <span className="text-sm font-extrabold text-primary">
              {formatDuration(maxMinutes)}
            </span>
          </div>
          {/* Wrapper gives position context for the fake animation overlay */}
          <div className="relative">
            {/* Real slider — invisible during the arrival animation so it
                doesn't flash at full width before the train has arrived */}
            <div ref={sliderWrapperRef} className={trainArriving ? "invisible" : ""}>
              <Slider
                min={45}
                max={180}
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

          {/* Rating visibility toggles — one checkbox per rating category */}
          <div className="mt-4 border-t pt-3 flex flex-col gap-1 sm:gap-0">
            {/* <span className="mb-2 block text-sm font-medium">Ratings</span> */}
            {RATING_FILTERS.map(({ key, label, icon, tooltip, secondary }) => (
              <div key={key} className="mt-1.5 flex items-center justify-between">
                {/* Tooltip wraps the icon + label so hovering/tapping them shows the description */}
                <LabelTip text={tooltip}>
                  <span className="flex items-center gap-3 text-sm font-medium">
                    {icon}
                    {label}
                  </span>
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

          {/* Trails toggle — <div> instead of <label> so tapping the gap
             on touchscreens doesn't toggle the checkbox */}
          <div className="mt-4 flex items-center justify-between border-t pt-3">
            <LabelTip text="Show sign-posted walking routes from OpenStreetMaps">
              <span className="text-sm font-medium">Waymarked trails</span>
            </LabelTip>
            <Checkbox
              checked={showTrails}
              onCheckedChange={(checked) => onToggleTrails(checked === true)}
              className="cursor-pointer"
            />
          </div>
        </div>
      </div>
    </div>
  )
}
