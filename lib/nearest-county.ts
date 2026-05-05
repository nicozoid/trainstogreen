// Nearest-county lookup against data/region-labels.json. Used by the
// walk editor's "Search Google" icon-button to add a disambiguating
// "Buckinghamshire" / "Surrey" / etc. token to the query so the
// admin lands on walker-relevant pages rather than same-named places
// elsewhere in the country (or world).
//
// Picks from the entries with category === "county" only — the file
// also lists national parks and national landscapes which are useful
// labels but aren't what people put in a Google query when looking
// for a specific landmark. A handful of historic counties (Westmorland,
// Cumberland, Middlesex) live in the file alongside modern ones; the
// nearest-coord match returns whichever is closest, which is "good
// enough" for the search-button heuristic.

import regionLabels from "@/data/region-labels.json"

type RegionLabel = { name: string; category: string; coord: [number, number] }

const COUNTIES: RegionLabel[] = (regionLabels as RegionLabel[]).filter(
  (r) => r.category === "county",
)

// Squared Euclidean distance on raw lat/lng — fine for nearest-neighbour
// ranking inside the British Isles where the regions aren't pole-near
// and we just need the ordering, not absolute distances.
function squaredDistance(lat: number, lng: number, target: [number, number]): number {
  const dLat = lat - target[1]
  const dLng = lng - target[0]
  return dLat * dLat + dLng * dLng
}

/** Return the name of the closest county to the given lat/lng, or
 *  undefined when lat/lng aren't finite numbers. The data file uses
 *  [lng, lat] coord order — matches GeoJSON convention — hence the
 *  index swaps inside squaredDistance. */
export function nearestCounty(lat: number | undefined, lng: number | undefined): string | undefined {
  if (typeof lat !== "number" || !Number.isFinite(lat)) return undefined
  if (typeof lng !== "number" || !Number.isFinite(lng)) return undefined
  if (COUNTIES.length === 0) return undefined
  let bestName = COUNTIES[0].name
  let bestDist = squaredDistance(lat, lng, COUNTIES[0].coord)
  for (let i = 1; i < COUNTIES.length; i++) {
    const d = squaredDistance(lat, lng, COUNTIES[i].coord)
    if (d < bestDist) {
      bestDist = d
      bestName = COUNTIES[i].name
    }
  }
  return bestName
}
