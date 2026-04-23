import { NextRequest, NextResponse } from "next/server"
import { readDataFile, writeDataFile } from "@/lib/github-data"

const FILE_PATH = "data/photo-flickr-settings.json"

// Per-station override of the Flickr photo-search algorithm. When a station
// has no entry in this file, the auto-fallback logic applies (isOrigin →
// station, else landscapes). When an entry exists, its `algo` supersedes
// the auto logic. Note: curation state no longer promotes to hikes — the
// admin must pick hikes (or custom) manually.
//
// `custom` is only populated when algo === "custom". It's a full override of
// include tags / exclude tags / radius — no partial overrides, the whole
// algorithm switches when you pick Custom.
export type FlickrAlgo = "landscapes" | "hikes" | "station" | "custom"
export type FlickrSort = "relevance" | "interestingness-desc"
export type FlickrSettings = {
  name?: string
  algo: FlickrAlgo
  custom?: {
    includeTags: string[]
    excludeTags: string[]
    radius: number // km
    // Optional. Default "relevance" (tag-match quality — matters when the
    // admin's tags are specific). Admin can flip to "interestingness-desc"
    // for stations where they want Flickr's engagement score to dominate.
    sort?: FlickrSort
  }
}

// POST — upsert settings for a station. Pass `algo: null` (or omit the body's
// algo entirely) to clear the station's override and return it to auto logic.
// Body: { coordKey, name, algo, custom? }
export async function POST(req: NextRequest) {
  const body = await req.json()
  const { coordKey, name, algo, custom } = body as {
    coordKey?: string
    name?: string
    algo?: FlickrAlgo | null
    custom?: FlickrSettings["custom"]
  }

  if (!coordKey) {
    return NextResponse.json({ error: "missing coordKey" }, { status: 400 })
  }

  const { data: settings, sha } = await readDataFile<Record<string, FlickrSettings>>(FILE_PATH)

  // algo === null (or missing) means "clear this station's override"
  if (!algo) {
    delete settings[coordKey]
    await writeDataFile(FILE_PATH, settings, `clear flickr settings for ${name ?? coordKey}`, sha)
    return NextResponse.json({ message: "cleared" })
  }

  const validAlgos: FlickrAlgo[] = ["landscapes", "hikes", "station", "custom"]
  if (!validAlgos.includes(algo)) {
    return NextResponse.json({ error: `algo must be one of ${validAlgos.join(", ")}` }, { status: 400 })
  }

  // Custom requires a custom payload; other algos don't persist one.
  const entry: FlickrSettings = { name, algo }
  if (algo === "custom") {
    if (!custom || !Array.isArray(custom.includeTags) || !Array.isArray(custom.excludeTags) || typeof custom.radius !== "number") {
      return NextResponse.json({ error: "custom algo requires { includeTags, excludeTags, radius }" }, { status: 400 })
    }
    const sort: FlickrSort | undefined =
      custom.sort === "interestingness-desc" || custom.sort === "relevance" ? custom.sort : undefined
    entry.custom = {
      includeTags: custom.includeTags.map((t) => t.trim()).filter(Boolean),
      excludeTags: custom.excludeTags.map((t) => t.trim()).filter(Boolean),
      radius: Math.max(0.1, Math.min(30, custom.radius)),
      ...(sort ? { sort } : {}),
    }
  }

  settings[coordKey] = entry
  await writeDataFile(FILE_PATH, settings, `set flickr algo=${algo} for ${name ?? coordKey}`, sha)
  return NextResponse.json({ message: "ok" })
}

// GET — returns all settings so the map can hydrate state on mount.
export async function GET() {
  const { data } = await readDataFile<Record<string, FlickrSettings>>(FILE_PATH)
  return NextResponse.json(data)
}
