// Per-station interchange buffer lookup. Replaces the previous flat
// 3-min / 5-min constants with values from data/station-interchange-buffers.json,
// so journeys through bigger interchanges (CLJ, RDG, KGX) get realistic
// transfer times.
//
// Data file is keyed by station ID (CRS or 4-char synthetic) post Phase 2g.
// The PUBLIC API stays name-based — many callers pass names from RTT/TfL
// hop results where they don't have a CRS handy. We resolve name → ID
// via the registry's resolveName() at call time.
//
// Caller responsibility: pass the INTERCHANGE station's name (where the
// transfer happens), not the journey's start. For a CLJ → VIC → KGX →
// Welwyn composition, the buffers to apply are at VIC (between leg 1 and
// 2) and KGX (between leg 2 and 3).

import buffersData from "@/data/station-interchange-buffers.json"
import { resolveName } from "@/lib/station-registry"

type BuffersFile = { default: number; buffers: Record<string, number> }
const file = buffersData as unknown as BuffersFile
const DEFAULT_BUFFER = file.default
const buffers = file.buffers

/**
 * Returns the interchange buffer (in minutes) to use AT this station.
 * Pass the name of the station where the transfer happens (the arrival
 * station of the previous leg / departure of the next). Unknown stations
 * fall through to the default 3 min — same value the codebase used as
 * a flat constant before this lookup existed.
 */
export function interchangeBufferFor(stationName: string | undefined): number {
  if (!stationName) return DEFAULT_BUFFER
  const id = resolveName(stationName)
  if (!id) return DEFAULT_BUFFER
  return buffers[id] ?? DEFAULT_BUFFER
}

/**
 * Default buffer when the interchange station is unknown or there's no
 * boundary station to query (e.g. a "tube hop into the user's primary"
 * computed from a TfL journey, where the buffer applies AT the primary
 * itself but the primary's name might not be in our data file).
 */
export const DEFAULT_INTERCHANGE_BUFFER_MIN = DEFAULT_BUFFER
