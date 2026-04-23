"use client"

import { useEffect, useState } from "react"

// Floating admin-only button that shows how many data commits are
// queued on `main` beyond the currently-running deployment, and
// triggers a Vercel rebuild on click. Pairs with:
//   - vercel.json       (ignoreCommand skips auto-builds for data-only commits)
//   - /api/dev/publish  (GET = pending status, POST = trigger deploy hook)
//
// Only renders while admin mode is active (the parent gates visibility).

type Status =
  | { phase: "idle"; pending: boolean; count: number; configured: boolean }
  | { phase: "loading" }
  | { phase: "publishing" }
  | { phase: "error"; message: string }
  | { phase: "published" }

export function AdminPublishButton() {
  const [status, setStatus] = useState<Status>({ phase: "loading" })

  // Fetch pending status when the button mounts + poll every 30s so
  // the counter stays roughly live as edits land.
  useEffect(() => {
    let cancelled = false

    async function refresh() {
      try {
        const res = await fetch("/api/dev/publish")
        if (!res.ok) throw new Error(`status ${res.status}`)
        const json = await res.json()
        if (cancelled) return
        setStatus({
          phase: "idle",
          pending: Boolean(json.pending),
          count: Number(json.count) || 0,
          configured: Boolean(json.configured),
        })
      } catch (err) {
        if (cancelled) return
        setStatus({ phase: "error", message: (err as Error).message })
      }
    }

    refresh()
    const interval = setInterval(refresh, 30_000)
    return () => {
      cancelled = true
      clearInterval(interval)
    }
  }, [])

  async function handlePublish() {
    setStatus({ phase: "publishing" })
    try {
      const res = await fetch("/api/dev/publish", { method: "POST" })
      if (!res.ok) {
        const body = await res.json().catch(() => ({}))
        throw new Error(body.error ?? `status ${res.status}`)
      }
      setStatus({ phase: "published" })
      // Return to idle (fresh status) after a short success flash.
      setTimeout(() => setStatus({ phase: "loading" }), 2500)
    } catch (err) {
      setStatus({ phase: "error", message: (err as Error).message })
    }
  }

  // Derived label + disabled state per phase.
  let label = "Publish"
  let subLabel: string | null = null
  let disabled = false
  let tone: "neutral" | "primary" | "error" | "success" = "neutral"

  if (status.phase === "loading") {
    label = "Publish"
    subLabel = "checking…"
    disabled = true
  } else if (status.phase === "publishing") {
    label = "Publishing…"
    disabled = true
    tone = "primary"
  } else if (status.phase === "published") {
    label = "Build triggered"
    subLabel = "~1–2 min"
    disabled = true
    tone = "success"
  } else if (status.phase === "error") {
    label = "Publish"
    subLabel = status.message
    tone = "error"
  } else if (status.phase === "idle") {
    if (!status.configured) {
      label = "Publish"
      subLabel = "hook not set"
      disabled = true
    } else if (status.pending) {
      label = "Publish"
      subLabel = `${status.count} change${status.count === 1 ? "" : "s"} pending`
      tone = "primary"
    } else {
      label = "Publish"
      subLabel = "up to date"
      disabled = true
    }
  }

  // Tailwind: tone drives colour. `primary` uses the app's accent; other
  // tones fall back to neutral greys so a disabled "up to date" state
  // doesn't shout.
  const toneClasses =
    tone === "primary"
      ? "bg-primary text-primary-foreground hover:bg-primary/90"
      : tone === "error"
        ? "bg-destructive text-destructive-foreground"
        : tone === "success"
          ? "bg-emerald-600 text-white"
          : "bg-muted text-muted-foreground"

  return (
    <button
      onClick={handlePublish}
      disabled={disabled}
      className={`pointer-events-auto flex flex-col items-start gap-0.5 rounded-md px-3 py-2 text-left text-sm font-medium shadow-md transition-opacity disabled:opacity-60 ${toneClasses}`}
      aria-label={subLabel ? `${label} — ${subLabel}` : label}
    >
      <span>{label}</span>
      {subLabel && <span className="text-[11px] font-normal opacity-90">{subLabel}</span>}
    </button>
  )
}
