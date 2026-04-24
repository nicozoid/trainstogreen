// Builds per-station RamblerNotes from data/rambler-walks.json and writes
// them to data/station-notes.json. Idempotent — re-running produces the
// same output, regenerating from the walks data each time.
//
// Applies the Phase-6 per-URL-per-station attachment rule:
//   1. Main walk → attached to its startStation and endStation
//   2. Shorter variant → only if Main hasn't already attached at that station
//   3. Longer variant → only if neither Main nor Shorter has
//   4. Other variants → only if nothing else from this URL has
//
// Result: at most one walk summary per URL per station's RamblerNotes.
// Multiple URLs can contribute paragraphs to the same station.
//
// Usage:
//   node scripts/build-rambler-notes.mjs               # writes to disk
//   node scripts/build-rambler-notes.mjs --dry-run     # prints diff, no write
//   node scripts/build-rambler-notes.mjs --flip-on-map # also flips onMap:true
//                                                        on successfully applied walks

import { readFileSync, writeFileSync } from "fs"
import { fileURLToPath } from "url"
import { dirname, join } from "path"

const __dirname = dirname(fileURLToPath(import.meta.url))
const PROJECT_ROOT = join(__dirname, "..")
const WALKS_PATH = join(PROJECT_ROOT, "data", "rambler-walks.json")
// Additional walk source(s). Currently just the Leicester Ramblers
// dataset, which shares the same entry shape so we merge into a single
// map keyed by slug. If future sources are added, extend this list —
// the later sources' entries override earlier ones on slug collision,
// so pick slug prefixes that don't clash (e.g. "leicester-ramblers-…").
const EXTRA_WALKS_PATHS = [
  join(PROJECT_ROOT, "data", "leicester-ramblers-walks.json"),
  join(PROJECT_ROOT, "data", "heart-rail-trails-walks.json"),
  join(PROJECT_ROOT, "data", "abbey-line-walks.json"),
]
// Free-form one-liner extras appended to each station's ramblerNote
// AFTER the walk paragraphs. Keyed by coordKey ("lng,lat"). Each value
// is an array of markdown strings — each becomes its own paragraph.
// Great for short externally-sourced callouts ("Featured by Scenic
// Rail", "RSPB Reserve", etc.) that don't fit the walk-summary shape.
const EXTRAS_PATH = join(PROJECT_ROOT, "data", "station-rambler-extras.json")
const NOTES_PATH = join(PROJECT_ROOT, "data", "station-notes.json")
const STATIONS_PATH = join(PROJECT_ROOT, "public", "stations.json")

// Attachment priority — first in the list takes precedence when multiple
// variants on the same URL touch the same station.
const ROLE_PRIORITY = ["main", "shorter", "longer", "alternative", "variant"]

function parseArgs(argv) {
  return {
    dryRun: argv.includes("--dry-run"),
    flipOnMap: argv.includes("--flip-on-map"),
  }
}

// CRS → { name, coordKey } using exact coordinates from stations.json.
// coordKey format matches station-notes.json's existing keys: "lng,lat".
function buildCrsIndex() {
  const geo = JSON.parse(readFileSync(STATIONS_PATH, "utf-8"))
  const map = new Map()
  for (const f of geo.features) {
    const crs = f.properties?.["ref:crs"]
    const name = f.properties?.name
    const [lng, lat] = f.geometry?.coordinates ?? []
    if (!crs || !name || lng == null || lat == null) continue
    map.set(crs, { name, coordKey: `${lng},${lat}` })
  }
  return map
}

// ── Formatting helpers ────────────────────────────────────────────────────

// Distance in km, rounded DOWN, with a space before "km". Miles are
// intentionally dropped — keeps the trailing stats compact.
function formatDistance(km) {
  if (typeof km !== "number") return null
  return `${Math.floor(km)} km`
}

// Hours round to nearest 30 minutes with ties going UP (4.25 → 4.5, 4.75 → 5).
function formatHours(hours) {
  if (typeof hours !== "number") return null
  const rounded = Math.floor(hours * 2 + 0.5) / 2
  return `${rounded} hours`
}

// Lunch stops: "the Gun Inn in Keyhaven, or the Marine in Milford".
// Commas separate items only (not item-from-location — that uses "in").
// URLs, when present, wrap the name: "the [Gun Inn](URL) in Keyhaven".
// Always prepends a lowercase "the " — we strip any existing leading
// "The/the " from the extractor's name to avoid "the The Swan".
function formatLunchStops(stops) {
  if (!stops?.length) return null
  const fmts = stops.map((s) => {
    const cleanedName = s.name.replace(/^the\s+/i, "")
    const linked = s.url ? `[${cleanedName}](${s.url})` : cleanedName
    const base = `the ${linked}`
    const loc = s.location?.trim()
    return loc ? `${base} in ${loc}` : base
  })
  if (fmts.length === 1) return fmts[0]
  if (fmts.length === 2) return `${fmts[0]}, or ${fmts[1]}`
  return fmts.slice(0, -1).join(", ") + ", or " + fmts[fmts.length - 1]
}

// Sights: "[Lacey Green Windmill](URL), Roald Dahl Museum, [Hastings Castle](URL)".
// No "or" — sights aren't alternatives, they're all worth seeing.
function formatSights(sights) {
  if (!Array.isArray(sights) || sights.length === 0) return null
  return sights
    .map((s) => (s.url ? `[${s.name}](${s.url})` : s.name))
    .join(", ")
}

// "a shorter variant of" / "a longer variant of" / "an alternative variant of" / "a variant of"
function roleQualifier(role) {
  switch (role) {
    case "shorter":     return "a shorter variant of"
    case "longer":      return "a longer variant of"
    case "alternative": return "an alternative variant of"
    default:            return "a variant of"
  }
}

// Ensure a string ends with a period. Trims trailing whitespace and
// existing punctuation before appending.
function withPeriod(s) {
  const trimmed = s.trim().replace(/[.!?]+$/, "")
  return trimmed ? `${trimmed}.` : ""
}

// Compose the markdown string for one walk variant attached to a station.
// Structure (each clause omitted if the source field is empty):
//
//   <opener><fav><terrain> <sights sentence><warnings><bestTime><lunch><km><hours>
//
// Separators between clauses are single spaces; every clause ends with a
// period. Main walks get the page title as the link; variants get
// "Start to End: a ... variant of the [Page Title](URL) walk." as the opener.
function buildSummary(variant, entry, crsIndex) {
  const start = crsIndex.get(variant.startStation)
  const end = crsIndex.get(variant.endStation)
  if (!start || !end) return null

  const isMain = variant.role === "main"
  const isCircular = variant.startStation === variant.endStation

  // The route name (the portion before the first colon) is wrapped in
  // **…** so it renders at font-medium in the overlay — a gentle
  // emphasis to help the eye hop between stacked recommendations.
  // For main walks the linked title IS the route name, so the link
  // lives inside the bold; for variants the "Start to End" subject is
  // the bold, and the source-page link sits in the trailing clause.
  let opening
  if (isMain) {
    opening = `**[${entry.title}](${entry.url})**:`
  } else {
    const subject = isCircular ? `${start.name} circular` : `${start.name} to ${end.name}`
    opening = `**${subject}**: ${roleQualifier(variant.role)} the [${entry.title}](${entry.url}) walk.`
  }

  const parts = [opening]

  // Rambler-favourite flourish (page-level — applies to every variant on
  // a starred URL, per the user's preference)
  if (entry.favourite) parts.push("Rambler favourite!")

  // Terrain — a required clipped sentence
  if (variant.terrain?.trim()) parts.push(withPeriod(variant.terrain))

  // Sights — labelled list, no descriptions
  const sightsStr = formatSights(variant.sights)
  if (sightsStr) parts.push(`Sights: ${sightsStr}.`)

  // Warnings — one ultra-short clause
  if (variant.warnings?.trim()) parts.push(withPeriod(variant.warnings))

  // Best time — one ultra-short clause
  if (variant.bestTime?.trim()) parts.push(withPeriod(variant.bestTime))

  // Lunch stops — compact list
  const lunch = formatLunchStops(variant.lunchStops)
  if (lunch) parts.push(`Lunch at ${lunch}.`)

  // Distance and hours — each their own sentence, terse
  const dist = formatDistance(variant.distanceKm)
  if (dist) parts.push(`${dist}.`)
  const time = formatHours(variant.hours)
  if (time) parts.push(`${time}.`)

  // GPX file — entry-level (applies to the whole page, not per
  // variant). Renders as a trailing "[GPX file](URL)." clause so the
  // admin/user can grab the track for use in their own map tools.
  // Only sources that expose a stable GPX URL (currently Leicester
  // Ramblers) populate this — SWC and Heart entries leave it unset.
  if (entry.gpx) parts.push(`[GPX file](${entry.gpx}).`)

  return parts.join(" ")
}

// ── Main build ─────────────────────────────────────────────────────────────

// Load the primary walks dataset plus any extras, merging by slug.
// Extras override primary on slug collision — that's intentional so
// future sources can patch specific entries if needed.
function loadAllWalks() {
  const merged = JSON.parse(readFileSync(WALKS_PATH, "utf-8"))
  for (const path of EXTRA_WALKS_PATHS) {
    try {
      const extra = JSON.parse(readFileSync(path, "utf-8"))
      for (const [slug, entry] of Object.entries(extra)) merged[slug] = entry
    } catch (err) {
      // Missing file is fine (extras are optional) — rethrow if it's a
      // different problem so we don't silently eat parse errors.
      // eslint-disable-next-line no-console
      if ((err instanceof Error) && !/ENOENT/.test(err.message)) throw err
    }
  }
  return merged
}

function buildRamblerNotes(args) {
  const walks = loadAllWalks()
  const notes = JSON.parse(readFileSync(NOTES_PATH, "utf-8"))
  const crsIndex = buildCrsIndex()

  // coordKey → { name, ramblerParts[] }
  const perStation = new Map()
  // Track which walk URLs contributed at least one summary — used for
  // --flip-on-map to mark onMap:true in rambler-walks.json.
  const urlsUsed = new Set()
  const urlsConsidered = new Set()

  for (const [slug, entry] of Object.entries(walks)) {
    if (!entry.extracted) continue
    if (entry.outsideMainlandBritain) continue
    if (!Array.isArray(entry.walks) || entry.walks.length === 0) continue
    urlsConsidered.add(slug)

    // Iterate variants in priority order; track which stations have
    // already received a summary from THIS page.
    const sorted = [...entry.walks]
      .filter((v) => v.stationToStation)
      .sort(
        (a, b) => ROLE_PRIORITY.indexOf(a.role) - ROLE_PRIORITY.indexOf(b.role)
      )

    const urlStationsAdded = new Set()

    for (const variant of sorted) {
      const summary = buildSummary(variant, entry, crsIndex)
      if (!summary) continue
      for (const crs of [variant.startStation, variant.endStation]) {
        if (!crs) continue
        const station = crsIndex.get(crs)
        if (!station) continue
        if (urlStationsAdded.has(station.coordKey)) continue
        urlStationsAdded.add(station.coordKey)
        urlsUsed.add(slug)

        if (!perStation.has(station.coordKey)) {
          perStation.set(station.coordKey, { name: station.name, ramblerParts: [] })
        }
        // priority: 0 = Rambler-favourite walk, 1 = regular walk, 2 = extras.
        // Sorted before join so favourites float to the top of the note.
        perStation.get(station.coordKey).ramblerParts.push({
          summary,
          priority: entry.favourite ? 0 : 1,
        })
      }
    }
  }

  // Merge free-form extras AFTER the walk paragraphs. Each entry in the
  // extras file is a list of markdown strings keyed by coordKey; each
  // string becomes its own paragraph. A station with ONLY extras (no
  // walk summary) still lands in perStation so the cleanup loop below
  // doesn't wipe its ramblerNote.
  let extras = {}
  try {
    const raw = JSON.parse(readFileSync(EXTRAS_PATH, "utf-8"))
    // Strip the _readme key — it's documentation for humans, not data.
    for (const [k, v] of Object.entries(raw)) if (k !== "_readme") extras[k] = v
  } catch (err) {
    if (!(err instanceof Error) || !/ENOENT/.test(err.message)) throw err
  }
  for (const [coordKey, lines] of Object.entries(extras)) {
    if (!Array.isArray(lines) || lines.length === 0) continue
    const station = [...crsIndex.values()].find((s) => s.coordKey === coordKey)
    // Station not in our data → skip silently (coord might be a typo
    // or a retired stop we no longer show).
    if (!station && !perStation.has(coordKey)) continue
    if (!perStation.has(coordKey)) {
      perStation.set(coordKey, {
        name: station?.name ?? notes[coordKey]?.name ?? "(unknown)",
        ramblerParts: [],
      })
    }
    for (const line of lines) {
      perStation.get(coordKey).ramblerParts.push({ summary: line, priority: 2 })
    }
  }

  // Apply to station-notes.json:
  // - Stations in perStation get their ramblerNote set to joined paragraphs.
  // - Existing stations not in perStation get their ramblerNote cleared
  //   (preserves publicNote and privateNote).
  // - Entries that end up with all three notes empty are removed so the
  //   file stays clean.
  const changes = { added: 0, updated: 0, cleared: 0, removed: 0 }

  for (const [coordKey, { name, ramblerParts }] of perStation) {
    // Stable sort by priority: favourites first, then regular walks, then extras.
    const ordered = [...ramblerParts].sort((a, b) => a.priority - b.priority)
    const ramblerNote = ordered.map((p) => p.summary).join("\n\n")
    if (notes[coordKey]) {
      const before = notes[coordKey].ramblerNote
      notes[coordKey].ramblerNote = ramblerNote
      if (before !== ramblerNote) changes.updated++
    } else {
      notes[coordKey] = { name, publicNote: "", privateNote: "", ramblerNote }
      changes.added++
    }
  }

  for (const [coordKey, entry] of Object.entries(notes)) {
    if (perStation.has(coordKey)) continue
    if (entry.ramblerNote) {
      entry.ramblerNote = ""
      changes.cleared++
    }
  }

  for (const [coordKey, entry] of Object.entries(notes)) {
    if (!entry.publicNote && !entry.privateNote && !entry.ramblerNote) {
      delete notes[coordKey]
      changes.removed++
    }
  }

  // eslint-disable-next-line no-console
  console.log(
    `Extracted pages considered: ${urlsConsidered.size}  contributed: ${urlsUsed.size}  stations affected: ${perStation.size}`
  )
  // eslint-disable-next-line no-console
  console.log(
    `Changes — added: ${changes.added}, updated: ${changes.updated}, cleared: ${changes.cleared}, removed: ${changes.removed}`
  )

  if (args.dryRun) {
    // eslint-disable-next-line no-console
    console.log("\n--- Sample output (first 3 affected stations) ---\n")
    const samples = [...perStation.entries()].slice(0, 3)
    for (const [coordKey, { name, ramblerParts }] of samples) {
      // eslint-disable-next-line no-console
      console.log(`${name} (${coordKey})`)
      // eslint-disable-next-line no-console
      console.log("-".repeat(name.length + coordKey.length + 3))
      // eslint-disable-next-line no-console
      const orderedSample = [...ramblerParts].sort((a, b) => a.priority - b.priority)
      // eslint-disable-next-line no-console
      console.log(orderedSample.map((p) => p.summary).join("\n\n"))
      // eslint-disable-next-line no-console
      console.log()
    }
    // eslint-disable-next-line no-console
    console.log("(dry run — no files written)")
    return
  }

  writeFileSync(NOTES_PATH, JSON.stringify(notes, null, 2) + "\n", "utf-8")
  // eslint-disable-next-line no-console
  console.log(`Wrote ${Object.keys(notes).length} entries to ${NOTES_PATH}`)

  if (args.flipOnMap) {
    // Update onMap per-source so each file only holds its own entries —
    // otherwise merging `walks` would push Leicester entries into the SWC
    // rambler-walks.json on writeback.
    let flipped = 0
    const updateFile = (path) => {
      let data
      try { data = JSON.parse(readFileSync(path, "utf-8")) } catch { return }
      for (const slug of Object.keys(data)) {
        const entry = data[slug]
        if (!entry.extracted) continue
        const onMapNow = urlsUsed.has(slug) || !!entry.outsideMainlandBritain
        if (entry.onMap !== onMapNow) {
          entry.onMap = onMapNow
          flipped++
        }
      }
      writeFileSync(path, JSON.stringify(data, null, 2) + "\n", "utf-8")
    }
    updateFile(WALKS_PATH)
    for (const p of EXTRA_WALKS_PATHS) updateFile(p)
    // eslint-disable-next-line no-console
    console.log(`Flipped onMap on ${flipped} walk entries.`)
  }
}

buildRamblerNotes(parseArgs(process.argv.slice(2)))
