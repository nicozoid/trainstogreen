// Synthesises a "primary origin" JourneyInfo for a destination when we don't
// have one explicitly fetched. Reuses the Kings Cross cluster journey (which
// we have for every destination) plus a small terminal-to-terminal matrix
// (data/terminal-matrix.json) to construct journeys from any London terminal
// without making new per-destination API calls.
//
// How it works, at a glance:
//   KX journey to Swindon:     KX → Paddington (tube) → Swindon (GWR)
//                                  ^^^^^^^^^^^^^^^^^^  ^^^^^^^^^^^^^^^^
//                                  stripped (transfer  kept as "mainline"
//                                  to a terminal)
//
//   User picks "Victoria" as primary origin.
//   → matrix["Victoria"]["Paddington"] = { minutes: 11, polyline, ... }
//   → Stitched journey = [Victoria→Paddington tube hop] + [Paddington→Swindon mainline]
//
// We also handle Farringdon as a fallback source — its Elizabeth-Line leg to
// Paddington is exactly the same shape (transfer landing at a terminal), just
// with vehicleType=HEAVY_RAIL instead of SUBWAY.

import type { JourneyInfo } from "@/components/photo-overlay"

// ---------------------------------------------------------------------------
// Types for the static data files
// ---------------------------------------------------------------------------

/** A single entry from data/london-terminals.json. */
export type Terminal = {
  name: string        // Canonical display name (e.g. "Paddington")
  lat: number
  lng: number
  aliases: string[]   // Variants Google might return (e.g. "London Paddington")
}

/** A single entry from data/terminal-matrix.json — one terminal-to-terminal hop. */
export type MatrixEntry = {
  minutes: number
  polyline: string | null
  vehicleType: string  // "SUBWAY" | "WALK" | "HEAVY_RAIL" | ...
}

/** Full matrix: outer key is "from" terminal, inner key is "to" terminal. */
export type TerminalMatrix = Record<string, Record<string, MatrixEntry>>

// ---------------------------------------------------------------------------
// Terminal matching — map Google's station names onto canonical terminal names
// ---------------------------------------------------------------------------

// Normalise a station label the same way effective-journey.ts does, so
// "King's Cross St. Pancras (KGX)" and "Kings Cross" both match "kings cross".
function normalise(name: string): string {
  return name
    .toLowerCase()
    .replace(/[.']/g, "")
    .replace(/^london\s+/, "")
    .replace(/\s*\([^)]*\)\s*$/, "")
    .trim()
}

// Build a lookup of "every alias → canonical name" from the terminals list.
// Memoised per terminals-array reference (stable in practice — imported once).
const canonicalCache = new WeakMap<Terminal[], Map<string, string>>()
function buildCanonicalLookup(terminals: Terminal[]): Map<string, string> {
  const existing = canonicalCache.get(terminals)
  if (existing) return existing
  const map = new Map<string, string>()
  for (const t of terminals) {
    map.set(normalise(t.name), t.name)
    for (const alias of t.aliases) map.set(normalise(alias), t.name)
  }
  canonicalCache.set(terminals, map)
  return map
}

/** Given a station name from journey data, return the canonical terminal
 *  name (e.g. "Paddington"), or null if the station isn't a recognised
 *  London terminal. Exported because map.tsx may want to check this too. */
export function matchTerminal(
  stationName: string | undefined,
  terminals: Terminal[]
): string | null {
  if (!stationName) return null
  const lookup = buildCanonicalLookup(terminals)
  return lookup.get(normalise(stationName)) ?? null
}

// ---------------------------------------------------------------------------
// Polyline helpers
// ---------------------------------------------------------------------------

/** Decode a Google polyline5 string into [lng, lat] pairs. Same algorithm as
 *  components/map.tsx:decodePolyline — duplicated here so this module can run
 *  in any environment without importing from the component. */
function decodePolyline(encoded: string): [number, number][] {
  const coords: [number, number][] = []
  let i = 0, lat = 0, lng = 0
  while (i < encoded.length) {
    for (const apply of [(v: number) => { lat += v }, (v: number) => { lng += v }]) {
      let shift = 0, result = 0, byte: number
      do {
        byte = encoded.charCodeAt(i++) - 63
        result |= (byte & 0x1f) << shift
        shift += 5
      } while (byte >= 0x20)
      apply(result & 1 ? ~(result >> 1) : result >> 1)
    }
    coords.push([lng / 1e5, lat / 1e5])
  }
  return coords
}

/** Approximate squared distance between two [lng, lat] points. Not geographically
 *  accurate, but fine for "which point in a polyline is closest to this terminal". */
function sqDist(a: [number, number], b: [number, number]): number {
  const dx = a[0] - b[0]
  const dy = a[1] - b[1]
  return dx * dx + dy * dy
}

/** Given the full KX→destination polyline (decoded), return the sub-array from
 *  the point closest to `terminal` onwards. The idea: the mainline train starts
 *  at this terminal, so the polyline visually "starts" near those coords. */
function sliceFromTerminal(
  coords: [number, number][],
  terminal: Terminal
): [number, number][] {
  if (coords.length === 0) return coords
  const target: [number, number] = [terminal.lng, terminal.lat]
  let bestIdx = 0
  let bestDist = sqDist(coords[0], target)
  for (let i = 1; i < coords.length; i++) {
    const d = sqDist(coords[i], target)
    if (d < bestDist) {
      bestDist = d
      bestIdx = i
    }
  }
  return coords.slice(bestIdx)
}

// ---------------------------------------------------------------------------
// The stitcher itself
// ---------------------------------------------------------------------------

/** A JourneyInfo with optional decoded polyline coords. Stitched journeys
 *  carry the decoded array because we compose polylines by concatenation —
 *  re-encoding to the polyline5 format is unnecessary work when the only
 *  consumer (map.tsx) decodes it again immediately. */
export type StitchedJourneyInfo = JourneyInfo & {
  polyline?: string
  polylineCoords?: [number, number][]
}

/** Minimum fields we need from a GeoJSON feature. Kept loose so the stitcher
 *  can be called from both map.tsx (typed StationFeature) and from inside
 *  derived-state loops without a cast-dance. */
type FeatureLike = {
  properties:
    | { journeys?: Record<string, StitchedJourneyInfo> }
    | null
    | undefined
}

export type StitchInputs = {
  feature: FeatureLike
  /** The terminal we want to build a journey FROM. Must appear in `terminals`. */
  newOrigin: string
  matrix: TerminalMatrix
  terminals: Terminal[]
  /** Which source journey to try first. Defaults to KX cluster. */
  canonicalOrigin?: string
  /** Fallback source if the canonical one is missing. */
  fallbackOrigin?: string
}

// The KX cluster origin name used in data/origin-stations.json and journey keys.
const KX_CLUSTER_ORIGIN = "Kings Cross St Pancras"
const FARRINGDON_ORIGIN = "Farringdon"

// Minutes of platform-transfer buffer added when we prepend a tube hop.
// Matches what Google Routes tends to add for station transfers.
const INTERCHANGE_BUFFER_MIN = 3

/**
 * Produce a synthesised JourneyInfo for `newOrigin`, or null if we can't.
 *
 * Returns null (not undefined) to make "unsupported destination" behave like
 * "journey data is missing" elsewhere in the codebase — those stations just
 * drop out of time-filtered views naturally.
 */
export function stitchJourney({
  feature,
  newOrigin,
  matrix,
  terminals,
  canonicalOrigin = KX_CLUSTER_ORIGIN,
  fallbackOrigin = FARRINGDON_ORIGIN,
}: StitchInputs): StitchedJourneyInfo | null {
  const journeys = feature.properties?.journeys
  if (!journeys) return null

  // Case 0: we already have a real journey for this origin (e.g. for Farringdon,
  // Stratford, or KX). Just return it unchanged.
  const existing = journeys[newOrigin]
  if (existing) return existing

  // Try the canonical source (KX cluster) first, then fall back to Farringdon.
  const candidates = [canonicalOrigin, fallbackOrigin]
  for (const sourceOrigin of candidates) {
    if (sourceOrigin === newOrigin) continue
    const source = journeys[sourceOrigin]
    if (!source) continue
    const stitched = stitchFromSource(source, newOrigin, matrix, terminals)
    if (stitched) return stitched
  }
  return null
}

// Kings Cross / St Pancras / Euston share an Underground interchange
// ("King's Cross St. Pancras" station), so Google often reports a tube hop
// as arriving at one cluster member while the mainline train departs from
// another (e.g. arrive at "King's Cross St. Pancras", depart from "St Pancras").
// Treat them as equivalent when deciding "is the first leg a transfer into
// the terminal the mainline train leaves from?" — we pick the actual mainline
// departure as the terminal we route to.
const KX_CLUSTER = new Set(["Kings Cross", "St Pancras", "Euston"])
function sameTerminalOrCluster(a: string | null, b: string | null): boolean {
  if (!a || !b) return false
  if (a === b) return true
  return KX_CLUSTER.has(a) && KX_CLUSTER.has(b)
}

/** Identify the mainline terminal and the legs that start from it. Returns
 *  null if we can't find a terminal boundary we recognise. */
function extractMainline(
  source: StitchedJourneyInfo,
  terminals: Terminal[],
): {
  mainlineTerminal: string
  mainlineLegs: StitchedJourneyInfo["legs"]
  /** True iff we stripped the first leg (a transfer into the terminal). */
  stripped: boolean
} | null {
  const legs = source.legs
  if (legs.length === 0) return null

  // Is the first leg a *transfer* that ends at a known terminal, with the
  // second leg departing from that same terminal (or a KX-cluster equivalent)?
  // Works for SUBWAY/WALK (Kings Cross → Paddington by tube) and HEAVY_RAIL
  // (Farringdon → Paddington via the Elizabeth Line). The key signal is the
  // terminal boundary — we don't care about vehicle type.
  const candidate = matchTerminal(legs[0].arrivalStation, terminals)
  const secondDepart = legs.length >= 2 ? matchTerminal(legs[1].departureStation, terminals) : null
  if (candidate && secondDepart && sameTerminalOrCluster(candidate, secondDepart)) {
    // When the two sides of the transfer are different cluster members, we
    // route to the *actual mainline departure* (secondDepart) — that's where
    // the real train leaves from and what matrix lookups must target.
    return {
      mainlineTerminal: secondDepart,
      mainlineLegs: legs.slice(1),
      stripped: true,
    }
  }

  // No transfer — the mainline departure is just the first leg's start.
  // This covers cases where the KX journey is already direct from a terminal,
  // e.g. "St Pancras → Bedford" as a single Thameslink leg.
  const firstDepart = matchTerminal(legs[0].departureStation, terminals)
  if (firstDepart) {
    return {
      mainlineTerminal: firstDepart,
      mainlineLegs: legs,
      stripped: false,
    }
  }

  return null
}

/** Core stitcher given a specific source journey. */
function stitchFromSource(
  source: StitchedJourneyInfo,
  newOrigin: string,
  matrix: TerminalMatrix,
  terminals: Terminal[],
): StitchedJourneyInfo | null {
  const extracted = extractMainline(source, terminals)
  if (!extracted) return null
  const { mainlineTerminal, mainlineLegs, stripped } = extracted

  const terminalMeta = terminals.find((t) => t.name === mainlineTerminal)
  if (!terminalMeta) return null

  // Mainline duration in minutes, measured from the mainline train's departure
  // to the final arrival. Falls back to the raw journey duration if the source
  // wasn't stripped, or if timestamps are missing.
  const mainlineMinutes = computeMainlineMinutes(source, mainlineLegs, stripped)
  if (mainlineMinutes == null) return null

  // Mainline changes = one fewer change if we stripped a transfer leg.
  const mainlineChanges = stripped ? Math.max(0, source.changes - 1) : source.changes

  // --- Case: the user IS starting at the mainline terminal. ---
  // No prepend needed — just return the mainline portion as a complete journey.
  if (mainlineTerminal === newOrigin) {
    return buildJourney({
      source,
      mainlineLegs,
      mainlineTerminal,
      terminalMeta,
      mainlineMinutes,
      mainlineChanges,
      prepend: null,
    })
  }

  // --- Case: user is at a different terminal. Need a tube hop from matrix. ---
  const hop = matrix[newOrigin]?.[mainlineTerminal]
  if (!hop) return null

  return buildJourney({
    source,
    mainlineLegs,
    mainlineTerminal,
    terminalMeta,
    mainlineMinutes,
    mainlineChanges,
    prepend: { newOrigin, hop },
  })
}

/** How long the mainline portion takes. Prefers timestamp math (accurate
 *  even when the source started with a stripped transfer), falls back to
 *  source.durationMinutes. */
function computeMainlineMinutes(
  source: StitchedJourneyInfo,
  mainlineLegs: StitchedJourneyInfo["legs"],
  stripped: boolean,
): number | null {
  const firstDeparture = mainlineLegs[0]?.departureTime
  const lastArrival = mainlineLegs.at(-1)?.arrivalTime
  if (firstDeparture && lastArrival) {
    const mins = (new Date(lastArrival).getTime() - new Date(firstDeparture).getTime()) / 60_000
    if (Number.isFinite(mins) && mins >= 0) return Math.round(mins)
  }
  // Without timestamps we can't isolate the mainline portion when the source
  // included a transfer. Bail rather than report a misleading total.
  if (stripped) return null
  return source.durationMinutes
}

type BuildJourneyArgs = {
  source: StitchedJourneyInfo
  mainlineLegs: StitchedJourneyInfo["legs"]
  mainlineTerminal: string
  terminalMeta: Terminal
  mainlineMinutes: number
  mainlineChanges: number
  prepend: { newOrigin: string; hop: MatrixEntry } | null
}

function buildJourney({
  source,
  mainlineLegs,
  mainlineTerminal,
  terminalMeta,
  mainlineMinutes,
  mainlineChanges,
  prepend,
}: BuildJourneyArgs): StitchedJourneyInfo | null {
  // --- Polyline --------------------------------------------------------------
  let coords: [number, number][] = []
  if (source.polyline) {
    const fullCoords = decodePolyline(source.polyline)
    coords = sliceFromTerminal(fullCoords, terminalMeta)
  }
  if (prepend && prepend.hop.polyline) {
    const hopCoords = decodePolyline(prepend.hop.polyline)
    coords = [...hopCoords, ...coords]
  }

  // --- Duration + changes ----------------------------------------------------
  const durationMinutes = prepend
    ? prepend.hop.minutes + INTERCHANGE_BUFFER_MIN + mainlineMinutes
    : mainlineMinutes

  const changes = prepend ? mainlineChanges + 1 : mainlineChanges

  // --- Legs ------------------------------------------------------------------
  let prependLeg: StitchedJourneyInfo["legs"][number] | null = null
  if (prepend) {
    // Back-date synthesised timestamps from the mainline train's departure.
    const mainlineDeparture = mainlineLegs[0]?.departureTime
    const arrivalMs = mainlineDeparture
      ? new Date(mainlineDeparture).getTime() - INTERCHANGE_BUFFER_MIN * 60_000
      : NaN
    const departureMs = Number.isFinite(arrivalMs)
      ? arrivalMs - prepend.hop.minutes * 60_000
      : NaN
    prependLeg = {
      departureStation: prepend.newOrigin,
      arrivalStation: mainlineTerminal,
      vehicleType: prepend.hop.vehicleType,
      departureTime: Number.isFinite(departureMs) ? new Date(departureMs).toISOString() : undefined,
      arrivalTime: Number.isFinite(arrivalMs) ? new Date(arrivalMs).toISOString() : undefined,
    }
  }

  const legs = prependLeg ? [prependLeg, ...mainlineLegs] : [...mainlineLegs]

  return {
    durationMinutes,
    changes,
    legs,
    polylineCoords: coords.length > 0 ? coords : undefined,
  }
}

// ---------------------------------------------------------------------------
// Convenience: augment a journeys dict with a stitched entry for primaryOrigin
// ---------------------------------------------------------------------------

/** Returns a journeys dict that is guaranteed to contain an entry for
 *  `primaryOrigin` (if one can be stitched). Original journeys are never
 *  mutated. If the stitcher returns null, the returned dict is unchanged. */
export function augmentJourneys(
  feature: FeatureLike,
  primaryOrigin: string,
  matrix: TerminalMatrix,
  terminals: Terminal[],
): Record<string, StitchedJourneyInfo> | undefined {
  const existing = feature.properties?.journeys
  if (!existing) return undefined
  if (existing[primaryOrigin]) return existing
  const stitched = stitchJourney({ feature, newOrigin: primaryOrigin, matrix, terminals })
  if (!stitched) return existing
  return { ...existing, [primaryOrigin]: stitched }
}
