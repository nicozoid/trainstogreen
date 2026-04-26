// Fetches tube/walk connections between every pair of London terminals listed
// in data/london-terminals.json, and writes the results to data/terminal-matrix.json.
//
// This matrix lets the app construct journeys from ANY terminal to any destination
// WITHOUT fetching new per-destination data: we already have Kings Cross cluster
// journeys for every destination, and the KX journey identifies which mainline
// terminal that destination uses. lib/stitch-journey.ts then prepends a short
// tube hop from the user-selected terminal to the destination's mainline terminal,
// pulling the hop's duration + polyline from this matrix.
//
// Data source: TfL Unified API Journey Planner (https://api.tfl.gov.uk).
// Free, anonymous (no key needed at our scale — 210 pairs is well under
// the unauthenticated rate limit). Replaces the earlier Google Routes
// implementation, which was paid and produced equivalent data.
//
// Usage:
//   node scripts/fetch-terminal-matrix.mjs
//
// Flags:
//   --recompute    Re-fetch even if an entry already exists in terminal-matrix.json
//
// Safe to interrupt and re-run — existing entries are skipped unless --recompute.

import { readFileSync, writeFileSync, existsSync } from "fs"

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const RECOMPUTE = process.argv.includes("--recompute")

const TERMINALS_PATH = "data/london-terminals.json"
const MATRIX_PATH = "data/terminal-matrix.json"

const terminals = JSON.parse(readFileSync(TERMINALS_PATH, "utf-8"))

// Load existing matrix (resumable); initialise empty if missing.
const matrix = existsSync(MATRIX_PATH)
  ? JSON.parse(readFileSync(MATRIX_PATH, "utf-8"))
  : {}

// ---------------------------------------------------------------------------
// Terminal name → NaPTAN rail station ID
// ---------------------------------------------------------------------------
//
// TfL Journey Planner needs precise station IDs — passing names or "HUBxxx"
// codes triggers a disambiguator that returns no journeys. Each entry is
// the NaPTAN ID for the National Rail station component of the hub
// (prefix 910G, lookupable via /StopPoint/HUB{CRS}).
const NAME_TO_NAPTAN = {
  "Paddington":        "910GPADTON",
  "Kings Cross":       "910GKNGX",
  "St Pancras":        "910GSTPX",
  "Euston":            "910GEUSTON",
  "Victoria":          "910GVICTRIC",
  "Waterloo":          "910GWATRLMN",
  "Waterloo East":     "910GWLOE",
  "Liverpool Street":  "910GLIVST",
  "Marylebone":        "910GMARYLBN",
  "Charing Cross":     "910GCHRX",
  "London Bridge":     "910GLNDNBDC",
  "Blackfriars":       "910GBLFR",
  "Fenchurch Street":  "910GFENCHRS",
  "Cannon Street":     "910GCANONST",
  "Moorgate":          "910GMRGT",
}

// ---------------------------------------------------------------------------
// TfL Journey Planner
// ---------------------------------------------------------------------------

const TFL_BASE = "https://api.tfl.gov.uk"

// Pick a reference Saturday-morning departure — the same day-of-week the
// hike-finder app cares about. Date doesn't materially affect tube/walk
// hop times, but matching the rest of the codebase's "Saturday morning"
// convention keeps the data coherent.
function nextSaturdayDateString() {
  const d = new Date()
  const daysToSat = (6 - d.getDay() + 7) % 7 || 7  // 1..7 — never today
  d.setDate(d.getDate() + daysToSat)
  const yyyy = d.getFullYear()
  const mm = String(d.getMonth() + 1).padStart(2, "0")
  const dd = String(d.getDate()).padStart(2, "0")
  return `${yyyy}${mm}${dd}`
}

const QUERY_DATE = nextSaturdayDateString()
const QUERY_TIME = "0900"

async function fetchJourney(fromNaptan, toNaptan) {
  const url = `${TFL_BASE}/Journey/JourneyResults/${fromNaptan}/to/${toNaptan}?date=${QUERY_DATE}&time=${QUERY_TIME}&timeIs=Departing`
  const res = await fetch(url)
  if (!res.ok) {
    throw new Error(`TfL ${res.status} ${res.statusText} for ${fromNaptan}->${toNaptan}`)
  }
  const data = await res.json()
  const journeys = data.journeys || []
  if (journeys.length === 0) {
    throw new Error(`No journeys returned for ${fromNaptan}->${toNaptan}`)
  }
  // Sort by duration ascending — pick the fastest itinerary.
  journeys.sort((a, b) => a.duration - b.duration)
  return journeys[0]
}

// ---------------------------------------------------------------------------
// Polyline + mode helpers
// ---------------------------------------------------------------------------

// Encode an array of [lat, lng] pairs as a Google polyline5 string.
// Mirrors the algorithm in lib/stitch-journey.ts:decodePolyline so the
// round-trip is lossless to ~1m precision.
function encodePolyline(latlngs) {
  let out = ""
  let prevLat = 0, prevLng = 0
  for (const [lat, lng] of latlngs) {
    const latE5 = Math.round(lat * 1e5)
    const lngE5 = Math.round(lng * 1e5)
    out += encodeSigned(latE5 - prevLat) + encodeSigned(lngE5 - prevLng)
    prevLat = latE5
    prevLng = lngE5
  }
  return out
}
function encodeSigned(n) {
  let v = n < 0 ? ~(n << 1) : n << 1
  let out = ""
  while (v >= 0x20) {
    out += String.fromCharCode((0x20 | (v & 0x1f)) + 63)
    v >>= 5
  }
  out += String.fromCharCode(v + 63)
  return out
}

// TfL leg.path.lineString is a JSON-encoded array of [lat, lng] pairs.
// Concatenate every leg's points into one continuous coordinate stream
// before encoding — this matches the single-polyline-per-hop shape the
// stitcher consumes.
function concatJourneyCoords(journey) {
  const coords = []
  for (const leg of journey.legs) {
    const ls = leg.path?.lineString
    if (!ls) continue
    let pts
    try {
      pts = typeof ls === "string" ? JSON.parse(ls) : ls
    } catch {
      continue
    }
    if (!Array.isArray(pts)) continue
    // Avoid duplicating join points between consecutive legs.
    const start = coords.length > 0 ? 1 : 0
    for (let i = start; i < pts.length; i++) coords.push(pts[i])
  }
  return coords
}

// Map a TfL mode name to the {SUBWAY, HEAVY_RAIL, WALK, BUS} enum the
// existing matrix uses. Anything tube-like is SUBWAY (Mapbox renders
// underground/orbital lines together visually); national-rail is
// HEAVY_RAIL; bus and walk pass through; unknown modes default to SUBWAY
// because most central-London hops are.
function mapMode(tflMode) {
  switch (tflMode) {
    case "tube":
    case "elizabeth-line":
    case "overground":
    case "dlr":
    case "tram":
      return "SUBWAY"
    case "national-rail":
      return "HEAVY_RAIL"
    case "walking":
      return "WALK"
    case "bus":
    case "river-bus":
      return "BUS"
    default:
      return "SUBWAY"
  }
}

// Derive the matrix entry's single vehicleType from a multi-leg journey.
// Heuristic: ignore walking legs if any non-walking leg exists, then pick
// the longest non-walking leg's mode. If all legs are walking, return WALK.
function dominantVehicleType(journey) {
  const legs = journey.legs || []
  const transit = legs.filter(l => l.mode?.name && l.mode.name !== "walking")
  if (transit.length === 0) return "WALK"
  transit.sort((a, b) => (b.duration ?? 0) - (a.duration ?? 0))
  return mapMode(transit[0].mode.name)
}

// ---------------------------------------------------------------------------
// Main loop
// ---------------------------------------------------------------------------

async function fetchPair(from, to) {
  const fromNaptan = NAME_TO_NAPTAN[from.name]
  const toNaptan = NAME_TO_NAPTAN[to.name]
  if (!fromNaptan || !toNaptan) {
    throw new Error(`Missing NaPTAN for ${from.name} or ${to.name}`)
  }
  const journey = await fetchJourney(fromNaptan, toNaptan)
  const coords = concatJourneyCoords(journey)
  return {
    minutes: journey.duration,
    polyline: coords.length > 1 ? encodePolyline(coords) : null,
    vehicleType: dominantVehicleType(journey),
  }
}

let fetched = 0
let skipped = 0
let failed = 0

for (const from of terminals) {
  if (!matrix[from.name]) matrix[from.name] = {}
  for (const to of terminals) {
    if (from.name === to.name) continue
    if (!RECOMPUTE && matrix[from.name][to.name]) {
      skipped++
      continue
    }
    try {
      const entry = await fetchPair(from, to)
      matrix[from.name][to.name] = entry
      fetched++
      console.log(`  ${from.name} -> ${to.name}: ${entry.minutes}min ${entry.vehicleType}`)
      // Persist after each successful fetch so an interruption keeps progress.
      writeFileSync(MATRIX_PATH, JSON.stringify(matrix, null, 2))
      // Light pacing to stay well under TfL's unauthenticated rate limits.
      await new Promise(r => setTimeout(r, 100))
    } catch (err) {
      failed++
      console.warn(`  ! ${from.name} -> ${to.name}: ${err.message}`)
    }
  }
}

console.log(`\nDone. fetched=${fetched} skipped=${skipped} failed=${failed}`)
console.log(`Matrix size: ${Object.keys(matrix).length} origins, ${Object.values(matrix).reduce((n, v) => n + Object.keys(v).length, 0)} entries.`)
