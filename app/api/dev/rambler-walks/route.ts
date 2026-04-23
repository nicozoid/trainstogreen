import { NextRequest, NextResponse } from "next/server"
import { readDataFile, writeDataFile } from "@/lib/github-data"

// Admin endpoint for the walkingclub.org.uk extraction dataset.
//
// GET  → returns the whole data/rambler-walks.json file (the admin page
//        polls this periodically to show progress).
// POST → partial-updates a single walk entry, merging the posted fields
//        into the existing entry. Used later by the extraction script and
//        by manual admin edits on the page (toggling `issues`, editing
//        `notes`, etc.).

const FILE_PATH = "data/rambler-walks.json"

// Shape is intentionally loose — the file holds both index-level fields
// (slug/title/url/region/favourite) and extraction payload (walks, places,
// etc.). We don't want to fight TS over payload keys here.
type RamblerWalk = Record<string, unknown> & { slug: string }

export async function GET() {
  const { data } = await readDataFile<Record<string, RamblerWalk>>(FILE_PATH)
  return NextResponse.json(data)
}

export async function POST(req: NextRequest) {
  const body = await req.json()
  const { slug, ...patch } = body as { slug?: string } & Record<string, unknown>
  if (!slug) return NextResponse.json({ error: "missing slug" }, { status: 400 })

  const { data: walks, sha } = await readDataFile<Record<string, RamblerWalk>>(FILE_PATH)
  const existing = walks[slug]
  if (!existing) {
    return NextResponse.json({ error: `unknown slug: ${slug}` }, { status: 404 })
  }

  // Shallow merge: top-level keys in `patch` overwrite existing values.
  // Nested objects (places, walks[]) are replaced wholesale if included —
  // consumers should send whole objects for those when updating them.
  walks[slug] = { ...existing, ...patch, slug }

  await writeDataFile(FILE_PATH, walks, `Update rambler walk: ${slug}`, sha)
  return NextResponse.json({ message: "ok" })
}
