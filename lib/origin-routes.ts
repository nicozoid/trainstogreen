// Loader for data/origin-routes.json. Post Phase 2a the file is keyed
// by station ID (CRS or 4-char synthetic) at both the outer level and
// inside each entry's directReachable. Phase 3c finished the runtime
// migration in components/map.tsx, so this module now exports only the
// canonical ID-keyed view.

import data from "@/data/origin-routes.json"

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

export const originRoutesById = data as unknown as OriginRoutes

// Every destination ID that appears in ANY primary's directReachable
// list. Used by the no-data message branching in photo-overlay to
// distinguish "we have NO journey data for this station anywhere"
// (likely a sparse Saturday-morning service or beyond fetch coverage)
// from "we have data elsewhere but not from your active primary"
// (try a different home). Computed once at module load.
export const ALL_RTT_DESTINATIONS: ReadonlySet<string> = (() => {
  const out = new Set<string>()
  for (const entry of Object.values(originRoutesById)) {
    for (const destId of Object.keys(entry.directReachable ?? {})) {
      out.add(destId)
    }
    // Origins themselves count as "reachable" — RTT-fetched primaries
    // know their own data even if no other primary lists them as a
    // destination.
  }
  for (const originId of Object.keys(originRoutesById)) out.add(originId)
  return out
})()
