"use client"

/**
 * Two-pane card showing one logo asset rendered on both light and
 * dark surfaces side by side.
 *
 * The "tinted" prop controls how we render the SVG:
 *
 *   - tinted=false → use it as a regular <img>. The SVG's intrinsic
 *     fill colour applies (so trainstogreen-logo.svg shows in green;
 *     trainstogreen-logomark.svg shows in black). Useful for inspecting
 *     the asset itself.
 *
 *   - tinted={tokenName} → render the SVG as a CSS mask, with a
 *     background colour pulled from a Tailwind utility. This is how
 *     the app actually uses the logo: the mask makes the SVG act as
 *     a stencil, and the background tints it. Lets us preview every
 *     bg-* utility against the logo shape without committing to one.
 */

import { cn } from "@/lib/utils"

export function LogoSpecimen({
  src,
  aspectRatio,
  altText,
  // Force-light / force-dark wrappers around each pane. Done with
  // class="" + custom CSS variables on the wrapper rather than
  // toggling next-themes, so this card shows BOTH themes
  // simultaneously regardless of the page's current theme.
  className,
}: {
  src: string
  // Width-to-height ratio of the SVG's viewBox — needed because the
  // mask-image render mode doesn't intrinsically size itself; we
  // force the box ratio via CSS aspect-ratio.
  aspectRatio: string
  altText: string
  className?: string
}) {
  return (
    <div className={cn("grid gap-3 sm:grid-cols-2", className)}>
      <SurfacePane src={src} aspectRatio={aspectRatio} altText={altText} dark={false} />
      <SurfacePane src={src} aspectRatio={aspectRatio} altText={altText} dark />
    </div>
  )
}

// One surface pane — light or dark. We force the surface tone via
// inline style with `var(--tree-950)` / `var(--beach-500)` rather
// than Tailwind utilities, because the raw palette tokens aren't
// registered in @theme inline (only the semantic ones like --primary
// are exposed as bg-* utilities). Forcing the palette directly here
// keeps the preview stable regardless of the page's current theme.
function SurfacePane({
  src,
  aspectRatio,
  altText,
  dark,
}: {
  src: string
  aspectRatio: string
  altText: string
  dark: boolean
}) {
  return (
    <div
      className="rounded-lg border border-border p-6"
      style={{
        background: dark ? "var(--tree-950)" : "var(--beach-500)",
        color: dark ? "var(--beach-100)" : "var(--tree-950)",
      }}
    >
      <p
        className="mb-4 font-mono text-[0.65rem] uppercase tracking-wider opacity-60"
      >
        {dark ? "On dark surface" : "On light surface"}
      </p>
      {/* The image. <img> renders the SVG with its built-in fill —
          good for inspecting the asset as-shipped. We give it a
          definite width and let aspect-ratio carry the height. */}
      <img
        src={src}
        alt={altText}
        className="block w-full max-w-full"
        style={{ aspectRatio }}
      />
    </div>
  )
}

/**
 * Mask-tinted demo. Renders the SVG as a CSS mask and lets the bg-*
 * utility decide the colour. One pane per token so the reader sees
 * exactly what the app's filter-panel + welcome-banner techniques
 * produce.
 */
export function MaskedLogoTints({
  src,
  aspectRatio,
  altText,
  tints,
}: {
  src: string
  aspectRatio: string
  altText: string
  // Each tint is a label + a Tailwind class string applied to the
  // masked div. e.g. { label: "bg-primary", className: "bg-primary" }
  tints: { label: string; className: string }[]
}) {
  return (
    <div className="grid gap-3 [grid-template-columns:repeat(auto-fill,minmax(14rem,1fr))]">
      {tints.map((tint) => (
        <div
          key={tint.label}
          className="rounded-lg border border-border bg-card p-4"
        >
          {/* The masked rendering. role="img" + aria-label gives it
              the same accessibility as an <img> would. */}
          <div
            role="img"
            aria-label={altText}
            className={cn("w-full", tint.className)}
            style={{
              aspectRatio,
              maskImage: `url(${src})`,
              maskSize: "contain",
              maskRepeat: "no-repeat",
              WebkitMaskImage: `url(${src})`,
              WebkitMaskSize: "contain",
              WebkitMaskRepeat: "no-repeat",
            }}
          />
          <p className="mt-3 font-mono text-xs text-muted-foreground">
            {tint.label}
          </p>
        </div>
      ))}
    </div>
  )
}
