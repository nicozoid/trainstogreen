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
// Derived file: per-station season arrays ("Spring" | "Summer" | …) for the
// season dropdown + "[current-season] highlights" checkbox in the filter
// panel. Purely an output of this script — aggregated from each walk
// variant's structured `bestSeasons` month codes. No longer editable in
// the admin UI (used to be, via /api/dev/station-seasons POST).
const SEASONS_PATH = join(PROJECT_ROOT, "data", "station-seasons.json")

// Attachment priority — first in the list takes precedence when multiple
// variants on the same URL touch the same station.
const ROLE_PRIORITY = ["main", "shorter", "longer", "alternative", "variant"]

// Month codes used in each variant's structured `bestSeasons` field.
// Order matters — renders in calendar order regardless of how the source
// data lists them. Also used to map months → high-level seasons when
// aggregating station-level season metadata for the filter UI.
const MONTH_ORDER = ["jan","feb","mar","apr","may","jun","jul","aug","sep","oct","nov","dec"]
const MONTH_FULL = {
  jan: "January", feb: "February", mar: "March", apr: "April",
  may: "May", jun: "June", jul: "July", aug: "August",
  sep: "September", oct: "October", nov: "November", dec: "December",
}
// Calendar-quarter mapping used for deriving per-station season arrays.
const MONTH_TO_SEASON = {
  mar: "Spring", apr: "Spring", may: "Spring",
  jun: "Summer", jul: "Summer", aug: "Summer",
  sep: "Autumn", oct: "Autumn", nov: "Autumn",
  dec: "Winter", jan: "Winter", feb: "Winter",
}
const SEASON_ORDER = ["Spring", "Summer", "Autumn", "Winter"]

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

// Terrain is stored as a single comma-separated string where each
// item is a short phrase (e.g. "Chiltern escarpment ridge, open
// downland, ancient beechwoods"). Historically it was free-prose
// ending in a period; admins now edit it as a list of tags with no
// punctuation, and the renderer handles the comma/"and"/period.
//
// Rendering:
//   ["X"]               → "X."
//   ["X", "Y"]          → "X and Y."
//   ["X", "Y", "Z"]     → "X, Y, and Z."   (Oxford comma)
//
// Any legacy strings that already contain a period or fragment like
// "X, Y, and Z." just pass through untouched via withPeriod() because
// a non-empty parse still looks like one clause — easier than trying
// to round-trip old prose.
function formatTerrainTags(raw) {
  if (!raw || typeof raw !== "string") return null
  const items = raw
    .split(",")
    .map((s) => s.trim().replace(/\s+/g, " "))
    // Drop empty items (consecutive commas) and the special "and X"
    // leading — admins might accidentally type "X, Y, and Z" which
    // we want to read as three items, not two.
    .map((s) => s.replace(/^and\s+/i, ""))
    // Strip trailing sentence punctuation from each item. Legacy
    // strings end with "." so the final item would otherwise double
    // up when we append our own period below.
    .map((s) => s.replace(/[.!?]+$/, "").trim())
    .filter(Boolean)
  if (items.length === 0) return null
  if (items.length === 1) return `${items[0]}.`
  if (items.length === 2) return `${items[0]} and ${items[1]}.`
  return `${items.slice(0, -1).join(", ")}, and ${items[items.length - 1]}.`
}

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

// Structured bestSeasons → "Best in July, August." / "Best in July and August."
// Input is an array of 3-letter month codes. Sorts into calendar order,
// dedupes, converts to full names, joins with commas + "and". Empty or
// invalid → returns null so the caller can fall back to free-text `bestTime`.
function formatBestSeasons(months) {
  if (!Array.isArray(months) || months.length === 0) return null
  const clean = [...new Set(months.map((m) => String(m).toLowerCase()))]
    .filter((m) => MONTH_FULL[m])
    .sort((a, b) => MONTH_ORDER.indexOf(a) - MONTH_ORDER.indexOf(b))
  if (clean.length === 0) return null
  const names = clean.map((m) => MONTH_FULL[m])
  if (names.length === 1) return `Best in ${names[0]}.`
  if (names.length === 2) return `Best in ${names[0]} and ${names[1]}.`
  return `Best in ${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}.`
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
// period. Every walk renders identically — no "main vs variant"
// distinction — so the reader sees a flat list of walks rather than a
// page-anchored hierarchy. Names come from `variant.name`, falling
// back to the entry title when the variant name is the generic
// placeholder "Main Walk" that the SWC extractor emitted.
//
// The `role` field on each variant (main / shorter / longer /
// alternative / variant) is preserved as **provenance metadata** — a
// record of how the SWC extractor categorised this walk when it was
// scraped. It no longer drives rendering or any user-visible
// hierarchy, but may be useful later for filtering or showing the
// "canonical" version of a page's walks.
function buildSummary(variant, entry, crsIndex) {
  const start = crsIndex.get(variant.startStation)
  const end = crsIndex.get(variant.endStation)
  if (!start || !end) return null

  const isCircular = variant.startStation === variant.endStation

  // Display title resolution, in order of precedence:
  //   1. `variant.name` (legacy override / "Custom title" from admin)
  //   2. derived "{start} to {end}" (or "{start} circular") + optional
  //      `variant.suffix` appended with a space
  //   3. `entry.title` as a last-resort fallback (shouldn't fire in
  //      practice — every s2s walk reaching here has resolved stations)
  const rawName = (variant.name ?? "").trim()
  const suffix = (variant.suffix ?? "").trim()
  let displayName
  if (rawName) {
    // Admin-curated override — use as-is. Suffix is ignored in this
    // branch (override is meant to be the final title).
    displayName = rawName
  } else if (start && end) {
    const base = isCircular ? `${start.name} circular` : `${start.name} to ${end.name}`
    displayName = suffix ? `${base} ${suffix}` : base
  } else {
    displayName = entry.title
  }
  // Source URL is always the entry's SWC page for now. Once walks can
  // cite other sources (books, organisations, TG itself — Phase 6),
  // this will need to consult a per-walk source field.
  const opening = `**[${displayName}](${entry.url})**:`

  const parts = [opening]

  // Rambler-favourite flourish now keys off the walk's own rating.
  // Historic behaviour fired on the entry-level `favourite` flag,
  // which applied to every variant of a starred page; the rating
  // lives per-variant so individual variants can be singled out.
  // Threshold: rating >= 3 (backfill starts favourites at 3).
  if (typeof variant.rating === "number" && variant.rating >= 3) {
    parts.push("Rambler favourite!")
  }

  // Terrain — stored as comma-separated tags; renderer joins with
  // commas + "and" + period. Legacy prose that already contains
  // commas still renders well because each chunk is treated as a tag.
  const terrainSentence = formatTerrainTags(variant.terrain)
  if (terrainSentence) parts.push(terrainSentence)

  // Sights — labelled list, no descriptions
  const sightsStr = formatSights(variant.sights)
  if (sightsStr) parts.push(`Sights: ${sightsStr}.`)

  // Structured mud warning — short canonical clause. Only emit if the
  // free-text `warnings` doesn't mention mud anywhere (avoid duplicates
  // like "Can be muddy. Can be muddy." when both the structured flag
  // and a legacy mud sentence are present). Once the free-text mud
  // sentences are pruned in a follow-up pass, this check becomes moot.
  const warningsText = variant.warnings?.trim() ?? ""
  const warningsMentionsMud = /\bmud/i.test(warningsText)
  if (variant.mudWarning && !warningsMentionsMud) parts.push("Can be muddy.")

  // Free-text warnings — one ultra-short clause (for anything not
  // captured by the structured mudWarning flag, e.g. MOD closures).
  if (warningsText) parts.push(withPeriod(warningsText))

  // Best time — prefer the structured month-code array when present;
  // fall back to the free-text `bestTime` field otherwise. Once the
  // migration backfills bestSeasons everywhere, bestTime can be removed.
  const structuredSeasons = formatBestSeasons(variant.bestSeasons)
  if (structuredSeasons) parts.push(structuredSeasons)
  else if (variant.bestTime?.trim()) parts.push(withPeriod(variant.bestTime))

  // Lunch stops — compact list
  const lunch = formatLunchStops(variant.lunchStops)
  if (lunch) parts.push(`Lunch at ${lunch}.`)

  // Distance and hours — each their own sentence, terse.
  // Suppressed when a Komoot URL is present: Komoot provides the
  // authoritative figures, and the Rambler ones are often approximate
  // and end up conflicting with the Komoot route.
  if (!variant.komootUrl) {
    const dist = formatDistance(variant.distanceKm)
    if (dist) parts.push(`${dist}.`)
    const time = formatHours(variant.hours)
    if (time) parts.push(`${time}.`)
  }

  // GPX file — entry-level (applies to the whole page, not per
  // variant). Renders as a trailing "[GPX file](URL)." clause so the
  // admin/user can grab the track for use in their own map tools.
  // Only sources that expose a stable GPX URL (currently Leicester
  // Ramblers) populate this — SWC and Heart entries leave it unset.
  if (entry.gpx) parts.push(`[GPX file](${entry.gpx}).`)

  // Komoot tour link — per-variant. Different variants of the same
  // page can each have their own route, so this lives on the walk
  // variant rather than the entry.
  if (variant.komootUrl) parts.push(`[Komoot](${variant.komootUrl}).`)

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
  // coordKey → Set<Season>. Accumulated across every attached walk
  // variant. Written out to data/station-seasons.json at the end —
  // derived data, never hand-edited.
  const perStationSeasons = new Map()
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

        // Aggregate this variant's structured bestSeasons into the
        // station's derived season set. Only structured month codes
        // contribute — free-text `bestTime` is intentionally ignored
        // here (if a walk hasn't been migrated to month codes yet, its
        // seasonality simply doesn't flow into the filters).
        if (Array.isArray(variant.bestSeasons)) {
          let set = perStationSeasons.get(station.coordKey)
          if (!set) {
            set = { name: station.name, seasons: new Set() }
            perStationSeasons.set(station.coordKey, set)
          }
          for (const m of variant.bestSeasons) {
            const season = MONTH_TO_SEASON[String(m).toLowerCase()]
            if (season) set.seasons.add(season)
          }
        }
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

  // ── Derived file: station-seasons.json ─────────────────────────────
  // Build a diff-friendly output: entries sorted by coordKey, empty
  // season sets skipped, seasons inside each entry in calendar order.
  const seasonsOut = {}
  for (const [coordKey, { name, seasons }] of [...perStationSeasons.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    if (seasons.size === 0) continue
    seasonsOut[coordKey] = {
      name,
      seasons: SEASON_ORDER.filter((s) => seasons.has(s)),
    }
  }
  writeFileSync(SEASONS_PATH, JSON.stringify(seasonsOut, null, 2) + "\n", "utf-8")
  // eslint-disable-next-line no-console
  console.log(`Wrote ${Object.keys(seasonsOut).length} entries to ${SEASONS_PATH}`)

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

// Export the builder so API routes can invoke it in-process (admin
// saves trigger a rebuild immediately). The CLI entry below only runs
// when this file is executed directly via `node scripts/...`, not when
// it's imported.
export { buildRamblerNotes }

if (import.meta.url === `file://${process.argv[1]}`) {
  buildRamblerNotes(parseArgs(process.argv.slice(2)))
}
