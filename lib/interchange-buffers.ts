// Per-station interchange buffer lookup. Replaces the previous flat
// 3-min / 5-min constants with values from data/station-interchange-buffers.json,
// so journeys through bigger interchanges (CLJ, Reading, KX) get realistic
// transfer times.
//
// Lookup is name-based with light normalisation — "London Kings Cross",
// "King's Cross" and "Kings Cross" all resolve to the same entry. Stations
// not in the data file fall through to the `default` value.
//
// Caller responsibility: pass the INTERCHANGE station's name (where the
// transfer happens), not the journey's start. For a CLJ → VIC → KGX →
// Welwyn composition, the buffers to apply are at VIC (between leg 1 and
// 2) and KGX (between leg 2 and 3).

import buffersData from "@/data/station-interchange-buffers.json"

type BuffersFile = { default: number; buffers: Record<string, number> }
const file = buffersData as unknown as BuffersFile
const DEFAULT_BUFFER = file.default
const buffers = file.buffers

// Lightly normalise a station name so common API-supplied variants map
// to the same key as the canonical entry. Mirrors the cleanup the
// terminal matcher does, but kept self-contained here so this module
// can run without depending on the london-terminals data structures.
function normalise(name: string): string {
  return name
    .replace(/^London\s+/i, "")
    .replace(/\s+(Rail\s+)?Station$/i, "")
    .replace(/\s+International$/i, "")
    .replace(/['\u2019]/g, "")
    .replace(/\./g, "")
    .replace(/\s+/g, " ")
    .trim()
}

// Build a normalised lookup table once at module load. Iterating over
// the JSON's keys lets future entries flow in without further code.
const lookup: Record<string, number> = {}
for (const [name, mins] of Object.entries(buffers)) {
  lookup[normalise(name)] = mins
}

/**
 * Returns the interchange buffer (in minutes) to use AT this station.
 * Pass the name of the station where the transfer happens (the arrival
 * station of the previous leg / departure of the next). Unknown stations
 * fall through to the default 3 min — same value the codebase used as
 * a flat constant before this lookup existed.
 */
export function interchangeBufferFor(stationName: string | undefined): number {
  if (!stationName) return DEFAULT_BUFFER
  return lookup[normalise(stationName)] ?? DEFAULT_BUFFER
}

/**
 * Default buffer when the interchange station is unknown or there's no
 * boundary station to query (e.g. a "tube hop into the user's primary"
 * computed from a TfL journey, where the buffer applies AT the primary
 * itself but the primary's name might not be in our data file).
 */
export const DEFAULT_INTERCHANGE_BUFFER_MIN = DEFAULT_BUFFER
