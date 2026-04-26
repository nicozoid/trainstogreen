// Generates a priority-ordered list of London NR stations that still need
// TfL hop data fetched (i.e., a tfl-hop-matrix.json entry).
//
// Sister script to scripts/rtt-build-master-queue.mjs — same shape, but
// the workload is much smaller: each station = 15 TfL calls, free, no
// per-week quota. The queue is ordered so the most-useful primaries
// (heavy interchanges, well-connected stations) come first.
//
// Universe: stations in data/oyster-stations.json (the canonical "London
// NR" set, ~629 entries) ∩ stations with their own data/origin-routes.json
// entry (= they have RTT data, so their primary→destination journeys can
// be composed by the stitcher). As RTT coverage fills in via the master
// RTT queue, more stations become eligible here.
//
// Skipped: stations already present as keys in data/tfl-hop-matrix.json
// (15 hops fetched). Also skipped if they're one of the 15 termini —
// terminal-to-terminal hops live in terminal-matrix.json, not here.
//
// Priority ordering: terminal-customHubs DESC, directReachable DESC,
// name ASC. Stations reached by more termini have broader composition
// coverage out of the box; stations with more direct destinations are
// more useful as primaries (more hike destinations directly reachable).
//
// Output:
//   .tfl-queue/master-queue.txt — one CRS per line, priority-ordered.
//   .tfl-queue/master-queue.log — append-only log of generations.
//
// Usage: node scripts/tfl-build-master-queue.mjs

import { readFileSync, writeFileSync, mkdirSync, appendFileSync } from "fs"

const OYSTER_PATH = "data/oyster-stations.json"
const ORIGIN_ROUTES_PATH = "data/origin-routes.json"
const HOP_MATRIX_PATH = "data/tfl-hop-matrix.json"
const QUEUE_DIR = ".tfl-queue"
const QUEUE_PATH = `${QUEUE_DIR}/master-queue.txt`
const LOG_PATH = `${QUEUE_DIR}/master-queue.log`

const TERMINI_CRS = new Set([
  "KGX", "STP", "EUS", "CHX", "VIC", "WAT", "WAE", "MYB",
  "PAD", "MOG", "LST", "CST", "FST", "BFR", "LBG",
])

const oyster = JSON.parse(readFileSync(OYSTER_PATH, "utf-8"))
const oysterCrs = new Set(oyster.nrStations ?? [])

const originRoutes = JSON.parse(readFileSync(ORIGIN_ROUTES_PATH, "utf-8"))
const hopMatrix = (() => {
  try { return JSON.parse(readFileSync(HOP_MATRIX_PATH, "utf-8")) }
  catch { return {} }
})()

// Done = stations whose name appears as a top-level key in tfl-hop-matrix.
// (The matrix is keyed by name, not CRS — so we need to translate via
// origin-routes lookup.)
const doneNames = new Set(Object.keys(hopMatrix))

// Build CRS → entry index for fast iteration.
const byCrs = {}
for (const [coord, entry] of Object.entries(originRoutes)) {
  if (entry?.crs) byCrs[entry.crs] = { coord, ...entry }
}

// Priority score: bigger = higher priority. Components:
//   terminal_hubs   = number of central termini whose directReachable
//                     contains this station — i.e. how many lines from
//                     central London serve it directly.
//   direct_dests    = how many destinations this station reaches directly.
function priorityFor(crs, entry) {
  let terminalHubs = 0
  for (const [, originEntry] of Object.entries(originRoutes)) {
    if (!TERMINI_CRS.has(originEntry?.crs ?? "")) continue
    if (originEntry.directReachable?.[entry.coord]?.minMinutes != null) terminalHubs++
  }
  const directDests = Object.keys(entry.directReachable ?? {}).length
  return { terminalHubs, directDests }
}

const queue = []
let stats = { eligible: 0, skipped_no_rtt: 0, skipped_done: 0, skipped_terminus: 0 }

for (const crs of oysterCrs) {
  if (TERMINI_CRS.has(crs)) { stats.skipped_terminus++; continue }
  const entry = byCrs[crs]
  if (!entry) { stats.skipped_no_rtt++; continue }
  if (doneNames.has(entry.name)) { stats.skipped_done++; continue }
  const { terminalHubs, directDests } = priorityFor(crs, entry)
  queue.push({ crs, name: entry.name, terminalHubs, directDests })
  stats.eligible++
}

queue.sort((a, b) => {
  if (b.terminalHubs !== a.terminalHubs) return b.terminalHubs - a.terminalHubs
  if (b.directDests !== a.directDests) return b.directDests - a.directDests
  return a.name.localeCompare(b.name)
})

mkdirSync(QUEUE_DIR, { recursive: true })
const lines = queue.map(q => `${q.crs}  ${q.terminalHubs} hubs  ${q.directDests} dests  ${q.name}`)
writeFileSync(QUEUE_PATH, lines.join("\n") + (lines.length ? "\n" : ""))

const ts = new Date().toISOString()
const summary = `[${ts}] eligible=${stats.eligible} done=${stats.skipped_done} no-rtt=${stats.skipped_no_rtt} terminus=${stats.skipped_terminus}`
appendFileSync(LOG_PATH, summary + "\n")

console.log(summary)
console.log(`Queue: ${queue.length} stations → ${QUEUE_PATH}`)
if (queue.length > 0) {
  console.log(`\nTop 10:`)
  for (const q of queue.slice(0, 10)) {
    console.log(`  ${q.crs}  ${q.terminalHubs}h  ${q.directDests}d  ${q.name}`)
  }
}
