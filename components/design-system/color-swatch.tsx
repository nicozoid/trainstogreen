"use client"

/**
 * One colour-token card. Big swatch on top, metadata underneath.
 *
 * The colour VALUE is read live from the DOM via getComputedStyle —
 * we never duplicate the hex/oklch in this codebase. That means:
 * editing globals.css instantly updates this card with no rebuild
 * of the registry. It also means the value reflects whichever theme
 * is active (light vs dark), so the same card renders different
 * values automatically when the theme is toggled.
 *
 * Why a hidden probe div: getComputedStyle on a CSS custom property
 * has to be called on an element that has the variable in its
 * cascade. The probe is a 0×0 invisible div that simply exists in
 * the DOM so we can ask "what does --primary resolve to here?".
 */

import { useEffect, useRef, useState } from "react"
import type { ColorToken } from "@/lib/design-system/colors"

export function ColorSwatch({ token }: { token: ColorToken }) {
  // We attach this ref to a hidden probe div so we can read computed
  // styles. (We can't read from the swatch div directly because we
  // want the value of the *variable*, not of the swatch's own
  // background.)
  const probeRef = useRef<HTMLDivElement>(null)

  // Holds the resolved value (e.g. "oklch(0.45 0.08 154)") — empty
  // string until we've measured.
  const [resolved, setResolved] = useState<string>("")

  // Tracks the active theme so we can pick the matching alias from
  // token.alias. Sourced from the `dark` class on <html> via the
  // same MutationObserver that drives the resolved-value re-measure.
  const [theme, setThemeState] = useState<"light" | "dark">("light")

  useEffect(() => {
    const probe = probeRef.current
    if (!probe) return

    // One callback handles both jobs: re-measure the resolved colour
    // value AND update the theme flag. Both depend on the same
    // signal (a class change on <html>) so it's natural to bundle
    // them.
    const update = () => {
      const value = getComputedStyle(probe)
        .getPropertyValue(token.cssVar)
        .trim()
      setResolved(value)
      setThemeState(
        document.documentElement.classList.contains("dark") ? "dark" : "light",
      )
    }

    update()

    // MutationObserver is the React-agnostic way to watch DOM
    // changes. We chose it over next-themes' useTheme() because the
    // hook's resolvedTheme value didn't reliably re-trigger our
    // effect — observing the class attribute directly is bulletproof
    // and works regardless of which theming library is in use, which
    // matters for porting this DS app to other projects.
    const observer = new MutationObserver(update)
    observer.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["class"],
    })

    // Cleanup so we don't leak observers when the swatch unmounts.
    return () => observer.disconnect()
  }, [token.cssVar])

  // Pick the alias that matches the current theme. Optional chain
  // because raw tokens (no alias) just render undefined here.
  const currentAlias = token.alias?.[theme]

  // Display name: explicit override if given, else strip the leading
  // "--" from the CSS variable.
  const displayName = token.name ?? token.cssVar.replace(/^--/, "")

  return (
    // Card layout: rounded outer container, swatch up top, metadata
    // below. border = consistent boundary; overflow-hidden so the
    // swatch's rounded corners follow the card's.
    <div className="overflow-hidden rounded-lg border border-border bg-card">
      {/* The swatch itself. h-20 = fixed height. We set background
          via inline style with `var(...)` — Tailwind can't generate
          arbitrary var-based utilities at build time, so inline
          style is the right tool here.

          The hidden probe div sits inside so it inherits the same
          cascade as the swatch. */}
      <div
        className="h-20 w-full"
        style={{ background: `var(${token.cssVar})` }}
      >
        <div ref={probeRef} className="h-0 w-0" />
      </div>

      {/* Metadata block */}
      <div className="space-y-1 p-3">
        <p className="font-mono text-sm font-medium">{displayName}</p>
        {/* Resolved value — break-all so long oklch strings wrap
            instead of overflowing the card. */}
        <p className="font-mono text-xs break-all text-muted-foreground">
          {resolved || "…"}
        </p>
        {currentAlias && (
          // Show the alias chain — "→ tree-800" — so the user can
          // see which raw token the semantic one points at. The
          // value swaps when the theme is toggled because most
          // semantic tokens point at different raw colours in light
          // vs dark.
          <p className="font-mono text-xs text-muted-foreground/70">
            → {currentAlias.replace(/^--/, "")}
          </p>
        )}
        {token.description && (
          <p className="pt-1 text-xs text-foreground/80">{token.description}</p>
        )}
      </div>
    </div>
  )
}
