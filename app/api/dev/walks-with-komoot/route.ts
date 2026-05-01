import { NextResponse } from "next/server"
import { readDataFile } from "@/lib/github-data"

// Returns every walk variant that has a komootUrl, across all walk
// data files. Drives the admin's "pull all" bulk operation, which
// loops through this list calling /api/dev/komoot-distance + PATCH.
//
// Mirrors the WALKS_FILES constant in walk/[id]/route.ts and walks-
// for-station/route.ts — keep in sync when adding new sources.
const WALKS_FILES = [
  "data/rambler-walks.json",
  "data/leicester-ramblers-walks.json",
  "data/heart-rail-trails-walks.json",
  "data/abbey-line-walks.json",
  "data/manual-walks.json",
]

type WalkRef = {
  id: string
  slug: string
  komootUrl: string
  // Current values — surfaced so the client can show "before → after"
  // diffs in the progress UI without an extra round-trip per walk.
  distanceKm: number | null
  hours: number | null
  uphillMetres: number | null
  difficulty: string | null
  name: string
}

export async function GET() {
  const seen = new Map<string, WalkRef>()
  for (const file of WALKS_FILES) {
    let data: Record<string, any>
    try {
      const r = await readDataFile<Record<string, any>>(file)
      data = r.data
    } catch {
      continue // optional files
    }
    for (const [slug, entry] of Object.entries(data)) {
      if (!entry || typeof entry !== "object") continue
      const walks = (entry as { walks?: unknown[] }).walks
      if (!Array.isArray(walks)) continue
      for (const v of walks) {
        if (!v || typeof v !== "object") continue
        const variant = v as Record<string, unknown>
        const komootUrl = typeof variant.komootUrl === "string" ? variant.komootUrl.trim() : ""
        const id = typeof variant.id === "string" ? variant.id : ""
        if (!komootUrl || !id) continue
        // Last-occurrence-wins, matching locateWalk's "later file is
        // authoritative" semantics. With dupes cleaned up this is a
        // no-op, but stays robust if any sneak back in.
        seen.set(id, {
          id,
          slug,
          komootUrl,
          distanceKm: typeof variant.distanceKm === "number" ? variant.distanceKm : null,
          hours: typeof variant.hours === "number" ? variant.hours : null,
          uphillMetres: typeof variant.uphillMetres === "number" ? variant.uphillMetres : null,
          difficulty: typeof variant.difficulty === "string" ? variant.difficulty : null,
          name: typeof variant.name === "string" ? variant.name : "",
        })
      }
    }
  }
  // Sorted by slug then id for stable iteration order — the admin's
  // progress display benefits from a predictable sequence.
  const out = [...seen.values()].sort((a, b) => {
    if (a.slug !== b.slug) return a.slug.localeCompare(b.slug)
    return a.id.localeCompare(b.id)
  })
  return NextResponse.json(out)
}
