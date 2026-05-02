#!/usr/bin/env node
// Rekeys the family of station-array data files from coordKey to
// station ID:
//   - data/stations-by-source.json   (object: { source: string[] })
//   - data/stations-hiked.json       (array)
//   - data/stations-with-komoot.json (array)
//   - data/stations-potential-months.json (array)
//   - data/placemark-stations.json   (array)
// Same coord→ID rules as the registry (CRS for real stations, C-prefix
// synthetic for cluster anchors). Idempotent.

import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(__dirname, "..")

const stations = JSON.parse(fs.readFileSync(path.join(ROOT, "public/stations.json"), "utf8"))
const clusters = JSON.parse(fs.readFileSync(path.join(ROOT, "lib/clusters-data.json"), "utf8")).CLUSTERS

const coordToId = new Map()
for (const f of stations.features) {
  const [lng, lat] = f.geometry.coordinates
  const crs = f.properties["ref:crs"]
  if (crs) coordToId.set(`${lng},${lat}`, crs)
}
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

// Translate a single key. Idempotent: keys without a comma are
// considered already-migrated IDs and pass through unchanged.
function toId(key) {
  if (!key.includes(",")) return key
  const id = coordToId.get(key)
  if (!id) {
    console.error(`  unresolved: ${key}`)
    return null
  }
  return id
}

function migrateArrayFile(file) {
  const p = path.join(ROOT, "data", file)
  const arr = JSON.parse(fs.readFileSync(p, "utf8"))
  const ids = arr.map(toId).filter((x) => x !== null)
  ids.sort()
  fs.writeFileSync(p, JSON.stringify(ids, null, 2) + "\n")
  console.log(`${file}: ${arr.length} → ${ids.length} entries`)
}

function migrateBySourceFile() {
  const p = path.join(ROOT, "data/stations-by-source.json")
  const obj = JSON.parse(fs.readFileSync(p, "utf8"))
  const out = {}
  for (const [source, arr] of Object.entries(obj)) {
    const ids = arr.map(toId).filter((x) => x !== null)
    ids.sort()
    out[source] = ids
  }
  // Sort source keys alphabetically too for stable diff.
  const sorted = Object.fromEntries(Object.entries(out).sort(([a], [b]) => a.localeCompare(b)))
  fs.writeFileSync(p, JSON.stringify(sorted, null, 2) + "\n")
  const total = Object.values(sorted).reduce((s, a) => s + a.length, 0)
  console.log(`stations-by-source.json: ${Object.keys(sorted).length} sources, ${total} entries`)
}

migrateBySourceFile()
migrateArrayFile("stations-hiked.json")
migrateArrayFile("stations-with-komoot.json")
migrateArrayFile("stations-potential-months.json")
migrateArrayFile("placemark-stations.json")
