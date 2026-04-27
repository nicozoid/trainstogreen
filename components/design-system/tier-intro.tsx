"use client"

/**
 * Header block at the top of each tier page (Molecules, Cells,
 * Tissues, Organs).
 *
 * Surfaces the full framework definition — tagline, definition, the
 * one-line discriminator test, and "built on" — so the criteria for
 * tier membership are always visible while you're reading the
 * components on that page.
 *
 * Why this lives in its own component (rather than reusing
 * <PageHeader>): pages here need richer header content than a plain
 * title + subtitle. PageHeader stays tight for the simpler pages.
 */

import { tierInfo, type Tier } from "@/lib/design-system/components"

export function TierIntro({ tier }: { tier: Tier }) {
  const info = tierInfo[tier]

  return (
    <header className="mb-10">
      {/* Title row: tier name + tagline. Keeps a single typographic
          rhythm across all tier pages. */}
      <div className="flex items-baseline gap-3">
        <h1 className="text-3xl font-semibold tracking-tight">{info.name}</h1>
        <p className="text-sm text-muted-foreground">{info.tagline}</p>
      </div>

      {/* Definition — the one-sentence summary. */}
      <p className="mt-3 text-base text-foreground/90">{info.definition}</p>

      {/* Test + Built-on side by side. Two-column on wider viewports
          for readability; stacks on narrow. The bordered card framing
          marks it as a "framework reference" rather than body copy. */}
      <div className="mt-5 grid gap-4 rounded-lg border border-border bg-card p-4 text-sm sm:grid-cols-2">
        <div>
          <p className="mb-1 text-xs font-medium tracking-wide text-muted-foreground uppercase">
            Test
          </p>
          <p className="text-foreground/85 italic">{info.test}</p>
        </div>
        <div>
          <p className="mb-1 text-xs font-medium tracking-wide text-muted-foreground uppercase">
            Built on
          </p>
          <p className="text-foreground/85">{info.builtOn}</p>
        </div>
      </div>
    </header>
  )
}
