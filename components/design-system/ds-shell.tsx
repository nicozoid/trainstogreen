"use client"

/**
 * The DS app's outer chrome — sidebar nav on the left, content area on
 * the right. Used by every page under /design-system via the route
 * group's layout.tsx.
 *
 * Why client component: the sidebar's active-link highlight uses
 * usePathname(), which requires "use client".
 */

import { useEffect, useRef } from "react"
import Link from "next/link"
import { usePathname } from "next/navigation"
import { cn } from "@/lib/utils"
import { DsThemeToggle } from "./theme-toggle"
import {
  atoms,
  macromolecules,
  molecules,
  organelles,
  type ComponentEntry,
} from "@/lib/design-system/components"
import {
  anomalyAnchors,
  colorAnchors,
  iconographyAnchors,
  logoAnchors,
  mapAnchors,
  motionAnchors,
  tokenAnchors,
  typographyAnchors,
} from "@/lib/design-system/sidebar-anchors"

// `disabled: true` greys the link out and skips the href until we
// build that page.
//
// `children` lets a top-level item own a list of sub-pages or
// component-anchors. Children auto-reveal when the current pathname
// falls inside the parent's tree (so navigating to /components/molecules
// expands its anchor list automatically — no manual expand/collapse
// state). They render indented one level below the parent.
type NavItem = {
  href: string
  label: string
  disabled?: boolean
  children?: NavItem[]
}

// --- Nav data, split into groups ------------------------------------
// The sidebar renders four groups, separated by HRs:
//   1. Lone Overview at the top
//   2. PARTICLES section (named header) — the visual primitives
//      (Colour, Layout tokens, Typography, Motion, Logo, Iconography).
//      Named "Particles" rather than "Atoms" because the latter is now
//      the smallest tier of the COMPONENTS band below.
//   3. COMPONENTS section (named header) — the four tiers
//      (Atoms / Molecules / Macromolecules / Organelles)
//   4. Loose tail items (Map, Anomalies) without a section name
//
// We could put all this in a single "section[]" array with header
// metadata, but keeping the groups as separate constants is more
// readable and there are only four of them.

const OVERVIEW: NavItem = {
  href: "/design-system",
  label: "Overview",
}

// Each particle gets section anchors as children (revealed when its
// page is active, same path-driven pattern as the COMPONENTS tier
// items below). The anchor lists are derived from each page's
// section structure — see lib/design-system/sidebar-anchors.ts.
const PARTICLES: NavItem[] = [
  { href: "/design-system/colors", label: "Colour", children: colorAnchors() },
  { href: "/design-system/tokens", label: "Layout tokens", children: tokenAnchors() },
  { href: "/design-system/typography", label: "Typography", children: typographyAnchors() },
  { href: "/design-system/motion", label: "Motion", children: motionAnchors() },
  { href: "/design-system/logo", label: "Logo", children: logoAnchors() },
  { href: "/design-system/iconography", label: "Iconography", children: iconographyAnchors() },
]

// Helper — turn a registry list into anchor-link children for a tier
// page. Each component becomes a quick-jump link to its section anchor
// on the tier page.
function toAnchors(
  tierPath: string,
  entries: ComponentEntry[],
): NavItem[] {
  return entries
    .filter((c) => c.isPublic)
    .map((c) => ({ href: `${tierPath}#${c.id}`, label: c.name }))
}

const COMPONENT_TIERS: NavItem[] = [
  {
    href: "/design-system/components/atoms",
    label: "Atoms",
    children: toAnchors("/design-system/components/atoms", atoms),
  },
  {
    href: "/design-system/components/molecules",
    label: "Molecules",
    children: toAnchors("/design-system/components/molecules", molecules),
  },
  {
    href: "/design-system/components/macromolecules",
    label: "Macromolecules",
    children: toAnchors("/design-system/components/macromolecules", macromolecules),
  },
  {
    href: "/design-system/components/organelles",
    label: "Organelles",
    children: toAnchors("/design-system/components/organelles", organelles),
  },
]

// Tail of the sidebar — items that don't belong to ATOMS or COMPONENTS.
// Tail of the sidebar — items that don't belong to PARTICLES or
// COMPONENTS. Same anchor-children pattern as the rest.
const TAIL_ITEMS: NavItem[] = [
  { href: "/design-system/map", label: "Map", children: mapAnchors() },
  { href: "/design-system/anomalies", label: "Anomalies", children: anomalyAnchors() },
]

export function DsShell({ children }: { children: React.ReactNode }) {
  // usePathname returns the current URL path — used here to highlight
  // the matching sidebar link. Returns "" briefly during SSR; that's
  // harmless because the highlight is purely visual.
  const pathname = usePathname()

  // Ref to the right-column scroll container. Needed because our
  // content scrolls inside this div (not the body), and browsers'
  // built-in anchor scrolling only works for body-level scroll. We
  // call scrollIntoView() on the target element manually — that
  // walks up scroll ancestors and does the right thing for any
  // scroll container, including ours.
  const scrollContainerRef = useRef<HTMLDivElement | null>(null)

  // Anchor scroll handler — runs on mount (handle hash present at load
  // time, e.g. when navigating from another page) and on every
  // hashchange (clicking a sidebar anchor link while already on the
  // tier page).
  useEffect(() => {
    const scrollToHash = () => {
      const hash = window.location.hash
      if (!hash) return
      // The hash includes the leading #; getElementById doesn't want it.
      const el = document.getElementById(hash.slice(1))
      if (!el) return
      // smooth = nicer feel; block: 'start' = align top edge of the
      // target with the top of the visible scroll area (then
      // scroll-mt-24 on the section gives breathing room beneath the
      // sticky header).
      el.scrollIntoView({ behavior: "smooth", block: "start" })
    }

    // Initial pass — needs a small delay so the page has rendered
    // its sections (so getElementById finds them).
    const initialTimeout = setTimeout(scrollToHash, 50)

    window.addEventListener("hashchange", scrollToHash)
    return () => {
      window.removeEventListener("hashchange", scrollToHash)
      clearTimeout(initialTimeout)
    }
  }, [pathname])

  return (
    // The main app's body has `overflow: hidden` set globally
    // (the map needs that). Rather than override the body rule —
    // which would leak DS concerns into the global stylesheet — we
    // make the right-hand column its OWN scroll container, sized
    // exactly to the viewport (h-dvh). The body stays unscrollable;
    // scrolling happens inside the DS content area instead.
    //
    // grid with two columns: 14rem sidebar + flexible content.
    // h-dvh (not min-h-dvh) pins the grid to viewport height so the
    // inner scroll container has a definite size to fill.
    <div className="grid h-dvh grid-cols-[14rem_1fr] overflow-hidden bg-background text-foreground">
      {/* --- Sidebar ----------------------------------------------- */}
      {/* sticky + h-dvh keeps the sidebar pinned while the content
          area scrolls. border-r marks the boundary; bg-card gives
          the sidebar a subtly different surface from the page. */}
      <aside className="sticky top-0 h-dvh overflow-y-auto border-r border-border bg-card px-4 py-6">
        {/* Sidebar header. Two parts:
            1. A small uppercase "DESIGN SYSTEM" label identifying
               what this site IS — kept tiny + muted so the
               product's own identity (the logo below) leads.
            2. The product wordmark — currently the Trains to Green
               logo. ─────── PROJECT-IDENTITY SLOT ───────
               When porting this DS scaffold to a different product,
               this is the one place that needs to change: swap the
               maskImage URL for the new product's wordmark SVG and
               update the aspect-ratio to match. The CSS mask + bg-
               primary technique inherits the active theme so the
               wordmark tints correctly in both light and dark.
            The whole stack is a single Link so clicking either part
            returns to the DS overview. */}
        {/* px-2 on the Link matches the px-2 of NavLink and
            SectionHeader, so the "Design system" label, the logo,
            the nav items, and the "Back to app" link all share the
            same left edge. The logo is full-width OF THIS PADDED
            CONTAINER, which makes it slightly narrower than the
            sidebar — that's the "shrink" the alignment requires. */}
        <Link
          href="/design-system"
          className="mb-8 block px-2 no-underline group"
        >
          <p className="mb-2 text-[0.65rem] font-semibold tracking-wider text-muted-foreground uppercase select-none">
            Design system
          </p>
          <div
            className="w-full bg-primary transition-opacity group-hover:opacity-80"
            role="img"
            aria-label="Trains to Green"
            style={{
              aspectRatio: "597 / 51",
              maskImage: "url(/trainstogreen-logo.svg)",
              maskSize: "contain",
              maskRepeat: "no-repeat",
              WebkitMaskImage: "url(/trainstogreen-logo.svg)",
              WebkitMaskSize: "contain",
              WebkitMaskRepeat: "no-repeat",
            }}
          />
        </Link>

        <nav className="flex flex-col gap-0.5">
          {/* 1. Lone Overview at the top. */}
          <NavLink item={OVERVIEW} pathname={pathname} />

          {/* 2. PARTICLES band — visual primitives. (Renamed from
              ATOMS so the word "Atoms" can be used for the smallest
              tier of components below.) Same header pattern as
              COMPONENTS below: small all-caps muted, non-clickable. */}
          <hr className="my-3 border-border" />
          <SectionHeader>Particles</SectionHeader>
          {PARTICLES.map((item) => (
            <NavLink key={item.href} item={item} pathname={pathname} />
          ))}

          {/* 3. COMPONENTS band — the four tiers (Molecules / Cells /
              Tissues / Organs), each revealing its own anchor list when
              active. */}
          <hr className="my-3 border-border" />
          <SectionHeader>Components</SectionHeader>
          {COMPONENT_TIERS.map((item) => (
            <NavLink key={item.href} item={item} pathname={pathname} />
          ))}

          {/* 4. Tail items — Map and Deviations. No section header
              since they don't share a category yet. */}
          <hr className="my-3 border-border" />
          {TAIL_ITEMS.map((item) => (
            <NavLink key={item.href} item={item} pathname={pathname} />
          ))}
        </nav>

        {/* Back-to-app escape hatch sits at the bottom of the
            sidebar — visually separated from the section nav. */}
        <div className="mt-8 border-t border-border pt-4">
          <Link
            href="/"
            className="block px-2 text-xs text-muted-foreground no-underline hover:text-foreground"
          >
            ← Back to app
          </Link>
        </div>
      </aside>

      {/* --- Content area ------------------------------------------ */}
      {/* h-dvh + overflow-y-auto = this column is the scroll container.
          The sticky header below sticks to the top of THIS container
          (its nearest scrolling ancestor), not the viewport. */}
      <div ref={scrollContainerRef} className="flex h-dvh flex-col overflow-y-auto">
        {/* Top bar with the theme toggle. Sticky so it stays visible
            while you scroll long colour pages. */}
        <header className="sticky top-0 z-10 flex items-center justify-end gap-2 border-b border-border bg-background/80 px-8 py-3 backdrop-blur">
          <DsThemeToggle />
        </header>

        {/* Page content. max-w caps line length so token tables stay
            readable on wide monitors. */}
        <main className="px-8 py-8">
          <div className="mx-auto max-w-5xl">{children}</div>
        </main>
      </div>
    </div>
  )
}

/**
 * Renders one nav item. Recursive: if the item has `children`, it
 * renders itself, then conditionally reveals its children when the
 * current pathname falls inside the parent's tree.
 *
 * Children whose href contains a "#" are treated as anchor sub-items —
 * they don't get an active-state highlight (we'd need scroll-spy to do
 * that meaningfully) and they're rendered as quick-jump links.
 */
function NavLink({
  item,
  pathname,
  isChild = false,
}: {
  item: NavItem
  pathname: string
  isChild?: boolean
}) {
  // Anchor children (href contains #) are TOC entries — don't try to
  // active-highlight them based on pathname.
  const isAnchor = item.href.includes("#")

  // Active = exact path match (only for non-anchor items).
  const isActive = !isAnchor && pathname === item.href

  // For tree-detection (when to reveal children), strip any hash so
  // we compare the path part only.
  const itemPath = item.href.split("#")[0]
  const isInTree =
    pathname === itemPath || pathname.startsWith(itemPath + "/")

  const linkClassName = cn(
    "rounded-md px-2 py-1.5 no-underline transition-colors",
    // Smaller text + left padding for nested items.
    isChild ? "pl-5 text-xs" : "text-sm",
    item.disabled
      ? "cursor-not-allowed text-muted-foreground/50"
      : isActive
        ? "bg-primary/10 font-medium text-primary"
        : isAnchor
          ? "text-muted-foreground hover:bg-muted hover:text-foreground"
          : "text-foreground hover:bg-muted",
  )

  // Disabled links: span, not Link, so they're inert.
  const linkContent = item.disabled ? (
    <span className={linkClassName}>
      {item.label}
      <span className="ml-1 text-xs opacity-60">soon</span>
    </span>
  ) : (
    <Link href={item.href} className={linkClassName}>
      {item.label}
    </Link>
  )

  return (
    <>
      {linkContent}
      {/* Children only render when we're somewhere in this parent's
          tree — keeps the sidebar uncluttered when the user isn't
          working in this section. */}
      {item.children && isInTree && (
        <div className="flex flex-col gap-0.5">
          {item.children.map((child) => (
            <NavLink
              key={child.href}
              item={child}
              pathname={pathname}
              isChild
            />
          ))}
        </div>
      )}
    </>
  )
}

// Small all-caps label used as a non-clickable header above each
// sidebar group (ATOMS, COMPONENTS). select-none stops it
// participating in text selection — it's chrome, not content.
function SectionHeader({ children }: { children: React.ReactNode }) {
  return (
    <p className="mb-1 px-2 text-[0.65rem] font-semibold tracking-wider text-muted-foreground uppercase select-none">
      {children}
    </p>
  )
}
