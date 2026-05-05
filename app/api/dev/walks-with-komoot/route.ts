import { NextResponse } from "next/server"
import { readDataFile } from "@/lib/github-data"

// Returns every walk variant that has a komootUrl, from the unified
// walks file. Drives the admin's "pull all" bulk operation, which
// loops through this list calling /api/dev/komoot-distance + PATCH.
const WALKS_FILE = "data/walks.json"

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
  const { data } = await readDataFile<Record<string, any>>(WALKS_FILE)
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
  // Sorted by slug then id for stable iteration order — the admin's
  // progress display benefits from a predictable sequence.
  const out = [...seen.values()].sort((a, b) => {
    if (a.slug !== b.slug) return a.slug.localeCompare(b.slug)
    return a.id.localeCompare(b.id)
  })
  return NextResponse.json(out)
}
