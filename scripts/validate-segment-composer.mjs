#!/usr/bin/env node
// Validation pass for lib/compose-segment-polyline.ts.
//
// Reads every entry in data/origin-routes.json (the universe of real journeys)
// and tries to compose a polyline for each one using the new segment library.
// Reports per-origin coverage stats so we can see whether the composer is
// good enough to replace the per-journey polyline storage on the render path.
//
// Outputs:
//   - console summary: composability per origin, coverage, edges-resolved share
//   - data/segment-composer-report.json: full data for inspection

import { readFileSync, writeFileSync } from "node:fs"
import path from "node:path"
import { composeFromCallingPoints, decodePolyline } from "../lib/compose-segment-polyline.ts"

// Node 22 supports importing TS via a flag; Node 23+ does it natively. If this
// script fails to run, prefer running from `tsx` or compile first. For our
// repo (Node 24), the experimental TS import works out of the box.

const REPO = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..")

const stations = JSON.parse(readFileSync(path.join(REPO, "public/stations.json"), "utf-8"))
const segments = JSON.parse(readFileSync(path.join(REPO, "data/rail-segments.json"), "utf-8"))
const originRoutes = JSON.parse(readFileSync(path.join(REPO, "data/origin-routes.json"), "utf-8"))

// Build CRS -> [lng, lat] map for the composer's straight-line fallback.
const crsToCoord = new Map()
for (const f of stations.features) {
  const crs = f.properties?.["ref:crs"]
  if (!crs) continue
  const c = f.geometry?.coordinates
  if (!Array.isArray(c) || c.length < 2) continue
  if (!crsToCoord.has(crs)) crsToCoord.set(crs, [c[0], c[1]])
}

// Per-origin tally: how many journeys, how composable.
const perOrigin = new Map()

let total = 0
let allEdgesResolved = 0
let anyFallback = 0
let totallyMissing = 0
let totalEdges = 0
let totalEdgesResolved = 0
let totalEdgesFallback = 0
let totalEdgesMissing = 0

for (const [originCoord, entry] of Object.entries(originRoutes)) {
  const oCrs = entry.crs ?? originCoord
  const dr = entry.directReachable ?? {}
  const tally = perOrigin.get(oCrs) ?? {
    crs: oCrs,
    name: entry.name,
    journeys: 0,
    fullyResolved: 0,
    anyFallback: 0,
    totallyMissing: 0,
  }
  for (const [, info] of Object.entries(dr)) {
    const cp = info.fastestCallingPoints ?? []
    if (cp.length < 2) continue
    total++
    tally.journeys++
    const result = composeFromCallingPoints(cp, { segments, crsToCoord })
    totalEdges += cp.length - 1
    totalEdgesResolved += result.edgesResolved
    totalEdgesFallback += result.edgesFallback
    totalEdgesMissing += result.edgesMissing
    if (result.edgesResolved === cp.length - 1) {
      allEdgesResolved++
      tally.fullyResolved++
    } else if (result.edgesResolved > 0 || result.edgesFallback > 0) {
      anyFallback++
      tally.anyFallback++
    } else {
      totallyMissing++
      tally.totallyMissing++
    }
  }
  perOrigin.set(oCrs, tally)
}

console.log("=".repeat(72))
console.log("Segment composer — validation summary")
console.log("=".repeat(72))
console.log()
console.log(`Total journeys (origin-routes directReachable):      ${total.toLocaleString()}`)
console.log(`  All edges resolved (clean rail-following polyline): ${allEdgesResolved.toLocaleString()} (${pct(allEdgesResolved, total)})`)
console.log(`  Mixed (some real, some straight-line fallback):     ${anyFallback.toLocaleString()} (${pct(anyFallback, total)})`)
console.log(`  No edges resolved at all (all straight):            ${totallyMissing.toLocaleString()} (${pct(totallyMissing, total)})`)
console.log()
console.log(`Total adjacent-pair edges across all journeys:        ${totalEdges.toLocaleString()}`)
console.log(`  Resolved from segment library:                      ${totalEdgesResolved.toLocaleString()} (${pct(totalEdgesResolved, totalEdges)})`)
console.log(`  Straight-line fallback (no segment, but coords ok): ${totalEdgesFallback.toLocaleString()} (${pct(totalEdgesFallback, totalEdges)})`)
console.log(`  Genuinely missing (CRS unknown — no fallback poss): ${totalEdgesMissing.toLocaleString()} (${pct(totalEdgesMissing, totalEdges)})`)
console.log()

console.log("Per-origin coverage (top 30 by journey volume):")
const sorted = [...perOrigin.values()].sort((a, b) => b.journeys - a.journeys)
console.log(
  `  ${"CRS".padEnd(5)} ${"NAME".padEnd(28)} ${"#J".padStart(5)}  ${"FULL%".padStart(6)}  ${"MIX%".padStart(6)}  ${"NONE%".padStart(6)}`,
)
for (const t of sorted.slice(0, 30)) {
  console.log(
    `  ${t.crs.padEnd(5)} ${(t.name ?? "").slice(0, 28).padEnd(28)} ${String(t.journeys).padStart(5)}  ${pct(t.fullyResolved, t.journeys).padStart(6)}  ${pct(t.anyFallback, t.journeys).padStart(6)}  ${pct(t.totallyMissing, t.journeys).padStart(6)}`,
  )
}

const report = {
  generatedAt: new Date().toISOString(),
  totals: {
    journeys: total,
    fullyResolved: allEdgesResolved,
    anyFallback,
    totallyMissing,
    edges: totalEdges,
    edgesResolved: totalEdgesResolved,
    edgesFallback: totalEdgesFallback,
    edgesMissing: totalEdgesMissing,
  },
  perOrigin: sorted,
}
writeFileSync(
  path.join(REPO, "data/segment-composer-report.json"),
  JSON.stringify(report, null, 2),
)
console.log()
console.log(`Wrote data/segment-composer-report.json`)

function pct(n, d) {
  if (!d) return "—"
  return ((100 * n) / d).toFixed(1) + "%"
}
