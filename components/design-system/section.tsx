"use client"

/**
 * Page-level and section-level headings used across DS pages.
 *
 * - <PageHeader> renders the big title at the top of a page, with an
 *   optional subtitle and an optional source-file chip ("defined in:
 *   app/globals.css") so the user can see where the data lives.
 * - <Section> renders one band on the page — a sub-heading with
 *   description, then its children below.
 *
 * Both are pure presentational wrappers; no logic.
 */

import { cn } from "@/lib/utils"

export function PageHeader({
  title,
  subtitle,
  sourceFile,
  className,
}: {
  title: string
  subtitle?: string
  sourceFile?: string
  className?: string
}) {
  return (
    // mb-10 = bottom margin so the first section has breathing room.
    <header className={cn("mb-10", className)}>
      <h1 className="text-3xl font-semibold tracking-tight">{title}</h1>
      {subtitle && <p className="mt-2 text-base text-muted-foreground">{subtitle}</p>}
      {sourceFile && (
        // Monospace chip — inline-flex so it hugs its content. The
        // muted background marks it as metadata rather than copy.
        <p className="mt-3 inline-flex items-center gap-1.5 rounded-md bg-muted px-2 py-1 font-mono text-xs text-muted-foreground">
          <span>defined in</span>
          <span className="text-foreground">{sourceFile}</span>
        </p>
      )}
    </header>
  )
}

// Slugify a section title for use as an HTML id. Keeps it predictable
// so the sidebar's anchor children can build the same href without
// having to know per-section ids. "Brand actions" → "brand-actions",
// "Display & headings" → "display-and-headings".
export function sectionSlug(title: string): string {
  return title
    .toLowerCase()
    .replace(/&/g, "and")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
}

export function Section({
  title,
  description,
  children,
  className,
  id,
}: {
  title: string
  description?: string
  children: React.ReactNode
  className?: string
  // Optional override — when undefined, the id is derived from title.
  // The auto-id is what the sidebar's anchor children point at, so
  // most callers should NOT pass an explicit id.
  id?: string
}) {
  const sectionId = id ?? sectionSlug(title)
  return (
    // scroll-mt-24 leaves headroom under the sticky DS header when
    // the page jumps to a section anchor. Same offset as the
    // ComponentSection card uses.
    <section
      id={sectionId}
      className={cn("scroll-mt-24 mb-12", className)}
    >
      <h2 className="text-xl font-semibold tracking-tight">{title}</h2>
      {description && (
        <p className="mt-1 mb-4 text-sm text-muted-foreground">{description}</p>
      )}
      {!description && <div className="mb-4" />}
      {children}
    </section>
  )
}
