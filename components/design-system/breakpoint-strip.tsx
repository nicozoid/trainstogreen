"use client"

/**
 * Horizontal strip showing every Tailwind breakpoint as a tick on
 * the timeline, with a live "you are here" marker pinned to the
 * current viewport width.
 *
 * Why this is useful: breakpoints are abstract until you see them
 * relative to your current screen. Resize the window and the
 * marker slides.
 *
 * Implementation:
 *   - Track window.innerWidth with a resize listener (rAF-throttled).
 *   - Render the strip as a flex row, ticks at each breakpoint.
 *   - The marker is absolutely positioned within a relative container
 *     and offset by `viewportWidth / 2xl-max * 100%` (capped).
 */

import { useEffect, useState } from "react"
import { breakpoints } from "@/lib/design-system/tokens"

// We treat 2× the largest breakpoint (2xl = 1536) as the right edge
// of the timeline. Anything wider clamps to the right.
const TIMELINE_MAX = 1536 * 1.5

export function BreakpointStrip() {
  const [viewportWidth, setViewportWidth] = useState<number>(0)

  useEffect(() => {
    // Initial read needs to be inside useEffect — window is undefined
    // during SSR.
    const update = () => setViewportWidth(window.innerWidth)
    update()

    // rAF-throttle so dragging the corner of the window doesn't fire
    // hundreds of state updates per second.
    let raf = 0
    const onResize = () => {
      cancelAnimationFrame(raf)
      raf = requestAnimationFrame(update)
    }
    window.addEventListener("resize", onResize)
    return () => {
      window.removeEventListener("resize", onResize)
      cancelAnimationFrame(raf)
    }
  }, [])

  // Convert a px width to a 0–100 percentage along the timeline.
  // Math.min clamps so very large viewports don't push the marker
  // off the right edge.
  const toPercent = (px: number) => Math.min((px / TIMELINE_MAX) * 100, 100)

  // Find which named breakpoint the viewport currently satisfies
  // (the largest one whose minWidth is ≤ viewportWidth, or "base"
  // if narrower than sm).
  const activeName =
    [...breakpoints]
      .reverse()
      .find((bp) => viewportWidth >= bp.minWidth)?.name ?? "base"

  return (
    <div className="rounded-lg border border-border bg-card p-6">
      {/* Header row: current viewport width + active breakpoint label */}
      <div className="mb-6 flex items-baseline justify-between">
        <p className="font-mono text-sm">
          <span className="text-muted-foreground">viewport: </span>
          <span className="font-medium">{viewportWidth}px</span>
        </p>
        <p className="font-mono text-sm">
          <span className="text-muted-foreground">active: </span>
          <span className="font-medium text-primary">{activeName}</span>
        </p>
      </div>

      {/* The timeline. relative container so the marker can be
          absolutely positioned within it. h-12 gives room for the
          tick labels below the line. */}
      <div className="relative h-12">
        {/* Horizontal rail */}
        <div className="absolute top-3 right-0 left-0 h-px bg-border" />

        {/* Live marker — vertical tick at the current viewport.
            transition-all eases the slide so resizing feels
            physical. */}
        <div
          className="absolute top-0 h-6 w-0.5 bg-primary transition-[left] duration-150"
          style={{ left: `${toPercent(viewportWidth)}%` }}
        />

        {/* Breakpoint ticks */}
        {breakpoints.map((bp) => {
          const isActive = activeName === bp.name
          return (
            <div
              key={bp.name}
              className="absolute top-0 -translate-x-1/2"
              style={{ left: `${toPercent(bp.minWidth)}%` }}
            >
              {/* Tick mark */}
              <div
                className={
                  isActive
                    ? "mx-auto h-6 w-px bg-foreground"
                    : "mx-auto h-3 w-px bg-muted-foreground/50"
                }
              />
              {/* Label below the tick. text-center because the
                  parent already has -translate-x-1/2 to centre it
                  on the tick. */}
              <p className="mt-1 text-center font-mono text-xs">
                <span
                  className={
                    isActive ? "font-medium text-foreground" : "text-muted-foreground"
                  }
                >
                  {bp.name}
                </span>
                <span className="block text-muted-foreground/70">
                  {bp.minWidth}
                </span>
              </p>
            </div>
          )
        })}
      </div>

      {/* Per-breakpoint descriptions stacked below */}
      <dl className="mt-8 space-y-2 text-sm">
        {breakpoints.map((bp) => (
          <div key={bp.name} className="flex gap-3">
            <dt className="w-12 shrink-0 font-mono text-muted-foreground">
              {bp.name}
            </dt>
            <dd className="text-foreground/80">{bp.description}</dd>
          </div>
        ))}
      </dl>
    </div>
  )
}
