"use client"

/**
 * Live demos for the Macromolecules tier — the two domain-region components.
 *
 * Macromolecules are big, product-specific compositions. Mounting them in
 * the DS isn't free:
 *
 *   - WelcomeBanner is small enough to mount with real props — we
 *     give it a trigger button that flips its `open` state and let
 *     the real component handle the modal lifecycle.
 *
 *   - FilterPanel needs ~50 props of station/origin metadata. Rather
 *     than thread all of that through, we feed it a minimal stub —
 *     enough to render in its public-mode default state. Toggles and
 *     dropdowns still work (they update local state) but no real
 *     filtering happens. The point is to SHOW the component, not to
 *     replicate the full app.
 */

import { useState } from "react"
import FilterPanel from "@/components/filter-panel"
import { WelcomeBanner } from "@/components/welcome-banner"
import { Button } from "@/components/ui/button"

// --- WelcomeBanner ---------------------------------------------------
// Trigger button that opens the real component. The banner portals
// itself to a fixed-position overlay; closing returns to the DS.
export function WelcomeBannerDemo() {
  const [open, setOpen] = useState(false)

  return (
    <div className="flex flex-col gap-3">
      <Button onClick={() => setOpen(true)}>Open welcome banner</Button>
      {/* The banner is mounted unconditionally — it has its own
          internal "isClosing" animation state that needs to be
          preserved across the open/close cycle. Keeping it in the
          tree lets the close transition play out. */}
      <WelcomeBanner open={open} onDismiss={() => setOpen(false)} />
      <p className="text-xs text-muted-foreground italic">
        Click to open. The banner overlays the entire DS surface — backdrop
        click, X, or pressing Escape returns you here.
      </p>
    </div>
  )
}

// --- FilterPanel -----------------------------------------------------
// Public-mode default state. The shape of the stub data matches what
// the real app passes (see components/map.tsx around line 7603). Most
// admin-only props are present but inert because adminMode is false.
export function FilterPanelDemo() {
  // Filter state — all local. Setters update local state only; no
  // station data is actually filtered by anything.
  const [maxMinutes, setMaxMinutes] = useState(120)
  const [minMinutes, setMinMinutes] = useState(0)
  const [showTrails, setShowTrails] = useState(false)
  const [showRegions, setShowRegions] = useState(true)
  const [visibleRatings, setVisibleRatings] = useState<Set<string>>(
    new Set(["4", "3", "2", "1", "unrated"]),
  )
  const [searchQuery, setSearchQuery] = useState("")
  const [primaryOrigin, setPrimaryOrigin] = useState("Charing Cross")
  const [friendOrigin, setFriendOrigin] = useState<string | null>(null)
  const [friendMaxMinutes, setFriendMaxMinutes] = useState(120)
  const [primaryDirectOnly, setPrimaryDirectOnly] = useState(false)
  const [friendDirectOnly, setFriendDirectOnly] = useState(false)
  const [currentMonthHighlight, setCurrentMonthHighlight] = useState(false)

  // Stub maps — every helper accepts an arbitrary key and returns
  // either a sensible default or the key itself.
  const ORIGIN_NAMES: Record<string, string> = {
    "Charing Cross": "Charing Cross",
    Reading: "Reading",
    Brighton: "Brighton",
    Cambridge: "Cambridge",
  }

  return (
    // FilterPanel's root uses `absolute top-2 left-4 sm:w-64` — it
    // expects to anchor to a positioned ancestor (the map's
    // h-full w-full relative wrapper in components/map.tsx). We
    // recreate that positioning context here so the panel renders
    // INSIDE the demo card rather than escaping to the body. The
    // height needs to be tall enough to fit every section at the
    // panel's typical default state.
    <div className="relative h-[36rem] w-full overflow-hidden rounded-md border border-dashed border-border">
      <FilterPanel
        maxMinutes={maxMinutes}
        onChange={setMaxMinutes}
        minMinutes={minMinutes}
        onMinChange={setMinMinutes}
        showTrails={showTrails}
        onToggleTrails={setShowTrails}
        showRegions={showRegions}
        onToggleRegions={setShowRegions}
        // Admin "Show all" — no-op in the demo.
        onShowAll={() => {}}
        visibleRatings={visibleRatings}
        onToggleRating={(key: string) => {
          setVisibleRatings((prev) => {
            const next = new Set(prev)
            if (next.has(key)) next.delete(key)
            else next.add(key)
            return next
          })
        }}
        // Solo a rating — collapse the visible set to just this key.
        onSoloRating={(key: string) => setVisibleRatings(new Set([key]))}
        searchQuery={searchQuery}
        onSearchChange={setSearchQuery}
        // Public mode — no admin toggles render.
        adminMode={false}
        bannerVisible={false}
        primaryOrigin={primaryOrigin}
        // Pinned primary IDs — keeping the demo state minimal.
        pinnedPrimaries={["Charing Cross"]}
        onPrimaryOriginChange={setPrimaryOrigin}
        originDisplayName={(key) => ORIGIN_NAMES[key] ?? key}
        originMenuName={(key) => ORIGIN_NAMES[key] ?? key}
        searchableStations={[]}
        recentPrimaries={[]}
        onCustomPrimarySelect={() => {}}
        coordToName={{}}
        friendOrigin={friendOrigin}
        pinnedFriends={[]}
        recentFriends={[]}
        searchableFriendStations={[]}
        onFriendOriginChange={setFriendOrigin}
        friendMaxMinutes={friendMaxMinutes}
        onFriendMaxMinutesChange={setFriendMaxMinutes}
        onActivateFriend={() => setFriendOrigin("Reading")}
        onDeactivateFriend={() => setFriendOrigin(null)}
        primaryDirectOnly={primaryDirectOnly}
        onPrimaryDirectOnlyChange={setPrimaryDirectOnly}
        primaryInterchangeFilter="off"
        onPrimaryInterchangeFilterChange={() => {}}
        primaryFeatureFilter="off"
        onPrimaryFeatureFilterChange={() => {}}
        sourceFilter="off"
        onSourceFilterChange={() => {}}
        monthFilter="off"
        onMonthFilterChange={() => {}}
        currentMonthLabel="May"
        currentMonthHighlight={currentMonthHighlight}
        onCurrentMonthHighlightChange={setCurrentMonthHighlight}
        friendDirectOnly={friendDirectOnly}
        onFriendDirectOnlyChange={setFriendDirectOnly}
        // hideNoTravelTime is admin-only in practice but the prop is
        // required — default to true (the public default).
        hideNoTravelTime={true}
        onHideNoTravelTimeChange={() => {}}
      />
    </div>
  )
}
