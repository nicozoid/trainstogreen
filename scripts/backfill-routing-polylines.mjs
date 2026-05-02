#!/usr/bin/env node
// Backfills missing polylineCoords in public/routing/<slug>.json by composing
// rail polylines from the segment library at data/rail-segments.json.
//
// Each routing diff entry has a journey under its primary key with a `legs`
// array. For each HEAVY_RAIL leg we look up the calling-points sequence from
// data/origin-routes.json[depCoord].directReachable[arrCoord], compose the
// per-pair segment polylines from the library, and concat with any tube/walk
// hop polylines (which already exist on the leg or in terminal-matrix).
//
// Writes back over the routing file in place. Resumable / re-runnable (only
// touches entries where polylineCoords is missing or empty unless --recompute).
//
// Usage:
//   node scripts/backfill-routing-polylines.mjs               # central-london + stratford
//   node scripts/backfill-routing-polylines.mjs --slug central-london
//   node scripts/backfill-routing-polylines.mjs --recompute   # overwrite existing

import { readFileSync, writeFileSync, existsSync } from "node:fs"
import path from "node:path"
import {
  composeFromCallingPoints,
  decodePolyline,
} from "../lib/compose-segment-polyline.ts"

const REPO = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..")

function getFlag(name) {
  const i = process.argv.findIndex((a) => a === name || a.startsWith(name + "="))
  if (i === -1) return null
  const v = process.argv[i]
  if (v.includes("=")) return v.split("=")[1]
  return process.argv[i + 1] ?? true
}

const SLUG_FILTER = getFlag("--slug")
const RECOMPUTE = process.argv.includes("--recompute")

const SLUGS = SLUG_FILTER ? [SLUG_FILTER] : ["central-london", "stratford"]
const SIMPLIFY_TOL = 0.0005 // matches the rest of the pipeline
const round5 = (c) => [Math.round(c[0] * 1e5) / 1e5, Math.round(c[1] * 1e5) / 1e5]

// ---------------------------------------------------------------------------
// Static data
// ---------------------------------------------------------------------------

const segments = JSON.parse(readFileSync(path.join(REPO, "data/rail-segments.json"), "utf-8"))
const originRoutes = JSON.parse(readFileSync(path.join(REPO, "data/origin-routes.json"), "utf-8"))
const stations = JSON.parse(readFileSync(path.join(REPO, "public/stations.json"), "utf-8"))
const terminalMatrix = JSON.parse(readFileSync(path.join(REPO, "data/terminal-matrix.json"), "utf-8"))

// CRS → coord, normalized name → candidates, coord → CRS (coord = [lng, lat]).
const crsToCoord = new Map()
const nameToCandidates = new Map() // normName → [{ coord, crs, network, isPrimary }]
const coordToCrs = new Map() // "lng,lat" -> CRS

// Normalise a station name aggressively so different naming styles all collide
// onto one lookup key. Specifically handles the homonym pitfalls we've hit:
//   - Google uses curly apostrophes (King's, U+2019); OSM uses straight (')
//     or none (Kings Cross). Stripping both apostrophe forms collapses them.
//   - Some entries prepend "London " (the rail-station naming convention),
//     others don't. Strip the prefix.
//   - "Newport (Wales)" vs "Newport (Essex)" disambiguation suffix — strip it
//     so the bare "Newport" Google passes us collides with both, then we
//     pick via network/proximity.
function normName(s) {
  return s
    .toLowerCase()
    .replace(/[’']/g, "")
    .replace(/\./g, "")
    .replace(/^london\s+/, "")
    .replace(/\s*\([^)]*\)\s*$/, "")
    .trim()
}

// Network priority — when multiple stations share a normalized name, prefer
// National Rail over Elizabeth → Overground → DLR → Underground (matches
// the project's existing disambiguation memory note).
function networkRank(network) {
  if (!network) return 0
  const n = network.toLowerCase()
  if (n.includes("national rail")) return 5
  if (n.includes("elizabeth")) return 4
  if (n.includes("overground")) return 3
  if (n.includes("dlr")) return 2
  if (n.includes("underground")) return 1
  return 0
}

for (const f of stations.features) {
  const crs = f.properties?.["ref:crs"]
  const name = f.properties?.name
  const c = f.geometry?.coordinates
  if (!Array.isArray(c) || c.length < 2) continue
  if (crs) {
    if (!crsToCoord.has(crs)) crsToCoord.set(crs, [c[0], c[1]])
    const ck = `${c[0]},${c[1]}`
    if (!coordToCrs.has(ck)) coordToCrs.set(ck, crs)
  }
  if (name) {
    const norm = normName(name)
    const arr = nameToCandidates.get(norm) ?? []
    arr.push({
      coord: [c[0], c[1]],
      crs: crs ?? null,
      network: f.properties.network ?? null,
      // Whether this station is a top-level primary in origin-routes — used
      // to break ties when multiple stations share a name AND a network rank
      // (e.g. STP vs SPL). The "real" rail station is the one in origin-routes.
      isPrimary: originRoutes[`${c[0]},${c[1]}`] != null,
    })
    nameToCandidates.set(norm, arr)
  }
}

// (Old NAME_ALIASES removed — normName() now handles "London " prefixes,
// curly apostrophes, and "(Wales)" disambiguators uniformly.)

// Pick the best station coord for a given station name. When multiple stations
// share a normalized name (Waterloo London / Waterloo Merseyside, Newport
// Wales / Newport Essex, etc.) we score on:
//   1. isPrimary in origin-routes (this is the station we actually have data
//      for — strong signal it's the right one)
//   2. Network rank (NR > Elizabeth > Overground > DLR > Underground)
//   3. Proximity to the hint coord (final destination of the journey works
//      best — change-stations should be on the way to the destination)
// Network rank dominates over proximity (×1000) so a National Rail station
// 100km away beats an Underground station next door. Primary preference
// (×100) breaks ties WITHIN a network rank — e.g. STP (primary) beats SPL
// (not primary) when both are National Rail.
function resolveStationCoord(rawName, hint) {
  if (!rawName) return null
  const norm = normName(rawName)
  const candidates = nameToCandidates.get(norm)
  if (!candidates || candidates.length === 0) return null
  if (candidates.length === 1) return candidates[0].coord
  let best = candidates[0], bestScore = -Infinity
  for (const c of candidates) {
    const primaryScore = c.isPrimary ? 100 : 0
    const networkScore = networkRank(c.network) * 1000
    let proximityScore = 0
    if (hint) {
      const d2 = (c.coord[0] - hint[0]) ** 2 + (c.coord[1] - hint[1]) ** 2
      proximityScore = -d2 // closer = higher
    }
    const score = primaryScore + networkScore + proximityScore
    if (score > bestScore) { bestScore = score; best = c }
  }
  return best.coord
}

const coordKey = (c) => `${c[0]},${c[1]}`

// ---------------------------------------------------------------------------
// Compose one journey's polyline
// ---------------------------------------------------------------------------

// Compose using the journey's legs. Returns { coords, stats } or null when
// nothing usable could be assembled.
function composeJourneyPolyline(journey, primaryOriginCoord, destCoord) {
  if (!Array.isArray(journey.legs) || journey.legs.length === 0) return null
  const allCoords = []
  let edgesResolved = 0, edgesFallback = 0, edgesMissing = 0, legsHandled = 0

  // Per-leg dep/arr coord resolution. Use the journey's final destCoord as
  // the geographic hint for EVERY name lookup — change-stations are always
  // on the way to the destination, so destCoord biases the resolver toward
  // the right homonym (e.g. picks Newport Wales over Newport Essex when the
  // journey ends at Abergavenny). For the final leg's arrival, destCoord IS
  // the answer authoritatively.
  const legBounds = []
  for (let li = 0; li < journey.legs.length; li++) {
    const leg = journey.legs[li]
    const isLast = li === journey.legs.length - 1
    const depCoord = resolveStationCoord(leg.departureStation, destCoord)
    const arrCoord = isLast
      ? destCoord
      : resolveStationCoord(leg.arrivalStation, destCoord)
    legBounds.push({ depCoord, arrCoord })
  }

  for (let li = 0; li < journey.legs.length; li++) {
    const leg = journey.legs[li]
    const { depCoord, arrCoord } = legBounds[li]
    if (!depCoord || !arrCoord) continue

    let legCoords = []

    if (leg.vehicleType === "HEAVY_RAIL") {
      // Direct lookup first: origin-routes is keyed by leg-origin coord, with
      // directReachable[arrCoord] giving the calling-points sequence.
      const orEntry = originRoutes[coordKey(depCoord)]
      const dr = orEntry?.directReachable?.[coordKey(arrCoord)]
      let cp = dr?.fastestCallingPoints

      // Fallbacks for legs whose direct (depCRS → arrCoord) journey isn't in
      // origin-routes (e.g. East Croydon → Amberley — AMY isn't directly
      // reachable from ECR in our data, but the train still passes through
      // both en route from Victoria to Bognor Regis).
      if (!cp || cp.length < 2) {
        const depCrs = coordToCrs.get(coordKey(depCoord))
        const arrKey = coordKey(arrCoord)
        if (depCrs) {
          // Fallback 1 — single-sequence slice: find any origin whose journey
          // to arrCoord passes through depCRS partway, then slice from depCRS.
          let bestSlice = null
          for (const oEntry of Object.values(originRoutes)) {
            const candidate = oEntry.directReachable?.[arrKey]?.fastestCallingPoints
            if (!Array.isArray(candidate)) continue
            const idx = candidate.indexOf(depCrs)
            if (idx > 0 && idx < candidate.length - 1) {
              const sliced = candidate.slice(idx)
              if (!bestSlice || sliced.length > bestSlice.length) bestSlice = sliced
            }
          }
          // Fallback 2 — two-hop via a midpoint primary: for each origin M
          // that reaches arrCoord (the "M → arrCoord" leg), see if depCRS
          // reaches M's coord (either directly via origin-routes[depCoord], or
          // via another origin whose CP for M contains depCRS). Compose
          // [depCRS … M] + [M … arrCRS].
          if (!bestSlice) {
            for (const [mCoord, mEntry] of Object.entries(originRoutes)) {
              const midToArr = mEntry.directReachable?.[arrKey]?.fastestCallingPoints
              if (!Array.isArray(midToArr) || midToArr.length < 2) continue
              const midCrs = midToArr[0]
              if (!midCrs) continue
              // 2a — depCRS itself is a primary that reaches midCoord directly.
              const depToMidViaSelf = originRoutes[coordKey(depCoord)]?.directReachable?.[mCoord]?.fastestCallingPoints
              if (Array.isArray(depToMidViaSelf) && depToMidViaSelf[0] === depCrs) {
                bestSlice = [...depToMidViaSelf, ...midToArr.slice(1)]
                break
              }
              // 2b — some origin's path to midCoord contains depCRS partway.
              for (const oEntry2 of Object.values(originRoutes)) {
                const cand = oEntry2.directReachable?.[mCoord]?.fastestCallingPoints
                if (!Array.isArray(cand)) continue
                const idx = cand.indexOf(depCrs)
                if (idx > 0 && idx < cand.length - 1 && cand[cand.length - 1] === midCrs) {
                  bestSlice = [...cand.slice(idx), ...midToArr.slice(1)]
                  break
                }
              }
              if (bestSlice) break
            }
          }
          if (bestSlice) cp = bestSlice
        }
      }

      if (cp && cp.length >= 2) {
        const result = composeFromCallingPoints(cp, { segments, crsToCoord })
        legCoords = result.coords
        edgesResolved += result.edgesResolved
        edgesFallback += result.edgesFallback
        edgesMissing += result.edgesMissing
        legsHandled += 1
      } else {
        // No calling-points data anywhere — straight line from dep to arr.
        legCoords = [depCoord, arrCoord]
        edgesFallback += 1
      }
    } else if (leg.vehicleType === "SUBWAY" || leg.vehicleType === "WALK") {
      // Tube hop / walk transfer — pull from terminal-matrix when both ends
      // are recognised London terminals. Otherwise straight line.
      const m = terminalMatrix[leg.departureStation]?.[leg.arrivalStation]
      if (m?.polyline) {
        legCoords = decodePolyline(m.polyline)
      } else {
        legCoords = [depCoord, arrCoord]
        edgesFallback += 1
      }
      legsHandled += 1
    } else {
      legCoords = [depCoord, arrCoord]
      edgesFallback += 1
    }

    // Concat with shared-join dedup.
    const skipFirst = allCoords.length > 0 && legCoords.length > 0
    for (let i = skipFirst ? 1 : 0; i < legCoords.length; i++) allCoords.push(legCoords[i])
  }

  if (allCoords.length < 2) return null
  return {
    coords: allCoords.map(round5),
    stats: { edgesResolved, edgesFallback, edgesMissing, legsHandled },
  }
}

// ---------------------------------------------------------------------------
// Backfill a single routing/<slug>.json
// ---------------------------------------------------------------------------

function backfillSlug(slug) {
  const filePath = path.join(REPO, "public/routing", `${slug}.json`)
  if (!existsSync(filePath)) {
    console.log(`Skipping ${slug}: ${filePath} not found.`)
    return
  }
  const doc = JSON.parse(readFileSync(filePath, "utf-8"))
  const entries = Object.entries(doc)
  let touchedFeatures = 0
  let composedJourneys = 0
  let alreadyHadPolyline = 0
  let stillEmpty = 0
  let aggregateEdgesResolved = 0, aggregateEdgesFallback = 0, aggregateEdgesMissing = 0

  for (const [destCoordKey, delta] of entries) {
    const journeys = delta.journeys
    if (!journeys) continue
    const destCoord = destCoordKey.split(",").map(Number)
    let touched = false
    for (const [primaryKey, journey] of Object.entries(journeys)) {
      const hasPoly =
        Array.isArray(journey.polylineCoords) && journey.polylineCoords.length > 1
      if (hasPoly && !RECOMPUTE) {
        alreadyHadPolyline += 1
        continue
      }
      const primaryCoord = primaryKey.split(",").map(Number)
      const result = composeJourneyPolyline(journey, primaryCoord, destCoord)
      if (!result) {
        stillEmpty += 1
        continue
      }
      journey.polylineCoords = result.coords
      composedJourneys += 1
      touched = true
      aggregateEdgesResolved += result.stats.edgesResolved
      aggregateEdgesFallback += result.stats.edgesFallback
      aggregateEdgesMissing += result.stats.edgesMissing
    }
    if (touched) touchedFeatures += 1
  }

  // Match the original file's minified format — pretty-printing adds ~25%
  // and routing diffs ship to the browser.
  const serialised = JSON.stringify(doc)
  writeFileSync(filePath, serialised)
  const sizeMb = (Buffer.byteLength(serialised) / 1024 / 1024).toFixed(2)

  console.log(`\n=== ${slug} ===`)
  console.log(`Features in routing diff: ${entries.length}`)
  console.log(`Features touched:         ${touchedFeatures}`)
  console.log(`Journeys composed:        ${composedJourneys}`)
  console.log(`Journeys already had polyline (skipped): ${alreadyHadPolyline}`)
  console.log(`Journeys still empty (no legs / no calling-points): ${stillEmpty}`)
  console.log(`Edges aggregate — resolved: ${aggregateEdgesResolved}, fallback: ${aggregateEdgesFallback}, missing: ${aggregateEdgesMissing}`)
  console.log(`Wrote ${path.relative(REPO, filePath)} (${sizeMb} MB)`)
}

for (const slug of SLUGS) backfillSlug(slug)
