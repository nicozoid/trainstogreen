"use client"

/**
 * Inline monospace chip whose contents copy to the clipboard on
 * click. Briefly shows a "copied" state via the title attribute and
 * a subtle background flash so the user sees the action landed.
 *
 * Used by:
 *   - Typography specimen cards (the Tailwind class string)
 *   - Deviations page (each issue's stable code) — TODO when built
 *
 * The chip is ONE component on purpose, so changes to the
 * copy-feedback behaviour ripple everywhere it's used.
 */

import { useState } from "react"
import { cn } from "@/lib/utils"

export function CopyableCode({
  value,
  className,
}: {
  value: string
  className?: string
}) {
  // Two-phase state: idle → copied (250ms flash) → idle. Just a
  // boolean, since we only need "did the user just click".
  const [copied, setCopied] = useState(false)

  const onClick = async () => {
    try {
      await navigator.clipboard.writeText(value)
      setCopied(true)
      // Reset after the flash so the user can copy again. setTimeout
      // is fine here — this UI element is non-critical, doesn't need
      // a more sophisticated retry/cleanup pattern.
      setTimeout(() => setCopied(false), 1200)
    } catch {
      // Clipboard can fail (permissions, insecure context). We
      // swallow silently — the worst case is the user has to copy
      // manually, which is what they were going to do anyway.
    }
  }

  return (
    <button
      type="button"
      onClick={onClick}
      title={copied ? "Copied!" : "Click to copy"}
      className={cn(
        "inline-flex items-center gap-1.5 rounded-md px-2 py-1 font-mono text-xs transition-colors cursor-pointer",
        copied
          ? "bg-primary/15 text-primary"
          : "bg-muted text-foreground hover:bg-muted/70",
        className,
      )}
    >
      <span>{value}</span>
      {/* Subtle "copied" tick. Hidden by visibility toggle so the
          chip width stays stable across states. */}
      <span
        aria-hidden
        className={cn("text-[0.7em]", copied ? "opacity-100" : "opacity-0")}
      >
        ✓
      </span>
    </button>
  )
}
