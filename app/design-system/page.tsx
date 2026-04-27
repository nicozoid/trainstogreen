/**
 * Landing page for the DS app at /design-system. Brief overview +
 * quick-jump tiles to each section.
 *
 * Tiles for unbuilt sections render as muted "soon" cards so the
 * user can see what's coming.
 */

import Link from "next/link"
import { ExternalLink } from "lucide-react"
import { PageHeader } from "@/components/design-system/section"
import { cn } from "@/lib/utils"

type Tile = {
  href: string
  title: string
  description: string
  ready?: boolean
}

const TILES: Tile[] = [
  { href: "/design-system/colors", title: "Colour", description: "Semantic tokens and the raw palette.", ready: true },
  { href: "/design-system/tokens", title: "Layout tokens", description: "Spacing, radii, breakpoints, root font-size.", ready: true },
  { href: "/design-system/typography", title: "Typography", description: "Type scale, weights, where each style is used.", ready: true },
  { href: "/design-system/motion", title: "Motion", description: "Keyframes, transitions, modal entry, map reveals — grouped by what motion communicates.", ready: true },
  { href: "/design-system/components", title: "Components", description: "Sorted by complexity into Atoms, Molecules, Macromolecules, Organelles.", ready: true },
  { href: "/design-system/logo", title: "Logo", description: "Brand mark and variations.", ready: true },
  { href: "/design-system/iconography", title: "Iconography", description: "Favicons, OG image, spinners, artwork, icon libraries.", ready: true },
  { href: "/design-system/map", title: "Map", description: "Style URLs, marker shapes, polyline paint, label styling, hover state.", ready: true },
  { href: "/design-system/anomalies", title: "Anomalies", description: "Places where the design system isn't being followed (some intentional, some not).", ready: true },
]

// External tools that complement the DS — link previews, audits,
// asset generators. Ordered roughly by frequency of use.
type ExternalResource = {
  url: string
  title: string
  description: string
}

const EXTERNAL_RESOURCES: ExternalResource[] = [
  {
    url: "https://www.opengraph.xyz/url/https%3A%2F%2Ftrainstogreen.niczap.design",
    title: "Open Graph preview",
    description:
      "See how this site's URL renders as a share-card on Twitter, Facebook, LinkedIn, and others. Useful after editing app/opengraph-image.jpg or the openGraph metadata.",
  },
]

export default function DesignSystemHome() {
  return (
    <>
      <PageHeader
        title="Design system"
        subtitle="A live reference for every visual primitive used in this app."
      />

      {/* grid auto-layouts the tiles. md:grid-cols-2 means 1 column on
          mobile, 2 from medium screens up. gap-3 is the inter-tile
          spacing. */}
      <div className="grid gap-3 md:grid-cols-2">
        {TILES.map((tile) => {
          const className = cn(
            "block rounded-lg border border-border bg-card p-4 no-underline transition-colors",
            tile.ready
              ? "hover:bg-muted"
              : "cursor-not-allowed opacity-60",
          )
          // If a section isn't ready, render a non-interactive div so
          // it shows up but doesn't navigate anywhere.
          const Inner = (
            <>
              <div className="flex items-center justify-between">
                <h2 className="text-base font-semibold">{tile.title}</h2>
                {!tile.ready && (
                  <span className="font-mono text-xs text-muted-foreground">soon</span>
                )}
              </div>
              <p className="mt-1 text-sm text-muted-foreground">{tile.description}</p>
            </>
          )
          return tile.ready ? (
            <Link key={tile.href} href={tile.href} className={className}>
              {Inner}
            </Link>
          ) : (
            <div key={tile.href} className={className}>
              {Inner}
            </div>
          )
        })}
      </div>

      {/* --- External resources ------------------------------------ */}
      {/* Tools that aren't part of this codebase but pair with DS
          work — share-card previews, contrast checkers, etc. Lives
          on the overview rather than in the sidebar because each
          link is a one-shot reference, not a destination you
          navigate to repeatedly. */}
      <section className="mt-12">
        <h2 className="mb-1 text-lg font-semibold tracking-tight">External resources</h2>
        <p className="mb-4 text-sm text-muted-foreground">
          Third-party tools that pair with this design system.
        </p>
        <div className="grid gap-3 md:grid-cols-2">
          {EXTERNAL_RESOURCES.map((resource) => (
            // Plain anchor (not Next Link) because these go off-site.
            // target="_blank" + rel="noopener noreferrer" is the standard
            // safe-external-link pattern.
            <a
              key={resource.url}
              href={resource.url}
              target="_blank"
              rel="noopener noreferrer"
              className="block rounded-lg border border-border bg-card p-4 no-underline transition-colors hover:bg-muted"
            >
              <div className="flex items-center justify-between">
                <h3 className="text-base font-semibold">{resource.title}</h3>
                {/* External-link icon hints that the tile leaves the
                    site. Sized to match Tile-row chevrons. */}
                <ExternalLink className="size-4 text-muted-foreground" />
              </div>
              <p className="mt-1 text-sm text-muted-foreground">{resource.description}</p>
            </a>
          ))}
        </div>
      </section>
    </>
  )
}
