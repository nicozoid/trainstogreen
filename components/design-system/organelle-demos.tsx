"use client"

/**
 * Live demo for the Organelles tier — currently just PhotoOverlay
 * (the full station-detail modal).
 *
 * The component is exported as `StationModal` from photo-overlay.tsx
 * — the file name reflects an earlier draft. We mount it with only
 * the seven required props, leaving every optional prop unset. That
 * shows the modal's structural shell (header, journey row, walks
 * area, photos area) without forcing us to stub Flickr photo lists,
 * walk prose, journey data, presets, etc.
 */

import { useState } from "react"
import StationModal from "@/components/photo-overlay"
import { Button } from "@/components/ui/button"

export function PhotoOverlayDemo() {
  const [open, setOpen] = useState(false)

  return (
    <div className="flex flex-col gap-3">
      <Button onClick={() => setOpen(true)}>Open station modal</Button>
      {/* Mounted unconditionally — like WelcomeBanner, it owns its own
          close-animation state that needs to survive the open/close
          cycle. The modal portals itself to body, so it overlays the
          DS rather than rendering inline. */}
      <StationModal
        open={open}
        onClose={() => setOpen(false)}
        // Demo station — Gomshall is a real station on the North
        // Downs Line south of London. Picked as the demo because
        // it has a richer set of associated walks + photos than
        // most stations, so the modal demonstrates more of its
        // sub-sections.
        stationName="Gomshall"
        lat={51.2192418}
        lng={-0.4422487}
        minutes={77}
        flickrCount={null}
      />
      <p className="text-xs text-muted-foreground italic">
        Click to open the modal at minimal data. Most sections (photos, walks,
        journey alternates) are empty because the demo passes only the seven
        required props — the real app feeds it 40+ more.
      </p>
    </div>
  )
}
