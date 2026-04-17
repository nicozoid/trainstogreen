// Treats Kings Cross St Pancras, Euston, and Euston Square as a single logical
// origin. A journey that starts with a 2-minute tube hop between these stations
// and then boards a real train should be considered "effectively direct" from
// the train's actual departure station, not from Kings Cross itself.
//
// The Routes API returns station names in several variants — e.g.
// "King's Cross St. Pancras" (with a period, from Google Transit) vs
// "St Pancras International" (National Rail). We normalise before matching.

import type { JourneyInfo } from "@/components/photo-overlay"

// Normalise a station name for cluster matching: lowercase, strip apostrophes
// and periods, remove a leading "London " (Google prefixes mainline stations),
// and trim parenthetical station codes like "(KGX)".
function normaliseStation(name: string | undefined): string {
  if (!name) return ""
  return name
    .toLowerCase()
    .replace(/[.']/g, "")                // "King's Cross St. Pancras" -> "kings cross st pancras"
    .replace(/^london\s+/, "")           // "London Euston" -> "euston"
    .replace(/\s*\([^)]*\)\s*$/, "")     // "Rugby (RUG)" -> "rugby"
    .trim()
}

// Members of the cluster, in normalised form. Any journey starting or landing
// at one of these is treated as "the Kings Cross area".
const KINGS_CROSS_CLUSTER = new Set([
  "kings cross st pancras",
  "st pancras international",
  "kings cross",            // Google sometimes drops the "St Pancras" suffix
  "euston",
  "euston square",
])

// Returns true if the given station name (any variant) is one of the cluster
// members. Exported so map.tsx can test the primary origin.
export function isInKingsCrossCluster(station: string | undefined): boolean {
  return KINGS_CROSS_CLUSTER.has(normaliseStation(station))
}

// Cleans up Google's station labels for display. Google returns station names
// in several inconsistent variants; we collapse the cluster ones to their
// canonical short form so the UI always shows one of three labels for
// Kings Cross area origins/interchanges: "Kings Cross" / "St Pancras" / "Euston".
// Generic transformations (apostrophes, bracketed codes) apply to all stations.
// Exported so the station modal can prettify change-station names too.
export function prettifyStationLabel(name: string): string {
  let out = name
    .replace(/['\u2019]/g, "")              // straight ' and curly ’ apostrophes
    .replace(/\s*\([^)]*\)\s*$/, "")        // trailing "(XYZ)" station codes
    .trim()

  // Cluster-station canonicalisation — each rule is ordered so the more-specific
  // variant matches first. We do these as full replacements (not sub-replacements)
  // because any other text around them would be noise.
  //   "Kings Cross St Pancras" / "Kings Cross St. Pancras"   → "Kings Cross"
  //   "Kings Cross" (plain, already de-apostrophised)         → "Kings Cross" (no-op)
  if (/\bKings?\s+Cross(\s+St\.?\s*Pancras)?\b/i.test(out)) out = "Kings Cross"
  //   "St Pancras International" / "St. Pancras [International]" → "St Pancras"
  else if (/\bSt\.?\s+Pancras(\s+International)?\b/i.test(out)) out = "St Pancras"
  //   "Euston Square" / "Euston" → "Euston"
  else if (/\bEuston(\s+Square)?\b/i.test(out)) out = "Euston"

  return out
}

// Result of applying cluster-aware logic to a journey.
export type EffectiveJourney = {
  /** Travel time in minutes, excluding any tube hop inside the cluster. */
  effectiveMinutes: number
  /** Number of changes outside the cluster (the internal tube hop doesn't count). */
  effectiveChanges: number
  /** The station the "real" train departs from (e.g. "Euston" instead of "Kings Cross"). */
  effectiveOrigin: string
  /** True when the cluster adjustment actually changed anything (i.e. the first leg was a cluster hop). */
  isClusterHop: boolean
}

// Parses an ISO string to milliseconds. Returns NaN if invalid — callers check.
function toMillis(iso: string | undefined): number {
  return iso ? new Date(iso).getTime() : NaN
}

// Inspects a journey and decides whether the first leg is a short hop inside
// the Kings Cross cluster (e.g. Northern Line from Kings X St Pancras to Euston).
// If so, strips it from the reported time/changes and treats the second leg's
// departure station as the effective origin.
export function getEffectiveJourney(
  journey: JourneyInfo,
  origin: string
): EffectiveJourney {
  // Default for non-cluster origins — no rewrite at all. If the user picked
  // Stratford or Farringdon as primary, the raw journey is reported as-is.
  if (!isInKingsCrossCluster(origin)) {
    return {
      effectiveMinutes: journey.durationMinutes,
      effectiveChanges: journey.changes,
      effectiveOrigin: origin,
      isClusterHop: false,
    }
  }

  const legs = journey.legs ?? []
  // When the user picked a cluster station as primary, the precise departure
  // terminal lives in `legs[0].departureStation` (e.g. "St Pancras International"
  // for a Thameslink train, "King's Cross" for an ECML train). We always prefer
  // that over the user-selected origin label for display purposes. Cleaned up
  // via prettifyStationLabel so "King's Cross" becomes "Kings Cross" etc.
  const firstLegOrigin = prettifyStationLabel(legs[0]?.departureStation ?? origin)

  // Detect the tube/walk hop pattern: first leg is SUBWAY/WALK landing at
  // another cluster station. When this fires, the user effectively starts
  // from the second leg's departure station (e.g. Euston via tube).
  const first = legs[0]
  const second = legs[1]
  const isShortHop =
    legs.length >= 2 &&
    (first?.vehicleType === "SUBWAY" || first?.vehicleType === "WALK") &&
    isInKingsCrossCluster(first?.arrivalStation)

  if (!isShortHop) {
    // No tube hop — keep the raw duration/changes. Just relabel the origin
    // to the actual terminal (e.g. Baldock direct from "St Pancras International").
    return {
      effectiveMinutes: journey.durationMinutes,
      effectiveChanges: journey.changes,
      effectiveOrigin: firstLegOrigin,
      isClusterHop: false,
    }
  }

  // Tube-hop case — strip the first leg from both time and changes.
  // Effective minutes = final-leg arrival − second-leg departure. This
  // excludes the tube ride AND the platform wait before the mainline train
  // — exactly "how long it takes starting at Euston".
  const realStart = toMillis(second.departureTime)
  const finalArrival = toMillis(legs.at(-1)?.arrivalTime)
  if (!Number.isFinite(realStart) || !Number.isFinite(finalArrival)) {
    // Missing timestamps — fall back to the raw duration (rare).
    return {
      effectiveMinutes: journey.durationMinutes,
      effectiveChanges: journey.changes,
      effectiveOrigin: firstLegOrigin,
      isClusterHop: false,
    }
  }

  return {
    effectiveMinutes: Math.round((finalArrival - realStart) / 60000),
    // One fewer change — the tube hop was the change we just absorbed.
    effectiveChanges: Math.max(0, journey.changes - 1),
    effectiveOrigin: prettifyStationLabel(second.departureStation),
    isClusterHop: true,
  }
}
