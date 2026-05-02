#!/usr/bin/env node
// Retroactively strips homonym-mismatched journeys from public/routing/*.json.
//
// Background: the original routing-diff regenerator (admin "regen all" button)
// didn't validate that each per-feature journey actually goes to the feature
// it's stored under. Some entries got mis-attached at upstream-fetch time —
// e.g. Gillingham Dorset's coord carries legs whose last station is
// "Gillingham" but resolves to Gillingham Kent (280km away, different line).
//
// This script applies the same sanity check the buildDiff regenerator now
// uses (HOMONYM_TOL_SQ = 0.25 squared-deg ≈ 50km): for each journey entry,
// resolve the last leg's arrivalStation by name with proximity-to-feature
// hint, and drop the entry if the resolved coord is too far from the
// feature's actual coord.
//
// Usage: node scripts/sanitize-routing-homonyms.mjs

import { readFileSync, writeFileSync, readdirSync } from "node:fs"
import path from "node:path"
import {
  buildComposeContext,
  composeFullJourneyPolyline,
} from "../lib/compose-segment-polyline.ts"

const REPO = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..")
// Detection threshold for an intra-polyline straight-line jump that
// indicates a homonym mis-attachment. 0.5° ≈ 50km — large enough to allow
// segment endpoints near a feature without false-positives, small enough
// to catch homonym-induced 200km+ leaps. Squared to avoid sqrt.
const HOMONYM_JUMP_TOL_SQ = 0.5 * 0.5

const stations = JSON.parse(readFileSync(path.join(REPO, "public/stations.json"), "utf-8"))
const originRoutes = JSON.parse(readFileSync(path.join(REPO, "data/origin-routes.json"), "utf-8"))
const segments = JSON.parse(readFileSync(path.join(REPO, "data/rail-segments.json"), "utf-8"))
const terminalMatrix = JSON.parse(readFileSync(path.join(REPO, "data/terminal-matrix.json"), "utf-8"))
const tflHopMatrix = JSON.parse(readFileSync(path.join(REPO, "data/tfl-hop-matrix.json"), "utf-8"))

// Mirror map.tsx's TERMINUS_DISPLAY_OVERRIDES so the lib resolves long-form
// names ("London St. Pancras International") to the same coords the runtime
// uses. Without this, the offline sanitizer's name-resolution wouldn't match
// what map.tsx does at runtime, and we'd false-positive on legitimate trips.
const TERMINUS_OVERRIDES = {
  "-0.1230224,51.5323954": "Kings Cross",
  "-0.1270027,51.5327196": "St Pancras",
  "-0.1276185,51.5322106": "St Pancras",
}
const stationsForCtx = {
  ...stations,
  features: stations.features.map((f) => {
    const c = f.geometry?.coordinates
    if (!Array.isArray(c)) return f
    const ck = `${c[0]},${c[1]}`
    const override = TERMINUS_OVERRIDES[ck]
    if (!override) return f
    return {
      ...f,
      properties: {
        ...f.properties,
        canonicalName: f.properties?.name,
        name: override,
      },
    }
  }),
}

const ctx = buildComposeContext({
  stations: stationsForCtx,
  originRoutes,
  segments,
  terminalMatrix: { ...tflHopMatrix, ...terminalMatrix },
})

const routingDir = path.join(REPO, "public/routing")
for (const file of readdirSync(routingDir)) {
  if (!file.endsWith(".json")) continue
  const filePath = path.join(routingDir, file)
  const data = JSON.parse(readFileSync(filePath, "utf-8"))
  let dropped = 0
  let totalEntries = 0
  let featuresWithDrop = 0

  for (const [destKey, delta] of Object.entries(data)) {
    const journeys = delta.journeys
    if (!journeys) continue
    const featureCoord = destKey.split(",").map(Number)
    let featureDropped = false
    for (const [origin, entry] of Object.entries(journeys)) {
      totalEntries += 1
      const legs = entry?.legs
      if (!Array.isArray(legs) || legs.length === 0) continue
      const primaryCoord = origin.split(",").map(Number)
      // Compose the polyline via the same lib the runtime uses. Two
      // homonym-detection signals:
      //   1. Intra-polyline straight-line jump >50km — means the resolver
      //      had to bridge two stations the rail network doesn't actually
      //      connect. Indicates a leg-internal homonym mismatch.
      //   2. Polyline endpoint far from feature coord — means the legs'
      //      last station resolves to a wrong-homonym DIFFERENT from the
      //      feature where the journey is stored. This catches the GIL
      //      Dorset case: legs end at Gillingham Kent (rail-reachable
      //      from Chatham) while the feature key points to Dorset.
      // Either signal trips the drop.
      const composed = composeFullJourneyPolyline(legs, primaryCoord, featureCoord, ctx)
      if (!composed || composed.length < 2) continue
      let bad = false
      for (let i = 1; i < composed.length; i++) {
        const dx = composed[i][0] - composed[i - 1][0]
        const dy = composed[i][1] - composed[i - 1][1]
        if (dx * dx + dy * dy > HOMONYM_JUMP_TOL_SQ) { bad = true; break }
      }
      if (!bad) {
        const last = composed[composed.length - 1]
        const dx = last[0] - featureCoord[0]
        const dy = last[1] - featureCoord[1]
        if (dx * dx + dy * dy > HOMONYM_JUMP_TOL_SQ) bad = true
      }
      if (bad) {
        delete journeys[origin]
        dropped += 1
        featureDropped = true
      }
    }
    if (featureDropped) featuresWithDrop += 1
    if (Object.keys(journeys).length === 0) delete delta.journeys
  }

  writeFileSync(filePath, JSON.stringify(data))
  console.log(
    `${file.padEnd(22)} dropped ${dropped} of ${totalEntries} journey entries ` +
      `(across ${featuresWithDrop} features)`,
  )
}
