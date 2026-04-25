import { NextResponse } from "next/server"
import { readDataFile } from "@/lib/github-data"

const FILE_PATH = "data/stations-with-komoot.json"

// Read-only: stations-with-komoot.json is a pure build output — a sorted
// array of coordKeys for stations where at least one attached walk has
// a non-empty `komootUrl`. Derived in scripts/build-rambler-notes.mjs;
// no POST.
// The admin-only "Komoot" filter on the map uses this to keep only
// stations that already have a Komoot tour wired up.
export async function GET() {
  const { data: all } = await readDataFile<string[]>(FILE_PATH)
  return NextResponse.json(all)
}
