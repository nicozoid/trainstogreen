import { NextRequest, NextResponse } from "next/server"
import { readDataFile } from "@/lib/github-data"
import { commitWalkSave, handleAdminWrite } from "@/app/api/dev/_helpers"
import { VALID_SPOT_TYPES } from "@/lib/spot-types"
import { MAIN_TERRAINS, VALID_MAIN_TERRAINS } from "@/lib/main-terrains"
import { buildPlaceSlug, reserveSlug, type Place, type PlaceRegistry } from "@/lib/places"

// Single unified walks file (each entry carries a top-level `source`
// field identifying its origin).
const WALKS_FILE = "data/walks.json"
// Phase 1 places-registry data file. The PATCH route reads + mutates
// this alongside walks.json so venue field edits update the canonical
// place entry rather than living on the walk row.
const PLACES_FILE = "data/places.json"

// Whitelist of editable fields. Anything outside this set is ignored
// (can't set arbitrary keys via the PATCH body).
// Extending this list is a deliberate step — please add the UI editor
// at the same time so the data/UI stay in sync.
const EDITABLE_FIELDS = [
  "komootUrl",
  "bestSeasons",
  "bestSeasonsNote",
  "mudWarning",
  "miscellany",
  "trainTips",
  "privateNote",
  "rating",
  "ratingExplanation",
  "busyness",
  "previousWalkDates",
  "mainTerrains",
  "terrain",
  "distanceKm",
  "hours",
  "uphillMetres",
  "difficulty",
  "name",
  "suffix",
  "sights",
  "lunchStops",
  "lunchOverride",
  "destinationStops",
  "destinationStopsOverride",
  "source",
  "relatedSource",
] as const

const LUNCH_RATINGS = new Set(["good", "fine", "poor"])
const SOURCE_TYPES = new Set(["main", "shorter", "longer", "alternative", "variant", "similar", "adapted", "related"])

// Month codes accepted inside the bestSeasons array. Keep in sync with
// the month alphabet used by scripts/build-rambler-notes.mjs.
const VALID_MONTHS = new Set([
  "jan","feb","mar","apr","may","jun","jul","aug","sep","oct","nov","dec",
])

type WalkVariant = Record<string, unknown>
type WalkEntry = { slug?: string; walks?: WalkVariant[]; [k: string]: unknown }

// Finds the walks entry + variant index for a given walk id.
// Returns null if nothing matches.
async function locateWalk(id: string): Promise<
  | { file: string; data: Record<string, WalkEntry>; sha: string | null; slug: string; variantIndex: number }
  | null
> {
  const read = await readDataFile<Record<string, WalkEntry>>(WALKS_FILE)
  for (const [slug, entry] of Object.entries(read.data)) {
    if (!Array.isArray(entry.walks)) continue
    const idx = entry.walks.findIndex((v) => (v as WalkVariant).id === id)
    if (idx >= 0) {
      return { file: WALKS_FILE, data: read.data, sha: read.sha, slug, variantIndex: idx }
    }
  }
  return null
}

// Apply/clean one editable field. Returns the value we should actually
// store, or the sentinel `undefined` to DELETE the field (so empty
// strings / empty arrays don't bloat the JSON with "": "" keys).
function cleanField(key: string, value: unknown): unknown | undefined {
  switch (key) {
    case "komootUrl":
    case "name":
    case "suffix":
    case "lunchOverride":
    case "destinationStopsOverride":
    case "bestSeasonsNote": {
      if (typeof value !== "string") return undefined
      const trimmed = value.trim()
      return trimmed === "" ? undefined : trimmed
    }
    // Prose fields — strip trailing sentence punctuation on save so
    // admins don't need to type a period at the end of each entry.
    // The public renderer (scripts/build-rambler-notes.mjs) adds the
    // terminal period itself via `withPeriod()`, so storing the
    // content without it keeps the source clean.
    case "miscellany":
    case "trainTips":
    case "privateNote":
    case "ratingExplanation":
    case "terrain": {
      if (typeof value !== "string") return undefined
      const trimmed = value.trim().replace(/[.!?]+$/, "").trim()
      return trimmed === "" ? undefined : trimmed
    }
    case "rating": {
      // Accept 1–4, anything else (including null/0) clears the rating.
      // "Rambler favourite" maps to 3; the build script still uses
      // rating >= 3 as the threshold for that flourish.
      if (typeof value !== "number" || !Number.isFinite(value)) return undefined
      const rounded = Math.round(value)
      if (rounded < 1 || rounded > 4) return undefined
      return rounded
    }
    case "busyness": {
      // Footfall scale, 1 = isolated → 5 = busy. Stored numerically so
      // the labels can be reworded in the UI without a data migration.
      // Any non-finite / out-of-range value drops the field.
      if (typeof value !== "number" || !Number.isFinite(value)) return undefined
      const rounded = Math.round(value)
      if (rounded < 1 || rounded > 5) return undefined
      return rounded
    }
    case "distanceKm":
    case "hours":
    case "uphillMetres": {
      // Numeric fields — null or non-finite drops the field. Negative
      // values are treated as garbage (sanity floor).
      if (typeof value !== "number" || !Number.isFinite(value) || value < 0) return undefined
      return value
    }
    case "difficulty": {
      if (typeof value !== "string") return undefined
      const lower = value.toLowerCase().trim() as "easy" | "moderate" | "hard"
      if (!["easy", "moderate", "hard"].includes(lower)) return undefined
      return lower
    }
case "mudWarning": {
      // Only store `true` — absence means "not muddy", so false collapses
      // to "remove the field" to keep the file diff-friendly.
      return value === true ? true : undefined
    }
    case "bestSeasons": {
      if (!Array.isArray(value)) return undefined
      const cleaned = [...new Set(
        value
          .map((m) => (typeof m === "string" ? m.toLowerCase() : null))
          .filter((m): m is string => !!m && VALID_MONTHS.has(m)),
      )]
      return cleaned.length === 0 ? undefined : cleaned
    }
    // Closed-vocabulary multi-select (mountains / hills / coastal /
    // waterways / woodland / historic_urban). Drop unknowns, dedupe,
    // and re-sort into the canonical display order from MAIN_TERRAINS
    // so file diffs stay stable regardless of which order the admin
    // toggled them in.
    case "mainTerrains": {
      if (!Array.isArray(value)) return undefined
      const set = new Set<string>()
      for (const m of value) {
        if (typeof m !== "string") continue
        const lower = m.toLowerCase()
        if (VALID_MAIN_TERRAINS.has(lower)) set.add(lower)
      }
      const cleaned = MAIN_TERRAINS
        .map((t) => t.value as string)
        .filter((v) => set.has(v))
      return cleaned.length === 0 ? undefined : cleaned
    }
    // Admin-only log of when this walk was personally completed.
    // Strict YYYY-MM-DD validation — anything else gets dropped.
    // Deduped + sorted ascending so the file diff is stable across
    // edits regardless of the order the admin added them.
    case "previousWalkDates": {
      if (!Array.isArray(value)) return undefined
      const cleaned = [...new Set(
        value
          .map((d) => (typeof d === "string" ? d.trim() : ""))
          .filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(d)),
      )].sort()
      return cleaned.length === 0 ? undefined : cleaned
    }
    // sights / lunchStops / destinationStops are handled by
    // cleanRowArrayWithRegistry in the PATCH loop below — they need
    // access to the places registry which cleanField doesn't see.
    case "sights":
    case "lunchStops":
    case "destinationStops":
      return undefined
    // `source` is handled separately in the PATCH loop so invalid
    // payloads can be a no-op rather than deleting the field.
    default:
      return undefined
  }
}

// Source provenance — only `orgSlug` is mandatory. `pageName` and
// `pageURL` are optional (manual walks owned by Trains-to-Green
// frequently have no external source page; the renderer falls back to
// a plain, non-linked title when pageURL is empty). For relatedSource,
// an empty orgSlug is the signal to delete the field — callers rely
// on cleanSource returning null in that case.
function cleanSource(raw: unknown): {
  orgSlug: string
  pageName: string
  pageURL: string
  type: string
} | null {
  if (!raw || typeof raw !== "object") return null
  const r = raw as Record<string, unknown>
  const orgSlug = typeof r.orgSlug === "string" ? r.orgSlug.trim() : ""
  const pageName = typeof r.pageName === "string" ? r.pageName.trim() : ""
  const pageURL = typeof r.pageURL === "string" ? r.pageURL.trim() : ""
  const typeRaw = typeof r.type === "string" ? r.type.trim() : ""
  if (!orgSlug) return null
  const type = SOURCE_TYPES.has(typeRaw) ? typeRaw : "variant"
  return { orgSlug, pageName, pageURL, type }
}

// Row-level cleaners for sights/lunch. Drop rows with an empty name
// (everything else is optional context about that row). String fields
// are trimmed; empty trimmed strings → field omitted (so the JSON
// stays compact without empty keys). Number fields are accepted as
// either a number OR a numeric string (the editor stores them as
// strings to keep inputs controlled, but the data file stores them
// as numbers).
function coerceFiniteNumber(raw: unknown): number | undefined {
  if (typeof raw === "number" && Number.isFinite(raw)) return raw
  if (typeof raw === "string") {
    const trimmed = raw.trim()
    if (trimmed === "") return undefined
    const n = Number(trimmed)
    if (Number.isFinite(n)) return n
  }
  return undefined
}
// Whitelist of accepted businessStatus values. Mirrors Google Places
// API's enum (OPERATIONAL / CLOSED_TEMPORARILY / CLOSED_PERMANENTLY).
// Anything else is dropped — we don't want unknown strings drifting
// into the data file.
const BUSINESS_STATUSES = new Set([
  "OPERATIONAL",
  "CLOSED_TEMPORARILY",
  "CLOSED_PERMANENTLY",
])
// Filter an unknown value down to a deduped string[] of valid spot
// types (canonical vocabulary in lib/spot-types.ts). Returns
// undefined when the result is empty so the cleaner can omit the
// field rather than persisting "[]" in the JSON.
function cleanTypes(raw: unknown): string[] | undefined {
  if (!Array.isArray(raw)) return undefined
  const out: string[] = []
  const seen = new Set<string>()
  for (const v of raw) {
    if (typeof v !== "string") continue
    if (!VALID_SPOT_TYPES.has(v)) continue
    if (seen.has(v)) continue
    seen.add(v)
    out.push(v)
  }
  return out.length === 0 ? undefined : out
}

// `busy` is a tri-state matching the rating field's shape:
// "busy" (popular / loud), "quiet" (calm / room to spare), or absent
// (no opinion). Stored as a string so it parallels rating's enum
// rather than the legacy boolean.
const LUNCH_BUSY = new Set(["busy", "quiet"])

// Build a cleaned Place entry from an editor row (which still carries
// a flat venue shape from the round-trip hydration). `kind` selects
// which freeform commentary field is read (`description` for sights,
// `notes` for lunch / destination); the unused field is omitted from
// the resulting Place so the JSON stays compact.
function rowToPlace(
  raw: Record<string, unknown>,
  kind: "sights" | "lunchStops" | "destinationStops",
): Place | null {
  const name = typeof raw.name === "string" ? raw.name.trim() : ""
  if (!name) return null
  const out: Place = { name }
  if (typeof raw.location === "string" && raw.location.trim()) out.location = raw.location.trim()
  if (typeof raw.url === "string" && raw.url.trim()) out.url = raw.url.trim()
  const lat = coerceFiniteNumber(raw.lat)
  if (lat !== undefined) out.lat = lat
  const lng = coerceFiniteNumber(raw.lng)
  if (lng !== undefined) out.lng = lng
  const types = cleanTypes(raw.types)
  if (types !== undefined) out.types = types
  if (typeof raw.businessStatus === "string" && BUSINESS_STATUSES.has(raw.businessStatus)) {
    out.businessStatus = raw.businessStatus
  }
  if (kind === "sights") {
    if (typeof raw.description === "string" && raw.description.trim()) {
      out.description = raw.description.trim()
    }
  } else {
    if (typeof raw.notes === "string" && raw.notes.trim()) out.notes = raw.notes.trim()
    if (typeof raw.rating === "string" && LUNCH_RATINGS.has(raw.rating)) {
      out.rating = raw.rating as Place["rating"]
    }
    if (typeof raw.busy === "string" && LUNCH_BUSY.has(raw.busy)) {
      out.busy = raw.busy as Place["busy"]
    }
  }
  return out
}

// Walk a row array from the editor and build the corresponding stub
// array for walks.json. Mutates `registry` in place: existing places
// get updated; new rows (no placeId, or stale placeId) get a fresh
// entry with a unique slug. Rows with empty names are dropped — the
// place is left untouched in the registry (no GC at this layer; a
// future cleanup tool can sweep unreferenced entries).
function cleanRowArrayWithRegistry(
  raw: unknown,
  kind: "sights" | "lunchStops" | "destinationStops",
  registry: PlaceRegistry,
): Array<{ placeId: string; kmIntoRoute?: number }> | undefined {
  if (!Array.isArray(raw)) return undefined
  const stubs: Array<{ placeId: string; kmIntoRoute?: number }> = []
  for (const rowRaw of raw) {
    if (!rowRaw || typeof rowRaw !== "object") continue
    const row = rowRaw as Record<string, unknown>
    const place = rowToPlace(row, kind)
    if (!place) continue // empty name → drop
    // Determine the placeId. Editor sends back the round-tripped id
    // for existing rows; brand-new rows (added via Pull data or the
    // "+ Add" button) have no placeId yet, so we mint one.
    let placeId = typeof row.placeId === "string" && row.placeId in registry ? row.placeId : ""
    if (!placeId) {
      const base = buildPlaceSlug({ name: place.name, location: place.location, types: place.types })
      placeId = reserveSlug(base, registry)
    }
    registry[placeId] = place
    const stub: { placeId: string; kmIntoRoute?: number } = { placeId }
    const km = coerceFiniteNumber(row.kmIntoRoute)
    if (km !== undefined) stub.kmIntoRoute = km
    stubs.push(stub)
  }
  return stubs
}

// New-format ids: `[startCRS][endCRS][word]` (9+ chars, e.g. "hunhunfox").
// Legacy 4-char ids (e.g. "ml6i") still exist in data — accept both.
const WALK_ID_RE = /^[a-z0-9]{4}$|^[a-z]{6}[a-z0-9]{3,15}$/

export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  if (!id || !WALK_ID_RE.test(id)) {
    return NextResponse.json({ error: "invalid id" }, { status: 400 })
  }

  const body = await req.json()
  if (!body || typeof body !== "object") {
    return NextResponse.json({ error: "invalid body" }, { status: 400 })
  }

  return handleAdminWrite(async () => {
  const located = await locateWalk(id)
  if (!located) return NextResponse.json({ error: "walk not found" }, { status: 404 })

  const { file, data, slug, variantIndex } = located
  const entry = data[slug]
  const variant = entry.walks![variantIndex] as WalkVariant

  // Phase 1 places-registry: read the current registry so the row-
  // array cleaners below can mutate it (update existing place fields
  // / mint new entries for brand-new rows). We write places.json
  // back alongside walks.json in the bundled commit at the end.
  const placesRead = await readDataFile<PlaceRegistry>(PLACES_FILE)
  const placesData = placesRead.data
  let placesChanged = false

  // Apply every whitelisted field present in the body. Fields not in
  // the body are left alone — PATCH is partial, not PUT. Track
  // whether anything actually changed so we only stamp updatedAt (and
  // trigger a write + rebuild) on real edits.
  let changed = false
  for (const key of EDITABLE_FIELDS) {
    if (!(key in body)) continue

    // sights / lunchStops / destinationStops route through the
    // registry-aware cleaner — venue fields land on places.json,
    // walks.json gets the thin stubs.
    if (key === "sights" || key === "lunchStops" || key === "destinationStops") {
      const placesBefore = JSON.stringify(placesData)
      const stubs = cleanRowArrayWithRegistry(body[key], key, placesData)
      if (stubs === undefined) continue
      // Compare stub array against the existing walk-side array so we
      // only flag walks.json as changed when the row references
      // actually moved. Place-fields-only edits are caught separately
      // via placesChanged below.
      if (JSON.stringify(variant[key]) !== JSON.stringify(stubs)) {
        variant[key] = stubs
        changed = true
      }
      if (JSON.stringify(placesData) !== placesBefore) placesChanged = true
      continue
    }

    // `source` is special-cased: invalid payloads are a no-op (the
    // field stays intact). All other fields treat an undefined clean
    // result as "delete this key" so empty strings/arrays don't
    // linger in the file. Source is always expected to be present,
    // so deleting on a bad PATCH would corrupt the record.
    if (key === "source") {
      const cleaned = cleanSource(body[key])
      if (cleaned && JSON.stringify(variant.source) !== JSON.stringify(cleaned)) {
        variant.source = cleaned
        changed = true
      }
      continue
    }

    // `relatedSource` — same shape as `source` but OPTIONAL. An
    // invalid / empty payload DELETES the field (unlike `source`
    // which is required and no-ops on bad input). Used for admin
    // cross-references to a related walk page, not rendered in
    // public prose.
    if (key === "relatedSource") {
      const cleaned = cleanSource(body[key])
      if (cleaned) {
        if (JSON.stringify(variant.relatedSource) !== JSON.stringify(cleaned)) {
          variant.relatedSource = cleaned
          changed = true
        }
      } else if ("relatedSource" in variant) {
        delete variant.relatedSource
        changed = true
      }
      continue
    }

    const cleaned = cleanField(key, body[key])
    const before = variant[key]
    if (cleaned === undefined) {
      if (key in variant) {
        delete variant[key]
        changed = true
      }
    } else if (JSON.stringify(before) !== JSON.stringify(cleaned)) {
      variant[key] = cleaned
      changed = true
    }
  }

  // Stamp updatedAt on every successful edit so the build script + UI
  // can order walks by "most recently touched first" within a tier.
  // ISO string is precise enough (ms) for the tiebreaker to be stable.
  if (changed || placesChanged) {
    variant.updatedAt = new Date().toISOString()
  }

  // Bundle walks.json + places.json (when changed) in the same commit
  // so the source walk file + the venue registry stay in lockstep with
  // the derived station-* files. Skip the places-only commit when
  // nothing actually moved — small cost saving on no-op saves.
  const sourceFiles: Array<{ path: string; data: unknown }> = [{ path: file, data }]
  if (placesChanged) sourceFiles.push({ path: PLACES_FILE, data: placesData })
  await commitWalkSave(sourceFiles, `Update walk ${id} (${slug})`)

  return NextResponse.json({ message: "ok", id })
  })
}

// DELETE — remove a single walk variant from its source file. If that
// removal empties the entry's `walks` array, we remove the entry
// entirely so the file stays tidy. Triggers a rebuild so station-
// notes.json reflects the disappearance. Admin-only; the top-level
// middleware already blocks DELETE on non-dev environments.
export async function DELETE(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  if (!id || !WALK_ID_RE.test(id)) {
    return NextResponse.json({ error: "invalid id" }, { status: 400 })
  }

  return handleAdminWrite(async () => {
  const located = await locateWalk(id)
  if (!located) return NextResponse.json({ error: "walk not found" }, { status: 404 })

  const { file, data, slug, variantIndex } = located
  const entry = data[slug]
  entry.walks!.splice(variantIndex, 1)
  // If that was the entry's only variant, drop the entry entirely —
  // a walks-less entry would otherwise linger with no purpose.
  if (entry.walks!.length === 0) {
    delete data[slug]
  }

  await commitWalkSave({ path: file, data }, `Delete walk ${id} (${slug})`)

  return NextResponse.json({ message: "ok", id })
  })
}
