"use client"

/**
 * Live demos for the Motion page. Each entry in the registry has a
 * matching demo here, picked via id.
 *
 * Strategy by category:
 *   - Loading: re-use AnimationDemo from the original Tokens page.
 *   - Modal: trigger button → real component opens.
 *   - State: small in-line interactive widgets (Checkbox, Button).
 *   - Map: SVG approximations.
 *   - Feedback: small inline transitions.
 *
 * Where the real component already exists in the app we import and
 * use it (Checkbox, Button, Dialog, DropdownMenu, WelcomeBanner,
 * StationModal). For map-specific motion we approximate with SVG
 * because the real Mapbox layer can't be embedded inline.
 */

import { useState } from "react"
import { Button } from "@/components/ui/button"
import { Checkbox } from "@/components/ui/checkbox"
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
import { ChevronDown } from "lucide-react"
import { LogoSpinner } from "@/components/logo-spinner"
import { WelcomeBanner } from "@/components/welcome-banner"
import StationModal from "@/components/photo-overlay"

// --- Loading ---------------------------------------------------------
export function ShimmerDemo() {
  // The keyframe is registered in globals.css. We render a skeleton
  // bar identical to the original AnimationDemo so the visual reads
  // the same as the rest of the app's loading skeletons.
  return (
    <div className="relative h-6 w-full overflow-hidden rounded bg-muted">
      <div
        className="absolute inset-y-0 left-0 w-1/3 bg-gradient-to-r from-transparent via-foreground/20 to-transparent"
        style={{ animation: "shimmer 1.6s ease-in-out infinite" }}
      />
    </div>
  )
}

export function OrbitDemo() {
  // Real LogoSpinner component — already includes the orbit
  // animation and uses currentColor so the surrounding text-* tints
  // it. h-10 is a typical embedded size.
  return (
    <div className="text-foreground">
      <LogoSpinner className="h-10" />
    </div>
  )
}

// --- Modals ---------------------------------------------------------
export function DialogEnterDemo() {
  return (
    <Dialog>
      <DialogTrigger asChild>
        <Button>Open dialog</Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Dialog enter motion</DialogTitle>
          <DialogDescription>
            Watch the backdrop fade-in (200ms) and the content fade-in + zoom-in
            (100ms).
          </DialogDescription>
        </DialogHeader>
      </DialogContent>
    </Dialog>
  )
}

// Captures the click position of the trigger button so we can pass
// originX / originY to the modal — that's what makes the modal grow
// out of and shrink back into the click point. Used by both
// WelcomeBanner and StationModal demos. Each click captures fresh
// coords so opening the same demo from different points on the
// page makes the animation fly from / to the actual click location.
function useTriggerOrigin(): {
  origin: { x: number; y: number } | undefined
  capture: React.MouseEventHandler<HTMLElement>
} {
  const [origin, setOrigin] = useState<{ x: number; y: number } | undefined>()
  const capture: React.MouseEventHandler<HTMLElement> = (e) => {
    const r = e.currentTarget.getBoundingClientRect()
    setOrigin({ x: r.left + r.width / 2, y: r.top + r.height / 2 })
  }
  return { origin, capture }
}

export function WelcomeBannerEntryExitDemo() {
  const [open, setOpen] = useState(false)
  const { origin, capture } = useTriggerOrigin()
  return (
    <div className="flex flex-col gap-2">
      {/* Button onClick captures its own bounding-rect centre as the
          origin coords, then opens the banner. The banner's entry
          animation grows out of those coords; closing reverses the
          motion back to the same point. */}
      <Button
        onClick={(e) => {
          capture(e)
          setOpen(true)
        }}
      >
        Open welcome banner
      </Button>
      <WelcomeBanner
        open={open}
        onDismiss={() => setOpen(false)}
        originX={origin?.x}
        originY={origin?.y}
      />
    </div>
  )
}

export function StationModalEntryExitDemo() {
  const [open, setOpen] = useState(false)
  const { origin, capture } = useTriggerOrigin()
  return (
    <div className="flex flex-col gap-2">
      <Button
        onClick={(e) => {
          capture(e)
          setOpen(true)
        }}
      >
        Open station modal
      </Button>
      <StationModal
        open={open}
        onClose={() => setOpen(false)}
        stationName="Gomshall"
        lat={51.2192418}
        lng={-0.4422487}
        minutes={77}
        flickrCount={null}
        originX={origin?.x}
        originY={origin?.y}
      />
    </div>
  )
}

export function DropdownMenuOpenCloseDemo() {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="outline">
          Open menu
          <ChevronDown />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent>
        <DropdownMenuItem>Option one</DropdownMenuItem>
        <DropdownMenuItem>Option two</DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem>Option three</DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

// --- State ----------------------------------------------------------
export function CheckboxTickDrawEraseDemo() {
  // Single demo for both directions — toggling the checkbox shows
  // the draw (unchecked → checked, 200ms ease-out) and the erase
  // (checked → unchecked, 150ms ease-in).
  return (
    <label className="flex cursor-pointer items-center gap-2 text-sm">
      <Checkbox defaultChecked={false} />
      Toggle to see draw (200ms) + erase (150ms)
    </label>
  )
}

// Rating-icon jump — replicates the LabelTip behaviour from
// filter-panel.tsx. Click the row → icon hops -3px instantly, then
// a 120ms timer flips a state flag and the icon eases back down
// over 150ms via the inline transition.
export function FilterIconJumpDemo() {
  const [jumped, setJumped] = useState(false)
  const onClick = () => {
    setJumped(true)
    setTimeout(() => setJumped(false), 120)
  }
  return (
    <button
      type="button"
      onClick={onClick}
      className="flex items-center gap-3 text-sm font-medium"
    >
      {/* Same star SVG used by the rating-4 row in the filter
          panel. Wrapped in an inline-block span so the transform
          actually applies (transforms are ignored on bare inline
          elements). */}
      <span
        style={{
          display: "inline-block",
          transform: jumped ? "translateY(-3px)" : "translateY(0)",
          transition: "transform 150ms ease-out",
        }}
      >
        <svg
          viewBox="1 1 22 22"
          fill="var(--primary)"
          stroke="var(--primary)"
          strokeWidth={1.5}
          className="size-4"
        >
          <polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2" />
        </svg>
      </span>
      Sublime
    </button>
  )
}

export function ButtonHoverScaleDemo() {
  // Default variant has the hover-scale + active-translate built
  // into its CVA. Hover or click to see both effects.
  return <Button>Hover or click me</Button>
}

export function FilterPanelCollapseDemo() {
  // Approximate the grid-template-rows animation with a similar
  // pattern so the user can see what the real panel does without
  // mounting a stubbed FilterPanel here.
  const [open, setOpen] = useState(true)
  return (
    <div className="flex flex-col gap-3">
      <Button variant="outline" size="sm" onClick={() => setOpen((v) => !v)}>
        {open ? "Collapse" : "Expand"}
      </Button>
      <div
        className="grid transition-[grid-template-rows] duration-300 ease-in-out"
        style={{ gridTemplateRows: open ? "1fr" : "0fr" }}
      >
        <div className="overflow-hidden">
          <div className="rounded-md bg-muted p-4 text-sm">
            Body content. The grid-template-rows animation collapses this row
            from 1fr → 0fr over 300ms.
          </div>
        </div>
      </div>
    </div>
  )
}

export function FilterPanelChevronDemo() {
  // Same chevron pattern. 200ms default tailwind timing.
  const [open, setOpen] = useState(false)
  return (
    <Button variant="outline" size="sm" onClick={() => setOpen((v) => !v)}>
      Toggle
      <ChevronDown
        className={`transition-transform duration-200 ${open ? "rotate-180" : "rotate-0"}`}
      />
    </Button>
  )
}

// --- Map ------------------------------------------------------------
export function MapFadeInDemo() {
  // Click toggles a 700ms opacity transition on the demo card.
  const [visible, setVisible] = useState(true)
  return (
    <div className="flex flex-col gap-3">
      <Button variant="outline" size="sm" onClick={() => setVisible((v) => !v)}>
        Toggle
      </Button>
      <div
        className={`rounded-md bg-primary px-3 py-2 text-sm text-primary-foreground transition-opacity duration-700 ${
          visible ? "opacity-100" : "opacity-0"
        }`}
      >
        Sample overlay element fading in/out at 700ms.
      </div>
    </div>
  )
}

export function MapHoverGlowDemo() {
  // Same approximation as the Map page — pulsing green ring around
  // a star marker. CSS keyframes here for simplicity (the real one
  // is rAF-driven; same visual effect).
  return (
    <div className="relative flex h-20 items-center justify-center">
      <div
        className="absolute h-12 w-12 rounded-full"
        style={{
          background: "#22c55e",
          filter: "blur(2px)",
          animation: "ds-glow-pulse 1.4s ease-in-out infinite",
        }}
      />
      <style>{`
        @keyframes ds-glow-pulse {
          0%, 100% { opacity: 0.3; transform: scale(1); }
          50% { opacity: 0.75; transform: scale(1.15); }
        }
      `}</style>
      <div className="relative z-10 size-6 rounded-full border-2 border-primary bg-primary/40" />
    </div>
  )
}

export function MapPolylineDrawDemo() {
  // Approximate the line-opacity ramp using SVG. Replay button
  // remounts the path so the animation fires again.
  const [iter, setIter] = useState(0)
  return (
    <div className="flex flex-col gap-3">
      <Button variant="outline" size="sm" onClick={() => setIter((n) => n + 1)}>
        Replay
      </Button>
      <svg
        key={iter}
        width={200}
        height={40}
        viewBox="0 0 200 40"
        className="block"
      >
        <path
          d="M 4 30 Q 50 4, 100 20 T 196 14"
          stroke="var(--tree-800)"
          strokeWidth={2.5}
          fill="none"
          strokeLinecap="round"
          style={{
            opacity: 0,
            animation: "ds-line-fade-in 300ms ease-out forwards",
          }}
        />
        <style>{`
          @keyframes ds-line-fade-in {
            from { opacity: 0; }
            to { opacity: 1; }
          }
        `}</style>
      </svg>
    </div>
  )
}

// --- Feedback -------------------------------------------------------
export function TransitionOpacityDemo() {
  // Show a small pill that fades in/out at 300ms. Mirrors the toast
  // pill behaviour without the admin context.
  const [visible, setVisible] = useState(true)
  return (
    <div className="flex items-center gap-3">
      <Button variant="outline" size="sm" onClick={() => setVisible((v) => !v)}>
        Toggle
      </Button>
      <span
        className={`rounded-full bg-primary px-3 py-1 text-xs font-medium text-primary-foreground transition-opacity duration-300 ${
          visible ? "opacity-100" : "opacity-0"
        }`}
      >
        Toast-like pill
      </span>
    </div>
  )
}

export function PhotoHoverOverlayDemo() {
  // Card with hover-revealed overlay buttons + caption gradient.
  // Same 150ms timing as photo-overlay's photo cards.
  return (
    <div className="group relative h-32 w-full max-w-xs overflow-hidden rounded-md bg-primary/20">
      <div className="h-full w-full bg-gradient-to-br from-primary/40 to-accent/40 transition-opacity duration-150 group-hover:opacity-90" />
      <div className="absolute top-0 right-0 flex gap-1 p-2 opacity-0 transition-opacity duration-150 group-hover:opacity-100">
        <span className="rounded bg-black/60 px-1.5 py-0.5 text-[10px] text-white">
          Pin
        </span>
        <span className="rounded bg-black/60 px-1.5 py-0.5 text-[10px] text-white">
          Approve
        </span>
      </div>
      <div className="pointer-events-none absolute inset-x-0 bottom-0 translate-y-full bg-gradient-to-t from-black/70 to-transparent px-2.5 pb-2 pt-5 transition-transform duration-150 group-hover:translate-y-0">
        <p className="text-xs text-white">Hover me — caption slides up.</p>
      </div>
    </div>
  )
}

export function BreakpointMarkerDemo() {
  // Small horizontal axis with a marker that slides on click.
  const [pos, setPos] = useState(20)
  return (
    <div className="flex flex-col gap-3">
      <div className="flex gap-2">
        {[10, 35, 60, 85].map((p) => (
          <Button
            key={p}
            variant="outline"
            size="xs"
            onClick={() => setPos(p)}
          >
            {p}%
          </Button>
        ))}
      </div>
      <div className="relative h-6 w-full">
        <div className="absolute inset-x-0 top-1/2 h-px bg-border" />
        <div
          className="absolute top-0 h-6 w-0.5 bg-primary transition-[left] duration-150"
          style={{ left: `${pos}%` }}
        />
      </div>
    </div>
  )
}
