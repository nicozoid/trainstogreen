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
    const main = loc ? `${base} in ${loc}` : base
    // Optional admin notes about the stop (e.g. "good Sunday roast",
    // "no kitchen on Mondays"). Renders in parentheses so the prose
    // surfaces the colour without bloating the main clause.
    const note = typeof s.notes === "string" ? s.notes.trim().replace(/[.!?]+$/, "") : ""
    return note ? `${main} (${note})` : main
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
function formatSights(sights) {
  if (!Array.isArray(sights) || sights.length === 0) return null
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
// relatedSource → "Adapted from [<Org> walk](url)." (or "Similar to …").
//
// Emitted as a sentence between the lunch line and the distance line
// in the rendered prose. Triggered solely by relatedSource.orgSlug
// being populated; pageURL is optional — when missing, the link
// collapses to plain text. Falls back to the slug itself when the
// org isn't registered in sources.json (avoids a broken summary if
// an admin adds a new orgSlug without registering it first).
function formatRelatedSourceClause(variant, sources) {
  const rs = variant.relatedSource
  if (!rs || typeof rs.orgSlug !== "string" || rs.orgSlug.trim() === "") return null
  const orgName = sources?.[rs.orgSlug]?.name || rs.orgSlug
  const linkText = `${orgName} walk`
  const pageURL = typeof rs.pageURL === "string" ? rs.pageURL.trim() : ""
  const labelled = pageURL ? `[${linkText}](${pageURL})` : linkText
  let phrase
  switch (rs.type) {
    case "main":        phrase = "From"; break
    case "shorter":     phrase = "A shorter variant of"; break
    case "longer":      phrase = "A longer variant of"; break
    case "alternative": phrase = "An alternative variant of"; break
    case "variant":     phrase = "A variant of"; break
    case "similar":     phrase = "Similar to"; break
    case "related":     phrase = "Related to"; break
    // Unknown / unset types fall back to the most generic phrasing.
    case "adapted":
    default:            phrase = "Adapted from"; break
  }
  return `${phrase} ${labelled}.`
}

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

  // Lunch stops — compact list
  const lunch = formatLunchStops(variant.lunchStops)
  if (lunch) parts.push(`Lunch at ${lunch}.`)

  // Book source clause — emitted before distance so the book
  // attribution reads as a lead-in to the trailing stats rather than
  // trailing them. Only fires for book-style orgSlugs (Rough Guide
  // etc); web sources were already handled above.
  if (orgIsBook) {
    const bookClause = formatSourceClause(variant, entry, sources)
    if (bookClause) parts.push(bookClause)
  }

  // Related source — admin cross-reference rendered as a short
  // "Adapted from [<Org> walk](url)." clause. Sits alongside the
  // book source clause so any external attribution is grouped
  // together just before the distance/time stats.
  const relatedClause = formatRelatedSourceClause(variant, sources)
  if (relatedClause) parts.push(relatedClause)

  // Distance and hours — each their own sentence, terse. Always
  // emitted when present, including alongside a Komoot route (the
  // "Pull distance" admin button keeps the structured fields in
  // sync with the Komoot tour, so they no longer disagree).
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
  const notes = JSON.parse(readFileSync(NOTES_PATH, "utf-8"))
  const crsIndex = buildCrsIndex()
  // sources.json — organisation registry. Loaded once here and threaded
  // into buildSummary so the relatedSource clause can render
  // "<Org> walk" link text without each call re-reading from disk.
  const sources = JSON.parse(readFileSync(SOURCES_PATH, "utf-8"))

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
  // coordKey → true. Any station whose attached walks include at least
  // one variant with a non-empty `komootUrl`. Written to
  // data/stations-with-komoot.json as a sorted array; the admin "Komoot"
  // filter keeps only these.
  const perStationKomoot = new Set()
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
  for (const [synthCoord, memberCoords] of Object.entries(ALL_CLUSTER_MEMBERS)) {
    // Dedup by walkId: a walk with both endpoints in the same cluster
    // attaches to two member stations (once as "starting", once as
    // "ending") and would otherwise appear twice in the synthetic's
    // prose. Prefer the "starting" attachment so the synthetic header
    // reads "…starting at <Cluster>" rather than "…ending at".
    const seenWalks = new Map()
    let aggregatedHiked = false
    let aggregatedKomoot = false
    const aggregatedSeasons = new Set()
    for (const memberCoord of memberCoords) {
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
      const memberSeasons = perStationSeasons.get(memberCoord)
      if (memberSeasons) {
        for (const s of memberSeasons.seasons) aggregatedSeasons.add(s)
      }
    }
    const aggregatedParts = [...seenWalks.values()]
    // Always set a perStation entry for the synthetic, even when
    // empty — keeps the cleanup pass below from removing the
    // synthetic's user-authored notes if no member walks exist yet.
    const synthName = SYNTHETIC_DISPLAY_NAMES[synthCoord] ?? synthCoord
    if (!perStation.has(synthCoord)) {
      perStation.set(synthCoord, { name: synthName, ramblerParts: [] })
    }
    const synthBucket = perStation.get(synthCoord)
    synthBucket.name = synthName
    synthBucket.ramblerParts = aggregatedParts

    if (aggregatedHiked) perStationHiked.add(synthCoord)
    if (aggregatedKomoot) perStationKomoot.add(synthCoord)
    if (aggregatedSeasons.size > 0) {
      perStationSeasons.set(synthCoord, { name: synthName, seasons: aggregatedSeasons })
    }
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
    const publicWalksCircular = publicCircularParts.map((p) => p.summary).join("\n\n")
    const publicWalksS2S = publicS2SStartingParts.map((p) => p.summary).join("\n\n")
    const publicWalksS2SEnding = publicS2SEndingParts.map((p) => p.summary).join("\n\n")
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

  // station-seasons.json: entries sorted by coordKey, empty season sets
  // skipped, seasons inside each entry in calendar order — diff-friendly.
  const seasonsOut = {}
  for (const [coordKey, { name, seasons }] of [...perStationSeasons.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    if (seasons.size === 0) continue
    seasonsOut[coordKey] = {
      name,
      seasons: SEASON_ORDER.filter((s) => seasons.has(s)),
    }
  }

  // stations-hiked.json: sorted array of coordKeys for stations whose
  // attached walks include at least one variant with a non-empty
  // previousWalkDates. The admin "Undiscovered" filter hides these.
  const hikedOut = [...perStationHiked].sort()

  // stations-with-komoot.json: sorted array of coordKeys for stations
  // with at least one walk variant carrying a komootUrl. Drives the
  // admin-only "Komoot" map filter.
  const komootOut = [...perStationKomoot].sort()

  // stations-by-source.json: pivot the per-station Set<orgSlug> map
  // into { [orgSlug]: coordKey[] } with each list sorted, so the admin
  // "Source" filter can answer "stations with ≥1 walk from org X" via
  // a single Set lookup keyed by the dropdown selection.
  const bySourceOut = {}
  for (const [coordKey, orgs] of perStationSourceOrgs) {
    for (const org of orgs) {
      if (!bySourceOut[org]) bySourceOut[org] = []
      bySourceOut[org].push(coordKey)
    }
  }
  for (const org of Object.keys(bySourceOut)) bySourceOut[org].sort()
  const bySourceSorted = Object.fromEntries(
    Object.keys(bySourceOut).sort().map((k) => [k, bySourceOut[k]]),
  )

  // returnData mode: hand back the computed data instead of writing.
  // Callers (API routes) commit these atomically via writeDataFile so
  // the derived files end up in git alongside the walk file. This is
  // also the only viable path on Vercel, where writeFileSync would
  // throw EROFS.
  if (args.returnData) {
    return { notes, seasons: seasonsOut, hiked: hikedOut, komoot: komootOut, bySource: bySourceSorted }
  }

  writeFileSync(NOTES_PATH, JSON.stringify(notes, null, 2) + "\n", "utf-8")
  // eslint-disable-next-line no-console
  console.log(`Wrote ${Object.keys(notes).length} entries to ${NOTES_PATH}`)

  writeFileSync(SEASONS_PATH, JSON.stringify(seasonsOut, null, 2) + "\n", "utf-8")
  // eslint-disable-next-line no-console
  console.log(`Wrote ${Object.keys(seasonsOut).length} entries to ${SEASONS_PATH}`)

  writeFileSync(HIKED_PATH, JSON.stringify(hikedOut, null, 2) + "\n", "utf-8")
  // eslint-disable-next-line no-console
  console.log(`Wrote ${hikedOut.length} entries to ${HIKED_PATH}`)

  writeFileSync(KOMOOT_PATH, JSON.stringify(komootOut, null, 2) + "\n", "utf-8")
  // eslint-disable-next-line no-console
  console.log(`Wrote ${komootOut.length} entries to ${KOMOOT_PATH}`)

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
