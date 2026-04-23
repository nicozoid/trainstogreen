// Admin-only: mark a station as "has an issue" — station-global, not per-primary.
// Surfaces in the photo-overlay as an issue-flag button; the map shows a red
// halo on flagged stations (in admin mode) regardless of which primary is
// selected.
//
// Data shape on disk — `data/has-issue-stations.json`:
//   ["lng,lat", "lng,lat", …]        // flat array of coord keys
//
// Flat array keeps the file small and lookups cheap (Set.has on the client).
import { NextRequest, NextResponse } from "next/server"
import { readDataFile, writeDataFile } from "@/lib/github-data"

const FILE_PATH = "data/has-issue-stations.json"

export async function POST(req: NextRequest) {
  const { coordKey, name, hasIssue } = await req.json()
  if (!coordKey || typeof coordKey !== "string") {
    return NextResponse.json({ error: "missing or invalid coordKey" }, { status: 400 })
  }

  const { data: list, sha } = await readDataFile<string[]>(FILE_PATH)
  const set = new Set(list)
  const had = set.has(coordKey)

  if (hasIssue) set.add(coordKey)
  else set.delete(coordKey)

  if (set.has(coordKey) === had) {
    return NextResponse.json({ message: "no change" })
  }

  const next = Array.from(set).sort()
  const verb = hasIssue ? "Flag issue on" : "Clear issue on"
  await writeDataFile(FILE_PATH, next, `${verb} ${name ?? coordKey}`, sha)
  return NextResponse.json({ message: "ok" })
}

// GET returns the flat array — the client wraps it in a Set for O(1) lookups.
export async function GET() {
  const { data } = await readDataFile<string[]>(FILE_PATH)
  return NextResponse.json(data)
}
