"use client"

/**
 * Iconography page — every non-logo visual asset, plus the icon
 * libraries the app pulls glyphs from.
 *
 * Sections:
 *   1. Favicons          — browser tab icons (SVG + ICO fallback)
 *   2. Open Graph image  — social-sharing preview
 *   3. Loading spinner   — the LogoSpinner live, at multiple sizes
 *   4. Hero artwork      — the welcome-banner PNG
 *   5. Icon libraries    — Lucide / Hugeicons / Tabler with samples
 *
 * Most of these are one-off (single asset), so the demos are inline
 * rather than factored into reusable components.
 */

import {
  Search,
  Moon,
  Sun,
  X,
  CircleHelp,
  ChevronDown,
} from "lucide-react"
import { HugeiconsIcon } from "@hugeicons/react"
import {
  Tick02Icon,
  Cancel01Icon,
} from "@hugeicons/core-free-icons"
import {
  IconTrainFilled,
  IconChevronDown,
  IconPlus,
  IconX,
  IconCheck,
} from "@tabler/icons-react"
import { LogoSpinner } from "@/components/logo-spinner"
import { PageHeader, Section } from "@/components/design-system/section"

// One sample-icon entry. Used for the Icon libraries section grid.
type IconSample = {
  name: string
  // Pre-rendered React node — keeps import management local. Avoids
  // a registry-of-icons indirection that would just push the
  // imports somewhere else.
  node: React.ReactNode
}

const LUCIDE_SAMPLES: IconSample[] = [
  { name: "Sun", node: <Sun size={20} /> },
  { name: "Moon", node: <Moon size={20} /> },
  { name: "X", node: <X size={20} /> },
  { name: "Search", node: <Search size={20} /> },
  { name: "CircleHelp", node: <CircleHelp size={20} /> },
  { name: "ChevronDown", node: <ChevronDown size={20} /> },
]

const HUGEICONS_SAMPLES: IconSample[] = [
  // The HugeiconsIcon wrapper takes the icon prop + size. strokeWidth
  // here matches what the actual usages pass.
  { name: "Tick02Icon", node: <HugeiconsIcon icon={Tick02Icon} size={20} strokeWidth={2.5} /> },
  { name: "Cancel01Icon", node: <HugeiconsIcon icon={Cancel01Icon} size={20} strokeWidth={2.5} /> },
]

const TABLER_SAMPLES: IconSample[] = [
  { name: "IconTrainFilled", node: <IconTrainFilled size={20} /> },
  { name: "IconChevronDown", node: <IconChevronDown size={20} /> },
  { name: "IconPlus", node: <IconPlus size={20} /> },
  { name: "IconX", node: <IconX size={20} /> },
  { name: "IconCheck", node: <IconCheck size={20} /> },
]

// Single icon cell — small surface with the glyph centred and the
// import name underneath. Hover does nothing; this is reference, not
// interactive.
function IconCell({ sample }: { sample: IconSample }) {
  return (
    <div className="flex flex-col items-center gap-2 rounded-lg border border-border bg-card p-4">
      <div className="flex h-10 w-10 items-center justify-center text-foreground">
        {sample.node}
      </div>
      <code className="text-center font-mono text-xs text-muted-foreground">
        {sample.name}
      </code>
    </div>
  )
}

// Small library card — name + import path + grid of icons. Same
// structure for all three libraries to make them easy to compare.
function LibraryCard({
  name,
  importPath,
  description,
  samples,
}: {
  name: string
  importPath: string
  description: string
  samples: IconSample[]
}) {
  return (
    <div className="rounded-lg border border-border bg-card p-5">
      <div className="mb-3 flex items-baseline gap-3">
        <h3 className="text-base font-semibold">{name}</h3>
        <code className="font-mono text-xs text-muted-foreground">
          {importPath}
        </code>
      </div>
      <p className="mb-4 text-sm text-foreground/80">{description}</p>
      <div className="grid gap-3 [grid-template-columns:repeat(auto-fill,minmax(7rem,1fr))]">
        {samples.map((s) => (
          <IconCell key={s.name} sample={s} />
        ))}
      </div>
    </div>
  )
}

export default function IconographyPage() {
  return (
    <>
      <PageHeader
        title="Iconography"
        subtitle="Brand-shaped pixel and SVG assets, plus the third-party icon libraries components pull glyphs from."
      />

      {/* --- Favicons --------------------------------------------- */}
      <Section
        title="Favicons"
        description="Browser-tab icons. Modern browsers prefer the SVG; the ICO is the legacy fallback."
      >
        <div className="grid gap-3 sm:grid-cols-2">
          {/* SVG favicon. Rendered at 32×32 (a common tab size) with
              a subtle bordered surface so the asset's edges are
              visible against the page. */}
          <div className="rounded-lg border border-border bg-card p-5">
            <div className="mb-4 flex items-center justify-center bg-muted/40 p-6">
              <img
                src="/trainstogreen-favicon.svg"
                alt="Favicon at 32px"
                width={32}
                height={32}
              />
            </div>
            <p className="text-sm font-semibold">SVG favicon</p>
            <p className="mt-1 font-mono text-xs text-muted-foreground">
              public/trainstogreen-favicon.svg
            </p>
            <p className="mt-2 text-xs text-foreground/80">
              Set as the active favicon in <code className="font-mono">app/layout.tsx</code>.
            </p>
          </div>

          {/* ICO fallback. Rendered with <img> at 32×32 — browsers
              will pick whichever ICO frame matches that size. */}
          <div className="rounded-lg border border-border bg-card p-5">
            <div className="mb-4 flex items-center justify-center bg-muted/40 p-6">
              <img
                src="/favicon.ico"
                alt="Favicon at 32px"
                width={32}
                height={32}
              />
            </div>
            <p className="text-sm font-semibold">ICO fallback</p>
            <p className="mt-1 font-mono text-xs text-muted-foreground">
              app/favicon.ico
            </p>
            <p className="mt-2 text-xs text-foreground/80">
              Multi-size container for browsers that don't support SVG favicons.
            </p>
          </div>
        </div>
      </Section>

      {/* --- Loading spinner -------------------------------------- */}
      <Section
        title="Loading spinner"
        description="The LogoSpinner — used by the welcome banner during the initial map-data computation, and by the photo panel while photos load. Built from the brand glyph with an animated coupling rod."
      >
        <div className="grid gap-3 sm:grid-cols-3">
          {/* Three sizes — small (the default), medium, large.
              LogoSpinner uses currentColor so we can show different
              tints by changing text-* on the wrapper. */}
          <div className="flex flex-col items-center gap-3 rounded-lg border border-border bg-card p-6">
            <div className="text-foreground">
              <LogoSpinner className="h-6" />
            </div>
            <p className="font-mono text-xs text-muted-foreground">h-6 (default)</p>
          </div>
          <div className="flex flex-col items-center gap-3 rounded-lg border border-border bg-card p-6">
            <div className="text-primary">
              <LogoSpinner className="h-10" />
            </div>
            <p className="font-mono text-xs text-muted-foreground">h-10 · text-primary</p>
          </div>
          <div className="flex flex-col items-center gap-3 rounded-lg border border-border bg-card p-6">
            <div className="text-accent">
              <LogoSpinner className="h-14" />
            </div>
            <p className="font-mono text-xs text-muted-foreground">h-14 · text-accent</p>
          </div>
        </div>
        <p className="mt-3 font-mono text-xs text-muted-foreground">
          components/logo-spinner.tsx
        </p>
      </Section>

      {/* --- Hero artwork ---------------------------------------- */}
      <Section
        title="Hero artwork"
        description="Illustration used as the welcome-banner header. Also the README's hero. 1024×1024 PNG — the only large pixel asset shipped with the app."
      >
        {/* Render at native 1:1 so the asset is shown unmodified.
            In real use, the welcome-banner crops it to 16:9 via
            aspect-video + object-cover; the DS surfaces the source
            instead so a designer sees the full illustration. */}
        <div className="rounded-lg border border-border bg-card p-4">
          <img
            src="/trainstogreen-hero.png"
            alt="Hero — Trains to Green"
            className="mx-auto block w-full max-w-md rounded-md"
            style={{ aspectRatio: "1 / 1" }}
          />
          <p className="mt-3 font-mono text-xs text-muted-foreground">
            public/trainstogreen-hero.png
          </p>
          <p className="mt-2 text-xs text-foreground/80">
            Used in <code className="font-mono">components/welcome-banner.tsx</code> (cropped to 16:9 via <code className="font-mono">aspect-video object-cover</code>) and the README.
          </p>
        </div>
      </Section>

      {/* --- Icon libraries -------------------------------------- */}
      <Section
        title="Icon libraries"
        description="The app pulls glyphs from three icon sets. They're not interchangeable — each has a slightly different visual language. Pick whichever matches the surrounding context, but don't mix two libraries side by side."
      >
        <div className="flex flex-col gap-4">
          <LibraryCard
            name="Lucide"
            importPath='import { … } from "lucide-react"'
            description="Used for general-purpose UI icons (Sun/Moon for the theme toggle, X for clear/close, Search, CircleHelp). Stroke-based, geometric, light weight."
            samples={LUCIDE_SAMPLES}
          />
          <LibraryCard
            name="Hugeicons"
            importPath='import { Xxx } from "@hugeicons/core-free-icons" + <HugeiconsIcon /> from "@hugeicons/react"'
            description="Used for the checkbox tick (Tick02) and dialog close (Cancel01). Their stroke + corner style sits well at small sizes (≤16px) where Lucide reads thin."
            samples={HUGEICONS_SAMPLES}
          />
          <LibraryCard
            name="Tabler"
            importPath='import { IconXxx } from "@tabler/icons-react"'
            description="Used for the train glyph (IconTrainFilled) and filter-panel chrome (chevron, plus, x). The Filled variant is heavier and reads as a label, not an action."
            samples={TABLER_SAMPLES}
          />
        </div>
      </Section>
    </>
  )
}
