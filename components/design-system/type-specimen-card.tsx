"use client"

/**
 * One named type-style card. Sample text rendered with the
 * specimen's class string, plus a metadata table showing the
 * live-resolved computed font properties and the file paths that
 * use this style.
 */

import type { TypeSpecimen } from "@/lib/design-system/typography"
import { CopyableCode } from "./copyable-code"
import {
  formatFontFamily,
  useComputedTextStyle,
} from "./use-computed-text-style"

export function TypeSpecimenCard({ specimen }: { specimen: TypeSpecimen }) {
  // Probe sits alongside the visible sample so we can read the
  // resolved font metrics without showing the probe to the user.
  // Both elements get the same classes — the probe is invisible
  // (opacity-0 + h-0) but still present in the cascade.
  const { style, ref } = useComputedTextStyle()

  return (
    <div className="overflow-hidden rounded-lg border border-border bg-card">
      {/* --- Sample area ----------------------------------------- */}
      {/* Larger top region so long samples (the body specimens)
          breathe. p-6 = 24px-ish at default rem; min-h-24 ensures
          short labels don't collapse the card. */}
      <div className="min-h-24 border-b border-border bg-muted/20 p-6">
        {/* The actual sample, with the specimen's classes applied
            verbatim. We intentionally do NOT add layout overrides
            here — what you see is what the class string produces. */}
        <p className={specimen.classes}>{specimen.sample}</p>

        {/* The probe — same classes, but invisible. Used by
            useComputedTextStyle to read resolved metrics. */}
        <div ref={ref} className={specimen.classes} aria-hidden style={{ height: 0, opacity: 0, overflow: "hidden" }}>
          {/* Some content so the probe has computed metrics. */}
          x
        </div>
      </div>

      {/* --- Metadata block ------------------------------------- */}
      <div className="space-y-3 p-4">
        {/* Specimen name — the human-readable label. */}
        <p className="text-sm font-semibold">{specimen.name}</p>

        {/* The class string — copy-on-click. */}
        <div>
          <p className="mb-1 text-xs text-muted-foreground">Class</p>
          <CopyableCode value={specimen.classes} />
        </div>

        {/* Computed-style table. Each row is a 5rem label + flexible
            value column; consistent column gives the values a clean
            vertical alignment.
            We resolve fontFamily through formatFontFamily() to strip
            Next.js's auto-generated font-loader IDs. */}
        <dl className="grid grid-cols-[5rem_1fr] gap-y-1 font-mono text-xs">
          <dt className="text-muted-foreground">family</dt>
          <dd className="break-all">{formatFontFamily(style.fontFamily) || "…"}</dd>

          <dt className="text-muted-foreground">size</dt>
          <dd>{style.fontSize || "…"}</dd>

          <dt className="text-muted-foreground">weight</dt>
          <dd>{style.fontWeight || "…"}</dd>

          <dt className="text-muted-foreground">leading</dt>
          <dd>{style.lineHeight || "…"}</dd>

          <dt className="text-muted-foreground">tracking</dt>
          <dd>{style.letterSpacing === "normal" ? "0" : style.letterSpacing || "…"}</dd>
        </dl>

        {/* Description */}
        <p className="text-xs text-foreground/80">{specimen.description}</p>

        {/* Examples — file paths. We don't link them (no editor
            deeplink protocol available across users) but a small
            label + monospace stack makes them quick to copy. */}
        {specimen.examples.length > 0 && (
          <div>
            <p className="mb-1 text-xs text-muted-foreground">Examples</p>
            <ul className="space-y-0.5 font-mono text-xs text-foreground/70">
              {specimen.examples.map((path) => (
                <li key={path}>{path}</li>
              ))}
            </ul>
          </div>
        )}
      </div>
    </div>
  )
}
