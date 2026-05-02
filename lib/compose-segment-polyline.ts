// Compose a rail-following polyline from the deduplicated segment library at
// data/rail-segments.json by walking a calling-points sequence and looking up
// each adjacent CRS pair as a segment edge.
//
// Replaces the per-journey "trim a sibling Farringdon polyline" stitching
// approach in lib/stitch-journey.ts: instead of one polyline per (origin, dest)
// pair (with a render-time trim hack to repurpose Farringdon's polyline for
// other Central London terminals), we store one polyline per (CRS-A, CRS-B)
// rail edge and compose journeys by concatenation. Same polylines, ~37× less
// storage, no sibling-trim quirks.

// One entry of data/rail-segments.json. The polyline is Google polyline5
// (the format used by every other stored polyline in this app).
export type RailSegment = {
  polyline: string
  source: string
  points: number
}

// The whole rail-segments.json file: a map from "fromCRS-toCRS" to one entry.
export type RailSegments = Record<string, RailSegment>

// Decode a Google polyline5 string into [lng, lat] pairs. Same algorithm as
// components/map.tsx and lib/stitch-journey.ts — duplicated here so this
// module is standalone and can be used from scripts as well as the component.
export function decodePolyline(encoded: string): [number, number][] {
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

export type ComposeOptions = {
  // The segment library — typically `import segs from "@/data/rail-segments.json"`.
  segments: RailSegments
  // Optional CRS → [lng, lat] map. When a segment is missing from the library
  // (e.g. the 343 short walking-preferred hops that Routes API didn't return),
  // the composer can still emit a straight line between the two stations so
  // the journey doesn't break visually. Pass undefined to skip missing edges.
  crsToCoord?: Map<string, [number, number]> | Record<string, [number, number]>
}

// Outcome of one composition — useful for diagnostics and for callers that
// want to know whether they got real rail polylines or fallback straights.
export type ComposeResult = {
  coords: [number, number][]
  // Per-edge tally so callers can decide whether the result is "good enough".
  edgesResolved: number
  edgesFallback: number
  edgesMissing: number
}

// Look up a coord under either a Map or a plain object, abstracting over both.
function getCoord(
  src: ComposeOptions["crsToCoord"],
  crs: string,
): [number, number] | undefined {
  if (!src) return undefined
  if (src instanceof Map) return src.get(crs)
  return (src as Record<string, [number, number]>)[crs]
}

// Compose a polyline from a CRS sequence. Each consecutive pair is one edge.
//
// Example: callingPoints = ["PAD", "RDG", "DID", "SWI"] yields
//   [PAD-RDG segment] + [RDG-DID segment] + [DID-SWI segment], concatenated,
//   with shared join points deduplicated.
//
// If an edge is missing from `segments`, the composer either emits a straight
// line between the two stations (when crsToCoord is provided) or drops the
// edge entirely. Callers typically want the straight-line fallback because
// "polyline with a few straight bits" still renders correctly; only when
// auditing coverage do you care whether the real edge is present.
export function composeFromCallingPoints(
  callingPoints: string[],
  options: ComposeOptions,
): ComposeResult {
  const result: ComposeResult = {
    coords: [],
    edgesResolved: 0,
    edgesFallback: 0,
    edgesMissing: 0,
  }
  if (callingPoints.length < 2) return result

  // Track the last successfully-emitted coord so when an intermediate CRS is
  // unresolvable (missing from crsToCoord — e.g. brand-new stations like
  // Cambridge South which post-date stations.json) we can still draw a
  // straight line FROM where we are TO the next known coord, instead of
  // discarding everything before the unknown CRS.
  let lastKnown: [number, number] | undefined

  // Greedy-longest matching: at each starting point, look for the FARTHEST
  // later calling point that we have a segment to, and use that single
  // segment to bridge over the intermediates. This handles two cases at once:
  //
  //   1. Unresolvable intermediates (e.g. Cambridge South). The pair-by-pair
  //      lookup would emit ugly straight lines for each unresolvable CRS;
  //      jumping straight to the next bridgeable segment skips them cleanly.
  //
  //   2. Sparse fetched segments. If we have KGX→CBG (65 pts) and
  //      CBG→ELY (21 pts) but no per-stop sub-segments, the longest-jump
  //      approach uses both in two hops. Without it, the pair-by-pair walk
  //      would fall through to per-station straight lines.
  //
  // Tradeoff: a long segment may be visually different from the "true"
  // train path if the train calls at intermediate stations off the segment's
  // polyline. In practice this is fine because Google's transit polyline
  // for KGX→ELY follows the same ECML route the calling train uses.
  let i = 0
  while (i < callingPoints.length - 1) {
    const a = callingPoints[i]
    // Find the farthest j > i for which we have a segment a → callingPoints[j].
    let bestSeg: RailSegment | null = null
    let bestJ = -1
    for (let j = callingPoints.length - 1; j > i; j--) {
      const seg = options.segments[`${a}-${callingPoints[j]}`]
      if (seg?.polyline) {
        bestSeg = seg
        bestJ = j
        break
      }
    }

    if (bestSeg && bestJ > i) {
      const decoded = decodePolyline(bestSeg.polyline)
      const skipFirst = result.coords.length > 0
      for (let k = skipFirst ? 1 : 0; k < decoded.length; k++) {
        result.coords.push(decoded[k])
      }
      result.edgesResolved += 1
      lastKnown = result.coords[result.coords.length - 1]
      i = bestJ
      continue
    }

    // No bridgeable segment at all from this point. Fall back to the simple
    // pair (a, callingPoints[i+1]) and try the best straight line we can.
    const b = callingPoints[i + 1]
    const ac = getCoord(options.crsToCoord, a)
    const bc = getCoord(options.crsToCoord, b)
    if (ac && bc) {
      if (result.coords.length === 0) result.coords.push(ac)
      result.coords.push(bc)
      result.edgesFallback += 1
      lastKnown = bc
    } else if (bc && lastKnown) {
      result.coords.push(bc)
      result.edgesFallback += 1
      lastKnown = bc
    } else if (ac && !bc) {
      if (result.coords.length === 0) result.coords.push(ac)
      result.edgesMissing += 1
      lastKnown = ac
    } else {
      result.edgesMissing += 1
    }
    i += 1
  }
  return result
}

// Convenience: compose polylines for a multi-leg journey by joining each
// rail leg's segments. The caller must supply, per leg, either a
// `callingPoints` sequence (for HEAVY_RAIL legs we have data for) or a
// `legPolyline` (for tube hops, which have their own polylines from the
// TfL terminal matrices and are NOT in the rail-segments library).
export type LegInput =
  | { kind: "rail"; callingPoints: string[] }
  | { kind: "raw"; coords: [number, number][] }

export function composeJourney(
  legs: LegInput[],
  options: ComposeOptions,
): ComposeResult {
  const result: ComposeResult = {
    coords: [],
    edgesResolved: 0,
    edgesFallback: 0,
    edgesMissing: 0,
  }
  for (const leg of legs) {
    let legResult: ComposeResult
    if (leg.kind === "rail") {
      legResult = composeFromCallingPoints(leg.callingPoints, options)
    } else {
      // Tube/walk leg — the caller supplies the decoded polyline directly
      // (typically pulled from terminal-matrix.json or tfl-hop-matrix.json).
      legResult = {
        coords: leg.coords,
        edgesResolved: leg.coords.length > 1 ? 1 : 0,
        edgesFallback: 0,
        edgesMissing: 0,
      }
    }
    // Concat with dedup of the join point between consecutive legs.
    const skipFirst = result.coords.length > 0 && legResult.coords.length > 0
    for (let i = skipFirst ? 1 : 0; i < legResult.coords.length; i++) {
      result.coords.push(legResult.coords[i])
    }
    result.edgesResolved += legResult.edgesResolved
    result.edgesFallback += legResult.edgesFallback
    result.edgesMissing += legResult.edgesMissing
  }
  return result
}

// ---------------------------------------------------------------------------
// Full-journey composer — name-resolution-aware, both backfill scripts and
// the runtime renderer use this. Takes a journey's legs (with station NAMES
// rather than CRS, since that's what the legs come stamped with) plus the
// journey's known origin + destination coords, and returns a single decoded
// polyline that follows the rail tracks across every leg.
// ---------------------------------------------------------------------------

export type JourneyLeg = {
  vehicleType?: string | null
  departureStation?: string | null
  arrivalStation?: string | null
}

export type NameCandidate = {
  coord: [number, number]
  crs: string | null
  network: string | null
  isPrimary: boolean
}

// Origin-routes (data/origin-routes.json) shape we depend on. Other fields
// exist; we only read these.
export type OriginRoutesData = Record<
  string,
  {
    crs?: string
    name?: string
    directReachable?: Record<string, { fastestCallingPoints?: string[] }>
  }
>

// Terminal/hop matrices (data/terminal-matrix.json + data/tfl-hop-matrix.json
// merged) shape we depend on.
export type TerminalMatrixData = Record<
  string,
  Record<string, { polyline?: string | null }>
>

// All the lookup tables the full-journey composer needs. Build once via
// buildComposeContext and pass in.
export type ComposeContext = {
  segments: RailSegments
  originRoutes: OriginRoutesData
  terminalMatrix: TerminalMatrixData
  crsToCoord: Map<string, [number, number]>
  nameToCandidates: Map<string, NameCandidate[]>
  coordToCrs: Map<string, string>
}

// Inputs for buildComposeContext — the raw data files imported by the caller.
// Stations is a GeoJSON FeatureCollection; we only read each feature's
// geometry.coordinates and properties.{name, canonicalName, ref:crs, network}.
// `canonicalName` is the un-shortened OSM name (set by map.tsx when it
// applies a display-name override like "London St. Pancras International" →
// "St Pancras"); when present, the composer indexes the station under BOTH
// names so leg-name lookups match either form.
export type StationFeatureLike = {
  geometry?: { coordinates?: [number, number] | number[] }
  properties?: {
    name?: string
    canonicalName?: string
    "ref:crs"?: string
    network?: string
  } | null
}

// Aggressive name normalisation — strips curly apostrophes (Google), straight
// apostrophes (OSM straight form) and missing apostrophes (OSM missing form),
// dots, "London " prefix, and "(...)" disambiguation suffixes. Different
// naming styles for the same station collapse onto one key.
export function normName(s: string): string {
  return s
    .toLowerCase()
    .replace(/[’']/g, "")
    .replace(/\./g, "")
    .replace(/^london\s+/, "")
    .replace(/\s*\([^)]*\)\s*$/, "")
    .trim()
}

// Score the network so the right homonym wins when multiple stations share a
// normalized name (e.g. KGX vs ZKX). National Rail wins, with the tube as a
// last resort. Mirrors the project's existing disambiguation memory note.
export function networkRank(network: string | null | undefined): number {
  if (!network) return 0
  const n = network.toLowerCase()
  if (n.includes("national rail")) return 5
  if (n.includes("elizabeth")) return 4
  if (n.includes("overground")) return 3
  if (n.includes("dlr")) return 2
  if (n.includes("underground")) return 1
  return 0
}

export function buildComposeContext({
  stations,
  originRoutes,
  segments,
  terminalMatrix,
}: {
  stations: { features: StationFeatureLike[] }
  originRoutes: OriginRoutesData
  segments: RailSegments
  terminalMatrix: TerminalMatrixData
}): ComposeContext {
  const crsToCoord = new Map<string, [number, number]>()
  const nameToCandidates = new Map<string, NameCandidate[]>()
  const coordToCrs = new Map<string, string>()
  for (const f of stations.features) {
    const c = f.geometry?.coordinates
    if (!Array.isArray(c) || c.length < 2) continue
    const coord: [number, number] = [c[0] as number, c[1] as number]
    const crs = f.properties?.["ref:crs"] ?? null
    const name = f.properties?.name ?? null
    if (crs) {
      if (!crsToCoord.has(crs)) crsToCoord.set(crs, coord)
      const ck = `${coord[0]},${coord[1]}`
      if (!coordToCrs.has(ck)) coordToCrs.set(ck, crs)
    }
    const candidate: NameCandidate = {
      coord,
      crs,
      network: f.properties?.network ?? null,
      isPrimary: originRoutes[`${coord[0]},${coord[1]}`] != null,
    }
    // Index under both the displayed name and the canonical (un-overridden)
    // name when they differ. Map.tsx's TERMINUS_DISPLAY_OVERRIDES rewrites
    // "London St. Pancras International" → "St Pancras" for cleaner UI
    // labels, but Google's leg.departureStation still uses the original
    // long form — without canonicalName indexing here, those lookups
    // returned undefined and the journey fell back to a straight line.
    const canonical = f.properties?.canonicalName
    const indexUnder = new Set<string>()
    if (name) indexUnder.add(normName(name))
    if (canonical) indexUnder.add(normName(canonical))
    for (const norm of indexUnder) {
      const arr = nameToCandidates.get(norm) ?? []
      arr.push(candidate)
      nameToCandidates.set(norm, arr)
    }
  }
  return { segments, originRoutes, terminalMatrix, crsToCoord, nameToCandidates, coordToCrs }
}

// Resolve a station name to a [lng, lat] coord. When multiple stations share
// the normalised name (Newport Wales vs Essex, Waterloo London vs Merseyside,
// Gillingham Kent vs Dorset), score on:
//
//   1. Whether this station is a primary in origin-routes (the "real" rail
//      station — beats e.g. SPL Eurostar platforms over STP National Rail).
//   2. Network rank (NR > Elizabeth > Overground > DLR > Underground).
//   3. Proximity score combining both hints — the leg's `fromCoord` (where
//      the train just was) and `towardCoord` (where the journey is heading).
//      Each candidate's score is -max(distFromHere, distToward); the winner
//      minimises the worst-case detour. This handles three patterns at once:
//
//        - Newport (Wales) on a Paddington→Abergavenny journey: leg 1 dep
//          is Paddington, dest is Abergavenny. Newport Essex is closer to
//          Paddington but FAR from Abergavenny; Newport Wales is far from
//          Paddington but ON the way to Abergavenny. The max-distance
//          tiebreaker picks Wales because its worst hint-distance is much
//          smaller (the route bends through Wales).
//
//        - Gillingham (Kent) on a Cannon Street→Chatham→Gillingham journey
//          where destCoord points at GIL Dorset (data-corruption case):
//          fromCoord is Chatham (Kent), so Kent's Gillingham wins on the
//          fromCoord half of the max(). The polyline ends at Kent rather
//          than fabricating a 280km straight line into Dorset.
//
//        - Waterloo (London) for any London-rooted journey: WAT London is
//          close to both primary and any destination; WLO Merseyside is far
//          from both. London wins on EITHER hint half.
//
// Either hint may be null; if both are null, only the primary/network
// tiebreakers fire (rare — only when called with no journey context).
export function resolveStationCoord(
  rawName: string | null | undefined,
  fromCoord: [number, number] | null | undefined,
  ctx: ComposeContext,
  towardCoord?: [number, number] | null,
): [number, number] | null {
  if (!rawName) return null
  const candidates = ctx.nameToCandidates.get(normName(rawName))
  if (!candidates || candidates.length === 0) return null
  if (candidates.length === 1) return candidates[0].coord
  // Strongest signal: is there an actual railway from fromCoord to this
  // candidate? If yes, the rail network confirms which homonym is on the
  // train's path — beats both network rank and proximity. Without this,
  // pre-existing routing-diff data corruption (Gillingham Dorset entries
  // whose legs end at Kent) would let destCoord pull the resolver to the
  // wrong homonym. The underlying check is constant-time per candidate.
  const fromKey = fromCoord ? `${fromCoord[0]},${fromCoord[1]}` : null
  const fromEntry = fromKey ? ctx.originRoutes[fromKey] : null
  let best = candidates[0]
  let bestScore = -Infinity
  for (const c of candidates) {
    const primaryScore = c.isPrimary ? 100 : 0
    const networkScore = networkRank(c.network) * 1000
    let proximityScore = 0
    const distSq = (h: [number, number] | null | undefined) => {
      if (!h) return 0
      const dx = c.coord[0] - h[0]
      const dy = c.coord[1] - h[1]
      return dx * dx + dy * dy
    }
    if (fromCoord || towardCoord) {
      proximityScore = -Math.max(distSq(fromCoord), distSq(towardCoord))
    }
    // Rail-reachability bonus: dominates everything else when one candidate
    // is actually reachable from fromCoord by train and the other isn't.
    // The bonus is large enough (10000) to overpower a 5000-point network
    // score difference, so a National Rail homonym 200km away still loses
    // to an Underground homonym ON the train's path. In practice the cases
    // where reachability disagrees with network rank are vanishingly rare.
    const reachableBonus =
      fromEntry?.directReachable?.[`${c.coord[0]},${c.coord[1]}`] != null ? 10000 : 0
    const score = reachableBonus + primaryScore + networkScore + proximityScore
    if (score > bestScore) {
      bestScore = score
      best = c
    }
  }
  return best.coord
}

const coordKey = (c: [number, number]): string => `${c[0]},${c[1]}`

// Look up the calling-points sequence for a single rail leg. Tries direct
// origin-routes lookup, then a single-sequence slice fallback (for legs whose
// depCRS isn't itself a primary), then a 2-hop search via a midpoint primary.
function findCallingPoints(
  depCoord: [number, number],
  arrCoord: [number, number],
  ctx: ComposeContext,
): string[] | null {
  const depKey = coordKey(depCoord)
  const arrKey = coordKey(arrCoord)
  const direct = ctx.originRoutes[depKey]?.directReachable?.[arrKey]?.fastestCallingPoints
  if (Array.isArray(direct) && direct.length >= 2) return direct

  const depCrs = ctx.coordToCrs.get(depKey)
  if (!depCrs) return null

  // Fallback 1: single-sequence slice — find an origin whose journey to
  // arrCoord passes through depCRS, then slice from depCRS.
  let bestSlice: string[] | null = null
  for (const oEntry of Object.values(ctx.originRoutes)) {
    const cand = oEntry.directReachable?.[arrKey]?.fastestCallingPoints
    if (!Array.isArray(cand)) continue
    const idx = cand.indexOf(depCrs)
    if (idx > 0 && idx < cand.length - 1) {
      const sliced = cand.slice(idx)
      if (!bestSlice || sliced.length > bestSlice.length) bestSlice = sliced
    }
  }
  if (bestSlice) return bestSlice

  // Fallback 2: two-hop via a midpoint primary M — find any origin whose
  // directReachable to arrCoord exists, then check whether depCRS reaches M
  // (either as a primary itself, or as an intermediate calling point in some
  // other origin's journey to M). Compose [depCRS … M] + [M … arrCRS].
  for (const [mCoord, mEntry] of Object.entries(ctx.originRoutes)) {
    const midToArr = mEntry.directReachable?.[arrKey]?.fastestCallingPoints
    if (!Array.isArray(midToArr) || midToArr.length < 2) continue
    const midCrs = midToArr[0]
    if (!midCrs) continue
    const depEntry = ctx.originRoutes[depKey]
    const depToMid = depEntry?.directReachable?.[mCoord]?.fastestCallingPoints
    if (Array.isArray(depToMid) && depToMid[0] === depCrs) {
      return [...depToMid, ...midToArr.slice(1)]
    }
    for (const oEntry2 of Object.values(ctx.originRoutes)) {
      const cand2 = oEntry2.directReachable?.[mCoord]?.fastestCallingPoints
      if (!Array.isArray(cand2)) continue
      const idx2 = cand2.indexOf(depCrs)
      if (idx2 > 0 && idx2 < cand2.length - 1 && cand2[cand2.length - 1] === midCrs) {
        return [...cand2.slice(idx2), ...midToArr.slice(1)]
      }
    }
  }

  return null
}

// Compose the full polyline for a multi-leg journey by composing each rail
// leg from segments and concatenating them. Tube/walk legs use the
// terminal-matrix polyline. Returns null if nothing usable could be built.
//
// `primaryOriginCoord` is the journey's home coord — for synthetic primaries
// (e.g. the Central London anchor) this isn't a real station, but it's still
// used as a fallback hint. `destCoord` is the journey's authoritative
// destination — also the right hint for resolving change-station names
// (a change-station is by definition on the way to destCoord).
export function composeFullJourneyPolyline(
  legs: JourneyLeg[],
  primaryOriginCoord: [number, number],
  destCoord: [number, number],
  ctx: ComposeContext,
): [number, number][] | null {
  if (!Array.isArray(legs) || legs.length === 0) return null
  const out: [number, number][] = []

  // Resolve every leg's bounds with TWO geographic hints:
  //   - fromCoord: where the train just was (= previous leg's arrival, or
  //     the primary origin for leg 1)
  //   - towardCoord: where the journey is heading (= destCoord)
  //
  // The resolver minimises max(distFromHere, distToward), which biases each
  // homonym choice toward the station that's geographically continuous with
  // the journey AS A WHOLE — close to where we just were AND in the direction
  // we're going. Without the towardCoord hint, "Newport" on a Paddington-to-
  // Abergavenny journey snaps to Newport Essex (closer to Paddington) instead
  // of Newport Wales. Without the fromCoord hint, "Gillingham" on a
  // Cannon-Street-to-Gillingham journey corrupted to point at GIL Dorset
  // would snap to Dorset and produce a 280km straight line from Chatham.
  // Both together resolve cleanly.
  const legBounds: { depCoord: [number, number] | null; arrCoord: [number, number] | null }[] = []
  let prevCoord: [number, number] = primaryOriginCoord
  for (let li = 0; li < legs.length; li++) {
    const leg = legs[li]
    const isLast = li === legs.length - 1
    const depCoord = resolveStationCoord(leg.departureStation, prevCoord, ctx, destCoord)
    const fromHint = depCoord ?? prevCoord
    let arrCoord = resolveStationCoord(leg.arrivalStation, fromHint, ctx, destCoord)
    // Final-leg safety net: if the resolver couldn't find a candidate for the
    // arrival name (no station with that name in the dataset), fall back to
    // destCoord so the journey still terminates somewhere visible.
    if (isLast && !arrCoord) arrCoord = destCoord
    legBounds.push({ depCoord, arrCoord })
    if (arrCoord) prevCoord = arrCoord
    else if (depCoord) prevCoord = depCoord
  }

  for (let li = 0; li < legs.length; li++) {
    const leg = legs[li]
    const { depCoord, arrCoord } = legBounds[li]
    if (!depCoord || !arrCoord) continue

    let legCoords: [number, number][] = []

    if (leg.vehicleType === "HEAVY_RAIL") {
      const cp = findCallingPoints(depCoord, arrCoord, ctx)
      if (cp && cp.length >= 2) {
        const result = composeFromCallingPoints(cp, {
          segments: ctx.segments,
          crsToCoord: ctx.crsToCoord,
        })
        legCoords = result.coords
      } else {
        legCoords = [depCoord, arrCoord]
      }
    } else if (leg.vehicleType === "SUBWAY" || leg.vehicleType === "WALK") {
      const m = ctx.terminalMatrix[leg.departureStation ?? ""]?.[leg.arrivalStation ?? ""]
      if (m?.polyline) {
        legCoords = decodePolyline(m.polyline)
      } else {
        legCoords = [depCoord, arrCoord]
      }
    } else {
      legCoords = [depCoord, arrCoord]
    }

    if (legCoords.length < 2) continue
    const skipFirst = out.length > 0
    for (let k = skipFirst ? 1 : 0; k < legCoords.length; k++) {
      out.push(legCoords[k])
    }
  }

  if (out.length < 2) {
    // Last-resort fallback: a straight line from primary to destination.
    return [primaryOriginCoord, destCoord]
  }
  return out
}
