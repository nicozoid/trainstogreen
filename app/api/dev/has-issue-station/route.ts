// Admin-only: mark a station as "has an issue" — station-global, not per-primary.
// Surfaces in the photo-overlay as an issue-flag button; the map shows a red
// halo on flagged stations (in admin mode) regardless of which primary is
// selected.
//
// Data shape on disk — `data/has-issue-stations.json`:
//   ["DCH", "UPAD", "CSTM", …]   // flat array of station IDs (CRS or 4-char synthetic)
//
// Flat array keeps the file small and lookups cheap (Set.has on the client).
import { NextRequest, NextResponse } from "next/server"
import { readDataFile, writeDataFile } from "@/lib/github-data"
import { handleAdminWrite } from "@/app/api/dev/_helpers"

const FILE_PATH = "data/has-issue-stations.json"

export async function POST(req: NextRequest) {
  const { stationId, name, hasIssue } = await req.json()
  if (!stationId || typeof stationId !== "string") {
    return NextResponse.json({ error: "missing or invalid stationId" }, { status: 400 })
  }

  return handleAdminWrite(async () => {
    const { data: list, sha } = await readDataFile<string[]>(FILE_PATH)
    const set = new Set(list)
    const had = set.has(stationId)

    if (hasIssue) set.add(stationId)
    else set.delete(stationId)

    if (set.has(stationId) === had) {
      return NextResponse.json({ message: "no change" })
    }

    const next = Array.from(set).sort()
    const verb = hasIssue ? "Flag issue on" : "Clear issue on"
    await writeDataFile(FILE_PATH, next, `${verb} ${name ?? stationId}`, sha)
    return NextResponse.json({ message: "ok" })
  })
}

// GET returns the flat array — the client wraps it in a Set for O(1) lookups.
export async function GET() {
  const { data } = await readDataFile<string[]>(FILE_PATH)
  return NextResponse.json(data)
}
