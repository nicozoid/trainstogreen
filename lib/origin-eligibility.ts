// Origin eligibility predicate. Replaces the hardcoded PRIMARY_ORIGINS /
// FRIEND_ORIGINS / ADMIN_ONLY_PRIMARIES system with a data-driven check:
// a station/cluster is eligible to be picked as an origin iff it has full
// V2 RTT data for Saturday mornings (i.e. data/rtt-coverage.json marks it
// "ready"). Stations that will never have RTT data (TfL-only, etc.) get a
// network-specific label. Stations that fetched but turned out to have no
// Saturday morning service get "Ghost station". Stations awaiting their
// first fetch get "Coming soon".
//
// The picker UI uses the label to render ineligible stations greyed-out
// in search — same UX as the existing "Coming soon" treatment, just
// generalised across the new label set.

import type { StationRecord } from "./station-registry"

export type EligibilityLabel =
  | "TfL station — no data"        // London Underground / Overground / DLR / Elizabeth standalone
  | "Metro station — no data"      // Tyne & Wear Metro
  | "Subway station — no data"     // Glasgow Subway
  | "NIR station — no data"        // Northern Ireland Railways
  | "Heritage station — no data"   // heritage / unknown (Z-prefix synthetic IDs)
  | "Ghost station"                // fetched, no Saturday morning service
  | "Coming soon"                  // not yet fetched

// Discriminated union — when `eligible` is true the label is omitted, so
// downstream code can't accidentally render a label for a pickable station.
export type OriginStatus =
  | { eligible: true }
  | { eligible: false; label: EligibilityLabel }

// Map of station ID → fetch outcome. Source: data/rtt-coverage.json,
// written by scripts/fetch-direct-reachable.mjs. Stations absent from the
// map have never been fetched (treated as "Coming soon").
export type RttCoverage = Record<string, "ready" | "ghost">

// First letter of a synthetic ID encodes the source network — see the
// `networkPrefix()` mapping in station-registry.ts. We mirror that mapping
// here to convert a non-NR station's ID into its UI label.
function nonNrLabel(syntheticId: string): EligibilityLabel {
  switch (syntheticId[0]) {
    case "U":  // London Underground
    case "O":  // London Overground
    case "D":  // Docklands Light Railway
    case "E":  // Elizabeth line standalone
      return "TfL station — no data"
    case "M": return "Metro station — no data"     // Tyne & Wear Metro
    case "G": return "Subway station — no data"    // Glasgow Subway
    case "N": return "NIR station — no data"       // Northern Ireland Railways
    default:  return "Heritage station — no data"  // Z prefix — heritage / unknown
  }
}

// Sort rank for ineligible search results. Lower = surfaced first.
// Eligible rows are rank 0 (handled by the picker upstream); ineligibles
// get bucketed so the user sees the "most likely to become eligible"
// items first ("Coming soon" pending RTT fetch) and the network-only
// fallbacks ("TfL station — no data" etc.) last.
export function ineligibilityRank(label: EligibilityLabel): number {
  switch (label) {
    case "Coming soon":               return 1
    case "Ghost station":             return 2
    case "Heritage station — no data": return 3
    default:                          return 4  // TfL / Metro / Subway / NIR
  }
}

// Per-station eligibility. Cluster anchors are not handled here — they
// route through getClusterStatus(), which delegates to the members.
export function getStationStatus(
  station: StationRecord | undefined,
  coverage: RttCoverage,
): OriginStatus {
  // Defensive default — the picker iterates the registry so a missing
  // entry shouldn't happen, but if it does, treat as "Coming soon".
  if (!station) return { eligible: false, label: "Coming soon" }

  // Non-NR stations (synthetic IDs that aren't cluster anchors) will
  // never appear in RTT data — surface their network label instead.
  if (station.isSynthetic && !station.isClusterAnchor) {
    return { eligible: false, label: nonNrLabel(station.id) }
  }

  // Real NR station — RTT coverage decides.
  const status = coverage[station.id]
  if (status === "ready") return { eligible: true }
  if (status === "ghost") return { eligible: false, label: "Ghost station" }
  return { eligible: false, label: "Coming soon" }
}

// Cluster eligibility — eligible iff at least one member is eligible.
// When ineligible, picks a "most hopeful" label so the cluster doesn't
// claim "TfL only" while it has NR members still awaiting fetch:
//   Coming soon  > Ghost station > network-only
export function getClusterStatus(
  memberIds: readonly string[],
  lookup: (id: string) => StationRecord | undefined,
  coverage: RttCoverage,
): OriginStatus {
  const memberStatuses = memberIds.map((id) =>
    getStationStatus(lookup(id), coverage),
  )
  if (memberStatuses.some((s) => s.eligible)) return { eligible: true }

  // All members ineligible — pick a representative label by priority.
  // Reasoning: a cluster with a Coming-soon member might become eligible
  // once that member's RTT data lands; saying "TfL station — no data"
  // would mislead.
  const labels = memberStatuses
    .map((s) => (s.eligible ? null : s.label))
    .filter((l): l is EligibilityLabel => l != null)
  if (labels.includes("Coming soon")) return { eligible: false, label: "Coming soon" }
  if (labels.includes("Ghost station")) return { eligible: false, label: "Ghost station" }
  return { eligible: false, label: labels[0] ?? "Coming soon" }
}
