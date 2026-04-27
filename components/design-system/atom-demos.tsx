"use client"

/**
 * Variant demos for every atom. One file because each demo is
 * short and they all share the same supporting helpers (DemoRow,
 * DemoLabel) — keeps the change log local.
 *
 * The demos render the REAL components from the app. We import them
 * the same way any feature would: from @/components/ui/* etc. That
 * means edits to the source components reflect immediately in the
 * DS without any registry change.
 *
 * For interactive components (Dialog, DropdownMenu, Tooltip) the
 * triggers are functional — clicking opens the real menu/modal.
 */

import { useState } from "react"
import { Search, ChevronDown } from "lucide-react"

// All atoms, imported from the same paths real features use.
import { Button } from "@/components/ui/button"
import { Checkbox } from "@/components/ui/checkbox"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Slider } from "@/components/ui/slider"
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { ThemeToggle } from "@/components/theme-toggle"
import { LogoSpinner } from "@/components/logo-spinner"
import { HelpButton } from "@/components/help-button"

// --- Local layout helpers --------------------------------------------
// DemoRow: a horizontal row with a small label on the left and the
// rendered demos on the right. Used to group related variants.
// flex-wrap so narrow containers wrap demos onto multiple lines.
function DemoRow({
  label,
  children,
}: {
  label: string
  children: React.ReactNode
}) {
  return (
    <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
      <span className="w-24 shrink-0 font-mono text-xs text-muted-foreground">
        {label}
      </span>
      <div className="flex flex-wrap items-center gap-3">{children}</div>
    </div>
  )
}

// DemoStack wraps multiple DemoRows with consistent vertical spacing.
function DemoStack({ children }: { children: React.ReactNode }) {
  return <div className="flex flex-col gap-4">{children}</div>
}

// VariantCell wraps one demo + a small "in use" / "available" caption
// underneath. The caption tells the reader at a glance whether this
// option is actually called by the public app or is just shipped by
// the underlying component. Small pill so it doesn't compete with
// the demo visually. Pure presentation — the caller decides which
// state applies.
function VariantCell({
  used,
  children,
}: {
  used: boolean
  children: React.ReactNode
}) {
  return (
    <div className="flex flex-col items-center gap-1">
      {children}
      <span
        className={
          used
            ? "rounded-full bg-primary/15 px-1.5 py-0.5 font-mono text-[0.6rem] text-primary uppercase tracking-wider"
            : "font-mono text-[0.6rem] text-muted-foreground/60 uppercase tracking-wider"
        }
      >
        {used ? "in use" : "available"}
      </span>
    </div>
  )
}

// --- Button -----------------------------------------------------------
// Button is the only atom with multi-axis variants — we mark each
// cell as "in use" or "available" based on which combinations the
// public app actually calls. Data sourced from
// lib/design-system/components.ts (Button entry's usedVariants /
// usedSizes). Hard-coded here rather than threaded through props
// because the demo's structure already dictates which CVA values to
// show, and reading the registry just to look up booleans would
// indirect a one-line mapping for no real benefit.
const BUTTON_VARIANTS_USED = new Set(["default", "outline", "ghost", "destructive"])
const BUTTON_SIZES_USED = new Set(["default", "xs", "sm", "icon"])

export function ButtonDemo() {
  return (
    <DemoStack>
      <DemoRow label="variants">
        <VariantCell used={BUTTON_VARIANTS_USED.has("default")}>
          <Button>Default</Button>
        </VariantCell>
        <VariantCell used={BUTTON_VARIANTS_USED.has("outline")}>
          <Button variant="outline">Outline</Button>
        </VariantCell>
        <VariantCell used={BUTTON_VARIANTS_USED.has("secondary")}>
          <Button variant="secondary">Secondary</Button>
        </VariantCell>
        <VariantCell used={BUTTON_VARIANTS_USED.has("ghost")}>
          <Button variant="ghost">Ghost</Button>
        </VariantCell>
        <VariantCell used={BUTTON_VARIANTS_USED.has("destructive")}>
          <Button variant="destructive">Destructive</Button>
        </VariantCell>
        <VariantCell used={BUTTON_VARIANTS_USED.has("link")}>
          <Button variant="link">Link</Button>
        </VariantCell>
      </DemoRow>
      <DemoRow label="sizes">
        <VariantCell used={BUTTON_SIZES_USED.has("xs")}>
          <Button size="xs">xs</Button>
        </VariantCell>
        <VariantCell used={BUTTON_SIZES_USED.has("sm")}>
          <Button size="sm">sm</Button>
        </VariantCell>
        <VariantCell used={BUTTON_SIZES_USED.has("default")}>
          <Button>default</Button>
        </VariantCell>
        <VariantCell used={BUTTON_SIZES_USED.has("lg")}>
          <Button size="lg">lg</Button>
        </VariantCell>
      </DemoRow>
      <DemoRow label="icon sizes">
        <VariantCell used={BUTTON_SIZES_USED.has("icon-xs")}>
          <Button size="icon-xs" aria-label="search">
            <Search />
          </Button>
        </VariantCell>
        <VariantCell used={BUTTON_SIZES_USED.has("icon-sm")}>
          <Button size="icon-sm" aria-label="search">
            <Search />
          </Button>
        </VariantCell>
        <VariantCell used={BUTTON_SIZES_USED.has("icon")}>
          <Button size="icon" aria-label="search">
            <Search />
          </Button>
        </VariantCell>
        <VariantCell used={BUTTON_SIZES_USED.has("icon-lg")}>
          <Button size="icon-lg" aria-label="search">
            <Search />
          </Button>
        </VariantCell>
      </DemoRow>
      {/* States are always demonstrated without a "in use" marker —
          enabled/disabled are state, not a variant axis. */}
      <DemoRow label="states">
        <Button>Enabled</Button>
        <Button disabled>Disabled</Button>
      </DemoRow>
    </DemoStack>
  )
}

// --- Checkbox ---------------------------------------------------------
export function CheckboxDemo() {
  // Local state for one of the demos so you can toggle it and watch
  // the tick animation.
  const [checked, setChecked] = useState(true)

  return (
    <DemoStack>
      <DemoRow label="states">
        <Checkbox defaultChecked={false} aria-label="unchecked" />
        <Checkbox defaultChecked aria-label="checked" />
        <Checkbox disabled aria-label="disabled unchecked" />
        <Checkbox disabled defaultChecked aria-label="disabled checked" />
      </DemoRow>
      <DemoRow label="interactive">
        {/* Wrapped in a label so clicking the text toggles the checkbox.
            label is the recommended pattern — clicking anywhere in the
            label triggers the input. */}
        <label className="flex cursor-pointer items-center gap-2 text-sm">
          <Checkbox
            checked={checked}
            onCheckedChange={(v) => setChecked(v === true)}
          />
          Toggle me to see the tick animation
        </label>
      </DemoRow>
    </DemoStack>
  )
}

// --- Input ------------------------------------------------------------
// The demo placeholders mirror the input's only PUBLIC usage in the
// app: the "Other London stations" / "Other stations" search inputs
// that appear inside the primary and friend origin pickers (see
// filter-panel.tsx around line 1137 + 806). The admin-only Search
// bar uses "Search stations" — deliberately not used here so the
// demo represents what non-admin users actually see.
export function InputDemo() {
  // Controlled input so the integrated clear button has something to
  // clear.
  const [value, setValue] = useState("Reading")

  return (
    <DemoStack>
      <DemoRow label="states">
        <div className="w-64">
          <Input placeholder="Other London stations" />
        </div>
        <div className="w-64">
          <Input
            value={value}
            onChange={(e) => setValue(e.target.value)}
            placeholder="Other stations"
          />
        </div>
        <div className="w-40">
          <Input disabled placeholder="Disabled" />
        </div>
      </DemoRow>
    </DemoStack>
  )
}

// --- Label ------------------------------------------------------------
// In public mode, Label is used for the "Direct trains only"
// checkbox in the filter panel (filter-panel.tsx:1336). The demos
// below mirror that pattern (small-text Label paired with a
// Checkbox) rather than admin-only "Station name" form labels.
export function LabelDemo() {
  return (
    <DemoStack>
      <DemoRow label="default">
        <Label htmlFor="demo-direct">Direct trains only</Label>
      </DemoRow>
      <DemoRow label="with checkbox">
        {/* Same shape as the public usage: small muted Label on the
            right of a checkbox. */}
        <div className="flex items-center gap-2">
          <Checkbox id="demo-direct-2" />
          <Label
            htmlFor="demo-direct-2"
            className="cursor-pointer text-xs text-muted-foreground"
          >
            Direct trains only
          </Label>
        </div>
      </DemoRow>
      <DemoRow label="disabled">
        {/* peer-disabled selectors fade the label when its sibling
            checkbox is disabled — the Label's CSS keys off
            `peer-disabled`. */}
        <div className="flex items-center gap-2">
          <Checkbox id="demo-direct-3" disabled className="peer" />
          <Label
            htmlFor="demo-direct-3"
            className="cursor-pointer text-xs text-muted-foreground"
          >
            Disabled toggle
          </Label>
        </div>
      </DemoRow>
    </DemoStack>
  )
}

// --- Slider -----------------------------------------------------------
export function SliderDemo() {
  const [single, setSingle] = useState([45])
  const [range, setRange] = useState([20, 80])

  return (
    <DemoStack>
      <DemoRow label="single thumb">
        <div className="w-full max-w-md">
          <Slider value={single} onValueChange={setSingle} max={100} />
          <p className="mt-2 font-mono text-xs text-muted-foreground">{single[0]}</p>
        </div>
      </DemoRow>
      <DemoRow label="range">
        <div className="w-full max-w-md">
          <Slider value={range} onValueChange={setRange} max={100} />
          <p className="mt-2 font-mono text-xs text-muted-foreground">
            {range[0]} – {range[1]}
          </p>
        </div>
      </DemoRow>
      <DemoRow label="disabled">
        <div className="w-full max-w-md">
          <Slider defaultValue={[30, 70]} disabled />
        </div>
      </DemoRow>
    </DemoStack>
  )
}

// --- Tooltip ----------------------------------------------------------
export function TooltipDemo() {
  return (
    <DemoStack>
      <DemoRow label="hover or focus">
        <Tooltip>
          <TooltipTrigger asChild>
            <Button variant="outline">Hover me</Button>
          </TooltipTrigger>
          <TooltipContent>This is a tooltip</TooltipContent>
        </Tooltip>
        <Tooltip>
          <TooltipTrigger asChild>
            <Button variant="outline" size="icon" aria-label="info">
              <Search />
            </Button>
          </TooltipTrigger>
          <TooltipContent>Information button</TooltipContent>
        </Tooltip>
      </DemoRow>
    </DemoStack>
  )
}

// --- Dialog -----------------------------------------------------------
export function DialogDemo() {
  return (
    <DemoStack>
      <DemoRow label="trigger">
        <Dialog>
          <DialogTrigger asChild>
            <Button>Open dialog</Button>
          </DialogTrigger>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>Example dialog</DialogTitle>
              <DialogDescription>
                Click outside, press Escape, or hit the close button to dismiss.
                Focus is trapped within while open.
              </DialogDescription>
            </DialogHeader>
            <p className="text-sm">
              Dialogs portal to the body and render an overlay backdrop.
            </p>
          </DialogContent>
        </Dialog>
      </DemoRow>
    </DemoStack>
  )
}

// --- DropdownMenu -----------------------------------------------------
export function DropdownMenuDemo() {
  return (
    <DemoStack>
      <DemoRow label="trigger">
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="outline">
              Open menu
              <ChevronDown />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent>
            <DropdownMenuItem>Sort by name</DropdownMenuItem>
            <DropdownMenuItem>Sort by distance</DropdownMenuItem>
            <DropdownMenuItem>Sort by rating</DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem>Reset</DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </DemoRow>
    </DemoStack>
  )
}

// --- ThemeToggle ------------------------------------------------------
export function ThemeToggleDemo() {
  return (
    <DemoStack>
      <DemoRow label="default">
        {/* Note: the ThemeToggle force-locks light mode on viewports
            below md (768px). On a phone screenshot the toggle would
            do nothing. */}
        <ThemeToggle />
      </DemoRow>
    </DemoStack>
  )
}

// --- LogoSpinner ------------------------------------------------------
export function LogoSpinnerDemo() {
  // Note on the className: LogoSpinner has NO height default, despite
  // its docstring claiming `h-8`. Without an explicit height the SVG
  // renders at 0×0 and is invisible. Always pass a size class.
  return (
    <DemoStack>
      <DemoRow label="default">
        <LogoSpinner className="h-8" />
      </DemoRow>
    </DemoStack>
  )
}

// --- HelpButton -------------------------------------------------------
export function HelpButtonDemo() {
  // HelpButton fires its onClick with the button's centre coordinates
  // — the main app uses these to animate the welcome banner out from
  // the click point. In the DS demo we just no-op since we're not
  // mounting the welcome banner.
  return (
    <DemoStack>
      <DemoRow label="default">
        <HelpButton onClick={() => {}} />
      </DemoRow>
    </DemoStack>
  )
}
