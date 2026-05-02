#!/usr/bin/env node
// Extracts rail-edge polylines from existing per-origin Google Routes journey
// files and writes a deduplicated segment library at data/rail-segments.json.
//
// For each (origin, destination) journey in public/journeys/*.json:
//   1. Decode the journey's encoded polyline.
//   2. Snap each leg's dep/arr station coords onto the polyline, monotonically,
//      to find each leg's sub-polyline.
//   3. For HEAVY_RAIL legs only, look up the calling-points sequence in
//      data/origin-routes.json[depCoord].directReachable[arrCoord].fastestCallingPoints.
//   4. Snap each calling-point CRS to the leg's sub-polyline (monotonic),
//      slice into per-pair segments, simplify (DP tol=0.0005, round 5dp),
//      and store under "fromCRS-toCRS" in the segment library.
//
// Also writes data/rail-segments-missing.json: the list of unique adjacent
// CRS pairs from origin-routes that the extractor couldn't recover, i.e. the
// API top-up queue.
//
// Usage: node scripts/extract-rail-segments.mjs
//
// Outputs:
//   data/rail-segments.json         — { "FRO-TRO": { polyline, source, snapMetres, …}, … }
//   data/rail-segments-missing.json — { missing: ["PAD-RDG", …], notes: { … } }

import { readFileSync, writeFileSync, readdirSync } from "node:fs"
import path from "node:path"

const REPO = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..")
const JOURNEYS_DIR = path.join(REPO, "public", "journeys")
const STATIONS_PATH = path.join(REPO, "public", "stations.json")
const ORIGIN_ROUTES_PATH = path.join(REPO, "data", "origin-routes.json")
const OUT_SEGMENTS = path.join(REPO, "data", "rail-segments.json")
const OUT_MISSING = path.join(REPO, "data", "rail-segments-missing.json")

// Snap-distance limits in degrees-squared (approx). 0.001 deg ≈ 110m at the
// equator; we use squared values to avoid sqrts in the hot loop.
const MAX_SNAP_DIST_SQ_LEG = 0.01 * 0.01     // 1.1km — leg endpoint must be near polyline
const MAX_SNAP_DIST_SQ_CP  = 0.005 * 0.005   // 550m — calling point must be very near polyline
const SIMPLIFY_TOL = 0.0005                  // matches map.tsx buildDiff compromise

// ---------------------------------------------------------------------------
// Polyline encoding/decoding (Google polyline5)
// ---------------------------------------------------------------------------

function decodePolyline(encoded) {
  const coords = []
  let i = 0, lat = 0, lng = 0
  while (i < encoded.length) {
    for (const apply of [(v) => { lat += v }, (v) => { lng += v }]) {
      let shift = 0, result = 0, byte
      do {
        byte = encoded.charCodeAt(i++) - 63
        result |= (byte & 0x1f) << shift
        shift += 5
      } while (byte >= 0x20)
      apply(result & 1 ? ~(result >> 1) : result >> 1)
    }
    coords.push([lng / 1e5, lat / 1e5])
  }
  return coords
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

// Encode [lng, lat] pairs (our internal order) — flip to [lat, lng] for the wire format.
function encodePolyline(coords) {
  let out = "", prevLat = 0, prevLng = 0
  for (const [lng, lat] of coords) {
    const latE5 = Math.round(lat * 1e5)
    const lngE5 = Math.round(lng * 1e5)
    out += encodeSigned(latE5 - prevLat) + encodeSigned(lngE5 - prevLng)
    prevLat = latE5
    prevLng = lngE5
  }
  return out
}

// ---------------------------------------------------------------------------
// Geometry
// ---------------------------------------------------------------------------

// Project a point onto a polyline, optionally constrained to start at fromIdx.
// Returns { idx, t, distSq, projCoord } where:
//   idx is the polyline segment containing the projection (between coords[idx]..coords[idx+1])
//   t is the position along that segment (0..1)
//   distSq is squared distance from point to projected point (degrees²)
//   projCoord is the projected [lng, lat]
function projectOntoPolyline(coords, point, fromIdx = 0) {
  let best = { idx: fromIdx, t: 0, distSq: Infinity, projCoord: coords[fromIdx] }
  for (let i = fromIdx; i < coords.length - 1; i++) {
    const [x0, y0] = coords[i]
    const [x1, y1] = coords[i + 1]
    const dx = x1 - x0, dy = y1 - y0
    const segLenSq = dx * dx + dy * dy
    let t, px, py
    if (segLenSq === 0) { t = 0; px = x0; py = y0 }
    else {
      t = ((point[0] - x0) * dx + (point[1] - y0) * dy) / segLenSq
      t = Math.max(0, Math.min(1, t))
      px = x0 + t * dx
      py = y0 + t * dy
    }
    const ex = point[0] - px, ey = point[1] - py
    const d = ex * ex + ey * ey
    if (d < best.distSq) best = { idx: i, t, distSq: d, projCoord: [px, py] }
  }
  return best
}

// Slice polyline between two projected positions (inclusive of projected endpoints).
function slicePolyline(coords, p1, p2) {
  if (p1.idx > p2.idx || (p1.idx === p2.idx && p1.t > p2.t)) return null
  const out = [p1.projCoord]
  for (let i = p1.idx + 1; i <= p2.idx; i++) out.push(coords[i])
  // Avoid duplicating end vertex if p2 falls exactly on coords[p2.idx]
  const last = out[out.length - 1]
  const p2c = p2.projCoord
  if (last[0] !== p2c[0] || last[1] !== p2c[1]) out.push(p2c)
  return out
}

// Iterative Douglas-Peucker. Same algorithm as map.tsx:simplifyPolyline.
function simplifyPolyline(coords, tol) {
  if (coords.length <= 2) return coords
  const tolSq = tol * tol
  const keep = new Uint8Array(coords.length)
  keep[0] = 1
  keep[coords.length - 1] = 1
  const stack = [[0, coords.length - 1]]
  while (stack.length > 0) {
    const [iStart, iEnd] = stack.pop()
    if (iEnd - iStart < 2) continue
    const [x0, y0] = coords[iStart]
    const [x1, y1] = coords[iEnd]
    const dx = x1 - x0, dy = y1 - y0
    const segLenSq = dx * dx + dy * dy
    let maxDistSq = 0, maxIdx = iStart
    for (let i = iStart + 1; i < iEnd; i++) {
      const [px, py] = coords[i]
      let distSq
      if (segLenSq === 0) {
        const ex = px - x0, ey = py - y0
        distSq = ex * ex + ey * ey
      } else {
        const t = ((px - x0) * dx + (py - y0) * dy) / segLenSq
        const tc = Math.max(0, Math.min(1, t))
        const cx = x0 + tc * dx, cy = y0 + tc * dy
        const ex = px - cx, ey = py - cy
        distSq = ex * ex + ey * ey
      }
      if (distSq > maxDistSq) { maxDistSq = distSq; maxIdx = i }
    }
    if (maxDistSq > tolSq) {
      keep[maxIdx] = 1
      stack.push([iStart, maxIdx])
      stack.push([maxIdx, iEnd])
    }
  }
  const out = []
  for (let i = 0; i < coords.length; i++) if (keep[i]) out.push(coords[i])
  return out
}

const round5 = (c) => [Math.round(c[0] * 1e5) / 1e5, Math.round(c[1] * 1e5) / 1e5]

// ---------------------------------------------------------------------------
// Lookups
// ---------------------------------------------------------------------------

const stations = JSON.parse(readFileSync(STATIONS_PATH, "utf-8"))
const originRoutes = JSON.parse(readFileSync(ORIGIN_ROUTES_PATH, "utf-8"))

// CRS -> [lng, lat] (one per CRS — assumed unique).
const crsToCoord = new Map()
// CRS -> name (for friendly logging).
const crsToName = new Map()
// lowercased name -> array of [lng, lat] (for resolving leg dep/arr station names).
// Kept as an array because some names are shared — disambiguate against the
// polyline endpoint at lookup time.
const nameToCoords = new Map()

for (const f of stations.features) {
  const name = f.properties?.name
  const crs = f.properties?.["ref:crs"]
  const coords = f.geometry?.coordinates
  if (!Array.isArray(coords)) continue
  const [lng, lat] = coords
  if (crs && !crsToCoord.has(crs)) {
    crsToCoord.set(crs, [lng, lat])
    if (name) crsToName.set(crs, name)
  }
  if (name) {
    const k = name.toLowerCase()
    const arr = nameToCoords.get(k) ?? []
    arr.push([lng, lat])
    nameToCoords.set(k, arr)
  }
}

// Google's leg.departureStation/arrivalStation names sometimes differ slightly
// from OSM's (e.g. "London Paddington" vs "Paddington"). This map captures the
// known mismatches we hit during the spike — extend as needed.
const NAME_ALIASES = {
  "london paddington": "paddington",
  "london king's cross": "kings cross",
  "london kings cross": "kings cross",
  "london st pancras international": "st pancras international",
  "london st. pancras international": "st pancras international",
  "london euston": "euston",
  "london victoria": "victoria",
  "london waterloo": "waterloo",
  "london waterloo east": "waterloo east",
  "london liverpool street": "liverpool street",
  "london fenchurch street": "fenchurch street",
  "london bridge": "london bridge",
  "london cannon street": "cannon street",
  "london blackfriars": "blackfriars",
  "london charing cross": "charing cross",
  "london marylebone": "marylebone",
  "london moorgate": "moorgate",
  "kings cross": "king's cross",
  "kings cross st pancras": "king's cross",
}

function resolveStationCoord(rawName, hint) {
  if (!rawName) return null
  let key = rawName.toLowerCase().trim()
  if (NAME_ALIASES[key]) key = NAME_ALIASES[key]
  // First try exact (alias-corrected) match.
  let candidates = nameToCoords.get(key)
  if (!candidates) {
    // Try stripping a leading "London " (Google often prefixes it).
    if (key.startsWith("london ")) candidates = nameToCoords.get(key.slice("london ".length))
  }
  if (!candidates || candidates.length === 0) return null
  if (candidates.length === 1 || !hint) return candidates[0]
  // Disambiguate by proximity to a hint coord (e.g. nearest polyline point).
  let best = candidates[0], bestD = Infinity
  for (const c of candidates) {
    const d = (c[0] - hint[0]) ** 2 + (c[1] - hint[1]) ** 2
    if (d < bestD) { bestD = d; best = c }
  }
  return best
}

// Build the universe of unique CRS pairs from origin-routes calling-points.
// Each pair stores how many times it appeared (popularity, useful for ordering
// the API top-up queue) and a sample (origin, dest) for debugging.
const universe = new Map() // "A-B" -> { count, sampleOriginCrs, sampleDestCoord }
for (const o of Object.values(originRoutes)) {
  const oCrs = o.crs
  for (const [destCoord, dr] of Object.entries(o.directReachable || {})) {
    const cp = dr.fastestCallingPoints || []
    for (let i = 0; i < cp.length - 1; i++) {
      const k = `${cp[i]}-${cp[i + 1]}`
      const ent = universe.get(k) ?? { count: 0, sampleOriginCrs: oCrs, sampleDestCoord: destCoord }
      ent.count += 1
      universe.set(k, ent)
    }
  }
}

// ---------------------------------------------------------------------------
// Extraction
// ---------------------------------------------------------------------------

// Segment library: "fromCRS-toCRS" -> { polyline, source, snapMetres, points }
// On collision we keep the one with the smaller worst-case snap distance.
const segments = new Map()

const stats = {
  journeyFiles: 0,
  journeysScanned: 0,
  journeysSkipped: 0,
  legsScanned: 0,
  legsHeavyRail: 0,
  legsTubeOrWalk: 0,
  legsLegBoundsFailed: 0,
  legsCpLookupFailed: 0,
  legsCpResolveFailed: 0,
  legsExtracted: 0,
  segmentsCreated: 0,
  segmentsImproved: 0,
}

// Helpers
const coordKey = (c) => `${c[0]},${c[1]}`
const eqCoord = (a, b) => a[0] === b[0] && a[1] === b[1]

function tryStoreSegment(fromCrs, toCrs, sliceCoords, snapDistSqMax) {
  if (!sliceCoords || sliceCoords.length < 2) return
  const simplified = simplifyPolyline(sliceCoords, SIMPLIFY_TOL).map(round5)
  if (simplified.length < 2) return
  const key = `${fromCrs}-${toCrs}`
  const snapMetres = Math.sqrt(snapDistSqMax) * 111000
  const existing = segments.get(key)
  if (!existing) {
    segments.set(key, {
      polyline: encodePolyline(simplified),
      source: "google",
      points: simplified.length,
      snapMetres: Math.round(snapMetres),
    })
    stats.segmentsCreated += 1
  } else if (snapMetres < existing.snapMetres) {
    segments.set(key, {
      polyline: encodePolyline(simplified),
      source: "google",
      points: simplified.length,
      snapMetres: Math.round(snapMetres),
    })
    stats.segmentsImproved += 1
  }
}

function extractFromJourney(journey, originCoord, destCoord) {
  if (!journey.polyline) return
  const fullCoords = decodePolyline(journey.polyline)
  if (fullCoords.length < 2) return
  const legs = Array.isArray(journey.legs) ? journey.legs : []
  if (legs.length === 0) return

  // First pass: locate each leg's [start, end] projection on the full polyline.
  // Use the journey origin as the leg-1 start anchor and the journey dest as
  // the leg-N end anchor — both are exact, no name lookup needed.
  const legBounds = []
  let cursorIdx = 0
  for (let li = 0; li < legs.length; li++) {
    const leg = legs[li]
    let depCoord, arrCoord
    if (li === 0) depCoord = originCoord
    else depCoord = resolveStationCoord(leg.departureStation, fullCoords[cursorIdx])
    if (li === legs.length - 1) arrCoord = destCoord
    else arrCoord = resolveStationCoord(leg.arrivalStation, fullCoords[Math.min(cursorIdx + 10, fullCoords.length - 1)])
    if (!depCoord || !arrCoord) {
      stats.legsLegBoundsFailed += 1
      legBounds.push(null)
      continue
    }
    const startProj = projectOntoPolyline(fullCoords, depCoord, cursorIdx)
    if (startProj.distSq > MAX_SNAP_DIST_SQ_LEG) {
      stats.legsLegBoundsFailed += 1
      legBounds.push(null)
      continue
    }
    const endProj = projectOntoPolyline(fullCoords, arrCoord, startProj.idx)
    if (endProj.distSq > MAX_SNAP_DIST_SQ_LEG) {
      stats.legsLegBoundsFailed += 1
      legBounds.push(null)
      continue
    }
    legBounds.push({ startProj, endProj, depCoord, arrCoord })
    cursorIdx = endProj.idx
  }

  // Second pass: for each HEAVY_RAIL leg with bounds, look up calling-points
  // and slice within the leg's sub-polyline.
  for (let li = 0; li < legs.length; li++) {
    const leg = legs[li]
    stats.legsScanned += 1
    if (leg.vehicleType !== "HEAVY_RAIL") {
      stats.legsTubeOrWalk += 1
      continue
    }
    stats.legsHeavyRail += 1
    const bounds = legBounds[li]
    if (!bounds) continue

    // Slice out this leg's polyline.
    const legCoords = slicePolyline(fullCoords, bounds.startProj, bounds.endProj)
    if (!legCoords || legCoords.length < 2) continue

    // Look up calling-points: origin-routes is keyed by depCoord, directReachable
    // by arrCoord (both as "lng,lat" strings).
    const depKey = coordKey(bounds.depCoord)
    const arrKey = coordKey(bounds.arrCoord)
    const orEntry = originRoutes[depKey]
    if (!orEntry) { stats.legsCpLookupFailed += 1; continue }
    const dr = orEntry.directReachable?.[arrKey]
    if (!dr) { stats.legsCpLookupFailed += 1; continue }
    const cp = dr.fastestCallingPoints || []
    if (cp.length < 2) { stats.legsCpLookupFailed += 1; continue }

    // Resolve CRS sequence to coords; bail if any unknown.
    const cpCoords = cp.map((crs) => crsToCoord.get(crs))
    if (cpCoords.some((c) => !c)) { stats.legsCpResolveFailed += 1; continue }

    // Snap each calling point to the leg sub-polyline, monotonically.
    let cursor = 0
    const projs = []
    let worstSnap = 0
    let snapFailed = false
    for (const c of cpCoords) {
      const p = projectOntoPolyline(legCoords, c, cursor)
      if (p.distSq > MAX_SNAP_DIST_SQ_CP) { snapFailed = true; break }
      if (p.distSq > worstSnap) worstSnap = p.distSq
      projs.push(p)
      cursor = p.idx
    }
    if (snapFailed) { stats.legsCpResolveFailed += 1; continue }

    // Slice into per-pair segments.
    for (let i = 0; i < cp.length - 1; i++) {
      const slice = slicePolyline(legCoords, projs[i], projs[i + 1])
      tryStoreSegment(cp[i], cp[i + 1], slice, worstSnap)
    }
    stats.legsExtracted += 1
  }
}

// ---------------------------------------------------------------------------
// Main loop
// ---------------------------------------------------------------------------

const journeyFiles = readdirSync(JOURNEYS_DIR).filter((f) => f.endsWith(".json")).sort()
console.log(`Scanning ${journeyFiles.length} journey files…`)

for (const file of journeyFiles) {
  stats.journeyFiles += 1
  const data = JSON.parse(readFileSync(path.join(JOURNEYS_DIR, file), "utf-8"))
  const originCoord = data.origin.split(",").map(Number)
  for (const [destCoordKey, journey] of Object.entries(data.journeys)) {
    stats.journeysScanned += 1
    if (!journey.polyline || !Array.isArray(journey.legs)) {
      stats.journeysSkipped += 1
      continue
    }
    const destCoord = destCoordKey.split(",").map(Number)
    extractFromJourney(journey, originCoord, destCoord)
  }
}

// ---------------------------------------------------------------------------
// Coverage report
// ---------------------------------------------------------------------------

const covered = []
const missing = []
for (const [pair, info] of universe.entries()) {
  if (segments.has(pair)) covered.push(pair)
  else missing.push({ pair, count: info.count, sampleOriginCrs: info.sampleOriginCrs })
}
missing.sort((a, b) => b.count - a.count)

const report = {
  scanned: stats,
  segmentsExtracted: segments.size,
  universeSize: universe.size,
  coveragePct: ((100 * covered.length) / universe.size).toFixed(1),
  missingCount: missing.length,
  missingTopByPopularity: missing.slice(0, 30),
}

console.log("\n=== Spike report ===")
console.log(JSON.stringify(report.scanned, null, 2))
console.log(`\nSegments extracted: ${segments.size}`)
console.log(`Universe of unique adjacent pairs in origin-routes: ${universe.size}`)
console.log(`Coverage: ${covered.length}/${universe.size} = ${report.coveragePct}%`)
console.log(`Missing (need API top-up): ${missing.length}`)
console.log(`\nTop 10 missing pairs by popularity:`)
for (const m of missing.slice(0, 10)) {
  const a = crsToName.get(m.pair.split("-")[0]) ?? m.pair.split("-")[0]
  const b = crsToName.get(m.pair.split("-")[1]) ?? m.pair.split("-")[1]
  console.log(`  ${m.pair.padEnd(12)} ${a} → ${b} (${m.count} journeys)`)
}

// Snap-distance distribution (sanity check)
const snapBuckets = { "0-50m": 0, "50-100m": 0, "100-200m": 0, "200-500m": 0, "500m+": 0 }
for (const v of segments.values()) {
  if (v.snapMetres < 50) snapBuckets["0-50m"]++
  else if (v.snapMetres < 100) snapBuckets["50-100m"]++
  else if (v.snapMetres < 200) snapBuckets["100-200m"]++
  else if (v.snapMetres < 500) snapBuckets["200-500m"]++
  else snapBuckets["500m+"]++
}
console.log(`\nWorst-case snap distance per segment:`)
for (const [k, v] of Object.entries(snapBuckets)) console.log(`  ${k.padEnd(10)} ${v}`)

// ---------------------------------------------------------------------------
// Write outputs
// ---------------------------------------------------------------------------

const segmentsObj = Object.fromEntries(
  [...segments.entries()].sort(([a], [b]) => a.localeCompare(b))
)
writeFileSync(OUT_SEGMENTS, JSON.stringify(segmentsObj, null, 2))
const segBytes = JSON.stringify(segmentsObj).length
console.log(`\nWrote ${OUT_SEGMENTS} (${(segBytes / 1024 / 1024).toFixed(2)} MB)`)

const missingObj = {
  generatedAt: new Date().toISOString(),
  universeSize: universe.size,
  coveragePct: report.coveragePct,
  missing,
  notes: {
    schema: "missing[i].pair = 'fromCRS-toCRS', count = #journeys traversing it",
    topUp: "feed missing pairs to scripts/fetch-rail-segments.mjs (TODO)",
  },
}
writeFileSync(OUT_MISSING, JSON.stringify(missingObj, null, 2))
console.log(`Wrote ${OUT_MISSING} (${missing.length} missing pairs)`)
