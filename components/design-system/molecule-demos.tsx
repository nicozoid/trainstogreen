"use client"

/**
 * Live demos for the Molecules tier — the two reusable patterns.
 *
 * Both are small enough that we mount the real component with full
 * props rather than stubs. The Molecule tier exists for components like
 * these — patterns whose shape travels even though the data is
 * app-specific.
 */

import { useState } from "react"
import { ConfirmDialog } from "@/components/confirm-dialog"
import SearchBar from "@/components/search-bar"
import { Button } from "@/components/ui/button"

// --- ConfirmDialog ---------------------------------------------------
// Trigger button opens the dialog with a representative
// destructive-action message. The confirm callback simulates work
// (1s delay) so the "Working…" busy state is observable.
export function ConfirmDialogDemo() {
  const [open, setOpen] = useState(false)
  // Tracks whether the user actually confirmed in the most recent
  // round, so we can give visible feedback after the dialog closes.
  const [lastResult, setLastResult] = useState<"none" | "confirmed">("none")

  return (
    <div className="flex flex-col gap-3">
      <Button variant="destructive" onClick={() => setOpen(true)}>
        Delete walk
      </Button>
      <ConfirmDialog
        open={open}
        onOpenChange={setOpen}
        title="Delete walk?"
        description="The walk will be removed from the station's notes. This can't be undone."
        confirmLabel="Delete"
        onConfirm={async () => {
          // Simulate a save round-trip so the busy state is visible.
          await new Promise((resolve) => setTimeout(resolve, 800))
          setLastResult("confirmed")
        }}
      />
      <p className="text-xs text-muted-foreground italic">
        Click to open. Cancel and Confirm both close the dialog; Confirm flips
        to a &quot;Working…&quot; state for 800ms first.
        {lastResult === "confirmed" && (
          <span className="ml-1 text-foreground/80">Last action: confirmed.</span>
        )}
      </p>
    </div>
  )
}

// --- SearchBar -------------------------------------------------------
// SearchBar is a thin Input wrapper with a fixed "Search stations"
// placeholder; the only state it needs is the value. We expose the
// current value below the bar so the controlled-input wiring is
// observable.
export function SearchBarDemo() {
  const [value, setValue] = useState("")

  return (
    <div className="flex flex-col gap-3 max-w-sm">
      <SearchBar value={value} onChange={setValue} />
      <p className="font-mono text-xs text-muted-foreground">
        value: {value || <span className="italic">(empty)</span>}
      </p>
      <p className="text-xs text-muted-foreground italic">
        The X button appears once the input is non-empty — clicking it fires an
        onChange with an empty string, the same path real consumers see.
      </p>
    </div>
  )
}
