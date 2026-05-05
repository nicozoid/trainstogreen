import { NextRequest, NextResponse } from "next/server"
import { readDataFile } from "@/lib/github-data"

// Returns the number of DISTINCT walks that reference each requested
// placeId. Drives the editor's "Synced (N)" badge — N counts walks,
// not row instances, so a place referenced twice within the same
// walk (rare: sights AND lunch) counts as 1.
//
// Body: { placeIds: string[] }
// Response: { counts: Record<string, number> }
//
// Quiet on unknown ids — they appear in the response with count 0
// rather than a separate error path, since "unknown id" usually
// means "row was just added by the admin and hasn't been saved yet".
const WALKS_FILE = "data/walks.json"

export async function POST(req: NextRequest) {
  let body: { placeIds?: unknown }
  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ error: "invalid JSON body" }, { status: 400 })
  }
  const ids = Array.isArray(body.placeIds)
    ? body.placeIds.filter((x): x is string => typeof x === "string")
    : null
  if (!ids) {
    return NextResponse.json({ error: "expected { placeIds: string[] }" }, { status: 400 })
  }
  const wanted = new Set(ids)

  // placeId → Set<walkId> across all variants. Using a Set keyed on
  // walkId is what makes the "distinct walks" rule fall out
  // automatically — a place referenced twice in the same variant
  // adds only one entry to the set.
  const distinctWalks = new Map<string, Set<string>>()
  const { data } = await readDataFile<Record<string, { walks?: unknown[] }>>(WALKS_FILE)
  for (const entry of Object.values(data)) {
    if (!Array.isArray(entry?.walks)) continue
    for (const v of entry.walks) {
      if (!v || typeof v !== "object") continue
      const variant = v as Record<string, unknown>
      const walkId = typeof variant.id === "string" ? variant.id : ""
      if (!walkId) continue
      for (const key of ["sights", "lunchStops", "destinationStops"] as const) {
        const list = variant[key]
        if (!Array.isArray(list)) continue
        for (const stub of list) {
          if (!stub || typeof stub !== "object") continue
          const placeId = (stub as { placeId?: unknown }).placeId
          if (typeof placeId !== "string") continue
          if (!wanted.has(placeId)) continue
          let s = distinctWalks.get(placeId)
          if (!s) {
            s = new Set<string>()
            distinctWalks.set(placeId, s)
          }
          s.add(walkId)
        }
      }
    }
  }

  const counts: Record<string, number> = {}
  for (const id of wanted) counts[id] = distinctWalks.get(id)?.size ?? 0
  return NextResponse.json({ counts })
}
