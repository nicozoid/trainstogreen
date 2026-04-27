/**
 * Organelles tier page — full subsystems of the app.
 *
 * Same shape as the other tier pages: header + composition cards.
 * Each card pairs registry metadata with a hand-written live demo
 * from organelle-demos.tsx. Currently the only public organelle is
 * PhotoOverlay; if more are added, register them and add a case
 * below.
 */

import { ComponentSection } from "@/components/design-system/component-section"
import { TierIntro } from "@/components/design-system/tier-intro"
import { PhotoOverlayDemo } from "@/components/design-system/organelle-demos"
import { organelles } from "@/lib/design-system/components"

function pickDemo(id: string): React.ReactNode {
  switch (id) {
    case "photo-overlay": return <PhotoOverlayDemo />
    default:
      return (
        <p className="text-sm text-muted-foreground">
          Demo not yet wired up.
        </p>
      )
  }
}

export default function OrganellesPage() {
  const visible = organelles.filter((c) => c.isPublic)

  return (
    <>
      <TierIntro tier="organelles" />

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
