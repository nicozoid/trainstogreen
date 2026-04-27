/**
 * Typography page — every named type style in the public app, plus
 * the two font families.
 *
 * Unlike colours/tokens, the source of truth here is the registry
 * file (lib/design-system/typography.ts) — typography isn't
 * tokenised in this codebase, so the registry IS the catalogue.
 * Edit a class string in the registry and the specimen, computed
 * metrics and code chip all update.
 */

import { FontSpecimenCard } from "@/components/design-system/font-specimen-card"
import { TypeSpecimenCard } from "@/components/design-system/type-specimen-card"
import { PageHeader, Section } from "@/components/design-system/section"
import { fonts, typeGroups } from "@/lib/design-system/typography"

export default function TypographyPage() {
  // Same isPublic filter as the other pages.
  const visibleFonts = fonts.filter((f) => f.isPublic)

  return (
    <>
      <PageHeader
        title="Typography"
        subtitle="Every named type style and font family used in the public app."
      />

      {/* --- Fonts ----------------------------------------------- */}
      {/* Single column for fonts because each card is tall (variable
          weight ladder for sans). */}
      <Section
        title="Fonts"
        description="The two families loaded by app/layout.tsx. Everything below uses one of these."
      >
        <div className="grid gap-3">
          {visibleFonts.map((font) => (
            <FontSpecimenCard key={font.id} font={font} />
          ))}
        </div>
      </Section>

      {/* --- Type styles ---------------------------------------- */}
      {/* Each group becomes its own <h2>. Specimens within a group
          flow into a 2-column grid at wider viewports. */}
      {typeGroups.map((group) => {
        const visible = group.specimens.filter((s) => s.isPublic)
        if (visible.length === 0) return null

        return (
          <Section
            key={group.title}
            title={group.title}
            description={group.description}
          >
            <div className="grid gap-3 md:grid-cols-2">
              {visible.map((specimen) => (
                <TypeSpecimenCard key={specimen.id} specimen={specimen} />
              ))}
            </div>
          </Section>
        )
      })}
    </>
  )
}
