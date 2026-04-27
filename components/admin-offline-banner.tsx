"use client"

/**
 * Slim banner pinned to the very top of the viewport, visible only when
 * navigator.onLine is false. Communicates two things at once:
 *   1. "Your phone has no signal" (the trigger condition)
 *   2. "We're not losing your edits" (the queue-count reassurance)
 *
 * Renders BELOW the toast pill but ABOVE the map. When both are visible
 * the toast pill sits over the banner — which is fine because the toast
 * pill is the more time-sensitive signal.
 */

import { WifiOff } from "lucide-react"
import { useAdmin, usePendingCount } from "@/lib/admin-context"
import { cn } from "@/lib/utils"

export function AdminOfflineBanner() {
  const { state } = useAdmin()
  const pendingCount = usePendingCount()
  const visible = !state.online

  return (
    <div
      aria-hidden={!visible}
      aria-live="polite"
      className={cn(
        // Full-width strip pinned at the top, beneath the toast pill.
        // pointer-events-none so a stray tap on the banner doesn't block
        // the map underneath. z-[180] sits below the toast (z-[200]).
        "pointer-events-none fixed inset-x-0 top-0 z-[180] flex justify-center px-2 pt-1",
        "transition-opacity duration-300",
        visible ? "opacity-100" : "opacity-0",
      )}
    >
      <div className="flex items-center gap-2 rounded-md bg-amber-100 dark:bg-amber-900/60 px-3 py-1.5 text-xs font-medium text-amber-900 dark:text-amber-100 shadow-md ring-1 ring-amber-300 dark:ring-amber-700">
        <WifiOff className="h-3.5 w-3.5" />
        <span>
          Offline — your edits will sync when you&rsquo;re back online
          {pendingCount > 0 && (
            <span className="ml-1 opacity-80">
              ({pendingCount} pending)
            </span>
          )}
        </span>
      </div>
    </div>
  )
}
