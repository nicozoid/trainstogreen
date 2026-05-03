#!/usr/bin/env node
// Rekeys data/terminal-matrix.json + data/tfl-hop-matrix.json from
// station names to CRS codes. Both outer and inner keys are migrated.
// Idempotent — running on already-migrated files is a no-op.
//
// NOTE: scripts/fetch-terminal-matrix.mjs and scripts/fetch-tfl-hops.mjs
// still PRODUCE these files with name-keyed output. They'll need
// updating in Phase 4 (boundary code) to write CRS-keyed output;
// running them today would overwrite this migration.

import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(__dirname, "..")

const stations = JSON.parse(fs.readFileSync(path.join(ROOT, "public/stations.json"), "utf8"))

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
  const existing = nameToId.get(norm)
  if (!existing || (crs.length === 3 && existing.length === 4)) {
    nameToId.set(norm, crs)
  }
}

// Manual disambiguation for ambiguous names — mirrors registry's
// STATION_ALIASES so the scripts and runtime agree.
const NAME_OVERRIDES = {
  "waterloo": "WAT",   // London Waterloo, not Liverpool's WLO
}

function nameToCrs(name) {
  const norm = normalize(name)
  return NAME_OVERRIDES[norm] ?? nameToId.get(norm)
}

function isLikelyId(s) {
  return /^[A-Z0-9]{3,4}$/.test(s)
}

function migrateMatrix(filename) {
  const filePath = path.join(ROOT, "data", filename)
  const orig = JSON.parse(fs.readFileSync(filePath, "utf8"))
  const out = {}
  const orphans = []
  let translatedOuter = 0
  let translatedInner = 0
  for (const [outerKey, inner] of Object.entries(orig)) {
    const outerId = isLikelyId(outerKey) ? outerKey : nameToCrs(outerKey)
    if (!outerId) {
      orphans.push(`outer: ${outerKey}`)
      continue
    }
    if (!isLikelyId(outerKey)) translatedOuter++
    const innerOut = {}
    for (const [innerKey, hop] of Object.entries(inner)) {
      const innerId = isLikelyId(innerKey) ? innerKey : nameToCrs(innerKey)
      if (!innerId) {
        orphans.push(`${outerKey} → ${innerKey}`)
        continue
      }
      if (!isLikelyId(innerKey)) translatedInner++
      innerOut[innerId] = hop
    }
    // Sort inner keys for stable diff.
    out[outerId] = Object.fromEntries(Object.entries(innerOut).sort(([a], [b]) => a.localeCompare(b)))
  }
  if (orphans.length) {
    console.error(`${filename}: ${orphans.length} unresolved keys`)
    for (const o of orphans.slice(0, 20)) console.error(`  ${o}`)
    process.exit(1)
  }
  // Sort outer keys for stable diff too.
  const sorted = Object.fromEntries(Object.entries(out).sort(([a], [b]) => a.localeCompare(b)))
  fs.writeFileSync(filePath, JSON.stringify(sorted, null, 2) + "\n")
  console.log(`${filename}: ${Object.keys(sorted).length} outer rows, translated ${translatedOuter} outer + ${translatedInner} inner names`)
}

migrateMatrix("terminal-matrix.json")
migrateMatrix("tfl-hop-matrix.json")
