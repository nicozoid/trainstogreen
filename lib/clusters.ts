// Synthetic cluster topology — single source of truth for both client
// and server-side code. A "synthetic" is a logical place (Central
// London, Birmingham, Stratford, Windsor, …) that has no real station
// of its own; it aggregates several real National Rail stations as
// cluster members. The anchor coord is the synthetic's centroid (where
// its label/icon renders); members are real stations that render as
// satellite diamonds.
//
// Post Phase 3c every export is keyed by station ID (CRS or 4-char
// synthetic). Cluster anchors carry their lng/lat in `coord` for the
// rendering sites that need a position; everything else identifies
// stations by ID.
//
// SHAPE (clusters-data.json):
//   { CLUSTERS: { "<anchor ID>": { displayName, coord, members: [<station IDs>],
//     isPrimaryOrigin, isFriendOrigin }, … } }
//
// A cluster is a cluster first; its `isPrimaryOrigin` /
// `isFriendOrigin` flags decide whether it's also a selectable origin
// in the corresponding dropdown. A cluster with both flags false is
// destination-only — its diamonds still render and clicking opens the
// modal, but it doesn't appear in either origin dropdown.

import data from "./clusters-data.json"

// ── Cluster registry ─────────────────────────────────────────────────

export type ClusterDef = {
  displayName: string
  coord: string             // "lng,lat" centroid where the synthetic renders
  members: string[]         // station IDs of cluster members
  isPrimaryOrigin: boolean
  isFriendOrigin: boolean
  // Optional display overrides for primary-side clusters. The picker UI
  // and modal labels read these via getClusterDisplay() below; absent
  // values fall back to displayName so non-primary clusters need none of
  // these fields. Lifted from the old PRIMARY_ORIGINS OriginDef in
  // map.tsx so cluster topology AND its display info live together.
  menuName?: string         // longer label for dropdown menu items
  mobileDisplayName?: string  // super-short label below the sm breakpoint
  overlayName?: string      // override for the photo-overlay modal title
}

const RAW_CLUSTERS: Record<string, ClusterDef> =
  (data as { CLUSTERS: Record<string, ClusterDef> }).CLUSTERS

// The unified registry: every cluster keyed by its anchor ID. Iterate
// this when a code path needs to consider all clusters regardless of
// selectability (diamond rendering, virtual feature builder, click
// resolution).
export const ALL_CLUSTERS: Record<string, ClusterDef> = RAW_CLUSTERS

// Helper: build an `{ anchorId: memberIds[] }` map from clusters that
// pass a predicate. Used to derive the primary/friend exports below
// without duplicating filter logic.
function clustersWhere(predicate: (c: ClusterDef) => boolean): Record<string, string[]> {
  const out: Record<string, string[]> = {}
  for (const [anchorId, def] of Object.entries(ALL_CLUSTERS)) {
    if (predicate(def)) out[anchorId] = def.members
  }
  return out
}

// ── Origin-flagged subsets ───────────────────────────────────────────

export const PRIMARY_ORIGIN_CLUSTER: Record<string, string[]> = clustersWhere((c) => c.isPrimaryOrigin)
export const FRIEND_ORIGIN_CLUSTER: Record<string, string[]> = clustersWhere((c) => c.isFriendOrigin)

// Display names for every cluster (whether or not it's an origin).
export const SYNTHETIC_DISPLAY_NAMES: Record<string, string> = (() => {
  const out: Record<string, string> = {}
  for (const [anchorId, def] of Object.entries(ALL_CLUSTERS)) {
    out[anchorId] = def.displayName
  }
  return out
})()

// Anchor coord ("lng,lat") for every cluster. Surfaces the centroid
// for rendering sites that draw at the synthetic's position — Mapbox
// label points, hexagon icons, etc. IDs alone don't carry geometry.
export const SYNTHETIC_COORDS: Record<string, string> = (() => {
  const out: Record<string, string> = {}
  for (const [anchorId, def] of Object.entries(ALL_CLUSTERS)) {
    out[anchorId] = def.coord
  }
  return out
})()

// Every member ID of any synthetic cluster, flattened to a Set for
// cheap membership tests.
export const ALL_CLUSTER_MEMBER_IDS: Set<string> = new Set<string>(
  Object.values(ALL_CLUSTERS).flatMap((c) => c.members),
)

// Reverse lookup: member ID → its synthetic anchor ID.
export const MEMBER_TO_SYNTHETIC: Record<string, string> = (() => {
  const out: Record<string, string> = {}
  for (const [anchorId, def] of Object.entries(ALL_CLUSTERS)) {
    for (const m of def.members) out[m] = anchorId
  }
  return out
})()

// Whether a given anchor is a primary-side or friend-side synthetic.
export const SYNTHETIC_KIND: Record<string, "primary" | "friend" | undefined> = (() => {
  const out: Record<string, "primary" | "friend" | undefined> = {}
  for (const [anchorId, def] of Object.entries(ALL_CLUSTERS)) {
    if (def.isPrimaryOrigin) out[anchorId] = "primary"
    else if (def.isFriendOrigin) out[anchorId] = "friend"
  }
  return out
})()

// All synthetic anchor IDs (every cluster, regardless of selectability),
// flat Set for membership tests.
export const ALL_SYNTHETIC_IDS: Set<string> = new Set<string>(Object.keys(ALL_CLUSTERS))

// Resolved display info for a cluster anchor — every field is filled in,
// with absent overrides falling back to displayName. Returns null when
// the ID is not a known cluster anchor. Used by callers that need to
// render a cluster's name in different UI contexts (filter trigger,
// dropdown menu, mobile label, modal title) without each call site
// repeating the `?? displayName` fallback chain.
export function getClusterDisplay(anchorId: string): {
  displayName: string
  menuName: string
  mobileDisplayName: string
  overlayName: string
} | null {
  const c = ALL_CLUSTERS[anchorId]
  if (!c) return null
  return {
    displayName: c.displayName,
    menuName: c.menuName ?? c.displayName,
    mobileDisplayName: c.mobileDisplayName ?? c.displayName,
    overlayName: c.overlayName ?? c.displayName,
  }
}

// The Central London cluster's anchor ID. Hard-coded because the
// "London termini are individually selectable as primary" feature is
// scoped to this one cluster only — every other cluster keeps its
// "members aren't selectable on their own" rule.
export const CENTRAL_LONDON_ANCHOR = "CLON"

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
// callers can also recover the matching cluster-member ID). Returns
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
