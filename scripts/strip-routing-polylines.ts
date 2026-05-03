// Phase 3: surgically strip baked polylineCoords from public/routing/*.json
// where the rail-segment composer can produce a high-quality replacement
// at runtime. Encoded `polyline` (real Google data) is always kept;
// composer-incapable journeys keep their baked polylineCoords. Net effect:
// smaller JSON payload, no visible regression.
//
// The decision rule mirrors map.tsx's preferGooglePolyline hybrid:
//   1. encoded `polyline` present → keep (composer never overrides Google)
//   2. composer high-Q for (originId, destId) → strip polylineCoords
//   3. composer not high-Q → keep polylineCoords (the runtime fallback)
//
// Run: npx tsx scripts/strip-routing-polylines.ts            # writes
//      npx tsx scripts/strip-routing-polylines.ts --dry-run  # report only

import { readFileSync, writeFileSync, statSync } from "fs"
import { fileURLToPath } from "url"
import { dirname, join } from "path"
import {
  composePolylineForJourney,
  isHighQualityComposition,
} from "../lib/journey-composer"
import { resolveCoordKey } from "../lib/station-registry"

const __dirname = dirname(fileURLToPath(import.meta.url))
const root = join(__dirname, "..")

const dryRun = process.argv.includes("--dry-run")

type Journey = {
  polyline?: string
  polylineCoords?: [number, number][]
  legs?: { vehicleType?: string; departureStation?: string; arrivalStation?: string }[]
  [k: string]: unknown
}
type Diff = Record<
  string, // destCoord
  {
    journeys?: Record<string, Journey> // keyed by originCoord
    [k: string]: unknown
  }
>

const files = [
  "public/routing/central-london.json",
  "public/routing/stratford.json",
]

for (const rel of files) {
  const abs = join(root, rel)
  const before = statSync(abs).size
  const diff = JSON.parse(readFileSync(abs, "utf8")) as Diff

  let totalJourneys = 0
  let kept_encoded = 0
  let stripped = 0
  let kept_no_composer = 0
  let kept_composer_low = 0
  let no_polyline_either_way = 0

  for (const [destCoord, entry] of Object.entries(diff)) {
    if (!entry.journeys) continue
    const destId = resolveCoordKey(destCoord) ?? destCoord
    for (const [originCoord, journey] of Object.entries(entry.journeys)) {
      totalJourneys += 1
      // 1. Encoded Google polyline always wins — leave alone.
      if (journey.polyline) {
        kept_encoded += 1
        continue
      }
      // 2. Has baked polylineCoords. Try composer.
      if (journey.polylineCoords && journey.polylineCoords.length > 1) {
        const originId = originCoord.includes(",")
          ? (resolveCoordKey(originCoord) ?? originCoord)
          : originCoord
        const composed = composePolylineForJourney(originId, destId, journey.legs)
        if (composed && isHighQualityComposition(composed)) {
          delete journey.polylineCoords
          stripped += 1
        } else {
          kept_composer_low += 1
        }
        continue
      }
      // 3. No polyline of any kind.
      no_polyline_either_way += 1
      kept_no_composer += 1
    }
  }

  const out = JSON.stringify(diff)
  if (!dryRun) writeFileSync(abs, out)
  const after = Buffer.byteLength(out, "utf8")

  console.log(`\n${rel}`)
  console.log(`  ${totalJourneys} journeys`)
  console.log(`    kept encoded polyline:        ${kept_encoded}`)
  console.log(`    STRIPPED polylineCoords:      ${stripped}`)
  console.log(`    kept (composer not high-Q):   ${kept_composer_low}`)
  console.log(`    no polyline either way:       ${no_polyline_either_way}`)
  console.log(
    `  size: ${(before / 1024).toFixed(0)}KB → ${(after / 1024).toFixed(0)}KB ` +
      `(${(((before - after) / before) * 100).toFixed(1)}% smaller)`,
  )
}

if (dryRun) console.log("\n(dry run — no files written)")
