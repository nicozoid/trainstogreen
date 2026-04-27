"use client"

/**
 * Generic outer card used by every non-colour-token visualisation.
 *
 * Looks like the colour swatch card (border, rounded, two-section
 * layout) but the visualisation slot is whatever the caller passes
 * in. That keeps spacing/radius/animation visualisations
 * stylistically consistent without duplicating the chrome.
 *
 * Props:
 *   visualisation — the visual demo (a div, an animated element, etc.)
 *   name          — display name (defaults to the cssVar without "--")
 *   value         — the live-resolved string ("0.625rem", "20px", …)
 *   description   — optional explanatory paragraph
 *   usedIn        — optional list of public callsites where the token is
 *                   consumed. Empty array renders an explicit "registered
 *                   but unused" warning so absence is visible. Undefined
 *                   skips the section entirely.
 */

import { cn } from "@/lib/utils"

export function TokenCard({
  visualisation,
  name,
  value,
  description,
  usedIn,
  className,
}: {
  visualisation: React.ReactNode
  name: string
  value?: string
  description?: string
  usedIn?: string[]
  className?: string
}) {
  return (
    <div
      className={cn(
        "overflow-hidden rounded-lg border border-border bg-card",
        className,
      )}
    >
      {/* Visualisation sits in a fixed-height row so cards line up
          even when the content is a thin bar vs a square vs an
          animated dot. min-h-20 = 5rem floor; flex centres the
          visual horizontally + vertically. */}
      <div className="flex min-h-20 items-center justify-center bg-muted/40 p-4">
        {visualisation}
      </div>

      <div className="space-y-1 p-3">
        <p className="font-mono text-sm font-medium">{name}</p>
        {value && (
          <p className="font-mono text-xs break-all text-muted-foreground">
            {value}
          </p>
        )}
        {description && (
          <p className="pt-1 text-xs text-foreground/80">{description}</p>
        )}

        {/* Usage block — only renders when usedIn is provided. Empty
            array deliberately renders a warning so registered-but-
            unused tokens stand out (a real DS finding worth surfacing,
            not a silent gap). */}
        {usedIn !== undefined && (
          <div className="border-t border-border pt-2">
            <p className="mb-1 text-[0.65rem] font-medium tracking-wider text-muted-foreground uppercase">
              Used in
            </p>
            {usedIn.length === 0 ? (
              <p className="font-mono text-xs italic text-destructive">
                Registered but no public callsites — see anomalies.
              </p>
            ) : (
              <ul className="space-y-0.5 font-mono text-xs text-foreground/70">
                {usedIn.map((loc) => (
                  <li key={loc}>{loc}</li>
                ))}
              </ul>
            )}
          </div>
        )}
      </div>
    </div>
  )
}
