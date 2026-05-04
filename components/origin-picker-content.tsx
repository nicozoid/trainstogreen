"use client"

/**
 * OriginPickerContent — the shared dropdown-content body used by both
 * the primary-origin picker and the friend-origin picker in
 * filter-panel.tsx. Renders four sections in order:
 *
 *   1. Pinned items (CLON for the primary side; empty for friends today)
 *   2. Recents (already-merged user picks + curated defaults from the
 *      caller — this component doesn't do the merging)
 *   3. Search input
 *   4. Search results (when the search query is "active", typically ≥3 chars)
 *
 * Both pickers feed in their own `searchableStations` + `matchingStations`
 * arrays plus a small slot-specific config (active-row variant, search
 * placeholder, mobile-search-sheet trigger). Search state stays in the
 * caller so the primary side's mobile sheet and the desktop dropdown can
 * share the same query string.
 *
 * Phase 4b extracts this from filter-panel.tsx — the two pickers used to
 * have ~150 + ~250 lines of mostly-duplicated JSX. The structural patterns
 * were the same; only the active-row affordance and the mobile-sheet
 * focus-handler diverged.
 */

import { IconX } from "@tabler/icons-react"
import { DropdownMenuItem } from "@/components/ui/dropdown-menu"
import { Input } from "@/components/ui/input"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import { cn } from "@/lib/utils"

// Same row shape filter-panel passes via FilterPanelProps.searchableStations.
// Duplicated here so this module doesn't have to import the giant
// FilterPanelProps interface.
export type SearchableStation = {
  coord: string
  name: string
  crs: string
  primaryCoord: string
  displayLabel: string
  hasData: boolean
  ineligibleLabel?: string
  searchKeywords?: string[]
}

export type OriginPickerContentProps = {
  /** Which picker this is — drives active-row affordance and the
   *  set of slot-specific behaviours. */
  slot: "primary" | "friend"
  /** Currently-selected origin ID (`primaryOrigin` or `friendOrigin`).
   *  Used to highlight the matching row. */
  selectedId: string | null
  /** Pinned IDs — always rendered first, never evicted. */
  pinnedIds: string[]
  /** Recents IDs — already merged with curated defaults by the caller. */
  recentIds: string[]
  /** Pre-computed search matches (active when length > 0; the caller
   *  decides via `searchActive` whether to render this section). */
  matchingStations: SearchableStation[]
  /** True when the search bar has enough query to trigger results
   *  rendering. When false, the matches block is hidden entirely. */
  searchActive: boolean
  /** Search input value + setter — kept in the caller so the primary
   *  side can share state between the dropdown and its mobile sheet. */
  searchQuery: string
  onSearchChange: (q: string) => void
  /** Search input placeholder text. Primary uses "Other London stations"
   *  (London-bbox); friend uses "Other stations" (UK-wide). */
  searchPlaceholder: string
  /** Display callbacks — same shape as the FilterPanel-wide ones. */
  originMenuName: (key: string) => string
  coordToName: Record<string, string>
  /** Pinned + recents row click: passes the row's ID. Both sides do the
   *  same thing here. */
  onSelect: (id: string) => void
  /** Search-result row click. Primary's caller passes `row.coord` to its
   *  selectCustomPrimary which handles cluster-member-to-anchor
   *  redirect; friend's caller passes `row.primaryCoord` directly to
   *  onFriendOriginChange (already the anchor). The component just
   *  hands the row over and lets the caller pick the right field. */
  onSearchResultSelect: (row: SearchableStation) => void
  /** Friend-side only: clicking the active row deactivates the friend
   *  rather than re-selecting it. Renders an X icon + destructive-on-hover. */
  onDeactivate?: () => void
  /** Primary-side mobile UX: when the input gets focus on a narrow
   *  viewport, the caller swaps the dropdown for a full-screen sheet.
   *  Friend-side: undefined (stays in the dropdown on mobile). */
  onSearchInputFocus?: () => void
}

export default function OriginPickerContent({
  slot,
  selectedId,
  pinnedIds,
  recentIds,
  matchingStations,
  searchActive,
  searchQuery,
  onSearchChange,
  searchPlaceholder,
  originMenuName,
  coordToName,
  onSelect,
  onSearchResultSelect,
  onDeactivate,
  onSearchInputFocus,
}: OriginPickerContentProps) {
  const isFriend = slot === "friend"
  // Recents excluding pinned (pinned items are rendered separately
  // above; same item shouldn't appear twice). Same logic both sides.
  const recents = recentIds.filter((c) => !pinnedIds.includes(c))
  // Cap on recents alone — pinned counts separately. Mobile subtracts
  // the pinned count to keep small viewports compact.
  const desktopRoom = 12
  const mobileRoom = Math.max(0, 8 - pinnedIds.length)

  // Single row renderer. Three branches:
  //   - Active + friend slot → X-and-deactivate affordance
  //   - Active + primary slot → highlight only
  //   - Inactive → standard selectable row
  const renderRow = (id: string, idx?: number) => {
    const menu = originMenuName(id)
    const label = menu !== id ? menu : coordToName[id] ?? id
    const isActive = id === selectedId
    const hiddenOnMobile = idx != null && idx >= mobileRoom
    if (isActive && isFriend) {
      // Friend slot's active row doubles as the deactivate button.
      // group/friend-row exposes the hover state to the X icon below
      // so it can scale + thicken its stroke on hover.
      return (
        <DropdownMenuItem
          key={id}
          onSelect={() => onDeactivate?.()}
          className={cn(
            "group/friend-row flex items-center justify-between gap-2 whitespace-normal leading-tight cursor-pointer bg-accent/50 hover:bg-destructive focus:bg-destructive hover:text-white focus:text-white",
            hiddenOnMobile && "hidden sm:flex",
          )}
          aria-label={`Remove ${label} as friend's station`}
        >
          <span>{label}</span>
          <IconX
            size={14}
            className="shrink-0 transition-transform group-hover/friend-row:scale-110 group-hover/friend-row:stroke-[2.5]"
          />
        </DropdownMenuItem>
      )
    }
    return (
      <DropdownMenuItem
        key={id}
        onSelect={() => onSelect(id)}
        className={cn(
          "whitespace-normal leading-tight cursor-pointer",
          isActive && "bg-accent/50 focus:bg-accent/50",
          hiddenOnMobile && "hidden sm:flex",
        )}
      >
        {label}
      </DropdownMenuItem>
    )
  }

  return (
    <>
      {/* Pinned items (always shown, always at top). For the primary
          picker this is CLON (Central London); for friends it's
          currently empty but reserved for future curated picks. */}
      {pinnedIds.map((id) => renderRow(id))}
      {/* User recents merged with curated defaults — caller did the
          merge. Cap is on recents alone (pinned has its own slot above);
          items past the mobile slice get `hidden sm:flex`. */}
      {recents.slice(0, desktopRoom).map((id, idx) => renderRow(id, idx))}
      {/* Search input. stopPropagation on keydown blocks Radix's
          built-in typeahead from hijacking keystrokes. The primary
          picker also opens a full-screen mobile sheet on focus — the
          caller passes onSearchInputFocus to set that up. */}
      <div className="px-1.5 py-1">
        <Input
          type="text"
          placeholder={searchPlaceholder}
          value={searchQuery}
          onChange={(e) => onSearchChange(e.target.value)}
          onKeyDown={(e) => e.stopPropagation()}
          onFocus={onSearchInputFocus}
          className="h-7 text-xs px-2"
        />
      </div>
      {/* Search results. Hidden when the query is too short. When
          shown but empty, renders a "No matches" placeholder. */}
      {searchActive && (
        matchingStations.length > 0 ? (
          matchingStations.map((s) => {
            // Highlight the row when EITHER the matched station's coord
            // OR its cluster primary is currently selected — covers
            // cluster-member-resolves-to-anchor.
            const isActive =
              s.coord === selectedId || s.primaryCoord === selectedId
            // Disabled (Coming soon / TfL station — no data / Ghost station)
            // rendering: tooltip on hover with the specific reason.
            if (!s.hasData) {
              return (
                <Tooltip key={s.primaryCoord}>
                  <TooltipTrigger asChild>
                    {/* span wrapper because disabled DropdownMenuItems don't
                        fire pointer events — Radix's Tooltip needs something
                        focusable/hoverable as the trigger. */}
                    <span className="block">
                      <DropdownMenuItem
                        disabled
                        onSelect={(e) => e.preventDefault()}
                        className="flex items-baseline gap-2 whitespace-normal leading-tight text-muted-foreground opacity-60 data-[disabled]:pointer-events-auto cursor-not-allowed"
                      >
                        <span>{s.displayLabel}</span>
                        <span className="text-xs text-muted-foreground/70">
                          {s.ineligibleLabel ?? "Coming soon"}
                        </span>
                      </DropdownMenuItem>
                    </span>
                  </TooltipTrigger>
                  <TooltipContent side="right">
                    {s.ineligibleLabel ?? "Coming soon"}
                  </TooltipContent>
                </Tooltip>
              )
            }
            return (
              <DropdownMenuItem
                key={s.primaryCoord}
                onSelect={() => {
                  onSearchResultSelect(s)
                  onSearchChange("")
                }}
                className={cn(
                  "whitespace-normal leading-tight cursor-pointer",
                  isActive && "bg-accent/50 focus:bg-accent/50",
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
  )
}

