// Synthetic cluster topology — single source of truth for both client
// and server-side code. A "synthetic" is a logical place (Central
// London, Birmingham, Stratford, …) that has no real station of its
// own; it aggregates several real National Rail stations as cluster
// members. The anchor coord is the synthetic's centroid (where its
// label/icon renders); members are real stations that render as
// satellite diamonds.
//
// The raw data lives in clusters-data.json so both TypeScript modules
// (this file, API routes) and plain-Node .mjs scripts (the build
// pipeline) can read it. Members are listed in declared order (used
// as the alphabetical-fallback for the cluster header in the overlay,
// and as the journey-data source when the synthetic is the active
// primary/friend).

import data from "./clusters-data.json"

export const PRIMARY_ORIGIN_CLUSTER: Record<string, string[]> = data.PRIMARY_ORIGIN_CLUSTER
export const FRIEND_ORIGIN_CLUSTER: Record<string, string[]> = data.FRIEND_ORIGIN_CLUSTER

// Display names for each synthetic anchor — used by server-side build
// scripts that need a human-readable label without pulling in client-
// only modules. Keep in sync with PRIMARY_ORIGINS / FRIEND_ORIGINS in
// map.tsx.
export const SYNTHETIC_DISPLAY_NAMES: Record<string, string> = data.SYNTHETIC_DISPLAY_NAMES

// Every coord that's a member of a synthetic cluster (primary OR
// friend), flattened to a Set for cheap membership tests. Drives:
//   • The "always render as diamond" layer for cluster members
//     (regardless of whether their cluster is the active primary/friend).
//   • A matching exclusion filter on the regular station layers, so a
//     cluster member never double-renders with both a diamond AND a
//     rating/unrated icon.
export const ALL_CLUSTER_MEMBER_COORDS: Set<string> = new Set<string>([
  ...Object.values(PRIMARY_ORIGIN_CLUSTER).flat(),
  ...Object.values(FRIEND_ORIGIN_CLUSTER).flat(),
])

// Reverse lookup: member coordKey → its synthetic anchor coordKey.
// Used by the click handler to resolve "which synthetic owns this
// diamond?" without iterating the full cluster map every time.
export const MEMBER_TO_SYNTHETIC: Record<string, string> = (() => {
  const out: Record<string, string> = {}
  for (const [anchor, members] of Object.entries(PRIMARY_ORIGIN_CLUSTER)) {
    for (const m of members) out[m] = anchor
  }
  for (const [anchor, members] of Object.entries(FRIEND_ORIGIN_CLUSTER)) {
    for (const m of members) out[m] = anchor
  }
  return out
})()

// Whether a given anchor is a primary-side or friend-side synthetic.
// Some rendering paths only mount a layer for one side, so callers
// need to know which it is.
export const SYNTHETIC_KIND: Record<string, "primary" | "friend"> = (() => {
  const out: Record<string, "primary" | "friend"> = {}
  for (const k of Object.keys(PRIMARY_ORIGIN_CLUSTER)) out[k] = "primary"
  for (const k of Object.keys(FRIEND_ORIGIN_CLUSTER)) out[k] = "friend"
  return out
})()

// All synthetic anchor coordKeys (primary + friend), flat Set for
// membership tests (e.g. "is this coord a synthetic centroid?").
export const ALL_SYNTHETIC_COORDS: Set<string> = new Set<string>([
  ...Object.keys(PRIMARY_ORIGIN_CLUSTER),
  ...Object.keys(FRIEND_ORIGIN_CLUSTER),
])

// ── Route ranking ────────────────────────────────────────────────────
//
// Mirrors the candidate-comparison rule in lib/stitch-journey.ts: when
// picking the "top-ranked" of several alternative journeys (e.g. one
// per cluster member of a synthetic), we prefer FEWER CHANGES first
// and use SHORTER DURATION as the tiebreaker. Surfacing this here
// keeps synthetic ranking and stitch ranking in lockstep — change one
// rule, both follow.

export type RankableJourney = {
  durationMinutes?: number | null
  changes?: number | null
}

// Returns true when `a` is a strictly better journey than `b`.
// "null" duration/changes are treated as worst-case so a partially-
// populated journey never beats a fully-specified one.
export function isJourneyBetter(a: RankableJourney, b: RankableJourney): boolean {
  const aChanges = a.changes ?? Infinity
  const bChanges = b.changes ?? Infinity
  if (aChanges < bChanges) return true
  if (aChanges > bChanges) return false
  const aDur = a.durationMinutes ?? Infinity
  const bDur = b.durationMinutes ?? Infinity
  return aDur < bDur
}

// Picks the top-ranked journey from a list, returning its index (so
// callers can also recover the matching cluster-member coord). Returns
// -1 when the list is empty.
export function pickTopRankedIndex<T extends RankableJourney>(
  candidates: ReadonlyArray<T>,
): number {
  let bestIdx = -1
  for (let i = 0; i < candidates.length; i++) {
    if (bestIdx === -1 || isJourneyBetter(candidates[i], candidates[bestIdx])) {
      bestIdx = i
    }
  }
  return bestIdx
}
