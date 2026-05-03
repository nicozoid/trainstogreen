// For every multi-leg journey still keeping its baked polylineCoords
// after Phase 3 + multi-leg composer, report which legs' station names
// resolveName couldn't map to a CRS. The failures are the actionable
// gaps in resolveName's alias table.
//
// Run: npx tsx scripts/diagnose-multileg-failures.ts

import { readFileSync } from "fs"
import { fileURLToPath } from "url"
import { dirname, join } from "path"
import { resolveCoordKey, resolveName, getStation } from "../lib/station-registry"
import { originRoutesById } from "../lib/origin-routes"

const __dirname = dirname(fileURLToPath(import.meta.url))
const root = join(__dirname, "..")

type Leg = { vehicleType?: string; departureStation?: string; arrivalStation?: string }
type Journey = {
  polyline?: string
  polylineCoords?: [number, number][]
  legs?: Leg[]
}
type Diff = Record<string, { journeys?: Record<string, Journey> }>

const file = "public/routing/central-london.json"
const diff = JSON.parse(readFileSync(join(root, file), "utf8")) as Diff

const unresolvableNames = new Map<string, number>()
const failures: {
  origin: string
  dest: string
  legs: Leg[]
  unresolved: string[]
  partialEdges: { resolved: number; fallback: number; missing: number } | null
}[] = []

for (const [destCoord, entry] of Object.entries(diff)) {
  if (!entry.journeys) continue
  const destId = resolveCoordKey(destCoord) ?? destCoord
  for (const [originCoord, j] of Object.entries(entry.journeys)) {
    if (j.polyline) continue
    if (!j.polylineCoords || j.polylineCoords.length < 2) continue
    const legs = j.legs ?? []
    if (legs.length < 2) continue // 1-leg case is a separate bucket

    const originId = originCoord.includes(",")
      ? (resolveCoordKey(originCoord) ?? originCoord)
      : originCoord

    const unresolved: string[] = []
    for (const leg of legs) {
      const dn = leg.departureStation
      const an = leg.arrivalStation
      if (dn && !resolveName(dn)) {
        unresolved.push(dn)
        unresolvableNames.set(dn, (unresolvableNames.get(dn) ?? 0) + 1)
      }
      if (an && !resolveName(an)) {
        unresolved.push(an)
        unresolvableNames.set(an, (unresolvableNames.get(an) ?? 0) + 1)
      }
    }

    // Even if all names resolve, the composition might still fall short
    // (no calling points found for some leg). Track those too.
    if (unresolved.length === 0) {
      // Replicate per-leg lookup to find which leg lacks calling-points.
      let resolved = 0, fallback = 0, missing = 0
      const legDetails: string[] = []
      for (const leg of legs) {
        if (leg.vehicleType !== "HEAVY_RAIL") continue
        const depId = resolveName(leg.departureStation ?? "")
        const arrId = resolveName(leg.arrivalStation ?? "")
        if (!depId || !arrId) continue
        const cp = originRoutesById[depId]?.directReachable?.[arrId]?.fastestCallingPoints
        if (Array.isArray(cp) && cp.length >= 2) {
          resolved += 1
        } else {
          legDetails.push(`${depId}→${arrId} (${leg.departureStation} → ${leg.arrivalStation})`)
          missing += 1
        }
      }
      if (missing > 0) {
        failures.push({
          origin: originId,
          dest: destId,
          legs,
          unresolved: legDetails,
          partialEdges: { resolved, fallback, missing },
        })
      }
    } else {
      failures.push({
        origin: originId,
        dest: destId,
        legs,
        unresolved,
        partialEdges: null,
      })
    }
  }
}

console.log(`Multi-leg journeys still keeping baked polylineCoords: ${failures.length}\n`)

if (unresolvableNames.size > 0) {
  console.log(`Unresolvable station names (with × count of times seen):\n`)
  const sorted = Array.from(unresolvableNames.entries()).sort((a, b) => b[1] - a[1])
  for (const [name, count] of sorted) {
    console.log(`  ×${count}  "${name}"`)
  }
}

console.log(`\nFailing journeys:`)
for (const f of failures) {
  const dName = getStation(f.dest)?.name ?? f.dest
  console.log(`\n  ${f.origin} → ${f.dest} (${dName})`)
  for (let i = 0; i < f.legs.length; i++) {
    const leg = f.legs[i]
    console.log(
      `    leg ${i}: ${leg.vehicleType ?? "?"} "${leg.departureStation}" → "${leg.arrivalStation}"`,
    )
  }
  if (f.unresolved.length > 0) {
    console.log(`    ⚠ unresolved: ${f.unresolved.join("; ")}`)
  }
  if (f.partialEdges) {
    console.log(`    ⚠ leg-pairs missing in origin-routes: ${JSON.stringify(f.partialEdges)}`)
  }
}
