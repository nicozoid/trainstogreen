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
//   • walks.json:                startStation / endStation per walk.
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

// Mirror the registry's synthetic-ID rules so the audit knows about
// every legitimate non-CRS station ID (UEUS, UPAD etc.) that data
// files might reference. Keep in sync with lib/station-registry.ts.
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

// Mirror the registry's ID_OVERRIDES so the audit knows which coord-
// keyed manual disambiguations it should expect. Keep this in sync
// with lib/station-registry.ts:ID_OVERRIDES.
const ID_OVERRIDES_PATH = path.join(ROOT, "lib/station-registry.ts")
const ID_OVERRIDES = (() => {
  // Parse just the ID_OVERRIDES literal out of the registry source so
  // the audit can re-run without a TS/JS bridge. Tolerant of missing
  // entries.
  const src = fs.readFileSync(ID_OVERRIDES_PATH, "utf8")
  const m = src.match(/const ID_OVERRIDES:[^=]*=\s*\{([^}]*)\}/s)
  if (!m) return {}
  const body = m[1]
  const out = {}
  for (const line of body.split("\n")) {
    const entry = line.match(/"([^"]+)"\s*:\s*"([^"]+)"/)
    if (entry) out[entry[1]] = entry[2]
  }
  return out
})()

const coordKeyToId = new Map()
const idSet = new Set()
// Track which stations resolve to each id so we can flag collisions
// among rendered features (NR + Underground + DLR, no tourism). Keyed
// by id → array of { coord, name, network }.
const idToRenderedStations = new Map()
function isMapRendered(f) {
  const crs = f.properties["ref:crs"]
  const network = f.properties.network
  if (!(crs != null || network === "London Underground" || network === "Docklands Light Railway")) return false
  if (f.properties.usage === "tourism") return false
  return true
}
for (const f of stations.features) {
  const [lng, lat] = f.geometry.coordinates
  const coordKey = `${lng},${lat}`
  const crs = f.properties["ref:crs"]
  const name = f.properties.name
  let id = null
  if (crs) {
    id = crs
  } else if (name) {
    // Synthetic 4-char ID for non-CRS stations (Underground, DLR etc.).
    // ID_OVERRIDES wins over the auto-generated id when the coord is
    // listed (manual disambiguation for collisions).
    id = ID_OVERRIDES[coordKey] ?? networkPrefix(f.properties.network) + pickLetters(name)
  }
  coordKeyToId.set(coordKey, id)
  if (id) {
    idSet.add(id)
    if (isMapRendered(f)) {
      if (!idToRenderedStations.has(id)) idToRenderedStations.set(id, [])
      idToRenderedStations.get(id).push({ coord: coordKey, name: name ?? "(no name)", network: f.properties.network })
    }
  }
}
// Cluster-anchor IDs — read directly from clusters-data.json keys
// (Phase 2e shape). Each entry's `coord` field gives the centroid
// the registry uses for coord ↔ ID translation.
for (const [id, def] of Object.entries(clusters)) {
  coordKeyToId.set(def.coord, id)
  idSet.add(id)
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

// Phase 2a: keys at both levels are now station IDs. The embedded
// `crs` field on each entry should still match the outer/inner key.
const originRoutes = JSON.parse(fs.readFileSync(path.join(ROOT, "data/origin-routes.json"), "utf8"))
for (const [originId, data] of Object.entries(originRoutes)) {
  checkId("origin-routes.json", "origin", originId, data.name)
  if (data.crs && data.crs !== originId) {
    report("origin-routes.json", "origin-crs-mismatch", `${originId} vs embedded ${data.crs}`, data.name)
  }
  for (const [destId, dest] of Object.entries(data.directReachable ?? {})) {
    checkId("origin-routes.json", "destination", destId, `from ${data.name} to ${dest.name ?? "?"}`)
    if (dest.crs && dest.crs !== destId) {
      report("origin-routes.json", "destination-crs-mismatch", `${destId} vs embedded ${dest.crs}`, `from ${data.name}`)
    }
  }
}

const notes = JSON.parse(fs.readFileSync(path.join(ROOT, "data/station-notes.json"), "utf8"))
for (const id of Object.keys(notes)) {
  // Rekeyed from coordKey to station ID in Phase 2b.
  checkId("station-notes.json", "key", id, notes[id]?.name)
}

// Same shape change for has-issue-stations.json (Phase 2b).
const hasIssue = JSON.parse(fs.readFileSync(path.join(ROOT, "data/has-issue-stations.json"), "utf8"))
for (const id of hasIssue) checkId("has-issue-stations.json", "entry", id, "")

const months = JSON.parse(fs.readFileSync(path.join(ROOT, "data/station-months.json"), "utf8"))
for (const id of Object.keys(months)) {
  // station-months.json was rekeyed from coordKey to station ID in
  // Phase 2c. Real CRS or 4-char synthetic both pass — only typos or
  // stations removed from the registry should fail this check.
  checkId("station-months.json", "key", id, months[id]?.name)
}

// Phase 2d files — all rekeyed from coordKey to station ID.
const sources = JSON.parse(fs.readFileSync(path.join(ROOT, "data/stations-by-source.json"), "utf8"))
for (const [src, arr] of Object.entries(sources)) {
  for (const id of arr) checkId("stations-by-source.json", `source:${src}`, id, src)
}
for (const file of ["stations-hiked.json", "stations-with-komoot.json", "stations-potential-months.json", "placemark-stations.json"]) {
  const arr = JSON.parse(fs.readFileSync(path.join(ROOT, "data", file), "utf8"))
  for (const id of arr) checkId(file, "entry", id, "")
}

// clusters-data.json — Phase 2e shape: keys are C-prefix synthetic
// IDs, each entry has a `coord` (centroid coordKey) and members are
// station IDs.
for (const [anchorId, def] of Object.entries(clusters)) {
  checkId("clusters-data.json", "anchor", anchorId, def.displayName)
  if (!def.coord || !def.coord.includes(",")) {
    report("clusters-data.json", "missing-coord", anchorId, def.displayName)
  }
  for (const m of def.members) {
    checkId("clusters-data.json", "member", m, def.displayName)
  }
}

// walks.json keeps entries keyed by slug, each with a `walks` array of
// actual walks. The walk objects have startStation/endStation (CRS
// codes, or null when the walk doesn't fit a clean station-to-station
// shape).
{
  const file = "walks.json"
  const data = JSON.parse(fs.readFileSync(path.join(ROOT, "data", file), "utf8"))
  for (const [slug, entry] of Object.entries(data)) {
    if (slug.startsWith("_")) continue
    for (const w of entry.walks ?? []) {
      if (w.startStation) checkId(file, "startStation", w.startStation, entry.title ?? slug)
      if (w.endStation) checkId(file, "endStation", w.endStation, entry.title ?? slug)
    }
  }
}

// crs-to-naptan.json wraps the lookup in a `naptan` field, with a
// sibling `_` containing the schema comment.
const naptanFile = JSON.parse(fs.readFileSync(path.join(ROOT, "data/crs-to-naptan.json"), "utf8"))
for (const crs of Object.keys(naptanFile.naptan ?? {})) {
  checkId("crs-to-naptan.json", "key", crs, naptanFile.naptan[crs])
}

const oyster = JSON.parse(fs.readFileSync(path.join(ROOT, "data/oyster-stations.json"), "utf8"))
for (const crs of oyster.nrStations ?? []) checkId("oyster-stations.json", "nrStation", crs, "")

// station-interchange-buffers.json — keys are station IDs post Phase 2g.
const buffersFile = JSON.parse(fs.readFileSync(path.join(ROOT, "data/station-interchange-buffers.json"), "utf8"))
for (const id of Object.keys(buffersFile.buffers ?? {})) {
  checkId("station-interchange-buffers.json", "key", id, "")
}

// terminal-matrix.json + tfl-hop-matrix.json — outer + inner keys are
// station IDs post Phase 2f. Both files have the same shape:
//   { fromId: { toId: { minutes, polyline, vehicleType, ... } } }
for (const file of ["terminal-matrix.json", "tfl-hop-matrix.json"]) {
  const matrix = JSON.parse(fs.readFileSync(path.join(ROOT, "data", file), "utf8"))
  for (const [outerId, inner] of Object.entries(matrix)) {
    checkId(file, "outer", outerId, "")
    for (const innerId of Object.keys(inner)) {
      checkId(file, `${outerId} → inner`, innerId, "")
    }
  }
}

// ── ID collisions among rendered features ────────────────────────────
// Two distinct stations resolving to the same ID is a real bug — the
// runtime's find-by-id lookups (Phase 3c) only return the first hit,
// silently breaking the second station's routing / cluster membership /
// click handling. Beckton-style duplicates (same CRS + same name at
// near-identical coords) are NOT flagged — they're the same physical
// station tagged twice in OSM.
for (const [id, list] of idToRenderedStations) {
  if (list.length <= 1) continue
  const distinctNames = new Set(list.map((s) => s.name))
  if (distinctNames.size === 1) continue   // OSM-duplicate, harmless
  for (const s of list) {
    report("stations.json", `id-collision:${id}`, `${s.name} @ ${s.coord}`, `network=${s.network}`)
  }
}

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
