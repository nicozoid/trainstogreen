#!/usr/bin/env node
// Rekeys data/station-interchange-buffers.json from station names to
// CRS codes. The consumer (lib/interchange-buffers.ts) keeps its
// name-based public API but resolves names to CRS via the registry
// internally — see Phase 2g.

import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(__dirname, "..")

const stations = JSON.parse(fs.readFileSync(path.join(ROOT, "public/stations.json"), "utf8"))

// name → CRS lookup. Strip "London " prefix and trailing " Station" /
// " International" so common variants resolve, mirroring the rules
// in lib/station-registry.ts.
function normalize(name) {
  return name.toLowerCase()
    .replace(/^london\s+/i, "")
    .replace(/\s+(rail\s+)?station$/i, "")
    .replace(/\s+international$/i, "")
    .replace(/['']/g, "")
    .replace(/[.,&-]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
}

const nameToId = new Map()
for (const f of stations.features) {
  const crs = f.properties["ref:crs"]
  const name = f.properties.name
  if (!crs || !name) continue
  const norm = normalize(name)
  // Prefer real CRS over synthetic when there's a name collision
  // (Paddington NR over Paddington Underground, etc.).
  const existing = nameToId.get(norm)
  if (!existing || (crs.length === 3 && existing.length === 4)) {
    nameToId.set(norm, crs)
  }
}

// Manual disambiguation when a name matches multiple real-CRS stations.
// The interchange-buffers data is curated for major UK interchanges, so
// we always want the bigger/more-central station.
const NAME_OVERRIDES = {
  "waterloo": "WAT",  // London Waterloo, not Liverpool Waterloo (WLO)
}

const filePath = path.join(ROOT, "data/station-interchange-buffers.json")
const data = JSON.parse(fs.readFileSync(filePath, "utf8"))
const oldBuffers = data.buffers
const newBuffers = {}
const orphans = []
for (const [name, mins] of Object.entries(oldBuffers)) {
  // Already-migrated entries (3- or 4-char ID, no spaces) pass through.
  if (/^[A-Z0-9]{3,4}$/.test(name)) {
    newBuffers[name] = mins
    continue
  }
  const norm = normalize(name)
  const id = NAME_OVERRIDES[norm] ?? nameToId.get(norm)
  if (!id) {
    orphans.push(name)
    continue
  }
  newBuffers[id] = mins
}
if (orphans.length) {
  console.error("Could not resolve:")
  for (const o of orphans) console.error(`  ${o}`)
  process.exit(1)
}
const sorted = Object.fromEntries(Object.entries(newBuffers).sort(([a], [b]) => a.localeCompare(b)))
data.buffers = sorted
// Update the schema comment to reflect the new key shape.
data._ = data._.replace(
  /Per-station interchange buffer in minutes\..*?Stations not listed/s,
  "Per-station interchange buffer in minutes, keyed by station ID (CRS or 4-char synthetic). Replaces the previous flat 3-min / 5-min constants with per-station values, so journeys through bigger / busier interchanges (CLJ, RDG, KGX) get more realistic transfer times. Stations not listed",
)
fs.writeFileSync(filePath, JSON.stringify(data, null, 2) + "\n")
console.log(`Rekeyed ${Object.keys(sorted).length} buffers.`)
