import { NextRequest, NextResponse } from "next/server"
import { readDataFile } from "@/lib/github-data"
import { commitWalkSave, handleAdminWrite } from "@/app/api/dev/_helpers"
import { VALID_SPOT_TYPES } from "@/lib/spot-types"

// Files that hold walk entries — mirrors scripts/build-rambler-notes.mjs.
const WALKS_FILES = [
  "data/rambler-walks.json",
  "data/leicester-ramblers-walks.json",
  "data/heart-rail-trails-walks.json",
  "data/abbey-line-walks.json",
  "data/manual-walks.json",
]

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
  "previousWalkDates",
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

// Finds the file + walks entry + variant index for a given walk id.
// Returns null if nothing matches.
//
// Returns the LAST occurrence across files — important when the same
// walk id (or slug) appears in multiple data files. The build script
// (scripts/build-rambler-notes.mjs) merges files in WALKS_FILES order
// with later files overriding earlier ones on slug collision, so the
// LAST file's entry is the authoritative copy used to render the
// public prose. We mirror that here so save updates the same file
// the build reads from — otherwise saves go to a "stale" copy and
// the public view never updates. (Pre-existing data has 110 such
// duplicates between rambler-walks.json and the per-source files.)
async function locateWalk(id: string): Promise<
  | { file: string; data: Record<string, WalkEntry>; sha: string | null; slug: string; variantIndex: number }
  | null
> {
  let lastHit: { file: string; data: Record<string, WalkEntry>; sha: string | null; slug: string; variantIndex: number } | null = null
  for (const file of WALKS_FILES) {
    let read
    try {
      read = await readDataFile<Record<string, WalkEntry>>(file)
    } catch {
      continue // optional files
    }
    for (const [slug, entry] of Object.entries(read.data)) {
      if (!Array.isArray(entry.walks)) continue
      const idx = entry.walks.findIndex((v) => (v as WalkVariant).id === id)
      if (idx >= 0) {
        lastHit = { file, data: read.data, sha: read.sha, slug, variantIndex: idx }
      }
    }
  }
  return lastHit
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
    case "sights": {
      if (!Array.isArray(value)) return undefined
      const cleaned = value
        .map((raw) => cleanSight(raw))
        .filter((x): x is NonNullable<ReturnType<typeof cleanSight>> => x !== null)
      // Preserve an empty array explicitly — the admin may have
      // deleted the last sight intentionally. Storing `[]` vs dropping
      // the key is a minor distinction; we keep the empty array so
      // the intent is visible in the file diff.
      return cleaned
    }
    case "lunchStops":
    case "destinationStops": {
      // Both lists store the same shape (name + location/url/notes/
      // rating/busy), so they share the same row-level cleaner.
      if (!Array.isArray(value)) return undefined
      const cleaned = value
        .map((raw) => cleanLunchStop(raw))
        .filter((x): x is NonNullable<ReturnType<typeof cleanLunchStop>> => x !== null)
      return cleaned
    }
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

function cleanSight(raw: unknown): { name: string; url?: string; description?: string; lat?: number; lng?: number; kmIntoRoute?: number; businessStatus?: string; types?: string[] } | null {
  if (!raw || typeof raw !== "object") return null
  const r = raw as Record<string, unknown>
  const name = typeof r.name === "string" ? r.name.trim() : ""
  if (!name) return null
  const out: { name: string; url?: string; description?: string; lat?: number; lng?: number; kmIntoRoute?: number; businessStatus?: string; types?: string[] } = { name }
  if (typeof r.url === "string" && r.url.trim()) out.url = r.url.trim()
  if (typeof r.description === "string" && r.description.trim()) out.description = r.description.trim()
  const lat = coerceFiniteNumber(r.lat)
  if (lat !== undefined) out.lat = lat
  const lng = coerceFiniteNumber(r.lng)
  if (lng !== undefined) out.lng = lng
  const km = coerceFiniteNumber(r.kmIntoRoute)
  if (km !== undefined) out.kmIntoRoute = km
  if (typeof r.businessStatus === "string" && BUSINESS_STATUSES.has(r.businessStatus)) {
    out.businessStatus = r.businessStatus
  }
  const types = cleanTypes(r.types)
  if (types !== undefined) out.types = types
  return out
}

// `busy` is a tri-state matching the rating field's shape:
// "busy" (popular / loud), "quiet" (calm / room to spare), or absent
// (no opinion). Stored as a string so it parallels rating's enum
// rather than the legacy boolean.
const LUNCH_BUSY = new Set(["busy", "quiet"])

function cleanLunchStop(raw: unknown): {
  name: string
  location?: string
  url?: string
  notes?: string
  rating?: "good" | "fine" | "poor"
  busy?: "busy" | "quiet"
  lat?: number
  lng?: number
  kmIntoRoute?: number
  businessStatus?: string
  types?: string[]
} | null {
  if (!raw || typeof raw !== "object") return null
  const r = raw as Record<string, unknown>
  const name = typeof r.name === "string" ? r.name.trim() : ""
  if (!name) return null
  const out: {
    name: string
    location?: string
    url?: string
    notes?: string
    rating?: "good" | "fine" | "poor"
    busy?: "busy" | "quiet"
    lat?: number
    lng?: number
    kmIntoRoute?: number
    businessStatus?: string
    types?: string[]
  } = { name }
  if (typeof r.location === "string" && r.location.trim()) out.location = r.location.trim()
  if (typeof r.url === "string" && r.url.trim()) out.url = r.url.trim()
  if (typeof r.notes === "string" && r.notes.trim()) out.notes = r.notes.trim()
  if (typeof r.rating === "string" && LUNCH_RATINGS.has(r.rating)) {
    out.rating = r.rating as "good" | "fine" | "poor"
  }
  if (typeof r.busy === "string" && LUNCH_BUSY.has(r.busy)) {
    out.busy = r.busy as "busy" | "quiet"
  }
  const lat = coerceFiniteNumber(r.lat)
  if (lat !== undefined) out.lat = lat
  const lng = coerceFiniteNumber(r.lng)
  if (lng !== undefined) out.lng = lng
  const km = coerceFiniteNumber(r.kmIntoRoute)
  if (km !== undefined) out.kmIntoRoute = km
  if (typeof r.businessStatus === "string" && BUSINESS_STATUSES.has(r.businessStatus)) {
    out.businessStatus = r.businessStatus
  }
  const types = cleanTypes(r.types)
  if (types !== undefined) out.types = types
  return out
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

  // Apply every whitelisted field present in the body. Fields not in
  // the body are left alone — PATCH is partial, not PUT. Track
  // whether anything actually changed so we only stamp updatedAt (and
  // trigger a write + rebuild) on real edits.
  let changed = false
  for (const key of EDITABLE_FIELDS) {
    if (!(key in body)) continue

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
  if (changed) {
    variant.updatedAt = new Date().toISOString()
  }

  // Single atomic commit: source walk file + rebuilt derived station-*
  // files. One commit → one Vercel preview deploy → public view stays
  // in sync because there's no intermediate state where the source
  // changed but the derived files haven't caught up yet.
  await commitWalkSave({ path: file, data }, `Update walk ${id} (${slug})`)

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
