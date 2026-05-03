// Unified display-info lookup for any origin (station or cluster anchor).
// Replaces the per-constant maps PRIMARY_ORIGINS / FRIEND_ORIGINS /
// ALL_ORIGINS that map.tsx historically used to surface displayName /
// menuName / mobileDisplayName / overlayName for the selected origin.
//
// Single source of truth: the station registry. Real stations carry
// their optional display overrides via the GeoJSON properties on
// public/stations.json (mobileDisplayName etc.). Cluster anchors carry
// theirs via the matching fields on the ClusterDef in clusters-data.json.
// Both surfaces flow into StationRecord, so this helper is just a thin
// resolver with fallbacks.

import { getStation, type StationId, type StationRecord } from "./station-registry"

// Same field set the picker / map / modal need — all four labels
// always populated (with sensible fallbacks), plus a couple of structural
// flags consumers use to branch rendering. canonicalName is preserved
// for backwards-compatibility with the OriginDef shape that map.tsx
// used to consume; it equals StationRecord.name.
export type OriginDisplay = {
  id: StationId
  canonicalName: string       // matches stations.json `name` / cluster displayName
  displayName: string         // short label (filter trigger, map label)
  menuName: string            // longer label for dropdown menu items
  mobileDisplayName?: string  // super-shorthand below the sm breakpoint
  overlayName?: string        // photo-overlay modal title override
  isCluster: boolean          // true for synthetic cluster anchors only
}

// Resolve display info for an origin ID. Returns null when the ID is
// unknown (caller decides whether to log/fallback/skip).
export function getOriginDisplay(id: StationId): OriginDisplay | null {
  const s = getStation(id)
  if (!s) return null
  return fromStationRecord(s)
}

// Internal — turn a StationRecord into an OriginDisplay with fallbacks
// applied. Pulled out so callers iterating `getAllStations()` don't have
// to repeat the fallback chain.
//
// canonicalName is always the OSM-canonical name (StationRecord.name).
// displayName is the curated friendly version (registry's optional
// `displayName` override, falling back to name) — what the picker
// shows. menuName / mobileDisplayName / overlayName cascade further
// from displayName when their own override isn't set.
export function fromStationRecord(s: StationRecord): OriginDisplay {
  const display = s.displayName ?? s.name
  return {
    id: s.id,
    canonicalName: s.name,
    displayName: display,
    menuName: s.menuName ?? display,
    mobileDisplayName: s.mobileDisplayName,
    overlayName: s.overlayName,
    isCluster: s.isClusterAnchor,
  }
}
