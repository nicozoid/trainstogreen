/**
 * Molecules tier page — reusable patterns whose shape travels.
 *
 * Same structure as the other tier pages. Each card pairs registry
 * metadata with a hand-written live demo from molecule-demos.tsx.
 * Molecules are small enough to mount with full props (no stubbing
 * needed).
 */

import { ComponentSection } from "@/components/design-system/component-section"
import { TierIntro } from "@/components/design-system/tier-intro"
import {
  ConfirmDialogDemo,
  SearchBarDemo,
} from "@/components/design-system/molecule-demos"
import { molecules } from "@/lib/design-system/components"

function pickDemo(id: string): React.ReactNode {
  switch (id) {
    case "confirm-dialog": return <ConfirmDialogDemo />
    case "search-bar": return <SearchBarDemo />
    default:
      return (
        <p className="text-sm text-muted-foreground">
          Demo not yet wired up.
        </p>
      )
  }
}

export default function MoleculesPage() {
  const visible = molecules.filter((c) => c.isPublic)

  return (
    <>
      <TierIntro tier="molecules" />

      {visible.length === 0 ? (
        // Showing the absence rather than rendering a blank page —
        // this is a real DS finding (the public app currently has no
        // Molecule-tier components; every reusable pattern that
        // exists is admin-only). Worth surfacing rather than hiding.
        <div className="rounded-lg border border-dashed border-border bg-card p-8 text-sm text-muted-foreground">
          <p className="mb-2 font-medium text-foreground/90">
            No public Molecule-tier components yet.
          </p>
          <p>
            The reusable patterns that exist in this codebase (ConfirmDialog,
            SearchBar) are currently only mounted from admin-only contexts, so
            they don&apos;t appear here. They live in the registry with{" "}
            <code className="font-mono">isPublic: false</code> — promote one to{" "}
            <code className="font-mono">isPublic: true</code> when a public
            usage lands.
          </p>
        </div>
      ) : (
        <div className="flex flex-col gap-6">
          {visible.map((entry) => (
            <ComponentSection key={entry.id} entry={entry}>
              {pickDemo(entry.id)}
            </ComponentSection>
          ))}
        </div>
      )}
    </>
  )
}
