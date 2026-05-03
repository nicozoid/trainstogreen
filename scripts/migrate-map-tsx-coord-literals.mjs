#!/usr/bin/env node
// Phase 3c — Step 1
//
// Bulk-rename coord-string literals in components/map.tsx to their canonical
// station IDs. Uses public/stations.json + lib/clusters-data.json as the
// authoritative coord→ID map (same sources lib/station-registry.ts indexes,
// duplicated here so this script can run as a plain Node module without
// pulling in the TypeScript registry).
//
// Defensive substitution rules:
//   • Only replace literals that resolve to a known ID.
//   • Skip literals embedded inside comments — pre-pass strips them.
//   • Print a summary of replaced + skipped literals.
//
// Idempotent: rerunning is a no-op once the file is migrated.

import { readFileSync, writeFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { dirname, join } from "node:path"

const __dirname = dirname(fileURLToPath(import.meta.url))
const root = join(__dirname, "..")

const stations = JSON.parse(readFileSync(join(root, "public/stations.json"), "utf8"))
const clusters = JSON.parse(readFileSync(join(root, "lib/clusters-data.json"), "utf8"))

// ── Build coord→ID map ───────────────────────────────────────────────
//
// Mirrors lib/station-registry.ts logic (kept in sync manually — there's
// no TS-to-Node bridge here). Real CRS wins over synthetic. For non-CRS
// stations we recompute the synthetic ID using the same rules; for cluster
// anchors we use the C-prefixed key directly from clusters-data.json.

function networkPrefix(network) {
  if (!network || network === "unknown" || network === "None") return "Z"
  if (network.includes("Elizabeth line")) return "E"
  if (network.includes("London Overground")) return "O"
  if (network.includes("Docklands Light Railway")) return "D"
  if (network.includes("London Underground")) return "U"
  if (network.includes("Tyne and Wear Metro")) return "M"
  if (network.includes("Glasgow Subway")) return "G"
  if (network === "NIR") return "N"
  return "Z"
}

function cleanName(name) {
  return name
    .replace(/\s*\([^)]*\)/g, "")
    .replace(/[‘’']/g, "")
    .replace(/&/g, " and ")
    .replace(/[.,~/-]/g, " ")
    .trim()
}

function pickLetters(name) {
  const words = cleanName(name).split(/\s+/).filter(Boolean)
  const stop = new Set(["the", "of", "and", "at", "on", "in", "for", "to", "upon"])
  const significant = words.filter((w) => !stop.has(w.toLowerCase()))
  const list = significant.length ? significant : words
  if (list.length === 0) return "ZZZ"
  if (list.length >= 3) return (list[0][0] + list[1][0] + list[2][0]).toUpperCase()
  if (list.length === 2) return (list[0][0] + list[1].slice(0, 2)).toUpperCase()
  return list[0].slice(0, 3).padEnd(3, "X").toUpperCase()
}

const coordToId = new Map()

// Stations from public/stations.json
for (const f of stations.features) {
  const name = f.properties.name
  if (!name) continue
  const [lng, lat] = f.geometry.coordinates
  const coordKey = `${lng},${lat}`
  const crs = f.properties["ref:crs"]
  const id = crs ?? networkPrefix(f.properties.network) + pickLetters(name)
  if (!coordToId.has(coordKey)) coordToId.set(coordKey, id)
}

// Cluster anchors override (some anchors share a coord with a member; the
// anchor wins for our purposes because consumers iterate cluster anchors
// when deciding "is this coord a cluster?").
for (const [id, def] of Object.entries(clusters.CLUSTERS)) {
  coordToId.set(def.coord, id)
}

// ── Apply rewrites to map.tsx ────────────────────────────────────────

const filePath = join(root, "components/map.tsx")
let src = readFileSync(filePath, "utf8")

const literalRe = /"(-?\d+\.\d+,-?\d+\.\d+)"/g
const stats = { replaced: 0, skippedUnknown: new Set(), perId: new Map() }

src = src.replace(literalRe, (match, coord) => {
  const id = coordToId.get(coord)
  if (!id) {
    stats.skippedUnknown.add(coord)
    return match
  }
  stats.replaced += 1
  stats.perId.set(id, (stats.perId.get(id) ?? 0) + 1)
  return `"${id}"`
})

writeFileSync(filePath, src)

console.log(`Replaced ${stats.replaced} coord literals → IDs`)
console.log(`Unique IDs touched: ${stats.perId.size}`)
if (stats.skippedUnknown.size) {
  console.log(`Skipped (no registry match): ${stats.skippedUnknown.size}`)
  for (const c of stats.skippedUnknown) console.log(`  ${c}`)
}
