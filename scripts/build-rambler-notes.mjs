// Builds per-station RamblerNotes from data/rambler-walks.json and writes
// them to data/station-notes.json. Idempotent — re-running produces the
// same output, regenerating from the walks data each time.
//
// Attachment rule: every station-to-station walk variant gets its own
// paragraph at its start and end stations (no per-source-URL dedup).
// Paragraph order within a station is determined by compareRamblerParts:
//   hasKomoot → isMain → ratingTier → distanceScore → pageTitle
// The admin has no manual override — curation happens via rating/
// komoot/suffix edits on individual walks.
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
  // Manual walks created through the admin UI ("+ New walk") —
  // same entry shape as rambler-walks.json, one entry per walk
  // keyed `manual-{id}`.
  join(PROJECT_ROOT, "data", "manual-walks.json"),
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

// Derived list of stations where at least one attached walk has a
// populated `previousWalkDates` array — i.e. we've personally walked
// it. Drives the admin-only "Undiscovered" filter, which inverts the
// match to surface destinations still to explore.
const HIKED_PATH = join(PROJECT_ROOT, "data", "stations-hiked.json")

// Month codes used in each variant's structured `bestSeasons` field.
// Order matters — renders in calendar order regardless of how the source
// data lists them. Also used to map months → high-level seasons when
// aggregating station-level season metadata for the filter UI.
const MONTH_ORDER = ["jan","feb","mar","apr","may","jun","jul","aug","sep","oct","nov","dec"]
// Title-case three-letter abbreviations. Keeps the rendered "Best in …"
// clause compact — "Best in Oct–Jan" reads faster than "Best in October
// to January". "May" stays 3 letters since the full name is already short.
const MONTH_FULL = {
  jan: "Jan", feb: "Feb", mar: "Mar", apr: "Apr",
  may: "May", jun: "Jun", jul: "Jul", aug: "Aug",
  sep: "Sep", oct: "Oct", nov: "Nov", dec: "Dec",
}
// Calendar-quarter mapping used for deriving per-station season arrays.
const MONTH_TO_SEASON = {
  mar: "Spring", apr: "Spring", may: "Spring",
  jun: "Summer", jul: "Summer", aug: "Summer",
  sep: "Autumn", oct: "Autumn", nov: "Autumn",
  dec: "Winter", jan: "Winter", feb: "Winter",
}
const SEASON_ORDER = ["Spring", "Summer", "Autumn", "Winter"]

// Rating tier mapping used to sort walks at a station. Lower value =
// higher in the rendered list. Rating=1 (Flawed) is explicitly
// demoted below unrated walks because it's an active down-vote, not
// an absence of signal. Mirror of the constant in
// app/api/dev/walks-for-station/route.ts — keep in sync.
const RATING_TIER = { 4: 0, 3: 1, 2: 2, unrated: 3, 1: 4 }
function ratingTierOf(rating) {
  if (typeof rating !== "number") return RATING_TIER.unrated
  const key = Math.round(rating)
  return RATING_TIER[key] ?? RATING_TIER.unrated
}

// Ideal walk length for ordering. Walks closer to this figure sort
// higher (|distanceKm - IDEAL_LENGTH_KM| ASC). Tweak the constant to
// shift the bias — e.g. 13 prefers a full-day hike, 8 prefers a
// half-day stroll. Walks with no distance recorded fall to the
// bottom of this tier (Infinity score).
const IDEAL_LENGTH_KM = 13

function distanceScore(distanceKm) {
  if (typeof distanceKm !== "number" || !Number.isFinite(distanceKm)) {
    return Number.POSITIVE_INFINITY
  }
  return Math.abs(distanceKm - IDEAL_LENGTH_KM)
}

// Order ramblerParts at a station:
//   1. walks before extras (kind ASC)
//   2. isMain DESC (main walks ALL come before variants — enables the
//                   client-side "slice to N mains when there are 2+"
//                   rule; non-mains are always second-class now)
//   3. hasKomoot DESC (within the same kind + main-status, komoot first)
//   4. ratingTier ASC (4 on top, then 3, 2, unrated, 1)
//   5. distanceScore ASC (closer to IDEAL_LENGTH_KM first; missing sorts last)
//   6. pageTitle ASC for stable alphabetic tiebreak
function compareRamblerParts(a, b) {
  if (a.kind !== b.kind) return a.kind - b.kind
  if (a.isMain !== b.isMain) return a.isMain ? -1 : 1
  if (a.hasKomoot !== b.hasKomoot) return a.hasKomoot ? -1 : 1
  if (a.ratingTier !== b.ratingTier) return a.ratingTier - b.ratingTier
  if (a.distanceScore !== b.distanceScore) return a.distanceScore - b.distanceScore
  return (a.pageTitle || "").localeCompare(b.pageTitle || "")
}

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

// Source-link clause. Every walk gets one, positioned right after the
// title colon. The walk title itself is intentionally un-linked so
// this clause is the single canonical path to the source page.
//
//   main        → "From [Page](url)."
//   shorter     → "A shorter variant of [Page](url)."
//   longer      → "A longer variant of [Page](url)."
//   alternative → "An alternative variant of [Page](url)."
//   variant     → "A variant of [Page](url)."
//
// Capitalised at sentence start (follows the opening colon). Returns
// null only if the walk has no identifiable source — in practice this
// never fires post-backfill, but the build script stays defensive.
function formatSourceClause(variant, entry) {
  // Prefer the structured source info, falling back to entry-level
  // fields for any walk that predates the source backfill. role is
  // the legacy field; source.type is its modern home.
  const type = variant.source?.type ?? variant.role ?? "main"
  const pageName = variant.source?.pageName ?? entry.title
  const pageURL = variant.source?.pageURL ?? entry.url
  if (!pageName || !pageURL) return null
  let phrase
  switch (type) {
    case "main":        phrase = "From"; break
    case "shorter":     phrase = "A shorter variant of"; break
    case "longer":      phrase = "A longer variant of"; break
    case "alternative": phrase = "An alternative variant of"; break
    case "variant":     phrase = "A variant of"; break
    default:            phrase = "From"; break
  }
  return `${phrase} [${pageName}](${pageURL}).`
}

// Sights: "[Lacey Green Windmill](URL), Roald Dahl Museum, and [Hastings Castle](URL)".
// No "or" — sights aren't alternatives, they're all worth seeing.
// Oxford comma + "and" before the last item, matching the terrain-tag
// formatter's style so the rendered prose reads consistently.
function formatSights(sights) {
  if (!Array.isArray(sights) || sights.length === 0) return null
  const items = sights.map((s) => (s.url ? `[${s.name}](${s.url})` : s.name))
  if (items.length === 1) return items[0]
  if (items.length === 2) return `${items[0]} and ${items[1]}`
  return `${items.slice(0, -1).join(", ")}, and ${items[items.length - 1]}`
}

// Structured bestSeasons → "Best in July and August." / "Best in December,
// January and February." Input is an array of 3-letter month codes.
//
// Ordering is "season-aware" rather than strictly calendar-order: we
// rotate the 12-month cycle so the selected months start at the
// natural beginning of their contiguous run. "dec, jan, feb" reads as
// "December, January and February" (winter starts in December) not
// "January, February and December". The rotation finds the largest
// gap between selected months (circularly) and starts listing
// immediately after it. Dedupes; empty/invalid → null so the caller
// Empty/invalid → null.
function formatBestSeasons(months) {
  if (!Array.isArray(months) || months.length === 0) return null
  const set = new Set()
  for (const m of months) {
    const key = String(m).toLowerCase()
    if (MONTH_FULL[key]) set.add(key)
  }
  if (set.size === 0) return null

  const indices = MONTH_ORDER
    .map((m, i) => (set.has(m) ? i : -1))
    .filter((i) => i >= 0)

  // Find the largest circular gap between consecutive selected months.
  // The "start" of the run is the month immediately after that gap.
  let maxGap = -1
  let startAt = indices[0]
  for (let i = 0; i < indices.length; i++) {
    const cur = indices[i]
    const next = indices[(i + 1) % indices.length]
    // Gap size going forward from cur to next (modulo 12).
    const gap = ((next - cur + 12) % 12) || 12
    if (gap > maxGap) {
      maxGap = gap
      startAt = next
    }
  }

  // Rotate the list so it begins at startAt.
  const rotated = []
  let idx = indices.indexOf(startAt)
  for (let k = 0; k < indices.length; k++) {
    rotated.push(indices[(idx + k) % indices.length])
  }

  // If the rotated sequence is a contiguous run — each adjacent pair
  // one calendar month apart (modulo 12) — collapse it to
  // "{first}–{last}" with an en-dash instead of listing each month.
  // Examples:
  //   [mar, apr, may]        → "Mar–May"
  //   [oct, nov, dec, jan]   → "Oct–Jan"
  //   [mar, apr, jun]        → "Mar, Apr and Jun"  (gap, no collapse)
  const isContiguous = rotated.length >= 2 && rotated.every((m, k) => {
    if (k === 0) return true
    return (m - rotated[k - 1] + 12) % 12 === 1
  })
  if (isContiguous) {
    const first = MONTH_FULL[MONTH_ORDER[rotated[0]]]
    const last = MONTH_FULL[MONTH_ORDER[rotated[rotated.length - 1]]]
    return `Best in ${first}\u2013${last}.`
  }

  const names = rotated.map((i) => MONTH_FULL[MONTH_ORDER[i]])
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
//   <opener><fav><terrain> <sights sentence><warnings><trainTips><bestSeasons><lunch><km><hours>
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
  // Base title = the derived name WITHOUT the suffix. Used by the
  // downstream "hide duplicate variants" filter: a variant is hidden
  // from public view when its baseDisplayName matches any other walk's
  // full displayName at the same station (so two variants that differ
  // only in their suffix don't both clutter the list).
  let baseDisplayName
  if (rawName) {
    // Admin-curated override — use as-is. Suffix is ignored in this
    // branch (override is meant to be the final title). The base for
    // the duplicate check is the override itself (no suffix to strip).
    displayName = rawName
    baseDisplayName = rawName
  } else if (start && end) {
    const base = isCircular ? `${start.name} Circular` : `${start.name} to ${end.name}`
    displayName = suffix ? `${base} ${suffix}` : base
    baseDisplayName = base
  } else {
    displayName = entry.title
    baseDisplayName = entry.title
  }
  // Title linking is conditional on variant type:
  //  - MAIN walks link the title directly to source.pageURL so the
  //    most common case (canonical walk for a page) stays compact —
  //    no trailing "From X" clause needed.
  //  - VARIANTS (shorter / longer / alternative / variant) keep the
  //    title plain; their provenance is carried in a dedicated
  //    "A shorter variant of [X](url)." clause right after.
  const sourceType = variant.source?.type ?? variant.role ?? "main"
  const isMain = sourceType === "main"
  const sourceUrl = variant.source?.pageURL ?? entry.url

  let opening
  if (isMain && sourceUrl) {
    opening = `**[${displayName}](${sourceUrl})**:`
  } else {
    opening = `**${displayName}**:`
  }

  const parts = [opening]

  // Variant-of clause — only emitted for non-main walks. Mains don't
  // need one because their title IS the link to the source page.
  if (!isMain) {
    const sourceClause = formatSourceClause(variant, entry)
    if (sourceClause) parts.push(sourceClause)
  }

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

  // Train tips — booking advice (singles vs returns, off-peak windows
  // etc). Sits immediately after warnings so practical "before you go"
  // info is grouped together in the prose.
  const trainTipsText = variant.trainTips?.trim() ?? ""
  if (trainTipsText) parts.push(withPeriod(trainTipsText))

  // Best seasons — the structured month-code array. Legacy free-text
  // bestTime has been migrated into warnings and the field removed.
  const structuredSeasons = formatBestSeasons(variant.bestSeasons)
  if (structuredSeasons) parts.push(structuredSeasons)

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
  if (variant.komootUrl) parts.push(`[Komoot route](${variant.komootUrl}).`)

  // Return the rendered string PLUS the title pieces — callers need
  // `displayName` / `baseDisplayName` to run the duplicate-variant
  // filter without re-implementing the derivation logic.
  return { summary: parts.join(" "), displayName, baseDisplayName }
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
  // coordKey → true. Any station whose attached walks include at least
  // one variant with a non-empty `previousWalkDates` array. Written to
  // data/stations-hiked.json as a sorted array; the admin "Undiscovered"
  // filter hides these to surface the stations still to visit.
  const perStationHiked = new Set()
  // Track which walk URLs contributed at least one summary — used for
  // --flip-on-map to mark onMap:true in rambler-walks.json.
  const urlsUsed = new Set()
  const urlsConsidered = new Set()

  for (const [slug, entry] of Object.entries(walks)) {
    if (!entry.extracted) continue
    if (entry.outsideMainlandBritain) continue
    if (!Array.isArray(entry.walks) || entry.walks.length === 0) continue
    urlsConsidered.add(slug)

    // Every station-to-station variant gets its own paragraph. We no
    // longer dedup by source URL: the automatic sort (komoot →
    // main-first → rating → distance) orders them and keeps the
    // reader from drowning in redundant siblings, and admins curate
    // via ratings/suffixes if they want any one walk demoted.
    const stationToStation = entry.walks.filter((v) => v.stationToStation)

    for (const variant of stationToStation) {
      const built = buildSummary(variant, entry, crsIndex)
      if (!built) continue
      const { summary, displayName, baseDisplayName } = built
      // Each walk attaches ONLY to its starting station in the public
      // overlay prose — a visitor lands on the walk's natural starting
      // point rather than seeing it duplicated on both ends. Circular
      // walks still appear once (start === end); walks whose end
      // station is the "more famous" stop are the main trade-off.
      // seenStations is kept to defensively dedupe in case a future
      // change re-introduces a secondary attachment key.
      const seenStations = new Set()
      for (const crs of [variant.startStation]) {
        if (!crs) continue
        const station = crsIndex.get(crs)
        if (!station) continue
        if (seenStations.has(station.coordKey)) continue
        seenStations.add(station.coordKey)
        urlsUsed.add(slug)

        if (!perStation.has(station.coordKey)) {
          perStation.set(station.coordKey, { name: station.name, ramblerParts: [] })
        }
        // kind: 0 = walk paragraph, 1 = free-form extra. Walks always
        // render before extras. Within walks, the sort order is defined
        // by compareRamblerParts — admins don't override it; all keys
        // come from the walk data itself (main/variant, komoot, rating,
        // distance).
        perStation.get(station.coordKey).ramblerParts.push({
          summary,
          kind: 0,
          ratingTier: ratingTierOf(variant.rating),
          hasKomoot: !!variant.komootUrl,
          isMain: (variant.source?.type ?? variant.role) === "main",
          distanceScore: distanceScore(variant.distanceKm),
          pageTitle: entry.title ?? "",
          // Title pieces feed the duplicate-variant filter below —
          // variants whose `baseDisplayName` (title minus suffix)
          // matches another walk's full `displayName` at this same
          // station are hidden from the public-prose output.
          displayName,
          baseDisplayName,
        })

        // Aggregate this variant's structured bestSeasons into the
        // station's derived season set. Walks without month codes don't
        // contribute — they simply don't flow into the seasonality filters.
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

        // Track stations with at least one personally-walked variant.
        // Any non-empty previousWalkDates flips the station from
        // "undiscovered" to "hiked" in the derived output.
        if (Array.isArray(variant.previousWalkDates) && variant.previousWalkDates.length > 0) {
          perStationHiked.add(station.coordKey)
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
      perStation.get(coordKey).ramblerParts.push({
        summary: line,
        kind: 1, // extras sort below walks
        ratingTier: Number.POSITIVE_INFINITY,
        hasKomoot: false,
        isMain: false,
        distanceScore: Number.POSITIVE_INFINITY,
        pageTitle: "",
        // Extras (free-form notes) have no title, so no duplicate-
        // filter role. Leaving these empty is equivalent to "never
        // matches any other walk's displayName".
        displayName: "",
        baseDisplayName: "",
      })
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
    const ordered = [...ramblerParts].sort(compareRamblerParts)
    const ramblerNote = ordered.map((p) => p.summary).join("\n\n")
    // Public visibility rules (admin always sees the full list):
    //   • Mains are always shown.
    //   • Notes (free-form extras, kind=1) are always shown.
    //   • Bus-requiring walks never reach this filter — they're
    //     excluded upstream by `stationToStation !== true`, which
    //     buildSummary returns null for. (Admin CMS still shows them.)
    //   • Variants (non-main walks) are shown ONLY when there is
    //     exactly 1 main walk at this station — variants act as
    //     supplementary detail on pages dominated by a single walk.
    //     Stations with 0 mains (rare) or 2+ mains get no variants
    //     in the public prose at all.
    const mainCount = ordered.filter((p) => p.kind === 0 && p.isMain).length
    const publicParts = ordered.filter((p) => {
      if (p.kind !== 0) return true // notes always pass
      if (p.isMain) return true // mains always pass
      // Variant — only permitted when there's a lone main to sit next to.
      return mainCount === 1
    })
    const publicRamblerNote = publicParts.map((p) => p.summary).join("\n\n")
    if (notes[coordKey]) {
      const before = notes[coordKey].ramblerNote
      notes[coordKey].ramblerNote = ramblerNote
      notes[coordKey].publicRamblerNote = publicRamblerNote
      // Drop the legacy sidecar field from the earlier "mainCount"
      // rule so it doesn't linger in the JSON.
      if ("ramblerMainCount" in notes[coordKey]) delete notes[coordKey].ramblerMainCount
      if (before !== ramblerNote) changes.updated++
    } else {
      notes[coordKey] = { name, publicNote: "", privateNote: "", ramblerNote, publicRamblerNote }
      changes.added++
    }
  }

  for (const [coordKey, entry] of Object.entries(notes)) {
    if (perStation.has(coordKey)) continue
    if (entry.ramblerNote) {
      entry.ramblerNote = ""
      entry.publicRamblerNote = ""
      changes.cleared++
    }
    // Tidy up the legacy sidecar field left behind by the earlier
    // "mainCount-based" visibility rule. No longer read by the client.
    if ("ramblerMainCount" in entry) delete entry.ramblerMainCount
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
      const orderedSample = [...ramblerParts].sort(compareRamblerParts)
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

  // ── Derived file: stations-hiked.json ──────────────────────────────
  // Sorted array of coordKeys for stations we've personally walked at
  // least one attached walk from. The client fetches this into a Set<string>
  // and the "Undiscovered" admin filter hides anything in it.
  const hikedOut = [...perStationHiked].sort()
  writeFileSync(HIKED_PATH, JSON.stringify(hikedOut, null, 2) + "\n", "utf-8")
  // eslint-disable-next-line no-console
  console.log(`Wrote ${hikedOut.length} entries to ${HIKED_PATH}`)

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
