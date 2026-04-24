import { NextResponse } from "next/server"
import { readDataFile } from "@/lib/github-data"

const FILE_PATH = "data/station-seasons.json"

type Season = "Spring" | "Summer" | "Autumn" | "Winter"
type SeasonsEntry = { name: string; seasons: Season[] }

// Read-only: station-seasons.json is now a pure build output, derived
// from each walk variant's structured `bestSeasons` field in
// scripts/build-rambler-notes.mjs. No POST — the admin UI used to edit
// station-level seasons directly, but seasonality now flows from walk
// data. Edit `bestSeasons` on the walk variants instead and re-run the
// build script.
export async function GET() {
  const { data: all } = await readDataFile<Record<string, SeasonsEntry>>(FILE_PATH)
  return NextResponse.json(all)
}
