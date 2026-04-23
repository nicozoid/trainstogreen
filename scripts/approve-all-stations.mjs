// Rebuilds data/approved-journeys.json from scratch with one rule:
//
//   Approve every (primary origin × non-excluded destination) pair —
//   EXCEPT destinations that are touched by any walk flagged with
//   `issues: true` in data/rambler-walks.json. Those stay unapproved
//   so they still surface the admin red tint for review.
//
// Running this script replaces the existing approvals file wholesale.
// Any manually-added approvals will be lost (and can be re-added via the
// admin UI). That's intentional — the rule above is authoritative.
//
// Usage:
//   node scripts/approve-all-stations.mjs
//   node scripts/approve-all-stations.mjs --dry-run

import { readFileSync, writeFileSync } from "fs"
import { fileURLToPath } from "url"
import { dirname, join } from "path"

const __dirname = dirname(fileURLToPath(import.meta.url))
const ROOT = join(__dirname, "..")
const STATIONS = join(ROOT, "public", "stations.json")
const EXCLUDED = join(ROOT, "data", "excluded-stations.json")
const APPROVED = join(ROOT, "data", "approved-journeys.json")
const WALKS = join(ROOT, "data", "rambler-walks.json")
// Extra walks files (same shape as the SWC one) — merged so that any
// issue-flagged entry in a secondary source also keeps its stations
// out of the approval set.
const EXTRA_WALKS = [
  join(ROOT, "data", "leicester-ramblers-walks.json"),
  join(ROOT, "data", "heart-rail-trails-walks.json"),
  join(ROOT, "data", "abbey-line-walks.json"),
]

// Primary origins that populate the home dropdown — mirror of the
// PRIMARY_ORIGINS constant in components/map.tsx. Kept in sync manually;
// add a new entry here if you add one to the component. Each key is the
// primary's coordKey ("lng,lat"); order doesn't matter.
const PRIMARY_ORIGIN_COORDS = [
  "-0.1269,51.5196",       // Central London synthetic
  "-0.1239491,51.530609",  // Kings Cross / St Pancras / Euston cluster primary
  "-0.1236888,51.5074975", // Charing Cross
  "-0.163592,51.5243712",  // Marylebone
  "-0.177317,51.5170952",  // Paddington
  "-0.1445802,51.4947328", // Victoria
  "-0.112801,51.5028379",  // Waterloo
  "-0.0035472,51.541289",  // Stratford
  "-0.0890625,51.5182516", // Moorgate
  "-0.0814269,51.5182105", // Liverpool Street
  "-0.0906046,51.5106685", // Cannon Street
  "-0.0774191,51.5113281", // Fenchurch Street
  "-0.1032417,51.5104871", // Blackfriars
  "-0.0851473,51.5048764", // London Bridge
]

const dryRun = process.argv.includes("--dry-run")

const geo = JSON.parse(readFileSync(STATIONS, "utf-8"))
// excluded-stations.json is loaded but no longer gates approvals.
// Both excluded and non-excluded stations can be approved; the only
// thing that keeps a station unapproved is being touched by an
// issue-flagged walk (below).
const excluded = new Set(JSON.parse(readFileSync(EXCLUDED, "utf-8")))
void excluded // retained for future use / log diagnostics
const walks = JSON.parse(readFileSync(WALKS, "utf-8"))
for (const p of EXTRA_WALKS) {
  try {
    const extra = JSON.parse(readFileSync(p, "utf-8"))
    for (const [slug, entry] of Object.entries(extra)) walks[slug] = entry
  } catch (err) {
    if (!(err instanceof Error) || !/ENOENT/.test(err.message)) throw err
  }
}

// Build CRS → coordKey map from stations.json. We need this because
// rambler-walks.json references stations by their CRS code (e.g. "HOT")
// while approved-journeys.json keys by coordKey ("lng,lat").
const coordByCrs = new Map()
// Name → coordKey so we can scan the notes text for stations that are
// mentioned but not resolved into a walk's startStation/endStation
// (e.g. the candidate names surfaced in "Lymington is ambiguous
// (candidates: Lymington Town, Lymington Pier)" — LYT and LYP are
// mentioned in the note but neither is startStation because the model
// wrote bare "Lymington"). Iterated in LENGTH-DESCENDING order when
// matching so "Lymington Town" wins over bare "Lymington" et al.
const nameToCoord = []
for (const feature of geo.features) {
  const [lng, lat] = feature.geometry?.coordinates ?? []
  const crs = feature.properties?.["ref:crs"]
  const name = feature.properties?.name
  if (lng == null || lat == null) continue
  const coord = `${lng},${lat}`
  if (crs) coordByCrs.set(crs, coord)
  if (name) nameToCoord.push({ name, coord })
}
nameToCoord.sort((a, b) => b.name.length - a.name.length)

// Precompile a word-boundary regex per station name. Matching is
// case-sensitive so "Hope" (Derbyshire station) doesn't fire on the
// common verb "hope"; station names are title-case in source, as are
// proper-noun references in the auto-generated notes text.
const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
for (const entry of nameToCoord) {
  entry.re = new RegExp(`(^|\\W)${escapeRe(entry.name)}($|\\W)`)
}

// Every station that either (a) is the start or end of any variant of
// a walk with `issues: true`, or (b) is NAMED in the walk's notes
// text, gets flagged. Both channels matter because the CRS resolver
// nulls out ambiguous starts/ends (e.g. bare "Lymington"), so the
// only record of LYT/LYP being implicated for that walk is the notes
// string surfacing "candidates: Lymington Town, Lymington Pier".
const issueCoords = new Set()
for (const entry of Object.values(walks)) {
  if (!entry.issues) continue
  // Variant-level CRS flags
  for (const variant of entry.walks ?? []) {
    for (const crs of [variant.startStation, variant.endStation]) {
      if (!crs) continue
      const coord = coordByCrs.get(crs)
      if (coord) issueCoords.add(coord)
    }
  }
  // Scan the notes text for any station name. Cheap enough — a few
  // thousand regex tests per issue-walk × ~150 issue walks runs in
  // under a second.
  const notes = entry.notes ?? ""
  if (!notes) continue
  for (const { coord, re } of nameToCoord) {
    if (re.test(notes)) issueCoords.add(coord)
  }
}

// Start fresh — this script is authoritative. Any prior approvals
// (either manual admin edits or old blanket runs) get overwritten.
const approvals = {}
const now = new Date().toISOString()
let approved = 0
let skippedIssues = 0

for (const primary of PRIMARY_ORIGIN_COORDS) {
  for (const feature of geo.features) {
    const [lng, lat] = feature.geometry?.coordinates ?? []
    if (lng == null || lat == null) continue
    const coord = `${lng},${lat}`
    // Skip the primary itself — a station can't be its own destination.
    if (coord === primary) continue
    // Skip stations touched by any issue-flagged walk — those stay
    // unapproved so the red tint keeps surfacing them for review,
    // INCLUDING excluded stations (now that excluded + !isApproved
    // is a valid combination on the map).
    if (issueCoords.has(coord)) { skippedIssues++; continue }
    const composite = `${primary}|${coord}`
    approvals[composite] = {
      homeName: primary,
      destName: feature.properties?.name ?? "(unknown)",
      approvedAt: now,
    }
    approved++
  }
}

// eslint-disable-next-line no-console
console.log(
  `Issue-stations skipped across all primaries: ${skippedIssues}  (${issueCoords.size} unique station coords)`
)
// eslint-disable-next-line no-console
console.log(
  `Approvals written: ${approved}  (${PRIMARY_ORIGIN_COORDS.length} primaries × non-excluded non-issue stations)`
)

if (dryRun) {
  // eslint-disable-next-line no-console
  console.log("(dry run — no files written)")
  process.exit(0)
}

// Stable sort by composite key so the file diff stays readable.
const sorted = Object.fromEntries(
  Object.entries(approvals).sort(([a], [b]) => a.localeCompare(b))
)
writeFileSync(APPROVED, JSON.stringify(sorted, null, 2) + "\n", "utf-8")
// eslint-disable-next-line no-console
console.log(`Wrote ${APPROVED}`)
