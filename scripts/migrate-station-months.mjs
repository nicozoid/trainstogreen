#!/usr/bin/env node
// Rekeys data/station-months.json from coordKey to station ID. Built
// once per migration step — running again on already-migrated data is
// a no-op, so it's safe to re-execute if the file has been touched.

import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(__dirname, "..")

const stations = JSON.parse(fs.readFileSync(path.join(ROOT, "public/stations.json"), "utf8"))
const clusters = JSON.parse(fs.readFileSync(path.join(ROOT, "lib/clusters-data.json"), "utf8")).CLUSTERS

// Mirror the registry's coord→ID lookup: real CRS for stations.json
// features that have one, then C-prefix synthetic for cluster anchors.
// Both sources together cover every coord any data file should
// reference. Stations without ref:crs (heritage halts etc.) aren't in
// the months file anyway, so we don't need to cover them here.
const coordToId = new Map()
for (const f of stations.features) {
  const [lng, lat] = f.geometry.coordinates
  const crs = f.properties["ref:crs"]
  if (crs) coordToId.set(`${lng},${lat}`, crs)
}

// Cluster-anchor ID generation — duplicates the rules in
// lib/station-registry.ts so this Node script doesn't need TS imports.
// Keep in sync if the registry's CLUSTER_ID_OVERRIDES changes.
const CLUSTER_ID_OVERRIDES = {
  "-0.1316749,51.4276184": "CSTM", "-1.2001264,53.1527713": "CMSF",
  "-0.167866,51.3628865": "CCSH", "-0.8848748,51.4337601": "CWNS",
  "-2.8410923,53.6014878": "CBSC", "-2.4400492,50.7100345": "CDOC",
  "1.271333,51.9456913": "CHWC", "0.0551433,50.7923582": "CNHV",
  "-0.8063346,53.0808147": "CNWK", "-4.2725674,55.8391842": "CPOS",
  "-2.1577202,53.4428532": "CRDS", "-2.2656135,53.4845542": "CSFD",
  "-2.614673,53.3928419": "CWRG", "-3.4360381,50.6555068": "CLYS",
  "-5.0602303,50.149592": "CFLM", "0.5624634,51.8723022": "CBRT",
}
function pickLetters(name) {
  const cleaned = name.replace(/\s*\([^)]*\)/g, "").replace(/['']/g, "")
    .replace(/&/g, " and ").replace(/[.,~/-]/g, " ").trim()
  const stop = new Set(["the", "of", "and", "at", "on", "in", "for", "to", "upon"])
  const words = cleaned.split(/\s+/).filter(Boolean)
  const list = words.filter((w) => !stop.has(w.toLowerCase()))
  const use = list.length ? list : words
  if (use.length >= 3) return (use[0][0] + use[1][0] + use[2][0]).toUpperCase()
  if (use.length === 2) return (use[0][0] + use[1].slice(0, 2)).toUpperCase()
  return use[0].slice(0, 3).padEnd(3, "X").toUpperCase()
}
for (const [coord, def] of Object.entries(clusters)) {
  coordToId.set(coord, CLUSTER_ID_OVERRIDES[coord] ?? "C" + pickLetters(def.displayName))
}

const monthsPath = path.join(ROOT, "data/station-months.json")
const months = JSON.parse(fs.readFileSync(monthsPath, "utf8"))

const migrated = {}
const orphans = []
for (const [oldKey, value] of Object.entries(months)) {
  // Already migrated entries (3- or 4-char ID, no comma) pass through.
  if (!oldKey.includes(",")) {
    migrated[oldKey] = value
    continue
  }
  const id = coordToId.get(oldKey)
  if (!id) {
    orphans.push({ oldKey, name: value?.name })
    continue
  }
  migrated[id] = value
}

if (orphans.length) {
  console.error(`Could not migrate ${orphans.length} entries:`)
  for (const o of orphans) console.error(`  ${o.oldKey}  (${o.name})`)
  process.exit(1)
}

// Stable sort by ID so the diff is reviewable.
const sorted = Object.fromEntries(Object.entries(migrated).sort(([a], [b]) => a.localeCompare(b)))
fs.writeFileSync(monthsPath, JSON.stringify(sorted, null, 2) + "\n")
console.log(`Rekeyed ${Object.keys(sorted).length} entries.`)
