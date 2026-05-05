import { NextResponse } from "next/server"
import { readDataFile } from "@/lib/github-data"

const FILE_PATH = "data/stations-by-source.json"

// Read-only: stations-by-source.json is a pure build output —
// { [orgSlug]: coordKey[] } pivoted from per-station Set<orgSlug>.
// Derived in scripts/build-rambler-notes.mjs from every walk's
// orgs[].orgSlug across ALL walks (including non-stationToStation),
// so the admin "Source" filter can answer "stations with ≥1 walk from
// org X" via a single Set lookup.
export async function GET() {
  const { data: all } = await readDataFile<Record<string, string[]>>(FILE_PATH)
  return NextResponse.json(all)
}
