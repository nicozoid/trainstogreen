/**
 * Layout tokens page — non-colour CSS variables (spacing, radii)
 * plus structural primitives (breakpoints, root font-size) that
 * aren't variables but behave like tokens because everything else
 * is built on top of them.
 *
 * Animations USED to live here; they've moved to the Motion page so
 * we can group them by what they communicate (loading, modal entry,
 * state changes, etc.) and check for consistency across surfaces.
 *
 * Each section uses its own visualisation component so the demo
 * matches the token's meaning — a bar for spacing, a curved square
 * for radii, a horizontal strip for breakpoints.
 */

import { BreakpointStrip } from "@/components/design-system/breakpoint-strip"
import { RadiusSquare } from "@/components/design-system/radius-square"
import { RootFontSizeCard } from "@/components/design-system/root-font-size-card"
import { SpacingBar } from "@/components/design-system/spacing-bar"
import { PageHeader, Section } from "@/components/design-system/section"
import {
  TOKENS_SOURCE_FILE,
  radiusTokens,
  spacingTokens,
} from "@/lib/design-system/tokens"

export default function LayoutTokensPage() {
  // Same isPublic filter as the colours page — keeps the rule
  // uniform so admin-only tokens never leak in.
  const visibleSpacing = spacingTokens.filter((t) => t.isPublic)
  const visibleRadii = radiusTokens.filter((t) => t.isPublic)

  return (
    <>
      <PageHeader
        title="Layout tokens"
        subtitle="Non-colour primitives — spacing, radii, breakpoints, root font-size. (Animations have moved to the Motion page.)"
        sourceFile={TOKENS_SOURCE_FILE}
      />

      {/* --- Spacing --------------------------------------------- */}
      <Section
        title="Spacing"
        description="Tailwind utilities like p-1, gap-2, mt-4 multiply --spacing by the index. The bars below show 1×, 2×, 4×, 8×, 16×."
      >
        <div className="grid gap-3 [grid-template-columns:repeat(auto-fill,minmax(18rem,1fr))]">
          {visibleSpacing.map((t) => (
            <SpacingBar key={t.cssVar} token={t} />
          ))}
        </div>
      </Section>

      {/* --- Border radius -------------------------------------- */}
      <Section
        title="Border radius"
        description="--radius is the base; every other --radius-* token is calc(--radius × n). Re-tune the whole app's roundness from one variable."
      >
        <div className="grid gap-3 [grid-template-columns:repeat(auto-fill,minmax(14rem,1fr))]">
          {visibleRadii.map((t) => (
            <RadiusSquare key={t.cssVar} token={t} />
          ))}
        </div>
      </Section>

      {/* --- Breakpoints ---------------------------------------- */}
      <Section
        title="Breakpoints"
        description="Tailwind v4 defaults. Resize the window — the marker tracks your viewport."
      >
        <BreakpointStrip />
      </Section>

      {/* --- Root font size ------------------------------------- */}
      <Section
        title="Root font size"
        description="The html element's font-size — sets 1rem for the whole app. Bumped on small viewports."
      >
        <RootFontSizeCard />
      </Section>
    </>
  )
}
