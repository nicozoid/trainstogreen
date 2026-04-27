"use client"

/**
 * Top-centre admin toast. Mirrors the chrome of the existing notification
 * pill in map.tsx (rounded-full, ring-1, shadow-lg) but pinned to the
 * TOP of the viewport so it doesn't fight the bottom-pinned filter pill.
 *
 * Three states (driven by the outbox's `toast` slot):
 *   - saving  → spinner + "Saving…"
 *   - saved   → check icon + "Saved · 14:32"
 *   - error   → alert ring + "Save failed — try again"
 *
 * z-[200] keeps it above the photo overlay (z-[100]) and any Radix portal.
 */

import { Check, AlertTriangle, Loader2 } from "lucide-react"
import { useAdmin } from "@/lib/admin-context"
import { cn } from "@/lib/utils"

export function AdminToastPill() {
  const { state } = useAdmin()
  const t = state.toast
  const visible = !!t

  // Pick icon + ring colour per state. We always render the wrapper —
  // visibility is just an opacity flip — so the fade-in/out animates
  // smoothly without a remount.
  const icon = !t ? null
    : t.kind === "saving" ? <Loader2 className="h-4 w-4 animate-spin text-primary" />
    : t.kind === "saved" ? <Check className="h-4 w-4 text-primary" />
    : <AlertTriangle className="h-4 w-4 text-destructive" />

  return (
    <div
      aria-hidden={!visible}
      aria-live="polite"
      className={cn(
        // Top-centre fixed positioning. pt-3 keeps it off the very edge
        // (esp. iPhone notch); px-4 keeps long messages off the screen
        // edges on narrow widths. pointer-events-none so it never blocks
        // a click on the map underneath.
        "pointer-events-none fixed inset-x-0 top-0 z-[200] flex justify-center pt-3 px-4",
        "transition-opacity duration-300",
        visible ? "opacity-100" : "opacity-0",
      )}
    >
      <div
        className={cn(
          "flex items-center gap-2 rounded-full bg-background/95 px-4 py-2 shadow-lg ring-1",
          // Ring colour switches to destructive for error so the pill is
          // unmistakably "something went wrong" rather than just "info".
          t?.kind === "error" ? "ring-destructive/40" : "ring-border",
        )}
      >
        {icon}
        <span className="text-sm font-medium text-foreground">
          {t?.message ?? ""}
        </span>
      </div>
    </div>
  )
}
