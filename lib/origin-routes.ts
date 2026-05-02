// Loader + coord-keyed view of data/origin-routes.json.
//
// On disk (post Phase 2a) the file is keyed by station ID at both
// the outer level and inside each entry's directReachable. Many
// runtime consumers in components/map.tsx still iterate by coordKey,
// so this module also exposes a coord-keyed view built once at
// import time. Future phases can swap consumers to the ID-keyed
// canonical export and drop the coord-keyed wrapper.

import data from "@/data/origin-routes.json"
import { getCoordKey } from "@/lib/station-registry"

export type DirectReachable = {
  name: string
  crs: string
  minMinutes: number
  services: number
  fastestCallingPoints: string[]
  fastestCallingPointTimes?: Array<number | null>
  upstreamCallingPoints?: {
    crs: string
    name: string
    coord: string
    minutesBeforeOrigin: number
  }[]
  serviceDepMinutes?: number[]
  serviceDurationsMinutes?: number[]
}

export type OriginEntry = {
  name: string
  crs: string
  directReachable: Record<string, DirectReachable>
  generatedAt: string
  sampledDates?: string[]
  v2FetchedDates?: string[]
}

export type OriginRoutes = Record<string, OriginEntry>

// Canonical (preferred) — keyed by station ID at every level.
export const originRoutesById = data as unknown as OriginRoutes

// Legacy view — keyed by coordKey at every level. Built once at
// module load by translating IDs back to coords via the registry.
// Dropped entries: any ID that isn't in the registry. In practice
// this should be empty (audit-station-resolution.mjs catches drift).
export const originRoutesByCoord: OriginRoutes = (() => {
  const out: OriginRoutes = {}
  for (const [outerId, entry] of Object.entries(originRoutesById)) {
    const outerCoord = getCoordKey(outerId)
    if (!outerCoord) continue
    const dr: Record<string, DirectReachable> = {}
    for (const [innerId, dest] of Object.entries(entry.directReachable ?? {})) {
      const innerCoord = getCoordKey(innerId)
      if (innerCoord) dr[innerCoord] = dest
    }
    out[outerCoord] = { ...entry, directReachable: dr }
  }
  return out
})()
