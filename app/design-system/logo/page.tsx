/**
 * Logo page — the brand mark + variations + how it's used.
 *
 * The app has three brand assets:
 *   - trainstogreen-logo.svg     (full wordmark + glyph; used in the
 *                                 welcome banner + filter panel)
 *   - trainstogreen-logomark.svg (just the glyph; not currently used
 *                                 in the public app, but shipped for
 *                                 future / favicon contexts)
 *   - trainstogreen-favicon.svg  (browser-tab icon; covered on the
 *                                 Iconography page, not here)
 *
 * Both logo and logomark are SINGLE-COLOUR fills (the logo's path
 * is filled #2F6544; the logomark's is filled black). In real use
 * they're rendered as CSS masks and tinted by a bg-* utility — the
 * shape carries through, the colour comes from the surrounding
 * style. This page demonstrates both rendering modes.
 */

import {
  LogoSpecimen,
  MaskedLogoTints,
} from "@/components/design-system/logo-specimen"
import { PageHeader, Section } from "@/components/design-system/section"

// All available bg-* tints we want to preview. Picked to cover both
// the colours the app actually uses (bg-primary in filter-panel) and
// a representative spread of the rest of the semantic palette.
const TINTS = [
  { label: "bg-primary", className: "bg-primary" },
  { label: "bg-foreground", className: "bg-foreground" },
  { label: "bg-secondary", className: "bg-secondary" },
  { label: "bg-accent", className: "bg-accent" },
  { label: "bg-muted-foreground", className: "bg-muted-foreground" },
  { label: "bg-destructive", className: "bg-destructive" },
]

export default function LogoPage() {
  return (
    <>
      <PageHeader
        title="Logo"
        subtitle="The brand mark and its variations. Both assets ship as single-colour SVGs and are typically rendered as CSS masks so the colour can be tinted at the call site."
      />

      {/* --- Full logo --------------------------------------------- */}
      <Section
        title="Full logo"
        description="Wordmark + glyph. The asset's intrinsic fill is dark green (#2F6544); rendered with <img> below."
      >
        <LogoSpecimen
          src="/trainstogreen-logo.svg"
          aspectRatio="597 / 51"
          altText="Trains to Green"
        />

        <p className="mt-6 mb-3 text-sm font-medium">Used in the public app</p>
        <ul className="list-inside list-disc space-y-1 font-mono text-xs text-muted-foreground">
          <li>components/filter-panel.tsx (top of the left rail, tinted bg-primary)</li>
          <li>components/welcome-banner.tsx (over the hero image)</li>
        </ul>
      </Section>

      {/* --- Logomark --------------------------------------------- */}
      <Section
        title="Logomark"
        description="Just the glyph (no wordmark). Filled black in the source. Not currently used anywhere in the public app, but shipped as a separate asset for compact contexts."
      >
        <LogoSpecimen
          src="/trainstogreen-logomark.svg"
          aspectRatio="141 / 50"
          altText="Trains to Green"
        />
      </Section>

      {/* --- Mask tinting --------------------------------------- */}
      <Section
        title="Mask-tint technique"
        description="In real use the logo is rendered as a CSS mask, not an <img>. The bg-* utility carries through; the SVG shape decides which pixels are visible. Lets the same asset adapt to any surface without shipping multiple colour variants."
      >
        <MaskedLogoTints
          src="/trainstogreen-logo.svg"
          aspectRatio="597 / 51"
          altText="Trains to Green (tinted)"
          tints={TINTS}
        />

        {/* Worked example so a designer can copy the technique into a
            new component. Prose first, then the code block. */}
        <div className="mt-6 rounded-lg border border-border bg-card p-5">
          <p className="mb-3 text-sm font-medium">How to use it</p>
          <p className="mb-3 text-sm text-foreground/80">
            Set <code className="font-mono">maskImage</code> to the logo URL
            and apply a Tailwind <code className="font-mono">bg-*</code> utility.
            The element needs a definite size — give it a width and let
            <code className="font-mono"> aspectRatio</code> carry the height,
            or pass explicit width/height.
          </p>
          <pre className="overflow-x-auto rounded-md bg-muted p-3 font-mono text-xs">
{`<div
  role="img"
  aria-label="Trains to Green"
  className="w-full bg-primary"
  style={{
    aspectRatio: "597 / 51",
    maskImage: "url(/trainstogreen-logo.svg)",
    maskSize: "contain",
    maskRepeat: "no-repeat",
    WebkitMaskImage: "url(/trainstogreen-logo.svg)",
    WebkitMaskSize: "contain",
    WebkitMaskRepeat: "no-repeat",
  }}
/>`}
          </pre>
        </div>
      </Section>
    </>
  )
}
