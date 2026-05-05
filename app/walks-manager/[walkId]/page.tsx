"use client"

// Standalone editor for a single walk. Renders nothing but the
// per-walk editor UI extracted from <WalksAdminPanel> — same
// component (<WalkCard>), same fields, same Save/Pull-data flow,
// just hosted on its own page so it can be opened in a new tab from
// the walks-manager table.
//
// Lifecycle:
//   - Fetch /api/dev/walk/[id] on mount → render <WalkCard>.
//   - On save the WalkCard calls onSaved, which refetches so the
//     local view reflects any server-side normalisation (e.g.
//     month-codes reordered, empty strings dropped).

import { useCallback, useEffect, useState } from "react"
import { useParams } from "next/navigation"
import { WalkCard, type WalkPayload } from "@/components/walks-admin-panel"

export default function WalkEditorPage() {
  // useParams returns Record<string, string | string[]>; walkId is a
  // single segment so the value is always a string here. Cast keeps
  // TypeScript honest without a runtime branch.
  const params = useParams<{ walkId: string }>()
  const walkId = params.walkId

  const [walk, setWalk] = useState<WalkPayload | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const fetchWalk = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const r = await fetch(`/api/dev/walk/${encodeURIComponent(walkId)}`)
      if (!r.ok) {
        throw new Error(r.status === 404 ? "Walk not found" : `HTTP ${r.status}`)
      }
      const data = (await r.json()) as WalkPayload
      setWalk(data)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setLoading(false)
    }
  }, [walkId])

  useEffect(() => {
    void fetchWalk()
  }, [fetchWalk])

  // After Save the WalkCard re-renders against the refetched payload,
  // so any server-side cleanup (sorted month codes, stripped empty
  // strings, normalised orgs) shows up immediately.
  const handleSaved = useCallback(async () => {
    await fetchWalk()
  }, [fetchWalk])

  return (
    // The global body has `overflow: hidden` (set so the full-screen
    // map page doesn't scroll). Wrap our content in an h-screen +
    // overflow-y-auto container so this page can scroll on its own.
    <div className="h-screen overflow-y-auto">
      {/* mx-auto + max-w narrows the editor to a comfortable column
          width — the embedded version inside the station overlay is
          constrained by the overlay panel; here we provide our own. */}
      <main className="mx-auto max-w-3xl p-6">
        <header className="mb-4">
          <h1 className="text-lg font-semibold">Walk editor</h1>
          <p className="font-mono text-xs text-muted-foreground">{walkId}</p>
        </header>

        {loading && <p className="text-sm italic text-muted-foreground">Loading…</p>}
        {error && <p className="text-sm text-destructive">{error}</p>}
        {walk && (
          // Match the orange-dashed container WalksAdminPanel uses, so
          // the page reads as a single editable walk card on its own.
          <div className="rounded-md border border-dashed border-orange-400 bg-orange-50/50 px-3 py-3 dark:bg-orange-950/10">
            <WalkCard walk={walk} onSaved={handleSaved} />
          </div>
        )}
      </main>
    </div>
  )
}
