"use client"

import { IconTrainFilled, IconChevronUp, IconChevronDown } from "@tabler/icons-react"
import SearchBar from "@/components/search-bar"
import { Checkbox } from "@/components/ui/checkbox"
import { Slider } from "@/components/ui/slider"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import { useRef, useState } from "react"

// Wraps any inline content with a tooltip that works on both desktop (hover)
// and touchscreens (tap toggles open/closed). Uses controlled `open` state
// so Radix honours our state while still closing on blur.
// On touch devices, tapping the label only shows the tooltip — it won't
// bubble up to toggle a parent <label>'s checkbox.
function LabelTip({ text, children }: { text: string; children: React.ReactNode }) {
  const [open, setOpen] = useState(false)
  // Tracks whether the click originated from a touch event
  const touchedRef = useRef(false)
  return (
    <Tooltip open={open} onOpenChange={setOpen}>
      <TooltipTrigger asChild>
        <span
          className="cursor-default"
          // Flag that a touch just happened — the click handler checks this
          onTouchStart={() => { touchedRef.current = true }}
          onClick={(e) => {
            if (touchedRef.current) {
              // Stop the click from reaching the parent <label>,
              // so the checkbox doesn't toggle on tap
              e.preventDefault()
              touchedRef.current = false
            }
            setOpen((v) => !v)
          }}
        >
          {children}
        </span>
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
      <svg width="12" height="12" viewBox="0 0 24 24" fill="var(--primary)" stroke="var(--primary)" strokeWidth="1.5">
        <polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2" />
      </svg>
    ),
  },
  {
    key: "verified", label: "Good", tooltip: "A hiking spot I can personally recommend —TrainToGreen creator",
    icon: (
      <svg width="12" height="12" viewBox="0 0 24 24" fill="var(--primary)" stroke="var(--primary)" strokeWidth="1.5">
        <polygon points="12 3, 22.39 21, 1.61 21" />
      </svg>
    ),
  },
  {
    key: "unverified", label: "Probably", secondary: true, tooltip: "Reputably recommended, but unvisited by me —TrainToGreen creator",
    icon: (
      <svg width="12" height="12" viewBox="0 0 24 24" fill="var(--secondary)" stroke="var(--secondary)" strokeWidth="1.5">
        <polygon points="12 3, 22.39 21, 1.61 21" />
      </svg>
    ),
  },
  {
    key: "not-recommended", label: "Unworthy", secondary: true, tooltip: "All green is good but I personally wouldn't bother going here again —TrainToGreen creator",
    icon: (
      <svg width="12" height="12" viewBox="0 0 24 24" fill="var(--secondary)" stroke="var(--secondary)" strokeWidth="1.5">
        <polygon points="12 21, 22.39 3, 1.61 3" />
      </svg>
    ),
  },
  {
    key: "unrated", label: "Unknown", secondary: true, tooltip: "I have no opinion about this area —TrainToGreen creator",
    icon: (
      <svg width="12" height="12" viewBox="0 0 24 24" fill="var(--secondary)" stroke="var(--secondary)" strokeWidth="1.5">
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
}

export default function FilterPanel({ maxMinutes, onChange, showTrails, onToggleTrails, visibleRatings, onToggleRating, searchQuery, onSearchChange, adminMode }: FilterPanelProps) {
  // Collapsed state — only meaningful on mobile; desktop never shows the toggle button
  const [collapsed, setCollapsed] = useState(false)

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
    <div className="absolute left-4 right-4 top-4 z-10 rounded-lg border bg-card p-4 text-card-foreground shadow-md sm:right-auto sm:w-64">

      {/* Header row: logo on the left, collapse toggle on the right (mobile only) */}
      {/* gap-4 on mobile for breathing room between logo and button; sm:gap-0 removes it */}
      <div className="mb-0 sm:mb-1 flex items-center justify-between gap-2">
        {/* Logo — mask-image uses the SVG as a stencil filled by bg-primary */}
        <div
          className="h-8 w-full cursor-pointer bg-primary sm:cursor-default"
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
          className="shrink-0 rounded p-1 text-primary sm:hidden cursor-pointer -translate-y-0.5"
          aria-label={collapsed ? "Expand filters" : "Collapse filters"}
        >
          {/* Chevron flips direction to signal the current action */}
          {/* strokeLinecap="square" sharpens the line ends; strokeLinejoin="miter" sharpens the corner */}
          {collapsed
            ? <IconChevronDown size={24} stroke={4.5} strokeLinecap="square" strokeLinejoin="miter" />
            : <IconChevronUp   size={24} stroke={4.5} strokeLinecap="square" strokeLinejoin="miter" />
          }
        </button>
      </div>
      {/* Extra bottom breathing room when collapsed — the card's p-4 is there but feels tight */}
      {/* {collapsed && <div className="h-2 sm:hidden" />} */}

      {/* Everything below the logo is hidden when collapsed on mobile.
          On sm+ collapsed is irrelevant because the toggle button is hidden. */}
      {!collapsed && (
        <>
          {/* mt-3 on mobile adds the space that was previously on the header row;
              sm:mt-0 removes it since desktop never collapsed */}
          {/* Search bar only shows when admin mode is toggled on */}
          {adminMode && (
            <div className="mb-4 mt-3 sm:mt-0">
              <SearchBar value={searchQuery} onChange={onSearchChange} />
            </div>
          )}
          <div id="SLIDER-LABEL" className="mt-3 sm:mt-0 mb-3 flex items-baseline justify-between">
            <LabelTip text={`Showing all stations within ${formatDuration(maxMinutes)} public transport travel from central London on a Saturday morning`}>
              <span className="text-sm font-medium">Max time from London</span>
            </LabelTip>
            {/* Shows the current value, styled as secondary info */}
            <span className="text-sm font-extrabold text-primary">
              {formatDuration(maxMinutes)}
            </span>
          </div>
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
              /* Lucide TrainFront icon — uses text-primary to inherit
                 the design system green via stroke="currentColor". */
              <IconTrainFilled size={20} className="text-primary drop-shadow-sm" />
            }
          />

          {/* Rating visibility toggles — one checkbox per rating category */}
          <div className="mt-4 border-t pt-3">
            {/* <span className="mb-2 block text-sm font-medium">Ratings</span> */}
            {RATING_FILTERS.map(({ key, label, icon, tooltip, secondary }) => (
              <div key={key} className="mt-1.5 flex items-center justify-between">
                {/* Tooltip wraps the icon + label so hovering/tapping them shows the description */}
                <LabelTip text={tooltip}>
                  <span className="flex items-center gap-2.5 text-sm font-medium">
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
        </>
      )}
    </div>
  )
}
