// One-shot migration that splits venue data out of data/walks.json
// into a separate data/places.json registry. After this runs:
//   - data/places.json holds one entry per sight / lunch / destination
//     row that existed in walks.json
//   - data/walks.json's per-walk sights/lunchStops/destinationStops
//     arrays hold thin stubs of the form { placeId, kmIntoRoute }
//
// Conservative migration — every existing row gets its OWN place even
// if the same venue appears across multiple walks. Two walks with
// "Lower Red Lion" → two distinct entries (slugs collide → -2 suffix).
// Phase 2's editor adds an admin-driven merge UI; until then, treating
// duplicates as separate places is the safe default (avoids false
// auto-merges between similarly-named-but-actually-different venues).
//
// Idempotent: running a second time is a no-op once any walk row has
// already been converted to the stub shape.
//
// Usage:
//   node scripts/migrate-places.mjs              # writes both files
//   node scripts/migrate-places.mjs --dry-run    # report only

import { readFileSync, writeFileSync } from "fs"
import { fileURLToPath } from "url"
import { dirname, join } from "path"

const __dirname = dirname(fileURLToPath(import.meta.url))
const ROOT = join(__dirname, "..")
const WALKS_PATH = join(ROOT, "data", "walks.json")
const PLACES_PATH = join(ROOT, "data", "places.json")

const dryRun = process.argv.includes("--dry-run")

// Slug helpers — duplicated from lib/places.ts because this .mjs
// script can't import from .ts. Keep these two implementations in
// sync; the rule is documented in lib/places.ts.
const slugify = (s) =>
  String(s ?? "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")

function buildPlaceSlug({ name, location, types }) {
  const base = slugify(name)
  const loc = slugify(location ?? "")
  if (loc && loc !== base) return `${base}-${loc}`
  const tag = (types ?? [])[0]
  if (tag) return `${base}-${slugify(tag)}`
  return base
}

const walks = JSON.parse(readFileSync(WALKS_PATH, "utf-8"))

// Idempotency check — abort if any row is already a stub. We could
// merge with the existing places.json instead, but Phase 1 prefers
// to fail loudly so an accidental re-run doesn't quietly double up.
let alreadyMigrated = false
for (const entry of Object.values(walks)) {
  if (!Array.isArray(entry.walks)) continue
  for (const v of entry.walks) {
    for (const list of [v.sights, v.lunchStops, v.destinationStops]) {
      if (!Array.isArray(list)) continue
      for (const row of list) {
        if (row && typeof row === "object" && "placeId" in row) {
          alreadyMigrated = true
        }
      }
    }
  }
}
if (alreadyMigrated) {
  console.log("Already migrated — found rows with placeId. No changes made.")
  process.exit(0)
}

const places = {}
let placeCount = 0
let stubCount = 0
let collisionCount = 0
let droppedRows = 0
let normalisedSelfRefs = 0

const reserveSlug = (base) => {
  if (!(base in places)) return base
  let n = 2
  while (`${base}-${n}` in places) n++
  collisionCount++
  return `${base}-${n}`
}

const migrateRow = (row, kind /* "sights" | "lunchStops" | "destinationStops" */) => {
  if (!row || typeof row !== "object") return null
  const name = typeof row.name === "string" ? row.name.trim() : ""
  if (!name) {
    droppedRows++
    return null
  }

  // Self-reference normalisation — drop a location that just repeats
  // the row's own name. Only applied to SIGHTS (Wheathampstead-as-
  // sight with location: "Wheathampstead" was a common pattern in
  // the old data). Lunch and destination rows keep their locations
  // even when name and location match — for refreshment venues, a
  // hotel literally called "Botany Bay" sitting in the place called
  // Botany Bay genuinely sits in Botany Bay, and the prose grouping
  // reads better as "Botany Bay lunch stop: the Botany Bay" than
  // tossing the row into "Other lunch stop: …".
  let location = typeof row.location === "string" ? row.location.trim() : ""
  if (kind === "sights" && location && location.toLowerCase() === name.toLowerCase()) {
    location = ""
    normalisedSelfRefs++
  }

  const types = Array.isArray(row.types)
    ? row.types.filter((t) => typeof t === "string")
    : []

  // Build the place entry — only emit fields with non-trivial values
  // so the JSON stays diff-friendly (mirrors the per-row cleaners on
  // the server side).
  const place = { name }
  if (location) place.location = location
  if (typeof row.url === "string" && row.url.trim()) place.url = row.url.trim()
  if (typeof row.lat === "number" && Number.isFinite(row.lat)) place.lat = row.lat
  if (typeof row.lng === "number" && Number.isFinite(row.lng)) place.lng = row.lng
  if (types.length) place.types = types
  if (typeof row.businessStatus === "string" && row.businessStatus) {
    place.businessStatus = row.businessStatus
  }

  if (kind === "sights") {
    if (typeof row.description === "string" && row.description.trim()) {
      place.description = row.description.trim()
    }
  } else {
    if (typeof row.notes === "string" && row.notes.trim()) place.notes = row.notes.trim()
    if (typeof row.rating === "string" && ["good", "fine", "poor"].includes(row.rating)) {
      place.rating = row.rating
    }
    if (typeof row.busy === "string" && ["busy", "quiet"].includes(row.busy)) {
      place.busy = row.busy
    }
  }

  const slug = reserveSlug(buildPlaceSlug({ name, location, types }))
  places[slug] = place
  placeCount++

  // Build the walk-side stub. Only carry kmIntoRoute — every other
  // field now lives on the place.
  const stub = { placeId: slug }
  if (typeof row.kmIntoRoute === "number" && Number.isFinite(row.kmIntoRoute)) {
    stub.kmIntoRoute = row.kmIntoRoute
  }
  stubCount++
  return stub
}

for (const entry of Object.values(walks)) {
  if (!Array.isArray(entry.walks)) continue
  for (const v of entry.walks) {
    if (Array.isArray(v.sights)) {
      v.sights = v.sights.map((r) => migrateRow(r, "sights")).filter(Boolean)
    }
    if (Array.isArray(v.lunchStops)) {
      v.lunchStops = v.lunchStops.map((r) => migrateRow(r, "lunchStops")).filter(Boolean)
    }
    if (Array.isArray(v.destinationStops)) {
      v.destinationStops = v.destinationStops.map((r) => migrateRow(r, "destinationStops")).filter(Boolean)
    }
  }
}

// Sort the registry by key so the file diffs cleanly when admins add
// places later. JSON.stringify preserves insertion order.
const sortedPlaces = Object.fromEntries(
  Object.entries(places).sort(([a], [b]) => a.localeCompare(b)),
)

if (dryRun) {
  console.log("(dry run — no files written)")
} else {
  writeFileSync(WALKS_PATH, JSON.stringify(walks, null, 2) + "\n")
  writeFileSync(PLACES_PATH, JSON.stringify(sortedPlaces, null, 2) + "\n")
}

console.log("Migration complete:")
console.log(`  Places created:          ${placeCount}`)
console.log(`  Walk stubs written:      ${stubCount}`)
console.log(`  Slug collisions:         ${collisionCount}`)
console.log(`  Self-ref locations dropped: ${normalisedSelfRefs}`)
console.log(`  Rows dropped (no name):  ${droppedRows}`)
