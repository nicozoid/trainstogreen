#!/usr/bin/env node
// Rekeys lib/clusters-data.json to ID-keyed shape:
//   Before: { "lng,lat": { displayName, members: ["lng,lat"], isPrimaryOrigin, isFriendOrigin } }
//   After:  { "C___": { displayName, coord: "lng,lat", members: ["CRS", ...], isPrimaryOrigin, isFriendOrigin } }
// where "C___" is a 4-char synthetic ID generated from the displayName,
// and member coords are translated to their station IDs (CRS or
// 4-char synthetic).
// Idempotent: detects already-migrated shape (4-char keys, coord field
// present) and exits without changes.

import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(__dirname, "..")

// Synthetic-ID rules mirror lib/station-registry.ts so this script
// can run in plain Node without TypeScript imports.
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

const stations = JSON.parse(fs.readFileSync(path.join(ROOT, "public/stations.json"), "utf8"))
const coordToId = new Map()
for (const f of stations.features) {
  const [lng, lat] = f.geometry.coordinates
  const crs = f.properties["ref:crs"]
  if (crs) {
    coordToId.set(`${lng},${lat}`, crs)
  } else if (f.properties.name) {
    // Mirror the registry's synthetic-ID generation for non-CRS stations
    // so cluster members like "Euston (Underground)" get IDs like UEUS.
    const id = networkPrefix(f.properties.network) + pickLetters(f.properties.name)
    coordToId.set(`${lng},${lat}`, id)
  }
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

const filePath = path.join(ROOT, "lib/clusters-data.json")
const data = JSON.parse(fs.readFileSync(filePath, "utf8"))
const oldClusters = data.CLUSTERS

// Detect already-migrated shape: a key without a comma (4-char ID).
const sampleKey = Object.keys(oldClusters)[0]
if (sampleKey && !sampleKey.includes(",")) {
  console.log("clusters-data.json already migrated; nothing to do.")
  process.exit(0)
}

const newClusters = {}
const orphans = []
for (const [anchorCoord, def] of Object.entries(oldClusters)) {
  const id = CLUSTER_ID_OVERRIDES[anchorCoord] ?? "C" + pickLetters(def.displayName)
  if (newClusters[id]) {
    orphans.push(`duplicate ID ${id}: anchor ${anchorCoord} (${def.displayName}) collides with ${newClusters[id].displayName}`)
    continue
  }
  const memberIds = []
  for (const memberCoord of def.members) {
    const memberId = coordToId.get(memberCoord)
    if (!memberId) {
      orphans.push(`${def.displayName} member ${memberCoord} has no station registry entry`)
      continue
    }
    memberIds.push(memberId)
  }
  newClusters[id] = {
    displayName: def.displayName,
    coord: anchorCoord,
    members: memberIds,
    isPrimaryOrigin: def.isPrimaryOrigin,
    isFriendOrigin: def.isFriendOrigin,
  }
}

if (orphans.length) {
  console.error(`Could not migrate ${orphans.length} entries:`)
  for (const o of orphans.slice(0, 20)) console.error(`  ${o}`)
  process.exit(1)
}

const sorted = Object.fromEntries(Object.entries(newClusters).sort(([a], [b]) => a.localeCompare(b)))
fs.writeFileSync(filePath, JSON.stringify({ CLUSTERS: sorted }, null, 2) + "\n")
console.log(`clusters-data.json: ${Object.keys(sorted).length} clusters rekeyed to ID-shape with embedded coord field.`)
