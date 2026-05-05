import { NextRequest, NextResponse } from "next/server"
import { KOMOOT_TO_SPOT_TYPES, VIEWPOINT_SUPERSEDED_BY, bucketForRefreshment, type SpotTypeValue } from "@/lib/spot-types"

// Scrape tour data from a public komoot tour page.
//
// Komoot's HTML embeds a human-readable summary in the og:description /
// twitter:description meta tags shaped like:
//   "Distance: 15.5 km | Duration: 04:16 h"
// We parse that plus the embedded JSON for elevation, difficulty, and
// tour name — these live in the serialised tour object rather than meta
// tags.
//
// Returns { distanceKm, hours, uphillMetres, difficulty, name }. Errors:
//   400 — body missing/malformed
//   404 — page returned non-200 OR the meta string is missing
//   502 — fetch failed entirely (network, timeout)

const META_RE = /Distance:\s*([\d.]+)\s*km\s*\|\s*Duration:\s*(\d+):(\d+)\s*h/i
// Elevation gain from the embedded JSON tour object (first occurrence
// is the tour total; per-segment values follow but are typically 0).
const ELEVATION_UP_RE = /"elevation_up\\?":\s*([\d.]+)/
// Difficulty grade — searches for the "grade" key inside the tour's
// embedded JSON. Handles both plain ("grade":"X") and escaped
// (\"grade\":\"X\") JSON encoding.
const DIFFICULTY_RE = /\\?"grade\\?"\s*:\s*\\?"(EASY|MODERATE|HARD|DIFFICULT|EXPERT)/i
// Tour name from og:title — strip the trailing " | hike | Komoot" etc.
const OG_TITLE_RE = /<meta\s+(?:property|name)="og:title"\s+content="([^"]+)"/i
const OG_TITLE_ALT_RE = /<meta\s+content="([^"]+)"\s+(?:property|name)="og:title"/i

// Decode the HTML entities komoot embeds in og:title attribute values
// (&#x27; → ', &amp; → &, etc.). Without this we'd persist literal
// "&#x27;" in the walk's name field and it would render as "&#x27;"
// in the public prose. &amp; is decoded LAST so we don't double-decode
// "&amp;quot;" into a literal quote.
function decodeHtmlEntities(s: string): string {
  return s
    .replace(/&#x([0-9a-fA-F]+);/g, (_, hex) => String.fromCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, dec) => String.fromCodePoint(parseInt(dec, 10)))
    .replace(/&apos;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&")
}

// Categories on Komoot Highlights that should bucket as a refreshment
// venue (pub / lunch stop / destination pub). Anything else maps to a
// "sight". Komoot's highlight `categories` field is a string array
// like ["cafe","pub","settlement","family_friendly"]; POIs only carry
// a numeric `category` we have to decode via POI_CATEGORY_TAGS below.
const FOOD_CATEGORIES = new Set(["pub", "restaurant", "cafe"])

// Tags that mean "this waypoint is navigation, not a destination" —
// dropped from all buckets entirely. Train stations are the obvious
// case (Komoot loves to drop them at the start/end of rail-served
// walks). Add any other navigational categories here as we encounter
// them.
const NON_DESTINATION_TAGS = new Set(["train_station"])

// Name-based filter for navigation waypoints. Komoot's HIGHLIGHT
// items often skip the `train_station` category and just carry a name
// like "Tring Railway Station" — those slip past NON_DESTINATION_TAGS
// and end up listed as sights. Match the trailing "<modifier> station"
// pattern so a highlight named "Tring Railway Station" is dropped
// while a pub literally called "The Old Station" survives (modifier
// is required).
const NON_DESTINATION_NAME_RE = /\b(?:railway|train|rail|tube|underground|metro|subway|bus|coach|tram)\s+station\s*$/i

// Empirically-built lookup from Komoot's numeric POI category IDs to
// the equivalent highlight-string tag(s). Komoot doesn't ship this
// mapping in the page or any public API — entries are added as we
// encounter new categories on real walks. Unknown IDs → no tags
// (defaults to a "sight" bucket).
//
//    21 — summit         (Otford Mount and similar named hills)
//    41 — cafe           (Abigail's Cafe)
//    61 — pub            (Queens Head, Rose & Crown, Peahen, …)
//    72 — religious_building (St Peter & St Paul, parish churches)
//   191 — forest         (Back Wood, Courtfield Wood, Great Wood, …)
//   219 — train_station  (Bow Brickhill, St Albans City)
//
// Add new entries here when a POI gets misclassified. The values use
// the same vocabulary as Komoot's highlight `categories` array, so
// FOOD_CATEGORIES + KOMOOT_TO_SPOT_TYPES + NON_DESTINATION_TAGS all
// match against this same string set.
const POI_CATEGORY_TAGS: Record<number, string[]> = {
  21: ["mountain_summits"],
  41: ["cafe"],
  61: ["pub"],
  72: ["religious_building"],
  191: ["forest"],
  219: ["train_station"],
}

type Waypoint = {
  name: string
  lat: number
  lng: number
  /** Approx. km along the route at this waypoint's index. Linear
   *  interpolation (totalKm × index / maxIndex) — close enough for the
   *  admin to see at a glance, not survey-accurate. */
  kmIntoRoute: number
  /** Canonical spot types derived from the raw Komoot categories
   *  (highlight `categories[]` strings + POI numeric `category`). The
   *  frontend fills the row's `types` field with these only when it's
   *  currently empty. */
  types: SpotTypeValue[]
}

// Map raw Komoot category strings (already normalised — POI numeric
// codes are decoded upstream) into our canonical SpotTypeValue
// vocabulary, deduped + order-preserved. Tags not in the lookup are
// silently dropped (most Komoot tags are non-classification metadata
// like "trail" or "wheelchair_accessible").
//
// Special case: drop `viewpoint` when a more specific nature tag is
// also present (forest / lakes_rivers / coastline / mountain_summits
// / waterfall). See VIEWPOINT_SUPERSEDED_BY for the full rule.
function mapKomootTypes(categories: string[]): SpotTypeValue[] {
  const hasSupersedingNature = categories.some((c) => VIEWPOINT_SUPERSEDED_BY.has(c))
  const out: SpotTypeValue[] = []
  const seen = new Set<SpotTypeValue>()
  for (const c of categories) {
    if (c === "viewpoint" && hasSupersedingNature) continue
    const v = KOMOOT_TO_SPOT_TYPES[c]
    if (!v || seen.has(v)) continue
    seen.add(v)
    out.push(v)
  }
  return out
}

type WaypointBuckets = {
  destinationStops: Waypoint[]
  lunchStops: Waypoint[]
  sights: Waypoint[]
}

// Parse the embedded `way_points` block from Komoot's HTML and bucket
// each named waypoint into destinationStops / lunchStops / sights.
//
// Komoot embeds tour state in the page as a stringified JSON blob with
// escaped quotes (\"). We unescape a chunk around the way_points key,
// then walk through each `{"type":...,"index":...}` item and pull
// out name + location + categories with scoped sub-regexes.
//
// Skipped:
//  - type === "point" items (route shaping, no name)
//  - the smallest- and largest-index named items (start + end)
//
// Limitation: POI items have only a numeric `category` (Komoot
// internal lookup); we can't tell from the data alone if a POI is a
// pub. POIs always bucket as sights — admin can re-categorise.
function parseWaypoints(html: string, totalKm: number): WaypointBuckets | null {
  const blockStart = html.indexOf('"way_points\\":{\\"_links\\":{}')
  if (blockStart < 0) return null
  // 250KB window. Each waypoint item embeds nested image metadata
  // (Wikipedia/Geograph attributions, photo URLs, captions) which can
  // run a few KB per item — so a tour with ~20 POIs easily blows past
  // 50KB. 250KB covers every tour we've encountered with margin to
  // spare without scanning the whole 500KB+ HTML payload.
  const raw = html.slice(blockStart, blockStart + 250_000)
  const unesc = raw.replace(/\\"/g, '"').replace(/\\\//g, "/").replace(/\\\\/g, "\\")

  // Iterate item starts. Each item begins with `{"type":"X","index":N`
  // — we slice to the next item start (or end of window) to scope the
  // sub-regexes so a later item's name can't leak into the current.
  const itemStarts: number[] = []
  const startRe = /\{"type":"(?:poi|highlight|point)","index":/g
  let m: RegExpExecArray | null
  while ((m = startRe.exec(unesc)) !== null) itemStarts.push(m.index)
  if (itemStarts.length === 0) return null

  type Item = {
    type: "poi" | "highlight" | "point"
    index: number
    name: string | null
    location: { lat: number; lng: number } | null
    categories: string[]
  }
  const items: Item[] = []
  for (let i = 0; i < itemStarts.length; i++) {
    const body = unesc.slice(itemStarts[i], itemStarts[i + 1] ?? itemStarts[i] + 5_000)
    const typeM = /^\{"type":"(poi|highlight|point)"/.exec(body)
    const idxM = /"index":(\d+)/.exec(body)
    if (!typeM || !idxM) continue
    const nameM = /"name":"([^"]+)"/.exec(body)
    const locM = /"location":\{"lat":(-?[\d.]+),"lng":(-?[\d.]+)/.exec(body)
    // Highlight categories: string array.
    // POI category: a single numeric ID; we map it via POI_CATEGORY_TAGS
    // to the same string vocabulary so downstream code treats both
    // shapes uniformly.
    const catsM = /"categories":\[([^\]]+)\]/.exec(body)
    const numericCatM = /"category":(\d+)/.exec(body)
    const categories: string[] = catsM
      ? Array.from(catsM[1].matchAll(/"([a-z_]+)"/g)).map((c) => c[1])
      : numericCatM
        ? POI_CATEGORY_TAGS[parseInt(numericCatM[1], 10)] ?? []
        : []
    items.push({
      type: typeM[1] as Item["type"],
      index: parseInt(idxM[1], 10),
      name: nameM ? nameM[1] : null,
      location: locM ? { lat: parseFloat(locM[1]), lng: parseFloat(locM[2]) } : null,
      categories,
    })
  }

  // Every named, located waypoint is a candidate. We deliberately
  // DON'T exclude the smallest or largest index any more — Komoot's
  // route start/end are the unnamed `point` markers, not the named
  // POIs/highlights that happen to sit at the lowest/highest index.
  // Excluding by index used to drop genuine waypoints near the end of
  // the walk (e.g. "The Woodman", a pub the route literally finishes
  // at).
  //
  // Train-station POIs (category 219 → "train_station") are filtered
  // out separately — they're navigational landmarks, not destinations
  // worth showing as sights/lunch stops/pubs. Same for any future
  // category we add to NON_DESTINATION_TAGS.
  if (items.length === 0) return null
  // Use the maximum overall index as the route's end position for
  // kmIntoRoute interpolation (still correct: indices count up
  // monotonically along the route polyline).
  let maxIndex = 0
  for (const it of items) if (it.index > maxIndex) maxIndex = it.index
  if (maxIndex <= 0) return null

  const middle = items
    .filter(
      (it) =>
        it.type !== "point" &&
        it.name &&
        it.location &&
        !it.categories.some((c) => NON_DESTINATION_TAGS.has(c)) &&
        // Decode entities before the regex check — Komoot occasionally
        // emits "&amp;" inside station names ("Tring &amp; Tring Park")
        // which would otherwise survive the suffix match unscathed.
        !NON_DESTINATION_NAME_RE.test(decodeHtmlEntities(it.name!)),
    )
    .sort((a, b) => a.index - b.index)
  if (middle.length === 0) return { destinationStops: [], lunchStops: [], sights: [] }

  const buckets: WaypointBuckets = {
    destinationStops: [],
    lunchStops: [],
    sights: [],
  }
  for (const it of middle) {
    const isFood = it.categories.some((c) => FOOD_CATEGORIES.has(c))
    const wp: Waypoint = {
      name: decodeHtmlEntities(it.name!),
      lat: it.location!.lat,
      lng: it.location!.lng,
      // Linear interp via index. Round to 1dp — the value's only
      // accurate to ±10% anyway since waypoint indices aren't evenly
      // distributed along the route. Uses the OVERALL maxIndex
      // (across all items including unnamed points) as the route end.
      kmIntoRoute: Math.round(((totalKm * it.index) / maxIndex) * 10) / 10,
      types: mapKomootTypes(it.categories),
    }
    if (isFood) {
      // Use the shared helper so import-time bucketing agrees with
      // the editor's auto-move logic when an admin changes a row's
      // types. The helper looks at fractional distance from the end
      // (DESTINATION_STOP_FRACTION) rather than an absolute cutoff,
      // so the split scales with route length.
      const bucket = bucketForRefreshment(wp.kmIntoRoute, totalKm)
      if (bucket === "destination") buckets.destinationStops.push(wp)
      else buckets.lunchStops.push(wp)
    } else {
      buckets.sights.push(wp)
    }
  }
  return buckets
}

export async function POST(req: NextRequest) {
  let body: { url?: string }
  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ error: "invalid JSON body" }, { status: 400 })
  }
  const url = body.url?.trim()
  if (!url || !/^https?:\/\/(www\.)?komoot\.(com|de)\/tour\//i.test(url)) {
    return NextResponse.json(
      { error: "expected a komoot.com/tour/… or komoot.de/tour/… URL" },
      { status: 400 },
    )
  }

  let html: string
  try {
    const res = await fetch(url, {
      // Komoot serves a 403 unless the request looks like a real browser.
      headers: {
        "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
        "Accept": "text/html,application/xhtml+xml",
        "Accept-Language": "en-GB,en;q=0.9",
      },
      // Stop hanging on slow responses — komoot is normally <2s, but
      // 10s was tight enough to occasionally trip on transient blips.
      signal: AbortSignal.timeout(25_000),
    })
    if (!res.ok) {
      return NextResponse.json(
        { error: `komoot returned HTTP ${res.status} (the tour may be private or removed)` },
        { status: 404 },
      )
    }
    html = await res.text()
  } catch (e) {
    return NextResponse.json(
      { error: `fetch failed: ${(e as Error).message}` },
      { status: 502 },
    )
  }

  const m = META_RE.exec(html)
  if (!m) {
    return NextResponse.json(
      { error: "couldn't find distance/duration on the page (private tour?)" },
      { status: 404 },
    )
  }
  const distanceKm = parseFloat(m[1])
  const hh = parseInt(m[2], 10)
  const mm = parseInt(m[3], 10)
  // Round hours to 2 decimal places so the value matches the rest of
  // the dataset (e.g. 5.25, 4.27) rather than 4.266666666….
  const hours = Math.round((hh + mm / 60) * 100) / 100

  // Elevation gain — first "elevation_up" in the JSON blob is the
  // tour total. Round to 2dp for clean storage.
  const elevMatch = ELEVATION_UP_RE.exec(html)
  const uphillMetres = elevMatch
    ? Math.round(parseFloat(elevMatch[1]) * 100) / 100
    : null

  // Difficulty — mapped to our three-value enum.
  const diffMatch = DIFFICULTY_RE.exec(html)
  let difficulty: "easy" | "moderate" | "hard" | null = null
  if (diffMatch) {
    const grade = diffMatch[1].toUpperCase()
    if (grade === "EASY") difficulty = "easy"
    else if (grade === "MODERATE") difficulty = "moderate"
    else difficulty = "hard" // HARD, DIFFICULT, EXPERT → hard
  }

  // Tour name — from og:title, stripping the " | hike | Komoot" suffix.
  // Decode HTML entities first so apostrophes etc. land as actual
  // characters, not literal "&#x27;" in the walk's name field.
  const titleMatch = OG_TITLE_RE.exec(html) || OG_TITLE_ALT_RE.exec(html)
  const name = titleMatch
    ? decodeHtmlEntities(titleMatch[1]).replace(/\s*\|.*$/, "").trim()
    : null

  // Waypoints — bucketed into destinationStops / lunchStops / sights.
  // Returns null when the page doesn't expose the way_points JSON
  // (very old tours, or pages that ship a different shape); the
  // admin UI treats null/missing as "no waypoints to merge in" and
  // applies the rest of the response normally.
  const waypoints = parseWaypoints(html, distanceKm)

  return NextResponse.json({ distanceKm, hours, uphillMetres, difficulty, name, waypoints })
}
