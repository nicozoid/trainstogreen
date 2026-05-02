import { NextResponse } from "next/server"
import { readDataFile } from "@/lib/github-data"

const FILE_PATH = "data/stations-potential-months.json"

// Read-only: stations-potential-months.json is a pure build output — a
// sorted array of coordKeys for stations that have a Komoot route AND
// month data only on admin-only walks (zero on publicly-visible walks).
// Derived in scripts/build-rambler-notes.mjs; no POST.
// The admin-only "Potential month data" feature filter uses this to
// surface destinations where buried admin month metadata could be
// promoted to a public walk.
export async function GET() {
  const { data: all } = await readDataFile<string[]>(FILE_PATH)
  return NextResponse.json(all)
}
