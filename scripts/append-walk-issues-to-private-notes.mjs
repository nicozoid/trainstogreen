// For every station linked from the admin/rambler-walks page (i.e. every
// station touched by a walk whose entry carries `issues: true` — either
// as a variant's startStation/endStation or by name in the issue notes),
// append that walk's notes text to the station's privateNote.
//
// Idempotent — the appended block is wrapped in sentinel lines so a
// re-run strips the previous auto-generated block cleanly before writing
// a fresh one. Manual privateNote content outside the block is preserved.
//
// Usage:
//   node scripts/append-walk-issues-to-private-notes.mjs
//   node scripts/append-walk-issues-to-private-notes.mjs --dry-run

import { readFileSync, writeFileSync } from "fs"
import { fileURLToPath } from "url"
import { dirname, join } from "path"

const __dirname = dirname(fileURLToPath(import.meta.url))
const ROOT = join(__dirname, "..")
const WALKS = join(ROOT, "data", "walks.json")
const EXTRA_WALKS = []
const NOTES = join(ROOT, "data", "station-notes.json")
const STATIONS = join(ROOT, "public", "stations.json")

// Sentinel lines that wrap the auto-generated block. Any content between
// these two markers is owned by this script and replaced on each run.
const BLOCK_START = "-- Rambler-walk issues (auto-generated) --"
const BLOCK_END = "-- end Rambler-walk issues --"

const dryRun = process.argv.includes("--dry-run")

const walks = JSON.parse(readFileSync(WALKS, "utf-8"))
for (const p of EXTRA_WALKS) {
  try {
    const extra = JSON.parse(readFileSync(p, "utf-8"))
    for (const [slug, entry] of Object.entries(extra)) walks[slug] = entry
  } catch (err) {
    if (!(err instanceof Error) || !/ENOENT/.test(err.message)) throw err
  }
}
const notes = JSON.parse(readFileSync(NOTES, "utf-8"))
const geo = JSON.parse(readFileSync(STATIONS, "utf-8"))

// Lookup tables
const coordByCrs = new Map()
const nameToCoord = []
const nameByCoord = new Map()
for (const f of geo.features) {
  const [lng, lat] = f.geometry?.coordinates ?? []
  const name = f.properties?.name
  const crs = f.properties?.["ref:crs"]
  if (lng == null || lat == null) continue
  const coord = `${lng},${lat}`
  if (name) {
    nameByCoord.set(coord, name)
    nameToCoord.push({ name, coord })
  }
  if (crs) coordByCrs.set(crs, coord)
}
nameToCoord.sort((a, b) => b.name.length - a.name.length)
const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
for (const entry of nameToCoord) {
  entry.re = new RegExp(`(^|\\W)${escapeRe(entry.name)}($|\\W)`)
}

// For each walk with issues=true, collect all stations it touches and
// record one formatted note line per station. We key by coordKey so
// each station builds a list of (slug, note) pairs.
const notesByStation = new Map() // coordKey → string[]
for (const [slug, entry] of Object.entries(walks)) {
  if (!entry.issues) continue
  const noteText = (entry.notes ?? "").trim()
  if (!noteText) continue
  const touchedCoords = new Set()
  for (const variant of entry.walks ?? []) {
    for (const crs of [variant.startStation, variant.endStation]) {
      if (!crs) continue
      const c = coordByCrs.get(crs)
      if (c) touchedCoords.add(c)
    }
  }
  for (const { coord, re } of nameToCoord) {
    if (re.test(noteText)) touchedCoords.add(coord)
  }
  // Prefix with slug + URL so an admin reading the privateNote can
  // (a) identify which walk page the issue refers to and (b) click
  // through to the source. URL is the walk entry's primary URL —
  // for SWC/Leicester it's the per-walk page; for Heart it's the
  // PDF URL. Emitted as markdown `[slug](url)` so renderWithLinks in
  // photo-overlay.tsx turns it into a clickable anchor; falls back to
  // plain slug if no url is stored.
  const prefix = entry.url ? `[${slug}](${entry.url})` : slug
  const line = `${prefix}: ${noteText}`
  for (const coord of touchedCoords) {
    if (!notesByStation.has(coord)) notesByStation.set(coord, [])
    notesByStation.get(coord).push(line)
  }
}

// Strip any existing auto-generated block from a privateNote string.
// Matches the block even if surrounded by extra blank lines so re-runs
// don't accumulate whitespace.
function stripAutoBlock(privateNote) {
  if (!privateNote) return ""
  const reStart = privateNote.indexOf(BLOCK_START)
  if (reStart < 0) return privateNote
  const reEnd = privateNote.indexOf(BLOCK_END, reStart)
  if (reEnd < 0) return privateNote // malformed — leave alone rather than nuke
  const before = privateNote.slice(0, reStart).replace(/\s+$/, "")
  const after = privateNote.slice(reEnd + BLOCK_END.length).replace(/^\s+/, "")
  return [before, after].filter(Boolean).join("\n\n")
}

// Build the fresh block text for a station given its collected lines.
// Lines are sorted by slug so the file diff stays stable across runs.
function buildBlock(lines) {
  const sorted = [...lines].sort()
  return [BLOCK_START, ...sorted, BLOCK_END].join("\n")
}

let stationsTouched = 0
let linesAppended = 0

// Pass 1 — apply to existing entries + create entries where the station
// is currently missing from station-notes.json.
for (const [coord, lines] of notesByStation) {
  const existing = notes[coord]
  const prevPrivate = existing?.privateNote ?? ""
  const stripped = stripAutoBlock(prevPrivate)
  const block = buildBlock(lines)
  const newPrivate = stripped ? `${stripped}\n\n${block}` : block
  if (!existing) {
    notes[coord] = {
      name: nameByCoord.get(coord) ?? "(unknown)",
      publicNote: "",
      privateNote: newPrivate,
      ramblerNote: "",
    }
  } else {
    existing.privateNote = newPrivate
  }
  stationsTouched++
  linesAppended += lines.length
}

// Pass 2 — for stations that previously had an auto-block but no longer
// appear in notesByStation (their walk's issues were resolved, so they
// shouldn't keep stale notes), strip the block.
let stationsCleared = 0
for (const [coord, entry] of Object.entries(notes)) {
  if (notesByStation.has(coord)) continue
  if (!entry.privateNote?.includes(BLOCK_START)) continue
  entry.privateNote = stripAutoBlock(entry.privateNote)
  // If the entry is now entirely empty, drop it to keep the file clean.
  if (!entry.publicNote && !entry.privateNote && !entry.ramblerNote) {
    delete notes[coord]
  }
  stationsCleared++
}

// eslint-disable-next-line no-console
console.log(`Stations touched (appended auto-block): ${stationsTouched}`)
// eslint-disable-next-line no-console
console.log(`Lines appended in total:                 ${linesAppended}`)
// eslint-disable-next-line no-console
console.log(`Stations whose previous auto-block was cleared: ${stationsCleared}`)

if (dryRun) {
  const samples = [...notesByStation.entries()].slice(0, 3)
  // eslint-disable-next-line no-console
  console.log("\n--- Sample (first 3 stations) ---\n")
  for (const [coord, lines] of samples) {
    const name = nameByCoord.get(coord) ?? coord
    console.log(`${name}  (${coord})`)
    console.log(buildBlock(lines))
    console.log()
  }
  console.log("(dry run — no files written)")
  process.exit(0)
}

// Stable sort the output file so diffs stay readable.
const sortedNotes = Object.fromEntries(
  Object.entries(notes).sort(([a], [b]) => a.localeCompare(b))
)
writeFileSync(NOTES, JSON.stringify(sortedNotes, null, 2) + "\n", "utf-8")
// eslint-disable-next-line no-console
console.log(`\nWrote ${NOTES} (${Object.keys(sortedNotes).length} entries)`)
