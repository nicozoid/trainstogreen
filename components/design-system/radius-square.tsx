"use client"

/**
 * Visualises a border-radius variable as a square with that radius
 * applied to all four corners. Inline borderRadius style references
 * the live token, so editing --radius in globals.css updates every
 * card.
 */

import { TokenCard } from "./token-card"
import { useCssVar } from "./use-css-var"
import type { TokenEntry } from "@/lib/design-system/tokens"

export function RadiusSquare({ token }: { token: TokenEntry }) {
  const { value, ref } = useCssVar(token.cssVar)
  const displayName = token.name ?? token.cssVar.replace(/^--/, "")

  // 56×56 square — large enough that the curve is obvious for
  // small radii, not so large that big radii become circles.
  const visualisation = (
    <div ref={ref}>
      <div
        className="size-14 border-2 border-primary bg-primary/15"
        style={{ borderRadius: `var(${token.cssVar})` }}
      />
    </div>
  )

  return (
    <TokenCard
      visualisation={visualisation}
      name={displayName}
      value={value}
      description={token.description}
      usedIn={token.usedIn}
    />
  )
}
