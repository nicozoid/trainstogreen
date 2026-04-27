import { NextRequest, NextResponse } from "next/server"
import { readDataFile, writeDataFile } from "@/lib/github-data"
import { handleAdminWrite } from "@/app/api/dev/_helpers"
import { buildRamblerNotes } from "@/scripts/build-rambler-notes.mjs"

// All walk files — we read them all to ensure the generated id is
// globally unique across sources, not just within manual-walks.json.
// Keep in sync with app/api/dev/walk/[id]/route.ts.
const WALKS_FILES = [
  "data/rambler-walks.json",
  "data/leicester-ramblers-walks.json",
  "data/heart-rail-trails-walks.json",
  "data/abbey-line-walks.json",
  "data/manual-walks.json",
]

const MANUAL_FILE = "data/manual-walks.json"
const ID_ALPHABET = "0123456789abcdefghijklmnopqrstuvwxyz"
// Matches the existing id regex used in /api/dev/walk/[id]/route.ts.
const ID_LENGTH = 4

type WalkVariant = { id?: string; [k: string]: unknown }
type WalkEntry = { slug?: string; walks?: WalkVariant[]; [k: string]: unknown }
type ManualFile = { _readme?: string; [slug: string]: WalkEntry | string | undefined }

// Random 4-char id from [0-9a-z]. ~1.6M possible values — a linear
// collision check against every existing walk id is fine at this
// scale (well under 10k walks total).
function randomId(): string {
  let out = ""
  for (let i = 0; i < ID_LENGTH; i++) {
    out += ID_ALPHABET[Math.floor(Math.random() * ID_ALPHABET.length)]
  }
  return out
}

async function collectExistingIds(): Promise<Set<string>> {
  const ids = new Set<string>()
  for (const path of WALKS_FILES) {
    let read
    try {
      read = await readDataFile<Record<string, WalkEntry>>(path)
    } catch {
      continue
    }
    for (const entry of Object.values(read.data)) {
      if (!Array.isArray(entry.walks)) continue
      for (const v of entry.walks) {
        if (typeof v.id === "string") ids.add(v.id)
      }
    }
  }
  return ids
}

// POST — create a new manual walk. Body shape:
//   { startStation: "BLP", endStation: "BLP" }   // both CRS codes required
//
// Everything else (name, terrain, sights, etc.) is left empty so the
// admin can fill it in via the existing card editor. `source` is
// pre-populated with the `trains-to-green` org so the walk passes the
// source validator on subsequent PATCHes.
export async function POST(req: NextRequest) {
  const { startStation, endStation } = await req.json()
  if (typeof startStation !== "string" || !/^[A-Z]{3}$/.test(startStation)) {
    return NextResponse.json({ error: "invalid startStation (expected 3-letter CRS)" }, { status: 400 })
  }
  if (typeof endStation !== "string" || !/^[A-Z]{3}$/.test(endStation)) {
    return NextResponse.json({ error: "invalid endStation (expected 3-letter CRS)" }, { status: 400 })
  }

  return handleAdminWrite(async () => {
  // Generate a non-colliding id. Retry a handful of times in the
  // vanishingly unlikely event of a collision; the id space is ~1.6M
  // so even with 10k walks the miss rate is ~0.6%.
  const existingIds = await collectExistingIds()
  let id = randomId()
  let tries = 0
  while (existingIds.has(id) && tries++ < 10) id = randomId()
  if (existingIds.has(id)) {
    return NextResponse.json({ error: "could not mint unique id" }, { status: 500 })
  }

  const slug = `manual-${id}`
  const { data, sha } = await readDataFile<ManualFile>(MANUAL_FILE)

  // Circular when start === end; this drives the derived title
  // ("X Circular" vs "X to Y") in scripts/build-rambler-notes.mjs.
  const isCircular = startStation === endStation

  const now = new Date().toISOString()
  const newVariant: WalkVariant = {
    role: "main",
    name: "",
    startPlace: "",
    endPlace: "",
    startStation,
    endStation,
    stationToStation: true,
    distanceKm: null,
    hours: null,
    lunchStops: [],
    terrain: "",
    sights: [],
    warnings: "",
    id,
    suffix: "",
    // Manual walks are Trains-to-Green-owned by default with no
    // external source page; pageName/pageURL stay empty so the
    // renderer leaves the title un-linked. cleanSource only requires
    // orgSlug, so subsequent PATCHes work fine.
    source: {
      orgSlug: "trains-to-green",
      pageName: "",
      pageURL: "",
      type: "main",
    },
    updatedAt: now,
  }

  data[slug] = {
    slug,
    title: isCircular ? `Manual ${startStation} Circular` : `Manual ${startStation} to ${endStation}`,
    url: "",
    favourite: false,
    tags: ["manual"],
    categories: [],
    region: "",
    walks: [newVariant],
    extracted: true,
    onMap: true,
    issues: false,
    notes: "",
    outsideMainlandBritain: false,
  }

  await writeDataFile(MANUAL_FILE, data, `Create manual walk ${id} at ${startStation}`, sha)

  try {
    await buildRamblerNotes({ dryRun: false, flipOnMap: false })
  } catch (err) {
    // Same pattern as PATCH: the create write succeeded; only the
    // derived-file rebuild failed (expected on Vercel's read-only fs).
    // eslint-disable-next-line no-console
    console.error("rebuild after walk create failed:", err)
    return NextResponse.json({ message: "ok", id, rebuildPending: true })
  }

  return NextResponse.json({ message: "ok", id })
  })
}
