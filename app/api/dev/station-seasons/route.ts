import { NextRequest, NextResponse } from "next/server"
import { readDataFile, writeDataFile } from "@/lib/github-data"

const FILE_PATH = "data/station-seasons.json"

type Season = "Spring" | "Summer" | "Autumn" | "Winter"
type SeasonsEntry = { name: string; seasons: Season[] }

const VALID_SEASONS: Season[] = ["Spring", "Summer", "Autumn", "Winter"]

export async function POST(req: NextRequest) {
  const { coordKey, name, seasons } = await req.json()
  if (!coordKey) return NextResponse.json({ error: "missing coordKey" }, { status: 400 })
  if (!Array.isArray(seasons)) return NextResponse.json({ error: "seasons must be an array" }, { status: 400 })

  // Filter + dedupe + re-order to canonical calendar order — keeps the file
  // diff-friendly regardless of the order the client sent them in
  const cleaned = VALID_SEASONS.filter((s) => seasons.includes(s))

  const { data: all, sha } = await readDataFile<Record<string, SeasonsEntry>>(FILE_PATH)

  if (cleaned.length > 0) {
    all[coordKey] = { name: name ?? coordKey, seasons: cleaned }
  } else {
    // No seasons selected — remove the entry entirely
    delete all[coordKey]
  }

  await writeDataFile(FILE_PATH, all, `Update seasons for ${name ?? coordKey}`, sha)
  return NextResponse.json({ message: "ok" })
}

// GET returns all seasons so the map can load them on startup
export async function GET() {
  const { data: all } = await readDataFile<Record<string, SeasonsEntry>>(FILE_PATH)
  return NextResponse.json(all)
}
