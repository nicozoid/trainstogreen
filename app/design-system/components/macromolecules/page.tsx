/**
 * Macromolecules tier page — domain-specific regions of the screen.
 *
 * Same shape as the other tier pages: header + composition cards.
 * Each card pairs the registry metadata with a hand-written live
 * demo from macromolecule-demos.tsx. The demos here are heavier
 * than Atom or Molecule demos because Macromolecules are full
 * feature regions — FilterPanel needs ~50 stub props to stand
 * alone, WelcomeBanner portals itself as a full-screen modal.
 */

import { ComponentSection } from "@/components/design-system/component-section"
import { TierIntro } from "@/components/design-system/tier-intro"
import {
  FilterPanelDemo,
  WelcomeBannerDemo,
} from "@/components/design-system/macromolecule-demos"
import { macromolecules } from "@/lib/design-system/components"

// id → demo mapping. Same explicit-switch pattern as Atoms so the
// wiring is type-checked.
function pickDemo(id: string): React.ReactNode {
  switch (id) {
    case "filter-panel": return <FilterPanelDemo />
    case "welcome-banner": return <WelcomeBannerDemo />
    default:
      return (
        <p className="text-sm text-muted-foreground">
          Demo not yet wired up.
        </p>
      )
  }
}

export default function MacromoleculesPage() {
  const visible = macromolecules.filter((c) => c.isPublic)

  return (
    <>
      <TierIntro tier="macromolecules" />

      <div className="flex flex-col gap-6">
        {visible.map((entry) => (
          <ComponentSection key={entry.id} entry={entry}>
            {pickDemo(entry.id)}
          </ComponentSection>
        ))}
      </div>
    </>
  )
}
