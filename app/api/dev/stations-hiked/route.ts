import { NextResponse } from "next/server"
import { readDataFile } from "@/lib/github-data"

const FILE_PATH = "data/stations-hiked.json"

// Read-only: stations-hiked.json is a pure build output — a sorted
// array of coordKeys for stations where at least one attached walk has
// a non-empty `previousWalkDates`. Derived in
// scripts/build-rambler-notes.mjs; no POST.
// The admin-only "Undiscovered" filter on the map uses this to hide
// already-walked stations, surfacing the ones still to explore.
export async function GET() {
  const { data: all } = await readDataFile<string[]>(FILE_PATH)
  return NextResponse.json(all)
}
