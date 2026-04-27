"use client"

/**
 * Admin "Edits" dialog — answers two questions:
 *   1. What's queued locally that hasn't synced yet? (top section)
 *   2. What landed in main recently? (bottom section, fed by /api/dev/recent-edits)
 *
 * Both sections poll while the dialog is open so the admin can watch the
 * queue drain in real time and confirm a recent commit landed.
 */

import { useCallback, useEffect, useState } from "react"
import { ExternalLink, RotateCw, X } from "lucide-react"
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog"
import { useAdmin } from "@/lib/admin-context"
import { cn } from "@/lib/utils"

type EditRow = {
  sha: string
  message: string
  author: string
  dateISO: string
  filesChanged: string[]
  url: string
}

const POLL_MS = 5000

type Props = {
  open: boolean
  onOpenChange: (open: boolean) => void
}

export function AdminEditsDialog({ open, onOpenChange }: Props) {
  const { state, retry, dismiss } = useAdmin()
  const [recent, setRecent] = useState<EditRow[]>([])
  const [loading, setLoading] = useState(false)

  const fetchRecent = useCallback(async () => {
    setLoading(true)
    try {
      const res = await fetch("/api/dev/recent-edits", { cache: "no-store" })
      if (res.ok) setRecent((await res.json()) as EditRow[])
    } catch {
      // Quiet — the queued items stay visible regardless.
    } finally {
      setLoading(false)
    }
  }, [])

  // Poll while open. Stop on close (effect cleanup) so we're not hammering
  // the GitHub API in the background.
  useEffect(() => {
    if (!open) return
    void fetchRecent()
    const id = setInterval(fetchRecent, POLL_MS)
    return () => clearInterval(id)
  }, [open, fetchRecent])

  const items = state.items
  const hasQueue = items.length > 0

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl max-h-[85vh] overflow-hidden flex flex-col">
        <DialogHeader>
          <DialogTitle>Edits</DialogTitle>
          <DialogDescription>
            What&rsquo;s queued locally and what&rsquo;s recently landed on{" "}
            <code className="text-xs">main</code>.
          </DialogDescription>
        </DialogHeader>

        <div className="overflow-y-auto flex-1 -mx-6 px-6 space-y-6">
          {/* Pending queue. Hidden entirely when empty so the dialog
              doesn't show "no pending items" — it's noise. */}
          {hasQueue && (
            <section>
              <h3 className="text-sm font-semibold text-foreground mb-2">
                Pending ({items.length})
              </h3>
              <ul className="space-y-1.5">
                {items.map((it) => (
                  <li
                    key={it.id}
                    className={cn(
                      "flex items-start gap-2 rounded-md px-3 py-2 text-sm ring-1",
                      it.status === "failed"
                        ? "bg-destructive/5 ring-destructive/30"
                        : "bg-muted ring-border",
                    )}
                  >
                    <div className="flex-1 min-w-0">
                      <div className="font-medium truncate">{it.label}</div>
                      <div className="text-xs text-muted-foreground">
                        {it.status === "sending" && "Sending…"}
                        {it.status === "pending" && (
                          <>Queued {timeAgo(it.enqueuedAt)} · {it.attempts > 0 ? `${it.attempts} attempt${it.attempts === 1 ? "" : "s"}` : "not yet sent"}</>
                        )}
                        {it.status === "failed" && (
                          <>Failed · {it.lastError ?? "unknown error"}</>
                        )}
                      </div>
                    </div>
                    {it.status === "failed" && (
                      <div className="flex items-center gap-1 shrink-0">
                        <button
                          onClick={() => retry(it.id)}
                          className="p-1 rounded hover:bg-background"
                          aria-label="Retry"
                          title="Retry"
                        >
                          <RotateCw className="h-3.5 w-3.5" />
                        </button>
                        <button
                          onClick={() => dismiss(it.id)}
                          className="p-1 rounded hover:bg-background"
                          aria-label="Dismiss"
                          title="Dismiss"
                        >
                          <X className="h-3.5 w-3.5" />
                        </button>
                      </div>
                    )}
                  </li>
                ))}
              </ul>
            </section>
          )}

          {/* Recent commits. Always shown so the admin always has SOME
              feedback — even when the queue is empty. */}
          <section>
            <h3 className="text-sm font-semibold text-foreground mb-2">
              Recent commits
              {loading && recent.length === 0 && (
                <span className="ml-2 text-xs font-normal text-muted-foreground">loading…</span>
              )}
            </h3>
            {recent.length === 0 && !loading && (
              <div className="text-sm text-muted-foreground">No recent edits found.</div>
            )}
            <ul className="space-y-1">
              {recent.map((row) => (
                <li
                  key={row.sha}
                  className="flex items-start gap-2 text-sm rounded-md px-3 py-1.5 hover:bg-muted/50"
                >
                  <div className="flex-1 min-w-0">
                    <div className="truncate">{row.message}</div>
                    <div className="text-xs text-muted-foreground">
                      {timeAgo(new Date(row.dateISO).getTime())} · {row.author}
                      {row.filesChanged.length > 0 && (
                        <> · {row.filesChanged.length === 1
                          ? row.filesChanged[0].replace(/^data\//, "")
                          : `${row.filesChanged.length} files`}</>
                      )}
                    </div>
                  </div>
                  <a
                    href={row.url}
                    target="_blank"
                    rel="noreferrer"
                    className="shrink-0 p-1 text-muted-foreground hover:text-foreground"
                    aria-label="Open commit on GitHub"
                  >
                    <ExternalLink className="h-3.5 w-3.5" />
                  </a>
                </li>
              ))}
            </ul>
          </section>
        </div>
      </DialogContent>
    </Dialog>
  )
}

// Compact relative time — "12s ago" / "3m ago" / "1h ago" / "2d ago".
// Days is the upper limit because anything older isn't worth scanning
// the audit dialog for (the recent-edits endpoint caps at 50 anyway).
function timeAgo(ms: number): string {
  const diff = Date.now() - ms
  const s = Math.floor(diff / 1000)
  if (s < 60) return `${s}s ago`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}m ago`
  const h = Math.floor(m / 60)
  if (h < 24) return `${h}h ago`
  const d = Math.floor(h / 24)
  return `${d}d ago`
}
