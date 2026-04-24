import { NextRequest, NextResponse } from "next/server"
import { readDataFile, writeDataFile } from "@/lib/github-data"
import { buildRamblerNotes } from "@/scripts/build-rambler-notes.mjs"

// Files that hold walk entries — mirrors scripts/build-rambler-notes.mjs.
const WALKS_FILES = [
  "data/rambler-walks.json",
  "data/leicester-ramblers-walks.json",
  "data/heart-rail-trails-walks.json",
  "data/abbey-line-walks.json",
]

// Whitelist of editable fields. Anything outside this set is ignored
// (can't set arbitrary keys via the PATCH body).
// Extending this list is a deliberate step — please add the UI editor
// at the same time so the data/UI stay in sync.
const EDITABLE_FIELDS = [
  "komootUrl",
  "bestSeasons",
  "mudWarning",
  "bestTime",
  "warnings",
  "trainTips",
  "rating",
  "terrain",
  "distanceKm",
  "hours",
  "name",
  "suffix",
  "sights",
  "lunchStops",
  "source",
] as const

const LUNCH_RATINGS = new Set(["good", "fine", "poor"])
const SOURCE_TYPES = new Set(["main", "shorter", "longer", "alternative", "variant"])

// Month codes accepted inside the bestSeasons array. Keep in sync with
// the month alphabet used by scripts/build-rambler-notes.mjs.
const VALID_MONTHS = new Set([
  "jan","feb","mar","apr","may","jun","jul","aug","sep","oct","nov","dec",
])

type WalkVariant = Record<string, unknown>
type WalkEntry = { slug?: string; walks?: WalkVariant[]; [k: string]: unknown }

// Finds the file + walks entry + variant index for a given walk id.
// Returns null if nothing matches. Scans ALL walk files because ids
// are globally unique across sources.
async function locateWalk(id: string): Promise<
  | { file: string; data: Record<string, WalkEntry>; sha: string | null; slug: string; variantIndex: number }
  | null
> {
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
        return { file, data: read.data, sha: read.sha, slug, variantIndex: idx }
      }
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
    case "bestTime":
    case "warnings":
    case "trainTips":
    case "terrain":
    case "name":
    case "suffix": {
      if (typeof value !== "string") return undefined
      const trimmed = value.trim()
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
    case "hours": {
      // Numeric fields — null or non-finite drops the field. Negative
      // values are treated as garbage (sanity floor).
      if (typeof value !== "number" || !Number.isFinite(value) || value < 0) return undefined
      return value
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
    case "lunchStops": {
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

// Source provenance — all four keys required (we've already backfilled
// every walk with a source, so missing orgSlug/pageName/pageURL on a
// PATCH means the admin accidentally cleared a required field; drop
// the update silently rather than corrupting the record).
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
  if (!orgSlug || !pageName || !pageURL) return null
  const type = SOURCE_TYPES.has(typeRaw) ? typeRaw : "variant"
  return { orgSlug, pageName, pageURL, type }
}

// Row-level cleaners for sights/lunch. Drop rows with an empty name
// (everything else is optional context about that row). String fields
// are trimmed; empty trimmed strings → field omitted (so the JSON
// stays compact without empty keys).
function cleanSight(raw: unknown): { name: string; url?: string; description?: string } | null {
  if (!raw || typeof raw !== "object") return null
  const r = raw as Record<string, unknown>
  const name = typeof r.name === "string" ? r.name.trim() : ""
  if (!name) return null
  const out: { name: string; url?: string; description?: string } = { name }
  if (typeof r.url === "string" && r.url.trim()) out.url = r.url.trim()
  if (typeof r.description === "string" && r.description.trim()) out.description = r.description.trim()
  return out
}

function cleanLunchStop(raw: unknown): {
  name: string
  location?: string
  url?: string
  notes?: string
  rating?: "good" | "fine" | "poor"
  busy?: true
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
    busy?: true
  } = { name }
  if (typeof r.location === "string" && r.location.trim()) out.location = r.location.trim()
  if (typeof r.url === "string" && r.url.trim()) out.url = r.url.trim()
  if (typeof r.notes === "string" && r.notes.trim()) out.notes = r.notes.trim()
  if (typeof r.rating === "string" && LUNCH_RATINGS.has(r.rating)) {
    out.rating = r.rating as "good" | "fine" | "poor"
  }
  // `busy` collapses to absence when false so the JSON file stays
  // tidy — presence of the key is the signal.
  if (r.busy === true) out.busy = true
  return out
}

export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  if (!id || !/^[0-9a-z]{4}$/.test(id)) {
    return NextResponse.json({ error: "invalid id" }, { status: 400 })
  }

  const body = await req.json()
  if (!body || typeof body !== "object") {
    return NextResponse.json({ error: "invalid body" }, { status: 400 })
  }

  const located = await locateWalk(id)
  if (!located) return NextResponse.json({ error: "walk not found" }, { status: 404 })

  const { file, data, sha, slug, variantIndex } = located
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

  await writeDataFile(file, data, `Update walk ${id} (${slug})`, sha)

  // Rebuild in-process so station-notes.json + station-seasons.json
  // reflect the change immediately. The builder logs to stdout — fine
  // for now; the client just cares about the result.
  try {
    await buildRamblerNotes({ dryRun: false, flipOnMap: false })
  } catch (err) {
    // Report but don't undo the write — the data is saved, the derived
    // files just need another rebuild.
    // eslint-disable-next-line no-console
    console.error("rebuild after walk patch failed:", err)
    return NextResponse.json(
      { message: "saved but rebuild failed", id },
      { status: 500 },
    )
  }

  return NextResponse.json({ message: "ok", id })
}
