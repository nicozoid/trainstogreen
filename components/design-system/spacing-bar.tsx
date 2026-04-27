"use client"

/**
 * Visualises a spacing variable as a row of bars at multiplier
 * widths. Tailwind's spacing utilities (`p-1`, `gap-2`, …) use the
 * index to multiply the base. So a 1× bar shows what `p-1` looks
 * like, 2× shows `p-2`, etc.
 *
 * Renders inside a TokenCard. The probe ref is attached so we can
 * read the resolved value back at the page level.
 */

import { TokenCard } from "./token-card"
import { useCssVar } from "./use-css-var"
import type { TokenEntry } from "@/lib/design-system/tokens"

// Picked so the row covers a useful range without being too wide:
// 1 (a hairline), 2 (gap-2), 4 (p-4), 8 (gap-8), 16 (a chunky pad).
const MULTIPLIERS = [1, 2, 4, 8, 16]

export function SpacingBar({ token }: { token: TokenEntry }) {
  const { value, ref } = useCssVar(token.cssVar)
  const displayName = token.name ?? token.cssVar.replace(/^--/, "")

  // The visualisation: a column of bars, each labelled with its
  // multiplier. Width is set inline via calc() so it's anchored to
  // the live value — if --spacing changes, the bars resize.
  const visualisation = (
    <div ref={ref} className="flex w-full flex-col gap-2">
      {MULTIPLIERS.map((m) => (
        <div key={m} className="flex items-center gap-3">
          {/* Multiplier label, monospace + fixed width so all rows
              align regardless of digit count. */}
          <span className="w-8 shrink-0 font-mono text-xs text-muted-foreground">
            {m}×
          </span>
          {/* The bar itself. style.width uses calc so it tracks the
              live token value. h-3 = 12px so the bars are tall enough
              to read on dense screens. bg-primary so they pop against
              the card. */}
          <div
            className="h-3 rounded bg-primary"
            style={{ width: `calc(var(${token.cssVar}) * ${m})` }}
          />
        </div>
      ))}
    </div>
  )

  return (
    <TokenCard
      visualisation={visualisation}
      name={displayName}
      value={value}
      description={token.description}
    />
  )
}
