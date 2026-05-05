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
const NOTES_PATH = join(PROJECT_ROOT, "data", "station-notes.json")
const STATIONS_PATH = join(PROJECT_ROOT, "public", "stations.json")
// Synthetic-cluster topology — read from lib/clusters-data.json so this
// .mjs script and the .ts client both share one definition. The JSON
// holds a unified CLUSTERS map keyed by anchor coord; we derive the
// legacy primary/friend/displayName shapes here so the rest of this
// script (which predates the unified shape) stays unchanged.
const CLUSTERS_PATH = join(PROJECT_ROOT, "lib", "clusters-data.json")
const { CLUSTERS } = JSON.parse(readFileSync(CLUSTERS_PATH, "utf-8"))
const PRIMARY_ORIGIN_CLUSTER = Object.fromEntries(
  Object.entries(CLUSTERS).filter(([, d]) => d.isPrimaryOrigin).map(([k, d]) => [k, d.members]),
)
const FRIEND_ORIGIN_CLUSTER = Object.fromEntries(
  Object.entries(CLUSTERS).filter(([, d]) => d.isFriendOrigin).map(([k, d]) => [k, d.members]),
)
const SYNTHETIC_DISPLAY_NAMES = Object.fromEntries(
  Object.entries(CLUSTERS).map(([k, d]) => [k, d.displayName]),
)
// Every cluster's members keyed by anchor — used by the synthetic
// aggregation pass so destination-only clusters (no origin flags)
// also get their members' walks rolled up under the anchor.
const ALL_CLUSTER_MEMBERS = Object.fromEntries(
  Object.entries(CLUSTERS).map(([k, d]) => [k, d.members]),
)
// Organisation registry — slug → { name, url }. Used to render the
// human-readable "<Org> walk" link text in the relatedSource clause.
const SOURCES_PATH = join(PROJECT_ROOT, "data", "sources.json")
// Derived file: per-station month-code arrays ("jan" | "feb" | …) for the
// month dropdown + "[current-month] highlights" checkbox in the filter
// panel. Purely an output of this script — aggregated from each walk
// variant's structured `bestSeasons` month codes (the field name on the
// walk record is historical — content is and always was month codes).
const MONTHS_PATH = join(PROJECT_ROOT, "data", "station-months.json")
// Derived file: sorted array of coordKeys for stations that have a Komoot
// route AND have month data on at least one ADMIN-ONLY walk AND no month
// data on any publicly-visible walk. Drives the admin-only "Potential
// month data" feature filter — surfaces destinations where the public
// walks could inherit month metadata that's currently buried on an
// admin-only variant.
const POTENTIAL_MONTHS_PATH = join(PROJECT_ROOT, "data", "stations-potential-months.json")

// Derived list of stations where at least one attached walk has a
// populated `previousWalkDates` array — i.e. we've personally walked
// it. Drives the admin-only "Undiscovered" filter, which inverts the
// match to surface destinations still to explore.
const HIKED_PATH = join(PROJECT_ROOT, "data", "stations-hiked.json")

// Derived list of stations where at least one attached walk has a
// non-empty `komootUrl`. Drives the admin-only "Komoot" filter, which
// surfaces destinations that already have a Komoot tour wired up.
const KOMOOT_PATH = join(PROJECT_ROOT, "data", "stations-with-komoot.json")

// Derived index of stations grouped by source organisation. Shape:
// { [orgSlug]: string[] } where the value is a sorted array of
// coordKeys. Drives the admin-only "Source" filter, which keeps only
// stations with at least one attached walk whose source.orgSlug or
// relatedSource.orgSlug matches the picked org. Considers ALL walks
// (including non-stationToStation), since the filter is admin-only and
// non-public walks still belong to a station for curation purposes.
const STATIONS_BY_SOURCE_PATH = join(PROJECT_ROOT, "data", "stations-by-source.json")

// Month codes used in each variant's structured `bestSeasons` field.
// Order matters — renders in calendar order regardless of how the source
// data lists them. Also drives station-level month aggregation for the
// filter UI (calendar order in the JSON output).
const MONTH_ORDER = ["jan","feb","mar","apr","may","jun","jul","aug","sep","oct","nov","dec"]
// Title-case three-letter abbreviations. Keeps the rendered "Best in …"
// clause compact — "Best in Oct–Jan" reads faster than "Best in October
// to January". "May" stays 3 letters since the full name is already short.
const MONTH_FULL = {
  jan: "Jan", feb: "Feb", mar: "Mar", apr: "Apr",
  may: "May", jun: "Jun", jul: "Jul", aug: "Aug",
  sep: "Sep", oct: "Oct", nov: "Nov", dec: "Dec",
}

// Rating tier mapping used to sort walks at a station. Lower value =
// higher in the rendered list. Any explicit rating — including 1
// (Flawed) — beats unrated, on the principle that a reviewed walk
// carries more signal than one we haven't looked at yet. Mirror of
// the constant in app/api/dev/walks-for-station/route.ts — keep in
// sync.
const RATING_TIER = { 4: 0, 3: 1, 2: 2, 1: 3, unrated: 4 }
function ratingTierOf(rating) {
  if (typeof rating !== "number") return RATING_TIER.unrated
  const key = Math.round(rating)
  return RATING_TIER[key] ?? RATING_TIER.unrated
}

// Ideal walk length for ordering — proximity to this value is the
// distance sort key. Tweak to shift the bias (e.g. 13 prefers a
// full-day hike, 8 a half-day stroll). Keep in sync with
// IDEAL_LENGTH_KM in app/api/dev/walks-for-station/route.ts.
const IDEAL_LENGTH_KM = 13

// Distance score — |distanceKm - IDEAL_LENGTH_KM|. Closer to ideal
// sorts higher; walks without a recorded distance fall to the
// bottom of their tier (Infinity).
function distanceScore(distanceKm) {
  if (typeof distanceKm !== "number" || !Number.isFinite(distanceKm)) {
    return Number.POSITIVE_INFINITY
  }
  return Math.abs(distanceKm - IDEAL_LENGTH_KM)
}


// Order ramblerParts at a station:
//   1. hasKomoot DESC (walks with a Komoot route come first)
//   2. sectionPriority ASC (circular → S2S-starting → S2S-ending —
//                           groups paragraphs of the same section
//                           together within the admin's full prose)
//   3. isMain DESC (main walks first; non-mains don't get a
//                   further subtype ordering among themselves)
//   4. ratingTier ASC (4 on top, then 3, 2, 1, unrated)
//   5. distanceScore ASC (closest to IDEAL_LENGTH_KM first; missing
//                         sorts last)
//   6. pageTitle ASC for stable alphabetic tiebreak
// The bus key from the unified spec is omitted here because every
// part already has stationToStation === true (bus walks are filtered
// upstream at line ~719) — adding it would be a no-op.
// Mirrors the CMS sort in app/api/dev/walks-for-station/route.ts —
// keep both in step.
function sectionPriority(p) {
  if (p.isCircular) return 0
  return p.role === "starting" ? 1 : 2
}
function compareRamblerParts(a, b) {
  if (a.hasKomoot !== b.hasKomoot) return a.hasKomoot ? -1 : 1
  const sa = sectionPriority(a), sb = sectionPriority(b)
  if (sa !== sb) return sa - sb
  if (a.isMain !== b.isMain) return a.isMain ? -1 : 1
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

// coordKey → station ID (CRS for real stations, C-prefix synthetic
// for cluster anchors). Mirrors lib/station-registry.ts's coord→id
// logic so this Node script doesn't need the TS module. Used at
// output time to convert internally-coord-keyed maps into the
// ID-keyed JSON files the runtime now expects.
function buildCoordToId() {
  const stations = JSON.parse(readFileSync(STATIONS_PATH, "utf-8"))
  const map = new Map()
  for (const f of stations.features) {
    const crs = f.properties?.["ref:crs"]
    const [lng, lat] = f.geometry?.coordinates ?? []
    if (crs && lng != null && lat != null) map.set(`${lng},${lat}`, crs)
  }
  // Cluster anchors — read directly from clusters-data.json (Phase 2e
  // shape: keys are C-prefix synthetic IDs, each entry has a `coord`
  // centroid).
  const clusters = JSON.parse(readFileSync(join(PROJECT_ROOT, "lib/clusters-data.json"), "utf-8")).CLUSTERS
  for (const [id, def] of Object.entries(clusters)) {
    map.set(def.coord, id)
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
  // Auto-capitalise the first item so admin-entered lowercase renders
  // as a proper sentence opener in the walk prose.
  items[0] = items[0][0].toUpperCase() + items[0].slice(1)
  if (items.length === 1) return `${items[0]}.`
  if (items.length === 2) return `${items[0]} and ${items[1]}.`
  return `${items.slice(0, -1).join(", ")}, and ${items[items.length - 1]}.`
}

// "Last reviewed {date}." — italicised sentence sourced from the
// variant's previousWalkDates log. Picks the most recent valid ISO
// date and formats it UK-style ("13 May 2022"). Returns null when
// the array is missing/empty/all garbage so the caller can skip it
// cleanly.
//
// Date formatting is hand-rolled rather than via Intl.DateTimeFormat
// to avoid environment-specific locale fallbacks — UK month names
// are stable and short to enumerate.
const MONTH_NAMES = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
]
function formatLastReviewed(dates) {
  if (!Array.isArray(dates) || dates.length === 0) return null
  // Pick the latest valid YYYY-MM-DD entry. ISO sorts lexically, so
  // a string sort gives us chronological order without parsing.
  const valid = dates
    .filter((d) => typeof d === "string" && /^\d{4}-\d{2}-\d{2}$/.test(d))
    .sort()
  if (valid.length === 0) return null
  const latest = valid[valid.length - 1]
  const [yyyy, mm, dd] = latest.split("-").map((p) => parseInt(p, 10))
  // Bail on out-of-range months — defensive, since the regex already
  // matches digits but a "13" or "00" could slip through.
  if (mm < 1 || mm > 12) return null
  // No leading zero on day; "13 May 2022" not "13 May 2022".
  return `*Last reviewed ${dd} ${MONTH_NAMES[mm - 1]} ${yyyy}.*`
}

// Distance in km, rounded DOWN, with a space before "km". Miles are
// intentionally dropped — keeps the trailing stats compact.
function formatDistance(km) {
  if (typeof km !== "number") return null
  return `${Math.floor(km)} km`
}

// Uphill in metres, rounded DOWN to the nearest 10 m.
function formatUphill(metres) {
  if (typeof metres !== "number" || !Number.isFinite(metres)) return null
  const rounded = Math.floor(metres / 10) * 10
  if (rounded <= 0) return null
  return `${rounded} m uphill`
}

// Hours round to nearest 30 minutes with ties going UP (4.25 → 4.5, 4.75 → 5).
function formatHours(hours) {
  if (typeof hours !== "number") return null
  const rounded = Math.floor(hours * 2 + 0.5) / 2
  return `${rounded} hours`
}

// Difficulty — capitalised one-word sentence.
function formatDifficulty(difficulty) {
  if (typeof difficulty !== "string") return null
  const lower = difficulty.toLowerCase()
  if (lower === "easy") return "Easy"
  if (lower === "moderate") return "Moderate"
  if (lower === "hard") return "Hard"
  return null
}

// Oxford-style "or" join used for both venue items inside a group and
// for the groups themselves. 1 item → unchanged; 2 items → "A, or B"
// (note: comma before "or" even on 2-item joins, per the project's
// preferred Oxford convention, NOT the strict-Oxford-only-on-3+ rule);
// 3+ items → "A, B, …, or Z".
function joinWithOr(items) {
  if (items.length <= 1) return items[0] ?? ""
  return items.slice(0, -1).join(", ") + ", or " + items[items.length - 1]
}

// Format a single lunch-stop venue (the inner item — no "in {location}"
// suffix; that's handled at group level so multiple venues at the same
// location share one clause). Strips a leading "the/The" from the name
// because we always prepend a lowercase "the " ourselves; produces
// "the [Gun Inn](url) (charming; reservations recommended)" etc.
// Stored rating ("poor"/"fine"/"good") → public prose phrase. "poor"
// reads as a soft warning, "fine" as faint praise, "good" as a clear
// recommendation. Anything else (unset, unexpected) → no rating bit
// in the parens.
const RATING_PHRASES = {
  poor: "not great",
  fine: "not bad",
  good: "very nice",
}
function ratingPhrase(rating) {
  return typeof rating === "string" ? RATING_PHRASES[rating] ?? "" : ""
}

function formatLunchVenue(s) {
  const cleanedName = s.name.replace(/^the\s+/i, "")
  const linked = s.url ? `[${cleanedName}](${s.url})` : cleanedName
  const base = `the ${linked}`
  // Parenthetical bits, in order: rating phrase → admin notes →
  // "reservations recommended". Rating comes first so the reader
  // gets the qualitative tier ("not bad", "very nice") before the
  // free-text colour. Joined with "; " so a venue with all three
  // reads "(very nice; charming; reservations recommended)".
  // Strip trailing "." and "?" from notes so they merge cleanly into
  // the surrounding sentence, but PRESERVE "!" — exclamation marks
  // carry tone the admin chose deliberately ("(lovely!)").
  const note = typeof s.notes === "string" ? s.notes.trim().replace(/[.?]+$/, "") : ""
  const rating = ratingPhrase(s.rating)
  const reservations = s.busy === "busy" ? "reservations recommended" : ""
  const parens = [rating, note, reservations].filter(Boolean).join("; ")
  return parens ? `${base} (${parens})` : base
}

// Lunch-stop list, grouped by location. Returns the full prose (one
// or more sentences) — caller pushes the result into the parts array
// as-is.
//
// One location:
//   "Lunch in Sandridge: the Heartwood Tearooms (lovely!), the Green
//    Man (okay), or the Magpie."
//
// Multiple locations — header sentence listing the locations, then a
// sentence per group:
//   "Lunch in Sandridge, Westhumble, or East Humbling. Sandridge
//    lunch stops: the Heartwood Tearooms (lovely!), the Green Man
//    (okay), or the Magpie. Westhumble lunch stop: the Dead Dog. East
//    Humbling lunch stops: the Axe & Crumbe, or Fairy's Demise
//    (reservations recommended)."
//
// Insertion order is preserved across groups (first-seen location
// keeps its slot). Venues with no location fall back to a flat
// "Lunch at A, or B." sentence (or appear under an "Other lunch
// stops:" trailing sentence in the multi-location case).
function formatLunchStops(stops) {
  if (!stops?.length) return null
  // Strip permanently-closed venues before grouping. An entire group
  // becoming empty is fine — joinWithOr handles the resulting array
  // shape — and an empty overall list returns null below.
  stops = stops.filter(isLive)
  if (stops.length === 0) return null
  const groups = new Map() // location → venue strings (preserves order)
  const noLoc = []
  for (const s of stops) {
    const venue = formatLunchVenue(s)
    const loc = s.location?.trim()
    if (loc) {
      if (!groups.has(loc)) groups.set(loc, [])
      groups.get(loc).push(venue)
    } else {
      noLoc.push(venue)
    }
  }
  const locatedGroups = [...groups.entries()] // [[loc, venues], …]
  const totalGroupCount = locatedGroups.length + (noLoc.length ? 1 : 0)

  // Single-group case — one sentence.
  if (totalGroupCount === 1) {
    if (locatedGroups.length === 1) {
      const [loc, venues] = locatedGroups[0]
      return `Lunch in ${loc}: ${joinWithOr(venues)}.`
    }
    // No location info on any stop — fall back to flat phrasing so
    // pre-existing data without locations still reads as a sentence.
    return `Lunch at ${joinWithOr(noLoc)}.`
  }

  // Multi-group case — header + one sentence per group.
  const sentences = []
  // Header lists only the located groups (unlocated venues are
  // covered by the trailing "Other lunch stop(s):" sentence). If
  // there's only one located group plus an unlocated bucket, the
  // header still mentions the located group in case the admin scans
  // it; the unlocated bucket falls under "Other".
  const headerLocations = locatedGroups.map(([loc]) => loc)
  if (headerLocations.length > 0) {
    sentences.push(`Lunch in ${joinWithOr(headerLocations)}.`)
  }
  for (const [loc, venues] of locatedGroups) {
    const label = venues.length === 1 ? `${loc} lunch stop` : `${loc} lunch stops`
    sentences.push(`${label}: ${joinWithOr(venues)}.`)
  }
  if (noLoc.length) {
    const label = noLoc.length === 1 ? "Other lunch stop" : "Other lunch stops"
    sentences.push(`${label}: ${joinWithOr(noLoc)}.`)
  }
  return sentences.join(" ")
}

// Destination-pub list. Same data shape as lunch stops, but the prose
// convention differs: the location is implicit (the walk destination),
// so we don't render "in {location}" or prepend "the ". The venue name
// is rendered as-is — including any leading "The" — because the typical
// sentence reads "End-of-walk rests: The Queens Head."
//
// URLs (when present) wrap the name as a markdown link, mirroring the
// lunch-stop formatter. Optional admin notes go in trailing parens.
function formatDestinationStops(stops) {
  if (!stops?.length) return null
  stops = stops.filter(isLive)
  if (stops.length === 0) return null
  const fmts = stops.map((s) => {
    const linked = s.url ? `[${s.name}](${s.url})` : s.name
    // Parenthetical bits, same order + helper as formatLunchVenue:
    // rating phrase → notes → "reservations recommended". Rating
    // first so the reader gets the qualitative tier before the
    // free-text colour. Joined with "; " so a venue with all three
    // reads "(very nice; charming; reservations recommended)".
    // Strip trailing "." and "?" from notes so they merge cleanly into
    // the surrounding sentence, but PRESERVE "!" — exclamation marks
    // carry tone the admin chose deliberately ("(lovely!)").
    const note = typeof s.notes === "string" ? s.notes.trim().replace(/[.?]+$/, "") : ""
    const rating = ratingPhrase(s.rating)
    const reservations = s.busy === "busy" ? "reservations recommended" : ""
    const parens = [rating, note, reservations].filter(Boolean).join("; ")
    return parens ? `${linked} (${parens})` : linked
  })
  return joinWithOr(fmts)
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
//   similar     → "Similar to [Page](url)."
//   adapted     → "Adapted from [Page](url)."
//
// Capitalised at sentence start (follows the opening colon). Returns
// null only if the walk has no identifiable source — in practice this
// never fires post-backfill, but the build script stays defensive.
// Some sources are books rather than per-walk web pages — there's
// no pageURL to link to, so the source clause renders against the
// org-level name/URL from sources.json instead. Detected by slug
// prefix for now (extend the check when we add more book sources).
function isBookSource(orgSlug) {
  if (typeof orgSlug !== "string") return false
  return orgSlug.startsWith("rough-guide-") || orgSlug.startsWith("time-out-country-walks-")
}

function formatSourceClause(variant, entry, sources) {
  const type = variant.source?.type ?? variant.role ?? "main"
  const orgSlug = variant.source?.orgSlug
  // Book sources (e.g. the Rough Guide series) have no per-walk URL,
  // so the link target is the publisher's landing page from
  // sources.json and the link text is the book's title.
  if (isBookSource(orgSlug)) {
    const org = sources?.[orgSlug]
    if (!org?.name) return null
    const linked = org.url ? `[${org.name}](${org.url})` : org.name
    const phrase = type === "main" ? "From" : variantPhrase(type)
    return `${phrase} ${linked}.`
  }
  // Web-page sources — prefer structured source info, falling back
  // to entry-level fields for walks that predate the source backfill.
  const pageName = variant.source?.pageName ?? entry.title
  const pageURL = variant.source?.pageURL ?? entry.url
  if (!pageName || !pageURL) return null
  const phrase = type === "main" ? "From" : variantPhrase(type)
  return `${phrase} [${pageName}](${pageURL}).`
}

// Per-type prefix shared between formatSourceClause (web sources +
// book sources) and the relatedSource clause. Kept tight so the
// switch arms stay terse at each call site.
function variantPhrase(type) {
  switch (type) {
    case "shorter":     return "A shorter variant of"
    case "longer":      return "A longer variant of"
    case "alternative": return "An alternative variant of"
    case "variant":     return "A variant of"
    case "similar":     return "Similar to"
    case "adapted":     return "Adapted from"
    default:            return "From"
  }
}

// Sights: "[Lacey Green Windmill](URL), Roald Dahl Museum, and [Hastings Castle](URL)".
// No "or" — sights aren't alternatives, they're all worth seeing.
// Oxford comma + "and" before the last item, matching the terrain-tag
// formatter's style so the rendered prose reads consistently.
// Drop venues Google has flagged as permanently closed before any
// downstream rendering touches them — keeps closed places out of the
// public prose without needing to remove the row from the JSON.
function isLive(s) {
  return s?.businessStatus !== "CLOSED_PERMANENTLY"
}

function formatSights(sights) {
  if (!Array.isArray(sights) || sights.length === 0) return null
  sights = sights.filter(isLive)
  if (sights.length === 0) return null
  const items = sights.map((s) => {
    const linked = s.url ? `[${s.name}](${s.url})` : s.name
    // Optional descriptive blurb — surfaces in parentheses after the
    // sight's name so a reader gets a one-line gloss without leaving
    // the prose. Trimmed of any trailing sentence punctuation so the
    // outer comma/period flow stays natural.
    const desc = typeof s.description === "string" ? s.description.trim().replace(/[.!?]+$/, "") : ""
    return desc ? `${linked} (${desc})` : linked
  })
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
  if (!trimmed) return ""
  return `${trimmed[0].toUpperCase()}${trimmed.slice(1)}.`
}

// Compose the markdown string for one walk variant attached to a station.
// Structure (each clause omitted if the source field is empty):
//
//   <opener><fav><terrain> <sights sentence><miscellany><trainTips><bestSeasons><lunch><km><hours>
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

function buildSummary(variant, entry, crsIndex, sources) {
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
  // Title linking rule: ONLY main walks link the title, and ONLY to
  // their OWN main source URL (variant.source.pageURL). Variants
  // (shorter / longer / alternative / similar / adapted / variant)
  // NEVER link the title — their provenance is carried in the
  // "A shorter variant of [X](url)." clause that emits right after.
  // The title also never links to the related source URL or to
  // entry.url. Both of those are easy to mistake for a "main source"
  // in legacy data: entry.url is a holdover from when the entry was
  // originally scraped from a single page, so for an admin-created
  // T2G walk hung under a scraped-page slug, entry.url effectively
  // IS the related source URL. Linking the title to either would be
  // wrong. When variant.source.pageURL is empty, the title stays
  // plain text — even for main walks.
  const sourceType = variant.source?.type ?? variant.role ?? "main"
  const isMain = sourceType === "main"
  // Title-link target. For book sources we deliberately skip the
  // pageURL too — book entries don't have per-walk URLs and book
  // attribution flows through the dedicated source clause instead.
  const ownSourceUrl = typeof variant.source?.pageURL === "string" ? variant.source.pageURL.trim() : ""
  const sourceUrl = isBookSource(variant.source?.orgSlug) ? null : (ownSourceUrl || null)

  let opening
  if (isMain && sourceUrl) {
    opening = `**[${displayName}](${sourceUrl})**:`
  } else {
    opening = `**${displayName}**:`
  }

  const parts = [opening]

  // Source clause for WEB sources sits right after the title.
  //  - non-main walks always emit ("A shorter variant of [X](url).")
  //  - main walks skip it (the title is already linked to the source).
  // Book sources (Rough Guide etc) defer to a clause emitted AFTER
  // distance — see further down. They're handled separately because
  // a book attribution reads more naturally as a closing footnote
  // than as an opening clause.
  const orgIsBook = isBookSource(variant.source?.orgSlug)
  if (!orgIsBook && (!isMain || !sourceUrl)) {
    const sourceClause = formatSourceClause(variant, entry, sources)
    if (sourceClause) parts.push(sourceClause)
  }

  // Rambler-favourite flourish now keys off the walk's own rating.
  // Historic behaviour fired on the entry-level `favourite` flag,
  // which applied to every variant of a starred page; the rating
  // lives per-variant so individual variants can be singled out.
  // Threshold: rating >= 3 (backfill starts favourites at 3).
  // Top-tier walks (rating 4) get a stronger Trains-to-Green
  // endorsement; rating-3 walks fall back to the legacy
  // "Rambler favourite!" flourish.
  if (variant.rating === 4) {
    parts.push("An essential walk!")
  } else if (typeof variant.rating === "number" && variant.rating >= 3) {
    parts.push("Rambler favourite!")
  }

  // Optional admin-authored sentence anchored to the rating-flourish
  // slot. When a flourish exists ("Rambler favourite!" / "An
  // essential walk!") this sits right after it; otherwise it
  // becomes the first sentence after the colon. Always emitted
  // regardless of rating — even rating-1 walks can carry a caveat
  // (e.g. "Epic scenery sadly ruined by the constant drone of the
  // M25"). Stored without a trailing period; withPeriod() tacks
  // one on so callers don't need to remember it.
  if (
    typeof variant.ratingExplanation === "string" &&
    variant.ratingExplanation.trim() !== ""
  ) {
    parts.push(withPeriod(variant.ratingExplanation.trim()))
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
  // free-text `miscellany` doesn't mention mud anywhere (avoid duplicates
  // like "Can be muddy. Can be muddy." when both the structured flag
  // and a legacy mud sentence are present). Once the free-text mud
  // sentences are pruned in a follow-up pass, this check becomes moot.
  const miscellanyText = variant.miscellany?.trim() ?? ""
  const miscellanyMentionsMud = /\bmud/i.test(miscellanyText)
  if (variant.mudWarning && !miscellanyMentionsMud) parts.push("Can be muddy.")

  // Free-text miscellany — one ultra-short clause (for anything not
  // captured by the structured mudWarning flag, e.g. MOD closures, or
  // other miscellaneous notes about the walk).
  if (miscellanyText) parts.push(withPeriod(miscellanyText))

  // Train tips — booking advice (singles vs returns, off-peak windows
  // etc). Sits immediately after miscellany so practical "before you go"
  // info is grouped together in the prose.
  const trainTipsText = variant.trainTips?.trim() ?? ""
  if (trainTipsText) parts.push(withPeriod(trainTipsText))

  // Best seasons — the structured month-code array. Legacy free-text
  // bestTime has been migrated into miscellany and the field removed.
  const structuredSeasons = formatBestSeasons(variant.bestSeasons)
  if (structuredSeasons) parts.push(structuredSeasons)

  // Lunch — admin override (free text) takes precedence over the
  // structured lunchStops list. Override rendered verbatim (with
  // trailing period). Otherwise formatLunchStops returns the full
  // prose (one or more sentences, headers and all), so we push it
  // as-is rather than wrapping it.
  const lunchOverride = typeof variant.lunchOverride === "string" ? variant.lunchOverride.trim() : ""
  if (lunchOverride) {
    parts.push(withPeriod(lunchOverride))
  } else {
    const lunch = formatLunchStops(variant.lunchStops)
    if (lunch) parts.push(lunch)
  }

  // End-of-walk rests — venues at or near the route's end. Same
  // override-beats-list rule as lunch. Uses its own formatter because
  // the prose convention differs from lunch: no "in {Location}", just
  // the venue name(s) since the destination is implicit. Header is
  // always "End-of-walk rests:" — no singular/plural variant, the
  // colon construction reads naturally with one or many.
  const destinationStopsOverride = typeof variant.destinationStopsOverride === "string" ? variant.destinationStopsOverride.trim() : ""
  if (destinationStopsOverride) {
    parts.push(withPeriod(destinationStopsOverride))
  } else {
    const dest = formatDestinationStops(variant.destinationStops)
    if (dest) parts.push(`End-of-walk rests: ${dest}.`)
  }

  // Book source clause — emitted before distance so the book
  // attribution reads as a lead-in to the trailing stats rather than
  // trailing them. Only fires for book-style orgSlugs (Rough Guide
  // etc); web sources were already handled above.
  if (orgIsBook) {
    const bookClause = formatSourceClause(variant, entry, sources)
    if (bookClause) parts.push(bookClause)
  }

  // Related source is intentionally NOT rendered in public prose —
  // it stays admin-only as a cross-reference inside the editor. The
  // formatter still exists for any admin-side surfaces that want it.

  // "Last reviewed {date}." — italicised, sits just before the
  // distance/time stats. Sourced from variant.previousWalkDates (the
  // admin-tracked log of when this walk was personally completed);
  // we pick the LATEST date and format it "13 May 2022" UK-style.
  // Skipped when the array is empty / missing.
  const reviewSentence = formatLastReviewed(variant.previousWalkDates)
  if (reviewSentence) parts.push(reviewSentence)

  // Distance, uphill, hours, difficulty — each their own sentence.
  // Always emitted when present, including alongside a Komoot route
  // (the "Pull data" admin button keeps the structured fields in
  // sync with the Komoot tour, so they no longer disagree).
  const dist = formatDistance(variant.distanceKm)
  if (dist) parts.push(`${dist}.`)
  const uphill = formatUphill(variant.uphillMetres)
  if (uphill) parts.push(`${uphill}.`)
  const time = formatHours(variant.hours)
  if (time) parts.push(`${time}.`)
  const diff = formatDifficulty(variant.difficulty)
  if (diff) parts.push(`${diff}.`)

  // GPX file — entry-level (applies to the whole page, not per
  // variant). Renders as a trailing "[GPX file](URL)." clause so the
  // admin/user can grab the track for use in their own map tools.
  // Only sources that expose a stable GPX URL (currently Leicester
  // Ramblers) populate this — SWC and Heart entries leave it unset.
  if (entry.gpx) parts.push(`[GPX file](${entry.gpx}).`)

  // Komoot tour link — per-variant. Different variants of the same
  // page can each have their own route, so this lives on the walk
  // variant rather than the entry.
  if (variant.komootUrl) parts.push(`**[Komoot route →](${variant.komootUrl})**`)

  // Return the rendered string PLUS the title pieces — callers need
  // `displayName` / `baseDisplayName` to run the duplicate-variant
  // filter without re-implementing the derivation logic.
  return { summary: parts.join(" "), displayName, baseDisplayName }
}

// ── Main build ─────────────────────────────────────────────────────────────

// Load the primary walks dataset plus any extras, merging by slug.
// Extras override primary on slug collision — that's intentional so
// future sources can patch specific entries if needed.
//
// `overrideWalks` (optional): Map<absolutePath, walksObject>. When the
// API-route caller has just-mutated walk data in memory that hasn't
// been flushed to disk yet (e.g. mid-DELETE/PATCH), it passes the
// new content here so the rebuild reflects the in-flight change
// instead of re-reading the stale on-disk version. Without this,
// derived files end up one-save behind the source file.
function loadAllWalks(overrideWalks) {
  const readOrOverride = (path) => overrideWalks?.get(path) ?? JSON.parse(readFileSync(path, "utf-8"))
  const merged = readOrOverride(WALKS_PATH)
  for (const path of EXTRA_WALKS_PATHS) {
    try {
      const extra = overrideWalks?.has(path) ? overrideWalks.get(path) : JSON.parse(readFileSync(path, "utf-8"))
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
  const walks = loadAllWalks(args?.overrideWalks)
  // overrideNotes: same rationale as overrideWalks — the API-route
  // caller already has a fresh copy of station-notes.json (fetched
  // from GitHub on serverless, where the local fs is the deploy-time
  // snapshot). Deep-cloned because the build mutates `notes` in place
  // (preserves admin-authored publicNote/privateNote, rewrites the
  // prose fields), and we don't want to scribble on the caller's copy.
  // station-notes.json is keyed by station ID (CRS or 4-char synthetic)
  // post Phase 2b. The build pipeline below was written against the
  // older coordKey-keyed shape, so convert at read-time into a
  // coord-keyed working copy. We translate back to IDs once at write/
  // return time. This keeps the internal logic ID-agnostic.
  const coordToId = buildCoordToId()
  const idToCoord = new Map([...coordToId.entries()].map(([c, i]) => [i, c]))
  const notesById = args?.overrideNotes
    ? structuredClone(args.overrideNotes)
    : JSON.parse(readFileSync(NOTES_PATH, "utf-8"))
  const notes = {}
  for (const [id, entry] of Object.entries(notesById)) {
    const coord = idToCoord.get(id)
    if (coord) notes[coord] = entry
    // Entries whose ID isn't in the registry are dropped here — same
    // behavior as the audit script's check. If this ever surfaces in
    // practice, fix the registry, not the build.
  }
  const crsIndex = buildCrsIndex()
  // sources.json — organisation registry. Loaded once here and threaded
  // into buildSummary so the relatedSource clause can render
  // "<Org> walk" link text without each call re-reading from disk.
  const sources = JSON.parse(readFileSync(SOURCES_PATH, "utf-8"))

  // coordKey → { name, ramblerParts[] }
  const perStation = new Map()
  // coordKey → Set<MonthCode>. Accumulated across every attached walk
  // variant. Written out to data/station-months.json at the end —
  // derived data, never hand-edited.
  const perStationMonths = new Map()
  // coordKey → true. Any station whose attached walks include at least
  // one variant with a non-empty `previousWalkDates` array. Written to
  // data/stations-hiked.json as a sorted array; the admin "Undiscovered"
  // filter hides these to surface the stations still to visit.
  const perStationHiked = new Set()
  // coordKey → true. Any station whose attached walks include at least
  // one variant with a non-empty `komootUrl`. Written to
  // data/stations-with-komoot.json as a sorted array; the admin "Komoot"
  // filter keeps only these.
  const perStationKomoot = new Set()
  // coordKey → true. Stations matching the "Potential month data"
  // criteria: has a Komoot route, no month data on publicly-visible
  // walks, but at least one admin-only variant carries month codes.
  // Populated in the per-station rendering loop below (after public-
  // tier filtering). Written to data/stations-potential-months.json.
  const perStationPotentialMonths = new Set()
  // coordKey → Set<orgSlug>. Aggregated from every variant's
  // source.orgSlug AND relatedSource.orgSlug (both contribute), across
  // ALL walks (including non-s2s). Pivoted into { orgSlug: coordKey[] }
  // at write-time and shipped to data/stations-by-source.json. Drives
  // the admin-only "Source" dropdown.
  const perStationSourceOrgs = new Map()
  // Track which walk URLs contributed at least one summary — used for
  // --flip-on-map to mark onMap:true in rambler-walks.json.
  const urlsUsed = new Set()
  const urlsConsidered = new Set()

  for (const [slug, entry] of Object.entries(walks)) {
    if (!entry.extracted) continue
    if (entry.outsideMainlandBritain) continue
    if (!Array.isArray(entry.walks) || entry.walks.length === 0) continue
    urlsConsidered.add(slug)

    // Source-org index. Iterates EVERY variant on the page (not just
    // s2s) and records orgSlugs from BOTH source and relatedSource
    // against whichever station endpoints the variant touches. Runs
    // independently of the s2s/public pipeline so the admin "Source"
    // filter sees curation-only walks too (requires-bus, half-mainline,
    // etc.). Skipped silently when the station CRS isn't in crsIndex —
    // that's the same defensive fall-through used elsewhere in the
    // build, and avoids a hard failure if a walk references a
    // station that's been retired from public/stations.json.
    for (const variant of entry.walks) {
      const orgs = []
      const srcOrg = variant.source?.orgSlug
      const srcOk = typeof srcOrg === "string" && srcOrg.trim() !== ""
      if (srcOk) orgs.push(srcOrg.trim())
      const relOrg = variant.relatedSource?.orgSlug
      const relOk = typeof relOrg === "string" && relOrg.trim() !== ""
      if (relOk) orgs.push(relOrg.trim())
      // Sentinel "none" — record stations with at least one variant
      // missing BOTH source.orgSlug AND relatedSource.orgSlug. Drives
      // the admin "No source" dropdown option, which surfaces fully
      // unattributed walks (the orphans most likely to need fixing).
      if (!srcOk && !relOk) orgs.push("none")
      const seen = new Set()
      for (const crs of [variant.startStation, variant.endStation]) {
        if (!crs) continue
        const station = crsIndex.get(crs)
        if (!station) continue
        if (seen.has(station.coordKey)) continue
        seen.add(station.coordKey)
        let set = perStationSourceOrgs.get(station.coordKey)
        if (!set) {
          set = new Set()
          perStationSourceOrgs.set(station.coordKey, set)
        }
        for (const o of orgs) set.add(o)
      }
    }

    // Every station-to-station variant gets its own paragraph. We no
    // longer dedup by source URL: the automatic sort (komoot →
    // main-first → rating → distance) orders them and keeps the
    // reader from drowning in redundant siblings, and admins curate
    // via ratings/suffixes if they want any one walk demoted.
    const stationToStation = entry.walks.filter((v) => v.stationToStation)

    for (const variant of stationToStation) {
      const built = buildSummary(variant, entry, crsIndex, sources)
      if (!built) continue
      const { summary, displayName, baseDisplayName } = built
      // Each S2S walk attaches to BOTH its start and end stations so
      // the walk is discoverable from either endpoint. The `role`
      // field on each attachment ("starting" / "ending") drives the
      // public overlay's two sectioned headers ("…starting at X" vs
      // "…ending at X"). Circular walks (start === end) attach once
      // via the seenStations dedup and are always sectioned as
      // "Circular" regardless of role.
      const seenStations = new Set()
      for (const { crs, role } of [
        { crs: variant.startStation, role: "starting" },
        { crs: variant.endStation, role: "ending" },
      ]) {
        if (!crs) continue
        const station = crsIndex.get(crs)
        if (!station) continue
        if (seenStations.has(station.coordKey)) continue
        seenStations.add(station.coordKey)
        urlsUsed.add(slug)

        if (!perStation.has(station.coordKey)) {
          perStation.set(station.coordKey, { name: station.name, ramblerParts: [] })
        }
        // The sort order within walks is defined by compareRamblerParts —
        // admins don't override it; all keys come from the walk data
        // itself (main/variant, komoot, rating, distance).
        const sourceType = variant.source?.type ?? variant.role ?? "main"
        // Circular walks: same start and end station. The public view
        // splits walks into "Station-to-station" vs "Circular" sections;
        // each section applies its own 3-walks-per-section quota.
        const isCircular = !!variant.startStation && variant.startStation === variant.endStation
        perStation.get(station.coordKey).ramblerParts.push({
          // Stable walk identity — used to dedup parts in synthetic
          // aggregation when the same walk both starts AND ends inside
          // the same cluster (Charing Cross → Waterloo within Central
          // London, for example).
          walkId: variant.id,
          // Per-attachment role: which endpoint of the walk this
          // station is. Drives the s2s prose split below.
          role,
          summary,
          ratingTier: ratingTierOf(variant.rating),
          hasKomoot: !!variant.komootUrl,
          // GPX is an entry-level field, shared by every variant on
          // the same source page. Tracked per-part so the public-tier
          // filter (Komoot/GPX > main > all) can short-circuit on it.
          hasGpx: typeof entry.gpx === "string" && entry.gpx.trim() !== "",
          isMain: sourceType === "main",
          isCircular,
          // Raw source type kept for possible future per-subtype
          // filtering. Current filter only cares about isMain.
          sourceType,
          distanceScore: distanceScore(variant.distanceKm),
          pageTitle: entry.title ?? "",
          // Legacy title pieces from the old duplicate-variant filter.
          // Current rule keys off mainCount + sourceType only; leaving
          // them on the struct for now in case we reintroduce the
          // dedup later without a rebuild.
          displayName,
          baseDisplayName,
          // Structured month codes for this variant. Aggregated into
          // perStationMonths AFTER publicTierFilter runs (below) so the
          // month filter only surfaces stations whose PUBLICLY-VISIBLE
          // walks include the chosen month — admin-only variants hidden
          // by the public tier (e.g. a non-main, non-Komoot walk at a
          // station that also has Komoot walks) don't contribute.
          bestSeasons: Array.isArray(variant.bestSeasons) ? variant.bestSeasons : [],
        })

        // Track stations with at least one personally-walked variant.
        // Any non-empty previousWalkDates flips the station from
        // "undiscovered" to "hiked" in the derived output.
        if (Array.isArray(variant.previousWalkDates) && variant.previousWalkDates.length > 0) {
          perStationHiked.add(station.coordKey)
        }

        // Track stations with at least one walk variant carrying a
        // Komoot tour URL.
        if (typeof variant.komootUrl === "string" && variant.komootUrl.trim() !== "") {
          perStationKomoot.add(station.coordKey)
        }
      }
    }
  }

  // Apply to station-notes.json:
  // - Stations in perStation get their ramblerNote set to joined paragraphs.
  // - Existing stations not in perStation get their ramblerNote cleared
  //   (preserves publicNote and privateNote).
  // - Entries that end up with all three notes empty are removed so the
  //   file stays clean.
  const changes = { added: 0, updated: 0, cleared: 0, removed: 0 }

  // Station-wide public tier filter — drastically reduces clutter by
  // showing only the most curated walks at each station. Cascading:
  //   Tier 1: any walk with a Komoot URL or GPX → show only those
  //   Tier 2: else any main walk → show only mains
  //   Tier 3: else show all (parts already exclude bus walks because
  //           the build only iterates stationToStation === true)
  // The chosen tier applies station-wide; circular and S2S sections
  // share one decision, so a single Komoot circular walk will hide
  // non-Komoot S2S walks elsewhere on the station. No per-section
  // quota — every walk in the chosen tier is rendered.
  function publicTierFilter(parts) {
    if (parts.some((p) => p.hasKomoot || p.hasGpx)) {
      return parts.filter((p) => p.hasKomoot || p.hasGpx)
    }
    if (parts.some((p) => p.isMain)) {
      return parts.filter((p) => p.isMain)
    }
    return parts
  }

  // ── Synthetic aggregation ────────────────────────────────────────
  // Synthetics (Central London, Birmingham, Stratford, …) "possess"
  // their cluster members' walks. We pool every member's ramblerParts
  // into a single bucket keyed by the synthetic anchor coord, then
  // pass that bucket through the same compareRamblerParts sort and
  // quotaFilterPerSection 3-per-section limit as a regular station.
  // Result: a synthetic with 15 members each having 5 walks still
  // shows the top 3 circular + top 3 station-to-station walks
  // overall, picked using identical curation rules. Synthetics are
  // looped through alongside real stations so they get the same
  // perStation treatment downstream.
  // Iterate every cluster — destination-only ones (no origin flags) also
  // need their members' walks aggregated under the anchor, otherwise the
  // cluster modal renders no walks even though members have plenty.
  // ALL_CLUSTER_MEMBERS is ID-keyed (post Phase 2e): both the synthetic
  // anchor key and each member entry are station IDs, not coord strings.
  // perStation / perStationHiked / perStationKomoot stay coord-keyed
  // (matches the rest of this script), so we translate IDs → coords
  // via idToCoord at the boundary. Pre-fix this loop quietly missed
  // every member lookup and clusters ended up with empty walks.
  for (const [synthId, memberIds] of Object.entries(ALL_CLUSTER_MEMBERS)) {
    const synthCoord = idToCoord.get(synthId)
    if (!synthCoord) continue
    // Dedup by walkId: a walk with both endpoints in the same cluster
    // attaches to two member stations (once as "starting", once as
    // "ending") and would otherwise appear twice in the synthetic's
    // prose. Prefer the "starting" attachment so the synthetic header
    // reads "…starting at <Cluster>" rather than "…ending at".
    const seenWalks = new Map()
    let aggregatedHiked = false
    let aggregatedKomoot = false
    for (const memberId of memberIds) {
      const memberCoord = idToCoord.get(memberId)
      if (!memberCoord) continue
      const memberBucket = perStation.get(memberCoord)
      if (memberBucket) {
        for (const p of memberBucket.ramblerParts) {
          const existing = seenWalks.get(p.walkId)
          if (!existing || (existing.role === "ending" && p.role === "starting")) {
            seenWalks.set(p.walkId, p)
          }
        }
      }
      if (perStationHiked.has(memberCoord)) aggregatedHiked = true
      if (perStationKomoot.has(memberCoord)) aggregatedKomoot = true
    }
    const aggregatedParts = [...seenWalks.values()]
    // Always set a perStation entry for the synthetic, even when
    // empty — keeps the cleanup pass below from removing the
    // synthetic's user-authored notes if no member walks exist yet.
    const synthName = SYNTHETIC_DISPLAY_NAMES[synthId] ?? synthId
    if (!perStation.has(synthCoord)) {
      perStation.set(synthCoord, { name: synthName, ramblerParts: [] })
    }
    const synthBucket = perStation.get(synthCoord)
    synthBucket.name = synthName
    synthBucket.ramblerParts = aggregatedParts

    if (aggregatedHiked) perStationHiked.add(synthCoord)
    if (aggregatedKomoot) perStationKomoot.add(synthCoord)
    // Synthetic months are derived in the per-station rendering loop
    // below — same path as real stations, so the publicTierFilter is
    // applied to the synthetic's aggregated parts before months are
    // collected.
  }

  for (const [coordKey, { name, ramblerParts }] of perStation) {
    const ordered = [...ramblerParts].sort(compareRamblerParts)
    // Admin's view: full unfiltered single block (every walk, every
    // note, every variant — bus-tagged walks never make it this far
    // because buildSummary returns null when stationToStation is
    // false). Distinct from the public view's three sectioned blocks.
    const adminWalksAll = ordered.map((p) => p.summary).join("\n\n")
    // Public view — apply the station-wide tier filter first, then
    // split the survivors into the three section buckets:
    // - circular  (isCircular — same start & end station)
    // - s2s starting here (role === "starting")
    // - s2s ending here   (role === "ending")
    // Empty sections aren't rendered (handled by photo-overlay).
    const publicOrdered = publicTierFilter(ordered)
    const publicCircularParts = publicOrdered.filter((p) => p.isCircular)
    const publicS2SStartingParts = publicOrdered.filter((p) => !p.isCircular && p.role === "starting")
    const publicS2SEndingParts = publicOrdered.filter((p) => !p.isCircular && p.role === "ending")
    // The "*Last reviewed …*" sentence is admin-only; strip it (plus
    // its leading separator) before joining so the public prose
    // doesn't expose the personal hike-tracking dates. buildSummary
    // emits one summary per walk and we use it for BOTH admin and
    // public views, so the cleanest place to drop it is at the
    // public-render boundary here.
    const stripReviewedSentence = (s) => s.replace(/\s*\*Last reviewed [^*\n]+\*\.?/g, "")
    const publicWalksCircular = publicCircularParts.map((p) => stripReviewedSentence(p.summary)).join("\n\n")
    const publicWalksS2S = publicS2SStartingParts.map((p) => stripReviewedSentence(p.summary)).join("\n\n")
    const publicWalksS2SEnding = publicS2SEndingParts.map((p) => stripReviewedSentence(p.summary)).join("\n\n")
    // Per-station month aggregation from publicly-visible walks only —
    // bypasses admin-only variants hidden by publicTierFilter so the
    // month filter never surfaces a station whose only matching walks
    // are admin-only. Runs equally for real stations and synthetics
    // (synthetics have already been merged into perStation above).
    const publicMonths = new Set()
    for (const p of publicOrdered) {
      for (const m of p.bestSeasons ?? []) {
        const code = String(m).toLowerCase()
        if (MONTH_FULL[code]) publicMonths.add(code)
      }
    }
    if (publicMonths.size > 0) {
      perStationMonths.set(coordKey, { name, months: publicMonths })
    }
    // "Potential month data" set — stations that fail the public-month
    // filter but DO have month metadata on an admin-only variant, AND
    // have a Komoot route. Surfaces destinations where the existing
    // admin month metadata could be promoted to a public walk to make
    // the station appear in the public month filter.
    if (publicMonths.size === 0 && perStationKomoot.has(coordKey)) {
      const hasAdminMonths = ordered.some((p) =>
        Array.isArray(p.bestSeasons) && p.bestSeasons.some((m) => MONTH_FULL[String(m).toLowerCase()]),
      )
      if (hasAdminMonths) perStationPotentialMonths.add(coordKey)
    }
    if (notes[coordKey]) {
      const beforeAdmin = notes[coordKey].adminWalksAll
      notes[coordKey].adminWalksAll = adminWalksAll
      notes[coordKey].publicWalksS2S = publicWalksS2S
      notes[coordKey].publicWalksS2SEnding = publicWalksS2SEnding
      notes[coordKey].publicWalksCircular = publicWalksCircular
      delete notes[coordKey].publicWalksExtras
      // Tidy legacy fields — replaced by the four above.
      delete notes[coordKey].ramblerNote
      delete notes[coordKey].publicRamblerNote
      if ("ramblerMainCount" in notes[coordKey]) delete notes[coordKey].ramblerMainCount
      if (beforeAdmin !== adminWalksAll) changes.updated++
    } else {
      notes[coordKey] = {
        name,
        publicNote: "",
        privateNote: "",
        adminWalksAll,
        publicWalksS2S,
        publicWalksS2SEnding,
        publicWalksCircular,
      }
      changes.added++
    }
  }

  for (const [coordKey, entry] of Object.entries(notes)) {
    if (perStation.has(coordKey)) continue
    if (
      entry.adminWalksAll
      || entry.publicWalksS2S
      || entry.publicWalksS2SEnding
      || entry.publicWalksCircular
    ) {
      entry.adminWalksAll = ""
      entry.publicWalksS2S = ""
      entry.publicWalksS2SEnding = ""
      entry.publicWalksCircular = ""
      changes.cleared++
    }
    delete entry.publicWalksExtras
    // Drop legacy fields from any leftover entries too.
    delete entry.ramblerNote
    delete entry.publicRamblerNote
    if ("ramblerMainCount" in entry) delete entry.ramblerMainCount
  }

  for (const [coordKey, entry] of Object.entries(notes)) {
    if (!entry.publicNote && !entry.privateNote && !entry.adminWalksAll) {
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

  // ── Compute derived outputs ────────────────────────────────────────
  // Hoisted above the writes so `returnData` mode (used by API routes
  // that commit via the GitHub API) can hand them off without touching
  // the filesystem at all — important on Vercel's read-only fs.

  // station-months.json: entries keyed by station ID (CRS for real
  // stations, C-prefix synthetic for cluster anchors), sorted by ID,
  // empty month sets skipped, months inside each entry in calendar
  // order — diff-friendly. Internally we still aggregate against the
  // coordKey (perStationMonths) to keep the build pipeline ID-agnostic;
  // ID translation happens here at output time only. Reuses the
  // coordToId map built earlier when notes were converted from ID-keyed
  // input to the coord-keyed working copy.
  const monthsRaw = {}
  for (const [coordKey, { name, months }] of perStationMonths.entries()) {
    if (months.size === 0) continue
    const id = coordToId.get(coordKey)
    if (!id) continue   // station not in registry — skip rather than emit an unresolvable key
    monthsRaw[id] = {
      name,
      months: MONTH_ORDER.filter((m) => months.has(m)),
    }
  }
  const monthsOut = Object.fromEntries(
    Object.entries(monthsRaw).sort(([a], [b]) => a.localeCompare(b)),
  )

  // Coord → ID translation helper for the array-shaped outputs that
  // were rekeyed in Phase 2d. Drops anything not in the registry —
  // matches the audit's "every reference must resolve" expectation.
  const coordsToIds = (coords) =>
    [...coords].map((c) => coordToId.get(c)).filter((x) => x !== undefined).sort()

  // stations-hiked.json: sorted array of station IDs for stations whose
  // attached walks include at least one variant with a non-empty
  // previousWalkDates. The admin "Undiscovered" filter hides these.
  const hikedOut = coordsToIds(perStationHiked)

  // stations-with-komoot.json: sorted array of station IDs for stations
  // with at least one walk variant carrying a komootUrl. Drives the
  // admin-only "Komoot" map filter.
  const komootOut = coordsToIds(perStationKomoot)

  // stations-potential-months.json: sorted station IDs for stations that
  // have a Komoot route AND month data only on admin-only variants.
  // Drives the admin-only "Potential month data" feature filter.
  const potentialMonthsOut = coordsToIds(perStationPotentialMonths)

  // stations-by-source.json: pivot the per-station Set<orgSlug> map
  // into { [orgSlug]: stationId[] } with each list sorted, so the admin
  // "Source" filter can answer "stations with ≥1 walk from org X" via
  // a single Set lookup keyed by the dropdown selection.
  const bySourceOut = {}
  for (const [coordKey, orgs] of perStationSourceOrgs) {
    const id = coordToId.get(coordKey)
    if (!id) continue
    for (const org of orgs) {
      if (!bySourceOut[org]) bySourceOut[org] = []
      bySourceOut[org].push(id)
    }
  }
  for (const org of Object.keys(bySourceOut)) bySourceOut[org].sort()
  const bySourceSorted = Object.fromEntries(
    Object.keys(bySourceOut).sort().map((k) => [k, bySourceOut[k]]),
  )

  // Convert the working coord-keyed `notes` map back to the ID-keyed
  // shape that data/station-notes.json now uses on disk (Phase 2b).
  // Sorted by ID for a stable, diff-friendly output. Coord entries
  // without a registry ID are dropped — the same drop-on-unresolvable
  // policy applied at read-time, so this is symmetric.
  const notesOutRaw = {}
  for (const [coord, entry] of Object.entries(notes)) {
    const id = coordToId.get(coord)
    if (id) notesOutRaw[id] = entry
  }
  const notesOut = Object.fromEntries(
    Object.entries(notesOutRaw).sort(([a], [b]) => a.localeCompare(b)),
  )

  // returnData mode: hand back the computed data instead of writing.
  // Callers (API routes) commit these atomically via writeDataFile so
  // the derived files end up in git alongside the walk file. This is
  // also the only viable path on Vercel, where writeFileSync would
  // throw EROFS.
  if (args.returnData) {
    return { notes: notesOut, months: monthsOut, hiked: hikedOut, komoot: komootOut, potentialMonths: potentialMonthsOut, bySource: bySourceSorted }
  }

  writeFileSync(NOTES_PATH, JSON.stringify(notesOut, null, 2) + "\n", "utf-8")
  // eslint-disable-next-line no-console
  console.log(`Wrote ${Object.keys(notesOut).length} entries to ${NOTES_PATH}`)

  writeFileSync(MONTHS_PATH, JSON.stringify(monthsOut, null, 2) + "\n", "utf-8")
  // eslint-disable-next-line no-console
  console.log(`Wrote ${Object.keys(monthsOut).length} entries to ${MONTHS_PATH}`)

  writeFileSync(HIKED_PATH, JSON.stringify(hikedOut, null, 2) + "\n", "utf-8")
  // eslint-disable-next-line no-console
  console.log(`Wrote ${hikedOut.length} entries to ${HIKED_PATH}`)

  writeFileSync(KOMOOT_PATH, JSON.stringify(komootOut, null, 2) + "\n", "utf-8")
  // eslint-disable-next-line no-console
  console.log(`Wrote ${komootOut.length} entries to ${KOMOOT_PATH}`)

  writeFileSync(POTENTIAL_MONTHS_PATH, JSON.stringify(potentialMonthsOut, null, 2) + "\n", "utf-8")
  // eslint-disable-next-line no-console
  console.log(`Wrote ${potentialMonthsOut.length} entries to ${POTENTIAL_MONTHS_PATH}`)

  writeFileSync(STATIONS_BY_SOURCE_PATH, JSON.stringify(bySourceSorted, null, 2) + "\n", "utf-8")
  // eslint-disable-next-line no-console
  console.log(`Wrote ${Object.keys(bySourceSorted).length} source orgs to ${STATIONS_BY_SOURCE_PATH}`)

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
