// Fetches TfL Journey Planner itineraries from a non-terminal primary
// station (e.g. Clapham Junction) to each of the 15 canonical London
// termini, and writes the results to data/tfl-hop-matrix.json.
//
// Why this exists: lib/stitch-journey.ts composes journeys for non-Central
// primaries by combining the primary's RTT direct-rail data with hops to
// other London termini. terminal-matrix.json only carries terminal↔terminal
// hops; this file fills in the parallel primary→terminal layer for
// primaries CLJ doesn't reach by direct rail (KGX, MYB, EUS, MOG, etc.).
//
// Data source: TfL Unified API Journey Planner (free, anonymous). Same
// pipeline as scripts/fetch-terminal-matrix.mjs — see that file for the
// rationale on TfL vs Google. Output shape mirrors terminal-matrix so the
// stitcher can read both files interchangeably.
//
// Usage:
//   node scripts/fetch-tfl-hops.mjs --primary CLJ
//
// Flags:
//   --primary CRS     Required. The primary station's CRS code.
//   --recompute       Re-fetch even if entries already exist.
//
// Safe to interrupt and re-run — existing entries are skipped unless --recompute.

import { readFileSync, writeFileSync, existsSync } from "fs"

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const args = process.argv.slice(2)
const primaryIdx = args.indexOf("--primary")
const PRIMARY_CRS = primaryIdx >= 0 ? args[primaryIdx + 1] : null
const RECOMPUTE = args.includes("--recompute")

if (!PRIMARY_CRS) {
  console.error("Error: --primary CRS is required (e.g. --primary CLJ)")
  process.exit(1)
}

const TERMINALS_PATH = "data/london-terminals.json"
const HOPS_PATH = "data/tfl-hop-matrix.json"

const terminals = JSON.parse(readFileSync(TERMINALS_PATH, "utf-8"))
const hopMatrix = existsSync(HOPS_PATH)
  ? JSON.parse(readFileSync(HOPS_PATH, "utf-8"))
  : {}

// ---------------------------------------------------------------------------
// Primary station metadata (CRS → name + NaPTAN rail station ID)
// ---------------------------------------------------------------------------
//
// Add an entry here when promoting a new station to a non-terminal primary.
// The display name must match the station's `name` in data/origin-routes.json
// so the hop matrix integrates with the existing matrix-lookup paths.
const PRIMARY_STATIONS = {
  CLJ: { name: "Clapham Junction", naptan: "910GCLPHMJC" },
  // Future entries:
  // ECR: { name: "East Croydon",     naptan: "910GECROYDN" },
  // FPK: { name: "Finsbury Park",    naptan: "910GFNSBYP"  },
  // RMD: { name: "Richmond",         naptan: "910GRICHMND" },
}

const primary = PRIMARY_STATIONS[PRIMARY_CRS]
if (!primary) {
  console.error(`Error: ${PRIMARY_CRS} is not a known primary. Add it to PRIMARY_STATIONS in this script.`)
  process.exit(1)
}

// ---------------------------------------------------------------------------
// Terminal name → NaPTAN rail station ID (mirrored from fetch-terminal-matrix.mjs)
// ---------------------------------------------------------------------------
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

function nextSaturdayDateString() {
  const d = new Date()
  const daysToSat = (6 - d.getDay() + 7) % 7 || 7
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
  journeys.sort((a, b) => a.duration - b.duration)
  return journeys[0]
}

// ---------------------------------------------------------------------------
// Polyline + mode helpers (mirrored from fetch-terminal-matrix.mjs)
// ---------------------------------------------------------------------------

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

function concatJourneyCoords(journey) {
  const coords = []
  for (const leg of journey.legs) {
    const ls = leg.path?.lineString
    if (!ls) continue
    let pts
    try { pts = typeof ls === "string" ? JSON.parse(ls) : ls } catch { continue }
    if (!Array.isArray(pts)) continue
    const start = coords.length > 0 ? 1 : 0
    for (let i = start; i < pts.length; i++) coords.push(pts[i])
  }
  return coords
}

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

function dominantVehicleType(journey) {
  const legs = journey.legs || []
  const transit = legs.filter(l => l.mode?.name && l.mode.name !== "walking")
  if (transit.length === 0) return "WALK"
  transit.sort((a, b) => (b.duration ?? 0) - (a.duration ?? 0))
  return mapMode(transit[0].mode.name)
}

// ---------------------------------------------------------------------------
// Main loop — fetch primary → each terminal
// ---------------------------------------------------------------------------

async function fetchHop(toName, toNaptan) {
  const journey = await fetchJourney(primary.naptan, toNaptan)
  const coords = concatJourneyCoords(journey)
  return {
    minutes: journey.duration,
    polyline: coords.length > 1 ? encodePolyline(coords) : null,
    vehicleType: dominantVehicleType(journey),
  }
}

if (!hopMatrix[primary.name]) hopMatrix[primary.name] = {}

let fetched = 0
let skipped = 0
let failed = 0

console.log(`Fetching TfL hops from ${primary.name} (${PRIMARY_CRS}) to 15 termini...\n`)

for (const t of terminals) {
  const naptan = NAME_TO_NAPTAN[t.name]
  if (!naptan) {
    console.warn(`  ! Skipping ${t.name} — no NaPTAN mapping`)
    failed++
    continue
  }
  if (!RECOMPUTE && hopMatrix[primary.name][t.name]) {
    skipped++
    continue
  }
  try {
    const entry = await fetchHop(t.name, naptan)
    hopMatrix[primary.name][t.name] = entry
    fetched++
    console.log(`  ${primary.name} -> ${t.name}: ${entry.minutes}min ${entry.vehicleType}`)
    writeFileSync(HOPS_PATH, JSON.stringify(hopMatrix, null, 2))
    await new Promise(r => setTimeout(r, 100))
  } catch (err) {
    failed++
    console.warn(`  ! ${primary.name} -> ${t.name}: ${err.message}`)
  }
}

console.log(`\nDone. fetched=${fetched} skipped=${skipped} failed=${failed}`)
console.log(`Hop matrix size: ${Object.keys(hopMatrix).length} primaries, ${Object.values(hopMatrix).reduce((n, v) => n + Object.keys(v).length, 0)} entries.`)
