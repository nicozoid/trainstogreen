import { NextRequest, NextResponse } from "next/server"
import { readDataFile } from "@/lib/github-data"

// Returns the walks that reference a given place. Drives the popover
// shown when the admin clicks the "Synced (N)" badge on a row in
// the editor — they get a list of the OTHER walks this place lives
// on, with enough context to recognise each one (start / end station
// names + walk title).
//
// One entry per distinct walk; if a place is referenced twice within
// the same walk (sights AND lunch, say) it still appears once.
const WALKS_FILE = "data/walks.json"

type Reference = {
  /** Walk variant id (the 9-char or 4-char string). */
  walkId: string
  /** Walk's display name — falls back to suffix-derived form when
   *  the variant has no explicit name override. */
  walkName: string
  /** Source page / book title. Useful when several variants share
   *  the same name pattern. */
  pageTitle: string
  /** Start / end CRS codes — let the editor link / scroll into the
   *  matching admin card without an extra lookup. */
  startStation: string | null
  endStation: string | null
}

export async function GET(_req: NextRequest, { params }: { params: Promise<{ placeId: string }> }) {
  const { placeId } = await params
  if (!placeId) return NextResponse.json({ error: "missing placeId" }, { status: 400 })

  const { data } = await readDataFile<Record<string, any>>(WALKS_FILE)
  const seen = new Set<string>()
  const out: Reference[] = []
  for (const [, entry] of Object.entries(data)) {
    if (!Array.isArray(entry?.walks)) continue
    const pageTitle = typeof entry.title === "string" ? entry.title : ""
    for (const v of entry.walks) {
      if (!v || typeof v !== "object") continue
      const variant = v as Record<string, any>
      const walkId = typeof variant.id === "string" ? variant.id : ""
      if (!walkId || seen.has(walkId)) continue
      let referenced = false
      for (const key of ["sights", "lunchStops", "destinationStops"] as const) {
        const list = variant[key]
        if (!Array.isArray(list)) continue
        if (list.some((s) => s && typeof s === "object" && (s as { placeId?: unknown }).placeId === placeId)) {
          referenced = true
          break
        }
      }
      if (!referenced) continue
      seen.add(walkId)
      out.push({
        walkId,
        walkName: typeof variant.name === "string" ? variant.name : "",
        pageTitle,
        startStation: typeof variant.startStation === "string" ? variant.startStation : null,
        endStation: typeof variant.endStation === "string" ? variant.endStation : null,
      })
    }
  }
  // Stable order — by walkId for determinism. The popover doesn't
  // need any particular sort, but a stable one stops the list from
  // shuffling between fetches.
  out.sort((a, b) => a.walkId.localeCompare(b.walkId))
  return NextResponse.json({ references: out })
}
