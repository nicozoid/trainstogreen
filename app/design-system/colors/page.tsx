/**
 * Colours page — renders the full palette in two top-level groups
 * (semantic tokens, then raw palette), each subdivided into bands
 * (Surface, Foreground, Tree, Beach …).
 *
 * The data comes from lib/design-system/colors.ts. The values are
 * resolved live via getComputedStyle inside <ColorSwatch>.
 */

import { ColorSwatch } from "@/components/design-system/color-swatch"
import { PageHeader, Section } from "@/components/design-system/section"
import {
  COLORS_SOURCE_FILE,
  rawColorGroups,
  semanticColorGroups,
  type ColorGroup,
} from "@/lib/design-system/colors"

// Pulled out into a helper because we render the same grid for both
// semantic and raw groups — only the data differs.
function ColorGrid({ group }: { group: ColorGroup }) {
  // Filter out tokens flagged isPublic === false. Currently nothing
  // is hidden, but the rule is enforced uniformly.
  const visibleTokens = group.tokens.filter((t) => t.isPublic)
  if (visibleTokens.length === 0) return null

  return (
    <Section title={group.title} description={group.description}>
      {/* Auto-fill grid: each card is at least 14rem wide, the grid
          lays out as many columns as fit. minmax(14rem, 1fr) lets
          the cards stretch to fill the row. */}
      <div className="grid gap-3 [grid-template-columns:repeat(auto-fill,minmax(14rem,1fr))]">
        {visibleTokens.map((token) => (
          <ColorSwatch key={token.cssVar} token={token} />
        ))}
      </div>
    </Section>
  )
}

export default function ColorsPage() {
  return (
    <>
      <PageHeader
        title="Colour"
        subtitle="Every colour token in the system. Toggle the theme with the icon top-right to see dark-mode values."
        sourceFile={COLORS_SOURCE_FILE}
      />

      {/* --- Semantic tokens --------------------------------------- */}
      {/* Big band heading separates the two top-level groups. We
          repeat this pattern for the raw palette below. */}
      <h2 className="mb-2 text-2xl font-semibold tracking-tight">Semantic tokens</h2>
      <p className="mb-8 text-sm text-muted-foreground">
        These are the names components reference. Each one resolves to a raw token
        via <code className="font-mono">var(...)</code> — shown under each swatch.
      </p>
      {semanticColorGroups.map((group) => (
        <ColorGrid key={group.title} group={group} />
      ))}

      {/* Visible divider between groups */}
      <hr className="my-12 border-border" />

      {/* --- Raw palette ------------------------------------------ */}
      <h2 className="mb-2 text-2xl font-semibold tracking-tight">Raw palette</h2>
      <p className="mb-8 text-sm text-muted-foreground">
        The building blocks. Semantic tokens above are aliases for these.
      </p>
      {rawColorGroups.map((group) => (
        <ColorGrid key={group.title} group={group} />
      ))}
    </>
  )
}
