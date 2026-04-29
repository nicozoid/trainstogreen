// Admin-only: mark a station as a "placemark" — station-global, not per-primary.
// Effect: forces the station's name-label to appear at zoom 8+ even if its
// rating wouldn't normally surface that early. If the station's rating already
// surfaces its label at zoom ≤ 8 (rating 4/3/1), the flag has no visible effect.
//
// Data shape on disk — `data/placemark-stations.json`:
//   ["lng,lat", "lng,lat", …]        // flat array of coord keys
//
// Same shape as `has-issue-stations.json` — flat array, Set-wrapped on the client.
import { NextRequest, NextResponse } from "next/server"
import { readDataFile, writeDataFile } from "@/lib/github-data"
import { handleAdminWrite } from "@/app/api/dev/_helpers"

const FILE_PATH = "data/placemark-stations.json"

export async function POST(req: NextRequest) {
  const { coordKey, name, isPlacemark } = await req.json()
  if (!coordKey || typeof coordKey !== "string") {
    return NextResponse.json({ error: "missing or invalid coordKey" }, { status: 400 })
  }

  return handleAdminWrite(async () => {
    const { data: list, sha } = await readDataFile<string[]>(FILE_PATH)
    const set = new Set(list)
    const had = set.has(coordKey)

    if (isPlacemark) set.add(coordKey)
    else set.delete(coordKey)

    if (set.has(coordKey) === had) {
      return NextResponse.json({ message: "no change" })
    }

    const next = Array.from(set).sort()
    const verb = isPlacemark ? "Mark as placemark" : "Unmark placemark on"
    await writeDataFile(FILE_PATH, next, `${verb} ${name ?? coordKey}`, sha)
    return NextResponse.json({ message: "ok" })
  })
}

// GET returns the flat array — the client wraps it in a Set for O(1) lookups.
export async function GET() {
  const { data } = await readDataFile<string[]>(FILE_PATH)
  return NextResponse.json(data)
}
