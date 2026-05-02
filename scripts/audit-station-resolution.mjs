#!/usr/bin/env node
// Audits every station reference across the data files to confirm it
// resolves through the registry. Reports unmatched references grouped
// by file so you can spot data drift before kicking off the bigger
// data-key migration.
//
// Checks performed:
//   • origin-routes.json:        top-level keys (coordKeys), each
//                                entry's `crs`, every directReachable
//                                key (coordKey) and inner crs.
//   • station-notes.json:        top-level keys (coordKeys).
//   • station-months.json:       top-level keys (coordKeys).
//   • stations-by-source.json:   every coordKey in the source arrays.
//   • clusters-data.json:        anchor coordKeys + every member.
//   • manual-walks.json:         startStation / endStation (CRS).
//   • rambler-walks.json:        startStation / endStation per walk.
//   • crs-to-naptan.json:        keys (CRS).
//   • oyster-stations.json:      nrStations (array of CRS).
//
// Usage:  node scripts/audit-station-resolution.mjs
// Exits 1 on any unresolved reference; 0 on a clean audit.

import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(__dirname, "..")

// ── Load the registry by hand (the .ts file imports JSON via TS-only
//    syntax, so we replicate the lookups against stations.json +
//    clusters-data.json directly to keep this script Node-only).
const stations = JSON.parse(fs.readFileSync(path.join(ROOT, "public/stations.json"), "utf8"))
const clusters = JSON.parse(fs.readFileSync(path.join(ROOT, "lib/clusters-data.json"), "utf8")).CLUSTERS

const coordKeyToId = new Map()
const idSet = new Set()
for (const f of stations.features) {
  const [lng, lat] = f.geometry.coordinates
  const coordKey = `${lng},${lat}`
  const id = f.properties["ref:crs"] || null
  if (id) {
    coordKeyToId.set(coordKey, id)
    idSet.add(id)
  } else {
    // Without a ref:crs the registry would synthesise an ID; for the
    // audit we just track whether the coord exists in stations.json,
    // so the synthesised value doesn't matter here.
    coordKeyToId.set(coordKey, null)
  }
}
for (const [coordKey, def] of Object.entries(clusters)) {
  // Cluster anchors are synthetic; every anchor must have a coord but
  // its registry ID is generated. Mark the coord as known.
  coordKeyToId.set(coordKey, "synthetic-cluster-anchor")
}

// ── Helpers for reporting ────────────────────────────────────────────

const issues = []
function report(file, kind, ref, context) {
  issues.push({ file, kind, ref, context })
}

function checkCoord(file, kind, ref, context) {
  if (!coordKeyToId.has(ref)) report(file, kind, ref, context)
}
function checkId(file, kind, ref, context) {
  if (!idSet.has(ref)) report(file, kind, ref, context)
}

// ── Audit each data file ─────────────────────────────────────────────

const originRoutes = JSON.parse(fs.readFileSync(path.join(ROOT, "data/origin-routes.json"), "utf8"))
for (const [coord, data] of Object.entries(originRoutes)) {
  checkCoord("origin-routes.json", "origin-coord", coord, data.name)
  if (data.crs) checkId("origin-routes.json", "origin-crs", data.crs, `origin ${data.name}`)
  for (const [destCoord, dest] of Object.entries(data.directReachable ?? {})) {
    checkCoord("origin-routes.json", "destination-coord", destCoord, `from ${data.name} to ${dest.name ?? "?"}`)
    if (dest.crs) checkId("origin-routes.json", "destination-crs", dest.crs, `from ${data.name} to ${dest.name ?? "?"}`)
  }
}

const notes = JSON.parse(fs.readFileSync(path.join(ROOT, "data/station-notes.json"), "utf8"))
for (const coord of Object.keys(notes)) {
  checkCoord("station-notes.json", "key", coord, notes[coord]?.name)
}

const months = JSON.parse(fs.readFileSync(path.join(ROOT, "data/station-months.json"), "utf8"))
for (const coord of Object.keys(months)) {
  checkCoord("station-months.json", "key", coord, months[coord]?.name)
}

const sources = JSON.parse(fs.readFileSync(path.join(ROOT, "data/stations-by-source.json"), "utf8"))
for (const [src, arr] of Object.entries(sources)) {
  for (const coord of arr) {
    checkCoord("stations-by-source.json", `source:${src}`, coord, src)
  }
}

for (const [anchor, def] of Object.entries(clusters)) {
  checkCoord("clusters-data.json", "anchor-coord", anchor, def.displayName)
  for (const m of def.members) {
    checkCoord("clusters-data.json", "member-coord", m, def.displayName)
  }
}

// Walks: both manual-walks.json and rambler-walks.json keep entries
// keyed by slug, each with a `walks` array of actual walks. The walk
// objects have startStation/endStation (CRS codes, or null when the
// walk doesn't fit a clean station-to-station shape).
function auditWalkBundle(file) {
  const data = JSON.parse(fs.readFileSync(path.join(ROOT, "data", file), "utf8"))
  for (const [slug, entry] of Object.entries(data)) {
    if (slug.startsWith("_")) continue   // skip "_readme" etc.
    for (const w of entry.walks ?? []) {
      if (w.startStation) checkId(file, "startStation", w.startStation, entry.title ?? slug)
      if (w.endStation) checkId(file, "endStation", w.endStation, entry.title ?? slug)
    }
  }
}
auditWalkBundle("manual-walks.json")
auditWalkBundle("rambler-walks.json")

// crs-to-naptan.json wraps the lookup in a `naptan` field, with a
// sibling `_` containing the schema comment.
const naptanFile = JSON.parse(fs.readFileSync(path.join(ROOT, "data/crs-to-naptan.json"), "utf8"))
for (const crs of Object.keys(naptanFile.naptan ?? {})) {
  checkId("crs-to-naptan.json", "key", crs, naptanFile.naptan[crs])
}

const oyster = JSON.parse(fs.readFileSync(path.join(ROOT, "data/oyster-stations.json"), "utf8"))
for (const crs of oyster.nrStations ?? []) checkId("oyster-stations.json", "nrStation", crs, "")

// ── Report ───────────────────────────────────────────────────────────

if (issues.length === 0) {
  console.log("Audit clean — every reference resolves.")
  process.exit(0)
}

const byFile = new Map()
for (const i of issues) {
  if (!byFile.has(i.file)) byFile.set(i.file, [])
  byFile.get(i.file).push(i)
}

console.log(`Audit found ${issues.length} unresolved references in ${byFile.size} files:`)
for (const [file, list] of [...byFile.entries()].sort()) {
  console.log()
  console.log(`  ${file} — ${list.length}`)
  for (const i of list.slice(0, 20)) {
    const ctx = i.context ? `  (${i.context})` : ""
    console.log(`    [${i.kind}] ${i.ref}${ctx}`)
  }
  if (list.length > 20) console.log(`    ... ${list.length - 20} more`)
}
process.exit(1)
