// Synthesises a "primary origin" JourneyInfo for a destination when we don't
// have one explicitly fetched. Reuses a pre-fetched source journey (KX cluster
// by default, Farringdon as fallback) plus a small terminal-to-terminal matrix
// (data/terminal-matrix.json) to construct journeys from any London terminal
// without making new per-destination API calls.
//
// How it works, at a glance:
//   KX journey to Swindon:     KX → Paddington (tube) → Swindon (GWR)
//                                  ^^^^^^^^^^^^^^^^^^  ^^^^^^^^^^^^^^^^
//                                  stripped (transfer  kept as "mainline"
//                                  to a terminal)
//
//   User picks "Victoria" as primary origin (passed in as a Terminal object).
//   → matrix["Victoria"]["Paddington"] = { minutes: 11, polyline, ... }
//   → Stitched journey = [Victoria→Paddington tube hop] + [Paddington→Swindon mainline]
//
// The Farringdon fallback handles the same shape — its first-leg transfer to
// Paddington is via Elizabeth line rather than tube, but the stitcher treats
// any "first leg lands at a terminal" journey uniformly.
//
// IMPORTANT LIMITATION: this file ONLY synthesises via-central-London journeys.
// If the new origin sits on a mainline (e.g. Feltham on the Waterloo-Reading
// line), destinations that share that line could be reached DIRECTLY without
// going into central London. Detecting those is out of scope here — the caller
// should consult a curated per-origin "direct-reachable" list (or real journey
// data from the Routes API) before falling back to this stitcher.

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
// Handles both straight apostrophe (') and curly apostrophe (\u2019) — Google
// Routes returns the curly form, everything else uses straight.
function normalise(name: string): string {
  return name
    .toLowerCase()
    .replace(/[.'\u2019]/g, "")
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
  /**
   * The terminal the user is starting FROM. Carries both the coord (used for
   * looking up an already-fetched journey in feature.properties.journeys) and
   * the name (used as a key into the terminal matrix, which is name-based).
   * Passing the whole Terminal avoids string-type ambiguity between the two.
   */
  newOrigin: Terminal
  matrix: TerminalMatrix
  terminals: Terminal[]
  /**
   * Coord keys of pre-fetched source journeys to try, in order. The first one
   * that both exists on the feature AND yields a successful stitch wins.
   * Defaults to Kings Cross first (more coverage of national routes via Euston
   * / KX / St Pancras), Farringdon as fallback (for destinations where the
   * Thameslink / Elizabeth line route is what we have on file).
   */
  sourceJourneyKeys?: string[]
}

// Minutes of platform-transfer buffer added when we prepend a tube hop.
// Matches what Google Routes tends to add for station transfers.
const INTERCHANGE_BUFFER_MIN = 3

// Minimum realistic wait time between two consecutive HEAVY_RAIL legs in a
// mid-journey change (e.g. change at Guildford from a Waterloo train to the
// Minimum inter-leg transfer time. API-reported gaps below this get
// padded up; values at or above are trusted verbatim. 3 min matches
// the floor of what's physically plausible for a same-platform
// cross-platform change and lets tight real-world connections (Lewes,
// Guildford cross-platform etc.) come through as the APIs report them.
//
// Also used as a fallback when a leg lacks arrival/departure timestamps
// and we can't compute the real gap from API data.
const MIN_CHANGE_BUFFER_MIN = 3

/**
 * Produce a synthesised JourneyInfo for the user starting at `newOrigin`, or
 * null if we can't. Works by taking a pre-fetched "source" journey (KX or
 * Farringdon), stripping its first-leg transfer into a London terminal, and
 * prepending a different transfer from `newOrigin` to that terminal (taken
 * from the terminal matrix).
 *
 * This only stitches VIA-CENTRAL journeys. It does NOT know whether a
 * destination is directly reachable from `newOrigin` without going into
 * central London first — that requires separate data (see data/origin-routes.json
 * if implemented, or per-origin Routes API fetches).
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
  sourceJourneyKeys,
}: StitchInputs): StitchedJourneyInfo | null {
  const journeys = feature.properties?.journeys
  if (!journeys) return null

  // If we already have a real journey for this exact coord, just return it —
  // no need to stitch.
  const newOriginKey = `${newOrigin.lng},${newOrigin.lat}`
  if (journeys[newOriginKey]) return journeys[newOriginKey]

  // Build the candidate source list. If the caller passed an explicit list,
  // honour it exactly (backwards compatibility + testability). Otherwise try
  // EVERY pre-fetched journey on the feature as a potential source.
  //
  // Why iterate every source instead of just KX + Farringdon? Because some
  // destinations have a weird "fastest route" recorded from KX on the day
  // of the fetch (e.g. Overton routes via Vauxhall + Clapham Junction when
  // direct Waterloo services were disrupted). Meanwhile the same feature's
  // Stratford journey might contain a clean "Stratford → Waterloo → Overton"
  // — stitching that source for a Waterloo primary yields "Waterloo →
  // Overton" direct after the transfer is stripped. We want to pick the
  // best result, not just the first.
  const candidateKeys = sourceJourneyKeys ?? Object.keys(journeys)

  // Collect every successful stitch and pick the winner by (fewest changes,
  // then shortest duration). Fewer changes is strongly preferred — a user
  // would rather wait a few extra minutes than pointlessly change trains.
  let best: StitchedJourneyInfo | null = null

  // FIRST — scan each source journey for an "origin-leg subsequence": a
  // contiguous run of HEAVY_RAIL legs starting with one whose departure
  // matches newOrigin, continuing to the end of the source journey (which
  // means it terminates at the feature's destination). Handles two cases
  // in one pass:
  //
  //   (a) Single trailing HEAVY_RAIL leg (the original "direct-leg
  //       shortcut"): e.g. Birmingham → Amberley stored as [Bham→Euston
  //       HEAVY_RAIL, Euston→Victoria SUBWAY, Victoria→Amberley
  //       HEAVY_RAIL] — for newOrigin=Victoria we extract the last leg
  //       alone for a 0-change journey.
  //
  //   (b) Multiple trailing HEAVY_RAIL legs starting at newOrigin: e.g.
  //       Nottingham → Southease stored as [Nott→StP HEAVY, StP→Vic
  //       SUBWAY, Vic→Lewes HEAVY, Lewes→Southease HEAVY] — for
  //       newOrigin=Victoria we extract legs[2..3], giving a 1-change
  //       Victoria → Lewes → Southease journey. This matches the route
  //       Trainline suggests as the realistic-fastest-change-at-Lewes,
  //       as opposed to the via-Brighton route extractMainline would
  //       produce by stripping only one leading leg.
  //
  // extractMainline's original logic doesn't pick up either case because
  // it only strips ONE leading-transfer leg and assumes everything after
  // is a single connected ride from that terminal.
  for (const sourceKey of candidateKeys) {
    if (sourceKey === newOriginKey) continue
    const source = journeys[sourceKey]
    if (!source?.legs || source.legs.length === 0) continue
    // Find the first HEAVY_RAIL leg departing newOrigin (or a cluster
    // equivalent). Scanning left-to-right so we always pick the earliest
    // match — closest to the user's actual boarding point.
    let startIdx = -1
    for (let i = 0; i < source.legs.length; i++) {
      const leg = source.legs[i]
      if (leg.vehicleType !== "HEAVY_RAIL") continue
      const legDepart = matchTerminal(leg.departureStation, terminals)
      if (!legDepart) continue
      if (sameTerminalOrCluster(legDepart, newOrigin.name)) {
        startIdx = i
        break
      }
    }
    if (startIdx === -1) continue
    // All legs from startIdx to end must be HEAVY_RAIL — if there's a
    // tube/walk in between, this isn't a clean rail-only continuation.
    const originLegs = source.legs.slice(startIdx)
    if (originLegs.some((l) => l.vehicleType !== "HEAVY_RAIL")) continue
    // Compute duration from the API-provided timestamps. Inter-leg
    // gaps are trusted verbatim down to a 4-minute floor — see
    // MIN_CHANGE_BUFFER_MIN for why. Single-leg journeys skip the
    // gap logic entirely.
    let minutes = 0
    let timestampsOk = true
    for (let i = 0; i < originLegs.length; i++) {
      const leg = originLegs[i]
      if (!leg.departureTime || !leg.arrivalTime) { timestampsOk = false; break }
      minutes += (new Date(leg.arrivalTime).getTime() - new Date(leg.departureTime).getTime()) / 60_000
      if (i < originLegs.length - 1) {
        const nextLeg = originLegs[i + 1]
        if (!nextLeg.departureTime) { timestampsOk = false; break }
        const gap = (new Date(nextLeg.departureTime).getTime() - new Date(leg.arrivalTime).getTime()) / 60_000
        minutes += Math.max(gap, MIN_CHANGE_BUFFER_MIN)
      }
    }
    if (!timestampsOk || !Number.isFinite(minutes) || minutes <= 0) continue
    // Carry the polyline through from the source journey, sliced to start
    // at newOrigin's coord. Without this, origin-leg-subsequence matches
    // (which is the path every London-cluster → via-cluster destination
    // takes when the source journey departs from a cluster sibling)
    // produce a stitched journey with NO polyline data — the map's hover
    // polyline then draws nothing, even though the source journey had a
    // perfectly good full-route polyline available.
    //
    // sliceFromTerminal finds the closest coord in the source polyline
    // to newOrigin and keeps the tail. For startIdx=0 (same-terminal
    // departure) that's effectively "keep everything"; for startIdx>0
    // (user boards at an intermediate stop) it trims the upstream
    // portion so the rendered polyline starts at the right place.
    let polylineCoords: [number, number][] | undefined
    if (source.polyline) {
      polylineCoords = sliceFromTerminal(decodePolyline(source.polyline), newOrigin)
    }
    const candidate: StitchedJourneyInfo = {
      durationMinutes: Math.round(minutes),
      // HEAVY_RAIL-only legs → (N legs = N-1 changes). Single leg = 0 changes.
      changes: originLegs.length - 1,
      legs: originLegs,
      polylineCoords: polylineCoords && polylineCoords.length > 1 ? polylineCoords : undefined,
    }
    if (
      best == null ||
      candidate.changes < best.changes ||
      (candidate.changes === best.changes &&
        (candidate.durationMinutes ?? Infinity) < (best.durationMinutes ?? Infinity))
    ) {
      best = candidate
    }
  }

  // THEN — the original full-stitch loop. Even if we found a direct leg
  // above, stitched alternatives might beat it on duration (rare, but the
  // comparison is cheap). stitchFromSource returns at most a 1-change
  // journey post-strip, so a direct-leg result will usually win on changes.
  for (const sourceKey of candidateKeys) {
    if (sourceKey === newOriginKey) continue
    const source = journeys[sourceKey]
    if (!source) continue
    // stitchFromSource takes the terminal NAME because the matrix is name-keyed.
    const stitched = stitchFromSource(source, newOrigin.name, matrix, terminals)
    if (!stitched || stitched.durationMinutes == null) continue
    if (
      best == null ||
      stitched.changes < best.changes ||
      (stitched.changes === best.changes &&
        (stitched.durationMinutes ?? Infinity) < (best.durationMinutes ?? Infinity))
    ) {
      best = stitched
    }
  }
  return best
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
 *  source.durationMinutes.
 *
 *  Sums per-leg ride times from each leg's own start/end timestamps,
 *  plus the API-reported gap between consecutive legs floored at
 *  MIN_CHANGE_BUFFER_MIN (4 min — roughly the tightest interchange
 *  Trainline ever quotes). Falls back to the source journey's own
 *  start-to-end delta when per-leg timestamps are missing entirely. */
function computeMainlineMinutes(
  source: StitchedJourneyInfo,
  mainlineLegs: StitchedJourneyInfo["legs"],
  stripped: boolean,
): number | null {
  if (mainlineLegs.length === 0) return null

  // Fast path: single-leg mainline has no change to buffer — just the one
  // ride's duration. Avoids allocating intermediate numbers for the common
  // direct-train case.
  if (mainlineLegs.length === 1) {
    const leg = mainlineLegs[0]
    if (leg.departureTime && leg.arrivalTime) {
      const mins = (new Date(leg.arrivalTime).getTime() - new Date(leg.departureTime).getTime()) / 60_000
      if (Number.isFinite(mins) && mins >= 0) return Math.round(mins)
    }
    if (stripped) return null
    return source.durationMinutes
  }

  // Multi-leg path: accumulate ride times + enforced-minimum interchange gaps.
  let total = 0
  for (let i = 0; i < mainlineLegs.length; i++) {
    const leg = mainlineLegs[i]
    if (!leg.departureTime || !leg.arrivalTime) {
      // A leg missing timestamps makes per-leg math unreliable — fall back
      // to the raw start-to-end delta + no buffer enforcement.
      const firstDep = mainlineLegs[0]?.departureTime
      const lastArr = mainlineLegs.at(-1)?.arrivalTime
      if (firstDep && lastArr) {
        const mins = (new Date(lastArr).getTime() - new Date(firstDep).getTime()) / 60_000
        if (Number.isFinite(mins) && mins >= 0) return Math.round(mins)
      }
      if (stripped) return null
      return source.durationMinutes
    }
    total += (new Date(leg.arrivalTime).getTime() - new Date(leg.departureTime).getTime()) / 60_000
    if (i < mainlineLegs.length - 1) {
      const nextLeg = mainlineLegs[i + 1]
      // Gap = time between this leg's arrival and the next leg's
      // departure. Trusted from the API down to a 4-min floor (see
      // MIN_CHANGE_BUFFER_MIN). Falls back to the same 4-min default
      // if the next leg lacks timestamps entirely.
      const gap = nextLeg.departureTime && nextLeg.arrivalTime
        ? (new Date(nextLeg.departureTime).getTime() - new Date(leg.arrivalTime).getTime()) / 60_000
        : MIN_CHANGE_BUFFER_MIN
      total += Math.max(gap, MIN_CHANGE_BUFFER_MIN)
    }
  }
  return Math.round(total)
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

/**
 * Returns a journeys dict that is guaranteed to contain an entry for `newOrigin`
 * (if one can be stitched). The entry is keyed by `newOrigin`'s "lng,lat" coord,
 * matching how every other origin's journeys are keyed. Original journeys are
 * never mutated. If the stitcher returns null, the returned dict is unchanged.
 */
export function augmentJourneys(
  feature: FeatureLike,
  newOrigin: Terminal,
  matrix: TerminalMatrix,
  terminals: Terminal[],
): Record<string, StitchedJourneyInfo> | undefined {
  const existing = feature.properties?.journeys
  if (!existing) return undefined
  const key = `${newOrigin.lng},${newOrigin.lat}`
  if (existing[key]) return existing
  const stitched = stitchJourney({ feature, newOrigin, matrix, terminals })
  if (!stitched) return existing
  return { ...existing, [key]: stitched }
}
