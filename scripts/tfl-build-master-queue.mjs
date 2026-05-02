// Generates a priority-ordered list of stations that still need TfL hop
// data fetched (i.e., a tfl-hop-matrix.json entry).
//
// Sister script to scripts/rtt-build-master-queue.mjs — same shape, but
// the workload is much smaller: each station = 15 TfL calls, free, no
// per-week quota. The queue is ordered so the most-useful primaries
// (heavy interchanges, well-connected stations) come first.
//
// Universe: every NR/Elizabeth-line/Overground station in
// public/stations.json whose coord falls inside the primary-search
// bounding box used by the runtime (lat 51.10–51.95, lng -1.05–0.40).
// That box is the geographic filter for "stations a Londoner might pick
// as their home", so it's also the right scope for primary→terminus
// TfL hops.
//
// IMPORTANT — TfL hops are fetched in ADVANCE of RTT data: the matrix
// is keyed by station name and only needs that + the 15 termini, so a
// station can have hops baked in long before its RTT data lands. The
// runtime's hasData check still requires RTT to flip a station from
// 'Coming soon' to selectable, so pre-fetched hops cause no UX harm
// while waiting for RTT.
//
// Priority ordering: when RTT data is present we sort by terminal-hubs
// DESC then direct-dests DESC (well-connected first); stations without
// RTT yet sort to the bottom by name only — we don't have a good
// proxy for their importance until their direct-reachable set is
// known. Names ASC tie-break.
//
// Skipped: stations already present as keys in data/tfl-hop-matrix.json
// (15 hops fetched). Also skipped if they're one of the 15 termini —
// terminal-to-terminal hops live in terminal-matrix.json, not here.
//
// Output:
//   .tfl-queue/master-queue.txt — one CRS per line, priority-ordered.
//   .tfl-queue/master-queue.log — append-only log of generations.
//
// Usage: node scripts/tfl-build-master-queue.mjs

import { readFileSync, writeFileSync, mkdirSync, appendFileSync } from "fs"

const STATIONS_PATH = "public/stations.json"
const ORIGIN_ROUTES_PATH = "data/origin-routes.json"
const HOP_MATRIX_PATH = "data/tfl-hop-matrix.json"
const QUEUE_DIR = ".tfl-queue"
const QUEUE_PATH = `${QUEUE_DIR}/master-queue.txt`
const LOG_PATH = `${QUEUE_DIR}/master-queue.log`

const TERMINI_CRS = new Set([
  "KGX", "STP", "EUS", "CHX", "VIC", "WAT", "WAE", "MYB",
  "PAD", "MOG", "LST", "CST", "FST", "BFR", "LBG",
])

// Same bounding box the runtime uses for primary-dropdown searchableStations
// — see components/map.tsx. Keep these in sync; widening one without the
// other would queue stations that the dropdown would never expose, or
// expose stations the queue never fetched hops for.
const BBOX = { latMin: 51.10, latMax: 51.95, lngMin: -1.05, lngMax: 0.40 }
const inBox = (lat, lng) =>
  lat > BBOX.latMin && lat < BBOX.latMax && lng > BBOX.lngMin && lng < BBOX.lngMax

const stations = JSON.parse(readFileSync(STATIONS_PATH, "utf-8"))
// origin-routes.json + tfl-hop-matrix.json are both keyed by station
// ID (CRS or 4-char synthetic) post Phase 2. Outer + inner keys are
// IDs throughout.
const originRoutes = JSON.parse(readFileSync(ORIGIN_ROUTES_PATH, "utf-8"))
const hopMatrix = (() => {
  try { return JSON.parse(readFileSync(HOP_MATRIX_PATH, "utf-8")) }
  catch { return {} }
})()

// Done = stations whose CRS appears as a top-level key in tfl-hop-matrix.
const doneCrs = new Set(Object.keys(hopMatrix))

// Priority score: bigger = higher priority. Components:
//   terminal_hubs   = number of central termini whose directReachable
//                     contains this station — i.e. how many lines from
//                     central London serve it directly.
//   direct_dests    = how many destinations this station reaches directly.
// Stations without RTT data return zero/zero — they sort to the
// bottom of the queue, fetched after everything we have priority
// data for.
function priorityFor(crs) {
  const entry = originRoutes[crs]
  if (!entry) return { terminalHubs: 0, directDests: 0, hasRtt: false }
  let terminalHubs = 0
  for (const terminusCrs of TERMINI_CRS) {
    const terminusEntry = originRoutes[terminusCrs]
    if (terminusEntry?.directReachable?.[crs]?.minMinutes != null) terminalHubs++
  }
  const directDests = Object.keys(entry.directReachable ?? {}).length
  return { terminalHubs, directDests, hasRtt: true }
}

const queue = []
const seenCrs = new Set()
let stats = {
  eligible_with_rtt: 0,
  eligible_no_rtt: 0,
  skipped_outside_bbox: 0,
  skipped_done: 0,
  skipped_terminus: 0,
  skipped_not_nr: 0,
  skipped_no_crs: 0,
}

// NR/Elizabeth/Overground network filter — same as the runtime's
// searchableStations universe. Tube-only stations don't have CRS codes
// and wouldn't pass anyway, but the explicit filter keeps the criteria
// readable.
const NR_NETWORK = /National Rail|Elizabeth line|London Overground/

for (const f of stations.features ?? []) {
  const crs = f.properties?.["ref:crs"]
  if (!crs) { stats.skipped_no_crs++; continue }
  if (seenCrs.has(crs)) continue   // dedupe (some CRSes appear twice in OSM)
  seenCrs.add(crs)
  if (TERMINI_CRS.has(crs)) { stats.skipped_terminus++; continue }
  const network = f.properties?.["network"] ?? ""
  if (!NR_NETWORK.test(network)) { stats.skipped_not_nr++; continue }
  const [lng, lat] = f.geometry?.coordinates ?? [NaN, NaN]
  if (!Number.isFinite(lng) || !Number.isFinite(lat) || !inBox(lat, lng)) {
    stats.skipped_outside_bbox++; continue
  }
  // Hop matrix is now keyed by CRS — single check.
  if (doneCrs.has(crs)) {
    stats.skipped_done++; continue
  }
  const osmName = f.properties.name
  const rttEntry = originRoutes[crs]
  const rttName = rttEntry?.name
  const { terminalHubs, directDests, hasRtt } = priorityFor(crs)
  // Use the RTT name when available so the queue label matches what
  // the user sees in the app; fall back to OSM name otherwise.
  const queueName = rttName ?? osmName
  queue.push({ crs, name: queueName, terminalHubs, directDests, hasRtt })
  if (hasRtt) stats.eligible_with_rtt++
  else stats.eligible_no_rtt++
}

queue.sort((a, b) => {
  // RTT-backed stations first (we know their importance); RTT-less
  // stations after, sorted alphabetically (no signal to prioritise).
  if (a.hasRtt !== b.hasRtt) return a.hasRtt ? -1 : 1
  if (b.terminalHubs !== a.terminalHubs) return b.terminalHubs - a.terminalHubs
  if (b.directDests !== a.directDests) return b.directDests - a.directDests
  return a.name.localeCompare(b.name)
})

mkdirSync(QUEUE_DIR, { recursive: true })
const lines = queue.map(q => {
  const tag = q.hasRtt ? `${q.terminalHubs} hubs  ${q.directDests} dests` : `no-rtt`.padEnd(18)
  return `${q.crs}  ${tag}  ${q.name}`
})
writeFileSync(QUEUE_PATH, lines.join("\n") + (lines.length ? "\n" : ""))

const ts = new Date().toISOString()
const eligible = stats.eligible_with_rtt + stats.eligible_no_rtt
const summary = `[${ts}] eligible=${eligible} (rtt=${stats.eligible_with_rtt} no-rtt=${stats.eligible_no_rtt}) done=${stats.skipped_done} terminus=${stats.skipped_terminus} outside-bbox=${stats.skipped_outside_bbox}`
appendFileSync(LOG_PATH, summary + "\n")

console.log(summary)
console.log(`Queue: ${queue.length} stations → ${QUEUE_PATH}`)
if (queue.length > 0) {
  console.log(`\nTop 10:`)
  for (const q of queue.slice(0, 10)) {
    const tag = q.hasRtt ? `${q.terminalHubs}h  ${q.directDests}d` : "no-rtt"
    console.log(`  ${q.crs}  ${tag}  ${q.name}`)
  }
}
