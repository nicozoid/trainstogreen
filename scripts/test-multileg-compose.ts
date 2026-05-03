// Verifies multi-leg composition via the legs[] fallback. Uses real
// 2- and 3-leg journeys pulled from the routing diff to confirm:
//
//   - resolveName correctly maps leg station names to CRS
//   - each leg's calling-points are found in origin-routes
//   - concatenation is clean (no duplicate join coords)
//   - quality gate accepts the result

import {
  composePolylineForJourney,
  isHighQualityComposition,
  type JourneyLeg,
} from "../lib/journey-composer"

const cases: { label: string; o: string; d: string; legs: JourneyLeg[] }[] = [
  {
    label: "CLON → BEU (2-leg via Southampton)",
    o: "CLON",
    d: "BEU",
    legs: [
      { vehicleType: "HEAVY_RAIL", departureStation: "Waterloo", arrivalStation: "Southampton Central" },
      { vehicleType: "HEAVY_RAIL", departureStation: "Southampton Central", arrivalStation: "Beaulieu Road" },
    ],
  },
  {
    label: "CLON → ELR (3-leg via Doncaster + Meadowhall)",
    o: "CLON",
    d: "ELR",
    legs: [
      { vehicleType: "HEAVY_RAIL", departureStation: "King's Cross", arrivalStation: "Doncaster" },
      { vehicleType: "HEAVY_RAIL", departureStation: "Doncaster", arrivalStation: "Meadowhall" },
      { vehicleType: "HEAVY_RAIL", departureStation: "Meadowhall", arrivalStation: "Elsecar" },
    ],
  },
  {
    label: "CLON → SBT (4-leg via Birmingham + Smethwick + Stourbridge)",
    o: "CLON",
    d: "SBT",
    legs: [
      { vehicleType: "HEAVY_RAIL", departureStation: "Euston", arrivalStation: "Birmingham New Street" },
      { vehicleType: "HEAVY_RAIL", departureStation: "Birmingham New Street", arrivalStation: "Smethwick Galton Bridge" },
      { vehicleType: "HEAVY_RAIL", departureStation: "Smethwick Galton Bridge", arrivalStation: "Stourbridge Junction" },
      { vehicleType: "HEAVY_RAIL", departureStation: "Stourbridge Junction", arrivalStation: "Stourbridge Town" },
    ],
  },
  {
    label: "CLON → CUM (2-leg via Oxford)",
    o: "CLON",
    d: "CUM",
    legs: [
      { vehicleType: "HEAVY_RAIL", departureStation: "Paddington", arrivalStation: "Oxford" },
      { vehicleType: "HEAVY_RAIL", departureStation: "Oxford", arrivalStation: "Culham" },
    ],
  },
]

for (const c of cases) {
  const r = composePolylineForJourney(c.o, c.d, c.legs)
  if (!r) { console.log(`✗ ${c.label}: null`); continue }
  const q = isHighQualityComposition(r) ? "✓" : "○"
  console.log(
    `${q} ${c.label}: ${r.coords.length}pts (resolved=${r.edgesResolved}, fallback=${r.edgesFallback}, missing=${r.edgesMissing})`,
  )
}
