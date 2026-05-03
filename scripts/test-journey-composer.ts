// Sanity check the Phase 2 wrapper: pull a few real (originId, destId)
// pairs from origin-routes.json and confirm composePolylineForJourney
// returns high-quality output (all edges resolved). Mirrors the hybrid
// gate in components/map.tsx so we know the wiring will actually fire.
//
// Run: npx tsx scripts/test-journey-composer.ts

import {
  composePolylineForJourney,
  isHighQualityComposition,
} from "../lib/journey-composer"

const cases: { origin: string; dest: string; label: string }[] = [
  { origin: "KGX", dest: "NNG", label: "King's Cross → Newark Northgate" },
  { origin: "WAT", dest: "DCH", label: "Waterloo → Dorchester South" },
  { origin: "PAD", dest: "PLY", label: "Paddington → Plymouth" },
  { origin: "PAD", dest: "OXF", label: "Paddington → Oxford" },
  { origin: "LST", dest: "CBG", label: "Liverpool Street → Cambridge" },
]

let pass = 0
let fail = 0
for (const c of cases) {
  const result = composePolylineForJourney(c.origin, c.dest)
  if (!result) {
    console.log(`✗ ${c.label}: NO RESULT (probably missing calling-points)`)
    fail += 1
    continue
  }
  const quality = isHighQualityComposition(result)
  const tag = quality ? "✓ HIGH-Q" : "○ low-Q"
  console.log(
    `${tag} ${c.label}: ${result.coords.length}pts (resolved=${result.edgesResolved}, fallback=${result.edgesFallback}, missing=${result.edgesMissing})`,
  )
  if (quality) pass += 1
  else fail += 1
}
console.log(`\n${pass}/${pass + fail} cases produce high-quality compositions`)
