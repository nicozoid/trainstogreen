// Synthetic cluster topology — single source of truth for both client
// and server-side code. A "synthetic" is a logical place (Central
// London, Birmingham, Stratford, Windsor, …) that has no real station
// of its own; it aggregates several real National Rail stations as
// cluster members. The anchor coord is the synthetic's centroid (where
// its label/icon renders); members are real stations that render as
// satellite diamonds.
//
// SHAPE (clusters-data.json):
//   { CLUSTERS: { "<anchor coord>": { displayName, members[],
//     isPrimaryOrigin, isFriendOrigin }, … } }
//
// A cluster is a cluster first; its `isPrimaryOrigin` /
// `isFriendOrigin` flags decide whether it's also a selectable origin
// in the corresponding dropdown. A cluster with both flags false is
// destination-only — its diamonds still render and clicking opens the
// modal, but it doesn't appear in either origin dropdown. Flipping a
// flag promotes the cluster to an origin without any other code
// changes (the derived maps below pick it up automatically).
//
// The raw data lives in clusters-data.json so both TypeScript modules
// (this file, API routes) and plain-Node .mjs scripts (the build
// pipeline) can read it. Members are listed in declared order (used
// as the alphabetical-fallback for the cluster header in the overlay,
// and as the journey-data source when the synthetic is the active
// primary/friend).

import data from "./clusters-data.json"

// ── Cluster registry ─────────────────────────────────────────────────

export type ClusterDef = {
  displayName: string
  members: string[]
  isPrimaryOrigin: boolean
  isFriendOrigin: boolean
}

// The unified registry: every cluster keyed by its anchor coord.
// Iterate this when a code path needs to consider all clusters
// regardless of selectability (diamond rendering, virtual feature
// builder, click resolution).
export const ALL_CLUSTERS: Record<string, ClusterDef> = data.CLUSTERS as Record<string, ClusterDef>

// Helper: build an `{ anchor: members[] }` map from clusters that pass
// a predicate. Used to derive the legacy primary/friend exports below
// without duplicating the filter logic.
function clustersWhere(predicate: (c: ClusterDef) => boolean): Record<string, string[]> {
  const out: Record<string, string[]> = {}
  for (const [anchor, def] of Object.entries(ALL_CLUSTERS)) {
    if (predicate(def)) out[anchor] = def.members
  }
  return out
}

// ── Legacy-shape exports (origin-flagged subsets) ────────────────────
// Same shape as before so existing call sites in map.tsx, build
// scripts, and API routes don't need to change. These are derived
// views of ALL_CLUSTERS; the source of truth is the registry above.

export const PRIMARY_ORIGIN_CLUSTER: Record<string, string[]> = clustersWhere((c) => c.isPrimaryOrigin)
export const FRIEND_ORIGIN_CLUSTER: Record<string, string[]> = clustersWhere((c) => c.isFriendOrigin)

// Display names for every cluster (whether or not it's an origin).
// Used by:
//   • Server-side build scripts that need a human-readable label
//     without pulling in client-only modules.
//   • The map's modal-title fallback when a clicked cluster anchor
//     isn't registered as a primary/friend origin (i.e. destination-
//     only clusters like Windsor).
export const SYNTHETIC_DISPLAY_NAMES: Record<string, string> = (() => {
  const out: Record<string, string> = {}
  for (const [anchor, def] of Object.entries(ALL_CLUSTERS)) {
    out[anchor] = def.displayName
  }
  return out
})()

// Every coord that's a member of any synthetic cluster, flattened to
// a Set for cheap membership tests. Drives:
//   • The "always render as diamond" layer for cluster members
//     (regardless of whether their cluster is the active primary/friend
//     or even an origin at all).
//   • A matching exclusion filter on the regular station layers, so a
//     cluster member never double-renders with both a diamond AND a
//     rating/unrated icon.
export const ALL_CLUSTER_MEMBER_COORDS: Set<string> = new Set<string>(
  Object.values(ALL_CLUSTERS).flatMap((c) => c.members),
)

// Reverse lookup: member coordKey → its synthetic anchor coordKey.
// Used by the click handler to resolve "which synthetic owns this
// diamond?" without iterating the full cluster map every time.
export const MEMBER_TO_SYNTHETIC: Record<string, string> = (() => {
  const out: Record<string, string> = {}
  for (const [anchor, def] of Object.entries(ALL_CLUSTERS)) {
    for (const m of def.members) out[m] = anchor
  }
  return out
})()

// Whether a given anchor is a primary-side or friend-side synthetic.
// Some rendering paths only mount a layer for one side, so callers
// need to know which it is. Returns undefined for destination-only
// clusters (neither primary nor friend) — those rely on the universal
// cluster-diamond layer and don't need a per-side overlay.
export const SYNTHETIC_KIND: Record<string, "primary" | "friend" | undefined> = (() => {
  const out: Record<string, "primary" | "friend" | undefined> = {}
  for (const [anchor, def] of Object.entries(ALL_CLUSTERS)) {
    if (def.isPrimaryOrigin) out[anchor] = "primary"
    else if (def.isFriendOrigin) out[anchor] = "friend"
    // destination-only → omitted; lookup returns undefined naturally
  }
  return out
})()

// All synthetic anchor coordKeys (every cluster, regardless of
// selectability), flat Set for membership tests (e.g. "is this coord
// a synthetic centroid?").
export const ALL_SYNTHETIC_COORDS: Set<string> = new Set<string>(Object.keys(ALL_CLUSTERS))

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
