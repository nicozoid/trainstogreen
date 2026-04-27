"use client"

/**
 * Outer card for one component entry on a tier page. Header (name +
 * source badge + file path), then a slot for the variant demo, then
 * a metadata footer (composition, a11y, examples).
 *
 * The variant demo content is hand-written per component because each
 * component's variants are differently shaped. That's why this card
 * takes `children` for the demo region.
 */

import type { ComponentEntry } from "@/lib/design-system/components"
import { cn } from "@/lib/utils"

export function ComponentSection({
  entry,
  children,
}: {
  entry: ComponentEntry
  children: React.ReactNode
}) {
  return (
    // id used as in-page anchor target. scroll-mt-24 leaves headroom
    // beneath the sticky DsShell header when jumped to.
    <section
      id={entry.id}
      className="scroll-mt-24 rounded-lg border border-border bg-card"
    >
      {/* --- Header --------------------------------------------- */}
      <header className="flex flex-wrap items-center gap-3 border-b border-border px-5 py-4">
        <h2 className="text-lg font-semibold">{entry.name}</h2>
        <SourceBadge source={entry.source} />
        <code className="ml-auto font-mono text-xs text-muted-foreground">
          {entry.filePath}
        </code>
      </header>

      {/* --- Description ---------------------------------------- */}
      <div className="border-b border-border px-5 py-4">
        <p className="text-sm text-foreground/80">{entry.description}</p>
        {entry.source.notes && (
          // shadcn-customised entries carry a notes line — the
          // specific delta from the upstream component. Surfaced as
          // a dimmer line so the reader can scan past if they don't
          // care about implementation history.
          <p className="mt-2 text-xs text-muted-foreground">
            <span className="font-medium">Customisations: </span>
            {entry.source.notes}
          </p>
        )}
      </div>

      {/* --- Variant demo --------------------------------------- */}
      {/* bg-muted/30 sets a subtly different surface for the demo
          region so it reads as a "stage" within the card. min-h-32
          stops the area collapsing if a variant grid is short. */}
      <div className="min-h-32 border-b border-border bg-muted/30 px-5 py-6">
        {children}
      </div>

      {/* --- Metadata footer ----------------------------------- */}
      <div className="grid gap-3 px-5 py-4 text-xs sm:grid-cols-2">
        {entry.composedOf && entry.composedOf.length > 0 && (
          <MetaRow label="Built from">
            {entry.composedOf.join(" · ")}
          </MetaRow>
        )}
        {entry.a11y && <MetaRow label="Accessibility">{entry.a11y}</MetaRow>}
        {entry.examples && entry.examples.length > 0 && (
          <MetaRow label="Examples">
            <ul className="space-y-0.5 font-mono">
              {entry.examples.map((path) => (
                <li key={path} className="text-foreground/70">
                  {path}
                </li>
              ))}
            </ul>
          </MetaRow>
        )}
      </div>
    </section>
  )
}

// Small badge in the header showing whether the component is a shadcn
// customisation or a custom build. Different colours so the kind is
// readable at a glance.
function SourceBadge({ source }: { source: ComponentEntry["source"] }) {
  const isShadcn = source.kind === "shadcn-customised"
  return (
    <span
      className={cn(
        "rounded-md px-2 py-0.5 font-mono text-[10px] uppercase tracking-wide",
        isShadcn
          ? "bg-accent/30 text-accent-foreground"
          : "bg-primary/15 text-primary",
      )}
    >
      {isShadcn ? "shadcn — customised" : "custom"}
    </span>
  )
}

// One row of the metadata footer. Stacks label above value; keeps
// alignment consistent across rows.
function MetaRow({
  label,
  children,
}: {
  label: string
  children: React.ReactNode
}) {
  return (
    <div>
      <p className="mb-1 text-muted-foreground">{label}</p>
      <div className="text-foreground/80">{children}</div>
    </div>
  )
}
