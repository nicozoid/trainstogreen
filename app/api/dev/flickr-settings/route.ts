import { NextRequest, NextResponse } from "next/server"
import { readDataFile, writeDataFile } from "@/lib/github-data"

const FILE_PATH = "data/photo-flickr-settings.json"

// Per-station custom tag config. Only stored for stations that have a custom
// feed configured — presence in this file means "this station has a custom
// fallback". Absence means the custom-fallback step in the gallery fill-chain
// is skipped for that station.
//
// The algo itself (landscapes / hikes / station / custom) is no longer stored
// per-station — the default is decided by the client based on cluster/excluded
// membership (always landscapes except for Central London terminals + excluded
// stations, which default to station). Admins edit only the custom tag config.
export type FlickrSort = "relevance" | "interestingness-desc"
export type FlickrCustomSettings = {
  name?: string
  custom: {
    includeTags: string[]
    excludeTags: string[]
    radius: number // km
    sort?: FlickrSort
  }
}

// POST — upsert custom config for a station. Pass `custom: null` to clear.
// Body: { coordKey, name, custom }
export async function POST(req: NextRequest) {
  const body = await req.json()
  const { coordKey, name, custom } = body as {
    coordKey?: string
    name?: string
    custom?: FlickrCustomSettings["custom"] | null
  }

  if (!coordKey) {
    return NextResponse.json({ error: "missing coordKey" }, { status: 400 })
  }

  const { data: settings, sha } = await readDataFile<Record<string, FlickrCustomSettings>>(FILE_PATH)

  // null/missing custom means "clear this station's custom config"
  if (!custom) {
    delete settings[coordKey]
    await writeDataFile(FILE_PATH, settings, `clear flickr custom config for ${name ?? coordKey}`, sha)
    return NextResponse.json({ message: "cleared" })
  }

  if (!Array.isArray(custom.includeTags) || !Array.isArray(custom.excludeTags) || typeof custom.radius !== "number") {
    return NextResponse.json({ error: "custom requires { includeTags, excludeTags, radius }" }, { status: 400 })
  }
  const sort: FlickrSort | undefined =
    custom.sort === "interestingness-desc" || custom.sort === "relevance" ? custom.sort : undefined

  settings[coordKey] = {
    name,
    custom: {
      includeTags: custom.includeTags.map((t) => t.trim()).filter(Boolean),
      excludeTags: custom.excludeTags.map((t) => t.trim()).filter(Boolean),
      radius: Math.max(0.1, Math.min(30, custom.radius)),
      ...(sort ? { sort } : {}),
    },
  }

  await writeDataFile(FILE_PATH, settings, `set flickr custom config for ${name ?? coordKey}`, sha)
  return NextResponse.json({ message: "ok" })
}

// GET — returns all custom configs so the map can hydrate state on mount.
export async function GET() {
  const { data } = await readDataFile<Record<string, FlickrCustomSettings>>(FILE_PATH)
  return NextResponse.json(data)
}
