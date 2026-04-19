"use client"

import { CircleHelp } from "lucide-react"
import { Button } from "@/components/ui/button"

/**
 * Icon button that re-opens the welcome banner. Styled identically to
 * ThemeToggle (same variant, size, backdrop blur, hover state) so the
 * two read as a matching pair when displayed side-by-side.
 *
 * Positioning is the caller's responsibility — this component just
 * renders the button itself.
 */
// onClick receives the button's own screen-centre coords so the caller
// can animate the welcome banner out FROM the button rather than from the
// map's London hexagon. We read the centre via getBoundingClientRect on
// the element that fired the click — more stable than the cursor position
// (which varies depending on where the user clicked within the button).
export function HelpButton({
  onClick,
}: {
  onClick: (origin: { x: number; y: number }) => void
}) {
  return (
    <Button
      variant="outline"
      size="icon"
      onClick={(e) => {
        const rect = e.currentTarget.getBoundingClientRect()
        onClick({ x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 })
      }}
      aria-label="Show welcome banner"
      // bg-background/60 = semi-transparent fill so the map peeks through;
      // backdrop-blur-sm softens whatever's underneath. Matches ThemeToggle.
      className="bg-background/60 backdrop-blur-sm hover:bg-background transition-colors cursor-pointer"
    >
      <CircleHelp className="size-4" />
    </Button>
  )
}
