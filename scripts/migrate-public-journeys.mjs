#!/usr/bin/env node
// Rekeys public/journeys/<slug>.json files from coord to station ID.
// Each file has shape: { origin: <coord>, journeys: { <destCoord>: {…} } }.
// After this migration: { origin: <station-id>, journeys: { <destId>: {…} } }.
// Idempotent — entries without commas pass through.

import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(__dirname, "..")

// Mirror lib/station-registry.ts so non-CRS stations (Underground,
// DLR, etc.) get their synthetic IDs (UEUS, DPDO, …) — matters for
// Google Routes journey files whose destinations include tube hops.
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
const STOPWORDS = new Set(["the", "of", "and", "at", "on", "in", "for", "to", "upon"])
function pickLetters(name) {
  const cleaned = name.replace(/\s*\([^)]*\)/g, "").replace(/['']/g, "")
    .replace(/&/g, " and ").replace(/[.,~/-]/g, " ").trim()
  const words = cleaned.split(/\s+/).filter(Boolean)
  const list = words.filter((w) => !STOPWORDS.has(w.toLowerCase()))
  const use = list.length ? list : words
  if (use.length >= 3) return (use[0][0] + use[1][0] + use[2][0]).toUpperCase()
  if (use.length === 2) return (use[0][0] + use[1].slice(0, 2)).toUpperCase()
  return use[0].slice(0, 3).padEnd(3, "X").toUpperCase()
}

const stations = JSON.parse(fs.readFileSync(path.join(ROOT, "public/stations.json"), "utf8"))
const coordToId = new Map()
for (const f of stations.features) {
  const [lng, lat] = f.geometry.coordinates
  const crs = f.properties["ref:crs"]
  const name = f.properties.name
  if (crs) coordToId.set(`${lng},${lat}`, crs)
  else if (name) coordToId.set(`${lng},${lat}`, networkPrefix(f.properties.network) + pickLetters(name))
}

function toId(key) {
  if (!key.includes(",")) return key
  return coordToId.get(key) ?? null
}

const journeyDir = path.join(ROOT, "public/journeys")
const files = fs.readdirSync(journeyDir).filter((f) => f.endsWith(".json"))

for (const file of files) {
  const filePath = path.join(journeyDir, file)
  const data = JSON.parse(fs.readFileSync(filePath, "utf8"))
  const newOrigin = toId(data.origin)
  if (!newOrigin) {
    console.error(`${file}: origin ${data.origin} doesn't resolve; skipping`)
    continue
  }
  const newJourneys = {}
  let dropped = 0
  for (const [destKey, entry] of Object.entries(data.journeys ?? {})) {
    const id = toId(destKey)
    if (!id) { dropped++; continue }
    newJourneys[id] = entry
  }
  const sorted = Object.fromEntries(Object.entries(newJourneys).sort(([a], [b]) => a.localeCompare(b)))
  fs.writeFileSync(filePath, JSON.stringify({ origin: newOrigin, journeys: sorted }))
  console.log(`${file}: ${Object.keys(sorted).length} destinations migrated (${dropped} dropped)`)
}
