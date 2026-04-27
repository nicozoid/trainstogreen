"use client"

/**
 * Visualises the html element's base font-size and the cascade it
 * controls.
 *
 * Why this card matters: root font-size is the master scaler for
 * everything sized in rem. That includes type sizes (text-sm = 0.875rem)
 * but ALSO layout primitives — Tailwind's height/width utilities
 * (h-9 = 2.25rem), the bespoke --spacing token (0.3rem) that drives
 * every padding / margin / gap utility, and the --radius scale.
 *
 * Move root font-size up or down and EVERYTHING in the app scales
 * proportionally. This is also why it lives on Layout tokens, not
 * Typography — type is one of several things it controls, not the
 * only one.
 *
 * The card reads the live computed font-size from <html> and
 * re-measures on resize so the cascade values stay in sync as the
 * user crosses the md breakpoint.
 */

import { useEffect, useState } from "react"

export function RootFontSizeCard() {
  // Live root font-size in px (e.g. "17px"). Empty until measured.
  const [rootSize, setRootSize] = useState<string>("")
  // Numeric form so we can compute cascade values inline.
  const [rootPx, setRootPx] = useState<number>(0)

  useEffect(() => {
    const measure = () => {
      const cs = getComputedStyle(document.documentElement)
      setRootSize(cs.fontSize)
      setRootPx(parseFloat(cs.fontSize))
    }
    measure()

    // Re-measure on resize — root font-size flips at the md
    // breakpoint (768px), so every cascade value below recomputes.
    // rAF throttle keeps drag-resize smooth.
    let raf = 0
    const onResize = () => {
      cancelAnimationFrame(raf)
      raf = requestAnimationFrame(measure)
    }
    window.addEventListener("resize", onResize)
    return () => {
      window.removeEventListener("resize", onResize)
      cancelAnimationFrame(raf)
    }
  }, [])

  // Helper — given a rem value, show what it resolves to right now.
  // Used to surface the cascade in the table below.
  const px = (rem: number) =>
    rootPx > 0 ? `${(rem * rootPx).toFixed(2)}px` : "…"

  return (
    <div className="rounded-lg border border-border bg-card p-6">
      {/* Visual — 1rem rendered prominently so the user sees the
          actual size. Resizing the viewport across 768px makes the
          glyphs grow/shrink. */}
      <div className="mb-6 flex items-center justify-center bg-muted/40 py-8">
        <span className="font-semibold" style={{ fontSize: "1rem" }}>
          Aa &nbsp;·&nbsp; 1rem = {rootSize || "…"}
        </span>
      </div>

      <p className="text-sm font-medium">What it does</p>
      <p className="mt-2 text-sm text-foreground/80">
        Sets the size of <code className="font-mono">1rem</code> for the
        entire app. Bumped on small viewports for proportional touch
        targets:{" "}
        <code className="font-mono">20px</code> on phone (default),{" "}
        <code className="font-mono">17px</code> from the{" "}
        <code className="font-mono">md</code> breakpoint (768px) up.
      </p>

      <p className="mt-5 text-sm font-medium">What scales with it</p>
      <p className="mt-2 text-sm text-foreground/80">
        Anything sized in <code className="font-mono">rem</code>. That covers
        type, but also Tailwind&apos;s height / width utilities, the bespoke
        spacing scale, and border radii — so the root font-size is a layout
        knob, not just a typography knob.
      </p>

      {/* Live cascade table — every row is a token whose px value
          changes when root font-size flips at the md breakpoint.
          Resize the window across 768px to see all four rows
          recompute together. */}
      <dl className="mt-3 grid grid-cols-[10rem_1fr] gap-y-1 font-mono text-xs">
        <dt className="text-muted-foreground">text-sm (0.875rem)</dt>
        <dd>{px(0.875)}</dd>
        <dt className="text-muted-foreground">text-base (1rem)</dt>
        <dd>{px(1)}</dd>
        <dt className="text-muted-foreground">--spacing (0.3rem)</dt>
        <dd>
          {px(0.3)}{" "}
          <span className="text-muted-foreground/70">
            — drives every p-*, m-*, gap-*
          </span>
        </dd>
        <dt className="text-muted-foreground">--radius (0.625rem)</dt>
        <dd>{px(0.625)}</dd>
        <dt className="text-muted-foreground">h-9 (2.25rem)</dt>
        <dd>
          {px(2.25)}{" "}
          <span className="text-muted-foreground/70">— Button default height</span>
        </dd>
      </dl>
    </div>
  )
}
