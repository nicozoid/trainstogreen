import { NextRequest, NextResponse } from "next/server"
import { readDataFile, writeDataFile } from "@/lib/github-data"

const FILE_PATH = "data/station-ratings.json"

type RatingValue = "highlight" | "verified" | "unverified" | "not-recommended"
type RatingEntry = { name: string; rating: RatingValue }

export async function POST(req: NextRequest) {
  const { coordKey, name, rating } = await req.json()
  if (!coordKey) return NextResponse.json({ error: "missing coordKey" }, { status: 400 })

  const { data: ratings, sha } = await readDataFile<Record<string, RatingEntry>>(FILE_PATH)

  if (rating) {
    // Set or update — store name alongside rating for human readability
    ratings[coordKey] = { name: name ?? coordKey, rating }
  } else {
    // No rating means "unrated" — remove the entry
    delete ratings[coordKey]
  }

  await writeDataFile(FILE_PATH, ratings, `Rate ${name ?? coordKey} as ${rating ?? "unrated"}`, sha)
  return NextResponse.json({ message: "ok" })
}

// GET returns all ratings so the map can load them on startup.
// Flattens to { coordKey: ratingValue } since the map only needs the rating string.
export async function GET() {
  const { data: raw } = await readDataFile<Record<string, RatingEntry>>(FILE_PATH)
  const flat: Record<string, RatingValue> = {}
  for (const [key, entry] of Object.entries(raw)) {
    flat[key] = entry.rating
  }
  return NextResponse.json(flat)
}
