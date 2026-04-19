#!/usr/bin/env node
// Builds a list of stations directly reachable from a given origin CRS using the
// Realtime Trains API's scheduled timetable. Merges results into data/origin-routes.json.
//
// Samples Saturday 07:00–12:00 by default — this is the realistic window
// for day-hikers leaving London, and Saturday service patterns differ enough
// from weekdays that using the "wrong" day would give misleading results.
//
// Usage:
//   RTT_TOKEN=<jwt> node scripts/fetch-direct-reachable.mjs FEL
//   RTT_TOKEN=<jwt> node scripts/fetch-direct-reachable.mjs FEL --date=2026-04-18
//   RTT_TOKEN=<jwt> node scripts/fetch-direct-reachable.mjs FEL --dates=2026-04-18,2026-07-25,2026-10-03
//
// MULTI-DATE MERGE SEMANTICS
// --------------------------
// A single Saturday sample is incomplete — if that specific day has engineering
// works on some line, the direct services for that line won't appear in the
// API response. Running across multiple Saturdays (weeks or months apart)
// lets us union the real direct network.
//
// When the script writes back to data/origin-routes.json it MERGES with the
// existing entry for the origin (rather than overwriting it). Per destination:
//   - minMinutes  → minimum across all sampled dates (fastest observed)
//   - fastestCallingPoints + upstreamCallingPoints → from whichever date
//     produced that winning time (so they stay self-consistent with minMinutes)
//   - services    → MAX across dates (services-per-morning on a typical
//     Saturday; summing would double-count a service that runs every week)
//   - sampledDates (new, origin-level) → union of all dates that have
//     contributed to this origin's dataset so far
//
// Running on a new date with --date or --dates is additive — already-captured
// destinations on previous dates are preserved and only replaced when the
// new date yields a faster time. The order of runs does not matter.
//
// How it works (single-date):
//   1. Exchange the long-life JWT (from RTT_TOKEN) for a short-life access token.
//   2. Fetch ~5h of services calling at <CRS> (gb-nr namespace) for that Sat.
//   3. For each unique service, fetch its full calling list from /rtt/service.
//   4. Every station that appears AFTER <CRS> in a service's calling order is
//      directly reachable — a passenger can board at <CRS> and stay on that train.
//   5. Record the fastest observed duration across all services for each pair,
//      plus a service count (how many services call at that destination per day).
//   6. Merge output into data/origin-routes.json, keyed by origin coord key,
//      using the merge semantics above.
//
// Rate limits (from RTT API portal, personal tier):
//   30/min, 750/hour, 9000/day. We pace at ~500ms between calls (≤120/min
//   peak, avg well under 750/hour) and print progress so you can Ctrl-C safely.
//
// Rerun safely: already-processed service identities are skipped on rerun
// (the output is merged, not overwritten).

import { readFileSync, writeFileSync, existsSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { dirname, join } from "node:path"

const __dirname = dirname(fileURLToPath(import.meta.url))
const REPO = join(__dirname, "..")
const STATIONS_PATH = join(REPO, "public/stations.json")
const ROUTES_PATH = join(REPO, "data/origin-routes.json")
const API_BASE = "https://data.rtt.io"
const NAMESPACE = "gb-nr"
// Rate limits (personal tier): 30/min, 750/hour, 9000/day, 30000/week.
// Default 2100ms throttle (~28/min, just under the per-minute cap) works for a
// single fetch, but back-to-back fetches of large stations burn through the
// 750/hour limit. Override with --throttle=4800 for bulk runs: that's 12.5/min
// = 750/hour exactly, so sustained running never trips the per-hour cap.
const throttleArg = process.argv.find((a) => a.startsWith("--throttle="))?.replace("--throttle=", "")
const THROTTLE_MS = throttleArg ? parseInt(throttleArg, 10) : 2100

const originCrs = (process.argv[2] ?? "").toUpperCase()
if (!originCrs) {
  console.error("Usage: RTT_TOKEN=<jwt> node scripts/fetch-direct-reachable.mjs <CRS>")
  process.exit(1)
}
const RTT_TOKEN = process.env.RTT_TOKEN
if (!RTT_TOKEN) {
  console.error("Error: set RTT_TOKEN environment variable to your RTT API refresh token")
  process.exit(1)
}

// ---------------------------------------------------------------------------
// Station-index: CRS → { coord, name } — built from stations.json
// ---------------------------------------------------------------------------
const stationData = JSON.parse(readFileSync(STATIONS_PATH, "utf8"))
const crsToStation = new Map()
for (const f of stationData.features) {
  const crs = f.properties?.["ref:crs"]
  if (!crs) continue
  const [lng, lat] = f.geometry.coordinates
  crsToStation.set(crs, {
    coord: `${lng},${lat}`,
    name: f.properties.name,
  })
}
const originStation = crsToStation.get(originCrs)
if (!originStation) {
  console.error(`Error: CRS "${originCrs}" not found in public/stations.json`)
  process.exit(1)
}
console.log(`Origin: ${originStation.name} (${originCrs}) at ${originStation.coord}`)

// ---------------------------------------------------------------------------
// Auth + HTTP helpers
// ---------------------------------------------------------------------------
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function getAccessToken() {
  const res = await fetch(`${API_BASE}/api/get_access_token`, {
    headers: { Authorization: `Bearer ${RTT_TOKEN}` },
  })
  if (!res.ok) throw new Error(`access-token request failed: ${res.status} ${await res.text()}`)
  const body = await res.json()
  const token = body.token ?? body.accessToken  // spec called it accessToken; API returns token
  if (!token) throw new Error(`no token in response: ${JSON.stringify(body)}`)
  console.log(`Got access token (valid ~20 min)`)
  return token
}

let accessToken = await getAccessToken()

async function apiGet(path, retriesLeft = 3) {
  const url = `${API_BASE}${path}`
  const res = await fetch(url, { headers: { Authorization: `Bearer ${accessToken}` } })
  if (res.status === 401) {
    // Access token expired mid-run — refresh and retry once.
    accessToken = await getAccessToken()
    return apiGet(path, retriesLeft)
  }
  if (res.status === 429 && retriesLeft > 0) {
    // Per-minute cap hit — back off for a full minute and retry. Common when
    // quota is shared with other clients on your token.
    console.log(`  rate-limited, backing off 60s (retries left: ${retriesLeft - 1})`)
    await sleep(60_000)
    return apiGet(path, retriesLeft - 1)
  }
  if (res.status === 204) return null  // valid query, no data
  if (!res.ok) throw new Error(`${path}: ${res.status} ${await res.text()}`)
  return res.json()
}

// ---------------------------------------------------------------------------
// Date window: Saturday 07:00–12:00. Configurable via --date (single) or
// --dates (comma-separated list). Defaults to the next upcoming Saturday.
// ---------------------------------------------------------------------------
function nextSaturday() {
  const d = new Date()
  // If today is Saturday, use today. Otherwise advance to the next Saturday.
  // Day-of-week: 0=Sun, 6=Sat.
  const daysUntilSat = (6 - d.getDay() + 7) % 7
  d.setDate(d.getDate() + daysUntilSat)
  return d
}
// --dates takes precedence over --date if both are supplied.
const datesArg = process.argv.find((a) => a.startsWith("--dates="))?.replace("--dates=", "")
const dateArg = process.argv.find((a) => a.startsWith("--date="))?.replace("--date=", "")
const isoDateStrings = datesArg
  ? datesArg.split(",").map((s) => s.trim()).filter(Boolean)
  : [dateArg ?? isoDateStr(nextSaturday())]
function isoDateStr(d) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`
}
function parseDate(s) { return new Date(`${s}T00:00:00`) }
const iso = (d, h, m) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}T${String(h).padStart(2,"0")}:${String(m).padStart(2,"0")}:00`

// Default: Saturday morning 07:00–12:00, which covers the realistic window a
// day-hiker would leave London. Override with --hours HH,HH for testing.
const hoursArg = process.argv.find((a) => a.startsWith("--hours="))
const [hFrom, hTo] = hoursArg ? hoursArg.replace("--hours=", "").split(",").map(Number) : [7, 12]
const mTo = hTo === 23 ? 59 : 0

// ---------------------------------------------------------------------------
// Per-date fetch — returns a Map<crs, { name, coord, crs, minMinutes, services,
// fastestCallingPoints, upstreamCallingPoints }> for the given Saturday.
// ---------------------------------------------------------------------------
async function fetchForDate(dateStr) {
  const qDate = parseDate(dateStr)
  const timeFrom = iso(qDate, hFrom, 0)
  const timeTo   = iso(qDate, hTo, mTo)
  console.log(`\n=== ${dateStr} ===`)
  console.log(`Querying services at ${originCrs} between ${timeFrom} and ${timeTo}`)
  const lineup = await apiGet(
    `/rtt/location?code=${NAMESPACE}:${originCrs}&timeFrom=${encodeURIComponent(timeFrom)}&timeTo=${encodeURIComponent(timeTo)}`
  )
  if (!lineup) {
    console.log(`No services returned for ${dateStr} — perhaps a closure day.`)
    return new Map()
  }
  const services = lineup.services ?? []
  console.log(`Found ${services.length} services at ${originCrs} on ${dateStr}`)

  // Map<crs, { ..., minMinutes, services, fastestCallingPoints, upstreamCallingPoints }>
  const reachable = new Map()

  // RTT's /rtt/service response gives each calling point as an ISO datetime under
  // temporalData.{arrival,departure}.scheduleAdvertised. Origins have no arrival;
  // terminals have no departure — so we fall back to whichever is available.
  function serviceCallingList(service) {
    const locs = service?.service?.locations ?? []
    return locs
      .map((l) => {
        const crs = l.location?.shortCodes?.[0]
        if (!crs) return null
        const depIso = l.temporalData?.departure?.scheduleAdvertised ?? l.temporalData?.arrival?.scheduleAdvertised
        const arrIso = l.temporalData?.arrival?.scheduleAdvertised ?? l.temporalData?.departure?.scheduleAdvertised
        return {
          crs,
          depMs: depIso ? new Date(depIso).getTime() : null,
          arrMs: arrIso ? new Date(arrIso).getTime() : null,
        }
      })
      .filter(Boolean)
  }

  let processed = 0, skipped = 0
  const startedAt = Date.now()
  for (const svc of services) {
    const uniqueIdentity = svc.scheduleMetadata?.uniqueIdentity
    if (!uniqueIdentity) { skipped++; continue }

    await sleep(THROTTLE_MS)
    let detail
    try {
      detail = await apiGet(`/rtt/service?uniqueIdentity=${encodeURIComponent(uniqueIdentity)}`)
    } catch (e) {
      console.warn(`  skip ${uniqueIdentity}: ${e.message}`)
      skipped++
      continue
    }
    if (!detail) { skipped++; continue }

    const calling = serviceCallingList(detail)
    const idx = calling.findIndex((c) => c.crs === originCrs)
    if (idx < 0 || idx === calling.length - 1) { skipped++; continue }  // origin not on list, or origin is last stop

    const originDepartMs = calling[idx].depMs ?? calling[idx].arrMs
    if (originDepartMs == null) { skipped++; continue }

    // Pre-compute the upstream calling points for this service — stations the
    // train calls at BEFORE the origin. Used by the "can also board earlier"
    // hint in the modal: a user boarding at Farringdon can tell a friend in
    // Kentish Town to join the same train further back. Time is measured as
    // minutes BEFORE origin departure (always positive, sorted by distance).
    // Recorded per-destination because different destinations are reached by
    // different services with different upstreams (e.g. Thameslink trains
    // start at Bedford or St Albans depending on the service).
    const upstream = []
    for (let j = 0; j < idx; j++) {
      const { crs, depMs } = calling[j]
      if (depMs == null) continue
      const station = crsToStation.get(crs)
      if (!station) continue
      const minsBefore = Math.round((originDepartMs - depMs) / 60000)
      if (minsBefore <= 0 || minsBefore > 24 * 60) continue
      upstream.push({ crs, name: station.name, coord: station.coord, minutesBeforeOrigin: minsBefore })
    }

    // Everything AFTER the origin in the calling list is directly reachable.
    // We record the calling-point sequence for the FASTEST service we've seen
    // per (origin, destination) pair — lets the UI synthesise a polyline and
    // show intermediate-stop count without another API call.
    //
    // NEW (Phase 4 schema): also record per-stop ARRIVAL TIMES as minutes
    // from the service's origin departure, parallel to the CRS array. Unlocks
    // "calling-point-as-hub" routing in the app — e.g. Richmond→Ascot via
    // Barnes needs X→Barnes time + Barnes→D time on the relevant services,
    // which weren't computable from raw minMinutes + CRS chain alone.
    //
    // Backward compat: parallel-array shape (not a reshape of the existing
    // field). Consumers that only read fastestCallingPoints keep working;
    // new calling-point-as-hub code reads fastestCallingPointTimes on top.
    // Existing entries in origin-routes.json that pre-date this field
    // simply won't participate in calling-point-as-hub routing until
    // their primary gets re-fetched.
    for (let i = idx + 1; i < calling.length; i++) {
      const { crs, arrMs } = calling[i]
      if (arrMs == null) continue
      const station = crsToStation.get(crs)
      if (!station) continue  // destination CRS isn't in our dataset (unusual)

      const mins = Math.round((arrMs - originDepartMs) / 60000)
      if (mins <= 0 || mins > 24 * 60) continue  // sanity bounds (handles clock skew)

      // Build the fastestCallingPoints slice and its parallel per-stop times.
      // index 0 is the origin → 0 minutes by definition. Subsequent entries
      // get (arrMs - originDepartMs) in minutes. Nulls are preserved (rare
      // but defensive — some CP entries lack arrival timestamps).
      const sliceArr = calling.slice(idx, i + 1)
      const fastestCallingPoints = sliceArr.map((c) => c.crs)
      const fastestCallingPointTimes = sliceArr.map((c, k) => {
        if (k === 0) return 0  // service origin = zero minutes
        if (c.arrMs == null) return null
        return Math.round((c.arrMs - originDepartMs) / 60000)
      })

      const prev = reachable.get(crs)
      if (!prev) {
        reachable.set(crs, {
          ...station,
          crs,
          minMinutes: mins,
          services: 1,
          fastestCallingPoints,
          fastestCallingPointTimes,
          // Upstream is pinned to the WINNING service — when a faster service
          // displaces the current winner below, upstream gets replaced too.
          upstreamCallingPoints: upstream,
        })
      } else {
        prev.services++
        if (mins < prev.minMinutes) {
          prev.minMinutes = mins
          prev.fastestCallingPoints = fastestCallingPoints
          prev.fastestCallingPointTimes = fastestCallingPointTimes
          prev.upstreamCallingPoints = upstream
        }
      }
    }

    processed++
    if (processed % 10 === 0) {
      const elapsed = Math.round((Date.now() - startedAt) / 1000)
      console.log(`[${processed}/${services.length}] ${elapsed}s elapsed, ${reachable.size} reachable stations so far`)
    }
  }

  console.log(`Processed ${processed} services on ${dateStr} (${skipped} skipped)`)
  console.log(`Found ${reachable.size} directly-reachable stations from ${originCrs} on ${dateStr}`)
  return reachable
}

// ---------------------------------------------------------------------------
// Run across all requested dates, collecting per-date maps.
// ---------------------------------------------------------------------------
const perDateMaps = []
for (const dateStr of isoDateStrings) {
  try {
    const m = await fetchForDate(dateStr)
    if (m.size > 0) perDateMaps.push({ date: dateStr, map: m })
  } catch (e) {
    console.warn(`Failed to fetch ${dateStr}: ${e.message}`)
  }
}
if (perDateMaps.length === 0) {
  console.error("No dates produced any data — aborting without writing.")
  process.exit(1)
}

// ---------------------------------------------------------------------------
// Merge: combine all fetched dates AND any pre-existing entry in
// origin-routes.json. Per destination, keep the fastest time and the
// calling-points from whichever date produced it.
// ---------------------------------------------------------------------------
// Map<coord, mergedEntry> — keyed by DESTINATION coord (the JSON output's
// inner key), not CRS, so the merge handles the same-name / different-coord
// edge case cleanly.
const merged = new Map()
function takeBetter(existing, candidate) {
  // Returns the entry with the smaller minMinutes, falling back to existing
  // when times are tied so we preserve the earlier-sampled metadata. services
  // count is max across all sources (see comment at top of file).
  if (!existing) return { ...candidate }
  if (candidate.minMinutes < existing.minMinutes) {
    return {
      name: candidate.name,
      crs: candidate.crs,
      minMinutes: candidate.minMinutes,
      // services: max across sources — reflects "typical Saturday morning
      // frequency", not "sum of all samples" (which would over-count a
      // service that runs every week).
      services: Math.max(existing.services ?? 0, candidate.services ?? 0),
      fastestCallingPoints: candidate.fastestCallingPoints,
      // fastestCallingPointTimes is parallel to fastestCallingPoints — must
      // be carried from the same winning date's data. Older entries in
      // origin-routes.json won't have it; degrade to undefined rather than
      // invent numbers.
      fastestCallingPointTimes: candidate.fastestCallingPointTimes,
      upstreamCallingPoints: candidate.upstreamCallingPoints ?? [],
    }
  }
  // Keep existing time/calling-points, but still allow services count to
  // grow if the candidate saw more services on a different date.
  return {
    ...existing,
    services: Math.max(existing.services ?? 0, candidate.services ?? 0),
  }
}

// Seed with any pre-existing entry from origin-routes.json for this origin.
const current = existsSync(ROUTES_PATH) ? JSON.parse(readFileSync(ROUTES_PATH, "utf8")) : {}
const existingEntry = current[originStation.coord]
if (existingEntry?.directReachable) {
  for (const [coord, entry] of Object.entries(existingEntry.directReachable)) {
    merged.set(coord, { ...entry })
  }
}
// Then fold each date's per-CRS map in.
for (const { map } of perDateMaps) {
  for (const rec of map.values()) {
    const key = rec.coord
    merged.set(key, takeBetter(merged.get(key), rec))
  }
}

// ---------------------------------------------------------------------------
// sampledDates: union of previously-sampled dates (preserved from the file)
// and the dates just fetched. Sorted chronologically so the list reads
// naturally when inspected.
// ---------------------------------------------------------------------------
const prevDates = Array.isArray(existingEntry?.sampledDates) ? existingEntry.sampledDates : []
const newDates = perDateMaps.map((p) => p.date)
const sampledDates = Array.from(new Set([...prevDates, ...newDates])).sort()

// ---------------------------------------------------------------------------
// Write back — directReachable sorted by minMinutes ascending for scanability.
// ---------------------------------------------------------------------------
current[originStation.coord] = {
  name: originStation.name,
  crs: originCrs,
  directReachable: Object.fromEntries(
    [...merged.entries()]
      .sort((a, b) => a[1].minMinutes - b[1].minMinutes)
      .map(([coord, r]) => [coord, {
        name: r.name,
        crs: r.crs,
        minMinutes: r.minMinutes,
        services: r.services,
        fastestCallingPoints: r.fastestCallingPoints,
        // Parallel to fastestCallingPoints (same length): arrival time
        // from the service's origin in minutes. Drives calling-point-
        // as-hub routing downstream. Omitted from the output JSON
        // when undefined (older pre-schema entries) to keep the diff
        // clean — don't write a null field just to be explicit.
        ...(r.fastestCallingPointTimes !== undefined && {
          fastestCallingPointTimes: r.fastestCallingPointTimes,
        }),
        upstreamCallingPoints: r.upstreamCallingPoints ?? [],
      }])
  ),
  sampledDates,
  generatedAt: new Date().toISOString(),
}
writeFileSync(ROUTES_PATH, JSON.stringify(current, null, 2) + "\n")
console.log(`\nWrote ${ROUTES_PATH}`)
console.log(`  ${merged.size} total destinations after merging across ${sampledDates.length} sampled date(s)`)
console.log(`  Sampled dates: ${sampledDates.join(", ")}`)
