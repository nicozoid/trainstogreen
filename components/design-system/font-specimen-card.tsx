"use client"

/**
 * Card for a font FAMILY (not a named style). Different from the
 * TypeSpecimenCard because:
 *
 *   - The class string is just `font-sans` or `font-mono` — the
 *     interesting thing is the family itself, not a size/weight combo.
 *   - For variable fonts (General Sans), we render the sample at
 *     each weight in the ladder so you can see the axis range.
 *
 * The metadata block surfaces the CSS variable, the loaded family
 * name (live-resolved), and where the family is loaded.
 */

import type { FontSpecimen } from "@/lib/design-system/typography"
import { CopyableCode } from "./copyable-code"
import {
  formatFontFamily,
  useComputedTextStyle,
} from "./use-computed-text-style"

export function FontSpecimenCard({ font }: { font: FontSpecimen }) {
  const { style, ref } = useComputedTextStyle()

  return (
    <div className="overflow-hidden rounded-lg border border-border bg-card">
      {/* --- Sample area ----------------------------------------- */}
      <div className="border-b border-border bg-muted/20 p-6">
        {font.weights ? (
          // Variable-font ladder — render the same chunk at each
          // weight. We set fontWeight inline because Tailwind class
          // weights are an enum (font-light, font-medium…); inline
          // gives us the exact numeric values we want to demonstrate
          // (200, 300, 400, …) including odd ones.
          <div ref={ref} className={font.classes}>
            {font.weights.map((w) => (
              <div key={w} className="mb-3 last:mb-0">
                {/* Weight label sits to the left of the line */}
                <span className="mr-3 inline-block w-10 text-right font-mono text-xs text-muted-foreground align-middle">
                  {w}
                </span>
                <span style={{ fontWeight: w }}>{font.sample}</span>
              </div>
            ))}
          </div>
        ) : (
          // Static font — single rendering at the default weight.
          <p ref={ref} className={font.classes}>
            {font.sample}
          </p>
        )}
      </div>

      {/* --- Metadata block ------------------------------------- */}
      <div className="space-y-3 p-4">
        <p className="text-sm font-semibold">{font.name}</p>

        <div>
          <p className="mb-1 text-xs text-muted-foreground">Class</p>
          <CopyableCode value={font.classes} />
        </div>

        <dl className="grid grid-cols-[5rem_1fr] gap-y-1 font-mono text-xs">
          <dt className="text-muted-foreground">var</dt>
          <dd>{font.cssVar}</dd>

          <dt className="text-muted-foreground">family</dt>
          <dd className="break-all">{formatFontFamily(style.fontFamily) || "…"}</dd>

          {font.weights && (
            <>
              <dt className="text-muted-foreground">weights</dt>
              <dd>
                {Math.min(...font.weights)}–{Math.max(...font.weights)}
              </dd>
            </>
          )}

          <dt className="text-muted-foreground">loaded in</dt>
          <dd>{font.loadedIn}</dd>
        </dl>

        <p className="text-xs text-foreground/80">{font.description}</p>
      </div>
    </div>
  )
}
