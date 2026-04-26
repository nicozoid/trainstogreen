// Fetches TfL Journey Planner itineraries from a non-terminal primary
// station (e.g. Clapham Junction) to each of the 15 canonical London
// termini, and writes the results to data/tfl-hop-matrix.json.
//
// Why this exists: lib/stitch-journey.ts composes journeys for non-Central
// primaries by combining the primary's RTT direct-rail data with hops to
// other London termini. terminal-matrix.json only carries terminal↔terminal
// hops; this file fills in the parallel primary→terminal layer for
// primaries that don't reach every terminal by direct rail (most non-
// central NR stations).
//
// Data source: TfL Unified API Journey Planner (free, anonymous). Same
// pipeline as scripts/fetch-terminal-matrix.mjs. Output shape mirrors
// terminal-matrix so the stitcher can read both files interchangeably.
//
// CRS → NaPTAN resolution: looks up data/crs-to-naptan.json first, then
// falls back to TfL StopPoint Search. New entries are persisted back to
// the cache so future runs are zero-network for known stations.
//
// Station name (matrix key) is taken from the primary's entry in
// data/origin-routes.json — must match what coordToName[primaryOrigin]
// produces in components/map.tsx so the runtime lookup hits.
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
const ORIGIN_ROUTES_PATH = "data/origin-routes.json"
const NAPTAN_CACHE_PATH = "data/crs-to-naptan.json"

const terminals = JSON.parse(readFileSync(TERMINALS_PATH, "utf-8"))
const hopMatrix = existsSync(HOPS_PATH)
  ? JSON.parse(readFileSync(HOPS_PATH, "utf-8"))
  : {}
const originRoutes = JSON.parse(readFileSync(ORIGIN_ROUTES_PATH, "utf-8"))
const naptanCache = JSON.parse(readFileSync(NAPTAN_CACHE_PATH, "utf-8"))

// ---------------------------------------------------------------------------
// Resolve primary CRS → name + NaPTAN
// ---------------------------------------------------------------------------

// Find the primary station's name from origin-routes (the matrix is keyed
// by station name, and the runtime resolves coordToName[primaryOrigin]
// against this same source — names must align).
function resolvePrimaryName(crs) {
  for (const entry of Object.values(originRoutes)) {
    if (entry?.crs === crs) return entry.name
  }
  return null
}

const PRIMARY_NAME = resolvePrimaryName(PRIMARY_CRS)
if (!PRIMARY_NAME) {
  console.error(`Error: ${PRIMARY_CRS} not in data/origin-routes.json — fetch its RTT data first.`)
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
// TfL StopPoint Search → NaPTAN (with caching)
// ---------------------------------------------------------------------------

const TFL_BASE = "https://api.tfl.gov.uk"

// Wrap fetch with retry-on-429 — TfL's anonymous rate limit is rolling-
// window, so a brief pause after a 429 lets the next call through.
async function fetchWithRetry(url, attempt = 0) {
  const res = await fetch(url)
  if (res.status === 429 && attempt < 4) {
    const wait = 5000 + attempt * 5000  // 5s, 10s, 15s, 20s
    console.warn(`  (rate-limited, waiting ${wait / 1000}s before retry…)`)
    await new Promise((r) => setTimeout(r, wait))
    return fetchWithRetry(url, attempt + 1)
  }
  return res
}

// Pick the best match from TfL's StopPoint Search results. The API
// often returns near-name matches first ("Luton Airport Parkway" before
// "Luton" when searching for "Luton"), so prefer the entry whose
// normalised name matches the search term exactly. Fallback: shortest
// name (most likely the principal station, not a longer sub-variant).
function pickBestNaptanMatch(matches, name) {
  const norm = (s) =>
    (s ?? "").toLowerCase().replace(/[^a-z0-9 ]/g, "").replace(/\s+/g, " ").trim()
  const target = norm(name)
  for (const m of matches) {
    const mn = norm(m.name ?? "")
    if (mn === target) return m
    if (mn === `${target} rail station`) return m
    if (mn === `london ${target}` || mn === `london ${target} rail station`) return m
  }
  return [...matches].sort((a, b) => (a.name?.length ?? 999) - (b.name?.length ?? 999))[0]
}

async function resolveNaptanForCrs(crs, name) {
  if (naptanCache.naptan[crs]) return naptanCache.naptan[crs]
  // Search by name, filtering to national-rail stops. Returns a HUB id
  // for stations with multiple modes (HUBxxx) or a 910Gxxx directly for
  // smaller stations.
  const url = `${TFL_BASE}/StopPoint/Search/${encodeURIComponent(name)}?modes=national-rail`
  const res = await fetchWithRetry(url)
  if (!res.ok) throw new Error(`StopPoint search failed for ${name} (${crs}): ${res.status}`)
  const data = await res.json()
  const matches = data.matches ?? []
  if (matches.length === 0) throw new Error(`No StopPoint match for ${name} (${crs})`)
  const top = pickBestNaptanMatch(matches, name)
  let naptan = top.id
  // If top match is a HUB, drill into its children for the 910G rail entry.
  if (naptan.startsWith("HUB")) {
    const hubRes = await fetchWithRetry(`${TFL_BASE}/StopPoint/${naptan}`)
    if (!hubRes.ok) throw new Error(`Hub fetch failed for ${naptan}`)
    const hubData = await hubRes.json()
    const railChild = (hubData.children ?? []).find(
      (c) => c.id?.startsWith("910G") && c.modes?.includes("national-rail"),
    )
    if (!railChild) throw new Error(`Hub ${naptan} has no 910G rail child`)
    naptan = railChild.id
  } else if (!naptan.startsWith("910G")) {
    throw new Error(`Unexpected StopPoint id format: ${naptan} for ${name} (${crs})`)
  }
  naptanCache.naptan[crs] = naptan
  writeFileSync(NAPTAN_CACHE_PATH, JSON.stringify(naptanCache, null, 2) + "\n")
  return naptan
}

// ---------------------------------------------------------------------------
// TfL Journey Planner
// ---------------------------------------------------------------------------

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
  const res = await fetchWithRetry(url)
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

async function fetchHop(fromNaptan, toName, toNaptan) {
  const journey = await fetchJourney(fromNaptan, toNaptan)
  const coords = concatJourneyCoords(journey)
  return {
    minutes: journey.duration,
    polyline: coords.length > 1 ? encodePolyline(coords) : null,
    vehicleType: dominantVehicleType(journey),
  }
}

const primaryNaptan = await resolveNaptanForCrs(PRIMARY_CRS, PRIMARY_NAME)

if (!hopMatrix[PRIMARY_NAME]) hopMatrix[PRIMARY_NAME] = {}

let fetched = 0
let skipped = 0
let failed = 0

console.log(`Fetching TfL hops from ${PRIMARY_NAME} (${PRIMARY_CRS}, NaPTAN ${primaryNaptan}) to 15 termini...\n`)

for (const t of terminals) {
  const naptan = NAME_TO_NAPTAN[t.name]
  if (!naptan) {
    console.warn(`  ! Skipping ${t.name} — no NaPTAN mapping`)
    failed++
    continue
  }
  if (!RECOMPUTE && hopMatrix[PRIMARY_NAME][t.name]) {
    skipped++
    continue
  }
  try {
    const entry = await fetchHop(primaryNaptan, t.name, naptan)
    hopMatrix[PRIMARY_NAME][t.name] = entry
    fetched++
    console.log(`  ${PRIMARY_NAME} -> ${t.name}: ${entry.minutes}min ${entry.vehicleType}`)
    writeFileSync(HOPS_PATH, JSON.stringify(hopMatrix, null, 2))
    // Pace at ~40 calls/min — under TfL's 50-req/min anonymous cap.
    await new Promise(r => setTimeout(r, 1500))
  } catch (err) {
    failed++
    console.warn(`  ! ${PRIMARY_NAME} -> ${t.name}: ${err.message}`)
  }
}

console.log(`\nDone. fetched=${fetched} skipped=${skipped} failed=${failed}`)
console.log(`Hop matrix size: ${Object.keys(hopMatrix).length} primaries, ${Object.values(hopMatrix).reduce((n, v) => n + Object.keys(v).length, 0)} entries.`)
