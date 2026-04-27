/**
 * Components landing page. Explains the four-tier framework
 * (Atoms → Molecules → Macromolecules → Organelles) and links to
 * each tier page.
 *
 * The framework is documented HERE rather than on each tier page so
 * the discriminator tests are visible in one place — useful when you
 * land cold and need to remember which tier a component belongs to.
 */

import Link from "next/link"
import { PageHeader } from "@/components/design-system/section"
import {
  atoms,
  macromolecules,
  molecules,
  organelles,
  tierInfo,
  type Tier,
} from "@/lib/design-system/components"

// Map each tier to its component count + the tier's URL path. Done at
// page level (not in tierInfo) because counts are dynamic.
const TIERS: { key: Tier; href: string; count: number }[] = [
  { key: "atoms", href: "/design-system/components/atoms", count: atoms.length },
  { key: "molecules", href: "/design-system/components/molecules", count: molecules.length },
  { key: "macromolecules", href: "/design-system/components/macromolecules", count: macromolecules.length },
  { key: "organelles", href: "/design-system/components/organelles", count: organelles.length },
]

export default function ComponentsLandingPage() {
  return (
    <>
      <PageHeader
        title="Components"
        subtitle="Sorted into four tiers by complexity and reusability. The discriminator test on each card decides borderline cases."
      />

      <div className="flex flex-col gap-3">
        {TIERS.map(({ key, href }) => {
          const info = tierInfo[key]
          const visibleCount = countVisible(key)
          return (
            // Each tier is its own card. Link wraps the whole card so
            // the entire surface is clickable.
            <Link
              key={key}
              href={href}
              className="block rounded-lg border border-border bg-card p-5 no-underline transition-colors hover:bg-muted"
            >
              {/* Header row: tier name + tagline + entry count */}
              <div className="mb-3 flex items-baseline gap-3">
                <h2 className="text-lg font-semibold">{info.name}</h2>
                <p className="text-sm text-muted-foreground">{info.tagline}</p>
                <p className="ml-auto font-mono text-xs text-muted-foreground">
                  {visibleCount} component{visibleCount === 1 ? "" : "s"}
                </p>
              </div>

              {/* Definition */}
              <p className="text-sm text-foreground/90">{info.definition}</p>

              {/* Two-column metadata: the test + what it's built on */}
              <div className="mt-3 grid gap-2 text-xs sm:grid-cols-2">
                <div>
                  <p className="text-muted-foreground">Test</p>
                  <p className="text-foreground/80 italic">{info.test}</p>
                </div>
                <div>
                  <p className="text-muted-foreground">Built on</p>
                  <p className="text-foreground/80">{info.builtOn}</p>
                </div>
              </div>
            </Link>
          )
        })}
      </div>
    </>
  )

  // Local helper — counts only public entries, matching what each
  // tier page renders. Defined inside the function so we can close
  // over the imported tier arrays without cluttering module scope.
  function countVisible(tier: Tier): number {
    const list =
      tier === "atoms" ? atoms
      : tier === "molecules" ? molecules
      : tier === "macromolecules" ? macromolecules
      : organelles
    return list.filter((c) => c.isPublic).length
  }
}
