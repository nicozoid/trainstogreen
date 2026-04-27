"use client"

/**
 * Live-resolves a CSS custom property and re-runs whenever the
 * <html> class changes (i.e. theme toggles), or whenever the
 * viewport crosses a media-query threshold that affects the value.
 *
 * Why a hook: every visualisation on the DS pages needs to read a
 * variable's resolved value. We extracted this from <ColorSwatch>
 * so spacing, radius, animation cards etc. don't each re-implement
 * the MutationObserver dance.
 *
 * Returns the trimmed string value (e.g. "0.625rem") — empty string
 * until the first measurement runs on mount.
 *
 * The probe ref must be attached to a DOM element somewhere inside
 * the component — getComputedStyle reads at that element's position
 * in the cascade, which is what we want for theme- or
 * media-query-dependent variables.
 */

import { useEffect, useRef, useState } from "react"

export function useCssVar(cssVar: string): {
  value: string
  ref: React.RefObject<HTMLDivElement | null>
} {
  const ref = useRef<HTMLDivElement | null>(null)
  const [value, setValue] = useState<string>("")

  useEffect(() => {
    const probe = ref.current
    if (!probe) return

    const measure = () => {
      setValue(getComputedStyle(probe).getPropertyValue(cssVar).trim())
    }

    measure()

    // Theme flip → re-measure. Same MutationObserver pattern used by
    // ColorSwatch.
    const observer = new MutationObserver(measure)
    observer.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["class"],
    })

    // Viewport-crossing → re-measure. Some tokens (--spacing, root
    // font-size) change at media-query thresholds, so we also listen
    // for resize. Throttled with requestAnimationFrame to avoid
    // hammering during drag-resize.
    let raf = 0
    const onResize = () => {
      cancelAnimationFrame(raf)
      raf = requestAnimationFrame(measure)
    }
    window.addEventListener("resize", onResize)

    return () => {
      observer.disconnect()
      window.removeEventListener("resize", onResize)
      cancelAnimationFrame(raf)
    }
  }, [cssVar])

  return { value, ref }
}
