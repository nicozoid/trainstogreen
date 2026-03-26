"use client"

import { IconTrainFilled } from "@tabler/icons-react"
import SearchBar from "@/components/search-bar"
import { Checkbox } from "@/components/ui/checkbox"
import { Slider } from "@/components/ui/slider"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import { HugeiconsIcon } from "@hugeicons/react"
import { InformationCircleIcon } from "@hugeicons/core-free-icons"

// Tiny info-circle tooltip — reused next to every checkbox
function InfoTip({ text }: { text: string }) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button className="ml-1 text-muted-foreground" type="button">
          <HugeiconsIcon icon={InformationCircleIcon} size={14} />
        </button>
      </TooltipTrigger>
      <TooltipContent>{text}</TooltipContent>
    </Tooltip>
  )
}

// Each rating category with its display label, colour, and inline SVG icon
// matching the map markers exactly: star, triangle-up, triangle-down, circle.
const RATING_FILTERS: { key: string; label: string; icon: React.ReactNode; tooltip: string }[] = [
  {
    key: "highlight", label: "Favourite", tooltip: "One of my favourite hiking spots —TrainToGreen creator",
    icon: (
      <svg width="12" height="12" viewBox="0 0 24 24" fill="var(--primary)" stroke="var(--primary)" strokeWidth="1.5">
        <polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2" />
      </svg>
    ),
  },
  {
    key: "verified", label: "Recommended", tooltip: "A hiking spot I can personally recommend —TrainToGreen creator",
    icon: (
      <svg width="12" height="12" viewBox="0 0 24 24" fill="var(--primary)" stroke="var(--primary)" strokeWidth="1.5">
        <polygon points="12 3, 22.39 21, 1.61 21" />
      </svg>
    ),
  },
  {
    key: "unverified", label: "To-do", tooltip: "Reputably recommended, but unvisited by me —TrainToGreen creator",
    icon: (
      <svg width="12" height="12" viewBox="0 0 24 24" fill="#aed0b8" stroke="#aed0b8" strokeWidth="1.5">
        <polygon points="12 3, 22.39 21, 1.61 21" />
      </svg>
    ),
  },
  {
    key: "not-recommended", label: "Unworthy", tooltip: "All green is good but I personally wouldn't bother going here again —TrainToGreen creator",
    icon: (
      <svg width="12" height="12" viewBox="0 0 24 24" fill="#aed0b8" stroke="#aed0b8" strokeWidth="1.5">
        <polygon points="12 21, 22.39 3, 1.61 3" />
      </svg>
    ),
  },
  {
    key: "unrated", label: "Unknown", tooltip: "I have no opinion about this area —TrainToGreen creator",
    icon: (
      <svg width="12" height="12" viewBox="0 0 24 24" fill="#aed0b8" stroke="#aed0b8" strokeWidth="1.5">
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
}

export default function FilterPanel({ maxMinutes, onChange, showTrails, onToggleTrails, visibleRatings, onToggleRating, searchQuery, onSearchChange }: FilterPanelProps) {
  // Convert minutes to hours + minutes for display (e.g. 90 → "1h 30m")
  function formatDuration(mins: number) {
    if (mins < 60) return `${mins}m`
    const h = Math.floor(mins / 60)
    const m = mins % 60
    return m === 0 ? `${h}h` : `${h}h ${m}m`
  }

  return (
    // Positioned over the map, top-left, using card tokens from the design system
    <div className="absolute left-4 top-4 z-10 w-64 rounded-lg border bg-card p-4 text-card-foreground shadow-md">

      <h1 className="text-md text-green-800 font-semibold pb-4 flex items-center gap-3 tracking-wide">
        <IconTrainFilled size={18} className="text-primary" />
        Trains to Green
      </h1>
      {/* Search bar — sits at the top of the sidebar */}
      <div className="mb-4">
        <SearchBar value={searchQuery} onChange={onSearchChange} />
      </div>
      <div className="mb-3 flex items-baseline justify-between">
        <span className="text-sm font-medium">Maximum travel time</span>
        {/* Shows the current value, styled as secondary info */}
        <div className="flex items-center gap-1">
          <span className="text-sm font-extrabold text-green-600">
            {formatDuration(maxMinutes)}
          </span>
          <Tooltip>
            <TooltipTrigger asChild>
              <button className="ml-1 text-muted-foreground">
                <HugeiconsIcon icon={InformationCircleIcon} size={14} />
              </button>
            </TooltipTrigger>
            <TooltipContent>Showing all stations within {formatDuration(maxMinutes)} of Farringdon Station on a Saturday morning</TooltipContent>
          </Tooltip>
        </div>
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
        <span className="mb-2 block text-sm font-medium">Ratings</span>
        {RATING_FILTERS.map(({ key, label, icon, tooltip }) => (
          <label key={key} className="mt-1.5 flex items-center justify-between">
            <span className="flex items-center gap-2.5 text-sm">
              {icon}
              {label}
            </span>
            <span className="flex items-center gap-1">
              <Checkbox
                checked={visibleRatings.has(key)}
                onCheckedChange={() => onToggleRating(key)}
                className="cursor-pointer"
              />
              <InfoTip text={tooltip} />
            </span>
          </label>
        ))}
      </div>

      {/* Trails toggle — label wraps the checkbox so clicking the text also toggles it.
         Radix Checkbox uses checked/onCheckedChange instead of the native onChange. */}
      <label className="mt-4 flex items-center justify-between border-t mt-4 pt-3">
        <span className="text-sm font-medium">Waymarked trails</span>
        <span className="flex items-center gap-1">
          <Checkbox
            checked={showTrails}
            onCheckedChange={(checked) => onToggleTrails(checked === true)}
            className="cursor-pointer"
          />
          <InfoTip text="Show sign-posted walking routes from OpenStreetMaps" />
        </span>
      </label>


    </div>
  )
}
