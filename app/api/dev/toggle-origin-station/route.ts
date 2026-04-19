import { NextRequest, NextResponse } from "next/server"
import { readDataFile, writeDataFile } from "@/lib/github-data"

// Shared data file that lists every "origin" station (marker squares,
// excluded from destination results).
const FILE_PATH = "data/origin-stations.json"

// Toggles a station's origin status. Body: { coordKey, name, isOrigin }
// - coordKey: "lng,lat" identifier (authoritative) — what gets stored in the JSON
// - name: passed purely for commit-message readability; not used for matching
// - isOrigin: true  → add coordKey (if not already there)
// - isOrigin: false → remove coordKey (if present)
export async function POST(req: NextRequest) {
  const { coordKey, name, isOrigin } = await req.json()
  if (!coordKey) return NextResponse.json({ error: "missing coordKey" }, { status: 400 })

  const { data: list, sha } = await readDataFile<string[]>(FILE_PATH)
  const label = name ?? coordKey  // prettier commit message when name is supplied

  if (isOrigin) {
    if (list.includes(coordKey)) {
      return NextResponse.json({ message: "already an origin" })
    }
    list.push(coordKey)
    await writeDataFile(FILE_PATH, list, `Mark ${label} as origin`, sha)
    return NextResponse.json({ message: `marked "${label}" as origin` })
  } else {
    const updated = list.filter((k) => k !== coordKey)
    if (updated.length === list.length) {
      return NextResponse.json({ error: `"${coordKey}" not found` }, { status: 404 })
    }
    await writeDataFile(FILE_PATH, updated, `Unmark ${label} as origin`, sha)
    return NextResponse.json({ message: `unmarked "${label}" as origin` })
  }
}
