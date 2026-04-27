"use client"

/**
 * Reads computed font metrics (family / size / weight / line-height /
 * letter-spacing) from a probe element. The probe is a 1×1 invisible
 * element with the typography classes applied; getComputedStyle on
 * it returns whatever Tailwind's classes resolve to.
 *
 * Returns a stable object that updates on theme toggle and viewport
 * resize, plus the ref to attach to the probe.
 *
 * Why not infer from the class string statically? Because Tailwind
 * theme tokens (root font-size, --font-sans, etc.) live in CSS, and
 * the actual computed values change with viewport (text-* sizes are
 * in rem, which depends on html font-size — see Tokens page). Live-
 * reading is the only way to keep the displayed numbers correct.
 */

import { useEffect, useRef, useState } from "react"

export type ComputedTextStyle = {
  fontFamily: string;
  fontSize: string;
  fontWeight: string;
  lineHeight: string;
  letterSpacing: string;
}

const EMPTY: ComputedTextStyle = {
  fontFamily: "",
  fontSize: "",
  fontWeight: "",
  lineHeight: "",
  letterSpacing: "",
}

export function useComputedTextStyle(): {
  style: ComputedTextStyle
  ref: React.RefObject<HTMLDivElement | null>
} {
  const ref = useRef<HTMLDivElement | null>(null)
  const [style, setStyle] = useState<ComputedTextStyle>(EMPTY)

  useEffect(() => {
    const probe = ref.current
    if (!probe) return

    const measure = () => {
      const cs = getComputedStyle(probe)
      setStyle({
        fontFamily: cs.fontFamily,
        fontSize: cs.fontSize,
        fontWeight: cs.fontWeight,
        lineHeight: cs.lineHeight,
        letterSpacing: cs.letterSpacing,
      })
    }
    measure()

    // Theme toggle (rare for type, but cheap to handle)
    const observer = new MutationObserver(measure)
    observer.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["class"],
    })

    // Viewport resize (matters because root font-size flips at 768px,
    // changing every rem-based size)
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
  }, [])

  return { style, ref }
}

// Pretty-print a font-family string. Browsers return the full
// fallback list ("__GeneralSans_…, ui-sans-serif, system-ui, …");
// we want just the first family with internal Next.js font-loader
// IDs stripped.
export function formatFontFamily(family: string): string {
  if (!family) return ""
  const first = family.split(",")[0].trim().replace(/^["']|["']$/g, "")
  // Next.js font-loader IDs look like __GeneralSans_<hash> or similar.
  // Strip the leading underscores + trailing hash to get a clean name.
  const cleaned = first.replace(/^_+/, "").replace(/_[a-zA-Z0-9]{6,}$/, "")
  return cleaned || first
}
