// Phase 3 extension: strip composer-capable polylineCoords from
// public/journeys/<slug>.json. Same idea as strip-routing-polylines
// but for the per-origin journey-file shape:
//
//   { origin: "<originId>",
//     journeys: { "<destId>": { legs: [...], polylineCoords: [...] }, ... } }
//
// Decision rule mirrors map.tsx's preferGooglePolyline hybrid:
//   1. encoded `polyline` present → keep (composer never overrides Google)
//   2. composer high-Q for (originId, destId, legs) → strip polylineCoords
//   3. composer not high-Q → keep polylineCoords (the runtime fallback)
//
// Iterates every public/journeys/*.json, including the few primary
// files that have encoded polylines for everything (farringdon,
// kings-cross, stratford) — those just pass through with zero strips.
//
// Run: npx tsx scripts/strip-journey-file-polylines.ts
//      npx tsx scripts/strip-journey-file-polylines.ts --dry-run

import { readdirSync, readFileSync, statSync, writeFileSync } from "fs"
import { fileURLToPath } from "url"
import { dirname, join } from "path"
import {
  composePolylineForJourney,
  isHighQualityComposition,
} from "../lib/journey-composer"

const __dirname = dirname(fileURLToPath(import.meta.url))
const root = join(__dirname, "..")
const journeysDir = join(root, "public/journeys")

const dryRun = process.argv.includes("--dry-run")

type Leg = { vehicleType?: string; departureStation?: string; arrivalStation?: string }
type Journey = {
  polyline?: string
  polylineCoords?: [number, number][]
  legs?: Leg[]
  [k: string]: unknown
}
type File = {
  origin?: string
  journeys?: Record<string, Journey>
  [k: string]: unknown
}

let totalBefore = 0
let totalAfter = 0
let totalStripped = 0
let totalKeptCompLow = 0
let totalKeptEncoded = 0

const fileNames = readdirSync(journeysDir).filter((f) => f.endsWith(".json")).sort()
for (const name of fileNames) {
  const abs = join(journeysDir, name)
  const before = statSync(abs).size
  totalBefore += before
  const data = JSON.parse(readFileSync(abs, "utf8")) as File
  const originId = data.origin
  const journeys = data.journeys ?? {}
  if (!originId || !journeys) continue

  let stripped = 0
  let keptCompLow = 0
  let keptEncoded = 0
  for (const [destId, journey] of Object.entries(journeys)) {
    if (journey.polyline) {
      keptEncoded += 1
      continue
    }
    if (!journey.polylineCoords || journey.polylineCoords.length < 2) continue
    const composed = composePolylineForJourney(originId, destId, journey.legs)
    if (composed && isHighQualityComposition(composed)) {
      delete journey.polylineCoords
      stripped += 1
    } else {
      keptCompLow += 1
    }
  }

  const out = JSON.stringify(data)
  if (!dryRun) writeFileSync(abs, out)
  const after = Buffer.byteLength(out, "utf8")
  totalAfter += after
  totalStripped += stripped
  totalKeptCompLow += keptCompLow
  totalKeptEncoded += keptEncoded
  const delta = ((before - after) / before) * 100
  if (stripped > 0 || keptCompLow > 0) {
    console.log(
      `  ${name.padEnd(28)}  stripped=${stripped.toString().padStart(4)} ` +
        `kept-low=${keptCompLow.toString().padStart(3)}  ` +
        `${(before / 1024).toFixed(0)}KB → ${(after / 1024).toFixed(0)}KB (${delta.toFixed(1)}%)`,
    )
  }
}

console.log(`\nTotal across ${fileNames.length} journey files:`)
console.log(`  STRIPPED:   ${totalStripped}`)
console.log(`  kept (composer low-Q):  ${totalKeptCompLow}`)
console.log(`  kept (encoded):          ${totalKeptEncoded}`)
console.log(
  `  size:    ${(totalBefore / 1024).toFixed(0)}KB → ${(totalAfter / 1024).toFixed(0)}KB ` +
    `(${(((totalBefore - totalAfter) / totalBefore) * 100).toFixed(1)}% smaller)`,
)
if (dryRun) console.log("\n(dry run — no files written)")
