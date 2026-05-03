// Standalone smoke test for lib/compose-segment-polyline.ts.
//
// Loads the segment library + a CRS→coord map built from public/stations.json,
// composes a few real calling-point sequences pulled from origin-routes.json,
// and prints what came out: edges resolved, edges fallen-back, total points,
// and the first/last coords so we can eyeball whether the composition is
// plausible.
//
// Run: npx tsx scripts/test-compose-segment.ts

import { readFileSync } from "fs"
import { fileURLToPath } from "url"
import { dirname, join } from "path"
import {
  composeFromCallingPoints,
  type RailSegments,
} from "../lib/compose-segment-polyline"

const __dirname = dirname(fileURLToPath(import.meta.url))
const root = join(__dirname, "..")

const segments = JSON.parse(
  readFileSync(join(root, "data/rail-segments.json"), "utf8"),
) as RailSegments

const stationsGeoJson = JSON.parse(
  readFileSync(join(root, "public/stations.json"), "utf8"),
) as {
  features: {
    geometry?: { coordinates?: number[] }
    properties?: { "ref:crs"?: string; name?: string } | null
  }[]
}

// Build CRS → [lng, lat]. First feature wins on duplicates (matches composer).
const crsToCoord = new Map<string, [number, number]>()
for (const f of stationsGeoJson.features) {
  const crs = f.properties?.["ref:crs"]
  const c = f.geometry?.coordinates
  if (!crs || !Array.isArray(c) || c.length < 2) continue
  if (!crsToCoord.has(crs)) crsToCoord.set(crs, [c[0] as number, c[1] as number])
}

console.log(
  `Loaded ${Object.keys(segments).length} segments, ${crsToCoord.size} CRS→coord entries\n`,
)

// Real calling-point sequences pulled from origin-routes.json:
const cases: { label: string; callingPoints: string[] }[] = [
  { label: "PAD→OXF (3 stops)", callingPoints: ["PAD", "RDG", "OXF"] },
  { label: "KGX→NCL (3 stops)", callingPoints: ["KGX", "YRK", "NCL"] },
  {
    label: "PAD→PLY (7 stops, long-haul GWR)",
    callingPoints: ["PAD", "RDG", "TAU", "EXD", "NTA", "TOT", "PLY"],
  },
  // Pair-by-pair edge case: a single hop where the segment exists.
  { label: "KGX→YRK direct (2 stops)", callingPoints: ["KGX", "YRK"] },
  // Pair-by-pair edge case: a hop unlikely to have a direct segment.
  { label: "PAD→PLY direct (2 stops, no intermediates)", callingPoints: ["PAD", "PLY"] },
]

for (const tc of cases) {
  const result = composeFromCallingPoints(tc.callingPoints, {
    segments,
    crsToCoord,
  })
  const first = result.coords[0]
  const last = result.coords[result.coords.length - 1]
  const fmt = (c?: [number, number]) =>
    c ? `[${c[0].toFixed(4)}, ${c[1].toFixed(4)}]` : "—"
  console.log(`▶ ${tc.label}`)
  console.log(`  calling points: ${tc.callingPoints.join(" → ")}`)
  console.log(
    `  edges: resolved=${result.edgesResolved}  fallback=${result.edgesFallback}  missing=${result.edgesMissing}`,
  )
  console.log(
    `  output: ${result.coords.length} coords, first=${fmt(first)}, last=${fmt(last)}`,
  )
  // Sanity: where would we expect first/last to be?
  const expectedFirst = crsToCoord.get(tc.callingPoints[0])
  const expectedLast = crsToCoord.get(tc.callingPoints[tc.callingPoints.length - 1])
  console.log(
    `  expected: first≈${fmt(expectedFirst)}, last≈${fmt(expectedLast)}`,
  )
  console.log("")
}
