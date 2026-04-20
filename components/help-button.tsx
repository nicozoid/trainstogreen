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
      // Mobile overrides (max-sm:):
      //   • bg-background/20 — very faint fill so the map reads through
      //     but there's still a subtle chip shape. At this small size
      //     the full desktop 60% fill made the icon feel like a heavy
      //     sticker sitting on the map.
      //   • border-input/30 — outline variant's border drops to 30%
      //     opaque so the small chip doesn't look like it has a heavy
      //     ring around it at mobile size.
      //   • size-5 shrinks the button to roughly half the default 36px
      //     icon-button size.
      //   • [&_svg]:size-3 shrinks the inner SVG in proportion.
      className="bg-background/60 backdrop-blur-sm hover:bg-background transition-colors cursor-pointer max-sm:bg-background/20 max-sm:border-input/30 max-sm:size-5 max-sm:[&_svg]:!size-3"
    >
      <CircleHelp className="size-4" />
    </Button>
  )
}
