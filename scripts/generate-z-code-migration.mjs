#!/usr/bin/env node
// Generates a mapping from each OSM-tagged synthetic Z-prefix CRS code
// (e.g. "UKCR" for the Underground Kings Cross) to a fresh 4-character
// synthetic ID under the new prefix scheme:
//
//   U = London Underground            G = Glasgow Subway
//   D = Docklands Light Railway       N = Northern Ireland Railways
//   O = London Overground             E = Elizabeth line standalone
//   M = Tyne & Wear Metro             Z = unknown / heritage / fallback
//
// The 5 real-CRS Z-prefix codes (ZFD, ZLW, ZEL, ZCW, ZTU) are excluded
// — they appear in RTT data and are genuine ATOC codes.
//
// Output: prints JSON mapping to stdout, with a summary on stderr.
// Usage: node scripts/generate-z-code-migration.mjs > z-code-migration.json

import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(__dirname, "..")

const stations = JSON.parse(fs.readFileSync(path.join(ROOT, "public/stations.json"), "utf8"))

// Allowlist: real ATOC CRS codes that happen to start with Z. KEEP unchanged.
const REAL_NR_Z = new Set(["ZFD", "ZLW", "ZEL", "ZCW", "ZTU"])

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
    .replace(/['']/g, "")
    .replace(/&/g, " and ")
    .replace(/[.,~/-]/g, " ")
    .trim()
}

function pickLetters(name) {
  const words = cleanName(name).split(/\s+/).filter(Boolean)
  const stop = new Set(["the", "of", "and", "at", "on", "in", "for", "to", "upon"])
  const significant = words.filter((w) => !stop.has(w.toLowerCase()))
  const list = significant.length ? significant : words
  if (list.length >= 3) return (list[0][0] + list[1][0] + list[2][0]).toUpperCase()
  if (list.length === 2) return (list[0][0] + list[1].slice(0, 2)).toUpperCase()
  return list[0].slice(0, 3).padEnd(3, "X").toUpperCase()
}

// First pass: collect every (oldCode, station) pair we need to migrate.
const candidates = []
for (const f of stations.features) {
  const crs = f.properties["ref:crs"]
  if (!crs || crs[0] !== "Z" || REAL_NR_Z.has(crs)) continue
  candidates.push({
    oldCode: crs,
    name: f.properties.name,
    network: f.properties.network ?? "unknown",
    coord: f.geometry.coordinates,
  })
}

// Second pass: compute fresh 4-char IDs, using a collision counter to
// disambiguate by appending offsets when two stations would clash.
const used = new Set()
// Pre-claim every existing real CRS so we never collide with them.
for (const f of stations.features) {
  const crs = f.properties["ref:crs"]
  if (!crs) continue
  if (crs[0] === "Z" && !REAL_NR_Z.has(crs)) continue   // we're replacing these
  used.add(crs)
}

const mapping = {}     // oldCode -> newId
const collisions = []  // entries that needed disambiguation

for (const c of candidates) {
  const prefix = networkPrefix(c.network)
  const baseLetters = pickLetters(c.name)
  let id = prefix + baseLetters
  if (used.has(id)) {
    // Disambiguate by trying 2nd-letter variations of the last word.
    // Cheap approach: replace last char with successive letters of the
    // last word until we find a free slot.
    const lastWord = cleanName(c.name).split(/\s+/).filter(Boolean).pop() || c.name
    let resolved = false
    for (let i = 1; i < lastWord.length && !resolved; i++) {
      const candidate = (prefix + baseLetters.slice(0, 2) + lastWord[i]).toUpperCase()
      if (!used.has(candidate)) {
        id = candidate
        resolved = true
        collisions.push({ name: c.name, original: prefix + baseLetters, used: id })
      }
    }
    if (!resolved) {
      // Numerical fallback (very rare).
      for (let n = 2; n <= 9; n++) {
        const candidate = prefix + baseLetters.slice(0, 2) + String(n)
        if (!used.has(candidate)) {
          id = candidate
          resolved = true
          collisions.push({ name: c.name, original: prefix + baseLetters, used: id })
          break
        }
      }
    }
    if (!resolved) {
      throw new Error(`Could not allocate unique ID for ${c.name} (${c.oldCode})`)
    }
  }
  used.add(id)
  mapping[c.oldCode] = id
}

console.error(`Generated ${Object.keys(mapping).length} migrations`)
console.error(`Disambiguations needed: ${collisions.length}`)
if (collisions.length) {
  console.error("Disambiguations:")
  for (const c of collisions) console.error(`  ${c.name}: ${c.original} -> ${c.used}`)
}

// Output: a sorted, deterministic mapping as JSON
const sorted = Object.fromEntries(Object.entries(mapping).sort(([a], [b]) => a.localeCompare(b)))
process.stdout.write(JSON.stringify(sorted, null, 2) + "\n")
