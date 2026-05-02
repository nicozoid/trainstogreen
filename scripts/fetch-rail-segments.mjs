#!/usr/bin/env node
// Fetches polylines for the rail segments listed in data/rail-segments-missing.json
// from the Google Routes API and merges them into data/rail-segments.json.
//
// One Routes API call per (fromCRS, toCRS) pair, transit mode, polyline-only
// field mask. Bills as Compute Routes Essentials (10,000 free/month — the
// 4,500-pair top-up fits with room to spare).
//
// Same simplification compromise as the extractor: DP tol=0.0005, round 5dp.
// Resumable — pairs already present in data/rail-segments.json are skipped
// unless --recompute is passed.
//
// Usage:
//   GOOGLE_MAPS_API_KEY=your_key node scripts/fetch-rail-segments.mjs
//
// Recommended (laptop won't sleep mid-batch):
//   GOOGLE_MAPS_API_KEY=your_key caffeinate -i node scripts/fetch-rail-segments.mjs
//
// Flags:
//   --limit N      Stop after N successful fetches (use 5 for a smoke test).
//   --recompute    Re-fetch even if a pair already exists in rail-segments.json.
//   --day=tue      Use a Tuesday departure instead of Saturday (for lines with
//                  no weekend service). Default: Saturday.

import { readFileSync, writeFileSync, existsSync } from "node:fs"
import path from "node:path"

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const REPO = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..")
const STATIONS_PATH = path.join(REPO, "public", "stations.json")
const MISSING_PATH = path.join(REPO, "data", "rail-segments-missing.json")
const SEGMENTS_PATH = path.join(REPO, "data", "rail-segments.json")
const FAILED_PATH = path.join(REPO, "data", "rail-segments-failed.json")

// Read GOOGLE_MAPS_API_KEY from process.env, falling back to a simple parse
// of .env.local in the repo root so the user doesn't have to learn shell
// exports. Only the one variable we care about — no full dotenv emulation.
function loadApiKey() {
  if (process.env.GOOGLE_MAPS_API_KEY) return process.env.GOOGLE_MAPS_API_KEY
  // Check the local repo first, then the main repo three levels up (since
  // .claude/worktrees/<name>/ is a worktree of /Users/.../trainstogreen/).
  const candidates = [
    path.join(REPO, ".env.local"),
    path.resolve(REPO, "..", "..", "..", ".env.local"),
  ]
  for (const envPath of candidates) {
    if (!existsSync(envPath)) continue
    const lines = readFileSync(envPath, "utf-8").split(/\r?\n/)
    for (const raw of lines) {
      const line = raw.trim()
      if (!line || line.startsWith("#")) continue
      const m = line.match(/^GOOGLE_MAPS_API_KEY\s*=\s*(.*)$/)
      if (m) return m[1].replace(/^["']|["']$/g, "").trim()
    }
  }
  return null
}
const API_KEY = loadApiKey()
if (!API_KEY) {
  console.error("Error: GOOGLE_MAPS_API_KEY not found.")
  console.error("Add it to .env.local as a line like:")
  console.error("  GOOGLE_MAPS_API_KEY=your_actual_key_here")
  process.exit(1)
}

function getFlag(name) {
  const i = process.argv.findIndex((a) => a === name || a.startsWith(name + "="))
  if (i === -1) return null
  const v = process.argv[i]
  if (v.includes("=")) return v.split("=")[1]
  return process.argv[i + 1] ?? true
}
const LIMIT = (() => {
  const v = getFlag("--limit")
  return v == null ? null : Number(v)
})()
const RECOMPUTE = process.argv.includes("--recompute")
const DAY_PREF = (getFlag("--day") || "sat").toLowerCase()

const SIMPLIFY_TOL = 0.0005
const PACE_MS = 100              // 10 req/s — well under Routes API limits
const FLUSH_EVERY = 50           // checkpoint to disk every N successes

// ---------------------------------------------------------------------------
// Polyline encode / decode / simplify (same algorithm as extractor)
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

function simplifyPolyline(coords, tol) {
  if (coords.length <= 2) return coords
  const tolSq = tol * tol
  const keep = new Uint8Array(coords.length)
  keep[0] = 1; keep[coords.length - 1] = 1
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
// CRS → coord lookup
// ---------------------------------------------------------------------------

const stations = JSON.parse(readFileSync(STATIONS_PATH, "utf-8"))
const crsToCoord = new Map()
const crsToName = new Map()
for (const f of stations.features) {
  const crs = f.properties?.["ref:crs"]
  if (!crs) continue
  const coords = f.geometry?.coordinates
  if (!Array.isArray(coords)) continue
  if (!crsToCoord.has(crs)) {
    crsToCoord.set(crs, coords)
    crsToName.set(crs, f.properties.name ?? crs)
  }
}

// ---------------------------------------------------------------------------
// Departure time — pick the next Saturday or Tuesday at 09:00 UTC.
// Geometry doesn't depend on the time, but we still need a future timestamp
// for the transit query to succeed; pick a day with reliable rail service.
// ---------------------------------------------------------------------------

function nextDow(targetDow) {
  const now = new Date()
  const day = now.getUTCDay()
  const delta = (targetDow - day + 7) % 7 || 7
  const d = new Date(now)
  d.setUTCDate(now.getUTCDate() + delta)
  d.setUTCHours(9, 0, 0, 0)
  return d
}
const DEPARTURE = (DAY_PREF === "tue" ? nextDow(2) : nextDow(6)).toISOString()

// ---------------------------------------------------------------------------
// Existing state — load rail-segments.json and rail-segments-failed.json
// for resumability.
// ---------------------------------------------------------------------------

const missingDoc = JSON.parse(readFileSync(MISSING_PATH, "utf-8"))
const segments = existsSync(SEGMENTS_PATH)
  ? JSON.parse(readFileSync(SEGMENTS_PATH, "utf-8"))
  : {}
let failed = []
if (existsSync(FAILED_PATH)) {
  try { failed = JSON.parse(readFileSync(FAILED_PATH, "utf-8")).failed ?? [] } catch {}
}
const failedSet = new Set(failed.map((e) => e.pair))

function flush() {
  // Sort segments alphabetically for stable diffs.
  const sortedSegments = Object.fromEntries(
    Object.entries(segments).sort(([a], [b]) => a.localeCompare(b)),
  )
  writeFileSync(SEGMENTS_PATH, JSON.stringify(sortedSegments, null, 2))
  writeFileSync(
    FAILED_PATH,
    JSON.stringify({ generatedAt: new Date().toISOString(), failed }, null, 2),
  )
}

// ---------------------------------------------------------------------------
// Routes API call
// ---------------------------------------------------------------------------

const ROUTES_URL = "https://routes.googleapis.com/directions/v2:computeRoutes"
const FIELD_MASK = [
  "routes.legs.polyline.encodedPolyline",
  "routes.legs.steps.travelMode",
  "routes.legs.steps.transitDetails.transitLine.vehicle.type",
].join(",")

// Returns { ok: true, encoded } or { ok: false, reason, message? }.
async function fetchSegment(fromCrs, toCrs) {
  const fromC = crsToCoord.get(fromCrs)
  const toC = crsToCoord.get(toCrs)
  if (!fromC) return { ok: false, reason: "from-crs-unknown" }
  if (!toC)   return { ok: false, reason: "to-crs-unknown" }
  const body = {
    origin:      { location: { latLng: { latitude: fromC[1], longitude: fromC[0] } } },
    destination: { location: { latLng: { latitude: toC[1],   longitude: toC[0]   } } },
    travelMode: "TRANSIT",
    departureTime: DEPARTURE,
    transitPreferences: { allowedTravelModes: ["TRAIN", "RAIL", "SUBWAY"] },
  }
  let res
  try {
    res = await fetch(ROUTES_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Goog-Api-Key": API_KEY,
        "X-Goog-FieldMask": FIELD_MASK,
      },
      body: JSON.stringify(body),
    })
  } catch (e) {
    return { ok: false, reason: "fetch-error", message: String(e).slice(0, 200) }
  }
  if (!res.ok) {
    const text = await res.text().catch(() => "")
    return { ok: false, reason: `http-${res.status}`, message: text.slice(0, 300) }
  }
  let data
  try { data = await res.json() } catch (e) {
    return { ok: false, reason: "json-parse", message: String(e).slice(0, 200) }
  }
  const route = data.routes?.[0]
  if (!route) return { ok: false, reason: "no-routes" }
  const legs = route.legs ?? []
  // Pick the first leg whose vehicle type indicates rail-or-subway. If there's
  // a long walking prefix and a single rail leg, that rail leg is what we want.
  let railLeg = null
  for (const leg of legs) {
    const vehicleTypes = (leg.steps ?? [])
      .map((s) => s.transitDetails?.transitLine?.vehicle?.type ?? null)
      .filter(Boolean)
    const isRail = vehicleTypes.some((t) =>
      /HEAVY_RAIL|RAIL|TRAIN|SUBWAY|COMMUTER_TRAIN|HIGH_SPEED_TRAIN|LONG_DISTANCE_TRAIN/.test(t),
    )
    if (isRail && leg.polyline?.encodedPolyline) {
      railLeg = leg
      break
    }
  }
  if (!railLeg) return { ok: false, reason: "no-rail-leg" }
  return { ok: true, encoded: railLeg.polyline.encodedPolyline }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  const all = missingDoc.missing ?? []
  // Skip pairs already covered (or previously failed, unless --recompute).
  const queue = all.filter((m) => {
    if (failedSet.has(m.pair) && !RECOMPUTE) return false
    if (segments[m.pair] && !RECOMPUTE) return false
    return true
  })

  console.log(`Total missing pairs: ${all.length}`)
  console.log(`Already covered:     ${all.length - queue.length - failed.filter(f => !RECOMPUTE).length}`)
  console.log(`Previously failed:   ${failed.filter((f) => failedSet.has(f.pair) && all.find((m) => m.pair === f.pair)).length}`)
  console.log(`To fetch this run:   ${queue.length}${LIMIT != null ? ` (limited to ${LIMIT})` : ""}`)
  console.log(`Departure time:      ${DEPARTURE}`)
  console.log(`Estimated wall time: ~${Math.ceil((LIMIT ?? queue.length) * (PACE_MS + 250) / 60000)} min`)
  console.log("")

  let success = 0, fail = 0
  const start = Date.now()
  for (const m of queue) {
    if (LIMIT != null && success >= LIMIT) break
    const [fromCrs, toCrs] = m.pair.split("-")
    const fromName = crsToName.get(fromCrs) ?? fromCrs
    const toName = crsToName.get(toCrs) ?? toCrs
    const r = await fetchSegment(fromCrs, toCrs)
    if (r.ok) {
      const decoded = decodePolyline(r.encoded)
      const simplified = simplifyPolyline(decoded, SIMPLIFY_TOL).map(round5)
      segments[m.pair] = {
        polyline: encodePolyline(simplified),
        source: "google",
        points: simplified.length,
      }
      success++
      console.log(`  ✓ ${m.pair.padEnd(12)} ${fromName} → ${toName}  (${simplified.length}pts)`)
    } else {
      // Replace any prior failure record for this pair.
      failed = failed.filter((f) => f.pair !== m.pair)
      failed.push({ pair: m.pair, reason: r.reason, message: r.message ?? null, fromName, toName })
      fail++
      console.log(`  ✗ ${m.pair.padEnd(12)} ${fromName} → ${toName}  — ${r.reason}${r.message ? ": " + r.message.slice(0, 80) : ""}`)
    }
    if (success > 0 && success % FLUSH_EVERY === 0) {
      flush()
      const elapsed = ((Date.now() - start) / 1000).toFixed(0)
      console.log(`  [checkpoint at ${success} successes — elapsed ${elapsed}s]`)
    }
    if (PACE_MS > 0) await new Promise((res) => setTimeout(res, PACE_MS))
  }
  flush()
  const elapsed = ((Date.now() - start) / 1000).toFixed(0)
  console.log(``)
  console.log(`Done in ${elapsed}s. ${success} ok, ${fail} failed.`)
  console.log(`Total segments now: ${Object.keys(segments).length}`)
  if (fail > 0) {
    console.log(`Failed pairs written to data/rail-segments-failed.json — review before re-running.`)
  }
}

main().catch((e) => {
  flush()
  console.error("Fatal error:", e)
  process.exit(1)
})
