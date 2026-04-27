/**
 * Atoms tier page — the 11 single-purpose primitives.
 *
 * One ComponentSection card per entry. Each card pairs the
 * registry's metadata with a hand-written variant demo from
 * atom-demos.tsx. The mapping from id → demo is explicit (a switch
 * in pickDemo) rather than dynamic-import based so we get
 * type-checking on the demo names.
 */

import { ComponentSection } from "@/components/design-system/component-section"
import {
  ButtonDemo,
  CheckboxDemo,
  DialogDemo,
  DropdownMenuDemo,
  HelpButtonDemo,
  InputDemo,
  LabelDemo,
  LogoSpinnerDemo,
  SliderDemo,
  ThemeToggleDemo,
  TooltipDemo,
} from "@/components/design-system/atom-demos"
import { TierIntro } from "@/components/design-system/tier-intro"
import { atoms } from "@/lib/design-system/components"

// Maps a registry id to the corresponding demo component. Centralised
// here so adding a new atom is a single place to wire up.
function pickDemo(id: string): React.ReactNode {
  switch (id) {
    case "button": return <ButtonDemo />
    case "checkbox": return <CheckboxDemo />
    case "input": return <InputDemo />
    case "label": return <LabelDemo />
    case "slider": return <SliderDemo />
    case "tooltip": return <TooltipDemo />
    case "dialog": return <DialogDemo />
    case "dropdown-menu": return <DropdownMenuDemo />
    case "theme-toggle": return <ThemeToggleDemo />
    case "logo-spinner": return <LogoSpinnerDemo />
    case "help-button": return <HelpButtonDemo />
    default:
      // No demo wired up yet — fall back to a placeholder so the
      // section still renders without breaking the page.
      return (
        <p className="text-sm text-muted-foreground">
          Demo not yet wired up.
        </p>
      )
  }
}

export default function AtomsPage() {
  const visible = atoms.filter((c) => c.isPublic)

  return (
    <>
      <TierIntro tier="atoms" />

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
