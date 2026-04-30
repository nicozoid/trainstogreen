import { NextRequest, NextResponse } from "next/server"
import { readDataFile } from "@/lib/github-data"
import { commitWalkSave, handleAdminWrite } from "@/app/api/dev/_helpers"
import { WALK_ID_WORDS } from "@/scripts/walk-id-words.mjs"

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

type WalkVariant = { id?: string; [k: string]: unknown }
type WalkEntry = { slug?: string; walks?: WalkVariant[]; [k: string]: unknown }
type ManualFile = { _readme?: string; [slug: string]: WalkEntry | string | undefined }

// Mint a memorable id in the `[startCRS][endCRS][word]` format used by
// scripts/assign-walk-ids.mjs — e.g. "cohcohfox" for a Crowborough
// circular. Word picked at random from WALK_ID_WORDS, retrying on
// collisions; falls back to a numeric suffix on the (extremely
// unlikely) event that every word is taken for this prefix.
function mintWalkId(startCrs: string, endCrs: string, taken: Set<string>): string {
  const prefix = startCrs.toLowerCase() + endCrs.toLowerCase()
  // Shuffle a copy so each call gets a different word ordering.
  const shuffled = [...WALK_ID_WORDS].sort(() => Math.random() - 0.5)
  for (const w of shuffled) {
    const id = prefix + w
    if (!taken.has(id)) return id
  }
  for (let n = 2; n < 1000; n++) {
    for (const w of WALK_ID_WORDS) {
      const id = `${prefix}${w}${n}`
      if (!taken.has(id)) return id
    }
  }
  throw new Error(`exhausted all ids for prefix ${prefix}`)
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
  // Generate a non-colliding `[start][end][word]` id by passing every
  // existing id in as the "taken" set so the picker avoids them.
  const existingIds = await collectExistingIds()
  const id = mintWalkId(startStation, endStation, existingIds)

  const slug = `manual-${id}`
  const { data } = await readDataFile<ManualFile>(MANUAL_FILE)

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
    miscellany: "",
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

  // Single atomic commit: source manual-walks.json + rebuilt derived
  // station-* files. See commitWalkSave for why one bundled commit.
  await commitWalkSave({ path: MANUAL_FILE, data }, `Create manual walk ${id} at ${startStation}`)

  return NextResponse.json({ message: "ok", id })
  })
}
