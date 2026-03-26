import { NextRequest, NextResponse } from "next/server"
import fs from "fs"
import path from "path"

const FILE = path.join(process.cwd(), "data", "station-ratings.json")

type RatingValue = "highlight" | "verified" | "unverified" | "not-recommended"
type RatingEntry = { name: string; rating: RatingValue }

export async function POST(req: NextRequest) {
  const { coordKey, name, rating } = await req.json()
  if (!coordKey) return NextResponse.json({ error: "missing coordKey" }, { status: 400 })

  const ratings: Record<string, RatingEntry> = JSON.parse(fs.readFileSync(FILE, "utf-8"))

  if (rating) {
    // Set or update — store name alongside rating for human readability
    ratings[coordKey] = { name: name ?? coordKey, rating }
  } else {
    // No rating means "unrated" — remove the entry
    delete ratings[coordKey]
  }

  fs.writeFileSync(FILE, JSON.stringify(ratings, null, 2) + "\n", "utf-8")
  return NextResponse.json({ message: "ok" })
}

// GET returns all ratings so the map can load them on startup.
// Flattens to { coordKey: ratingValue } since the map only needs the rating string.
export async function GET() {
  const raw: Record<string, RatingEntry> = JSON.parse(fs.readFileSync(FILE, "utf-8"))
  const flat: Record<string, RatingValue> = {}
  for (const [key, entry] of Object.entries(raw)) {
    flat[key] = entry.rating
  }
  return NextResponse.json(flat)
}
