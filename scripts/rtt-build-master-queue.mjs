// Generates /tmp/ttg-rtt/master-queue.txt — every UK mainland NR station
// not already in origin-routes.json or queued in cities-queue/london-nr-queue,
// ordered by national priority (south-first, then west, then north, then
// Scotland; with a clear regional grouping the smart runner uses purely as
// ordering — there's no separate "phase" gate, the runner just picks up
// from wherever the master file's done set hits).
//
// Output format: one CRS per line, with `# Region` comment headers between
// regional groups. Lines starting with `#` are skipped by the runner.

import { readFileSync, writeFileSync, mkdirSync } from "fs"
import path from "path"
import { fileURLToPath } from "url"

// Resolve repo root from this file's location so the script works in any
// worktree / clone (no hardcoded path).
const __dirname = path.dirname(fileURLToPath(import.meta.url))
const repoRoot = path.resolve(__dirname, "..")
const stations = JSON.parse(readFileSync(path.join(repoRoot, "data/stations.fat.json"), "utf8"))
const originRoutes = JSON.parse(readFileSync(path.join(repoRoot, "data/origin-routes.json"), "utf8"))
const fetched = new Set(Object.values(originRoutes).map((o) => o.crs))

// origin-routes.json is the single source of truth for "already done".
// The master queue includes EVERY mainland NR station; the smart runner
// skips already-fetched ones at run time. If a separate one-off chain
// (like the original cities-queue / london-nr-queue) is still running,
// either the runner skips its in-flight stations after they land in
// origin-routes.json, or — if the chain dies mid-run — the master queue
// picks up the orphans automatically. No manual exclusion list to keep
// in sync.

// Bounding-box-based regional classification. Stations get assigned to the
// FIRST region whose bbox contains them, in priority order. Each region's
// stations are sorted within by name (alphabetical) for deterministic
// output; the runner doesn't care, but this keeps regen diffs minimal.
const regions = [
  // [name, bbox: minLng, minLat, maxLng, maxLat]
  // Greater London (already mostly covered by london-nr-queue, but capture stragglers)
  ["Greater London tail", -0.55, 51.28, 0.30, 51.70],
  // South + South-East England (commuter belt + S Coast)
  ["South / South-East England", -2.0, 50.50, 1.60, 51.70],
  // East Anglia (Essex / Suffolk / Norfolk / Cambs)
  ["East Anglia", -0.30, 51.70, 1.85, 53.00],
  // South Midlands (Bucks/Beds/Herts/Northants/Warks)
  ["South Midlands", -2.00, 51.70, -0.30, 52.80],
  // West Country (Bristol/Wessex/Devon/Cornwall)
  ["West Country", -6.50, 50.00, -2.00, 51.70],
  // Wales (full)
  ["Wales", -5.50, 51.40, -2.50, 53.50],
  // North Midlands (Stoke/Leics/Notts/Lincs)
  ["North Midlands", -2.50, 52.80, 0.50, 53.50],
  // Yorkshire & Humberside
  ["Yorkshire & Humberside", -2.50, 53.50, 0.50, 54.50],
  // North-West England (Lancs / Manchester suburbs / Cheshire)
  ["North-West England", -3.50, 53.00, -1.80, 54.30],
  // North-East England (Tyneside, Durham, Teesside)
  ["North-East England", -2.00, 54.30, 0.00, 55.50],
  // Cumbria / Lake District
  ["Cumbria & Lake District", -3.80, 54.00, -2.50, 55.20],
  // Scotland Lowlands + Borders
  ["Scotland Lowlands & Borders", -5.50, 55.00, -1.80, 56.50],
  // Scotland Highlands & Far North
  ["Scotland Highlands & Far North", -7.50, 56.50, -1.50, 60.50],
]

function regionOf(lng, lat) {
  for (const [name, minLng, minLat, maxLng, maxLat] of regions) {
    if (lng >= minLng && lng <= maxLng && lat >= minLat && lat <= maxLat) return name
  }
  return "Unclassified"
}

// Importance score within a region: junctions / multi-network / town centres
// score higher; small commuter halts last.
function rank(f) {
  const network = f.properties?.network ?? ""
  const networks = network.split(";")
  const name = f.properties?.name ?? ""
  let score = 0
  if (networks.length >= 4) score += 100
  else if (networks.length === 3) score += 60
  else if (networks.length === 2) score += 30
  if (/Junction|Interchange|Terminal|Parkway/i.test(name)) score += 40
  if (/Central$|^Central/i.test(name)) score += 30
  if (/Park$/i.test(name)) score -= 5
  if (/Wood$|Hill$|Lane$|Heath$/i.test(name)) score -= 10
  if (/Golf|Halt/i.test(name)) score -= 50
  return score
}

// Demoted CRSes — stations whose service density blows the RTT per-minute
// rate-limit so badly that they spend hours stuck in retry-loops. We push
// them to the very end of the queue; they'll only get attempted after every
// less-problematic station is done, by which point the cap may have
// freed up and/or we'll have a better strategy.
const DEMOTED = new Set([
  "ZLW", // Whitechapel — Liz/Overground hub, 198 services, 26+ skips per attempt
])

// Filter to mainland Britain NR stations not already fetched / queued.
const candidates = stations.features.filter((f) => {
  const network = f.properties?.network ?? ""
  if (!/National Rail|Elizabeth line/.test(network)) return false
  const crs = f.properties?.["ref:crs"]
  if (!crs) return false
  if (fetched.has(crs)) return false
  // Crude "mainland Britain" filter — exclude Northern Ireland, Channel Islands,
  // and offshore. Greater Britain bounding box: lng ≥ -8, lat 49.8–60.8.
  const [lng, lat] = f.geometry.coordinates
  if (lng < -8 || lng > 1.9 || lat < 49.8 || lat > 60.9) return false
  return true
})

// Pull demoted stations out of the main grouping — they get appended at the
// very end of the queue regardless of region, after Unclassified.
const demotedFeatures = candidates.filter((f) => DEMOTED.has(f.properties?.["ref:crs"]))
const mainCandidates = candidates.filter((f) => !DEMOTED.has(f.properties?.["ref:crs"]))

// Group by region, then sort within region by rank then by name.
const byRegion = new Map()
for (const f of mainCandidates) {
  const [lng, lat] = f.geometry.coordinates
  const region = regionOf(lng, lat)
  if (!byRegion.has(region)) byRegion.set(region, [])
  byRegion.get(region).push(f)
}
for (const [region, list] of byRegion) {
  list.sort((a, b) => {
    const ra = rank(a)
    const rb = rank(b)
    if (rb !== ra) return rb - ra
    return (a.properties.name ?? "").localeCompare(b.properties.name ?? "")
  })
}

// Emit in the priority order defined by the regions array (NOT
// alphabetical — south-first then north then Scotland).
const lines = []
lines.push("# Master RTT-fetch queue — generated " + new Date().toISOString())
lines.push(`# Total candidates: ${candidates.length}`)
lines.push(`# Already fetched: ${fetched.size}`)
lines.push(`#`)
lines.push(`# Workflow: smart runner reads this file, skips lines starting with #`)
lines.push(`# and any CRS already in origin-routes.json, fetches each remaining`)
lines.push(`# CRS until weekly cap hits. Re-running picks up where it left off.`)
lines.push("")
let cumulative = 0
for (const [region] of regions) {
  const list = byRegion.get(region)
  if (!list || list.length === 0) continue
  cumulative += list.length
  lines.push(`# === ${region} (${list.length} stations) — running total: ${cumulative} ===`)
  for (const f of list) {
    const crs = f.properties["ref:crs"]
    const name = f.properties.name
    lines.push(`${crs}  # ${name}`)
  }
  lines.push("")
}
const unclassified = byRegion.get("Unclassified")
if (unclassified?.length) {
  lines.push(`# === Unclassified (${unclassified.length}) — likely offshore / boundary cases ===`)
  for (const f of unclassified) {
    const crs = f.properties["ref:crs"]
    const name = f.properties.name
    lines.push(`${crs}  # ${name}`)
  }
  lines.push("")
}

// Demoted stations go absolutely last — only attempted if everything
// else is done.
if (demotedFeatures.length) {
  lines.push(`# === Demoted (${demotedFeatures.length}) — known rate-limit-storm hubs, attempt last ===`)
  for (const f of demotedFeatures) {
    const crs = f.properties["ref:crs"]
    const name = f.properties.name
    lines.push(`${crs}  # ${name}`)
  }
}

// Write into a stable, predictable location next to the script. The
// runner reads from the same path. Not committed to git — the file is
// regenerated from origin-routes.json + stations.fat.json on each
// build, and the diff would be noisy.
const outDir = path.join(repoRoot, ".rtt-queue")
mkdirSync(outDir, { recursive: true })
const outPath = path.join(outDir, "master-queue.txt")
writeFileSync(outPath, lines.join("\n") + "\n")
console.log(`Master queue written to ${outPath}`)
console.log(`  ${candidates.length} stations across ${byRegion.size} regions:`)
for (const [region, list] of byRegion) {
  console.log(`  ${region.padEnd(35)} ${String(list.length).padStart(4)} stations`)
}
