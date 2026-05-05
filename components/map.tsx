"use client"

import { useCallback, useEffect, useMemo, useRef, useState, useTransition } from "react"
import { useTheme } from "next-themes"
import Map, { Layer, MapMouseEvent, MapRef, Source } from "react-map-gl/mapbox"
import "mapbox-gl/dist/mapbox-gl.css"
import FilterPanel from "@/components/filter-panel"
import { WelcomeBanner, type WelcomeBannerHandle } from "@/components/welcome-banner"
import { LogoSpinner } from "@/components/logo-spinner"
import { HelpButton } from "@/components/help-button"
import { RTTStatusPanel } from "@/components/rtt-status-panel"
import StationModal, { type FlickrPhoto, type JourneyInfo } from "@/components/photo-overlay"
import { MAX_GALLERY_PHOTOS } from "@/lib/flickr"
// Synthetic-cluster topology — declared in a shared module so build
// scripts and API routes can use the same definitions. The synthetic
// "displayName / canonicalName" fields stay in PRIMARY_ORIGINS /
// FRIEND_ORIGINS below (they're UI strings only the map cares about).
import {
  PRIMARY_ORIGIN_CLUSTER,
  FRIEND_ORIGIN_CLUSTER,
  ALL_CLUSTERS,
  ALL_CLUSTER_MEMBER_IDS,
  MEMBER_TO_SYNTHETIC,
  ALL_SYNTHETIC_IDS,
  SYNTHETIC_COORDS,
  SYNTHETIC_DISPLAY_NAMES,
  CENTRAL_LONDON_ANCHOR,
  pickTopRankedIndex,
  type RankableJourney,
} from "@/lib/clusters"
import { resolveCoordKey, resolveName as registryResolveName, getCoordKey as registryGetCoordKey, getName as registryGetName, getStation } from "@/lib/station-registry"
import { getOriginDisplay } from "@/lib/origin-display"
import { getStationStatus, getClusterStatus, ineligibilityRank, type RttCoverage } from "@/lib/origin-eligibility"
import rttCoverageData from "@/data/rtt-coverage.json"
import buriedStationsList from "@/data/buried-stations.json"
const RTT_COVERAGE = rttCoverageData as RttCoverage
// Stations that are TECHNICALLY a London NR station (so they match the
// searchableStations criteria) but produce no useful data when picked as
// a home station — because they have no RTT-reachable hub in any of our
// origin-routes.json primaries. Currently: Kensington (Olympia), whose NR
// service is sparse and event-driven. Coord-keyed, same shape as
// data/buried-stations.json.
import excludedPrimariesList from "@/data/excluded-primaries.json"
// origin-routes.json is keyed by station ID on disk (Phase 2a) and
// every consumer in this file iterates / looks up by ID post Phase 3c.
import { originRoutesById as originRoutesData } from "@/lib/origin-routes"
import londonTerminalsData from "@/data/london-terminals.json"
import terminalMatrixData from "@/data/terminal-matrix.json"
// Parallel hop matrix: non-terminal primaries (CLJ, future ECR/FPK/etc.)
// → each of the 15 London termini, fetched from TfL Journey Planner via
// scripts/fetch-tfl-hops.mjs. Merged into the live matrix at module load
// so stitchJourney can resolve "primary → terminal" hops the same way it
// resolves "terminal → terminal" hops today. Lives in a separate file
// from terminal-matrix.json to keep provenance clean (terminal-matrix is
// hand-curated + TfL-fetched; this is purely TfL-fetched per primary).
import tflHopMatrixData from "@/data/tfl-hop-matrix.json"
// Admin-only region labels — counties, national parks, AONBs (National Landscapes).
// Each entry is { name, category, coord:[lng,lat] }. Hand-edit `coord` to nudge
// a label to a better position. The list is converted to a Mapbox FeatureCollection
// in a useMemo below; only mounted when admin mode is active.
import regionLabelsData from "@/data/region-labels.json"
// CRS codes accepted within the TfL Oyster / contactless PAYG zone.
// Combined at runtime with a "Z-prefix → Oyster" rule (Underground / DLR
// / Elizabeth line tagged with Z* in OSM). Used by the admin Feature
// dropdown's "Oyster" option to surface only TfL-fare-area stations.
import oysterStationsData from "@/data/oyster-stations.json"
import { cn } from "@/lib/utils"
import { getColors } from "@/lib/tokens"
import { usePersistedState } from "@/lib/use-persisted-state"
import { getEffectiveJourney } from "@/lib/effective-journey"
import { stitchJourney, matchTerminal, type Terminal, type TerminalMatrix } from "@/lib/stitch-journey"
import { interchangeBufferFor } from "@/lib/interchange-buffers"
import { composePolylineForJourney, isHighQualityComposition } from "@/lib/journey-composer"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import { outbox } from "@/lib/admin-outbox"
import { AdminEditsDialog } from "@/components/admin-edits-dialog"

// Station rating — purely derived from the ratings of walks attached to
// the station (see /api/dev/walk-ratings). Numeric so the code can sort
// and compare directly. UI-side labels (Sublime / Charming / …) live in
// filter-panel.tsx — code never references them by word.
type Rating = 1 | 2 | 3 | 4

// Calendar order — index matches Date#getMonth() (0 = Jan, 11 = Dec).
// Used both as the canonical month-code list and to map the current
// month index to its 3-letter code for the "Best in {month}" public
// checkbox + admin month dropdown.
const MONTH_CODES = [
  "jan", "feb", "mar", "apr", "may", "jun",
  "jul", "aug", "sep", "oct", "nov", "dec",
] as const
type MonthCode = (typeof MONTH_CODES)[number]
// Display labels for the "Best in {month}" checkbox — full name reads
// more naturally in a sentence than a 3-letter abbreviation.
const MONTH_LABELS: Record<MonthCode, string> = {
  jan: "January", feb: "February", mar: "March", apr: "April",
  may: "May", jun: "June", jul: "July", aug: "August",
  sep: "September", oct: "October", nov: "November", dec: "December",
}
function currentMonth(): MonthCode {
  return MONTH_CODES[new Date().getMonth()]
}

// Only the fields the popup needs — simpler than the old sidebar type
type SelectedStation = {
  name: string
  lng: number
  lat: number
  minutes: number
  // "lng,lat" string — kept for places that still index by it (rating
  // map, stationNotes, etc. all coord-keyed at rest).
  coordKey: string
  // Canonical station ID (CRS or 4-char synthetic). Compare against
  // primaryOrigin / friendOrigin via this field — both are IDs post
  // Phase 3c.
  id: string
  flickrCount: number | null
  // Screen-space pixel position of the icon at click time — used to animate
  // the modal growing from / shrinking to this point
  screenX: number
  screenY: number
  journeys?: Record<string, JourneyInfo>
}

// Computes center + zoom so the bounding box [west,south]–[east,north] fits
// the viewport, with Eastbourne (~50.77°N) landing ~150px above the bottom.
// Doing this as pure math avoids calling fitBounds() at runtime, which
// react-map-gl's internal state manager can silently override.
function computeInitialView() {
  if (typeof window === 'undefined') {
    // SSR fallback — no window dimensions available.
    return { longitude: -0.118, latitude: 51.509, zoom: 6.1 }
  }

  const W = window.innerWidth
  const H = window.innerHeight
  const isMobile = W < 640
  // Less bottom padding on mobile — no filter panel at the bottom to clear
  const bottomPad = isMobile ? 50 : 150

  // Geographic region to frame (same bounds used by the mobile fitBounds)
  const west = -3.6, east = 2.0, south = 50.77, north = 52.8

  // --- Web Mercator helpers (Mapbox uses 512 px tiles) ---
  // Convert latitude to Mercator Y in "world units" (0–1 range)
  const latToY = (lat: number) =>
    (1 - Math.log(Math.tan(Math.PI / 4 + (lat * Math.PI) / 360)) / Math.PI) / 2

  const ySouth = latToY(south)
  const yNorth = latToY(north)
  const mercH = Math.abs(ySouth - yNorth) // height in 0–1 Mercator units

  // Zoom that fits the longitude span in W pixels
  const zoomX = Math.log2((W * 360) / (512 * (east - west)))
  // Zoom that fits the latitude span in (H − bottomPad) pixels
  const zoomY = Math.log2((H - bottomPad) / (512 * mercH))
  // Desktop: use the tighter constraint so nothing overflows.
  // Mobile (<640px): only use zoomY (height-based) — the wide bounding box
  // would force a very low zoom on narrow screens, pushing Eastbourne
  // too far from the bottom. Letting width overflow is fine; users can pan.
  const zoom = isMobile ? zoomY : Math.min(zoomX, zoomY)

  // On mobile, center on London longitude instead of the full bounding box
  // midpoint (which sits too far west when the map is zoomed in).
  const centerLon = isMobile ? -0.118 : (west + east) / 2

  // Place the southern bound at exactly bottomPad px above the viewport bottom.
  // In pixel space: south should sit at y = H − bottomPad (from top).
  // Pixel offset from center: H/2 − bottomPad  (positive = below center).
  // Convert that offset to Mercator units, then to latitude.
  const scale = 512 * Math.pow(2, zoom) // pixels per full Mercator width
  const offsetY = (H / 2 - bottomPad) / scale // in 0–1 Mercator units
  const yCenterMerc = ySouth - offsetY // move center north of south bound
  // Inverse Mercator Y → latitude
  const centerLat =
    (Math.atan(Math.sinh(Math.PI * (1 - 2 * yCenterMerc))) * 180) / Math.PI

  return { longitude: centerLon, latitude: centerLat, zoom }
}
const INITIAL_VIEW = computeInitialView()

// Decodes a Google Maps encoded polyline into an array of [lng, lat] pairs.
// Algorithm: https://developers.google.com/maps/documentation/utilities/polylinealgorithm
function decodePolyline(encoded: string): [number, number][] {
  const coords: [number, number][] = []
  let i = 0, lat = 0, lng = 0
  while (i < encoded.length) {
    // Each coordinate component is a variable-length sequence of 5-bit chunks
    for (const apply of [(v: number) => { lat += v }, (v: number) => { lng += v }]) {
      let shift = 0, result = 0, byte: number
      do {
        byte = encoded.charCodeAt(i++) - 63
        result |= (byte & 0x1f) << shift
        shift += 5
      } while (byte >= 0x20)
      // Zig-zag decode: if the lowest bit is 1, the value is negative
      apply(result & 1 ? ~(result >> 1) : result >> 1)
    }
    coords.push([lng / 1e5, lat / 1e5])
  }
  return coords
}

/**
 * Normalise a London-terminus OSM raw name for map labels + modal titles.
 *
 *   "London King's Cross"                    → "Kings Cross"
 *   "London St. Pancras International"       → "St Pancras"
 *   "London Liverpool Street"                → "Liverpool Street"
 *   "London Waterloo East"                   → "Waterloo East"
 *   "Mortimer"                               → "Mortimer"
 *
 * Primary path is `matchTerminal`, which resolves aliases via
 * london-terminals.json. Final fallback strips "London " prefix —
 * catches other cluster-satellite raw names that aren't in the
 * terminals file at all.
 */
function cleanTerminusLabel(rawName: string | undefined): string {
  if (!rawName) return ""
  const canonical = matchTerminal(rawName, londonTerminalsData as Terminal[])
  if (canonical) return canonical
  return rawName.replace(/^London\s+/i, "")
}

/**
 * Trim a sibling's full Google polyline to match an RTT-winning route.
 *
 * The situation: for a synthetic primary (the London cluster), the RTT data
 * picks some winner (e.g. Charing Cross for Swanley), and we want to draw a
 * real-track polyline from that winner to the destination. Our own journey
 * has only straight-line CRS coords, but a cluster SIBLING that was Google-
 * fetched (e.g. Kings Cross via Thameslink) has a curvy polyline that
 * eventually joins the same track (at London Bridge for Swanley).
 *
 * Walk down the RTT CRS chain and find the first station whose coord lies on
 * the sibling polyline (within `tolSq` squared-degrees). Call that the JOIN
 * POINT — both routes share track from there onwards. Return:
 *   [RTT-winner origin → earlier RTT calling points → join point]
 *   concatenated with
 *   [sibling polyline from join point to destination]
 *
 * For London-cluster → Swanley: prefix = [CHX, WAE], suffix = sibling's
 * Thameslink polyline from London Bridge onwards. Result draws CHX and WAE
 * with short straight lines, then real track from LBG to Swanley.
 *
 * Returns null when no join point is found (routes don't share any track the
 * polyline covers). Caller falls back to straight-line CRS coords.
 */
function trimSiblingPolylineToRttRoute(
  siblingDecoded: [number, number][],
  rttCrsChain: string[],
  crsToCoord: Record<string, [number, number]>,
  tolSq: number = 5e-5,  // ~700m at London latitude
): [number, number][] | null {
  if (siblingDecoded.length < 2 || rttCrsChain.length === 0) return null
  for (let i = 0; i < rttCrsChain.length; i++) {
    const stationCoord = crsToCoord[rttCrsChain[i]]
    if (!stationCoord) continue
    const [clng, clat] = stationCoord
    let bestJ = -1
    let bestDist = Infinity
    for (let j = 0; j < siblingDecoded.length; j++) {
      const [slng, slat] = siblingDecoded[j]
      const d = (slng - clng) ** 2 + (slat - clat) ** 2
      if (d < bestDist) {
        bestDist = d
        bestJ = j
      }
    }
    if (bestJ >= 0 && bestDist < tolSq) {
      // Prepend coords for the RTT CRS chain up to (not including) the join
      // CRS — these are short straight lines for the portion of the route
      // the sibling polyline doesn't cover. The join station itself is the
      // first vertex of the sibling suffix, so skipping it here avoids a
      // duplicate coord.
      const prefix: [number, number][] = []
      for (let k = 0; k < i; k++) {
        const earlier = crsToCoord[rttCrsChain[k]]
        if (earlier) prefix.push(earlier)
      }
      return [...prefix, ...siblingDecoded.slice(bestJ)]
    }
  }
  return null
}

// Mapbox GL expression that formats a minutes property as "Xh Ym" or "Xm".
// Reused across full-labels, hover-labels, and dual-origin labels.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function timeExpression(prop: string): any {
  const mins = ["coalesce", ["get", prop], 0]
  return ["case",
    [">=", mins, 60],
    ["concat",
      ["to-string", ["floor", ["/", mins, 60]]], "h",
      ["case",
        [">", ["%", mins, 60], 0],
        ["concat", " ", ["to-string", ["%", mins, 60]], "m"],
        ""
      ]
    ],
    ["concat", ["to-string", mins], "m"]
  ]
}

// HUB_PRIMARY_IDS is the historical curated PRIMARY_ORIGINS keyset —
// the Central London cluster anchor (CLON), Stratford cluster anchor
// (CSTR), and the 11 single-station London terminals. Used internally
// by routing logic to gate the "via direct hub" composition path:
// primaries IN this set have full coverage via stitching or pre-fetched
// journey files; primaries OUTSIDE need composition as a fallback. Not
// used for picker UI or eligibility — under the new origin-architecture
// model, ANY station/cluster with sufficient RTT data is pickable.
//
// CLON members and CSTR members live in lib/clusters-data.json. The 11
// terminals' display overrides (e.g. "Charing X" mobile shorthand) live
// on their entries in public/stations.json.
//
// Farringdon and Stratford as STATIONS are deliberately absent — they're
// non-termini that happen to have full per-station Google Routes data
// (because they're our stitcher sources), but from a user's point of view
// they deserve no special treatment. Search via the picker puts them in
// recents like any other custom pick.
const HUB_PRIMARY_IDS: ReadonlySet<string> = new Set([
  "CLON", "CSTR",
  "CHX", "MYB", "PAD", "VIC", "WAT",
  "MOG", "LST", "CST", "FST", "BFR", "LBG",
])


// Group layout for the filter-panel dropdown. string[][] is kept so filter-
// panel's grouped-rendering API still works; each inner array renders as one
// alphabetically-sorted block, with a horizontal rule between groups.
// Group order:
//   1. Synthetic primaries (e.g. the "Any London terminus" cluster) — these
//      represent a place, not a single station, so they head the list and
//      are visually separated from the single-station options below.
//   2. Public single-station primaries (Charing Cross, Kings Cross, …).
//   3. Admin-only primaries (hidden from non-admin users).
// Central London is the canonical default primary and must always sort to
// the top of any synthetic-primary list it appears in — even if a future
// synthetic (e.g. "Birmingham") would otherwise alphabetise before it.
const CENTRAL_LONDON_COORD = "CLON"
const byDisplayName = (a: string, b: string) => {
  if (a === CENTRAL_LONDON_COORD) return -1
  if (b === CENTRAL_LONDON_COORD) return 1
  return (getOriginDisplay(a)?.displayName ?? a).localeCompare(getOriginDisplay(b)?.displayName ?? b)
}
// Pinned primary IDs — always shown at the top of the primary
// dropdown, never evicted. CLON's "Central London" cluster lives here:
// it's the canonical default and is what every fresh user sees first.
const PINNED_PRIMARIES: string[] = [CENTRAL_LONDON_COORD]
// Pinned friend IDs — same idea on the friend side. Currently empty;
// reserved for future always-visible picks.
const PINNED_FRIENDS: string[] = []
// Seeded primary recents — pre-populated as if the user had already
// picked each one. Merged at render time below: PINNED first, then
// any user picks the user has actually made (top), then these defaults
// (filling out the rest). Picked for major-interchange status,
// geographic spread, and population catchment.
const DEFAULT_RECENT_PRIMARIES: string[] = [
  "CLJ",   // Clapham Junction
  "WIJ",   // Willesden Junction
  "NWD",   // Norwood Junction
  "FPK",   // Finsbury Park
  "TOM",   // Tottenham Hale
  "EAL",   // Ealing Broadway
  "FOG",   // Forest Gate
  "ECR",   // East Croydon
  "DFD",   // Dartford
  "ORP",   // Orpington
  "RMD",   // Richmond
  "WFJ",   // Watford Junction
  "SAC",   // St Albans City
  "RMF",   // Romford
  "HAY",   // Hayes and Harlington
  "ZFD",   // Farringdon
]

// Cluster-member topology lives in lib/clusters.ts so build scripts and
// API routes can use it too. Per-station display overrides (e.g. "Charing X"
// shorthand for CHX) live on the GeoJSON feature properties in
// public/stations.json and are picked up by the station registry.

// Farringdon coord / CRS — used by the City cluster's Thameslink-Farringdon
// preference: when any other cluster member would have been the RTT winner
// but is on the same Thameslink through-service as Farringdon, override back
// to Farringdon as the departure point.
const FARRINGDON_COORD = "ZFD"
const FARRINGDON_CRS = "ZFD"

// Display-name overrides for Central London cluster members whose OSM
// `properties.name` carries the "London " prefix (and/or an unwanted
// "International" suffix). Without these overrides:
//   • "London King's Cross" — picked as primary, square label reads
//     "London King's Cross"; as a destination from another terminus it
//     also reads "London King's Cross". Inconsistent with the cluster
//     diamond label ("Kings Cross") shown when the synthetic London
//     primary is active.
//   • Two St Pancras coords (main concourse + HS1 concourse) have OSM
//     names "London St. Pancras International" and "St Pancras
//     International" — also surface in the long form.
// Stamped onto baseStations features at fetch time so every consumer
// (search dropdown, primary square, regular destination label,
// coordToName, recents lookup) reads the cleaner short form.
const TERMINUS_DISPLAY_OVERRIDES: Record<string, string> = {
  "KGX": "Kings Cross",       // KGX National Rail
  "STP": "St Pancras",        // STP main concourse
  "SPL": "St Pancras",        // STP HS1 concourse
}

// Same-station alias coords inside the Central London cluster — both
// resolve to a single canonical primary on selection. The HS1 St Pancras
// concourse is ~80m from the main concourse, has no origin-routes data
// of its own, and shares timetabled service patterns with main; picking
// it should land on the main coord. Without this, the HS1 row would be
// pickable as a primary with no data, and the search dropdown would show
// two "St Pancras" rows side by side (filter-panel.tsx dedupes by
// primaryCoord, so both rows must share the same primaryCoord to fold).
const TERMINUS_COORD_ALIASES: Record<string, string> = {
  "SPL": "STP",
}

// Compute the set of coord keys that "belong" to a given primary — the primary
// itself plus any cluster members. Used by the modal-render site to decide
// whether a station click should use the simplified origin-style overlay.
// Passed-in helper so the check is ACTIVE-primary-scoped: with only one
// clustered primary (London) today, we don't want clicks on cluster members
// to trigger the simplified overlay when a DIFFERENT primary is active.
function getActivePrimaryCoords(primaryOrigin: string): string[] {
  return [primaryOrigin, ...(PRIMARY_ORIGIN_CLUSTER[primaryOrigin] ?? [])]
}

// Feature flag — controls what happens when the user clicks a primary station
// on the map. The two options, both of which are known-good behaviours:
//   "modal"  → opens the photo modal with the same simplified view as friend
//              stations (title + photos only; no journey text, no Hike button;
//              uses the origin-tuned Flickr search). CURRENT DEFAULT.
//   "banner" → opens the welcome banner (the rotating info popup that also
//              appears when the user clicks the London hexagon).
// To revert to the banner behaviour, flip this constant to "banner". Both
// code paths still exist below — the banner path is the same one the
// hexagon uses, so there's no dead code to clean up on either side.
const PRIMARY_CLICK_BEHAVIOUR: "modal" | "banner" = "modal"

// Default friend ID stamped when the user clicks "add a friend" without
// specifying one — Birmingham (CBIR) historically came first in the friend
// list so it's the no-thought default. The journey-file slug for every
// friend now lives on the station registry (`journeySlug` field on
// StationRecord, sourced from public/stations.json + lib/clusters-data.json).
const DEFAULT_FRIEND_ID = "CBIR"

// Seeded friend recents — same pattern as DEFAULT_RECENT_PRIMARIES
// above, picked for population catchment + geographic spread.
const DEFAULT_RECENT_FRIENDS: string[] = [
  "CBIR",   // Birmingham (BHM·BMO·BSW cluster)
  "RDG",    // Reading
  "BTN",    // Brighton
  "LEI",    // Leicester
  "CMAN",   // Manchester (MAN·MCV·MCO cluster)
  "COV",    // Coventry
  "BRI",    // Bristol (Temple Meads only — not a cluster)
  "NOT",    // Nottingham
  "LDS",    // Leeds
  "SOU",    // Southampton (Central only — not a cluster)
  "CCAR",   // Cardiff (CDF·CDQ cluster, centroid anchor)
  "CLIV",   // Liverpool (LIV·LVC·LVJ cluster, centroid anchor)
  "SHF",    // Sheffield
  "OXF",    // Oxford
  "CPOR",   // Portsmouth (PMS·PMH cluster, centroid anchor)
  "CBG",    // Cambridge
  "MKC",    // Milton Keynes
  "CGLA",   // Glasgow (GLC·GLQ cluster, centroid anchor)
  "DBY",    // Derby
  "CEDI",   // Edinburgh (EDB·HYM cluster, centroid anchor)
]

// Resolve the effective journey from a friend origin to a destination,
// falling back to cluster members when the friend is a SYNTHETIC anchor
// (e.g. Birmingham) — synthetic anchors aren't in origin-routes.json, so
// reading journeys[anchorCoord] always returns undefined. Picks the
// quickest cluster-member journey for the destination, since "fastest
// from any of {BHM, BMO, BSW}" matches what a real friend in Birmingham
// would actually do.
function getFriendJourney(
  journeys: Record<string, { durationMinutes?: number; changes?: number }> | undefined,
  friendOrigin: string,
): { durationMinutes?: number; changes?: number } | undefined {
  if (!journeys) return undefined
  const direct = journeys[friendOrigin]
  if (direct) return direct
  if (!getOriginDisplay(friendOrigin)?.isCluster) return undefined
  const members = FRIEND_ORIGIN_CLUSTER[friendOrigin] ?? []
  let best: { durationMinutes?: number; changes?: number } | undefined
  for (const m of members) {
    const j = journeys[m]
    if (!j || j.durationMinutes == null) continue
    if (best == null || best.durationMinutes == null || j.durationMinutes < best.durationMinutes) {
      best = j
    }
  }
  return best
}

// Parse "-0.12,51.53" → { lng, lat }. Coord keys are longitude-first because
// that matches GeoJSON [lng, lat] ordering we use elsewhere.
function parseCoordKey(key: string): { lng: number; lat: number } {
  const [lng, lat] = key.split(",").map(Number)
  return { lng, lat }
}

// Legacy → ID migration for localStorage. If the stored value is an old
// name string (no comma), resolve it via the station registry's
// resolveName. Unknown values fall back to `fallback`. Comma-containing
// values are assumed to already be coord keys (an even older format —
// the caller's hydration effect handles those separately).
function migrateOriginKey(stored: string | null | undefined, fallback: string): string {
  if (!stored) return fallback
  if (stored.includes(",")) return stored
  return registryResolveName(stored) ?? fallback
}

// White outline thickness for station icons and dots — lower = thinner strokes
const STATION_STROKE_WIDTH = 1.0

// Hover radius circles — tweak these to change the on-hover walkable-area indicators
const INNER_RADIUS_KM = 7
const OUTER_RADIUS_KM = 14

// Direct-reachable data from RTT (scripts/fetch-direct-reachable.mjs) — keyed
// by origin coord key. For primaries whose journey data is RTT-sourced rather
// than Routes-sourced (currently: Charing Cross), this table supplies the per-
// destination minutes and calling-point sequence. Each inner key is a
// destination coord key.
type DirectReachable = {
  name: string
  crs: string
  minMinutes: number
  services: number
  fastestCallingPoints: string[]
  /**
   * Parallel to fastestCallingPoints (same length): arrival time in minutes
   * from the service's origin departure. Index 0 is always 0 (origin itself).
   * Entries may be null when the RTT response omitted an arrival timestamp
   * for a given stop (rare). Added in the Phase 4 schema extension to unlock
   * calling-point-as-hub routing: the app can compute "from X to any
   * intermediate C" or "from any intermediate C to D" using the same
   * service's timings. Older rows written before this extension lack the
   * field entirely — consumers must treat `undefined` as "no per-stop
   * timing available; fall back to whatever the old path does".
   */
  fastestCallingPointTimes?: Array<number | null>
  /**
   * Stations this service calls at BEFORE the origin, captured so a passenger
   * who lives further out (e.g. Kentish Town for a Farringdon-bound
   * Thameslink) can be told to board earlier on the same train. Recorded
   * per-destination because different destinations win via different services,
   * each with their own upstream. Empty array if we haven't backfilled this
   * primary yet — older rows missing the field are treated as empty.
   */
  upstreamCallingPoints?: {
    crs: string
    name: string
    coord: string
    /** Minutes before the origin's departure time (always positive). */
    minutesBeforeOrigin: number
  }[]
  /**
   * Per-service timings — parallel arrays, same length, sorted by
   * serviceDepMinutes ascending. Each index represents one observed service:
   *   serviceDepMinutes[i]       — departure at this origin, UK-local minutes
   *                                since midnight
   *   serviceDurationsMinutes[i] — that service's journey time to THIS
   *                                destination in minutes
   * Arrival at the destination is serviceDepMinutes[i] + serviceDurationsMinutes[i].
   * Populated by the V2 schema extension in fetch-direct-reachable.mjs.
   * Powers the Option 2 hybrid-splice: "find the latest service arriving
   * at interchange X by time T-buffer". Older entries written before the
   * V2 schema lack both fields — tryHybridSplice treats them as "no data,
   * skip splice for this primary/interchange pair".
   */
  serviceDepMinutes?: number[]
  serviceDurationsMinutes?: number[]
}
type OriginRoutes = Record<string, {
  name: string
  crs: string
  directReachable: Record<string, DirectReachable>
  generatedAt: string
}>
const originRoutes = originRoutesData as OriginRoutes

// Terminals list + terminal-to-terminal matrix — used by stitchJourney to
// synthesise "start at primary origin, tube to a terminal, take that terminal's
// existing Routes-API journey" estimates. RTT-based primaries (currently just
// Charing Cross) use this alongside their direct-reachable set so that
// destinations where the stitched route is faster than the direct one — e.g.
// Ramsgate via HS1 from St Pancras beats the direct SE mainline route from
// Charing Cross — get the better time.
const londonTerminals = londonTerminalsData as Terminal[]
// Merged matrix: terminal-matrix entries take precedence for terminal-keyed
// rows (the 15 termini), tfl-hop-matrix adds parallel rows for non-terminal
// primaries like Clapham Junction.
//
// The on-disk shape post Phase 2f is keyed by station ID (CRS or 4-char
// synthetic) at both the outer and inner level. Many runtime consumers
// (stitch-journey + the journey-composition paths in this file) still
// do `matrix[matchTerminal(name)]` lookups, so we translate the IDs back
// to names at load-time to keep that surface stable. Future work
// (Phase 3+) can swap consumers over to ID-based access and drop this
// translation.
function buildNameKeyedMatrix(): TerminalMatrix {
  const merged: Record<string, Record<string, unknown>> = {
    ...(tflHopMatrixData as Record<string, Record<string, unknown>>),
    ...(terminalMatrixData as Record<string, Record<string, unknown>>),
  }
  const out: Record<string, Record<string, unknown>> = {}
  // Consumers (tryComposeViaPrimaryHop, stitchJourney's matrix lookup,
  // hasFullDataAtCoord's tflHopNames check) all index by the CANONICAL
  // terminal name — "St Pancras", "Kings Cross", "Liverpool Street" —
  // matching londonTerminals.json. registryGetName returns the raw OSM
  // name ("London St. Pancras International") which doesn't collide
  // with the canonical form, so we run it through matchTerminal first.
  // For non-terminal stations matchTerminal returns null and we keep
  // the raw name (those rows aren't queried by the canonical-name
  // consumers anyway, but stay accessible by their OSM name).
  function canonical(id: string): string | undefined {
    const raw = registryGetName(id)
    if (!raw) return undefined
    return matchTerminal(raw, londonTerminalsData as Terminal[]) ?? raw
  }
  for (const [outerId, inner] of Object.entries(merged)) {
    const outerName = canonical(outerId)
    if (!outerName) continue   // unknown ID — drop the row
    const innerOut: Record<string, unknown> = {}
    for (const [innerId, hop] of Object.entries(inner)) {
      const innerName = canonical(innerId)
      if (innerName) innerOut[innerName] = hop
    }
    out[outerName] = innerOut
  }
  return out as TerminalMatrix
}
const terminalMatrix: TerminalMatrix = buildNameKeyedMatrix()

// ---------------------------------------------------------------------------
// Option 2 — hybrid splice
// ---------------------------------------------------------------------------
// Google Routes sometimes picks a SLOW first leg to align with an infrequent
// continuation service. Example: Paddington→Marlow, Google returns a 38-min
// P→Maidenhead stopping train so the 11:34 Maidenhead→Marlow branch connects
// tightly. RTT knows P→Maidenhead can be done in 22 min on the Elizabeth
// line / GWR express — so if ANY 22-min service arrives at Maidenhead at
// (11:34 − 3min buffer) or earlier, we can splice it in:
//
//   P -[RTT fastest]-> X [BUFFER] -[Google continuation]-> D
//
// Result: same arrival at D, later departure from P, shorter journey time.
// All using authoritative data (real RTT service + real Google continuation).
// No interpolation or guessing.
//
// Returns a modified JourneyInfo when a better splice exists, else null.
// Requires the V2 schema fields (serviceDepMinutes + serviceDurationsMinutes)
// on the primary's direct-reachable entry for the interchange. Older entries
// degrade gracefully (we just return null and the original journey stands).

// UK-local minutes of day (00:00 = 0, 23:59 = 1439) for a given epoch ms.
// Intl handles BST/GMT transitions — Saturday-morning splices across the
// March DST change resolve correctly without hardcoding offsets.
const UK_TIME_FMT_CLIENT = new Intl.DateTimeFormat("en-GB", {
  timeZone: "Europe/London", hour: "2-digit", minute: "2-digit", hour12: false,
})
function msToUKMinutesOfDay(ms: number): number {
  const parts = UK_TIME_FMT_CLIENT.formatToParts(new Date(ms))
  const h = +(parts.find((p) => p.type === "hour")?.value ?? 0)
  const m = +(parts.find((p) => p.type === "minute")?.value ?? 0)
  return h * 60 + m
}

/**
 * Try to splice a faster RTT-direct first leg into a Google-sourced journey.
 *
 * Returns null when:
 *   - journey has no HEAVY_RAIL first leg (pure walk/subway journey)
 *   - the first HEAVY_RAIL leg isn't at leg 0 (pre-rail walk/subway exists —
 *     we'd need to shift those too, which is out-of-scope for MVP)
 *   - leg timestamps are missing (older Routes-API records pre-date the
 *     departureTime/arrivalTime field-mask)
 *   - primary has no origin-routes entry, OR the interchange station name
 *     doesn't match any entry in directReachable by exact name
 *   - the interchange entry lacks V2 schema arrays (pre-schema fetch)
 *   - no RTT service arrives at the interchange by (continuationDep − buffer)
 *   - the best candidate saves 0 or negative minutes vs original
 */
// Look up the origin-routes.json coord key for a station name, using
// matchTerminal to canonicalise ("London Paddington" → "Paddington")
// then scanning origin-routes for any entry that normalises to the same
// canonical. Returns null when no match — caller skips splice.
function findOriginRoutesCoord(stationName: string | undefined): string | null {
  if (!stationName) return null
  const canonical = matchTerminal(stationName, londonTerminalsData as Terminal[])
  // Some origin-routes entries aren't in the terminals list (Maidenhead,
  // Lewes, etc. — fetched as interchange-hub origins). Exact-name match
  // is a decent fallback for those.
  const target = canonical ?? stationName.replace(/^London\s+/i, "").trim()
  for (const [coord, data] of Object.entries(originRoutes)) {
    if (!data?.name) continue
    const dataCanonical = matchTerminal(data.name, londonTerminalsData as Terminal[])
    if (dataCanonical === target || data.name === target) return coord
    if (data.name.replace(/^London\s+/i, "").trim() === target) return coord
  }
  return null
}

function tryHybridSplice(journey: JourneyInfo): JourneyInfo | null {
  const legs = journey.legs ?? []
  if (legs.length < 2) return null

  const firstRailIdx = legs.findIndex((l) => l.vehicleType === "HEAVY_RAIL")
  if (firstRailIdx < 0) return null
  if (firstRailIdx === legs.length - 1) return null
  const firstRail = legs[firstRailIdx]
  if (!firstRail.departureTime || !firstRail.arrivalTime) return null

  // Resolve the first-rail leg's dep station → origin-routes coord.
  // This (not the USER's primary) is the correct anchor for the splice
  // — we need the timetable of the station the train actually starts
  // from, regardless of how the user got there.
  const railOriginCoord = findOriginRoutesCoord(firstRail.departureStation)
  if (!railOriginCoord) return null
  const drMap = originRoutes[railOriginCoord]?.directReachable
  if (!drMap) return null

  // Find the interchange entry by name match against firstRail.arrivalStation.
  // For multi-leg trains (e.g. Kent lines), this is the arr station of the
  // FIRST rail leg — the point where the passenger changes to the next leg.
  const interchangeName = firstRail.arrivalStation
  let interchangeEntry: DirectReachable | null = null
  for (const entry of Object.values(drMap)) {
    if (entry.name === interchangeName) {
      interchangeEntry = entry
      break
    }
  }
  if (!interchangeEntry) return null

  const deps = interchangeEntry.serviceDepMinutes
  const durs = interchangeEntry.serviceDurationsMinutes
  if (!deps || !durs || deps.length === 0 || durs.length !== deps.length) return null

  const firstDepMs = new Date(firstRail.departureTime).getTime()
  const firstArrMs = new Date(firstRail.arrivalTime).getTime()
  const firstDurationMin = Math.round((firstArrMs - firstDepMs) / 60000)
  if (interchangeEntry.minMinutes >= firstDurationMin - 1) return null

  // Continuation leg's departure is the constraint.
  const nextLeg = legs[firstRailIdx + 1]
  if (!nextLeg?.departureTime) return null
  const nextDepMs = new Date(nextLeg.departureTime).getTime()
  const continuationDepMin = msToUKMinutesOfDay(nextDepMs)
  const originalDepMin = msToUKMinutesOfDay(firstDepMs)
  // Per-station interchange buffer at the change station — bigger
  // interchanges need more time than the default 3 min.
  const latestArrMin = continuationDepMin - interchangeBufferFor(interchangeName)

  // Pick the latest-arriving service with arr ≤ latestArrMin.
  let bestDepMin = -1
  let bestDurMin = -1
  let bestArrMin = -1
  for (let i = 0; i < deps.length; i++) {
    const arr = deps[i] + durs[i]
    if (arr > latestArrMin) continue
    if (arr > bestArrMin) {
      bestArrMin = arr
      bestDepMin = deps[i]
      bestDurMin = durs[i]
    }
  }
  if (bestArrMin < 0) return null

  const savedMin = bestDepMin - originalDepMin
  if (savedMin <= 0) return null

  // Rebuild legs:
  //   - Preceding non-rail legs (walk, tube transfer): SHIFT later by
  //     savedMin so they end just before the new rail departure. User
  //     effectively leaves home later to match the faster train.
  //   - First rail leg: replace with the new dep/arr + shorter duration.
  //   - Legs after the first rail: UNCHANGED (same continuation).
  //
  // Journey's durationMinutes shrinks by savedMin (same final arrival,
  // later effective start). This is the "Marlow 1h9m → 49m" fix the
  // user originally flagged.
  const shiftMs = savedMin * 60_000
  const newFirstDepMs = firstDepMs + shiftMs
  const newFirstArrMs = newFirstDepMs + bestDurMin * 60_000
  const newLegs = legs.map((leg, idx) => {
    if (idx < firstRailIdx) {
      // Shift walk/tube prefix forward. If the leg has no timestamps
      // (older record), leave it unchanged — user's experience is
      // still fine, the duration metric is what matters here.
      if (!leg.departureTime || !leg.arrivalTime) return leg
      return {
        ...leg,
        departureTime: new Date(new Date(leg.departureTime).getTime() + shiftMs).toISOString(),
        arrivalTime: new Date(new Date(leg.arrivalTime).getTime() + shiftMs).toISOString(),
      }
    }
    if (idx === firstRailIdx) {
      return {
        ...leg,
        departureTime: new Date(newFirstDepMs).toISOString(),
        arrivalTime: new Date(newFirstArrMs).toISOString(),
      }
    }
    return leg
  })

  return {
    ...journey,
    durationMinutes: journey.durationMinutes - savedMin,
    legs: newLegs,
  }
}

/**
 * Reroute / reschedule a multi-leg journey using RTT service-level data.
 *
 * Handles TWO classes of Google-journey weakness that Option 2 splice
 * (single-leg swap with the same interchange) cannot:
 *
 *   1. WRONG INTERCHANGE — Seaford via Brighton (109 min) when V2 data
 *      shows VIC → Lewes → Seaford is ~83 min.
 *   2. BAD SERVICE PAIRING — Marlow: Google picked PAD 11:48 (slow 38m
 *      stopper) → Maidenhead → Marlow 12:34 = 69 min. V2 data reveals
 *      an 11:08 Elizabeth-line PAD (22m) → 11:34 Maidenhead → Marlow
 *      pairing = 49 min, same final arrival cycle, just earlier.
 *
 * Algorithm: for every hub candidate in the primary's directReachable
 * set — INCLUDING the current interchange — pair V2 observations from
 * primary→hub and hub→finalDest using service-level scheduling. Pick
 * the combination that minimises journey duration (hub.arr − primary.dep)
 * with at least the hub's interchange buffer between legs (see
 * interchangeBufferFor). Return the rebuilt journey when it beats the
 * current one by ≥ 5 min.
 *
 * Uses actual (depMin, durMin) observation pairs so the result is a
 * REAL, CONNECTABLE pair of services, not a theoretical min-time sum.
 */
function tryRerouteViaAlternativeHub(journey: JourneyInfo): JourneyInfo | null {
  const legs = journey.legs ?? []
  if (legs.length < 2) return null
  // Indices of HEAVY_RAIL legs
  const railIdxs: number[] = []
  legs.forEach((l, i) => { if (l.vehicleType === "HEAVY_RAIL") railIdxs.push(i) })
  if (railIdxs.length < 2) return null
  const prevRailIdx = railIdxs[railIdxs.length - 2]
  const lastRailIdx = railIdxs[railIdxs.length - 1]
  if (lastRailIdx !== prevRailIdx + 1) return null
  const prevRail = legs[prevRailIdx]
  const lastRail = legs[lastRailIdx]
  if (!prevRail.departureTime || !prevRail.arrivalTime) return null
  if (!lastRail.departureTime || !lastRail.arrivalTime) return null

  const reroutableOriginName = prevRail.departureStation
  const reroutableOriginCoord = findOriginRoutesCoord(reroutableOriginName)
  if (!reroutableOriginCoord) return null
  const drMap = originRoutes[reroutableOriginCoord]?.directReachable
  if (!drMap) return null

  const finalDestName = lastRail.arrivalStation

  const prevRailDepMs = new Date(prevRail.departureTime).getTime()
  const lastRailArrMs = new Date(lastRail.arrivalTime).getTime()
  const currentTotalMin = Math.round((lastRailArrMs - prevRailDepMs) / 60_000)

  // Pick the latest service-pair (A→hub, hub→finalDest) that:
  //   - both have valid V2 observations
  //   - hub.dep ≥ A.arr + interchangeBufferFor(hub) (real connection)
  //   - minimises (hub.arr − A.dep) = journey duration
  // Returns null when no valid pair exists.
  function bestPairThroughHub(
    p2h: DirectReachable,
    h2f: DirectReachable,
    hubName: string,
  ): { totalMin: number; aDep: number; aDur: number; hDep: number; hDur: number } | null {
    const aDeps = p2h.serviceDepMinutes
    const aDurs = p2h.serviceDurationsMinutes
    const hDeps = h2f.serviceDepMinutes
    const hDurs = h2f.serviceDurationsMinutes
    if (!aDeps || !aDurs || !hDeps || !hDurs) return null
    if (aDeps.length === 0 || hDeps.length === 0) return null
    if (aDeps.length !== aDurs.length || hDeps.length !== hDurs.length) return null
    // Per-station interchange buffer at the hub — bigger interchanges
    // need more time than the default 3-min floor.
    const buffer = interchangeBufferFor(hubName)
    let best: { totalMin: number; aDep: number; aDur: number; hDep: number; hDur: number } | null = null
    for (let i = 0; i < hDeps.length; i++) {
      const hDep = hDeps[i]
      const hDur = hDurs[i]
      const latestAArr = hDep - buffer
      // Latest A-service arriving by latestAArr = maximises A.dep =
      // minimises journey duration for this fixed hub dep.
      let bestA: { dep: number; dur: number; arr: number } | null = null
      for (let j = 0; j < aDeps.length; j++) {
        const aArr = aDeps[j] + aDurs[j]
        if (aArr > latestAArr) continue
        if (!bestA || aDeps[j] > bestA.dep) {
          bestA = { dep: aDeps[j], dur: aDurs[j], arr: aArr }
        }
      }
      if (!bestA) continue
      const totalMin = hDep + hDur - bestA.dep
      if (!best || totalMin < best.totalMin) {
        best = { totalMin, aDep: bestA.dep, aDur: bestA.dur, hDep, hDur }
      }
    }
    return best
  }

  let best: {
    hubName: string
    pair: { totalMin: number; aDep: number; aDur: number; hDep: number; hDur: number }
  } | null = null

  for (const [hubCoord, p2hEntry] of Object.entries(drMap)) {
    const hubOrigin = originRoutes[hubCoord]
    if (!hubOrigin) continue
    let h2fEntry: DirectReachable | null = null
    for (const e of Object.values(hubOrigin.directReachable)) {
      if (e.name === finalDestName) { h2fEntry = e; break }
    }
    if (!h2fEntry) continue
    const pair = bestPairThroughHub(p2hEntry, h2fEntry, p2hEntry.name)
    if (!pair) continue
    if (!best || pair.totalMin < best.pair.totalMin) {
      best = { hubName: p2hEntry.name, pair }
    }
  }

  if (!best) return null
  if (best.pair.totalMin >= currentTotalMin - 5) return null

  // Rebuild rail legs. Anchor to the SAME calendar date as the original
  // prev-rail leg's departure so timestamps stay on the right Saturday.
  const anchorDate = new Date(prevRail.departureTime)
  const toIso = (minOfDay: number) => {
    const d = new Date(anchorDate)
    d.setUTCHours(0, 0, 0, 0)
    // Minutes-of-day are UK-local. Apply DST offset from the anchor's
    // own UK-time (BST = UTC+1, GMT = UTC+0). Simpler: construct the
    // date in UK local and format to ISO. Here we mirror the offset
    // implied by the anchor.
    const anchorUtcMin = anchorDate.getUTCHours() * 60 + anchorDate.getUTCMinutes()
    const anchorUkMin = ukMinutesOfDayFromIso(prevRail.departureTime!)
    const tzShiftMin = anchorUkMin - anchorUtcMin  // 60 in BST, 0 in GMT
    const utcMin = minOfDay - tzShiftMin
    d.setUTCMinutes(utcMin)
    return d.toISOString()
  }

  const aDep = best.pair.aDep
  const aArr = aDep + best.pair.aDur
  const hDep = best.pair.hDep
  const hArr = hDep + best.pair.hDur

  const newPrevLeg = {
    ...prevRail,
    arrivalStation: best.hubName,
    departureTime: toIso(aDep),
    arrivalTime: toIso(aArr),
  }
  const newLastLeg = {
    ...lastRail,
    departureStation: best.hubName,
    departureTime: toIso(hDep),
    arrivalTime: toIso(hArr),
  }

  // Shift any preceding non-rail legs so they still end just before the
  // new prev-rail dep — matching the old "user leaves home later"
  // behaviour from tryHybridSplice.
  const oldPrevDepMs = prevRailDepMs
  const newPrevDepMs = new Date(newPrevLeg.departureTime).getTime()
  const shiftMs = newPrevDepMs - oldPrevDepMs

  const newLegs = legs.map((leg, idx) => {
    if (idx === prevRailIdx) return newPrevLeg
    if (idx === lastRailIdx) return newLastLeg
    if (idx < prevRailIdx && leg.departureTime && leg.arrivalTime) {
      return {
        ...leg,
        departureTime: new Date(new Date(leg.departureTime).getTime() + shiftMs).toISOString(),
        arrivalTime: new Date(new Date(leg.arrivalTime).getTime() + shiftMs).toISOString(),
      }
    }
    return leg
  })

  const savedMin = Math.round(currentTotalMin - best.pair.totalMin)
  return {
    ...journey,
    durationMinutes: Math.max(1, journey.durationMinutes - savedMin),
    legs: newLegs,
  }
}

// Per-station interchange buffer is now provided by interchangeBufferFor()
// from lib/interchange-buffers.ts. The previous flat 5-min constant has
// been replaced inline at each compose site so the buffer reflects the
// actual interchange station (CLJ, Reading etc. get longer than the
// 3-min default). See data/station-interchange-buffers.json.

/**
 * Compose a custom-primary journey by hub-hopping to an ALTERNATIVE London
 * terminal and stitching from there. Motivation:
 *
 *   CLJ → Marlow via Google Routes picks Stratford + Liverpool Street
 *   (2h44m). The genuine fastest is via Victoria + Paddington (~72min).
 *   Neither tryHybridSplice nor tryRerouteViaAlternativeHub can change the
 *   FIRST London terminus the journey routes through — they only touch the
 *   interchange between rail legs. This helper fills that gap.
 *
 * Algorithm — for every (customHub H, london terminal T) pair, compose:
 *     X → H (RTT, H.pToCustomMins)
 *     + interchange + (if H≠T) matrix[H][T] hop + interchange
 *     + stitchJourney({newOrigin: T}).durationMinutes
 * and keep the best by (fewest changes, then shortest duration).
 *
 * stitchJourney pulls the T→D mainline from whichever pre-fetched source
 * journey on the feature contains a HEAVY_RAIL subsequence starting at T.
 * So PAD→Marlow becomes reachable via the Farringdon source journey (which
 * has [F→PAD, PAD→Maidenhead, Maidenhead→Marlow]).
 *
 * The stitched leg is additionally passed through tryHybridSplice and
 * tryRerouteViaAlternativeHub so service-level pairing improvements (the
 * ones that unlocked London→Marlow 49min) are applied here too.
 */
function tryComposeViaTerminal(
  feature: unknown,
  customHubs: Array<{ pCoord: string; pToCustomMins: number; routes: { name?: string } }>,
  customName: string,
  customCoord: string,
): { journey: JourneyInfo; mins: number; changes: number } | null {
  if (customHubs.length === 0) return null
  let best: { journey: JourneyInfo; mins: number; changes: number } | null = null

  for (const hub of customHubs) {
    const hubCanonical = matchTerminal(hub.routes.name, londonTerminals)
    if (!hubCanonical) continue
    const hubName = hub.routes.name ?? hubCanonical
    for (const T of londonTerminals) {
      let stitched = stitchJourney({
        feature: feature as Parameters<typeof stitchJourney>[0]["feature"],
        newOrigin: T,
        matrix: terminalMatrix,
        terminals: londonTerminals,
      })
      if (!stitched?.durationMinutes) continue
      // Apply the same splice + reroute improvements that curated primaries
      // get. Crucial for Marlow-style cases where Google's source journey
      // picked a slow PAD→Maidenhead service — reroute swaps it to the
      // optimal service-level pairing.
      const sp = tryHybridSplice(stitched as unknown as JourneyInfo)
      if (sp) stitched = sp as unknown as typeof stitched
      const rr = tryRerouteViaAlternativeHub(stitched as unknown as JourneyInfo)
      if (rr) stitched = rr as unknown as typeof stitched

      const stitchedMins = stitched.durationMinutes ?? 0
      const stitchedChanges = stitched.changes ?? 0

      let mins: number
      let changes: number
      let matrixLeg: JourneyInfo["legs"][number] | null = null

      if (T.name === hubCanonical) {
        // Interchange happens at the hub (where customer→rail change occurs).
        mins = hub.pToCustomMins + interchangeBufferFor(hubCanonical) + stitchedMins
        changes = 1 + stitchedChanges
      } else {
        const hop = terminalMatrix[hubCanonical]?.[T.name]
        if (!hop?.minutes) continue
        // Two interchanges: at the hub (X→hub→matrix hop) and at T (hop→rail).
        mins = hub.pToCustomMins + hop.minutes + interchangeBufferFor(hubCanonical) + interchangeBufferFor(T.name) + stitchedMins
        changes = 2 + stitchedChanges
        matrixLeg = {
          vehicleType: "OTHER",
          departureStation: hubName,
          arrivalStation: T.name,
        } as JourneyInfo["legs"][number]
      }

      const firstLeg = {
        vehicleType: "OTHER",
        departureStation: customName,
        arrivalStation: hubName,
      } as JourneyInfo["legs"][number]

      const legs = matrixLeg
        ? [firstLeg, matrixLeg, ...(stitched.legs ?? [])]
        : [firstLeg, ...(stitched.legs ?? [])]

      // Polyline assembly — prepend [home, hub] straight segment, append
      // the matrix hop polyline (decoded) when the hub→T hop exists, then
      // the stitched journey's own polylineCoords. Without this the hover
      // polyline for composed journeys showed nothing for routes like
      // CLJ→Marlow via Waterloo+Paddington.
      // hub.pCoord is a station ID post Phase 3c (origin-routes is
      // ID-keyed); resolve to a real coord before parsing into lng/lat.
      const { lng: cLng, lat: cLat } = parseCoordKey(customCoord)
      const hubCoord = registryGetCoordKey(hub.pCoord) ?? ""
      const { lng: hLng, lat: hLat } = parseCoordKey(hubCoord)
      let polylineCoords: [number, number][] = [[cLng, cLat], [hLng, hLat]]
      if (T.name !== hubCanonical) {
        const hop = terminalMatrix[hubCanonical]?.[T.name]
        if (hop?.polyline) {
          polylineCoords = [...polylineCoords, ...decodePolyline(hop.polyline)]
        } else {
          // No matrix polyline — fall back to a straight segment to T.
          polylineCoords.push([T.lng, T.lat])
        }
      }
      const stitchedCoords = (stitched as unknown as { polylineCoords?: [number, number][] }).polylineCoords
      if (stitchedCoords && stitchedCoords.length > 0) {
        polylineCoords = [...polylineCoords, ...stitchedCoords]
      }

      const candidate = {
        durationMinutes: mins,
        changes,
        legs,
        polylineCoords: polylineCoords.length > 1 ? polylineCoords : undefined,
      } as unknown as JourneyInfo

      if (best == null || changes < best.changes || (changes === best.changes && mins < best.mins)) {
        best = { journey: candidate, mins, changes }
      }
    }
  }
  return best
}

// Coord-keyed walking links between stations that share a physical
// concourse — distinct from terminal-matrix entries even when the same
// pair appears there. terminal-matrix is consumed by the standard
// stitcher (newOrigin: terminal name → matrix lookup); this map is
// consumed by tryComposeViaWalkingDoubleHub (4-leg RTT-only
// composition for non-terminal primaries like CLJ, which the standard
// stitcher can't help with when the destination has no pre-fetched
// source journey).
//
// Polylines are intentionally null so the map draws a straight line
// between the two station coords — good enough for a 150m pedestrian
// link. Each entry should appear symmetrically (both directions) so
// the composition loop doesn't need to care which side is the rail
// origin. Add new entries only for stations that are physically
// adjacent (sharing a concourse / footbridge); for actual tube/walk
// hops between separate stations, terminal-matrix is the right place.
const WALKING_HOPS: Record<string, Record<string, { minutes: number }>> = {
  // Waterloo ↔ Waterloo East — covered pedestrian link, ~5 min.
  // Unlocks CLJ→YAL class journeys: CLJ→WAT (rail) → walk → WAE →
  // Paddock Wood (rail) → Yalding (branch rail). Both sides are in
  // origin-routes.json (WAE has its own RTT-fetched entry).
  "WAT":   { "WAE": { minutes: 5 } },  // WAT → WAE
  "WAE":  { "WAT":  { minutes: 5 } },  // WAE → WAT
}

/**
 * Extension B — triple-hop "walking interchange" composition. Handles
 * journeys like CLJ → Yalding that route:
 *
 *   X → H1 (rail, H1 is a customHub terminus, RTT-observed)
 *     → walk via WALKING_HOPS to H2 (adjacent origin-routes station)
 *     → H3 (rail, H3 is reached directly from H2, origin-routes entry)
 *     → D (final rail, D is reached directly from H3)
 *
 * Example: CLJ → WAT → walk → WAE → Paddock Wood → Yalding.
 *
 * Returns the fastest four-leg composition or null if no combination
 * reaches D under the day-hike-range cap. The interchange buffer is
 * applied at each hand-off (including the walking one).
 */
function tryComposeViaWalkingDoubleHub(
  customHubs: Array<{ pCoord: string; pToCustomMins: number; routes: { name?: string; directReachable?: Record<string, DirectReachable> } }>,
  destCoordKey: string,
  customName: string,
  customCoord: string,
): { journey: JourneyInfo; mins: number; changes: number } | null {
  if (customHubs.length === 0) return null
  let best: { journey: JourneyInfo; mins: number; changes: number } | null = null

  for (const h1 of customHubs) {
    const walks = WALKING_HOPS[h1.pCoord]
    if (!walks) continue
    const h1Name = h1.routes.name ?? ""
    // Three interchange buffers, one per hand-off station:
    //   H1 (walk-pair start) → H2 (walk-pair end) → H3 (rail change) → D
    const bufH1 = interchangeBufferFor(h1Name)
    for (const [h2Coord, walk] of Object.entries(walks)) {
      const h2Routes = originRoutes[h2Coord]
      if (!h2Routes) continue
      const h2Name = h2Routes.name ?? ""
      const bufH2 = interchangeBufferFor(h2Name)
      // For every H3 in H2's directReachable that's ALSO a top-level
      // origin-routes entry, see if H3 reaches D directly. H3 being an
      // origin-routes entry is required so we can look up H3→D times.
      for (const [h3Coord, h2ToH3] of Object.entries(h2Routes.directReachable ?? {})) {
        if (!h2ToH3?.minMinutes) continue
        if (h3Coord === destCoordKey) continue  // double-hop handled elsewhere
        const h3Routes = originRoutes[h3Coord]
        if (!h3Routes) continue
        const h3ToD = h3Routes.directReachable?.[destCoordKey]
        if (!h3ToD?.minMinutes) continue
        const bufH3 = interchangeBufferFor(h3Routes.name)
        const total =
          h1.pToCustomMins +
          bufH1 + walk.minutes +
          bufH2 + h2ToH3.minMinutes +
          bufH3 + h3ToD.minMinutes
        if (best != null && total >= best.mins) continue
        const h3Name = h3Routes.name ?? ""
        // h1.pCoord / h2Coord / h3Coord / destCoordKey are station IDs
        // post Phase 3c (origin-routes + the dest arg is a feature id).
        // Resolve each to its real coord via the registry before
        // parseCoordKey, otherwise the polyline becomes NaN-laced and
        // the hover-line either vanishes or collapses to a straight
        // origin→dest segment.
        const { lng: cLng, lat: cLat } = parseCoordKey(customCoord)
        const { lng: h1Lng, lat: h1Lat } = parseCoordKey(registryGetCoordKey(h1.pCoord) ?? "")
        const { lng: h2Lng, lat: h2Lat } = parseCoordKey(registryGetCoordKey(h2Coord) ?? "")
        const { lng: h3Lng, lat: h3Lat } = parseCoordKey(registryGetCoordKey(h3Coord) ?? "")
        // Polyline: home → H1 → H2 (walking segment, straight line) +
        // H2→H3 calling-points + H3→D calling-points.
        // Polyline approximated as straight segments between the
        // known coords (home → H1 → H2 → H3 → D). The detailed
        // calling-points CRS→coord map lives inside the useMemo
        // scope, so producing a fully-resolved polyline here would
        // mean threading it through as an arg. Straight segments
        // are acceptable for this edge case — the user-visible
        // improvement (a hover-polyline at all rather than none) is
        // the main thing.
        const { lng: dLng, lat: dLat } = parseCoordKey(registryGetCoordKey(destCoordKey) ?? "")
        const polylineCoords: [number, number][] = [
          [cLng, cLat],
          [h1Lng, h1Lat],
          [h2Lng, h2Lat],
          [h3Lng, h3Lat],
          [dLng, dLat],
        ]
        const journey = {
          durationMinutes: total,
          // Two RAIL changes (at H3 to board final, at H2 to board H3
          // train). The walking hop is counted as part of the H1
          // transfer rather than as a separate change. Matches the
          // way Trainline surfaces "2 changes" for this class.
          changes: 2,
          legs: [
            { vehicleType: "OTHER", departureStation: customName, arrivalStation: h1Name },
            { vehicleType: "OTHER", departureStation: h1Name, arrivalStation: h2Name },
            {
              vehicleType: "HEAVY_RAIL",
              departureStation: h2Name,
              arrivalStation: h3Name,
              stopCount: Math.max(0, (h2ToH3.fastestCallingPoints?.length ?? 0) - 2),
            },
            {
              vehicleType: "HEAVY_RAIL",
              departureStation: h3Name,
              arrivalStation: h3ToD.name ?? "",
              stopCount: Math.max(0, (h3ToD.fastestCallingPoints?.length ?? 0) - 2),
            },
          ],
          polylineCoords,
        } as unknown as JourneyInfo
        best = { journey, mins: total, changes: 2 }
      }
    }
  }
  return best
}

// UK-local minutes-of-day from an ISO timestamp — mirrors the offset
// encoded in the ISO string (either "+01:00" BST or "Z"/"+00:00" GMT).
// Used by tryRerouteViaAlternativeHub to convert the V2 observation
// min-of-day values back to absolute UTC timestamps for new leg
// timestamps.
function ukMinutesOfDayFromIso(iso: string): number {
  // Google Routes gives us "Z" UTC. Treat it as UK local per the
  // fetch window: our data is Saturday-morning UK, which spans BST.
  // For dates within BST (Apr–Oct), UK = UTC+1. Outside, UK = UTC.
  const d = new Date(iso)
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Europe/London",
    hour: "2-digit", minute: "2-digit", hour12: false,
  }).formatToParts(d)
  const h = +(parts.find((p) => p.type === "hour")?.value ?? 0)
  const m = +(parts.find((p) => p.type === "minute")?.value ?? 0)
  return h * 60 + m
}

// Stations manually "buried" by an admin (right-click in admin mode).
// Entries are "lng,lat" coordKey strings. Buried stations behave normally
// at zoom 12+ but disappear at lower zooms when they're unrated and not
// part of the active primary/friend's cluster — useful for hiding inner-
// suburb stations that would otherwise crowd the map.
// Seeds state from data/buried-stations.json; admin toggle mutates it.
const INITIAL_BURIED_STATIONS = new Set<string>(buriedStationsList)

// Describes the shape of a single GeoJSON feature from our stations.json.
// TypeScript uses this to check we're accessing valid properties later.
type StationFeature = {
  type: "Feature"
  geometry: { type: "Point"; coordinates: [number, number] }
  properties: { name: string; [key: string]: unknown }
}

type StationCollection = {
  type: "FeatureCollection"
  features: StationFeature[]
}

// Holds the data we need for hover effects (radius circles + label override)
type HoveredStation = {
  // Geographic coordinates — used to draw the radius circle on the map
  lng: number
  lat: number
  // Unique key — used to filter the hover label layer to this station only
  coordKey: string
  // Which icon image to render on the pulsing hovered-station-icon overlay
  // layer. Resolved from the station's rating / isBuried at
  // hover-set time so the overlay matches the base station's visual.
  iconImage: string
}

// Maps a station feature's properties to the matching registered icon image
// name. Kept in sync with the `icon-image` expressions used in the base
// station-dots and station-rating-icons layers.
// Uses the same property-existence semantics as the Mapbox `["has", ...]`
// expressions in those layers (not strict truthiness) so excluded
// stations ALWAYS resolve to their special icon even if the flag lands as
// something weird (number, string) through the Mapbox source pipeline.
function resolveStationIconImage(props: Record<string, unknown> | undefined): string {
  if (!props) return "icon-unrated"
  const hasProp = (k: string) => {
    const v = props[k]
    return v !== undefined && v !== null && v !== false
  }
  // `isBuried` is admin metadata and doesn't change the icon — buried
  // stations render with whatever rating icon they'd otherwise have.
  // The London hexagon marker uses icon-london (also a square shape). It's
  // tapped often — the primary-selection hexagon sits on top of the map —
  // so if we resolve it as "icon-unrated" the pulse renders a circle
  // on top of the hexagon. Match the base layer's icon-image here too.
  if (hasProp("isLondon")) return "icon-london"
  // Terminus diamond features carry isTerminus — match their base-layer
  // icon so the hover pulse animates as a primary-colour diamond rather
  // than defaulting to the unrated circle.
  if (hasProp("isTerminus")) return "icon-london-terminus"
  // Active-friend features carry isFriendOrigin — mirror the static
  // station-rating-icons / friend-anchor-icon layers, both of which
  // draw the friend's square via icon-origin. Without this, the pulse
  // resolves to the underlying rating icon (hexagon, circle, …) and
  // the user sees the smaller pulse-shape sitting inside the static
  // square frame.
  if (hasProp("isFriendOrigin")) return "icon-origin"
  switch (props.rating) {
    case 4: return "icon-rating-4"
    case 3: return "icon-rating-3"
    case 2: return "icon-rating-2"
    case 1: return "icon-rating-1"
    default: return "icon-unrated"
  }
}

// Approximates a geographic circle as a closed polygon by stepping around the
// centre point at the given radius. 64 steps is smooth enough to look circular.
// Pure pixel-based Mapbox circles can't represent real-world distances — this can.
function createCircleGeoJSON(lng: number, lat: number, radiusKm: number, steps = 64) {
  const R = 6371 // Earth's radius in km
  const coords: [number, number][] = []

  for (let i = 0; i <= steps; i++) {
    const angle = (i / steps) * 2 * Math.PI
    // Angular distance in radians converted to degrees of latitude/longitude.
    // Longitude degrees shrink as you move away from the equator, so we divide
    // by cos(lat) to compensate — otherwise the circle would be an oval.
    const dLat = (radiusKm / R) * (180 / Math.PI) * Math.cos(angle)
    const dLng = (radiusKm / R) * (180 / Math.PI) * Math.sin(angle) / Math.cos((lat * Math.PI) / 180)
    coords.push([lng + dLng, lat + dLat])
  }

  return {
    type: "Feature" as const,
    geometry: { type: "Polygon" as const, coordinates: [coords] },
    properties: {},
  }
}


// Draws a rating icon onto a canvas and returns the pixel data Mapbox needs.
// Using canvas (rather than SVG files) means no extra assets to load.
// strokeColor switches between white (light mode) and black (dark mode) so
// the outline stays visible against the map background.
function createRatingIcon(shape: 'star' | 'triangle-up' | 'triangle-down' | 'circle' | 'square' | 'hexagon' | 'cross' | 'diamond', color: string, strokeColor: string, opts?: { crossLineWidth?: number }): ImageData {
  const size = 24
  const dpr = window.devicePixelRatio || 1 // 2 on Retina, 1 on standard displays
  const canvas = document.createElement('canvas')
  canvas.width = size * dpr   // physical pixels (e.g. 48 on Retina)
  canvas.height = size * dpr
  const ctx = canvas.getContext('2d')!
  ctx.scale(dpr, dpr) // scale drawing so existing coordinates (based on 24) still work

  if (shape === 'star') {
    // 5-pointed star — alternates between outer and inner radius points
    ctx.beginPath()
    const cx = 12, cy = 12, outerR = 10, innerR = 4.5
    for (let i = 0; i < 10; i++) {
      const r = i % 2 === 0 ? outerR : innerR
      // -π/2 rotates so the first point faces straight up
      const angle = (i * Math.PI) / 5 - Math.PI / 2
      const x = cx + r * Math.cos(angle)
      const y = cy + r * Math.sin(angle)
      i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y)
    }
    ctx.closePath()
    ctx.fillStyle = color
    ctx.fill()
    ctx.strokeStyle = strokeColor
    ctx.lineWidth = STATION_STROKE_WIDTH
    ctx.stroke()
  } else if (shape === 'circle') {
    // Filled circle — used for "not recommended" or similar neutral ratings
    ctx.beginPath()
    ctx.arc(12, 12, 7, 0, Math.PI * 2)
    ctx.fillStyle = color
    ctx.fill()
    ctx.strokeStyle = strokeColor
    ctx.lineWidth = STATION_STROKE_WIDTH
    ctx.stroke()
  } else if (shape === 'square') {
    // Filled square centred at (12, 12) — used for the London marker
    const side = 16
    const offset = (24 - side) / 2 // 4px from each edge
    ctx.beginPath()
    ctx.rect(offset, offset, side, side)
    ctx.fillStyle = color
    ctx.fill()
    ctx.strokeStyle = strokeColor
    ctx.lineWidth = STATION_STROKE_WIDTH
    ctx.stroke()
  } else if (shape === 'cross') {
    // Latin/grave cross — vertical is centred; horizontal sits in the upper third
    // (not the middle) so it reads as a Christian cross / headstone rather than a "+".
    // This is the intended semantic for excluded stations. The curated-excluded
    // variant passes a larger crossLineWidth so the cross reads as "important".
    ctx.strokeStyle = color
    ctx.lineWidth = opts?.crossLineWidth ?? 3
    ctx.lineCap = 'butt'
    const inset = 5 // distance from canvas edge
    const cx = 12
    const hBarY = 9 // horizontal arm's y — raised from centre (12) for the Latin cross look
    ctx.beginPath()
    // Horizontal arm — raised toward the top
    ctx.moveTo(inset, hBarY)
    ctx.lineTo(24 - inset, hBarY)
    // Vertical arm — full top-to-bottom
    ctx.moveTo(cx, inset)
    ctx.lineTo(cx, 24 - inset)
    ctx.stroke()
  } else if (shape === 'diamond') {
    // Square rotated 45° — four vertices at top, right, bottom, left
    // centres. Used for London-terminus markers. Radius of ~7 keeps it
    // visually matched to the other small rating icons (circle r=7).
    ctx.beginPath()
    const cx = 12, cy = 12, r = 7
    ctx.moveTo(cx, cy - r)  // top
    ctx.lineTo(cx + r, cy)  // right
    ctx.lineTo(cx, cy + r)  // bottom
    ctx.lineTo(cx - r, cy)  // left
    ctx.closePath()
    ctx.fillStyle = color
    ctx.fill()
    ctx.strokeStyle = strokeColor
    ctx.lineWidth = STATION_STROKE_WIDTH
    ctx.stroke()
  } else if (shape === 'hexagon') {
    // Regular hexagon — 6 vertices evenly spaced, flat top edge.
    // Radius tuned so the hexagon reads as visually balanced against
    // the other rating shapes (triangle, star, circle) — a touch
    // smaller than the natural bounding radius so its flat sides
    // don't overpower the sparser silhouettes.
    ctx.beginPath()
    const cx = 12, cy = 12, hexR = 5.22
    for (let i = 0; i < 6; i++) {
      // -π/6 rotates so the hexagon has a flat top edge (not a pointy top)
      const angle = (i * Math.PI) / 3 - Math.PI / 6
      const x = cx + hexR * Math.cos(angle)
      const y = cy + hexR * Math.sin(angle)
      i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y)
    }
    ctx.closePath()
    ctx.fillStyle = color
    ctx.fill()
    ctx.strokeStyle = strokeColor
    ctx.lineWidth = STATION_STROKE_WIDTH
    ctx.stroke()
  } else {
    // Equilateral triangle — up or down pointing
    // Height of equilateral triangle = side × √3/2; we fit it within the 24px canvas
    const side = 13
    const h = side * Math.sqrt(3) / 2 // ≈17.3
    const cx = 12
    ctx.beginPath()
    if (shape === 'triangle-up') {
      const top = (24 - h) / 2 // vertically centred
      ctx.moveTo(cx, top)                   // apex
      ctx.lineTo(cx + side / 2, top + h)    // bottom-right
      ctx.lineTo(cx - side / 2, top + h)    // bottom-left
    } else {
      const top = (24 - h) / 2
      ctx.moveTo(cx, top + h)               // apex (bottom)
      ctx.lineTo(cx + side / 2, top)        // top-right
      ctx.lineTo(cx - side / 2, top)        // top-left
    }
    ctx.closePath()
    ctx.fillStyle = color
    ctx.fill()
    ctx.strokeStyle = strokeColor
    ctx.lineWidth = STATION_STROKE_WIDTH
    ctx.stroke()
  }

  // getImageData returns raw RGBA pixel data — this is what map.addImage() accepts
  return ctx.getImageData(0, 0, size * dpr, size * dpr)
}

export default function HikeMap() {
  const { theme } = useTheme()
  // Persisted across visits via localStorage — see lib/use-persisted-state.ts.
  // Each filter setting lives under its own "ttg:*" key so adding/removing
  // fields later doesn't require migrations.
  // Primary origin is a "lng,lat" coord key. Default is the "London"
  // mega-cluster (synthetic coord at the British Museum) — gives new
  // users broad access to all 15 London termini without needing to
  // pick one manually.
  // Users with the old name string in localStorage get translated below via migrateOriginKey.
  const [primaryOrigin, setPrimaryOriginRaw] = usePersistedState(
    "ttg:primaryOrigin",
    "CLON",
  )
  // Phase 2: admin-mode-only list of custom-primary coord keys the user has
  // previously selected via the dropdown's search bar. Surfaces them as quick-
  // pick items beneath the main origin list so they can hop back easily.
  // Empty by default — Stratford used to be seeded here, but it's now its
  // own synthetic primary in the top group, so seeding it would make it
  // appear twice.
  const [recentCustomPrimaries, setRecentCustomPrimaries] = usePersistedState<string[]>(
    "ttg:recentCustomPrimaries",
    [],
  )
  // Mirror of recentCustomPrimaries on the friend side — IDs the user
  // has previously picked as a friend's home. No seeded defaults post
  // Phase 4 of the origin-architecture refactor.
  const [recentCustomFriends, setRecentCustomFriends] = usePersistedState<string[]>(
    "ttg:recentCustomFriends",
    [],
  )
  // One-shot localStorage migration. Three cases the stored value can be in:
  //   1. A canonical station ID (current shape) — leave alone.
  //   2. A legacy coordKey "lng,lat" (pre-Phase-3c) — forward-translate
  //      via resolveCoordKey. Phase 3a/3b wrote IDs to storage but
  //      readers translated them back to coords, so users who upgraded
  //      mid-flight can hold either form.
  //   3. A legacy canonical name (pre-Phase-2 era) — match against
  //      PRIMARY_ORIGINS by canonicalName via migrateOriginKey.
  // Anything that fails all three resets to "CLON" (Central London).
  // Custom-primary IDs from the search bar count as valid even when
  // they're not in PRIMARY_ORIGINS, recognised via recentCustomPrimaries.
  // useEffect (rather than useState lazy init) because usePersistedState
  // hydrates from localStorage asynchronously via its own effect.
  useEffect(() => {
    if (!primaryOrigin) return
    if (primaryOrigin.includes(",")) {
      // Legacy coord — forward-translate to ID.
      setPrimaryOriginRaw(resolveCoordKey(primaryOrigin) ?? "CLON")
    } else if (!getOriginDisplay(primaryOrigin)) {
      // The stored ID resolves to nothing — either an old name string
      // (e.g. "Charing Cross") from a pre-Phase-3c localStorage value,
      // or an ID we no longer recognise. migrateOriginKey covers the
      // name-string case via the registry's resolveName; if neither
      // matches, it returns "CLON".
      setPrimaryOriginRaw(migrateOriginKey(primaryOrigin, "CLON"))
    }
  }, [primaryOrigin, setPrimaryOriginRaw, recentCustomPrimaries])

  // Recents-list cleanup. Forward-translates legacy coord entries (same
  // reasoning as the primaryOrigin effect above) AND removes synthetic
  // primary anchors, since synthetic primaries already have a permanent
  // slot in the dropdown and shouldn't appear twice.
  useEffect(() => {
    const cleaned: string[] = []
    let changed = false
    for (const c of recentCustomPrimaries) {
      const id = c.includes(",") ? resolveCoordKey(c) : c
      if (!id) { changed = true; continue }
      if (id !== c) changed = true
      if (getOriginDisplay(id)?.isCluster) { changed = true; continue }
      cleaned.push(id)
    }
    if (changed) setRecentCustomPrimaries(cleaned)
  }, [recentCustomPrimaries, setRecentCustomPrimaries])

  // Friend recents: forward-translate legacy coord entries to IDs.
  // No synthetic-anchor exclusion here — friend synthetic anchors aren't
  // permanent dropdown slots, they live in DEFAULT_RECENT_FRIENDS like
  // any other seed, so the recents list can hold them.
  useEffect(() => {
    const cleaned: string[] = []
    let changed = false
    for (const c of recentCustomFriends) {
      const id = c.includes(",") ? resolveCoordKey(c) : c
      if (!id) { changed = true; continue }
      if (id !== c) changed = true
      cleaned.push(id)
    }
    if (changed) setRecentCustomFriends(cleaned)
  }, [recentCustomFriends, setRecentCustomFriends])
  // useTransition lets us defer the heavy stations-recompute that happens
  // when primaryOrigin changes. startTransition wraps the state setter;
  // React paints the dropdown close + loading spinner IMMEDIATELY (those
  // happen outside the transition), then runs the heavy memo work in the
  // background while `isPending` stays true. When the new state is ready
  // React swaps in the new stations and flips isPending back to false.
  //
  // Without this wrapper, selecting a new home station freezes the main
  // thread for ~0.5–1.5s while the big useMemo over every station reruns
  // — the dropdown looks stuck, and nothing tells the user anything is
  // happening.
  const [isPending, startTransition] = useTransition()
  // pendingPrimaryCoord holds the coord key of the home station the
  // transition is fetching journeys for — used to drive the spinner's
  // "Fetching [name] train journeys" label. Set SYNCHRONOUSLY (outside
  // startTransition) when a new primary is picked so the spinner text
  // updates in the same frame as the transition starting. Stored as a
  // COORD rather than a pre-resolved name because the coord-to-name
  // resolution (PRIMARY_ORIGINS + coordToName) isn't in scope where
  // setPrimaryOrigin/selectCustomPrimary are defined; the actual name
  // resolution happens at render time instead (see the spinner JSX
  // below).
  //
  // Why capture the coord at all — during a useTransition, React keeps
  // the OLD primaryOrigin committed until the new one finishes. So
  // reading primaryOrigin in the spinner would show the station we're
  // moving AWAY FROM, not the one we're moving TO. pendingPrimaryCoord
  // is committed outside the transition and always reflects the target.
  const [pendingPrimaryCoord, setPendingPrimaryCoord] = useState<string | null>(null)
  // Coord of the friend being ADDED (or switched to). Drives the
  // "Looking up trains from <X>" label during an add/switch transition.
  // Cleared (null) during a friend-removal transition so the goodbye
  // label below takes over.
  const [pendingFriendCoord, setPendingFriendCoord] = useState<string | null>(null)
  // Coord of the friend being REMOVED. Populated right before the
  // remove-transition starts, captured from whatever friendOrigin was
  // at the moment the user clicked Remove. Drives the pill label
  // "Saying goodbye to <X>" — mutually exclusive with
  // pendingFriendCoord.
  const [goodbyeFriendCoord, setGoodbyeFriendCoord] = useState<string | null>(null)
  // Three-phase lifecycle for the home-station notification pill:
  //   - "idle"    : pill hidden (opacity 0, aria-hidden).
  //   - "loading" : spinner + "Looking up trains from X".
  //   - "success" : green tick + same label, shown for 2.5s as
  //                 visual confirmation AFTER the transition
  //                 commits, then auto-dismisses back to idle.
  // The success phase holds pendingPrimaryCoord so the label keeps
  // reading correctly during the confirmation window.
  type NotificationPhase = "idle" | "loading" | "success"
  const [notificationPhase, setNotificationPhase] = useState<NotificationPhase>("idle")
  // Filter-change notification — small pill at top-centre that flashes
  // "Showing N stations" whenever any filter input changes. Distinct
  // from the primary/friend "Looking up trains" pill above (different
  // position, different copy, no spinner). Driven by a useEffect on
  // displayedStations downstream; the visible flag controls the fade.
  const [filterNotif, setFilterNotif] = useState<{ count: number; visible: boolean } | null>(null)
  // Refs survive re-renders without retriggering the effect.
  const filterNotifTimerRef = useRef<number | null>(null)
  // Track the last filter-input signature so the pill fires on filter
  // changes only — NOT on primary/friend origin changes or any other
  // source of a stationsForMap recomputation. Signature is a JSON
  // string of every input the user can toggle to narrow the visible
  // station set. Origin changes (primary, friend) don't appear in the
  // signature, so they leave it unchanged and the pill stays
  // suppressed even though stationsForMap rebuilt.
  const filterNotifSignatureRef = useRef<string | null>(null)
  // Ref to the auto-dismiss timer so a fast double-selection can
  // cancel the previous cycle's pending idle-flip. Without this,
  // picking station B while station A's success pill is still
  // visible would see A's setTimeout fire mid-loading-of-B and
  // wipe the new spinner back to idle.
  const dismissTimerRef = useRef<number | null>(null)
  // Wall-clock time the pill entered "loading". Used to enforce a
  // minimum 2000ms total visibility — fast routing recomputes (e.g.
  // when the routing diff is already cached) would otherwise flash
  // the pill for ~50ms which feels like a glitch rather than feedback.
  const notificationLoadingStartRef = useRef<number | null>(null)
  // Total visible duration floor: loading + success windows summed
  // never drop below this. The post-load success window stretches
  // to fill the gap when loading itself was very fast.
  const MIN_LOOKING_UP_MS = 2000
  // Default success-window length when load was already long enough
  // that the pill has had plenty of stage time. Kept short so the
  // tick (now spinner) doesn't linger when nothing else is happening.
  const SUCCESS_TAIL_MS = 400
  useEffect(() => {
    if (isPending) {
      setNotificationPhase("loading")
      notificationLoadingStartRef.current = Date.now()
      if (dismissTimerRef.current != null) {
        clearTimeout(dismissTimerRef.current)
        dismissTimerRef.current = null
      }
    } else {
      // Only transition to "success" if we were actually in the
      // middle of loading — don't flash a tick on the initial mount
      // (phase starts "idle" while isPending is also already false).
      setNotificationPhase((prev) => {
        if (prev !== "loading") return prev
        // Stretch the success tail when loading was very fast so the
        // pill stays on screen for at least MIN_LOOKING_UP_MS total.
        const start = notificationLoadingStartRef.current ?? Date.now()
        const loadingElapsed = Date.now() - start
        const tail = Math.max(SUCCESS_TAIL_MS, MIN_LOOKING_UP_MS - loadingElapsed)
        dismissTimerRef.current = window.setTimeout(() => {
          setNotificationPhase("idle")
          // Deliberately do NOT clear pendingPrimaryCoord here.
          // Clearing it would flip the label's "Looking up trains
          // from X" back to the "new home" fallback while the pill
          // is still in its 200ms opacity fade-out — the user
          // sees the text briefly change to "new home" right
          // before it vanishes. Leaving the coord populated means
          // the label keeps reading correctly through the fade.
          // It'll be overwritten naturally the next time the
          // user picks a primary.
          dismissTimerRef.current = null
        }, tail)
        return "success"
      })
    }
  }, [isPending])
  const setPrimaryOrigin = useCallback((next: string) => {
    setPendingPrimaryCoord(next)
    setPendingFriendCoord(null)
    setGoodbyeFriendCoord(null)
    startTransition(() => setPrimaryOriginRaw(next))
  }, [setPrimaryOriginRaw])
  // Wrap setFriendOrigin in the same transition machinery so picking
  // a friend station (or clearing it) shows the notification pill
  // while the heavy routing recompute runs in the background.
  // Capturing the target coord in pendingFriendCoord lets the pill
  // label read "Looking up trains from friend's <X>" before the new
  // friendOrigin commits. null means "friend cleared" — we still
  // want a transition so the map recompute is deferred, but no
  // pending-coord so the pill stays idle.
  // Keep a ref of the LIVE friendOrigin so the callback can read the
  // latest value without re-creating itself every time friendOrigin
  // changes. The useEffect below syncs the ref (we can't assign
  // during render because the state declaration is further down in
  // the component body — avoids a "used before declaration" error).
  const currentFriendOriginRef = useRef<string | null>(null)
  const setFriendOriginWithTransition = useCallback((next: string | null) => {
    setPendingPrimaryCoord(null)
    if (next === null) {
      // Removal: capture the friend being dismissed so the pill can
      // read "Saying goodbye to <X>". Clear pendingFriendCoord so
      // the add/switch branch doesn't fire.
      setPendingFriendCoord(null)
      setGoodbyeFriendCoord(currentFriendOriginRef.current)
    } else {
      // Add / switch: drive the "Looking up trains from <X>" label.
      setPendingFriendCoord(next)
      setGoodbyeFriendCoord(null)
      // Bump this friend to the top of recents so it floats above the
      // seeded defaults next time the dropdown is opened. Same shape as
      // selectCustomPrimary's recents handling.
      setRecentCustomFriends((prev) => {
        const filtered = prev.filter((c) => c !== next)
        return [next, ...filtered].slice(0, 9)
      })
    }
    startTransition(() => setFriendOrigin(next))
  }, [setRecentCustomFriends])
  // Reverse lookup: cluster-member coord → parent primary coord. Lets the
  // search-based picker redirect a tap on (e.g.) Waterloo East to the
  // Waterloo primary, or St Pancras to the Kings Cross primary, instead of
  // stranding the user on an orphan coord in the recents list. Synthetic
  // primaries (London) are EXCLUDED — their cluster members are meaningful
  // selections on their own (a user searching for "Cannon Street" wants
  // Cannon Street, not London).
  // Plain Record<string,string> rather than a native Map — "Map" is shadowed
  // at the module level by the react-map-gl import at the top of the file,
  // so `new Map()` here resolves to the React component and blows up.
  const clusterMemberToPrimary = useMemo(() => {
    const out: Record<string, string> = {}
    // Iterate every cluster — including destination-only ones (Windsor,
    // Maidstone, Folkestone, Canterbury). Member-name-to-cluster
    // redirect is intrinsic to clustering: typing "Windsor and Eton
    // Riverside" in primary search collapses to the Windsor cluster row
    // even though Windsor isn't yet a primary origin (it'll show as
    // "Coming soon" until promoted).
    //
    // EXCEPTION: Central London members (Kings Cross, Waterloo,
    // Liverpool Street, …). They're individually selectable as primary
    // — typing "Kings Cross" in the search lands on Kings Cross-the-
    // station, not on the "London" cluster. The cluster row is still
    // findable separately via the synthetic-anchor loop in
    // searchableStations. Picking a member here also bypasses the
    // anchor-redirect in selectCustomPrimary, so the terminus becomes
    // the actual primaryOrigin and the rest of the cluster is implicitly
    // disabled (no diamonds, no hover pulse, no anchor lines, no cluster
    // overlay) via downstream gates that key off `isClusterMember`.
    for (const [anchor, def] of Object.entries(ALL_CLUSTERS)) {
      if (anchor === CENTRAL_LONDON_ANCHOR) {
        // Central London members are individually selectable as primaries
        // (see comment above), but a few "alias coords" still need to fold
        // into a canonical sibling — currently just the HS1 St Pancras
        // concourse → main concourse (TERMINUS_COORD_ALIASES). Without
        // these entries, the aliased coord would be pickable as its own
        // primary with no origin-routes data, and the primary search would
        // show two adjacent "St Pancras" rows that filter-panel can't
        // dedupe (its dedupe is keyed by primaryCoord).
        for (const [from, to] of Object.entries(TERMINUS_COORD_ALIASES)) {
          out[from] = to
        }
        continue
      }
      for (const m of def.members) out[m] = anchor
    }
    return out
  }, [])
  // Set of coords inside ANY synthetic primary's cluster (anchor + all
  // members). Used to decide whether a search-picked coord should bypass the
  // "recents" list. Synthetic-cluster coords bypass recents because their
  // anchor is already in the curated dropdown; non-synthetic standalone
  // primaries (Charing Cross, Waterloo) and other NR stations (Farringdon,
  // East Croydon) all go to recents.
  const syntheticClusterCoords = useMemo(() => {
    const set = new Set<string>()
    for (const anchorId of Object.keys(PRIMARY_ORIGIN_CLUSTER)) {
      set.add(anchorId)
      for (const m of PRIMARY_ORIGIN_CLUSTER[anchorId] ?? []) set.add(m)
    }
    return set
  }, [])
  // Select a primary coord chosen via the dropdown's search bar OR a recents
  // click. Two cases:
  //   1. Cluster variant of a London terminus (Waterloo East, St Pancras NR,
  //      Euston Underground, …) — the coord isn't itself in PRIMARY_ORIGINS
  //      but maps to a parent that is. Redirect to the parent so the trigger
  //      shows a meaningful name, and push the parent to recents.
  //   2. Everything else — standalone primaries (Charing Cross, Waterloo, …),
  //      non-primary London NR stations (Farringdon, Kentish Town, East
  //      Croydon, …): select the coord as-is and push to recents.
  // The ONLY exclusion is the synthetic "Any London terminus" primary,
  // which has a permanent curated slot at the top of the dropdown and so
  // doesn't need to live in the recents list too — selecting it just
  // switches the active primary, nothing else.
  const selectCustomPrimary = useCallback((coord: string) => {
    // Resolve the final destination coord BEFORE starting the transition
    // — the same canonicalisation logic runs both inside the transition
    // (to update primaryOrigin) and outside (to set pendingPrimaryCoord
    // so the spinner label reads correctly). Keeping one source of truth
    // avoids a flicker where the spinner briefly says "Fetching
    // St Pancras train journeys" before the coord gets redirected to
    // Kings Cross.
    // Cluster-anchor input: keep as-is. Cluster member input: redirect
    // to the cluster anchor regardless of which cluster — Phase 5b.i's
    // cluster-aware originRoutes (lib/origin-routes.ts) builds a
    // synthetic entry for every cluster anchor by aggregating the
    // fastest member journey per destination, so picking BHM lands on
    // CBIR with full routing rather than the Phase 5a-era workaround
    // that kept primary at the member.
    const resolved = getOriginDisplay(coord)?.isCluster
      ? coord
      : (clusterMemberToPrimary[coord] ?? coord)
    setPendingPrimaryCoord(resolved)
    // Clear any stale pendingFriendCoord so the notification pill
    // reads the NEW primary rather than a previously-set friend.
    // Without this, switching primary while a friend is active would
    // keep the label showing the friend's name.
    setPendingFriendCoord(null)
    setGoodbyeFriendCoord(null)
    // Same transition wrapper as setPrimaryOrigin — the stations memo
    // recomputation is equally expensive whichever route you took to
    // pick a primary. Both state updates are inside the transition
    // callback so they commit together and the spinner covers the
    // entire gap.
    startTransition(() => {
      // Synthetic primary — no recents entry, just select. Check
      // `resolved` (not `coord`) so picking a cluster member like Kings
      // Cross or Charing Cross — which now resolves to its synthetic
      // anchor — also takes this branch.
      if (getOriginDisplay(resolved)?.isCluster) {
        setPrimaryOriginRaw(resolved)
        return
      }
      setPrimaryOriginRaw(resolved)
      setRecentCustomPrimaries((prev) => {
        const filtered = prev.filter((c) => c !== resolved)
        // Cap at 9 — matches the curated seed size so the dropdown stays
        // compact even after the user has explored a few new stations.
        return [resolved, ...filtered].slice(0, 9)
      })
    })
  }, [setPrimaryOriginRaw, setRecentCustomPrimaries, clusterMemberToPrimary])
  // True when the active primary is a Central London cluster member
  // (Kings Cross, Waterloo East, St Pancras, …) rather than the synthetic
  // "London" anchor itself. Drives the "cluster is temporarily disabled"
  // behaviour: Central London members render as ordinary stations (no
  // diamonds, no hover pulse, no anchor lines, no cluster overlay) so the
  // selected terminus reads as a standalone primary. Switching back to
  // any non-London-terminus primary makes this false again and the cluster
  // resumes its normal behaviour. Friend-side is intentionally NOT mirrored
  // here — friends keep redirecting to the Central London anchor for now.
  const isLondonTerminusActive = MEMBER_TO_SYNTHETIC[primaryOrigin] === CENTRAL_LONDON_ANCHOR
  // Render-time anchor coord for the primary origin. primaryOrigin is
  // an ID post Phase 3c; resolve through the registry to get the
  // lng/lat for layers that draw at the primary's position.
  const originCoords = useMemo(() => {
    const ck = registryGetCoordKey(primaryOrigin)
    return ck ? parseCoordKey(ck) : { lng: 0, lat: 0 }
  }, [primaryOrigin])
  // Ref keeps theme accessible inside the style.load callback (which is a stale
  // closure from handleMapLoad). Without this, registerIcons would always see
  // whatever theme was active when the map first loaded.
  const themeRef = useRef(theme)
  themeRef.current = theme
  // Raw station data — loaded once, without primaryOrigin-dependent overrides
  const [baseStations, setBaseStations] = useState<StationCollection | null>(null)
  // Keep a ref in sync with baseStations for async admin flows that
  // need the latest value without being locked into a render closure.
  useEffect(() => { baseStationsRef.current = baseStations }, [baseStations])
  // Buried stations — "lng,lat" coord keys flagged via the admin
  // right-click. Seeded from data/buried-stations.json. Drives the
  // zoom-11+ visibility gate for unrated suburban-style stations.
  const [buriedStations, setBuriedStations] = useState<Set<string>>(() => new Set(INITIAL_BURIED_STATIONS))
  // Admin-only toggle controlling whether stations with no journey-time
  // data are hidden. Default = true (matches the public-facing rule
  // that the public app never sees them). Re-enabled automatically
  // when the admin leaves admin mode, so a non-admin viewer always
  // ends up with them hidden regardless of admin's last state.
  const [hideNoTravelTime, setHideNoTravelTime] = useState(true)
  // Default 150min (2h30m) — the non-admin slider cap. In admin mode the cap
  // extends to 600min ("Max" = no upper limit).
  // Filter state (max time, direct-only, rating checkboxes, trails) intentionally
  // does NOT persist across reloads — every visit starts from a clean slate.
  const [maxMinutes, setMaxMinutes] = useState(90)
  // Admin-only lower bound on travel time — 0 means "no minimum" (disabled)
  const [minMinutes, setMinMinutes] = useState(0)
  // Friend origin mode — when non-null, a second origin filters stations.
  // Not persisted — every reload starts with no friend (same as the other
  // filter state). Value is a "lng,lat" coord key.
  const [friendOrigin, setFriendOrigin] = useState<string | null>(null)
  const [friendMaxMinutes, setFriendMaxMinutes] = useState(90)
  // Keep the ref (declared above) in sync with friendOrigin so the
  // setFriendOriginWithTransition callback can read the latest value
  // on a removal without being forced to re-create on every
  // friendOrigin change.
  useEffect(() => {
    currentFriendOriginRef.current = friendOrigin
  }, [friendOrigin])
  // Lazy-loader for per-origin journey files. When the user picks a
  // friend (or switches home to one of the Routes-API primaries) the
  // corresponding journeys/<slug>.json is fetched and its records
  // merged into baseStations. Returns a promise that resolves once
  // the merge is committed (useful if a caller wants to wait before
  // triggering further state changes).
  const ensureOriginLoaded = useCallback(
    async (originCoord: string): Promise<void> => {
      if (!originCoord) return
      // No-op if already loaded.
      if (loadedOriginsRef.current.has(originCoord)) return
      // Dedupe concurrent requests for the same origin.
      const existing = pendingOriginsRef.current[originCoord]
      if (existing) return existing
      // No slug → origin isn't one of the pre-fetched Routes origins,
      // so there's nothing to lazy-load. Routing will fall back to
      // RTT direct-reachable data for this origin.
      const slug = getStation(originCoord)?.journeySlug
      if (!slug) return
      const p = (async () => {
        try {
          const res = await fetch(`/journeys/${slug}.json`)
          if (!res.ok) return
          const payload = await res.json() as {
            origin: string
            journeys: Record<string, unknown>
          }
          if (!payload?.journeys) return
          // Merge into baseStations: for each feature whose station ID
          // appears in the loaded journeys map, add an entry under
          // f.properties.journeys[originCoord]. Post Phase 4 the
          // journey file is keyed by station ID at the destination
          // level, so we look up via f.properties["ref:crs"] (the
          // canonical ID after Phase 1). The OUTER `originCoord` keying
          // on f.properties.journeys is preserved — every other consumer
          // in this file still reads journeys[<coord>].
          setBaseStations((prev) => {
            if (!prev) return prev
            const perId = payload.journeys
            return {
              ...prev,
              features: prev.features.map((f) => {
                const id = f.properties["ref:crs"] as string | undefined
                const entry = id ? perId[id] : undefined
                if (!entry) return f
                const existingJourneys = (f.properties as Record<string, unknown>).journeys as Record<string, unknown> | undefined
                return {
                  ...f,
                  properties: {
                    ...f.properties,
                    journeys: {
                      ...(existingJourneys ?? {}),
                      [originCoord]: entry,
                    },
                  } as StationFeature["properties"],
                }
              }),
            }
          })
          loadedOriginsRef.current.add(originCoord)
        } finally {
          delete pendingOriginsRef.current[originCoord]
        }
      })()
      pendingOriginsRef.current[originCoord] = p
      return p
    },
    [],
  )
  // Whenever the friend origin changes to one of the 5 known
  // pre-fetched Routes origins, kick off a lazy-load. The routing
  // memo will re-run once the fetch completes and the merge lands
  // in baseStations. For friends that AREN'T one of the known
  // origins (e.g. user typed in a custom London NR station), no
  // fetch fires and the routing falls back to RTT-based direct
  // reachability.
  useEffect(() => {
    if (friendOrigin) ensureOriginLoaded(friendOrigin)
  }, [friendOrigin, ensureOriginLoaded])
  // Phase 5b.ii — friend RTT compose. When the active friend has no
  // pre-built journey file (no `journeySlug` on the registry entry),
  // compute friend
  // journey times from origin-routes data and stamp them onto
  // baseStations.features as journeys[friendOrigin]. Direct routes +
  // 1-change via-hub composition. Only durationMinutes / changes are
  // populated (no polyline, no leg detail) — modal degrades gracefully.
  // Scoped to friend only — running this for primary would confuse the
  // primary routing pipeline, which expects journeys[primaryOrigin] to
  // be a rich Google Routes journey.
  const rttFriendComposedRef = useRef<Set<string>>(new Set())
  useEffect(() => {
    if (!friendOrigin) return
    if (getStation(friendOrigin)?.journeySlug) return       // journey file path will handle it
    if (rttFriendComposedRef.current.has(friendOrigin)) return // already composed once
    const directReachable = originRoutes[friendOrigin]?.directReachable
    if (!directReachable) return
    const out: Record<string, JourneyInfo> = {}
    for (const [destId, entry] of Object.entries(directReachable)) {
      if (entry?.minMinutes == null) continue
      out[destId] = { durationMinutes: entry.minMinutes, changes: 0 } as unknown as JourneyInfo
    }
    // 1-change via-hub composition.
    const HUB_INTERCHANGE_MIN = 5
    for (const [hubCoord, hubRoutes] of Object.entries(originRoutes)) {
      if (hubCoord === friendOrigin) continue
      const hubToFriend = hubRoutes.directReachable?.[friendOrigin]
      if (!hubToFriend?.minMinutes) continue
      const friendToHub = hubToFriend.minMinutes // assume RTT times symmetric
      const dests = hubRoutes.directReachable
      if (!dests) continue
      for (const [destId, hubToDest] of Object.entries(dests)) {
        if (destId === friendOrigin) continue
        if (hubToDest?.minMinutes == null) continue
        const total = friendToHub + HUB_INTERCHANGE_MIN + hubToDest.minMinutes
        const existing = out[destId]
        if (existing == null || (existing.durationMinutes ?? Infinity) > total) {
          out[destId] = { durationMinutes: total, changes: 1 } as unknown as JourneyInfo
        }
      }
    }
    rttFriendComposedRef.current.add(friendOrigin)
    setBaseStations((prev) => {
      if (!prev) return prev
      return {
        ...prev,
        features: prev.features.map((f) => {
          const id = f.properties["ref:crs"] as string | undefined
          const entry = id ? out[id] : undefined
          if (!entry) return f
          const existing = (f.properties as Record<string, unknown>).journeys as Record<string, unknown> | undefined
          return {
            ...f,
            properties: {
              ...f.properties,
              journeys: { ...(existing ?? {}), [friendOrigin]: entry },
            } as StationFeature["properties"],
          }
        }),
      }
    })
  }, [friendOrigin])
  // Same for the home primary — switching to Farringdon / Kings
  // Cross / Stratford eager-loads that origin's file so the live
  // compute path has the Routes journeys it expects.
  useEffect(() => {
    if (primaryOrigin) ensureOriginLoaded(primaryOrigin)
  }, [primaryOrigin, ensureOriginLoaded])
  // Always pre-load a handful of polyline-rich source journeys —
  // Farringdon (ZFD) for southern + central + Thameslink lines,
  // Birmingham (BHM) for the WCML / Midlands corridor. The routing
  // memo's deriveRichPolyline trims these into the active primary's
  // hover polyline, turning straight CRS-chain segments into real-
  // track curves. Without these pre-loads, distant destinations like
  // Dudley Port (DDP, BHM-area) and Sudbury (SUY, off the Stratford
  // line) drew only origin→dest straight lines.
  //
  // Depends on baseStations because ensureOriginLoaded merges into
  // the baseStations features — firing before baseStations is set
  // would land in setBaseStations((prev) => prev === null) and the
  // merge silently no-ops, losing the data forever (the second call
  // is a no-op because loadedOriginsRef has already cached the id).
  useEffect(() => {
    if (!baseStations) return
    ensureOriginLoaded("ZFD")
    ensureOriginLoaded("BHM")
  }, [baseStations, ensureOriginLoaded])
  // Precomputed routing diffs — loaded from `/routing/<slug>.json`
  // files keyed by primary slug. Shape per entry:
  //     { [coordKey]: { ...routing-added-or-changed-fields } }
  // Each diff only stores fields the routing pass ADDED or MODIFIED
  // on top of baseStations (everything else is already in
  // stations.json). When the active primary has a loaded diff AND
  // no friend is set, `routedStations` short-circuits and
  // reconstructs a full FeatureCollection by merging the diff over
  // baseStations instead of running the ~10s live compute.
  const [precomputedRoutingByPrimary, setPrecomputedRoutingByPrimary] = useState<
    Record<string, Record<string, Record<string, unknown>>>
  >({})
  // Coord → slug mapping for every primary that has a precomputed
  // routing file available. Limited to SYNTHETIC primaries (Central
  // London + Stratford) — they have no per-origin journey file under
  // public/journeys/, so the routing memo has to synthesise their
  // journeys on the fly (~10s). The precomputed diff lets first paint
  // skip that compute. Concrete primaries (Birmingham, Manchester,
  // Nottingham, …) load their data straight from public/journeys/<slug>.json
  // and don't benefit from a precomputed routing diff — see the
  // explanatory note above buildDiff in the regen handler for why.
  const PRIMARY_SLUG: Record<string, string> = {
    "CLON":       "central-london",
    "SRA":  "stratford",
    // Synthetic Stratford midpoint anchor — uses the same routing diff
    // as the SRA primary above; the diff merge in routedStations mirrors
    // SRA's journey data under this synthetic key so filters resolve.
    "CSTR": "stratford",
  }
  // Lazy-fetch the precomputed routing diff for the currently active
  // primary. Fires on mount (for the default home) and whenever the
  // user switches primary to one that has a slug in PRIMARY_SLUG.
  // Caches per-primary — switching back to a previously-loaded
  // primary reuses the cached diff without a re-fetch. Missing files
  // (404 or primary not in PRIMARY_SLUG) leave the cache entry
  // absent, and the routedStations memo falls through to live
  // compute for that primary.
  useEffect(() => {
    const slug = PRIMARY_SLUG[primaryOrigin]
    if (!slug) return
    // Already cached (even as explicit null on a previous 404) — don't refetch.
    if (slug in precomputedRoutingByPrimary) return
    fetch(`/routing/${slug}.json`)
      .then((res) => (res.ok ? res.json() : null))
      .then((data: Record<string, Record<string, unknown>> | null) => {
        if (!data || typeof data !== "object") return
        // The on-disk file is still keyed by destination coordKey at
        // the outer level AND by primary coordKey inside each entry's
        // `journeys` map (it was generated pre Phase 3c). Translate
        // every inner journey key forward to a station ID so the
        // runtime — which now reads f.properties.journeys[primaryId]
        // — finds the entry. The outer destination keying stays
        // coord-based to match the diff merge below, which still
        // looks up by f.properties.coordKey.
        const translated: Record<string, Record<string, unknown>> = {}
        for (const [destCoord, delta] of Object.entries(data)) {
          const next: Record<string, unknown> = { ...delta }
          const journeys = (delta as { journeys?: Record<string, unknown> }).journeys
          if (journeys) {
            const remappedJourneys: Record<string, unknown> = {}
            for (const [primaryCoord, entry] of Object.entries(journeys)) {
              const id = primaryCoord.includes(",")
                ? (resolveCoordKey(primaryCoord) ?? primaryCoord)
                : primaryCoord
              remappedJourneys[id] = entry
            }
            next.journeys = remappedJourneys
          }
          translated[destCoord] = next
        }
        setPrecomputedRoutingByPrimary((prev) => ({ ...prev, [slug]: translated }))
      })
      .catch(() => { /* swallow — fall through to live compute */ })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [primaryOrigin, precomputedRoutingByPrimary])
  // "Direct trains only" toggles — when true, only keep stations reachable
  // from the matching origin with zero interchanges (journeys[origin].changes === 0)
  const [primaryDirectOnly, setPrimaryDirectOnly] = useState(false)
  const [friendDirectOnly, setFriendDirectOnly] = useState(false)
  // Admin-only interchange filter. Lets the admin slice the destination
  // set by WHERE the user would change trains — great for testing,
  // because different interchange classes have different bug profiles.
  //
  //   "off"     — no filter (non-admin default, dropdown hidden)
  //   "direct"  — zero interchanges (absorbs the old admin-mode "Direct
  //               trains only" checkbox into the dropdown)
  //   "any"     — at least one interchange (i.e. any journey with ≥1 change)
  //   "inner"   — ≥1 interchange at a central-London terminus
  //   "outer"   — ≥1 interchange at a non-London-terminus station
  //   "lowdata" — ≥1 interchange at a station with no RTT data yet
  //               (most likely to have routing bugs — helps prioritise
  //               which suburban hubs to fetch next)
  //   "gooddata" — every interchange is at a station with full RTT
  //                data (inverse of lowdata). Useful for isolating the
  //                "should be bug-free" cohort when diff-testing
  //                against NRE.
  type InterchangeFilter = "off" | "direct" | "any" | "inner" | "outer" | "lowdata" | "gooddata"
  const [primaryInterchangeFilter, setPrimaryInterchangeFilter] = useState<InterchangeFilter>("off")
  // Admin-only "Feature" filter. Slices destinations by which
  // optional modal-overlay features they surface. Start-list is
  // intentionally small; add entries as new modal features arise.
  //
  //   "off"             — no filter (non-admin default, dropdown hidden)
  //   "alt-routes"      — only destinations whose overlay shows at
  //                       least one alternative route paragraph. Alt
  //                       routes only populate when home is the
  //                       synthetic Central London primary, so this
  //                       filter is most useful in that mode.
  //   "private-notes"   — only destinations with a non-empty private
  //                       note (admin-authored). Helps the admin find
  //                       stations where they've stashed context.
  //   "sloppy-pics"     — stations whose photo curation isn't "full"
  //                       yet: approved.length < MAX_PHOTOS (12). This
  //                       INCLUDES stations that have never been touched
  //                       (approved=0 counts as < 12).
  //   "all-sloppy-pics" — the subset of sloppy-pics that have zero
  //                       curation at all (no approvals AND no
  //                       rejections). These are the stations still
  //                       using the broad Flickr algorithm by default.
  // `undiscovered` hides any station where at least one attached walk
  // has a populated `previousWalkDates` — surfaces destinations still
  // to explore. Lives on the Feature dropdown (rather than a separate
  // checkbox) so admin-only filters that exclude stations all share a
  // single UI control.
  // `komoot` — keeps only stations whose attached walks include at least
  // one variant with a non-empty `komootUrl`. Membership comes from the
  // pre-built stations-with-komoot.json set.
  type FeatureFilter = "off" | "alt-routes" | "private-notes" | "sloppy-pics" | "all-sloppy-pics" | "undiscovered" | "hiked" | "komoot" | "no-komoot" | "potential-month-data" | "issues" | "placemark" | "no-travel-data" | "oyster"
  // Build the Oyster CRS Set with oysterStationsData as the dep — when
  // the JSON hot-reloads in dev the import gives a new array reference,
  // which busts this memo and the downstream filteredStations memo.
  // useMemo([]) (empty deps) was the previous form and went stale on
  // hot-reload, so updates to data/oyster-stations.json appeared not to
  // take effect until a hard reload — Claverdon (CLV) and other false
  // positives kept showing because the closed-over Set was the old one.
  const OYSTER_NR_CRS = useMemo(
    () => new Set(oysterStationsData.nrStations as string[]),
    // List the imported array as a dep so the Set rebuilds when the JSON
    // hot-reloads in dev (Next.js Fast Refresh gives a new array
    // reference). Empty `[]` was the previous form and silently kept a
    // stale Set across JSON edits — the cause of "CLV still shows after
    // I update oyster-stations.json".
    [oysterStationsData],
  )
  const [primaryFeatureFilter, setPrimaryFeatureFilter] = useState<FeatureFilter>("off")
  // Admin-only "Month" dropdown — slice destinations to those recommended
  // for the chosen month. "off" = no filter, "None" = stations with zero
  // month-flagged walks. Cleared on admin-off (below).
  type MonthFilter = "off" | MonthCode | "None"
  const [monthFilter, setMonthFilter] = useState<MonthFilter>("off")
  // Admin-only "Source" dropdown — slice destinations to those with at
  // least one attached walk whose source.orgSlug or relatedSource.orgSlug
  // matches the picked org. "off" = no filter. The string value is an
  // orgSlug from data/sources.json. Cleared on admin-off (below).
  const [sourceFilter, setSourceFilter] = useState<string>("off")
  // orgSlug → Set<coordKey>. Hydrated from /api/dev/stations-by-source
  // on mount; the admin-only "Source" filter does Set.has(coordKey)
  // against the slug picked in the dropdown. Each value's Set is built
  // from the JSON's sorted coordKey[] for O(1) membership lookups.
  const [stationsBySource, setStationsBySource] = useState<Record<string, Set<string>>>({})
  // Public "Best in {current-month}" checkbox — when on, only stations
  // recommended for the current month are shown. Coexists with monthFilter
  // (both filters applied independently, AND semantics).
  const [currentMonthHighlight, setCurrentMonthHighlight] = useState(false)
  const [hovered, setHovered] = useState<HoveredStation | null>(null)
  // Cluster-diamond hover — when the user mouses over a cluster member
  // diamond, the SYNTHETIC's pulsing icon is shown via the regular
  // `hovered` state (centred at the synthetic's anchor), and this
  // separate state drives a dedicated pulse on the diamond itself.
  // Two simultaneous pulses: the synthetic informs the user "this
  // belongs to that cluster", the diamond confirms "this is the
  // specific member you're pointing at". Cleared in lockstep with
  // `hovered` so the two animations always start/stop together.
  const [hoveredDiamond, setHoveredDiamond] = useState<{
    coordKey: string
    // Canonical station ID — used to prefix the diamond label in admin
    // mode (matches the regular hover label's "TRI Tring" treatment).
    id?: string
    lng: number
    lat: number
    name: string
  } | null>(null)
  const [showTrails, setShowTrails] = useState(false)
  // Region labels (counties, parks, AONBs) and the historic-county
  // borders that ride along — controlled by a checkbox in FilterPanel
  // sitting under "Waymarked trails", and toggled with the `h` key.
  // Off by default everywhere (dev and prod) so first-load reads the
  // same regardless of environment.
  const [showRegions, setShowRegions] = useState(false)
  // Region-label opacity is driven imperatively by an effect (further down)
  // that calls map.setPaintProperty when visibleRatings or showRegions
  // change. No React state needed — Mapbox owns the animated value, and
  // we just push target+transition into it.
  // Banner shows on EVERY page load. We deliberately DON'T persist a
  // "has seen welcome" flag — reloading brings the banner back. The
  // previous behaviour stored ttg:hasSeenWelcome in localStorage so
  // returning visitors skipped it; the user preferred a consistent
  // intro every time. Dismissing only hides it for the current session.
  const [bannerVisible, setBannerVisible] = useState(true)
  // Imperative handle on the banner so the ? help button can trigger
  // the same animated-close path that a backdrop tap or the X button
  // uses, rather than setting bannerVisible=false directly (which
  // would unmount without animation).
  const welcomeBannerRef = useRef<WelcomeBannerHandle>(null)
  // RTT status panel visibility — admin-only. Opened via the "RTT"
  // button next to the admin close (bottom-centre) when admin is active.
  const [rttStatusOpen, setRttStatusOpen] = useState(false)
  // Edits dialog (audit log + outbox queue) visibility — admin-only.
  // Opened via the "edits" button next to the RTT one.
  const [editsDialogOpen, setEditsDialogOpen] = useState(false)
  // Screen-pixel origin of the London icon — null on initial page load (no icon click)
  const [bannerOrigin, setBannerOrigin] = useState<{ x: number; y: number } | null>(null)
  // True when the banner is currently open BECAUSE the user opened it via
  // the ? help button (rather than the default cold-start appearance).
  // Drives the data-attribution footer on the welcome card. Once flipped
  // true it stays true — every subsequent ? open is also a deliberate
  // summons, and that's the only path to re-open after dismissal.
  const [bannerSummoned, setBannerSummoned] = useState(false)
  const [zoom, setZoom] = useState(INITIAL_VIEW.zoom)
  // Admin-only readout — last known cursor lng/lat. Updated from
  // handleMouseMove via e.lngLat. Rendered as a small badge next to the zoom
  // indicator. Uses the same coordKey format as the rest of the app
  // ("lng,lat" with 4 decimals) so the value can be copy-pasted into
  // station-keyed JSON files (buried-stations.json, station-notes.json,
  // etc) without reformatting.
  const [cursorCoord, setCursorCoord] = useState<{ lng: number; lat: number } | null>(null)
  // Brief visual flag — turns the cursor-coord badge green for ~1s after a
  // right-click clipboard copy lands, so the admin sees that the action
  // succeeded without needing a separate toast component.
  const [coordCopied, setCoordCopied] = useState(false)
  // The Mapbox style URL — switches between light and dark based on theme.
  const mapStyle = theme === "dark"
    ? "mapbox://styles/niczap/cmnepmfm2001p01sfe63j3ktq"
    : "mapbox://styles/niczap/cmneh11gr001q01qxeu1leyuc"
  // Halo behind label text — white in light mode, black in dark mode
  const haloColor = theme === "dark" ? "#000" : "#fff"
  // Label text color — --beach-100 (#fdfcf8) in dark mode, dark green in light mode
  const labelColor = theme === "dark" ? "#fdfcf8" : "#166534"
  // True once the map's onLoad fires — icon images are registered at that point,
  // so icon-dependent layers should only render after this is true.
  // Reset to false when the style changes (theme toggle) so Sources/Layers
  // don't try to render before the new style has finished loading.
  const [mapReady, setMapReady] = useState(false)
  // When set, the routedStations short-circuit refuses to return the
  // precomputed diff for this slug. Used by the admin "Regenerate
  // routing (all)" button to force live compute on a primary whose
  // precompute file is still on disk. Cleared once the admin flow
  // finishes so normal users keep the instant-load path.
  const [bypassPrecomputeForSlug, setBypassPrecomputeForSlug] = useState<string | null>(null)
  // Drives the admin "Regen routing (all)" button's visual state.
  // Null = idle, otherwise { index, total, slug } describes the
  // primary currently being regenerated. The button label + spinner
  // render off this. CSS-animated (compositor layer) so the spinner
  // keeps rotating even during the 10s main-thread freeze of each
  // primary's live compute.
  const [regenProgress, setRegenProgress] = useState<{
    index: number
    total: number
    slug: string
  } | null>(null)
  // Drives the admin "pull all" button — bulk-pulls Komoot data
  // (distance, hours, uphill, difficulty, name) for every walk with
  // a komootUrl. Null = idle, otherwise progress through the list.
  // Sequential (one walk at a time) so the public view rebuilds
  // incrementally — admins can navigate around the map and see
  // walks light up in real time.
  const [pullAllProgress, setPullAllProgress] = useState<{
    index: number
    total: number
    walkId: string
  } | null>(null)
  // Refs tracking latest routedStations / baseStations values. The
  // admin "Regenerate routing" flow runs asynchronously across
  // multiple primary switches, and each await needs to read the
  // LATEST memo output — closure-capture of the state at handler
  // creation time would give stale data.
  const routedStationsRef = useRef<StationCollection | null>(null)
  const baseStationsRef = useRef<StationCollection | null>(null)
  // Per-origin Google-Routes journey files, lazy-loaded from
  // /public/journeys/<slug>.json when the user picks a friend in
  // one of the 5 pre-fetched origins, or switches home to one of
  // the Routes-API primaries. The fat stations.json used to inline
  // all 5 (~21 MB); stripping them out shrinks the initial
  // stations.json from 28 MB to 0.68 MB. Keyed by the origin's
  // coord (same string the routing code uses to look up
  // f.properties.journeys[origin]).
  //
  // On arrival, the journey records merge into baseStations
  // directly, so every other code path continues to read
  // f.properties.journeys[origin] as before — no routing-logic
  // changes required.
  // Plain object rather than Map — `Map` is shadowed by the
  // react-map-gl import at the top of this file.
  const loadedOriginsRef = useRef<Set<string>>(new Set())
  const pendingOriginsRef = useRef<Record<string, Promise<void>>>({})
  // `mapReady` flips true on the style's `load` event — style + icons
  // are wired, but tiles / markers may not yet be painted. For the
  // welcome-banner "is the map actually visible?" gate we want a
  // stricter signal: the first `idle` event, which fires when Mapbox
  // has finished rendering all requested tiles + sources. That's the
  // earliest moment the user could tap "Find stations" and see a
  // populated map.
  const [mapFirstIdle, setMapFirstIdle] = useState(false)
  const prevStyleRef = useRef(mapStyle)
  useEffect(() => {
    if (prevStyleRef.current !== mapStyle) {
      prevStyleRef.current = mapStyle
      setMapReady(false)
    }
  }, [mapStyle])
  // Dev tool — toggled on/off via the badge button; off by default
  const [devExcludeActive, setDevExcludeActive] = useState(false)
  // The station whose detail panel is open, or null if none
  const [selectedStation, setSelectedStation] = useState<SelectedStation | null>(null)
  // Keeps the last station data alive during the close animation so the
  // component stays mounted while Radix plays the exit transition
  const lastStationRef = useRef<SelectedStation | null>(null)
  if (selectedStation) lastStationRef.current = selectedStation
  const displayStation = selectedStation ?? lastStationRef.current
  // Maps coordKey → derived station rating (1..4). Computed by
  // /api/dev/walk-ratings from the rating of every walk attached to
  // the station. Read-only on the client — the route handler does the
  // aggregation per the rules in walk-ratings/route.ts.
  const [ratings, setRatings] = useState<Record<string, Rating>>({})
  // Admin-only: set of "homeCoord|destCoord" pairs the admin has tested
  // and approved. Controls the red-tint overlay on the map in admin
  // mode (any non-approved destination for the current primary gets a
  // red dot) and the "Approved for this home" checkbox in the modal.
  // Station-global "has issue" flag — a Set of coordKeys flagged via the
  // admin issue button. Drives the red halo overlay regardless of which
  // primary is selected.
  const [issueStations, setIssueStations] = useState<Set<string>>(new Set())
  // Station-global "placemark" flag — a Set of coordKeys flagged via the
  // admin placemark button. Forces the name-label to appear at zoom 8+,
  // overriding the rating's normal label-zoom threshold (no-op when the
  // rating already surfaces the label at zoom ≤ 8).
  const [placemarkStations, setPlacemarkStations] = useState<Set<string>>(new Set())
  // Which rating categories to filter to — empty means "show all" (no filter active).
  // "unrated" is a pseudo-category for stations without any rating.
  // Empty set = no filter = all stations visible. Not persisted — rating
  // filters reset to "show everything" on every reload, matching the rest
  // of the filter state.
  // Default: start with the three positive ratings ticked so new visitors
  // see a focused map (curated picks only), not every rated station plus
  // every "Okay" and every "Unknown". Admins can click extras on manually.
  // Keys are stringified numeric ratings ("4","3","2","1") plus
  // "unrated" for the no-walks pseudo-category. Strings (not numbers)
  // because Set membership for the filter UI is keyed by string —
  // matches the `key` field in RATING_FILTERS in filter-panel.tsx.
  const [visibleRatings, setVisibleRatings] = useState<Set<string>>(
    () => new Set(["4", "3", "2", "1"]),
  )

  // Photo curations — per-station approved photo list + pinned-ids subset.
  // Loaded from data/photo-curations.json via API. Only used in admin mode.
  // Invariant: all ids in pinnedIds appear at the start of approved[], in the
  // same relative order as they do in approved[].
  type CurationEntry = { name: string; approved: FlickrPhoto[]; pinnedIds?: string[] }
  const [curations, setCurations] = useState<Record<string, CurationEntry>>({})

  // Station notes — public (visible to all) and private (admin-only) text per station
  type NotesEntry = {
    name: string
    publicNote: string
    privateNote: string
    /** Admin's full unfiltered single-block prose: every walk + every
     *  note for the station, joined with \n\n. Set by
     *  scripts/build-rambler-notes.mjs. Replaces legacy `ramblerNote`. */
    adminWalksAll?: string
    /** Public sectioned prose — station-to-station walks STARTING at
     *  this station. 3-walks-per-section quota. */
    publicWalksS2S?: string
    /** Public sectioned prose — station-to-station walks ENDING at
     *  this station. Same 3-walks-per-section quota as publicWalksS2S. */
    publicWalksS2SEnding?: string
    /** Public sectioned prose — circular walks. Same 3-walks-per-section
     *  filter as publicWalksS2S. */
    publicWalksCircular?: string
  }
  const [stationNotes, setStationNotes] = useState<Record<string, NotesEntry>>({})

  // Months metadata per station. Purely a build output derived from each
  // walk variant's structured `bestSeasons` month-code field (aggregated
  // in scripts/build-rambler-notes.mjs). Not editable — the source of
  // truth is the per-walk data. Used by two filters: the admin "Month"
  // dropdown and the public "Best in {current-month}" checkbox.
  type MonthsEntry = { name: string; months: MonthCode[] }
  const [stationMonths, setStationMonths] = useState<Record<string, MonthsEntry>>({})

  // Set of coordKeys for stations with at least one personally-walked
  // variant. Derived from `previousWalkDates` by the build script and
  // served as a flat string[]; we wrap in a Set for O(1) lookups in the
  // "Undiscovered" admin filter (which hides anything in this set).
  const [stationsHiked, setStationsHiked] = useState<Set<string>>(new Set())

  // Set of coordKeys for stations with at least one attached walk that
  // has a non-empty komootUrl. Derived by the build script and served
  // as a flat string[]; wrapped in a Set for O(1) lookups in the
  // admin-only "Komoot" feature filter.
  const [stationsWithKomoot, setStationsWithKomoot] = useState<Set<string>>(new Set())

  // Set of coordKeys for stations matching the "Potential month data"
  // criteria — has Komoot, no public-walk months, but month metadata on
  // ≥1 admin-only walk. Drives the admin-only feature filter of the
  // same name, surfacing destinations where existing admin month data
  // could be promoted to a public walk.
  const [stationsPotentialMonths, setStationsPotentialMonths] = useState<Set<string>>(new Set())

  // Per-station custom Flickr tag config (the "custom" fallback step). Only
  // stations with an entry participate in that step — everything else skips
  // straight to the next algo in the chain. The algo itself (landscapes /
  // station) is now decided per-station based on cluster/excluded membership.
  type FlickrSort = "relevance" | "interestingness-desc"
  type CustomSettings = { includeTags: string[]; excludeTags: string[]; radius: number; sort?: FlickrSort }
  type FlickrCustomEntry = { name?: string; custom: CustomSettings }
  const [flickrSettings, setFlickrSettings] = useState<Record<string, FlickrCustomEntry>>({})

  // Global Flickr presets (landscapes/hikes/station). Hydrated from
  // /api/dev/flickr-presets. Editing any of these affects every station that
  // uses that algo.
  type Presets = { landscapes: CustomSettings; hikes: CustomSettings; station: CustomSettings }
  const [presets, setPresets] = useState<Presets | null>(null)

  // Fetch universal ratings and photo curations on mount
  useEffect(() => {
    fetch("/api/dev/walk-ratings")
      .then((res) => res.json())
      .then((data) => setRatings(data))
    fetch("/api/dev/curate-photo")
      .then((res) => res.json())
      .then((data) => setCurations(data))
    fetch("/api/dev/station-notes")
      .then((res) => res.json())
      .then((data) => setStationNotes(data))
    fetch("/api/dev/station-months")
      .then((res) => res.json())
      .then((data) => setStationMonths(data))
    fetch("/api/dev/stations-hiked")
      .then((res) => res.json())
      .then((data: string[]) => setStationsHiked(new Set(data)))
    fetch("/api/dev/stations-with-komoot")
      .then((res) => res.json())
      .then((data: string[]) => setStationsWithKomoot(new Set(data)))
    fetch("/api/dev/stations-potential-months")
      .then((res) => res.json())
      .then((data: string[]) => setStationsPotentialMonths(new Set(data)))
    // Admin-only "Source" filter index. Re-shapes the served
    // { [orgSlug]: coordKey[] } into { [orgSlug]: Set<coordKey> } for
    // O(1) membership lookups inside passesFeatureFilter. Tolerates a
    // missing file (initial dev install before the build ran) by
    // leaving the state as the empty record.
    fetch("/api/dev/stations-by-source")
      .then((res) => res.json())
      .then((data: Record<string, string[]>) => {
        const out: Record<string, Set<string>> = {}
        for (const [org, keys] of Object.entries(data ?? {})) out[org] = new Set(keys)
        setStationsBySource(out)
      })
      .catch(() => { /* derived file may not exist yet — leave empty */ })
    fetch("/api/dev/flickr-settings")
      .then((res) => res.json())
      .then((data) => setFlickrSettings(data))
    fetch("/api/dev/flickr-presets")
      .then((res) => res.json())
      .then((data: Presets) => setPresets(data))
    // Stations flagged as "has issue" (admin triage). Server returns a
    // flat string[] of coordKeys; we wrap it in a Set for O(1) lookups.
    fetch("/api/dev/has-issue-station")
      .then((res) => res.json())
      .then((keys: string[]) => setIssueStations(new Set(keys)))
    // Stations flagged as "placemark" (force label visible at zoom 8+).
    // Same shape as has-issue-stations: flat string[] wrapped in a Set.
    fetch("/api/dev/toggle-placemark")
      .then((res) => res.json())
      .then((keys: string[]) => setPlacemarkStations(new Set(keys)))
  }, [])


  // Drives the grow-in animation for newly-appearing icons (isNew features).
  const [iconScale, setIconScale] = useState(0.01)
  // Drives the shrink-out animation for disappearing icons (isLeaving features).
  // Starts at 1 (full size) and animates down to 0.01 when a category is unchecked.
  const [leaveScale, setLeaveScale] = useState(1)

  // Tracks which rating categories were visible before the latest filter change.
  // Used by newlyAddedRatings/newlyRemovedRatings memos to detect what changed.
  // Must be STATE (not a ref) so updating it triggers a re-render — otherwise
  // the memos return stale cached values and leaving features reappear.
  // Only updated when the animation completes, keeping newlyRemovedRatings
  // non-empty throughout the leave animation so features stay on the map.
  // Initialised to match visibleRatings so the initial load doesn't treat
  // every default-checked category as "newly added" — that would stamp every
  // station with isNew, render them at iconScale (0.01 = invisible), and
  // leave them stuck there because the grow-in animation effect bails when
  // stationsForMap is still null on the first mapReady transition.
  const [prevVisibleRatings, setPrevVisibleRatings] = useState<Set<string>>(
    () => new Set(["4", "3", "2", "1"]),
  )

  const [searchQuery, setSearchQuery] = useState("")
  // Only filter once the user has typed at least 3 characters
  const isSearching = searchQuery.length >= 3

  // On mobile, highlight stations appear a zoom level earlier (6 vs 7)
  // so the best stations are visible sooner at arm's length.
  // Same 768px breakpoint (md) used across the app.
  const [isMobile, setIsMobile] = useState(false)
  useEffect(() => {
    const mq = window.matchMedia("(max-width: 767px)")
    setIsMobile(mq.matches)
    const update = () => setIsMobile(mq.matches)
    mq.addEventListener("change", update)
    return () => mq.removeEventListener("change", update)
  }, [])

  // Searchable list of LONDON NATIONAL RAIL stations — used by the dropdown's
  // search bar to let users pick their own home station as the custom primary.
  // Restricted to:
  //   1. Stations inside the greater-London bounding box (lat 51.28-51.70,
  //      lng -0.55-0.30), so hits are always "a London home station".
  //   2. Stations whose OSM `network` tag lists "National Rail" or
  //      "Elizabeth line". Tube-only and Overground-only stations (e.g.
  //      Hampstead Heath, which is London Overground but not NR) are
  //      EXCLUDED — they'd produce no usable journey data as primaries.
  //   3. Stations with a CRS code, mirroring the condition on origin-routes
  //      RTT fetches (no CRS = no timetable data).
  //   4. Stations NOT listed in data/excluded-primaries.json — a separate
  //      curated list of London NR stations that technically qualify but
  //      have no RTT-reachable hub (e.g. Kensington Olympia's sparse
  //      event-day-only service). Distinct from data/buried-stations.json,
  //      which buries stations as DESTINATIONS at low zoom; this list
  //      excludes them as HOME stations.
  // Memoized on baseStations so it's rebuilt once per data load.
  const excludedPrimariesSet = useMemo(
    () => new Set(excludedPrimariesList as string[]),
    [],
  )
  // Building-duplicate detection. OSM tags some interchanges as separate
  // features per network — e.g. Paddington has a "Paddington" feature
  // (the National Rail interchange node, CRS = PAD) AND a "Paddington
  // (Elizabeth line)" feature for the Liz line platforms (CRS = PDX).
  // Both pass the friend-search NR-or-Liz network filter, so without
  // suppression the user sees two "Paddington" rows for the same building.
  // Detection: parenthesized name pattern "X (Y)" + a base "X" feature
  // within ~500m. Returns the IDs to hide. Currently catches PDX (Liz
  // line Paddington) and LSX (Liz line Liverpool Street); other "(X)"
  // suffixes (Underground, heritage railways) are already filtered out
  // by the network check.
  // Names shared by multiple NR stations across the country — the
  // displayLabel for each colliding row gets a parenthetical county
  // disambiguator appended so the user can tell them apart in search
  // results. Without this, "Charing Cross" matches CHX (London) AND
  // CHC (Glasgow) with visually identical rows. Currently catches 11
  // collision groups: Bramley, Charing Cross, Earlswood, Gillingham,
  // Millbrook, Moreton, Northumberland Park, Rainham, St Margarets,
  // Waterloo, Whitchurch.
  const nameCollisions = useMemo(() => {
    if (!baseStations) return new Set<string>()
    // Plain object rather than Map — `Map` is shadowed by react-map-gl.
    const counts: Record<string, number> = {}
    for (const f of baseStations.features) {
      const name = f.properties?.name as string | undefined
      const crs = f.properties?.["ref:crs"] as string | undefined
      const network = f.properties?.network as string | undefined
      if (!name || !crs) continue
      if (!network || !/National Rail|Elizabeth line|London Overground/.test(network)) continue
      counts[name] = (counts[name] ?? 0) + 1
    }
    const out = new Set<string>()
    for (const [name, count] of Object.entries(counts)) {
      if (count > 1) out.add(name)
    }
    return out
  }, [baseStations])
  const buildingDuplicates = useMemo(() => {
    if (!baseStations) return new Set<string>()
    // Plain object rather than Map — `Map` is shadowed by the
    // react-map-gl import at the top of this file.
    const baseByName: Record<string, [number, number]> = {}
    for (const f of baseStations.features) {
      const name = f.properties?.name as string | undefined
      if (!name || /\(/.test(name)) continue
      baseByName[name] = f.geometry.coordinates as [number, number]
    }
    const out = new Set<string>()
    for (const f of baseStations.features) {
      const name = f.properties?.name as string | undefined
      const crs = f.properties?.["ref:crs"] as string | undefined
      if (!name || !crs) continue
      const m = name.match(/^(.+?)\s*\([^)]+\)$/)
      if (!m) continue
      const baseCoord = baseByName[m[1] as string]
      if (!baseCoord) continue
      const [lng1, lat1] = baseCoord
      const [lng2, lat2] = f.geometry.coordinates as [number, number]
      // Equirectangular approximation — distance in metres. Plenty
      // accurate at the 500m scale we care about, and avoids importing
      // a haversine helper for one site.
      const dLat = (lat2 - lat1) * 111320
      const dLng = (lng2 - lng1) * 111320 * Math.cos(((lat1 + lat2) / 2) * Math.PI / 180)
      if (Math.hypot(dLat, dLng) < 500) out.add(crs)
    }
    // Also hide same-station aliases known to TERMINUS_COORD_ALIASES
    // (SPL = HS1 St Pancras concourse, ~80m from STP main). The OSM
    // naming there doesn't follow the "X (Y)" pattern above ("London
    // St. Pancras International" vs "St Pancras International") so the
    // proximity rule alone misses them.
    for (const aliasFrom of Object.keys(TERMINUS_COORD_ALIASES)) {
      out.add(aliasFrom)
    }
    return out
  }, [baseStations])
  const searchableStations = useMemo(() => {
    if (!baseStations) return []
    // Each entry now carries:
    //   - coord: the station's own coord (what gets selected when tapped).
    //   - name: the station's own OSM name (what the user searches against).
    //   - crs: 3-letter CRS code.
    //   - primaryCoord: the effective primary origin this station maps to.
    //       For cluster members (St Pancras, Euston, Waterloo East, KX NR)
    //       this is the PARENT primary coord. For isolated stations, it's
    //       the same as coord. Used by the filter-panel to dedupe matches
    //       from the same cluster.
    //   - displayLabel: what to render in the dropdown results. For
    //       cluster primaries, it's the cluster's menuName ("Kings Cross,
    //       St Pancras, & Euston"). For isolated stations, just the
    //       station name.
    //   - hasData: true when the station is fully usable as a primary —
    //       RTT data present AND (terminus OR has TfL hops to all 15
    //       termini in tfl-hop-matrix). Stations with RTT data alone
    //       fall back to "Coming soon" disabled rows in search because
    //       custom-primary composition into central London needs the
    //       hop coverage to work.
    type SearchableStation = {
      coord: string
      name: string
      crs: string
      primaryCoord: string
      displayLabel: string
      hasData: boolean
      ineligibleLabel?: string
      searchKeywords?: string[]
    }
    // Strict hasData definition: a station counts as "fully usable as a
    // primary" only when both RTT and TfL-hop data are available.
    //   - Termini get a free pass (they ARE central London — no TfL
    //     hops needed to compose journeys).
    //   - Non-terminus primaries need an entry in tfl-hop-matrix.json,
    //     keyed by the station's name.
    // Stations with RTT data only (no TfL hops) would partially work
    // as primaries (direct destinations from their own lines render)
    // but custom-primary composition into central London breaks, so
    // we render them as 'Coming soon' disabled rows in search.
    const dataIds = new Set(Object.keys(originRoutesData))
    const TERMINI_CRS = new Set([
      "KGX","STP","EUS","CHX","VIC","WAT","WAE","MYB","PAD",
      "MOG","LST","CST","FST","BFR","LBG",
    ])
    const tflHopNames = new Set(Object.keys(terminalMatrix))
    // origin-routes is ID-keyed post Phase 2a; the data lookup is by
    // station ID throughout post Phase 3c.
    const hasFullData = (id: string): boolean => {
      if (!dataIds.has(id)) return false
      const entry = (originRoutesData as Record<string, { crs?: string; name?: string }>)[id]
      if (!entry?.crs) return false
      if (TERMINI_CRS.has(entry.crs)) return true
      return tflHopNames.has(entry.name ?? "")
    }
    const out: SearchableStation[] = []
    // No bounding-box filter post Phase 5a — primary search shows
    // UK-wide stations. Eligibility (RTT-coverage "ready") gates which
    // ones can be picked; everything else surfaces greyed-out with the
    // appropriate label ("Coming soon" / "TfL station — no data" / etc.).
    for (const f of baseStations.features) {
      const crs = f.properties?.["ref:crs"] as string | undefined
      if (!crs) continue
      const [lng, lat] = f.geometry.coordinates
      // No network filter — TfL/Underground/DLR stations surface too,
      // greyed-out with "TfL station — no data" labels via the
      // eligibility predicate below. Without this, users searching for
      // a station name shared with an Underground variant (e.g. typing
      // "Bank") wouldn't see the Underground row at all.
      const coord = `${lng},${lat}`
      // For real NR stations the CRS IS the canonical station ID; for
      // TfL/etc., the synthetic 4-char ID we put in `ref:crs` already
      // serves the same role.
      const id = crs
      if (excludedPrimariesSet.has(coord)) continue
      // Same-building OSM duplicates (e.g. PDX = Liz-line Paddington,
      // sitting next to PAD = NR Paddington) get hidden so the user
      // doesn't see two "Paddington" rows for the same place.
      if (buildingDuplicates.has(id)) continue
      const stationName = f.properties.name as string
      // Resolve to the parent cluster primary if this station is a
      // cluster member. clusterMemberToPrimary is keyed by member ID
      // (post Phase 3c) and returns the anchor ID.
      const primaryAnchor = clusterMemberToPrimary[id] ?? id
      // Cluster-membership is read from ALL_CLUSTERS so destination-
      // only clusters (Windsor, Maidstone…) collapse member rows under
      // the cluster's displayName, just like primary-side clusters do.
      // Falls back to PRIMARY_ORIGINS' menuName when present (preserves
      // the "Central London" wording for the London cluster).
      const hasCluster = !!ALL_CLUSTERS[primaryAnchor]
      let displayLabel = hasCluster
        ? (getOriginDisplay(primaryAnchor)?.menuName
          ?? ALL_CLUSTERS[primaryAnchor]?.displayName
          ?? stationName)
        : stationName
      // Disambiguate name collisions (Charing Cross London vs Glasgow,
      // Waterloo London vs Merseyside, etc.) by appending the county.
      // Only applies when the station's own name collides AND the row
      // isn't being labelled by a cluster — clusters already have unique
      // names ("Birmingham", "Central London") and don't need it.
      if (!hasCluster && nameCollisions.has(stationName)) {
        const rawCounty = f.properties?.county as string | undefined
        // Strip the " City" suffix on Scottish council areas (Glasgow
        // City / Aberdeen City / Dundee City) — UK readers expect the
        // city name alone in a station-disambiguator parenthetical.
        const county = rawCounty?.replace(/ City$/, "")
        if (county) displayLabel = `${displayLabel} (${county})`
      }
      // Eligibility: any station with full V2 RTT data + Saturday
      // morning service (rtt-coverage.json says "ready"). Phase 5a
      // dropped the stricter hasFullData check — under unified
      // eligibility, the existing customHubs composition handles
      // routing for primaries outside London just like it does for
      // CLJ-style customs. Pre-5a's TfL-hops requirement excluded
      // Exeter / Plymouth / Bath / Bristol / etc. from being pickable
      // even though their RTT data is fine.
      //
      // Cluster-member rows inherit their cluster anchor's status when
      // it's eligible (rare case — most cluster members of friend-
      // eligible clusters aren't redirected on the primary side, since
      // CLON members are the exception that stay individually selectable).
      const idStatus = getStationStatus(getStation(id), RTT_COVERAGE)
      const anchorStatus = primaryAnchor !== id && ALL_CLUSTERS[primaryAnchor]
        ? getClusterStatus(ALL_CLUSTERS[primaryAnchor].members, (m) => getStation(m), RTT_COVERAGE)
        : null
      const hasData = idStatus.eligible || (anchorStatus?.eligible ?? false)
      const ineligibleLabel = hasData
        ? undefined
        : (idStatus.eligible ? "Coming soon" : idStatus.label)
      out.push({
        // SearchableStation.coord stays in the type for back-compat
        // with the filter-panel prop shape, but its value is now a
        // canonical station ID. All consumers compare it against
        // primaryOrigin / friendOrigin (also IDs).
        coord: id,
        name: stationName,
        crs,
        primaryCoord: primaryAnchor,
        displayLabel,
        hasData,
        ineligibleLabel,
      })
    }
    // Synthetic anchors (Central London, Stratford, Windsor, Maidstone…)
    // aren't in OSM but we still want them findable by typing their
    // name directly. The dedupe-by-primaryCoord step in matchingStations
    // collapses any overlap with cluster-member rows.
    //
    // Iterates EVERY cluster, not just primary-flagged ones, so
    // destination-only clusters (Windsor, Maidstone, Folkestone,
    // Canterbury) also appear as findable rows. Their hasData stays
    // false — the dropdown renders them as "Coming soon" disabled rows
    // until they're promoted to primary origins. Bypasses the London
    // bbox filter above, which is critical for clusters like Maidstone
    // and Folkestone whose member coords sit east of the bbox.
    const seenAnchors = new Set<string>()
    // Primary-flagged synthetic clusters (CLON, CSTR) — fully usable as
    // primaries because the cluster covers routing via terminal-matrix
    // even though the synthetic anchor itself has no origin-routes entry.
    //
    // CLON gets searchKeywords with each member terminus's displayName
    // so typing "Paddington" or "Charing Cross" surfaces the "Central
    // London" row in addition to the member's own row. Other clusters
    // don't get this — only CLON, by user request.
    for (const anchorId of Object.keys(PRIMARY_ORIGIN_CLUSTER)) {
      seenAnchors.add(anchorId)
      const display = getOriginDisplay(anchorId)
      const label = display?.menuName ?? display?.canonicalName ?? anchorId
      const searchKeywords = anchorId === "CLON"
        ? (PRIMARY_ORIGIN_CLUSTER[anchorId] ?? [])
            .map((m) => getOriginDisplay(m)?.displayName)
            .filter((n): n is string => !!n)
        : undefined
      out.push({
        coord: anchorId,
        name: label,           // searchable via "central london" / "stratford"
        crs: "",
        primaryCoord: anchorId,
        displayLabel: label,
        hasData: true,
        searchKeywords,
      })
    }
    for (const [anchorId, def] of Object.entries(ALL_CLUSTERS)) {
      if (seenAnchors.has(anchorId)) continue
      // Cluster-level eligibility — eligible if any member is. The label
      // (when ineligible) reflects the most-hopeful member status.
      const status = getClusterStatus(
        def.members,
        (id) => getStation(id),
        RTT_COVERAGE,
      )
      out.push({
        coord: anchorId,
        name: def.displayName, // searchable via "windsor" / "maidstone"
        crs: "",
        primaryCoord: anchorId,
        displayLabel: def.displayName,
        // Destination-only clusters can't act as primaries yet — render
        // disabled with the predicate's specific reason ("Coming soon"
        // typically; could be "Ghost station" or a network label if every
        // member is ineligible for those reasons).
        hasData: false,
        ineligibleLabel: status.eligible ? "Coming soon" : status.label,
      })
    }
    return out
  }, [baseStations, excludedPrimariesSet, clusterMemberToPrimary])
  // Origin-id → display-name lookup. Used to render the recents list
  // in the filter-panel dropdown, and to show the custom primary's
  // name in the trigger / map label. Keyed by station ID so callers
  // looking up via primaryOrigin / friendOrigin (both IDs post Phase
  // 3c) hit the right entry. Field name retained for back-compat
  // with the filter-panel prop shape.
  const coordToName = useMemo(() => {
    const map: Record<string, string> = {}
    for (const s of searchableStations) map[s.coord] = s.name
    return map
  }, [searchableStations])

  // Cluster-member → anchor lookup for friend origins. Mirrors
  // clusterMemberToPrimary on the friend side so picking a cluster
  // member (e.g. Birmingham Moor Street, Cardiff Queen Street) via
  // friend search activates the parent cluster rather than the
  // individual station. Also includes the synthetic-PRIMARY clusters
  // (Central London, Stratford) so their cluster members fold under
  // the synthetic anchor in friend search the same way Birmingham's
  // do — without this, "St Pancras" in friend search would appear as
  // its own row instead of collapsing under "Central London".
  const friendClusterMemberToPrimary = useMemo(() => {
    const map: Record<string, string> = {}
    // Iterate every cluster — friend, primary, or destination-only.
    // Member-name-to-anchor redirect must work uniformly so the friend
    // dropdown collapses cluster members under their anchor regardless
    // of selectability.
    for (const [anchor, def] of Object.entries(ALL_CLUSTERS)) {
      for (const m of def.members) map[m] = anchor
    }
    return map
  }, [])

  // Searchable universe for the friend dropdown — every UK NR station
  // (no London-box filter — friends live anywhere). Each entry's
  // hasData flag tells the dropdown whether to render the row enabled
  // or as a disabled 'Coming soon' tooltip row. hasData is true for
  // coords that map to a friend in FRIEND_ORIGINS (either directly or
  // via a cluster-member redirect).
  const searchableFriendStations = useMemo(() => {
    if (!baseStations) return []
    type SearchableStation = {
      coord: string
      name: string
      crs: string
      primaryCoord: string
      displayLabel: string
      hasData: boolean
      ineligibleLabel?: string
      searchKeywords?: string[]
    }
    // Phase 5b.ii: friend eligibility is unified with primary eligibility.
    // A station/cluster is friend-eligible iff it has routing data — either
    // a raw RTT entry or a cluster-aggregated synthetic entry from
    // lib/origin-routes.ts. The Phase 5b.ii ensureOriginLoaded path computes
    // friend journey times on the fly for non-curated friends, so any
    // RTT-eligible station can be picked. Pre-built journey files (registry's
    // journeySlug) still get used preferentially when present.
    const isFriendEligible = (id: string): boolean =>
      originRoutes[id] != null || getStation(id)?.journeySlug != null
    // Synthetic primary clusters (Central London, Stratford) collapse
    // member rows to their anchor for the displayLabel even though they
    // don't have friend journey files yet — hasData stays false so the
    // dropdown renders them as "Coming soon" rows.
    const syntheticAnchorMenuName = (anchor: string): string | undefined =>
      getOriginDisplay(anchor)?.menuName
      // Destination-only clusters aren't in the origin registry as
      // pickable, so fall through to the cluster's displayName.
      // Without this, member rows for Windsor/Maidstone/etc. would
      // display as "Windsor and Eton Riverside" instead of "Windsor".
      ?? ALL_CLUSTERS[anchor]?.displayName
    const out: SearchableStation[] = []
    for (const f of baseStations.features) {
      const crs = f.properties?.["ref:crs"] as string | undefined
      if (!crs) continue
      // No network filter — TfL/Underground/DLR stations surface too,
      // greyed-out with "TfL station — no data" labels via the predicate
      // below. Keeps friend-search consistent with primary-search and
      // lets users see Underground duplicates of NR stations rather than
      // wondering why a typed name doesn't match anything.
      const [lng, lat] = f.geometry.coordinates
      const coord = `${lng},${lat}`
      const stationName = f.properties.name as string
      // Cluster-member visibility rules. Three cases:
      //
      //   • CLON members (CHX, MYB, PAD, …): always emitted as individual
      //     rows. Each terminus is a meaningful search target in its own
      //     right; the user expects "Paddington" to surface a Paddington
      //     row even though it's a CLON member.
      //
      //   • Members of OTHER clusters whose anchor IS friend-eligible
      //     (BHM in CBIR, CDF in CCAR, …): skipped at emission. The
      //     cluster anchor itself is added below in the synthetic loop;
      //     a member row would just dedupe-redundant-fold to the same
      //     primaryCoord, so we save the work.
      //
      //   • Members of clusters whose anchor is NOT friend-eligible
      //     (EXT/EXC in CEXE, etc.): skipped UNLESS the member is
      //     individually friend-eligible (EXD has its own journey file
      //     under public/journeys/exeter.json). The eligible member
      //     keeps its row; the others have nothing to surface.
      //
      // Non-cluster stations (NOT, BRI, OXF, …) always emit normally.
      // Same-building OSM duplicates (PDX, LSX) hidden in friend search
      // for the same reason as in primary search above.
      if (buildingDuplicates.has(crs)) continue
      const clusterAnchor = friendClusterMemberToPrimary[crs]
      const isClonMember = clusterAnchor === "CLON"
      if (clusterAnchor && !isClonMember && !isFriendEligible(crs)) continue
      const anchorId = (clusterAnchor && !isClonMember && isFriendEligible(clusterAnchor))
        ? clusterAnchor
        : crs
      const anchorMenuName = syntheticAnchorMenuName(anchorId)
      const hasData = isFriendEligible(anchorId)
      let displayLabel = anchorMenuName ?? stationName
      // Disambiguate name collisions (Charing Cross London vs Glasgow,
      // Waterloo London vs Merseyside, etc.) by appending the county.
      // The station-keyed-row check (`anchorId === crs`) — not a
      // truthy-anchorMenuName check — gates this: getOriginDisplay
      // always returns a menuName via fallbacks, so anchorMenuName is
      // truthy even for plain station rows.
      if (anchorId === crs && nameCollisions.has(stationName)) {
        const rawCounty = f.properties?.county as string | undefined
        // Strip the " City" suffix on Scottish council areas (Glasgow
        // City / Aberdeen City / Dundee City) — UK readers expect the
        // city name alone in a station-disambiguator parenthetical.
        const county = rawCounty?.replace(/ City$/, "")
        if (county) displayLabel = `${displayLabel} (${county})`
      }
      // For ineligible rows, use the registry-backed predicate to find
      // the SPECIFIC reason (TfL/Ghost/Coming soon). Friend hasData uses
      // FRIEND_ANCHORS_WITH_DATA (a curated list) — until the eligibility
      // unification phase lands, a station can be predicate-eligible but
      // still friend-ineligible (no journey file yet). Default-label
      // "Coming soon" handles that gap.
      let ineligibleLabel: string | undefined
      if (!hasData) {
        const status = getStationStatus(getStation(crs), RTT_COVERAGE)
        ineligibleLabel = status.eligible ? "Coming soon" : status.label
      }
      out.push({
        // SearchableStation.coord stays in the type for back-compat
        // with the filter-panel prop shape, but its value is a
        // canonical ID — same convention as the primary searchableStations.
        coord: crs,
        name: stationName,
        crs,
        primaryCoord: anchorId,
        displayLabel,
        hasData,
        ineligibleLabel,
      })
    }
    // Synthetic anchors (Birmingham, Manchester, Edinburgh, Central
    // London, Stratford, …) aren't in OSM but we still want them
    // findable by typing their display name directly. Mirrors the
    // primary-search loop above — without these entries, a user
    // typing "Birmingham" or "Central London" relies on a cluster
    // member's OSM coord matching the cluster JSON exactly, which
    // can't be guaranteed. With them, the synthetic itself is a
    // first-class search hit and any cluster-member matches collapse
    // to the same primaryCoord during dedupe.
    //
    // Includes synthetics from BOTH FRIEND_ORIGINS (Birmingham &c.)
    // and PRIMARY_ORIGINS (Central London, Stratford) — the primary-
    // only synthetics surface in friend search the same way friend
    // synthetics do. hasData is gated on FRIEND_ORIGINS so primary-
    // only synthetics render as "Coming soon" until they're wired up
    // as friends with their own journey-data file.
    const seenSyntheticAnchors = new Set<string>()
    const addSyntheticEntry = (anchorId: string, hasData: boolean) => {
      if (seenSyntheticAnchors.has(anchorId)) return
      seenSyntheticAnchors.add(anchorId)
      const display = getOriginDisplay(anchorId)
      const label = display?.menuName ?? display?.canonicalName ?? anchorId
      // CLON-only: also match when the user types any member terminus
      // name ("Paddington", "Charing Cross", …). Surfaces "Central London"
      // alongside the member's own row — special-case this cluster only.
      const searchKeywords = anchorId === "CLON"
        ? (PRIMARY_ORIGIN_CLUSTER[anchorId] ?? [])
            .map((m) => getOriginDisplay(m)?.displayName)
            .filter((n): n is string => !!n)
        : undefined
      // Ineligible cluster rows label themselves via getClusterStatus.
      let ineligibleLabel: string | undefined
      if (!hasData) {
        const status = getClusterStatus(
          ALL_CLUSTERS[anchorId]?.members ?? [],
          (id) => getStation(id),
          RTT_COVERAGE,
        )
        ineligibleLabel = status.eligible ? "Coming soon" : status.label
      }
      out.push({
        coord: anchorId,
        name: label,
        crs: "",
        primaryCoord: anchorId,
        displayLabel: label,
        hasData,
        ineligibleLabel,
        searchKeywords,
      })
    }
    // Friend-flagged synthetic clusters first — they have friend journey
    // files so hasData is true.
    for (const anchorId of Object.keys(FRIEND_ORIGIN_CLUSTER)) {
      addSyntheticEntry(anchorId, true)
    }
    // Primary-flagged synthetic clusters next (Central London, Stratford).
    // Phase 5b.ii unified eligibility means these route from members via
    // the aggregated originRoutes entry (lib/origin-routes.ts), so they're
    // friend-eligible just like every other cluster — hasData reflects
    // that.
    for (const anchorId of Object.keys(PRIMARY_ORIGIN_CLUSTER)) {
      addSyntheticEntry(anchorId, isFriendEligible(anchorId))
    }
    // Destination-only clusters (Windsor, Maidstone, Folkestone,
    // Canterbury) aren't flagged as origins, but still need to be
    // findable in friend search and collapse member rows under their
    // anchor. hasData=false → "Coming soon" disabled row.
    //
    // Skip when any member is INDIVIDUALLY friend-eligible — its own
    // row already covers the cluster's name (e.g. EXD's "Exeter" row
    // covers the CEXE cluster's "Exeter" displayName, so adding CEXE
    // would just produce a redundant Coming-soon "Exeter" duplicate).
    for (const [coord, def] of Object.entries(ALL_CLUSTERS)) {
      if (seenSyntheticAnchors.has(coord)) continue
      if (def.isPrimaryOrigin || def.isFriendOrigin) continue
      if (def.members.some((m) => isFriendEligible(m))) continue
      seenSyntheticAnchors.add(coord)
      const status = getClusterStatus(
        def.members,
        (id) => getStation(id),
        RTT_COVERAGE,
      )
      out.push({
        coord,
        name: def.displayName,
        crs: "",
        primaryCoord: coord,
        displayLabel: def.displayName,
        hasData: false,
        ineligibleLabel: status.eligible ? "Coming soon" : status.label,
      })
    }
    return out
  }, [baseStations, friendClusterMemberToPrimary])

  // StationModal's internals (getEffectiveJourney + display text) still speak
  // in station NAMES. Our journeys are coord-keyed now, so we re-key them to
  // canonical names just for the modal's benefit. Re-keying is cheap (max 5 keys).
  // Fallback chain: curated-primary canonicalName → custom-primary's own
  // station name (coordToName) → raw coord key. The custom-primary fallback
  // is what makes synthJourneys keyed on e.g. Kentish Town's coord show up
  // under the name "Kentish Town" in the modal's journey lookup.
  // Declared AFTER coordToName so the closure resolves cleanly — useMemo
  // captures its deps at call time and coordToName needs to be in scope.
  const modalJourneys = useMemo(() => {
    if (!displayStation?.journeys) return undefined
    const out: Record<string, JourneyInfo> = {}
    for (const [key, value] of Object.entries(displayStation.journeys)) {
      const name = getOriginDisplay(key)?.canonicalName ?? coordToName[key] ?? key
      out[name] = value
    }
    return out
  }, [displayStation?.journeys, coordToName])

  // Derived stations — overrides londonMinutes when primaryOrigin isn't Farringdon,
  // so slider filtering and Mapbox labels show the selected origin's travel times.
  // Recomputes when the user switches origin via the dropdown, without re-fetching.
  // Heavy routing pass — computes journeys, alt routes, effective
  // minutes, etc. for every feature against the active primary.
  // Deliberately NOT dependent on buriedStations: the flag is applied
  // in a cheap downstream useMemo so admin toggles don't re-trigger
  // this expensive pass (~10s stall).
  const routedStations = useMemo(() => {
    if (!baseStations) return null
    // CRS → coord lookup. Built once and shared between the diff fast
    // path's polyline augmentation (below) and the live compute path's
    // polyline assembly (further down).
    const crsToCoord: Record<string, [number, number]> = {}
    for (const f of baseStations.features) {
      const crs = f.properties?.["ref:crs"] as string | undefined
      if (!crs) continue
      const [lng, lat] = f.geometry.coordinates as [number, number]
      crsToCoord[crs] = [lng, lat]
    }
    // Display-name → that station's full journeys map. Built once so
    // multi-leg polyline builders can look up an intermediate stop's
    // sibling polylines: e.g. CLON→Sutton Coldfield's first leg ends at
    // Lichfield Trent Valley, and LTV's feature has a Farringdon-sourced
    // encoded polyline that traces the curvy WCML Euston→TAM→LTV track.
    // Without this lookup the multi-leg builder could only see
    // siblings on the FINAL destination (SUT) — which has no encoded
    // polyline anywhere — and falls back to a straight RTT chain.
    type NamedJourneys = Record<string, { polyline?: string; polylineCoords?: [number, number][] }>
    const nameToFeatureJourneys: Record<string, NamedJourneys> = {}
    for (const f of baseStations.features) {
      const name = f.properties?.name as string | undefined
      if (!name) continue
      const journeys = (f.properties as { journeys?: NamedJourneys }).journeys
      if (journeys) nameToFeatureJourneys[name] = journeys
    }
    // Helper: rebuild a precomputed journey's polyline using the
    // richest source available. Two upgrade paths, in priority order:
    //
    //   1. SIBLING ENCODED POLYLINE — when the destination feature has
    //      a sibling-origin journey (e.g. Farringdon's pre-fetched
    //      Google Routes journey) with an `polyline` encoded string,
    //      decode it and trim to the segment from the leg-departure
    //      terminal onwards. Produces real-track curves through every
    //      intermediate stop on the line. This is what makes
    //      CLON-as-primary's HND polyline follow the actual GWR track
    //      rather than zig-zag straight between stations.
    //
    //   2. RTT CRS-CHAIN FALLBACK — straight segments between every
    //      calling point's coord. Always at least as detailed as the
    //      precomputed diff entry (which sometimes trimmed to as few
    //      as 3 coords).
    //
    // Returns null when neither produces something richer than what's
    // already stored. Skips entries that already carry their own
    // encoded `polyline` string — those are already real-track.
    // Maps a station's display name (e.g. "Euston", "Birmingham New
    // Street", "Dudley Port") to its canonical station ID. Used to
    // walk a multi-leg journey's leg-departure/arrival labels back
    // into the RTT data so we can build a polyline per leg.
    // Resolution order:
    //   1. originRoutes — covers the 344 origins we've fetched, with
    //      matchTerminal canonicalisation (so "London Euston" → EUS).
    //   2. station-registry — covers EVERY named station, including
    //      destinations like "Dudley Port" that aren't fetched as
    //      origins.
    function nameToOriginRoutesId(name: string | undefined): string | undefined {
      if (!name) return undefined
      const canonical = matchTerminal(name, londonTerminals) ?? name
      for (const [id, data] of Object.entries(originRoutes)) {
        const dataCanonical = matchTerminal(data.name, londonTerminals) ?? data.name
        if (dataCanonical === canonical || data.name === canonical) return id
      }
      return registryResolveName(canonical) ?? registryResolveName(name)
    }
    // Rewrite a journey whose first leg departs OUT of the active
    // primary's cluster by prepending a leg from a cluster member
    // that reaches that station directly. Pure data-fixup: the
    // precomputed routing diffs sometimes hold stale entries whose
    // first leg starts at a non-cluster station (e.g. CLON → Sudbury
    // currently begins "Stratford → Marks Tey", with no preceding
    // London leg — implies the user is already at Stratford). The
    // displayed journey then misleads the user about where they
    // board ("from Stratford"). This rewrite fills in the missing
    // London leg using current RTT data so the modal/polyline
    // attribute the journey to a real cluster terminus the user
    // can actually start from.
    //
    // Returns the same journey object when no rewrite applies (first
    // leg already in-cluster, or no cluster member reaches the
    // out-of-cluster station). Otherwise returns a new journey with
    // an extra prepended leg + adjusted durationMinutes/changes.
    type RewritableJourney = JourneyInfo & { changes?: number; durationMinutes?: number; polylineCoords?: [number, number][]; polyline?: string }
    function prependClusterEntryLeg(journey: RewritableJourney, activeClusterMemberIds: Set<string> | undefined): RewritableJourney {
      if (!activeClusterMemberIds) return journey
      const legs = journey.legs ?? []
      if (legs.length === 0) return journey
      const firstLeg = legs[0]
      const depName = firstLeg?.departureStation
      if (!depName) return journey
      const depId = nameToOriginRoutesId(depName)
      if (!depId || activeClusterMemberIds.has(depId)) return journey
      // Find the fastest cluster-member route to depId.
      let bestMember: string | undefined
      let bestRoute: { minMinutes?: number; fastestCallingPoints?: string[]; name?: string } | undefined
      for (const memberId of activeClusterMemberIds) {
        const memberRoute = originRoutes[memberId]?.directReachable?.[depId]
        if (memberRoute?.minMinutes == null) continue
        if (!bestRoute || (bestRoute.minMinutes ?? Infinity) > memberRoute.minMinutes) {
          bestMember = memberId
          bestRoute = memberRoute
        }
      }
      if (!bestMember || !bestRoute) return journey
      const memberName = registryGetName(bestMember) ?? bestMember
      // Standard 5-minute change buffer at the interchange (depName).
      const interchangeMin = 5
      const prependedLeg = {
        vehicleType: "HEAVY_RAIL",
        departureStation: memberName,
        arrivalStation: depName,
        stopCount: Math.max(0, (bestRoute.fastestCallingPoints?.length ?? 0) - 2),
      } as JourneyInfo["legs"][number]
      return {
        ...journey,
        legs: [prependedLeg, ...legs],
        durationMinutes: (journey.durationMinutes ?? 0) + (bestRoute.minMinutes ?? 0) + interchangeMin,
        changes: (journey.changes ?? 0) + 1,
      }
    }
    // Build a multi-leg polyline by walking each leg and using the
    // richest source available per leg, then concatenating. Per leg,
    // priority order:
    //
    //   1. INTERMEDIATE SIBLING ENCODED POLYLINE — the leg's arrival
    //      station's feature may carry a sibling-origin journey with
    //      a Google-encoded polyline that already traces this leg's
    //      track. Trim it to start at the leg-departure terminal.
    //      Example: CLON→Sutton Coldfield's first leg (Euston→LTV)
    //      can borrow Farringdon's encoded polyline stored on LTV's
    //      feature, giving real WCML curves rather than the 3-coord
    //      EUS→TAM→LTV straight chain.
    //
    //   2. RTT CRS-CHAIN FALLBACK — straight segments between every
    //      calling-point coord on the leg. Always works when the
    //      origin-routes data covers the leg, but renders as zig-zag
    //      lines between station coords.
    //
    // Returns null when no leg resolves at all.
    function buildMultiLegRttPolyline(legs: Array<{ departureStation?: string; arrivalStation?: string }>): [number, number][] | null {
      const out: [number, number][] = []
      let prevLast: [number, number] | undefined
      for (const leg of legs) {
        const depId = nameToOriginRoutesId(leg.departureStation)
        const arrId = nameToOriginRoutesId(leg.arrivalStation)
        if (!depId || !arrId) continue
        let coords: [number, number][] | null = null
        // Path 1 — try intermediate sibling encoded polyline at the
        // leg's arrival station.
        const arrJourneys = leg.arrivalStation ? nameToFeatureJourneys[leg.arrivalStation] : undefined
        if (arrJourneys) {
          let bestSibling: [number, number][] | null = null
          for (const sib of Object.values(arrJourneys)) {
            if (!sib?.polyline) continue
            const decoded = decodePolyline(sib.polyline)
            if (!decoded || decoded.length < 2) continue
            const trimmed = trimSiblingPolylineToRttRoute(decoded, [depId, arrId], crsToCoord)
            if (trimmed && trimmed.length > 1 && (!bestSibling || trimmed.length > bestSibling.length)) {
              bestSibling = trimmed
            }
          }
          if (bestSibling) coords = bestSibling
        }
        // Path 2 — RTT calling-point chain.
        if (!coords) {
          const dest = originRoutes[depId]?.directReachable?.[arrId]
          if (dest?.fastestCallingPoints) {
            coords = dest.fastestCallingPoints
              .map((crs) => crsToCoord[crs])
              .filter((c): c is [number, number] => !!c)
          }
        }
        if (!coords || coords.length === 0) continue
        // Dedup the leg's first coord when it duplicates the previous
        // leg's last (same station — the change point).
        const start = prevLast
          && Math.abs(coords[0]![0] - prevLast[0]) < 1e-6
          && Math.abs(coords[0]![1] - prevLast[1]) < 1e-6
          ? 1 : 0
        for (let i = start; i < coords.length; i++) out.push(coords[i]!)
        prevLast = coords[coords.length - 1]
      }
      return out.length > 1 ? out : null
    }
    function deriveRichPolyline(
      featureId: string | undefined,
      journey: { legs?: Array<{ departureStation?: string; arrivalStation?: string }>; polyline?: string; polylineCoords?: [number, number][] },
      siblingJourneys?: Record<string, { polyline?: string; polylineCoords?: [number, number][] }>,
      activeClusterMemberIds?: Set<string>,
    ): [number, number][] | null {
      if (!featureId) return null
      if (journey.polyline) return null
      const existing = journey.polylineCoords?.length ?? 0
      const departure = journey.legs?.[0]?.departureStation
      if (!departure) return null
      const canonical = matchTerminal(departure, londonTerminals) ?? departure
      // Resolve the leg-departure name to an originRoutes member id.
      let memberId: string | undefined
      for (const [id, data] of Object.entries(originRoutes)) {
        const dataCanonical = matchTerminal(data.name, londonTerminals) ?? data.name
        if (dataCanonical === canonical || data.name === canonical) {
          memberId = id
          break
        }
      }
      // Pre-pass: when the diff entry's leg-departure is OUT of the
      // active primary's cluster (e.g. CLON's stale precomputed entry
      // for SUY says "departureStation: Stratford" but Stratford isn't
      // a CLON member), the leg-rooted trim below would start the
      // polyline at the out-of-cluster station — visibly wrong on the
      // map. In that case, ditch the leg-departure as the trim entry
      // point and use the sibling's own origin instead. Farringdon
      // (ZFD) is the typical sibling for CLON destinations: its
      // polyline starts at the Thameslink central-London core, which
      // visually reads as a sensible CLON departure even though ZFD
      // isn't formally a cluster member.
      if (siblingJourneys && activeClusterMemberIds && memberId && !activeClusterMemberIds.has(memberId)) {
        let best: [number, number][] | null = null
        for (const [sibOriginId, sibJourney] of Object.entries(siblingJourneys) as Array<[string, { polyline?: string; polylineCoords?: [number, number][] }]>) {
          // Skip the active primary's own entry — using it as the
          // sibling source would be circular (it's what we're
          // upgrading) and any out-of-cluster sibling is fine here
          // since we're already in the "diff is suspect" branch.
          if (sibOriginId === primaryOrigin) continue
          let decoded: [number, number][] | null = null
          if (sibJourney?.polyline) decoded = decodePolyline(sibJourney.polyline)
          else if (sibJourney?.polylineCoords && sibJourney.polylineCoords.length > 1) decoded = sibJourney.polylineCoords
          if (!decoded) continue
          // chain = [sibOriginId, destId] — trim joins at sibOriginId
          // (the sibling's start) and runs through to the destination.
          const trimmed = trimSiblingPolylineToRttRoute(decoded, [sibOriginId, featureId], crsToCoord)
          if (trimmed && trimmed.length > existing && (!best || trimmed.length > best.length)) {
            best = trimmed
          }
        }
        if (best) return best
      }
      // Build the calling-point chain we'll use as the trim guide. Two
      // shapes:
      //   • Single-leg journey AND the leg-departure terminal directly
      //     reaches our destination — use the full RTT calling chain.
      //     Most precise: the trim joins at every intermediate stop the
      //     train calls at.
      //   • Multi-leg journey OR no direct RTT data — fall back to a
      //     two-element chain [departure, destination]. trimSibling
      //     finds whichever coord appears first on the sibling polyline
      //     and stitches from there. For SUY (CLON→Stratford→MKT→SUY)
      //     the join lands at Stratford, then the sibling polyline
      //     fills in the curvy track all the way to SUY.
      let chain: string[] | undefined
      if (memberId) {
        const dest = originRoutes[memberId]?.directReachable?.[featureId]
        if (dest?.fastestCallingPoints) chain = dest.fastestCallingPoints
      }
      if (!chain && memberId) chain = [memberId, featureId]
      if (!chain) return null
      // Three candidate polylines. Compute all, return the longest:
      //
      //   Path 1: sibling-polyline trim. Decode (or reuse) any sibling
      //   origin's polyline and trim to start at our trim-chain entry
      //   point. Best for single-leg destinations Farringdon already
      //   has Google routes for (HND, TRI, SUY, etc.) — produces 400+
      //   coord real-track curves.
      //
      //   Path 2: multi-leg RTT assembly. For 2+ leg journeys, walk
      //   each leg and concat its RTT calling-point chain. Best for
      //   destinations no sibling polyline covers end-to-end (DDP,
      //   CSY, TIP — Birmingham-area destinations reached via
      //   Euston→BHM→destination).
      //
      //   Path 3: straight-segment fallback from the single-leg trim
      //   chain. Backstop when neither richer path produces anything.
      let best: [number, number][] | null = null
      const tryUpgrade = (candidate: [number, number][] | null) => {
        if (!candidate || candidate.length <= existing) return
        if (!best || candidate.length > best.length) best = candidate
      }
      if (siblingJourneys) {
        for (const sibJourney of Object.values(siblingJourneys) as Array<{ polyline?: string; polylineCoords?: [number, number][] }>) {
          let decoded: [number, number][] | null = null
          if (sibJourney?.polyline) decoded = decodePolyline(sibJourney.polyline)
          else if (sibJourney?.polylineCoords && sibJourney.polylineCoords.length > 1) decoded = sibJourney.polylineCoords
          if (!decoded) continue
          tryUpgrade(trimSiblingPolylineToRttRoute(decoded, chain, crsToCoord))
        }
      }
      if (journey.legs && journey.legs.length >= 2) {
        tryUpgrade(buildMultiLegRttPolyline(journey.legs))
      }
      tryUpgrade(chain.map((crs) => crsToCoord[crs]).filter((c): c is [number, number] => !!c))
      return best
    }
    // Short-circuit: if we've got a precomputed routing diff for
    // the currently active primary, reconstruct the full
    // FeatureCollection by merging the diff over baseStations and
    // skip the heavy compute below. A missing diff (no slug for this
    // primary, 404 on the file, or still loading) falls through to
    // the live compute path. This is a cheap O(features) spread —
    // no routing work — so it's fine to do it here in the memo body.
    //
    // Friend origin is NOT a reason to fall through: the friend's
    // journeys are merged into baseStations by ensureOriginLoaded
    // (see line ~1724) BEFORE this memo runs, and the journeys-merge
    // below preserves them alongside the precomputed primary routing.
    // Previously friend-set forced a live recompute that silently
    // dropped hundreds of distant stations (e.g. Belper, 114 min from
    // Central London) that the precomputed file covers correctly.
    const primarySlug = PRIMARY_SLUG[primaryOrigin]
    const diffForPrimary = primarySlug ? precomputedRoutingByPrimary[primarySlug] : null
    const isBypassed = primarySlug != null && bypassPrecomputeForSlug === primarySlug
    if (diffForPrimary && !isBypassed) {
      return {
        ...baseStations,
        features: baseStations.features.map((f) => {
          const coordKey = f.properties.coordKey as string
          const featureId = f.properties.id as string | undefined
          const delta = diffForPrimary[coordKey]
          if (!delta) return f
          // Merge the routing deltas on top of base properties. For
          // `journeys` we merge entries rather than replace, so
          // base-fetched journeys (e.g. from Farringdon, Stratford)
          // coexist with routing-added entries (e.g. the Central
          // London cluster primary).
          const nextProps: Record<string, unknown> = { ...f.properties }
          for (const [k, v] of Object.entries(delta)) {
            if (k === "journeys") {
              const merged: Record<string, JourneyInfo> = {
                ...((f.properties as Record<string, unknown>).journeys as Record<string, JourneyInfo> | undefined),
                ...(v as Record<string, JourneyInfo>),
              }
              // First pass — rewrite stale precomputed entries whose
              // first leg departs OUT of the active primary's cluster
              // (e.g. CLON's SUY entry currently begins "Stratford →
              // Marks Tey" with no preceding London leg). The rewrite
              // prepends a leg from a real cluster member that
              // actually reaches the dep station, so the modal title
              // and journey description attribute the journey to a
              // station the user can start from.
              const activeClusterMemberIds = new Set<string>([
                primaryOrigin,
                ...(PRIMARY_ORIGIN_CLUSTER[primaryOrigin] ?? []),
              ])
              const primaryEntry = merged[primaryOrigin] as JourneyInfo | undefined
              if (primaryEntry) {
                const rewritten = prependClusterEntryLeg(primaryEntry as JourneyInfo & { changes?: number; durationMinutes?: number; polylineCoords?: [number, number][]; polyline?: string }, activeClusterMemberIds)
                if (rewritten !== primaryEntry) {
                  merged[primaryOrigin] = rewritten
                  // Keep nextProps.londonMinutes consistent with the
                  // rewritten duration so the time slider + map labels
                  // reflect the real travel time including the prefixed
                  // London leg.
                  if (rewritten.durationMinutes != null) {
                    nextProps.londonMinutes = rewritten.durationMinutes
                  }
                  if (rewritten.changes != null) {
                    nextProps.effectiveChanges = rewritten.changes
                  }
                }
              }
              // Second pass — augment the ACTIVE PRIMARY'S sparse
              // polyline. Pass the merged journeys map itself as
              // siblingJourneys so deriveRichPolyline can borrow
              // encoded polylines from sibling-origin entries (e.g.
              // Farringdon's pre-fetched Google polyline) when
              // upgrading the primary's straight CRS-chain.
              // activeClusterMemberIds lets the upgrade reject sibling
              // polylines whose origin is OUTSIDE the active primary's
              // cluster (and prefer in-cluster ones when the diff's own
              // leg-departure is out-of-cluster).
              //
              // Restricted to the primary's cluster members ONLY: the
              // friend origin's journey came from its own
              // ensureOriginLoaded merge with a polyline that's already
              // correctly anchored at the friend's home. Letting
              // deriveRichPolyline run on the friend would borrow from
              // primary-side siblings (ZFD/CLON) and produce a polyline
              // that starts in central London instead of, say,
              // Nottingham — which then renders on top of the primary's
              // line and hides the friend line entirely.
              for (const [originKey, journey] of Object.entries(merged)) {
                if (!activeClusterMemberIds.has(originKey)) continue
                const richer = deriveRichPolyline(
                  featureId,
                  journey as { legs?: Array<{ departureStation?: string; arrivalStation?: string }>; polyline?: string; polylineCoords?: [number, number][] },
                  merged as Record<string, { polyline?: string; polylineCoords?: [number, number][] }>,
                  activeClusterMemberIds,
                )
                if (richer) merged[originKey] = { ...journey, polylineCoords: richer } as JourneyInfo
              }
              nextProps.journeys = merged
            } else {
              nextProps[k] = v
            }
          }
          return { ...f, properties: nextProps as StationFeature["properties"] }
        }),
      }
    }
    // Build a CRS → { coord, name, coordKey, isLondon } lookup once per
    // baseStations load. RTT's direct-reachable data stores calling points as
    // CRS codes; we need each calling point's coordinate (for polyline
    // synthesis), name (for the modal's calling-point list), coordKey (for
    // cross-referencing primary RTT data), and a London-area flag (for
    // filtering the calling-points list to stations a Londoner would recognise).
    // Plain object rather than Map<> because `Map` is shadowed by the
    // react-map-gl import at the top of this file.
    // Greater-London bounding box: lat 51.28–51.70, lng -0.55–0.30.
    const isLondonBox = (lat: number, lng: number) =>
      lat > 51.28 && lat < 51.70 && lng > -0.55 && lng < 0.30
    // crsToCoord was already built above (shared with the diff fast
    // path's polyline augmentation). Build the richer crsToStation
    // here, layering name + coordKey + isLondon on top.
    const crsToStation: Record<string, { name: string; coord: [number, number]; coordKey: string; isLondon: boolean }> = {}
    for (const f of baseStations.features) {
      const crs = f.properties?.["ref:crs"] as string | undefined
      if (!crs) continue
      const [lng, lat] = f.geometry.coordinates as [number, number]
      crsToStation[crs] = {
        name: f.properties.name as string,
        coord: [lng, lat],
        coordKey: `${lng},${lat}`,
        isLondon: isLondonBox(lat, lng),
      }
    }

    // Builds the "London calling points" + "upstream calling points" list
    // for a single (board-here, destination) pair, pulled from origin-routes
    // RTT data. Returns null when the board-here terminal has no direct-reach
    // entry for the destination.
    //
    // Both lists are filtered to London-only stops — the raw RTT data has
    // every calling point on the route (including non-London), but the modal
    // only surfaces London boarding options since the user is picking a
    // London terminus to start from.
    //
    // The primary origin is also excluded — when the user has picked e.g.
    // Stratford International as primary and same-train-shortcuts them to
    // Gravesend via a StP train, that StP train calls AT Stratford
    // International as an intermediate stop. Listing SFA as a "can also start
    // same route at" option is absurd (the user IS already at SFA).
    //
    // - downstream: stations the train calls AFTER the board-here terminal,
    //   labelled with minutes-from-board (sub.minMinutes on each intermediate
    //   station's OWN directReachable entry — filters stops the board-here
    //   terminal has no data for).
    // - upstream: stations the train calls BEFORE the board-here terminal,
    //   labelled with minutes-before-board. Comes straight from the
    //   pre-computed upstreamCallingPoints array (RTT provides it).
    const buildCallingPoints = (
      boardHereTerminalCoord: string,
      destCoord: string,
    ): { downstream: { name: string; crs: string; minutesFromOrigin: number }[]
       ; upstream: { name: string; crs: string; minutesExtra: number }[] } | null => {
      const winnerRoutes = originRoutes[boardHereTerminalCoord]
      const entry = winnerRoutes?.directReachable?.[destCoord]
      if (!entry) return null
      // Normalise station names via matchTerminal so London-terminus
      // rows render consistently across the app. Without this, the
      // same station surfaced different labels depending on data
      // source: "London St. Pancras International" from upstream RTT
      // vs "St Pancras" from the terminals list. The latter is the
      // canonical short form — use it everywhere.
      const nicerTerminusName = (fallback: string, crs: string) => {
        const station = crsToStation[crs]
        const rawName = station?.name ?? fallback
        return matchTerminal(rawName, londonTerminals) ?? rawName
      }
      const downstream = entry.fastestCallingPoints
        .slice(1, -1)
        .map((crs) => {
          const station = crsToStation[crs]
          if (!station || !station.isLondon) return null
          // Skip the primary origin itself — see header comment.
          if (crs === primaryOrigin) return null
          // origin-routes is ID-keyed post Phase 3c; crs IS the station
          // ID for any real NR station, so we look up directReachable[crs]
          // directly rather than via the legacy coordKey.
          const sub = winnerRoutes?.directReachable?.[crs]
          if (!sub) return null
          return { name: nicerTerminusName(station.name, crs), crs, minutesFromOrigin: sub.minMinutes }
        })
        .filter((p): p is { name: string; crs: string; minutesFromOrigin: number } => !!p)
      const upstream = (entry.upstreamCallingPoints ?? [])
        .map((u) => {
          const station = crsToStation[u.crs]
          if (!station || !station.isLondon) return null
          // Same reason as downstream — skip the primary origin.
          if (u.crs === primaryOrigin) return null
          return { name: nicerTerminusName(u.name, u.crs), crs: u.crs, minutesExtra: u.minutesBeforeOrigin }
        })
        .filter((p): p is { name: string; crs: string; minutesExtra: number } => !!p)
      return { downstream, upstream }
    }

    // CROSS-TERMINAL fallback used when a terminal X's own RTT data is
    // missing a destination D that is nonetheless reachable on a train
    // calling at X. Example: StP's fetch didn't capture southbound
    // Thameslink to East Croydon, but BFR's fetch DID record the same
    // train (StP appears in BFR's upstreamCallingPoints for East Croydon
    // at 9 min before BFR). We can reconstruct X → D and its calling
    // points by borrowing data from the donor terminal and re-baselining
    // times relative to X.
    //
    // Parameters:
    //   boardAtCoord — X's coord (the station the user boards at)
    //   destCoord    — D's coord (the station the user alights at)
    //
    // Returns downstream/upstream lists with times relative to X, or null
    // if no donor terminal has BOTH X and D on the same train.
    const buildCallingPointsViaDonor = (
      boardAtId: string,
      destId: string,
    ): { downstream: { name: string; crs: string; minutesFromOrigin: number }[]
       ; upstream: { name: string; crs: string; minutesExtra: number }[] } | null => {
      // Post Phase 3c: origin-routes is ID-keyed at every level, so
      // donorId / destId / boardAtId are all canonical station IDs.
      // For real NR stations the ID IS the CRS, which is how we cross-
      // reference the upstream-calling-points list (whose `crs` field
      // is on disk).
      for (const donorId of Object.keys(originRoutes)) {
        const donor = originRoutes[donorId]
        const entry = donor?.directReachable?.[destId]
        if (!entry) continue
        // Check if boardAt is represented somewhere on this train's route.
        // The train relative to the donor D looks like:
        //   [ ...upstream (negative times) ..., D (t=0), ...fastestCP[1:-1] (positive), dest ]
        // Where D's donor directReachable entry gives us t for each station.
        //
        // For a station S at time t_S relative to D:
        //   - if S is in entry.upstreamCallingPoints, t_S = -minutesBeforeOrigin
        //   - if S is in entry.fastestCallingPoints, t_S = donor.directReachable[S].minMinutes
        //   - if S is the donor itself, t_S = 0
        const boardAtInUpstream = entry.upstreamCallingPoints?.find((u) => u.crs === boardAtId)
        let boardAtT: number | null = null
        if (boardAtInUpstream) {
          boardAtT = -boardAtInUpstream.minutesBeforeOrigin
        } else if (donorId === boardAtId) {
          boardAtT = 0
        } else {
          // Check fastestCallingPoints — see if boardAt CRS appears as an
          // intermediate stop on the train from donor to destination.
          for (const crs of entry.fastestCallingPoints.slice(1, -1)) {
            if (crs === boardAtId) {
              const sub = donor?.directReachable?.[boardAtId]
              if (sub?.minMinutes != null) boardAtT = sub.minMinutes
              break
            }
          }
        }
        if (boardAtT == null) continue  // this donor's train doesn't pass through boardAt

        // Now compute times for every station on the train relative to
        // boardAt. A station S's time relative to boardAt is t_S - t_boardAt.
        // - dest is at t = entry.minMinutes
        const destT = entry.minMinutes
        // Gather all stations on the route with their time relative to donor.
        const routeStations: Array<{ name: string; crs: string; id: string; tDonor: number }> = []
        // Upstream of donor (negative tDonor).
        for (const u of entry.upstreamCallingPoints ?? []) {
          const station = crsToStation[u.crs]
          if (!station) continue
          routeStations.push({ name: u.name, crs: u.crs, id: u.crs, tDonor: -u.minutesBeforeOrigin })
        }
        // Donor itself at tDonor = 0.
        routeStations.push({
          name: donor?.name ?? "",
          crs: donor?.crs ?? "",
          id: donorId,
          tDonor: 0,
        })
        // Intermediate stops between donor and destination.
        for (const crs of entry.fastestCallingPoints.slice(1, -1)) {
          const station = crsToStation[crs]
          if (!station) continue
          const sub = donor?.directReachable?.[crs]
          if (!sub) continue
          routeStations.push({ name: station.name, crs, id: crs, tDonor: sub.minMinutes })
        }
        // Destination itself (will be filtered out below — it IS the target).
        // routeStations.push({ ..., tDonor: destT })

        // Classify each station relative to boardAt.
        const downstream: { name: string; crs: string; minutesFromOrigin: number }[] = []
        const upstream: { name: string; crs: string; minutesExtra: number }[] = []
        for (const s of routeStations) {
          // Skip boardAt, destination, and primary-origin.
          if (s.id === boardAtId) continue
          if (s.id === destId) continue
          if (s.id === primaryOrigin) continue
          const station = crsToStation[s.crs]
          if (!station || !station.isLondon) continue
          // Skip stations outside the [boardAt, dest] window — they're on
          // the train but before boardAt or after destination. Those are
          // genuinely "can also board earlier" (before boardAt) or "can
          // also alight later" — but the hint is about this specific
          // journey, so we want stations strictly between boardAt and dest.
          if (s.tDonor <= boardAtT) {
            // Before boardAt on the train — user could board even earlier.
            // Mark as upstream (extra time).
            upstream.push({ name: s.name, crs: s.crs, minutesExtra: boardAtT - s.tDonor })
          } else if (s.tDonor < destT) {
            // Between boardAt and dest. Downstream (time from boardAt).
            downstream.push({ name: s.name, crs: s.crs, minutesFromOrigin: s.tDonor - boardAtT })
          }
          // Past dest: skip (user has alighted).
        }
        return { downstream, upstream }
      }
      return null
    }

    // Enriches a multi-leg synth journey (typically custom-primary) with
    // calling-points for a selected HEAVY_RAIL leg. Selection rule, in
    // priority order:
    //
    //   1. A leg whose arrivalStation IS the feature's destination — i.e.
    //      a leg that takes the user directly to where they're going.
    //      That "direct train to {destination}" framing is what the user
    //      cares about most ("LST, Barking, Upminster as alternative starts
    //      for the train to Shoeburyness"). Among such legs, pick the one
    //      with the richest London calling-points list.
    //   2. If no destination-reaching leg yields calling points, fall back
    //      to the leg with the richest list overall. For Berwick, the last
    //      leg (Lewes→Berwick) has no London stops, so this falls through
    //      to the first HEAVY_RAIL leg (Farringdon→East Croydon) which
    //      captures the Thameslink London stops.
    //
    // Mutates synthJourney in place. If no leg has any London calling
    // points, leaves synthJourney unchanged.
    const enrichSynthJourneyCallingPoints = (
      synth: JourneyInfo,
      featureDestinationName: string,
    ): void => {
      type Picked = {
        cp: {
          downstream: { name: string; crs: string; minutesFromOrigin: number }[]
          upstream: { name: string; crs: string; minutesExtra: number }[]
        }
        arrivalName: string
        rank: number
        reachesDestination: boolean
      }
      let best: Picked | null = null
      for (const leg of synth.legs) {
        if (leg.vehicleType !== "HEAVY_RAIL") continue
        const depName = leg.departureStation
        const arrName = leg.arrivalStation
        if (!depName || !arrName) continue
        // Resolve coords via baseStations — the source-journey / RTT data
        // uses display names, and we need coord keys to look up calling
        // points. Same-name edge cases would only bite for destinations
        // with duplicated names nationally, not for mainline junctions.
        const depFeat = baseStations.features.find((x) => x.properties?.name === depName)
        const arrFeat = baseStations.features.find((x) => x.properties?.name === arrName)
        if (!depFeat || !arrFeat) continue
        const depCoord = `${depFeat.geometry.coordinates[0]},${depFeat.geometry.coordinates[1]}`
        const arrCoord = `${arrFeat.geometry.coordinates[0]},${arrFeat.geometry.coordinates[1]}`
        // Try the leg's departure terminal's own RTT data first; if the
        // departure isn't a terminal (e.g. Stratford) or has no entry for
        // the leg's arrival, fall back to donor-terminal derivation which
        // finds a terminal whose train calls at BOTH endpoints.
        const cp = buildCallingPoints(depCoord, arrCoord)
          ?? buildCallingPointsViaDonor(depCoord, arrCoord)
        if (!cp) continue
        const rank = cp.downstream.length + cp.upstream.length
        if (rank === 0) continue
        const reachesDestination = arrName === featureDestinationName
        const candidate: Picked = { cp, arrivalName: arrName, rank, reachesDestination }
        // Destination-reaching legs always beat non-destination-reaching
        // legs regardless of rank. Within the same "reaches" category,
        // prefer richer calling-points lists.
        if (
          best == null ||
          (candidate.reachesDestination && !best.reachesDestination) ||
          (candidate.reachesDestination === best.reachesDestination && candidate.rank > best.rank)
        ) {
          best = candidate
        }
      }
      if (best) {
        synth.londonCallingPoints = best.cp.downstream.length > 0 ? best.cp.downstream : undefined
        synth.londonUpstreamCallingPoints = best.cp.upstream.length > 0 ? best.cp.upstream : undefined
        synth.callingPointsLegArrival = best.arrivalName
      }
    }

    // SAME-TRAIN variant of buildCallingPoints. When the user's origin X is
    // itself on a through-train running P → … → D, we want a calling-points
    // list computed RELATIVE TO X (not P) and INCLUDING the terminal P
    // itself as a boarding option (earlier start). buildCallingPoints can't
    // do this because (a) it omits the terminal [fastestCallingPoints[0] is
    // sliced off] and (b) it labels times relative to P, not X.
    //
    // Parameters:
    //   terminalCoord      — the train's terminal P
    //   destCoord          — destination D
    //   xTimeRelativeToP   — X's time relative to P (negative if X is
    //                        upstream of P, positive if X is intermediate).
    //                        Caller computes this during the match loop.
    //
    // Output:
    //   upstream   — stations BEFORE X on the train (earlier-boarding
    //                options). Labelled with minutesExtra = extra travel time.
    //   downstream — stations AFTER X on the train (later-boarding options).
    //                Labelled with minutesFromOrigin = time saved.
    //
    // Both lists are filtered to London stops and exclude X itself.
    const buildSameTrainCallingPoints = (
      terminalId: string,
      destId: string,
      xTimeRelativeToP: number,
    ): { downstream: { name: string; crs: string; minutesFromOrigin: number }[]
       ; upstream: { name: string; crs: string; minutesExtra: number }[] } | null => {
      // Post Phase 3c: terminalId / destId are canonical station IDs.
      // For every real NR station on this through-train the ID === the
      // CRS, which is how directReachable[id] keys back into the data.
      const winnerRoutes = originRoutes[terminalId]
      const entry = winnerRoutes?.directReachable?.[destId]
      if (!entry) return null

      // Build a flat list: every station on the train (except D) with its
      // time relative to P. Positive = after P, negative = before P.
      // `id` is the station ID (CRS for real NR stops) for comparison
      // against primaryOrigin; isLondon is precomputed off crsToStation
      // so we don't have to re-parse coords during the reclassify loop.
      const route: Array<{ name: string; id: string; crs: string; tP: number; isLondon: boolean }> = []

      // P itself (the terminal). Resolve to the CANONICAL short name via
      // matchTerminal ("St Pancras" rather than "London St. Pancras
      // International" — cleaner in the calling-points line). Falls back
      // to the RTT name, then to crsToStation if present.
      const terminalCrs = winnerRoutes.crs
      const terminalStation = crsToStation[terminalCrs]
      const canonicalTerminalName =
        matchTerminal(winnerRoutes.name, londonTerminals)
        ?? terminalStation?.name
        ?? winnerRoutes.name
      route.push({
        name: canonicalTerminalName,
        id: terminalId,
        crs: terminalCrs,
        tP: 0,
        isLondon: terminalStation?.isLondon ?? false,
      })

      // Upstream of P — stations the train calls at BEFORE reaching P.
      // tP is NEGATIVE (the earlier the stop, the more negative).
      for (const u of entry.upstreamCallingPoints ?? []) {
        const station = crsToStation[u.crs]
        if (!station) continue
        route.push({
          name: u.name,
          id: u.crs,
          crs: u.crs,
          tP: -u.minutesBeforeOrigin,
          isLondon: station.isLondon,
        })
      }

      // Intermediate stops (between P and D). fastestCallingPoints[0] is P
      // (already pushed above); last entry is D (skip). tP is POSITIVE and
      // comes from the terminal's own directReachable[intermediate ID].
      for (const crs of entry.fastestCallingPoints.slice(1, -1)) {
        const station = crsToStation[crs]
        if (!station) continue
        const sub = winnerRoutes.directReachable?.[crs]
        if (!sub) continue
        route.push({ name: station.name, id: crs, crs, tP: sub.minMinutes, isLondon: station.isLondon })
      }

      // Reclassify each station relative to X. delta = tP - xTimeRelativeToP:
      //   delta < 0 → station is BEFORE X on the train → upstream (earlier
      //               boarding costs +|delta| minutes)
      //   delta > 0 → station is AFTER X → downstream (later boarding saves
      //               delta minutes)
      //   delta == 0 → station IS X → skip (trivially the user's own stop)
      // Also filter to London stops.
      const downstream: { name: string; crs: string; minutesFromOrigin: number }[] = []
      const upstream: { name: string; crs: string; minutesExtra: number }[] = []
      for (const s of route) {
        if (s.id === primaryOrigin) continue
        if (!s.isLondon) continue
        const delta = s.tP - xTimeRelativeToP
        if (delta < 0) upstream.push({ name: s.name, crs: s.crs, minutesExtra: -delta })
        else if (delta > 0) downstream.push({ name: s.name, crs: s.crs, minutesFromOrigin: delta })
      }
      return { downstream, upstream }
    }

    // Custom-primary prep. When the user picks an NR station that isn't
    // a routing hub (the historical PRIMARY_ORIGINS keyset — Central
    // London cluster + Stratford cluster + the 11 single-station
    // termini), there are no pre-fetched journeys for it. We derive
    // approximate times using RTT data from the hub primaries as a
    // transfer point:
    //   total(custom → D) ≈ P→custom + P→D + interchange
    //   where P is the fastest hub primary that direct-reaches both.
    // P→custom and P→D both come from originRoutes[P].directReachable.
    // Train times on the NR are roughly symmetric so reversing P→custom
    // to get custom→P is a safe approximation. The interchange buffer
    // covers the walk + wait at P.
    //
    // The hub keyset is hard-coded here (the only place it's needed)
    // rather than as a top-level constant — the broader curated-origin
    // concept is gone post Phase 3, but routing's hub distinction is
    // an internal optimisation that doesn't surface in the UI. Future
    // cleanup may derive this from data/london-terminals.json + the
    // registry's `journeySlug` field.
    const isCustomPrimary = !HUB_PRIMARY_IDS.has(primaryOrigin)
    // Per-station interchange buffer at the hub the user changes at.
    // interchangeBufferFor() returns the default 3-min for stations not
    // listed in data/station-interchange-buffers.json — bigger interchanges
    // (CLJ, KX, London Bridge, Reading) get more time per the curated list.

    // Extension A: via-direct-hub composition helper. For every origin-
    // routes station H that reaches BOTH the custom primary AND the
    // destination D, compose X→H (reverse of H→X) + interchange + H→D.
    // Lets "bypass central London via suburban interchange" journeys
    // win over Google's central-London routing when they're genuinely
    // faster. Example: CLJ→Penshurst via Redhill (once RDH is RTT-fetched).
    //
    // Only valuable for custom primaries. Returns the fastest 1-change
    // composition or null. Built inside the useMemo body so it can close
    // over coordToName / crsToCoord / customHubs.
    function buildViaDirectHubJourney(
      customHubsArg: Array<{ pCoord: string; pToCustomMins: number; routes: { name?: string; directReachable?: Record<string, DirectReachable> } }>,
      coordKey: string,
      customName: string,
      customCoord: string,
    ): { journey: JourneyInfo; mins: number; changes: number } | null {
      if (customHubsArg.length === 0) return null
      let best: { journey: JourneyInfo; mins: number; changes: number } | null = null
      const { lng: pLng, lat: pLat } = parseCoordKey(customCoord)
      for (const hub of customHubsArg) {
        const hubEntry = hub.routes.directReachable?.[coordKey]
        if (!hubEntry?.minMinutes) continue
        const hubName = hub.routes.name ?? ""
        const mins = hub.pToCustomMins + interchangeBufferFor(hubName) + hubEntry.minMinutes
        if (best != null && mins >= best.mins) continue
        const hubToDestCoords = (hubEntry.fastestCallingPoints ?? [])
          .map((crs) => crsToCoord[crs])
          .filter((c): c is [number, number] => !!c)
        const polylineCoords = hubToDestCoords.length > 1
          ? [[pLng, pLat] as [number, number], ...hubToDestCoords]
          : undefined
        const cp = buildCallingPoints(hub.pCoord, coordKey)
        const journey = {
          durationMinutes: mins,
          changes: 1,
          legs: [
            { vehicleType: "OTHER", departureStation: customName, arrivalStation: hubName },
            {
              vehicleType: "HEAVY_RAIL",
              departureStation: hubName,
              arrivalStation: hubEntry.name ?? "",
              stopCount: Math.max(0, (hubEntry.fastestCallingPoints?.length ?? 0) - 2),
            },
          ],
          polylineCoords,
          londonCallingPoints: cp && cp.downstream.length > 0 ? cp.downstream : undefined,
          londonUpstreamCallingPoints: cp && cp.upstream.length > 0 ? cp.upstream : undefined,
          callingPointsLegArrival: hubEntry.name,
        } as unknown as JourneyInfo
        best = { journey, mins, changes: 1 }
      }
      return best
    }
    // Extension C: TfL-hop composition for non-terminal primaries. Uses
    // the pre-fetched primary→terminal hops from data/tfl-hop-matrix.json
    // (merged into terminalMatrix at module load) to compose:
    //   2-leg: primary → T (TfL hop) → T.directReachable[D] (rail)
    //   3-leg: primary → T (TfL hop) → H (rail) → H.directReachable[D] (rail)
    //
    // 2-leg unlocks destinations directly reachable from a terminus the
    // primary doesn't have rail to (CLJ→Wendover via MYB, CLJ→WelwynGC
    // via KGX, CLJ→Hertford via LST, etc.).
    // 3-leg unlocks destinations one rail-leg deeper, where T reaches an
    // intermediate H that reaches D (CLJ→Marlow via PAD→Maidenhead,
    // CLJ→Henley-on-Thames via PAD→Twyford, etc.).
    //
    // Pure RTT — no pre-fetched source journey required, unlike
    // stitchJourney's via-source-journey path. Only fires when the
    // primary has tfl-hop-matrix entries (currently CLJ; future ECR,
    // FPK, RMD, etc. as they're added). Returns the best composition,
    // preferring fewer changes — a 1-change 2-leg path always beats a
    // 2-change 3-leg path regardless of duration.
    function tryComposeViaPrimaryHop(
      primaryName: string,
      coordKey: string,
      customCoord: string,
      featureJourneys?: Record<string, { polyline?: string }>,
    ): { journey: JourneyInfo; mins: number; changes: number } | null {
      // Canonicalise the primary name before the matrix lookup. Callers
      // pass `coordToName[primaryOrigin]` which holds the OSM `name` field
      // ("London St Pancras", "London Euston", "London King's Cross") —
      // but terminalMatrix keys come from terminal-matrix.json (canonical
      // short names: "St Pancras", "Euston", "Kings Cross") and the TfL
      // hop fetch ("St Pancras International"). Without this resolve, a
      // London-terminus custom primary (newly possible since the per-
      // terminus primary feature) bails here and never composes the
      // tube-hop path that would unlock other termini's lines —
      // e.g. STP→Euston→Tring drops Tring on the floor.
      const canonical = matchTerminal(primaryName, londonTerminals) ?? primaryName
      const hopRow = terminalMatrix[canonical]
      if (!hopRow) return null
      let best1: { journey: JourneyInfo; mins: number } | null = null
      let best2: { journey: JourneyInfo; mins: number } | null = null
      const { lng: pLng, lat: pLat } = parseCoordKey(customCoord)
      for (const T of londonTerminals) {
        const hop = hopRow[T.name]
        if (!hop?.minutes) continue
        const tCoord = findOriginRoutesCoord(T.name)
        if (!tCoord) continue
        const tRoutes = originRoutes[tCoord]
        if (!tRoutes) continue
        // Polyline prefix: TfL hop polyline (primary → T). Falls back to
        // a straight primary-coord → T-coord segment when the hop entry
        // has no polyline (rare — only WALK entries with 0min).
        const hopCoords: [number, number][] = hop.polyline
          ? decodePolyline(hop.polyline)
          : [[pLng, pLat]]
        // --- 2-leg: T direct-reaches D ---
        const tToD = tRoutes.directReachable?.[coordKey]
        if (tToD?.minMinutes != null) {
          // Interchange happens at T (TfL hop arrives at T, rail leg starts there).
          const mins = hop.minutes + interchangeBufferFor(T.name) + tToD.minMinutes
          if (best1 == null || mins < best1.mins) {
            const tToDCoordsStraight = (tToD.fastestCallingPoints ?? [])
              .map((crs) => crsToCoord[crs])
              .filter((c): c is [number, number] => !!c)
            // Polyline upgrade: if any sibling-origin journey on this
            // destination feature carries an encoded Google Routes
            // polyline (typically Farringdon, eagerly preloaded so
            // every custom primary can borrow it), trim that polyline
            // to the segment from this terminal T onwards. Replaces
            // the straight CRS-chain with real-track curves for the
            // whole rail leg.
            let tToDCoords = tToDCoordsStraight
            if (featureJourneys && tToD.fastestCallingPoints) {
              for (const sibJourney of Object.values(featureJourneys)) {
                if (!sibJourney?.polyline) continue
                const decoded = decodePolyline(sibJourney.polyline)
                const trimmed = trimSiblingPolylineToRttRoute(decoded, tToD.fastestCallingPoints, crsToCoord)
                if (trimmed && trimmed.length > tToDCoords.length) {
                  tToDCoords = trimmed
                  break
                }
              }
            }
            const polylineCoords = tToDCoords.length > 1 ? [...hopCoords, ...tToDCoords] : undefined
            const cp = buildCallingPoints(tCoord, coordKey)
            const journey = {
              durationMinutes: mins,
              changes: 1,
              legs: [
                { vehicleType: hop.vehicleType, departureStation: primaryName, arrivalStation: T.name },
                {
                  vehicleType: "HEAVY_RAIL",
                  departureStation: T.name,
                  arrivalStation: tToD.name ?? "",
                  stopCount: Math.max(0, (tToD.fastestCallingPoints?.length ?? 0) - 2),
                },
              ],
              polylineCoords,
              londonCallingPoints: cp && cp.downstream.length > 0 ? cp.downstream : undefined,
              londonUpstreamCallingPoints: cp && cp.upstream.length > 0 ? cp.upstream : undefined,
              callingPointsLegArrival: tToD.name,
            } as unknown as JourneyInfo
            best1 = { journey, mins }
          }
        }
        // --- 3-leg: T → H (rail) → H.directReachable[D] (rail) ---
        // Skip the inner loop entirely if we already have a 1-change path
        // — it'll always beat any 2-change candidate.
        if (best1 != null) continue
        for (const [hCoord, tToH] of Object.entries(tRoutes.directReachable ?? {})) {
          if (!tToH?.minMinutes) continue
          if (hCoord === coordKey) continue  // 2-leg case, handled above
          const hRoutes = originRoutes[hCoord]
          if (!hRoutes) continue
          const hToD = hRoutes.directReachable?.[coordKey]
          if (!hToD?.minMinutes) continue
          // Two interchanges: at T (after TfL hop) and at H (between rail legs).
          const mins =
            hop.minutes + interchangeBufferFor(T.name) +
            tToH.minMinutes + interchangeBufferFor(tToH.name) +
            hToD.minMinutes
          if (best2 != null && mins >= best2.mins) continue
          // Polyline: hop coords + T→H calling points + H→D calling points.
          const tToHCoords = (tToH.fastestCallingPoints ?? [])
            .map((crs) => crsToCoord[crs])
            .filter((c): c is [number, number] => !!c)
          const hToDCoords = (hToD.fastestCallingPoints ?? [])
            .map((crs) => crsToCoord[crs])
            .filter((c): c is [number, number] => !!c)
          const polylineCoords =
            tToHCoords.length + hToDCoords.length > 1
              ? [...hopCoords, ...tToHCoords, ...hToDCoords]
              : undefined
          const journey = {
            durationMinutes: mins,
            changes: 2,
            legs: [
              { vehicleType: hop.vehicleType, departureStation: primaryName, arrivalStation: T.name },
              {
                vehicleType: "HEAVY_RAIL",
                departureStation: T.name,
                arrivalStation: tToH.name ?? "",
                stopCount: Math.max(0, (tToH.fastestCallingPoints?.length ?? 0) - 2),
              },
              {
                vehicleType: "HEAVY_RAIL",
                departureStation: tToH.name ?? "",
                arrivalStation: hToD.name ?? "",
                stopCount: Math.max(0, (hToD.fastestCallingPoints?.length ?? 0) - 2),
              },
            ],
            polylineCoords,
          } as unknown as JourneyInfo
          best2 = { journey, mins }
        }
      }
      if (best1) return { journey: best1.journey, mins: best1.mins, changes: 1 }
      if (best2) return { journey: best2.journey, mins: best2.mins, changes: 2 }
      return null
    }
    // Pre-filter origin-routes entries that direct-reach the custom station,
    // so the inner loop over destinations only iterates the relevant primaries.
    // Each entry gets the P→custom time cached for quick use below.
    type CustomHub = { pCoord: string; pToCustomMins: number; routes: typeof originRoutes[string] }
    const customHubs: CustomHub[] = []
    if (isCustomPrimary) {
      // For cluster primaries (CMAN / CBIR / CEXE / etc.) the cluster
      // anchor isn't itself a destination CRS in any station's
      // directReachable, so we look up against every member instead.
      // Pick the fastest member-direct-reach as the hub→primary time.
      // Phase 5a handled this for non-cluster primaries; 5b.i extends
      // to clusters.
      const primaryTargetIds = ALL_CLUSTERS[primaryOrigin]?.members ?? [primaryOrigin]
      for (const [pCoord, routes] of Object.entries(originRoutes)) {
        // Skip cluster-anchor synth entries (CLON, CSTR, …). Their
        // aggregated `routes.name` is the cluster's displayName ("London",
        // "Stratford") which leaks into composed legs as "Change at London".
        // The cluster's individual members (VIC, STP, KGX, …) already appear
        // as their own customHub entries with real station names, so nothing
        // is lost. Synth entries stay live for friend-side RTT composition.
        if (getStation(pCoord)?.isClusterAnchor) continue
        let bestMins: number | undefined
        for (const targetId of primaryTargetIds) {
          const entry = routes?.directReachable?.[targetId]
          if (entry?.minMinutes != null && (bestMins == null || entry.minMinutes < bestMins)) {
            bestMins = entry.minMinutes
          }
        }
        if (bestMins != null) {
          customHubs.push({ pCoord, pToCustomMins: bestMins, routes })
        }
      }
    }

    // London via-junction composition. Mirror of Extension A's
    // buildViaDirectHubJourney, but for the London-as-home case: when a
    // destination D isn't directly reachable from any London terminal,
    // search for a junction H that
    //   - reaches D directly (originRoutes[H].directReachable[D] exists), AND
    //   - is itself directly reachable from at least one London terminal
    //     (originRoutes[T].directReachable[H] exists for some T)
    // and compose: T → H → D with a single change at H. Returns the fastest
    // 1-change composition or null. Without this, destinations like Bury
    // St Edmunds (reachable via Ipswich from Liverpool Street) silently
    // disappear — they're not in any London terminal's directReachable
    // list, but the chain through IPS is in the data.
    //
    // Only fires as a final fallback in the synthetic-London RTT branch
    // when both directCandidate and stitchedCandidate are null. Doesn't
    // override real direct trains or pre-fetched Google journeys.
    const LONDON_INTERCHANGE_MIN = 5
    // The set of coords we treat as "starting in London" for composition.
    // PRIMARY_ORIGINS keys (minus the synthetic London anchor, which has no
    // RTT data of its own) plus every cluster member (e.g. Waterloo East,
    // Stratford International). Computed inside the useMemo body so any
    // future cluster edits propagate without a manual sync step.
    const londonTerminalCoords: string[] = []
    // The 11 single-station London termini (HUB_PRIMARY_IDS minus cluster
    // anchors) plus every member of every primary-flagged cluster.
    // Composition uses these as transfer hubs when a custom primary's
    // direct routing doesn't reach a destination.
    for (const id of HUB_PRIMARY_IDS) {
      if (getOriginDisplay(id)?.isCluster) continue
      londonTerminalCoords.push(id)
    }
    for (const cluster of Object.values(PRIMARY_ORIGIN_CLUSTER)) {
      for (const c of cluster) londonTerminalCoords.push(c)
    }
    function composeLondonViaJunction(coordKey: string): { mins: number; journey: JourneyInfo } | null {
      let best: { mins: number; journey: JourneyInfo } | null = null
      for (const [hubCoord, hubRoutes] of Object.entries(originRoutes)) {
        if (hubCoord === coordKey) continue
        // Skip London terminals as the "hub" — composition through a
        // London terminal is what direct/stitched already handles.
        if (londonTerminalCoords.includes(hubCoord)) continue
        const hubToDest = hubRoutes.directReachable?.[coordKey]
        if (!hubToDest?.minMinutes) continue
        // Find the fastest London terminal that reaches this hub directly.
        let bestTermMins: number | null = null
        let bestTerminalName = ""
        for (const termCoord of londonTerminalCoords) {
          const termRoutes = originRoutes[termCoord]
          const termToHub = termRoutes?.directReachable?.[hubCoord]
          if (!termToHub?.minMinutes) continue
          if (bestTermMins === null || termToHub.minMinutes < bestTermMins) {
            bestTermMins = termToHub.minMinutes
            bestTerminalName = termRoutes.name ?? ""
          }
        }
        if (bestTermMins === null) continue
        const totalMins = bestTermMins + LONDON_INTERCHANGE_MIN + hubToDest.minMinutes
        if (best != null && totalMins >= best.mins) continue
        const hubName = hubRoutes.name ?? ""
        const journey = {
          durationMinutes: totalMins,
          changes: 1,
          legs: [
            { vehicleType: "HEAVY_RAIL", departureStation: bestTerminalName, arrivalStation: hubName, stopCount: 0 },
            { vehicleType: "HEAVY_RAIL", departureStation: hubName, arrivalStation: hubToDest.name ?? "", stopCount: Math.max(0, (hubToDest.fastestCallingPoints?.length ?? 0) - 2) },
          ],
        } as unknown as JourneyInfo
        best = { mins: totalMins, journey }
      }
      return best
    }

    return {
      ...baseStations,
      features: baseStations.features.map((f) => {
        const coordKey = f.properties.coordKey as string
        // Canonical station ID — used for comparisons against
        // primaryOrigin / friendOrigin (both IDs post Phase 3c).
        // coordKey is still kept in scope for the rating/notes/etc.
        // lookups that remain coord-keyed at rest.
        const featureId = f.properties.id as string | undefined
        // NOTE: origin / excluded flags are applied in a SEPARATE thin
        // useMemo downstream so toggling them via admin actions doesn't
        // re-run this heavy routing pass (Extension A, alt routes,
        // walking-hub composition across ~3700 features × 400+ hubs —
        // previously caused ~10s UI freeze on exclude/origin toggle).
        // Keep `coordKey` in scope because downstream routing code
        // still needs it.

        // Apply primaryOrigin-dependent minute override.
        // Two data paths:
        //   1. RTT-based primaries (e.g. Charing Cross): look up the destination
        //      in origin-routes.json. If present it's directly reachable — use
        //      the timetable minutes + 0 changes. If absent, this primary has no
        //      data for that destination and the station should drop out of
        //      results (we set londonMinutes = null to achieve that).
        //   2. Routes-API primaries (Farringdon / KX / Stratford): use the
        //      per-destination journey stored in stations.json. For cluster
        //      origins (KX) we also strip any initial tube hop via
        //      getEffectiveJourney so the shown time reflects the real train's
        //      departure terminal.
        const primaryName = getOriginDisplay(primaryOrigin)?.canonicalName ?? primaryOrigin
        const clusterCoords = [primaryOrigin, ...(PRIMARY_ORIGIN_CLUSTER[primaryOrigin] ?? [])]
        // A primary is RTT-based if EITHER the primary itself has direct-reachable
        // data OR any of its cluster satellites do. The City mega-cluster's
        // synthetic primary coord (Bank station) has no RTT data of its own —
        // its cluster members supply all the direct coverage.
        //
        // Custom primaries (anything not in PRIMARY_ORIGINS — Stratford,
        // Farringdon, Richmond once we fetch it, etc.) are EXCLUDED from
        // this check even when they have their own RTT data. They go down
        // the isCustomPrimary branch instead, where Step 0a can use the
        // pre-fetched Google Routes journey under feature.journeys[primary]
        // for comprehensive coverage (1092 destinations for Stratford)
        // — the RTT-primary branch would only give us the RTT direct
        // subset (~105 for Stratford) and silently drop everything else.
        const isRttPrimary = !isCustomPrimary && clusterCoords.some((c) => originRoutes[c] != null)
        // Gather direct-reachable entries from every cluster member (including
        // the primary) and pick the fastest. We remember which cluster member
        // served the winner so the modal/journey can attribute it correctly
        // (e.g. "from Moorgate" when MOG's train beats LST's).
        let rttReachable: DirectReachable | undefined
        let rttReachableOriginName: string | undefined
        // Coord key of whichever cluster member served the winning direct train.
        // Needed for looking up intermediate calling-point times from that
        // origin's RTT data (so the "you could board here" list in the modal
        // shows minutes derived from the same origin as the primary journey).
        let rttReachableOriginCoord: string | undefined
        if (isRttPrimary && featureId) {
          for (const ck of clusterCoords) {
            const entry = originRoutes[ck]
            const candidate = entry?.directReachable?.[featureId]
            if (candidate && (!rttReachable || candidate.minMinutes < rttReachable.minMinutes)) {
              rttReachable = candidate
              rttReachableOriginName = entry?.name
              rttReachableOriginCoord = ck
            }
          }
          // Thameslink-Farringdon preference: when Farringdon has its own direct
          // entry for this destination AND the current winner is on the same
          // through-service (the two stations appear in each other's calling
          // sequences — Thameslink trains call at Farringdon, Blackfriars and
          // London Bridge in sequence), always surface Farringdon as the start
          // point even if another cluster member nominally edges it on minutes.
          if (clusterCoords.includes(FARRINGDON_COORD) && rttReachable && rttReachableOriginName !== "Farringdon") {
            const frn = originRoutes[FARRINGDON_COORD]?.directReachable?.[featureId]
            if (frn) {
              const winnerStartCrs = rttReachable.fastestCallingPoints[0]
              const sameService = frn.fastestCallingPoints.includes(winnerStartCrs)
                || rttReachable.fastestCallingPoints.includes(FARRINGDON_CRS)
              if (sameService) {
                rttReachable = frn
                rttReachableOriginName = originRoutes[FARRINGDON_COORD]?.name
                rttReachableOriginCoord = FARRINGDON_COORD
              }
            }
          }
        }

        let originMins: number | undefined
        let effectiveChanges: number | undefined
        let rttClearLondonMinutes = false
        // When an RTT primary matches a destination we synthesise a JourneyInfo
        // and stash it under the primary's coord key, so the modal + hover
        // polyline code can treat RTT-sourced primaries identically to Routes-sourced ones.
        let synthJourney: JourneyInfo | null = null
        // Option 2 hybrid-splice override — when tryHybridSplice produces a
        // faster variant of a Google-sourced journey, this holds the rebuilt
        // JourneyInfo. Written to next.journeys[primaryOrigin] at feature
        // return time so the modal + polyline reflect the spliced timings.
        // Null when no splice fired (either no data or no improvement).
        let spliceOverride: JourneyInfo | null = null

        if (isRttPrimary) {
          // Priority check: if this feature already has a pre-fetched Google
          // Routes journey keyed by the active primary's coord, use it as-is.
          // Applies to primaries that have been through the fetch-journeys.mjs
          // pipeline (Stratford, Farringdon, Kings Cross). Those journeys are
          // comprehensive — multi-modal, with real leg timings — so they give
          // us 1000+ destinations instead of just the RTT direct subset
          // (~100-200 per primary).
          //
          // Without this, Stratford-as-a-cluster-primary would fall into the
          // RTT-direct/stitched logic and silently drop ~987 destinations
          // that aren't on any of Stratford's own direct lines. KX-as-primary
          // gets a parallel upgrade for its ~854 pre-fetched destinations.
          //
          // When there's no pre-fetched journey for this feature, the branch
          // below runs as before and uses RTT data.
          const prefetchedPrimaryJourney = (f.properties.journeys as Record<string, JourneyInfo> | undefined)?.[primaryOrigin]
          if (prefetchedPrimaryJourney) {
            // Option 2 splice — try replacing a slow Google-sourced first leg
            // with a faster RTT-direct service. Returns the same journey
            // unchanged when no improvement is possible, or a hybrid copy
            // with a later departureTime + shorter durationMinutes. Either
            // way the result lives in `effectiveSourceJourney` and downstream
            // code (effective-minutes + feature.journeys modal/polyline read)
            // sees the splice consistently.
            const spliced = tryHybridSplice(prefetchedPrimaryJourney)
            const afterSplice = spliced ?? prefetchedPrimaryJourney
            // Wrong-interchange reroute (e.g. Seaford via Brighton →
            // Seaford via Lewes when V2 data shows the Lewes path is
            // shorter). Runs on the post-splice journey so both
            // optimisations can compose.
            const rerouted = tryRerouteViaAlternativeHub(afterSplice)
            let effectiveSourceJourney: JourneyInfo = rerouted ?? afterSplice

            // London calling-points enrichment for prefetched Google journeys.
            //
            // fetch-journeys.mjs doesn't populate londonCallingPoints /
            // londonUpstreamCallingPoints (Routes API doesn't expose the
            // intermediate calls we need). So for any feature with a
            // prefetched journey keyed by a cluster primary (KX, Stratford,
            // Farringdon), the modal's "Can also board at" list used to
            // silently stay empty — e.g. KX → Elstree & Borehamwood would
            // show no calling points despite the Thameslink service calling
            // at West Hampstead, Mill Hill, Kentish Town, plus upstream at
            // Farringdon/Blackfriars/London Bridge and Kent destinations.
            //
            // When we ALSO have RTT data for this destination (rttReachable
            // is set by the cluster-scan above), borrow its calling-points
            // via the shared buildCallingPoints helper and attach them to
            // the journey. Same helper + same filter rules the non-
            // prefetched RTT branch uses below, so the "Alternative
            // starts..." prefix / time logic behaves identically whether
            // the backing journey is Google- or RTT-sourced.
            if (rttReachable && rttReachableOriginCoord) {
              const cp = buildCallingPoints(rttReachableOriginCoord, coordKey)
              if (cp && (cp.downstream.length > 0 || cp.upstream.length > 0)) {
                effectiveSourceJourney = {
                  ...effectiveSourceJourney,
                  londonCallingPoints: cp.downstream.length > 0 ? cp.downstream : undefined,
                  londonUpstreamCallingPoints: cp.upstream.length > 0 ? cp.upstream : undefined,
                }
              }
            }

            // Write the (possibly spliced + enriched) journey back into
            // feature.journeys so the modal reads the enriched version.
            // Uses the spliceOverride slot that was introduced for Option 2:
            // any time this branch rebuilds the journey we route through
            // that slot, whether the change was a time splice, a calling-
            // points enrichment, or both.
            if (effectiveSourceJourney !== prefetchedPrimaryJourney) {
              spliceOverride = effectiveSourceJourney
            }

            const effective = getEffectiveJourney(effectiveSourceJourney, primaryName)
            originMins = effective?.effectiveMinutes
            effectiveChanges = effective?.effectiveChanges
            // No synthJourney to build — the journey already lives at
            // feature.journeys[primaryOrigin], so the modal + hover polyline
            // pick it up natively. The rest of the isRttPrimary block
            // (RTT-direct + stitched candidates) is skipped for this feature.
          } else {
          // Build both candidate journeys then apply passenger-preference rules
          // when choosing between a direct (0-change) train and a stitched
          // alternative (with a change through a London terminal):
          //   1. "2h30m cutoff": if direct would be > 2h30m but stitched is ≤
          //      2h30m, always use stitched. This keeps the destination inside
          //      the default time window instead of dropping it off the map.
          //   2. Otherwise, prefer direct unless stitched is ≥15 min faster.
          //      A small time saving doesn't justify the hassle of a change,
          //      but a large saving does.
          const DIRECT_PREFERENCE_THRESHOLD_MIN = 15
          const DAY_TRIP_MAX_MIN = 150  // matches the default non-admin slider cap

          // Candidate A — direct train from RTT data (destination on one of the
          // primary origin's own lines, or a clustered satellite like Moorgate).
          let directCandidate: { mins: number; journey: JourneyInfo } | null = null
          if (rttReachable) {
            const straightCoords = rttReachable.fastestCallingPoints
              .map((crs) => crsToCoord[crs])
              .filter((c): c is [number, number] => !!c)
            // Polyline-quality upgrade for synthetic primaries (the London
            // cluster). RTT's straight-line CRS chain looks jagged next to
            // Google Routes' real-track polylines. If ANY cluster sibling
            // was Google-fetched and its polyline joins the RTT route's
            // track somewhere downstream, splice the curvy sibling suffix
            // onto the RTT prefix so the user sees real track from the
            // join station onwards.
            //
            // Concrete primaries skip this — their polyline MUST start at
            // the specific terminus the user picked, so a sibling's
            // polyline (starting at a different terminus) would visibly
            // leave the wrong station.
            let coords = straightCoords
            if (getOriginDisplay(primaryOrigin)?.isCluster) {
              const siblings = PRIMARY_ORIGIN_CLUSTER[primaryOrigin] ?? []
              const featureJourneys = f.properties.journeys as Record<string, { polyline?: string }> | undefined
              for (const siblingCoord of siblings) {
                const siblingEncoded = featureJourneys?.[siblingCoord]?.polyline
                if (!siblingEncoded) continue
                const siblingDecoded = decodePolyline(siblingEncoded)
                const trimmed = trimSiblingPolylineToRttRoute(
                  siblingDecoded,
                  rttReachable.fastestCallingPoints,
                  crsToCoord,
                )
                if (trimmed && trimmed.length > 1) {
                  coords = trimmed
                  break
                }
              }
            }
            // London calling-points: delegated to buildCallingPoints so the
            // same logic is shared across direct / stitched / custom-primary
            // code paths. For direct trains, "boardHere" is the winning
            // cluster member ID (rttReachableOriginCoord — name is legacy,
            // value is now an ID).
            const cp = rttReachableOriginCoord && featureId
              ? buildCallingPoints(rttReachableOriginCoord, featureId)
              : null
            const londonCallingPoints = cp?.downstream ?? []
            const londonUpstreamCallingPoints = cp?.upstream ?? []
            const directJourney = {
              durationMinutes: rttReachable.minMinutes,
              changes: 0,
              legs: [
                {
                  vehicleType: "HEAVY_RAIL",
                  // Attribution: if the cluster satellite (e.g. Moorgate) served
                  // the fastest train, display that as the departure station
                  // rather than the primary origin name.
                  departureStation: rttReachableOriginName ?? primaryName,
                  arrivalStation: rttReachable.name,
                  stopCount: Math.max(0, rttReachable.fastestCallingPoints.length - 2),
                },
              ],
              polylineCoords: coords.length > 1 ? coords : undefined,
              londonCallingPoints: londonCallingPoints.length > 0 ? londonCallingPoints : undefined,
              londonUpstreamCallingPoints: londonUpstreamCallingPoints.length > 0 ? londonUpstreamCallingPoints : undefined,
            } as unknown as JourneyInfo
            directCandidate = { mins: rttReachable.minMinutes, journey: directJourney }
          }

          // Candidate B — stitched via another London terminal + an existing
          // Routes-API journey (KX first, Farringdon as fallback inside stitchJourney).
          // For clusters, we try each member that has a matching Terminal record
          // and pick the fastest. Members without a Terminal entry in
          // london-terminals.json are skipped silently.
          let stitchedCandidate: { mins: number; journey: JourneyInfo } | null = null
          for (const ck of clusterCoords) {
            // Resolve the cluster member's coord to a terminal. Two cases:
            //   1. The coord IS a standalone primary (KX, CHX, VIC, …) —
            //      grab its canonicalName straight from PRIMARY_ORIGINS.
            //   2. The coord is ONLY a cluster member (St Pancras, Euston,
            //      Waterloo East, the NR KX main-line coord, …) — not in
            //      PRIMARY_ORIGINS at all. Look up the station's own name
            //      via baseStations and normalise through matchTerminal.
            //      Without this fallback, case 2 used to continue-skip, so
            //      London-synth primary would never try stitching via St
            //      Pancras, Euston, or Waterloo East — it only tried
            //      cluster members with their own primary entry. That's why
            //      "London → Swale" was stitching via Kings Cross and
            //      prepending an extra KX→StP tube hop, when using St
            //      Pancras as the newOrigin directly gives a shorter result
            //      with the correct "from St Pancras" narrative.
            let canonical = getOriginDisplay(ck)?.canonicalName
            if (!canonical) {
              const feat = baseStations.features.find(
                (x) => `${x.geometry.coordinates[0]},${x.geometry.coordinates[1]}` === ck,
              )
              const matched = matchTerminal(feat?.properties?.name, londonTerminals)
              if (matched) canonical = matched
            }
            if (!canonical) continue
            // Match by terminal name OR alias. KX's PRIMARY_ORIGINS entry has
            // canonicalName "Kings Cross St Pancras", which appears in the
            // "Kings Cross" terminal's aliases list — without the alias check
            // KX wouldn't participate in stitching, and north-England
            // destinations via KX would drop off the map.
            const term = londonTerminals.find(
              (t) => t.name === canonical || t.aliases.includes(canonical),
            )
            if (!term) continue
            const stitched = stitchJourney({
              feature: f as unknown as Parameters<typeof stitchJourney>[0]["feature"],
              newOrigin: term,
              matrix: terminalMatrix,
              terminals: londonTerminals,
            })
            if (stitched && stitched.durationMinutes != null) {
              // Enrich with London calling-points FROM THE SPECIFIC MAINLINE
              // TERMINAL the stitched journey departs from. The "can also
              // board at" hint must reflect the ACTUAL train the user is on
              // after changing at the stitch terminal — not a different
              // train that happens to reach the same destination. If the
              // mainline terminal's RTT data is empty for this destination
              // (e.g. KX → Royston has no London intermediate stops), the
              // list stays empty rather than risking misleading cross-train
              // suggestions.
              // Find the mainline terminal: first HEAVY_RAIL leg's departure.
              // Two-step name resolution:
              //   1. matchTerminal normalises the leg's departureStation (e.g.
              //      "St Pancras") against the terminals list's aliases to
              //      get a canonical terminal name (e.g. "St Pancras").
              //   2. Scan origin-routes.json for a terminal whose name also
              //      normalises to that canonical — handles the inverse case
              //      ("London St. Pancras International" → "St Pancras").
              // Both sides need alias resolution because the origin-routes
              // names weren't normalised when the RTT fetch script wrote them.
              const mainlineLeg = stitched.legs?.find((l) => l.vehicleType === "HEAVY_RAIL")
              const canonical = matchTerminal(mainlineLeg?.departureStation, londonTerminals)
              let mainlineCoord: string | undefined
              if (canonical) {
                for (const [coord, data] of Object.entries(originRoutes)) {
                  if (matchTerminal(data?.name, londonTerminals) === canonical) {
                    mainlineCoord = coord
                    break
                  }
                }
              }
              // Figure out what TARGET COORD to look up under the mainline
              // terminal's directReachable. Two cases:
              //   • Single HEAVY_RAIL leg (mainline goes straight to D):
              //     target = D. e.g. Cannon Street → StP → Gravesend. The
              //     StP→Gravesend train's fastestCallingPoints describe the
              //     whole route to D.
              //   • Multiple HEAVY_RAIL legs (user changes mid-journey):
              //     target = FIRST heavy-rail leg's arrivalStation, i.e. the
              //     CHANGE station, not D. e.g. London → Amberley routes as
              //     StP→East Croydon (Thameslink, leg 1) + East Croydon→
              //     Amberley (Southern, leg 2). The calling-points hint
              //     should describe the Thameslink train — its London stops
              //     between StP and East Croydon (Farringdon, Blackfriars,
              //     London Bridge). Looking up StP→Amberley would return
              //     null because Amberley isn't served by the Thameslink
              //     train (the user changes at East Croydon). Looking up
              //     StP→East Croydon returns the rich Thameslink list.
              const heavyRailLegs = stitched.legs?.filter((l) => l.vehicleType === "HEAVY_RAIL") ?? []
              let targetCoord: string = coordKey
              if (heavyRailLegs.length > 1) {
                const changeStationName = heavyRailLegs[0]?.arrivalStation
                if (changeStationName) {
                  // baseStations is the source of truth for station coords.
                  // Look for an exact name match. Station names in
                  // stations.json are unique for the ones we care about
                  // (London terminals + major interchange stations like
                  // East Croydon, Clapham Junction). Same-name edge cases
                  // would only trigger here if two stations share exact
                  // names — extremely rare for interchange stations.
                  const match = baseStations.features.find(
                    (x) => x.properties?.name === changeStationName,
                  )
                  if (match) {
                    const [lng, lat] = match.geometry.coordinates
                    targetCoord = `${lng},${lat}`
                  }
                }
              }
              // First try the mainline terminal's own directReachable. When
              // that terminal's RTT fetch captured the relevant train, this
              // gives the cleanest answer with minimal processing. When it
              // didn't (e.g. StP's own data is missing southbound Thameslink
              // to East Croydon despite the train physically calling at both),
              // fall back to buildCallingPointsViaDonor which borrows data
              // from a terminal that DID capture the same train (e.g. BFR).
              let cp = mainlineCoord ? buildCallingPoints(mainlineCoord, targetCoord) : null
              if ((!cp || (cp.downstream.length === 0 && cp.upstream.length === 0)) && mainlineCoord) {
                cp = buildCallingPointsViaDonor(mainlineCoord, targetCoord)
              }
              const enriched = cp
                ? {
                    ...stitched,
                    londonCallingPoints: cp.downstream.length > 0 ? cp.downstream : undefined,
                    londonUpstreamCallingPoints: cp.upstream.length > 0 ? cp.upstream : undefined,
                  }
                : stitched
              // Option 2 hybrid splice — try swapping a slow Google first
              // rail leg for a faster RTT-direct service. Works on stitched
              // journeys now that tryHybridSplice auto-detects the rail
              // leg's origin; the user's primary is often the synthetic
              // London cluster (no own origin-routes entry), but the
              // rail leg's actual starting terminus does have one. This
              // is what unlocks the Marlow / Seaford / Southease fixes:
              // PAD → Maidenhead, VIC → Lewes, VIC → Haywards Heath
              // all have V2 observations since 2026-04-20.
              const stitchedSpliced = tryHybridSplice(enriched as unknown as JourneyInfo)
              const afterSplice = stitchedSpliced ?? (enriched as unknown as JourneyInfo)
              // Second pass — reroute via an alternative hub if Google's
              // chosen interchange isn't the best one (e.g. Seaford via
              // Brighton rather than Lewes). Only fires when we have V2
              // origin-routes data for BOTH the penultimate leg's
              // origin and the alt hub.
              const rerouted = tryRerouteViaAlternativeHub(afterSplice)
              const finalStitched = rerouted ?? afterSplice
              if (!stitchedCandidate || finalStitched.durationMinutes! < stitchedCandidate.mins) {
                stitchedCandidate = { mins: finalStitched.durationMinutes!, journey: finalStitched }
              }
            }
          }

          // Apply the preference rules.
          let best: { mins: number; journey: JourneyInfo } | null = null
          if (directCandidate && stitchedCandidate) {
            const directMin = directCandidate.mins
            const stitchedMin = stitchedCandidate.mins
            // Rule 1 — 2h30m cutoff: direct would be out of range but stitched
            // is still in range, so use stitched regardless of the 15-min rule.
            if (directMin > DAY_TRIP_MAX_MIN && stitchedMin <= DAY_TRIP_MAX_MIN) {
              best = stitchedCandidate
            }
            // Rule 2 — 15-min preference: only switch to stitched if it saves
            // at least that much. Otherwise the direct train wins.
            else if (stitchedMin <= directMin - DIRECT_PREFERENCE_THRESHOLD_MIN) {
              best = stitchedCandidate
            } else {
              best = directCandidate
            }
          } else {
            // At most one candidate exists — use whichever we have.
            best = directCandidate ?? stitchedCandidate
          }

          if (!best) {
            // No direct or stitched candidate. Final fallback: try composing
            // via a non-London junction hub (e.g. London → Ipswich → Bury St
            // Edmunds). Without this, destinations served only by lines that
            // change at a regional hub silently lose londonMinutes even
            // though the data exists in origin-routes.json.
            const viaJunction = composeLondonViaJunction(coordKey)
            if (viaJunction) {
              originMins = viaJunction.mins
              effectiveChanges = 1
              synthJourney = viaJunction.journey
            } else {
              // No data at all for this destination → clear londonMinutes so it's filtered out.
              rttClearLondonMinutes = true
            }
          } else {
            originMins = best.mins
            effectiveChanges = (best.journey.changes ?? 0)
            synthJourney = best.journey
          }
          } // end else — pre-fetched-primary-journey priority branch above
        } else if (isCustomPrimary) {
          // Custom primary (any NR station picked via the search bar). No
          // pre-fetched data for it, but we can reach destinations two ways:
          //   1. SAME-TRAIN SHORTCUT — when the custom primary X is on a
          //      through-train from some terminal P to destination D, the
          //      user just boards at X and stays on. 0 changes. Happens for
          //      every MOG destination if X = Old Street (trains call at
          //      OLD between MOG and Stevenage/Hertford/etc), and similarly
          //      for BFR Thameslink (ZFD/STP/FPK as upstream calls).
          //   2. HUB ROUTING — fallback when no same-train option exists:
          //        time(custom → D via P) = P→custom + P→D + interchange
          //      where P is the fastest curated primary that direct-reaches
          //      both. 1 change at P.
          if (primaryOrigin === featureId) {
            // User's own station — drop it from the destination map.
            rttClearLondonMinutes = true
          } else if ((f.properties.journeys as Record<string, JourneyInfo> | undefined)?.[primaryOrigin]) {
            // --- Step 0a: Pre-fetched Google Routes journey ---
            // The feature ALREADY has a journey keyed by this custom
            // primary's coord. This happens when the primary was
            // previously a curated one whose per-destination journeys
            // were baked into stations.json via scripts/fetch-journeys.mjs
            // (Stratford, Farringdon, and the Kings Cross cluster).
            //
            // Those journeys are comprehensive Google Routes results —
            // multi-modal, already routed, more accurate than anything
            // we can stitch from RTT directReachable. Use them as-is,
            // same code path the old curated-primary branch uses
            // (see the `else` block below around "Calling-points
            // enrichment for curated primaries without their own RTT
            // data" for the logic being mirrored here).
            //
            // Without this, Stratford-as-custom-primary silently lost
            // most of its destinations — the stitcher only had RTT
            // direct (105 stations) + hub routes through Liverpool
            // Street, and many hike destinations weren't reachable
            // either way despite the feature having a perfectly good
            // pre-fetched Stratford→D journey sitting right there.
            const journeys = f.properties.journeys as Record<string, JourneyInfo>
            const primaryJourney = journeys[primaryOrigin]
            // Option 2 splice — if the custom primary itself has RTT direct-
            // reachable data (Stratford + Farringdon do; ClapJ after its
            // recent fetch does), try replacing the Google first leg with a
            // faster RTT service. When the splice fires, spliceOverride is
            // written back into next.journeys so the modal displays the
            // hybrid timings.
            const spliced = tryHybridSplice(primaryJourney)
            const afterSplice = spliced ?? primaryJourney
            const rerouted = tryRerouteViaAlternativeHub(afterSplice)
            let effectiveSourceJourney: JourneyInfo = rerouted ?? afterSplice
            // Try composing via an alternative London terminus. When Google
            // Routes' pre-fetched journey picked a suboptimal first terminus
            // (e.g. CLJ→Marlow via Stratford+LST at 2h44m), this recomposes
            // X→hub→terminal→D via the terminal matrix + stitched mainline.
            const composed = tryComposeViaTerminal(
              f,
              customHubs,
              coordToName[primaryOrigin] ?? primaryOrigin,
              primaryOrigin,
            )
            if (composed) {
              const curMins = effectiveSourceJourney.durationMinutes ?? Infinity
              const curChanges = (effectiveSourceJourney as unknown as { changes?: number }).changes ?? 99
              if (
                composed.changes < curChanges ||
                (composed.changes === curChanges && composed.mins < curMins)
              ) {
                effectiveSourceJourney = composed.journey
              }
            }
            // Extension A: via-direct-hub composition. Wins when a
            // single suburban interchange (e.g. Redhill for CLJ→PHR)
            // beats Google's central-London routing. 1 change.
            // primaryOrigin is an ID; the compose helpers want a real
            // coord for parseCoordKey-based polyline building.
            const primaryCoordStrA = registryGetCoordKey(primaryOrigin) ?? ""
            const viaHub = (featureId && primaryCoordStrA) ? buildViaDirectHubJourney(
              customHubs,
              featureId,
              coordToName[primaryOrigin] ?? primaryOrigin,
              primaryCoordStrA,
            ) : null
            if (viaHub) {
              const curMins = effectiveSourceJourney.durationMinutes ?? Infinity
              const curChanges = (effectiveSourceJourney as unknown as { changes?: number }).changes ?? 99
              if (
                viaHub.changes < curChanges ||
                (viaHub.changes === curChanges && viaHub.mins < curMins)
              ) {
                effectiveSourceJourney = viaHub.journey
              }
            }
            // Extension B: triple-hop walking-interchange composition.
            // Unlocks CLJ→YAL class journeys (CLJ → WAT → walk → WAE →
            // PKW → YAL). Only wins when the walking-chain path is
            // STRICTLY faster than what we already have — it's 2 rail
            // changes, so direct or single-change options beat it by
            // the change-count tiebreak automatically.
            const viaWalk = (featureId && primaryCoordStrA) ? tryComposeViaWalkingDoubleHub(
              customHubs,
              featureId,
              coordToName[primaryOrigin] ?? primaryOrigin,
              primaryCoordStrA,
            ) : null
            if (viaWalk) {
              const curMins = effectiveSourceJourney.durationMinutes ?? Infinity
              const curChanges = (effectiveSourceJourney as unknown as { changes?: number }).changes ?? 99
              if (
                viaWalk.changes < curChanges ||
                (viaWalk.changes === curChanges && viaWalk.mins < curMins)
              ) {
                effectiveSourceJourney = viaWalk.journey
              }
            }
            // Extension C: TfL-hop composition. For destinations that
            // need a terminal the primary can't reach by direct rail
            // (CLJ→Wendover via MYB, CLJ→WelwynGC via KGX, etc.),
            // bridge primary→T using the TfL hop matrix and finish
            // with T→D rail from origin-routes. 1 change.
            const viaTflHop = (featureId && primaryCoordStrA) ? tryComposeViaPrimaryHop(
              coordToName[primaryOrigin] ?? primaryOrigin,
              featureId,
              primaryCoordStrA,
              f.properties.journeys as Record<string, { polyline?: string }> | undefined,
            ) : null
            if (viaTflHop) {
              const curMins = effectiveSourceJourney.durationMinutes ?? Infinity
              const curChanges = (effectiveSourceJourney as unknown as { changes?: number }).changes ?? 99
              if (
                viaTflHop.changes < curChanges ||
                (viaTflHop.changes === curChanges && viaTflHop.mins < curMins)
              ) {
                effectiveSourceJourney = viaTflHop.journey
              }
            }

            // London calling-points enrichment (same rationale as the
            // isRttPrimary branch above). Custom primaries like Farringdon
            // and Stratford have their own origin-routes entries — when
            // this destination is direct-reachable from the primary, run
            // buildCallingPoints to surface intermediate + upstream
            // stations on the otherwise-bare Google journey. Without this,
            // Farringdon → Elstree & Borehamwood shows no "Can also board
            // at" list despite the Thameslink service obviously calling at
            // St Pancras, West Hampstead, Mill Hill Broadway, etc.
            const selfEntry = featureId ? originRoutes[primaryOrigin]?.directReachable?.[featureId] : undefined
            if (selfEntry && featureId) {
              const cp = buildCallingPoints(primaryOrigin, featureId)
              if (cp && (cp.downstream.length > 0 || cp.upstream.length > 0)) {
                effectiveSourceJourney = {
                  ...effectiveSourceJourney,
                  londonCallingPoints: cp.downstream.length > 0 ? cp.downstream : undefined,
                  londonUpstreamCallingPoints: cp.upstream.length > 0 ? cp.upstream : undefined,
                }
              }
            }

            if (effectiveSourceJourney !== primaryJourney) {
              spliceOverride = effectiveSourceJourney
            }

            const effective = getEffectiveJourney(effectiveSourceJourney, primaryName)
            originMins = effective?.effectiveMinutes
            effectiveChanges = effective?.effectiveChanges
            // The spliceOverride case above writes the enriched / hybrid
            // variant back into next.journeys at feature-return time; the
            // original Google journey is used as-is otherwise.
          } else if (featureId && originRoutes[primaryOrigin]?.directReachable?.[featureId]?.minMinutes != null) {
            // --- Step 0: Self-direct lookup ---
            // The custom primary has itself been RTT-fetched (its coord
            // is a key in origin-routes.json). Its own directReachable
            // entries give us a native 0-change route to every station
            // on its own lines — strictly better than the Step 1 same-
            // train inference or the Step 2 hub detour.
            //
            // Example: Richmond → Ascot. Without self-fetch the app
            // routes via Waterloo (RMD→WAT 18m + WAT→ACT 54m + 5m
            // change = 77m). With Richmond RTT-fetched, whichever
            // Reading-line service actually runs Richmond→Ascot
            // directly appears in RMD.directReachable[Ascot] at its
            // real timetabled time, and the user sees a single leg
            // with no change.
            //
            // Whether this branch fires depends entirely on the fetch
            // coverage. For custom primaries NOT in origin-routes.json
            // (the majority before we extend the fetch scope), we
            // fall through to the existing Steps 1 & 2 unchanged.
            const selfEntry = originRoutes[primaryOrigin]!.directReachable[featureId!]
            originMins = selfEntry.minMinutes
            effectiveChanges = 0
            const customName = coordToName[primaryOrigin] ?? primaryOrigin
            const destName = (f.properties.name as string) ?? ""
            // Polyline: the self-direct service's calling-point chain,
            // starting at the custom primary itself.
            const coords = selfEntry.fastestCallingPoints
              .map((crs) => crsToCoord[crs])
              .filter((c): c is [number, number] => !!c)
            // London calling-points hint — same helper used on other
            // single-leg branches.
            const cp = featureId ? buildCallingPoints(primaryOrigin, featureId) : null
            synthJourney = {
              durationMinutes: selfEntry.minMinutes,
              changes: 0,
              legs: [
                {
                  vehicleType: "HEAVY_RAIL",
                  departureStation: customName,
                  arrivalStation: destName,
                  stopCount: Math.max(0, selfEntry.fastestCallingPoints.length - 2),
                },
              ],
              polylineCoords: coords.length > 1 ? coords : undefined,
              londonCallingPoints: cp && cp.downstream.length > 0 ? cp.downstream : undefined,
              londonUpstreamCallingPoints: cp && cp.upstream.length > 0 ? cp.upstream : undefined,
            } as unknown as JourneyInfo
          } else {
            // --- Step 1: same-train shortcut search ---
            // For each terminal P that directly reaches D, see if X is on
            // the train — either as an UPSTREAM stop (train goes X → … → P
            // → … → D) or as an INTERMEDIATE stop (train goes P → … → X
            // → … → D). In both cases X → D is direct, 0 changes.
            // Track which terminal provided the winning match + X's time
            // relative to P — the calling-points builder needs the latter
            // to classify each stop as earlier-boarding (upstream) or
            // later-boarding (downstream) relative to X.
            let sameTrainMins: number | undefined
            let sameTrainTerminalCoord: string | undefined
            // X's time relative to P: negative if X is upstream of P (train
            // passes through X before reaching P), positive if X is
            // intermediate (between P and D).
            let sameTrainXTimeRelativeToP: number | undefined
            for (const terminalId of Object.keys(originRoutes)) {
              const entry = featureId ? originRoutes[terminalId]?.directReachable?.[featureId] : undefined
              if (!entry) continue
              const pToDestMins = entry.minMinutes

              // Upstream: X is before P. The upstream-calling-point list
              // carries each station's CRS, which IS the canonical ID for
              // any real NR station — so primaryOrigin (now an ID) compares
              // directly against u.crs.
              const upstreamMatch = entry.upstreamCallingPoints?.find(
                (u) => u.crs === primaryOrigin,
              )
              if (upstreamMatch) {
                const mins = pToDestMins + upstreamMatch.minutesBeforeOrigin
                if (sameTrainMins == null || mins < sameTrainMins) {
                  sameTrainMins = mins
                  sameTrainTerminalCoord = terminalId
                  // X is BEFORE P → negative tP.
                  sameTrainXTimeRelativeToP = -upstreamMatch.minutesBeforeOrigin
                }
                continue
              }

              // Intermediate: X is between P and D on fastestCallingPoints.
              // Excludes first (= P) and last (= D) entries; either of those
              // would mean X is the terminal or the destination, neither
              // gives us a new same-train shortcut. fastestCallingPoints
              // carries CRS strings, which equal primaryOrigin directly
              // for real NR primaries.
              const fastCP = entry.fastestCallingPoints
              const isIntermediate = fastCP.slice(1, -1).some((crs) => crs === primaryOrigin)
              if (isIntermediate) {
                // P→X time comes from P's OWN directReachable[X] entry,
                // which every intermediate stop on P's line should have
                // (Old Street gets its own MOG→OLD entry with minMins=2).
                const pToX = originRoutes[terminalId]?.directReachable?.[primaryOrigin]?.minMinutes
                if (pToX != null) {
                  const mins = pToDestMins - pToX
                  if (mins > 0 && (sameTrainMins == null || mins < sameTrainMins)) {
                    sameTrainMins = mins
                    sameTrainTerminalCoord = terminalId
                    // X is AFTER P → positive tP.
                    sameTrainXTimeRelativeToP = pToX
                  }
                }
              }
            }

            // Same-train shortcut found — user boards at X and stays on the
            // train all the way to D. Build a single-leg journey + enrich
            // with richest calling-points, then skip hub routing below by
            // marking the branch done (origin/effectiveChanges are set).
            if (sameTrainMins != null) {
              originMins = sameTrainMins
              effectiveChanges = 0
              const customName = coordToName[primaryOrigin] ?? primaryOrigin
              const destName = (f.properties.name as string) ?? ""
              // Calling points come from the SPECIFIC terminal whose train
              // matched the same-train shortcut. Using a different terminal
              // that happens to also reach D would surface stops from a
              // DIFFERENT train that doesn't call at the user's origin X —
              // which would be misleading.
              // buildSameTrainCallingPoints (not buildCallingPoints) is used
              // here so the list (a) INCLUDES the terminal P itself as an
              // "also start same route at" option and (b) labels times
              // relative to X, not P.
              const cp = sameTrainTerminalCoord != null && sameTrainXTimeRelativeToP != null && featureId
                ? buildSameTrainCallingPoints(sameTrainTerminalCoord, featureId, sameTrainXTimeRelativeToP)
                : null

              // Polyline for the same-train shortcut. Derived from the
              // terminal's fastestCallingPoints (CRS sequence). Two cases:
              //   • Intermediate: X sits inside fastCP between P and D. The
              //     relevant sub-polyline is fastCP.slice(idxX…) — the CRS
              //     chain from X forward.
              //   • Upstream: X sits BEFORE P. fastCP only covers P→D, so
              //     prepend X's own coord and the full P→D chain. Other
              //     upstream stops between X and P are omitted because we
              //     don't carry their CRS on the winner's route — a
              //     straight segment from X to P is a reasonable hint.
              // Without this step, every same-train-resolved destination
              // (most CLJ/Kentish-Town/Vauxhall journeys, etc.) used to
              // have NO polyline drawn on hover despite having an
              // otherwise complete journey.
              let stPolylineCoords: [number, number][] | undefined
              if (sameTrainTerminalCoord != null && featureId) {
                const winnerEntry = originRoutes[sameTrainTerminalCoord]?.directReachable?.[featureId]
                const fastCP = winnerEntry?.fastestCallingPoints ?? []
                if ((sameTrainXTimeRelativeToP ?? 0) >= 0) {
                  // Intermediate — slice fastCP from X forward. fastCP
                  // entries are CRS strings; primaryOrigin is the
                  // user's primary ID, equal to its CRS for real NR
                  // stations (custom primaries are always real NR).
                  const idxX = fastCP.findIndex((crs) => crs === primaryOrigin)
                  if (idxX > -1) {
                    const sliced = fastCP.slice(idxX)
                      .map((crs) => crsToCoord[crs])
                      .filter((c): c is [number, number] => !!c)
                    if (sliced.length > 1) stPolylineCoords = sliced
                  }
                } else {
                  // Upstream — prepend X's coord to the full P→D chain.
                  // primaryOrigin is an ID; resolve to a real coord via
                  // the registry before parsing into lng/lat.
                  const primaryCoord = registryGetCoordKey(primaryOrigin)
                  const { lng: xLng, lat: xLat } = primaryCoord
                    ? parseCoordKey(primaryCoord)
                    : { lng: NaN, lat: NaN }
                  const pToDestCoords = fastCP
                    .map((crs) => crsToCoord[crs])
                    .filter((c): c is [number, number] => !!c)
                  if (pToDestCoords.length > 0 && Number.isFinite(xLng)) {
                    stPolylineCoords = [[xLng, xLat], ...pToDestCoords]
                  }
                }
              }

              synthJourney = {
                durationMinutes: sameTrainMins,
                changes: 0,
                legs: [
                  {
                    vehicleType: "HEAVY_RAIL",
                    departureStation: customName,
                    arrivalStation: destName,
                  },
                ],
                polylineCoords: stPolylineCoords,
                londonCallingPoints: cp && cp.downstream.length > 0 ? cp.downstream : undefined,
                londonUpstreamCallingPoints: cp && cp.upstream.length > 0 ? cp.upstream : undefined,
              } as unknown as JourneyInfo
              // Skip hub routing fallback — same-train is strictly better.
              // Fall through to the outer next-property builder below.
            } else {

            // --- Step 2: hub routing fallback ---
            // Each hub P in customHubs is a terminal whose RTT data tells us
            // how to get from the custom primary X to P. From P, we can
            // reach the destination D two ways:
            //   (A) RTT-DIRECT — P has D in its directReachable: one train
            //       from P. total = X→P + interchange + P→D, 1 change.
            //   (B) SOURCE-STITCHED — the destination feature has a pre-
            //       fetched Google Routes journey keyed by P's coord (e.g.
            //       every feature has a Farringdon-origin journey because
            //       Farringdon is our baseline Routes API fetch). We pipe
            //       through THAT journey: total = X→P + interchange + the
            //       source journey's duration, changes = 1 + source's own
            //       changes.
            // Option B is crucial for destinations OUTSIDE any Thameslink
            // hub's own RTT network — e.g. Kentish Town (reachable only via
            // Thameslink hubs: ZFD, BFR, STP) to Oxford (GWR from Paddington,
            // not in any Thameslink hub's RTT data). Without B, those
            // destinations used to disappear entirely.
            type RouteCandidate = {
              mins: number
              changes: number
              hub: CustomHub
              kind: "rtt-direct" | "source-stitched" | "double-hop" | "composed"
              composedJourney?: JourneyInfo
              sourceJourney?: JourneyInfo
              // Only set for double-hop: the intermediate terminal name the
              // user interchanges at (after arriving from X's hub).
              doubleHopVia?: string
              doubleHopMins?: number
            }
            const isBetter = (c: RouteCandidate, best: RouteCandidate | undefined) =>
              best == null ||
              c.changes < best.changes ||
              (c.changes === best.changes && c.mins < best.mins)
            let winner: RouteCandidate | undefined
            const featureJourneys = f.properties.journeys as Record<string, JourneyInfo> | undefined
            for (const hub of customHubs) {
              // Option A: P.directReachable[D] exists → 1-change RTT path.
              const pToD = featureId ? hub.routes.directReachable?.[featureId]?.minMinutes : undefined
              if (pToD != null) {
                const candidate: RouteCandidate = {
                  mins: hub.pToCustomMins + pToD + interchangeBufferFor(hub.routes.name),
                  changes: 1,
                  hub,
                  kind: "rtt-direct",
                }
                if (isBetter(candidate, winner)) winner = candidate
              }
              // Option B: feature.journeys[hub.pCoord] exists → pipe through
              // a Google Routes journey from the hub. The hub's RTT coord
              // must match a key in the feature's journeys dict — true for
              // Farringdon (same coord in both RTT and stations.json) but
              // not e.g. for Kings Cross (whose RTT coord differs from its
              // stations.json Underground coord). Farringdon alone gives us
              // broad coverage via the baseline journeys.
              const srcJourney = featureJourneys?.[hub.pCoord]
              if (srcJourney?.durationMinutes != null) {
                const candidate: RouteCandidate = {
                  mins: hub.pToCustomMins + interchangeBufferFor(hub.routes.name) + srcJourney.durationMinutes,
                  // Changes through the hub (1) plus whatever the source
                  // journey already had. A Farringdon→Oxford journey with 1
                  // internal change (Farringdon→Paddington→Oxford) becomes
                  // 2 changes total for the X→hub→...→Oxford composition.
                  changes: 1 + (srcJourney.changes ?? 0),
                  hub,
                  kind: "source-stitched",
                  sourceJourney: srcJourney,
                }
                if (isBetter(candidate, winner)) winner = candidate
              }
              // Option C: Double-hop — X→hub (RTT) → hop via terminal-matrix
              // to another terminal T whose coord IS a source journey key.
              // Covers cases where the custom primary's ONLY reachable hub
              // isn't also one of our baseline Google Routes origins.
              // Vauxhall is the archetype: its only RTT-reachable hub is
              // Waterloo (3 min), but stations.json doesn't have Waterloo-
              // keyed source journeys — only Farringdon, KX, etc. Without
              // this path, VXH users lose every destination not on
              // Waterloo's own RTT network (Oxford, Cambridge via different
              // lines, most of the non-SWR network).
              const hubCanonical = matchTerminal(hub.routes.name, londonTerminals)
              if (hubCanonical && featureJourneys) {
                for (const [sourceId, journey] of Object.entries(featureJourneys)) {
                  if (!journey?.durationMinutes) continue
                  if (sourceId === hub.pCoord) continue  // already covered by Option B
                  // Find the terminal name of this source-journey origin.
                  // featureJourneys is keyed by station ID post Phase 4, so
                  // we look up the source station's feature by its id.
                  const srcStationFeat = baseStations.features.find(
                    (x) => (x.properties as { id?: string }).id === sourceId,
                  )
                  const srcCanonical = matchTerminal(srcStationFeat?.properties?.name, londonTerminals)
                  if (!srcCanonical || srcCanonical === hubCanonical) continue
                  // terminal-matrix gives hub→srcTerminal hop time.
                  const matrixHop = terminalMatrix[hubCanonical]?.[srcCanonical]
                  if (!matrixHop?.minutes) continue
                  const candidate: RouteCandidate = {
                    mins:
                      hub.pToCustomMins +
                      matrixHop.minutes +
                      // Two interchanges: at the hub, then at srcCanonical
                      // (the terminal whose source journey we're piping through).
                      interchangeBufferFor(hub.routes.name) +
                      interchangeBufferFor(srcCanonical) +
                      journey.durationMinutes,
                    // Two changes (X→hub, hub→src) on top of the source
                    // journey's own changes. For VXH→Oxford via Waterloo
                    // +Farringdon: 2 + 1 (Farringdon→Paddington→Oxford) = 3.
                    changes: 2 + (journey.changes ?? 0),
                    hub,
                    kind: "double-hop",
                    sourceJourney: journey,
                    doubleHopVia: srcCanonical,
                    doubleHopMins: matrixHop.minutes,
                  }
                  if (isBetter(candidate, winner)) winner = candidate
                }
              }
            }
            // Option D: composed-via-terminal — try every (hub H, terminal T)
            // pair and use stitchJourney to synthesise a T→D mainline from
            // any source journey on the feature. Crucial for destinations
            // where the best first terminus isn't one of the baseline Routes
            // API origins (PAD, VIC, Marylebone, …).
            // primaryOrigin is an ID post Phase 3c; the compose helpers
            // want a real coord string for parseCoordKey on the home
            // station, so resolve via the registry once per branch.
            const primaryCoordStr = registryGetCoordKey(primaryOrigin) ?? ""
            {
              const composed = primaryCoordStr ? tryComposeViaTerminal(
                f,
                customHubs,
                coordToName[primaryOrigin] ?? primaryOrigin,
                primaryCoordStr,
              ) : null
              if (composed && customHubs[0]) {
                const candidate: RouteCandidate = {
                  mins: composed.mins,
                  changes: composed.changes,
                  hub: customHubs[0],
                  kind: "composed",
                  composedJourney: composed.journey,
                }
                if (isBetter(candidate, winner)) winner = candidate
              }
            }
            // Option E: Extension B — triple-hop walking-interchange.
            // Covers CLJ→YAL class journeys where the user takes rail
            // to a terminus, walks to an adjacent origin-routes hub
            // (e.g. WAT→WAE), then takes two more rail legs. Same
            // rendering path as "composed" because its journey has
            // pre-assembled legs + polyline.
            {
              const viaWalk = (featureId && primaryCoordStr) ? tryComposeViaWalkingDoubleHub(
                customHubs,
                featureId,
                coordToName[primaryOrigin] ?? primaryOrigin,
                primaryCoordStr,
              ) : null
              if (viaWalk && customHubs[0]) {
                const candidate: RouteCandidate = {
                  mins: viaWalk.mins,
                  changes: viaWalk.changes,
                  hub: customHubs[0],
                  kind: "composed",
                  composedJourney: viaWalk.journey,
                }
                if (isBetter(candidate, winner)) winner = candidate
              }
            }
            // Option F: Extension C — TfL-hop primary→T→D composition.
            // Uses data/tfl-hop-matrix.json to bridge primary→T even
            // when the primary has no direct rail to T. Unlocks
            // destinations directly reachable from termini the primary
            // can't reach via customHubs (CLJ→Wendover via MYB,
            // CLJ→WelwynGC via KGX, etc.). Same rendering path as
            // "composed" — the journey ships with pre-assembled legs.
            {
              const viaTflHop = (featureId && primaryCoordStr) ? tryComposeViaPrimaryHop(
                coordToName[primaryOrigin] ?? primaryOrigin,
                featureId,
                primaryCoordStr,
                f.properties.journeys as Record<string, { polyline?: string }> | undefined,
              ) : null
              if (viaTflHop && customHubs[0]) {
                const candidate: RouteCandidate = {
                  mins: viaTflHop.mins,
                  changes: viaTflHop.changes,
                  hub: customHubs[0],
                  kind: "composed",
                  composedJourney: viaTflHop.journey,
                }
                if (isBetter(candidate, winner)) winner = candidate
              }
            }
            if (winner != null) {
              originMins = winner.mins
              effectiveChanges = winner.changes
              const hubName = winner.hub.routes.name ?? ""
              const customName = coordToName[primaryOrigin] ?? primaryOrigin

              // Helpers for building the hover polyline on custom primaries.
              // Primary-owned (RTT / Routes-API) journeys already get a
              // polylineCoords at fetch time; custom-primary synth-journeys
              // didn't, which is why hovering a reachable destination from a
              // non-terminus home station used to show no line on the map.
              // We build one here by prepending the custom-primary coord to
              // whatever coords the backbone of the journey already has.
              // primaryOrigin is an ID; resolve via the registry before
              // parsing into lng/lat for the polyline anchor.
              const { lng: pLng, lat: pLat } = parseCoordKey(registryGetCoordKey(primaryOrigin) ?? "")
              // Pull coords out of a pre-existing journey: polylineCoords if
              // present (RTT path), else decode the `polyline` string
              // (Google Routes path).
              const sourceCoordsFromJourney = (j: JourneyInfo | undefined): [number, number][] | null => {
                if (!j) return null
                const g = j as unknown as { polyline?: string; polylineCoords?: [number, number][] }
                if (g.polylineCoords && g.polylineCoords.length > 1) return g.polylineCoords
                if (g.polyline) return decodePolyline(g.polyline)
                return null
              }

              if (winner.kind === "composed") {
                // Composed journey already has fully assembled legs
                // (X→hub OTHER, optional hub→T matrix OTHER, ...stitched.legs).
                // No extra polyline construction here — hover polyline will
                // fall back to straight segments if absent. Good enough for
                // the edge-case coverage this path unlocks.
                synthJourney = winner.composedJourney ?? null
              } else if (winner.kind === "rtt-direct") {
                // Legs: [custom→hub interchange, hub→dest mainline].
                // Calling points use the hub's own RTT data for this dest,
                // so the "…can also be boarded at" hint reflects the actual
                // train the user boards after changing. callingPointsLegArrival
                // is set to the destination's name so photo-overlay renders
                // the "Alternative starts for the direct train to {dest}"
                // variant (since the HEAVY_RAIL leg's arrival IS the dest).
                const hubEntry = featureId ? winner.hub.routes.directReachable?.[featureId] : undefined
                const hubEntryName = hubEntry?.name ?? ""
                const cp = featureId ? buildCallingPoints(winner.hub.pCoord, featureId) : null
                // Polyline: [custom home] → [hub calling points → dest].
                // fastestCallingPoints[0] IS the hub, so we just stick the
                // home-station coord on the front. One straight line then
                // tracks the actual calling-point sequence.
                const hubToDestCoords = (hubEntry?.fastestCallingPoints ?? [])
                  .map((crs) => crsToCoord[crs])
                  .filter((c): c is [number, number] => !!c)
                const polylineCoords = hubToDestCoords.length > 1
                  ? [[pLng, pLat] as [number, number], ...hubToDestCoords]
                  : undefined
                synthJourney = {
                  durationMinutes: winner.mins,
                  changes: winner.changes,
                  legs: [
                    {
                      vehicleType: "OTHER",
                      departureStation: customName,
                      arrivalStation: hubName,
                    },
                    {
                      vehicleType: "HEAVY_RAIL",
                      departureStation: hubName,
                      arrivalStation: hubEntryName,
                      stopCount: hubEntry
                        ? Math.max(0, hubEntry.fastestCallingPoints.length - 2)
                        : 0,
                    },
                  ],
                  polylineCoords,
                  londonCallingPoints: cp && cp.downstream.length > 0 ? cp.downstream : undefined,
                  londonUpstreamCallingPoints: cp && cp.upstream.length > 0 ? cp.upstream : undefined,
                  callingPointsLegArrival: hubEntryName,
                } as unknown as JourneyInfo
              } else if (winner.kind === "source-stitched") {
                // Prepend the custom→hub interchange to the full source-
                // journey legs array. The source journey already describes
                // hub→...→destination, with whatever internal structure
                // (possibly multiple legs + changes).
                const prepended = [
                  {
                    vehicleType: "OTHER",
                    departureStation: customName,
                    arrivalStation: hubName,
                  },
                  ...(winner.sourceJourney?.legs ?? []),
                ]
                // Polyline: [custom home] + source journey's own polyline.
                // The source journey starts at the hub, so the home→hub
                // segment is a single straight prepend.
                const srcCoords = sourceCoordsFromJourney(winner.sourceJourney)
                const polylineCoords = srcCoords
                  ? [[pLng, pLat] as [number, number], ...srcCoords]
                  : undefined
                synthJourney = {
                  durationMinutes: winner.mins,
                  changes: winner.changes,
                  legs: prepended,
                  polylineCoords,
                } as unknown as JourneyInfo
                // Populate calling points by picking the richest HEAVY_RAIL
                // leg of the synth (via donor-terminal fallback when needed).
                // See enrichSynthJourneyCallingPoints header comment.
                enrichSynthJourneyCallingPoints(synthJourney, f.properties.name as string)
              } else {
                // double-hop: [X→hub interchange, hub→viaTerminal matrix
                // hop, ...sourceJourney.legs]. Two synthesised "OTHER" legs
                // at the front because neither the RTT hub nor the matrix
                // hop fits cleanly into HEAVY_RAIL / SUBWAY (the matrix
                // hop is tube/walk but recorded as "OTHER" for narrative
                // consistency with the existing interchange leg style).
                const prepended = [
                  {
                    vehicleType: "OTHER",
                    departureStation: customName,
                    arrivalStation: hubName,
                  },
                  {
                    vehicleType: "OTHER",
                    departureStation: hubName,
                    arrivalStation: winner.doubleHopVia ?? "",
                  },
                  ...(winner.sourceJourney?.legs ?? []),
                ]
                // Polyline: [custom home] → [hub] → [source journey].
                // The source journey starts at the via-terminal (which is
                // where the matrix hop lands); the hub→via-terminal hop
                // is drawn as a single straight segment. Home→hub is
                // another straight segment on the front.
                // winner.hub.pCoord is a station ID post Phase 3c —
                // resolve to its real coord before parsing.
                const { lng: hLng, lat: hLat } = parseCoordKey(registryGetCoordKey(winner.hub.pCoord) ?? "")
                const srcCoords = sourceCoordsFromJourney(winner.sourceJourney)
                const polylineCoords = srcCoords
                  ? [[pLng, pLat] as [number, number], [hLng, hLat] as [number, number], ...srcCoords]
                  : undefined
                synthJourney = {
                  durationMinutes: winner.mins,
                  changes: winner.changes,
                  legs: prepended,
                  polylineCoords,
                } as unknown as JourneyInfo
                enrichSynthJourneyCallingPoints(synthJourney, f.properties.name as string)
              }
            } else {
              // Both options failed — destination isn't reachable via any
              // customHubs (either as direct RTT destination or as a pre-
              // fetched source-journey key). Drop from the map.
              rttClearLondonMinutes = true
            }
            }
          }
        } else {
          const journeys = f.properties.journeys as Record<string, JourneyInfo> | undefined
          const primaryJourney = journeys?.[primaryOrigin]
          // getEffectiveJourney still uses canonical names internally (e.g. to detect
          // "Kings Cross" cluster and strip initial tube hops), so pass the name.
          const effective = primaryJourney ? getEffectiveJourney(primaryJourney, primaryName) : null
          // Farringdon is the baseline origin — londonMinutes already matches, no override.
          originMins = primaryName !== "Farringdon" ? effective?.effectiveMinutes : undefined
          effectiveChanges = effective?.effectiveChanges

          // Calling-points enrichment for curated primaries WITHOUT their
          // own RTT data (currently only Stratford). The pre-fetched Google
          // Routes journey has accurate timing but no calling-point info,
          // so trains like LST→Shoeburyness that call at Stratford never
          // surface Liverpool Street as an earlier-boarding option. Run
          // the same-train search here — if some London terminal's train
          // calls at both the primary AND the destination, build calling
          // points from that terminal's data relative to the primary. The
          // existing journey's duration/legs stay intact; we only ADD the
          // calling-point arrays to it.
          if (
            !isRttPrimary &&
            primaryJourney &&
            (effective?.effectiveChanges ?? 0) === 0
          ) {
            let terminalCoord: string | undefined
            let xTimeRelativeToP: number | undefined
            for (const tc of Object.keys(originRoutes)) {
              const entry = featureId ? originRoutes[tc]?.directReachable?.[featureId] : undefined
              if (!entry) continue
              const upstreamMatch = entry.upstreamCallingPoints?.find(
                (u) => u.crs === primaryOrigin,
              )
              if (upstreamMatch) {
                terminalCoord = tc
                xTimeRelativeToP = -upstreamMatch.minutesBeforeOrigin
                break
              }
              const isIntermediate = entry.fastestCallingPoints.slice(1, -1).some((crs) => crs === primaryOrigin)
              if (isIntermediate) {
                const pToX = originRoutes[tc]?.directReachable?.[primaryOrigin]?.minMinutes
                if (pToX != null) {
                  terminalCoord = tc
                  xTimeRelativeToP = pToX
                  break
                }
              }
            }
            if (terminalCoord != null && xTimeRelativeToP != null && featureId) {
              const cp = buildSameTrainCallingPoints(terminalCoord, featureId, xTimeRelativeToP)
              if (cp && (cp.downstream.length > 0 || cp.upstream.length > 0)) {
                // Shallow-clone the existing journey and attach calling
                // points. Cast through unknown because the base JourneyInfo
                // type used by StationFeature's properties may not declare
                // these optional fields explicitly.
                synthJourney = {
                  ...primaryJourney,
                  londonCallingPoints: cp.downstream.length > 0 ? cp.downstream : undefined,
                  londonUpstreamCallingPoints: cp.upstream.length > 0 ? cp.upstream : undefined,
                } as unknown as JourneyInfo
              }
            }
          }
        }

        // Build next properties — optionally override londonMinutes,
        // then stash routing results. The isBuried flag is
        // intentionally NOT applied here — it gets applied in a
        // separate thin useMemo downstream (see `stations` above)
        // so toggling it doesn't force this heavy routing pass to re-run.
        const next: Record<string, unknown> = { ...f.properties }
        if (originMins != null) next.londonMinutes = originMins
        else if (rttClearLondonMinutes) next.londonMinutes = null
        // Stash the effective-changes count so the direct-trains filter can use
        // it without recomputing. Falsy (0/undefined) means "no effective changes".
        if (effectiveChanges != null) next.effectiveChanges = effectiveChanges
        // Merge the synthesised CHX journey into the journeys dict so modal +
        // hover-polyline code paths find it by coord key like any other primary.
        if (synthJourney) {
          const existing = f.properties.journeys as Record<string, JourneyInfo> | undefined
          next.journeys = { ...(existing ?? {}), [primaryOrigin]: synthJourney }
        } else if (spliceOverride) {
          // Option 2 splice replaced the prefetched/custom Google journey with
          // a faster hybrid. Write it back onto the feature so the modal's
          // leg breakdown + hover polyline code read the hybrid timings
          // rather than the original Google-sourced journey.
          const existing = f.properties.journeys as Record<string, JourneyInfo> | undefined
          next.journeys = { ...(existing ?? {}), [primaryOrigin]: spliceOverride }
        }

        // Alternative terminus routes (London synthetic primary only).
        // Lets the modal surface "Victoria is 6 min slower but direct too"
        // scenarios. Only relevant when the user's home is the whole
        // London cluster — for any other primary, the specific terminus
        // they'd use is already nailed down.
        if (primaryOrigin === "CLON") {
          const activeJ = (next.journeys as Record<string, JourneyInfo> | undefined)?.[primaryOrigin]
          if (activeJ) {
            type Candidate = {
              terminusName: string
              terminusCoord: string
              durationMinutes: number
              callingList: string[]
              downstream: { name: string; crs: string; minutesFromOrigin: number }[]
              upstream: { name: string; crs: string; minutesExtra: number }[]
              changes: number
              changeStations: string[]
            }
            const candidates: Candidate[] = []
            // london-terminals.json's lat/lng are rounded/approximate and
            // don't match origin-routes.json keys. Use the cluster coord
            // list instead — those ARE the origin-routes.json keys (same
            // strings we use everywhere else for terminus identification).
            const clusterCoords = PRIMARY_ORIGIN_CLUSTER[primaryOrigin] ?? []
            for (const tCoord of clusterCoords) {
              const tRoutes = originRoutes[tCoord]
              if (!tRoutes) continue
              const entry = featureId ? tRoutes.directReachable?.[featureId] : undefined
              if (!entry?.minMinutes) continue
              // Resolve terminus display name through matchTerminal so cluster
              // satellites (Waterloo East, Euston Underground) surface under
              // their canonical parent name (Waterloo / Euston).
              const canonical = matchTerminal(tRoutes.name, londonTerminals) ?? tRoutes.name
              // Dedupe — multiple coord entries can map to the same canonical
              // terminus (KX Underground + NR, StP main + HS1). Keep the
              // fastest observation per canonical name.
              const existing = candidates.find((c) => c.terminusName === canonical)
              if (existing && existing.durationMinutes <= entry.minMinutes) continue
              const cp = featureId ? buildCallingPoints(tCoord, featureId) : null
              const record: Candidate = {
                terminusName: canonical,
                terminusCoord: tCoord,
                durationMinutes: entry.minMinutes,
                callingList: entry.fastestCallingPoints ?? [],
                downstream: cp?.downstream ?? [],
                upstream: cp?.upstream ?? [],
                changes: 0,
                changeStations: [],
              }
              if (existing) Object.assign(existing, record)
              else candidates.push(record)
            }
            // Indirect-route composition. For any terminus T that does
            // NOT have D direct, try to compose T → hub → D where hub
            // is any origin-routes entry that both T reaches directly
            // AND that directly reaches D. Uses per-station change
            // buffers via interchangeBufferFor() at each hand-off.
            //
            // CRITICAL filter: the hub must NOT be a London terminus.
            // If H is a terminus, then "T → H → D" is really just "go
            // to H and take H's train" — i.e. a different way to reach
            // an existing direct-route candidate, not a genuinely
            // different physical route. Including those pollutes the
            // alt-route list with near-duplicates (e.g. CST→LBG→Hastings,
            // BFR→LBG→Hastings, STP→LBG→Hastings are all just "catch
            // the LBG Hastings train"). The only indirect alts worth
            // surfacing are those via SUBURBAN interchanges — CLJ, ECR,
            // Ashford, Haywards Heath, etc — where the hub isn't a
            // terminus and the combined journey has legitimately
            // different character.
            const clusterCoordSet = new Set(clusterCoords)
            // Zone 1 filter: any hub whose coord lies inside the rough
            // zone-1 bounding box (TfL zone 1 ≈ lng [-0.20, -0.05],
            // lat [51.49, 51.54]) is ALSO treated as a terminus for
            // alt-route filtering. Rationale: routing via a zone-1
            // hub (e.g. Farringdon for a T→ZFD→D indirect path) is
            // functionally "go into central London then board another
            // train" — the same shape as going via an actual terminus.
            // Surfacing those as separate "alternative routes" would
            // just duplicate the main route's narrative. Currently
            // affects Farringdon and will auto-include any other
            // zone-1 hub we fetch later.
            // Translate the station ID back to its real coord before
            // bbox-checking. Hubs in originRoutes are keyed by ID post
            // Phase 3c, so the coord-shaped check needs the registry.
            const isInZone1 = (id: string) => {
              const coord = registryGetCoordKey(id)
              if (!coord) return false
              const [lngS, latS] = coord.split(",")
              const lng = parseFloat(lngS), lat = parseFloat(latS)
              return lng >= -0.20 && lng <= -0.05 && lat >= 51.49 && lat <= 51.54
            }
            for (const tCoord of clusterCoords) {
              const tRoutes = originRoutes[tCoord]
              if (!tRoutes) continue
              const canonical = matchTerminal(tRoutes.name, londonTerminals) ?? tRoutes.name
              // Skip if we already have a direct entry for this terminus.
              if (candidates.some((c) => c.terminusName === canonical)) continue
              // Iterate every origin-routes hub H — both T reaches it AND
              // it reaches D. Pick the hub minimising total duration.
              let best: null | {
                hubName: string
                totalMin: number
                tToHMin: number
                hCoord: string
              } = null
              for (const [hCoord, hRoutes] of Object.entries(originRoutes)) {
                if (hCoord === tCoord) continue
                // Hub must be a suburban / regional interchange — not
                // a London terminus AND not inside zone 1 (which reads
                // as "you're already in central London, just go direct
                // from the right terminus").
                if (clusterCoordSet.has(hCoord)) continue
                if (isInZone1(hCoord)) continue
                const tToH = tRoutes.directReachable?.[hCoord]
                const hToD = featureId ? hRoutes.directReachable?.[featureId] : undefined
                if (!tToH?.minMinutes || !hToD?.minMinutes) continue
                // Interchange happens at H (between the two rail legs).
                const total = tToH.minMinutes + interchangeBufferFor(hRoutes.name) + hToD.minMinutes
                if (!best || total < best.totalMin) {
                  best = {
                    hubName: hRoutes.name ?? hCoord,
                    totalMin: total,
                    tToHMin: tToH.minMinutes,
                    hCoord,
                  }
                }
              }
              if (!best) continue
              // Upstream + downstream of the first leg (T → hub).
              // Both reuse buildCallingPoints on T's hub-direct entry.
              // Downstream on an indirect alt = intermediate stops on
              // leg 1 before the change station, which are valid
              // alternative boarding points for the same journey
              // (e.g. Moorgate→FPK→Welwyn: board at Old Street
              // instead of Moorgate and save 2 min).
              const cpLeg1 = buildCallingPoints(tCoord, best.hCoord)
              candidates.push({
                terminusName: canonical,
                terminusCoord: tCoord,
                durationMinutes: best.totalMin,
                // Sentinel calling list — keeps indirect candidates from
                // dedup-merging with direct ones (they won't be suffix
                // matches since only-directs have real calling lists and
                // indirects have no overlap with them).
                callingList: [`__indirect_via_${best.hubName}`],
                downstream: cpLeg1?.downstream ?? [],
                upstream: cpLeg1?.upstream ?? [],
                changes: 1,
                changeStations: [best.hubName],
              })
            }
            if (candidates.length >= 2) {
              candidates.sort((a, b) => a.durationMinutes - b.durationMinutes)
              // Generalised dedup rule: if candidate B's calling list is
              // [extra...] + A's calling list (A is a proper suffix of B),
              // they're the same physical train and B is upstream of A.
              // Iterate fastest-first, keep the shortest-list representative
              // per physical-train cluster, and roll extensions up as its
              // upstream board points. Fixes Balcombe (LBG + BFR + STP on
              // same Thameslink), Hastings (LBG + WAE + CHX on same
              // Southeastern), Hassocks (BFR + STP on Thameslink — show
              // BFR paragraph with STP as its upstream start).
              type Kept = Candidate & {
                extraUpstream: { name: string; crs: string; minutesExtra: number }[]
              }
              const kept: Kept[] = []
              for (const c of candidates) {
                // Does this candidate EXTEND an already-kept one (tail match)?
                let extOf: Kept | null = null
                for (const k of kept) {
                  if (c.callingList.length <= k.callingList.length) continue
                  const tail = c.callingList.slice(-k.callingList.length).join(",")
                  if (tail === k.callingList.join(",")) { extOf = k; break }
                }
                if (extOf) {
                  const mb = c.durationMinutes - extOf.durationMinutes
                  if (mb > 0) {
                    extOf.extraUpstream.push({
                      name: c.terminusName,
                      crs: originRoutes[c.terminusCoord]?.crs ?? "",
                      minutesExtra: mb,
                    })
                  }
                } else {
                  kept.push({ ...c, extraUpstream: [] })
                }
              }
              const main = kept[0]
              // "Subset coverage" dedup — drop any alternative whose
              // set of MENTIONED LONDON TERMINI is already fully
              // covered by higher-ranked (kept) routes. Only London
              // termini count: intermediate suburban stops (e.g.
              // Coulsdon South on a BFR alt) shouldn't save a route
              // that otherwise restates termini already listed.
              // Farringdon is EXCLUDED — it's a through-station, not
              // a terminus, and its appearance in a route doesn't
              // constitute a genuinely new London boarding option.
              // WAE normalises to WAT (Waterloo East sits under the
              // Waterloo cluster).
              const LONDON_TERMINUS_CRS = new Set<string>([
                "KGX", "STP", "SPL", "EUS",     // KX / St Pancras / Euston
                "PAD", "VIC", "WAT", "WAE",      // Paddington / Vic / Waterloo (+ East)
                "LST", "MYB", "CHX", "LBG",      // LSt / Marylebone / CHX / LBG
                "BFR", "FST", "CST", "MOG",      // Blackfriars / FST / CST / Moorgate
                // NOTE: Farringdon (ZFD) intentionally omitted.
              ])
              const CLUSTER_PARENT: Record<string, string> = { WAE: "WAT" }
              const normCrs = (crs: string) => CLUSTER_PARENT[crs] ?? crs
              type KeptRoute = typeof main
              // Coverage set for dedup: ONLY London-terminus CRS
              // codes appearing in this route. Non-terminus stops
              // (Coulsdon South, Finsbury Park as an interchange,
              // etc.) are filtered out so they can't save an alt
              // that restates already-covered termini.
              const coveredSet = (r: KeptRoute): Set<string> => {
                const set = new Set<string>()
                const push = (raw: string | undefined) => {
                  if (!raw) return
                  const c = normCrs(raw)
                  if (LONDON_TERMINUS_CRS.has(c)) set.add(c)
                }
                push(originRoutes[r.terminusCoord]?.crs)
                for (const u of r.upstream) push(u.crs)
                for (const u of r.extraUpstream) push(u.crs)
                for (const d of r.downstream) push(d.crs)
                return set
              }
              const unionCovered = coveredSet(main)
              const alternatives: KeptRoute[] = []
              for (const c of kept.slice(1)) {
                if (c.durationMinutes > main.durationMinutes + 30) continue
                const altCov = coveredSet(c)
                // Empty terminus set → the alt mentions no termini
                // at all (rare — would only happen if the route runs
                // entirely through non-terminus London stations).
                // Treat as "nothing new", drop it.
                if (altCov.size === 0) continue
                let allCovered = true
                for (const s of altCov) {
                  if (!unionCovered.has(s)) { allCovered = false; break }
                }
                if (allCovered) continue
                alternatives.push(c)
                // Roll this alt's terminus coverage into the union so
                // later alts are compared against the full picture
                // (main + previously-kept alts).
                for (const s of altCov) unionCovered.add(s)
              }
              // Merge main.extraUpstream into the active journey's upstream
              // list when the journey matches the main terminus (cheap
              // check: same duration within a small tolerance).
              const enriched: JourneyInfo = { ...activeJ }
              if (
                main.extraUpstream.length > 0 &&
                Math.abs((enriched.durationMinutes ?? 0) - main.durationMinutes) <= 2
              ) {
                const existingUp = enriched.londonUpstreamCallingPoints ?? []
                const seen = new Set(existingUp.map((u) => u.crs))
                const merged = [...existingUp]
                for (const u of main.extraUpstream) if (!seen.has(u.crs)) merged.push(u)
                // Sort by minutesExtra descending — earliest boarding first.
                merged.sort((a, b) => b.minutesExtra - a.minutesExtra)
                enriched.londonUpstreamCallingPoints = merged
              }
              if (alternatives.length > 0) {
                enriched.alternativeRoutes = alternatives.map((c) => {
                  // Merge each alternative's own extraUpstream into its
                  // upstream calling-points list so the paragraph shows
                  // sibling termini as board points too (e.g. BFR alt route
                  // paragraph carries STP as an upstream start).
                  const existingUp = c.upstream
                  const seen = new Set(existingUp.map((u) => u.crs))
                  const merged = [...existingUp]
                  for (const u of c.extraUpstream) if (!seen.has(u.crs)) merged.push(u)
                  merged.sort((a, b) => b.minutesExtra - a.minutesExtra)
                  return {
                    terminusName: c.terminusName,
                    durationMinutes: c.durationMinutes,
                    changes: c.changes,
                    changeStations: c.changeStations,
                    londonCallingPoints: c.downstream,
                    londonUpstreamCallingPoints: merged,
                  }
                })
              }
              if (enriched !== activeJ) {
                next.journeys = {
                  ...(next.journeys as Record<string, JourneyInfo> | undefined ?? {}),
                  [primaryOrigin]: enriched,
                }
              }
            }
          }
        }

        return { ...f, properties: next as StationFeature["properties"] }
      }),
    }
  }, [baseStations, primaryOrigin, coordToName, precomputedRoutingByPrimary, friendOrigin, bypassPrecomputeForSlug])
  // Keep a ref in sync with the routedStations memo output for the
  // async admin "Regenerate routing" flow, which reads the latest
  // compute result after awaited state transitions.
  useEffect(() => { routedStationsRef.current = routedStations }, [routedStations])

  // Thin wrapper that applies the isBuried flag + isClusterMember flag
  // per feature. Cheap (Set.has lookups + object spread, no routing
  // work), so toggling via admin actions is instant.
  //
  // isClusterMember is static (membership doesn't change at runtime), so
  // its derivation lives here even though it'd be valid to compute it
  // once at module load. Stamping per-render keeps everything that
  // consumes feature.properties uniform — Mapbox layer expressions read
  // it as if it were any other property.
  const stations = useMemo(() => {
    if (!routedStations) return null
    // ── Virtual synthetic features ────────────────────────────────
    // Every non-active synthetic (Birmingham, Manchester, Stratford,
    // Central London when a different primary is active) gets a
    // virtual Point feature at its centroid so it flows through the
    // same filter/icon/click pipeline as a real station. Active
    // primary/friend synthetics are NOT in this list — their
    // hexagon/square legacy layers handle them. Each synthetic's
    // londonMinutes / effectiveChanges / journeys come from the
    // top-ranked cluster member (changes-first, duration-tiebreak,
    // matching lib/stitch-journey.ts) so the time slider and direct-
    // only filter behave intuitively. The journey paragraph in the
    // overlay reads from these too.
    const synthFeatures: typeof routedStations.features = []
    // Iterate every cluster — including destination-only ones (no
    // origin flags) — so they all flow through the same virtual-
    // feature pipeline. Windsor for example has no origin flags yet
    // but still needs its anchor to render and be clickable.
    for (const [synthId, def] of Object.entries(ALL_CLUSTERS)) {
      const memberIds = def.members
      // Skip the active primary/friend — their hexagon/square is
      // already rendered, and we don't want a duplicate icon on top.
      if (synthId === primaryOrigin) continue
      if (synthId === friendOrigin) continue
      // When a Central London terminus is the active primary, the whole
      // Central London cluster is "disabled" — skip its virtual feature
      // so it doesn't surface as a destination icon at the British Museum
      // centroid, and (crucially) its anchor doesn't get added to
      // visibleSynthAnchors below, which would otherwise re-enable the
      // members' diamonds + cluster hover/anchor-line behaviours.
      if (isLondonTerminusActive && synthId === CENTRAL_LONDON_ANCHOR) continue

      // Collect each member's feature from routedStations. Members are
      // station IDs; the routing pass stamps `id` on every feature
      // (Phase 3c Step 4), so this is a direct id→feature lookup.
      type Feat = (typeof routedStations.features)[number]
      const memberFeats: Feat[] = []
      for (const mid of memberIds) {
        const f = routedStations.features.find((g) => (g.properties as { id?: string }).id === mid)
        if (f) memberFeats.push(f)
      }
      if (memberFeats.length === 0) continue

      // Pick the top-ranked cluster member by primary journey.
      // primaryOrigin is a coord, journeys on each member are
      // coord-keyed too, so a direct lookup works.
      const memberPrimaryJourneys = memberFeats.map((f) =>
        ((f.properties as { journeys?: Record<string, JourneyInfo> }).journeys ?? {})[primaryOrigin],
      )
      const candPrimary: RankableJourney[] = memberPrimaryJourneys.map((j) => ({
        durationMinutes: j?.durationMinutes,
        changes: j?.changes,
      }))
      const bestPrimaryIdx = pickTopRankedIndex(candPrimary)
      // No primary journey to any member → synthetic isn't reachable
      // from this primary; skip it. The map won't render an unreachable
      // synthetic just like it doesn't render unreachable real stations.
      if (bestPrimaryIdx === -1) continue
      const bestPrimaryJourney = memberPrimaryJourneys[bestPrimaryIdx]
      if (!bestPrimaryJourney) continue
      const bestPrimaryMemberFeat = memberFeats[bestPrimaryIdx]
      const bestPrimaryMemberName = (bestPrimaryMemberFeat.properties as { name?: string }).name ?? ""

      // Compose the synthetic's coord-keyed journeys map. We start
      // from the top primary member's journeys so per-friend lookups
      // (including getFriendJourney's cluster-member fallback) have
      // data to fall through to.
      const baseJourneys = ((bestPrimaryMemberFeat.properties as { journeys?: Record<string, JourneyInfo> }).journeys ?? {}) as Record<string, JourneyInfo>
      const journeys: Record<string, JourneyInfo> = { ...baseJourneys }
      // Always set the primary entry to the top-from-primary journey
      // (in case the base member's primary entry differed).
      journeys[primaryOrigin] = bestPrimaryJourney

      // Pick top-ranked cluster member for the friend journey too —
      // can be a different member than the one chosen for the primary,
      // because "best from London" and "best from Manchester" don't
      // always agree. Falls through getFriendJourney's logic for
      // synthetic friends (per-member fallback inside the destination
      // feature's journeys map).
      let bestFriendMemberName: string | undefined
      if (friendOrigin) {
        const friendCandidates: { feat: Feat; journey: { durationMinutes?: number; changes?: number } | undefined }[] =
          memberFeats.map((f) => ({
            feat: f,
            journey: getFriendJourney(
              ((f.properties as { journeys?: Record<string, JourneyInfo> }).journeys ?? {}) as Record<string, { durationMinutes?: number; changes?: number }>,
              friendOrigin,
            ),
          }))
        const bestFriendIdx = pickTopRankedIndex(
          friendCandidates.map((c) => ({
            durationMinutes: c.journey?.durationMinutes,
            changes: c.journey?.changes,
          })),
        )
        if (bestFriendIdx >= 0 && friendCandidates[bestFriendIdx].journey) {
          bestFriendMemberName = (friendCandidates[bestFriendIdx].feat.properties as { name?: string }).name
          // Stamp the friend journey under the friend coord so the
          // friend description renders without going through cluster
          // fallback (cleaner data path for the modal).
          journeys[friendOrigin] = friendCandidates[bestFriendIdx].journey as JourneyInfo
        }
      }

      // The cluster's centroid coord is carried in clusters-data.json's
      // `coord` field for each anchor. SYNTHETIC_COORDS surfaces it for
      // the rendering sites that need a position (Mapbox label points,
      // synth-anchor-icon layers).
      const synthCoord = SYNTHETIC_COORDS[synthId] ?? def.coord
      const [lng, lat] = synthCoord.split(",").map(Number)
      const synthName = SYNTHETIC_DISPLAY_NAMES[synthId] ?? synthId
      // buriedStations is coord-keyed at rest (admin state file).
      const isBuried = buriedStations.has(synthCoord)
      const props: Record<string, unknown> = {
        // Both id and coordKey on the virtual feature so the click
        // handler + downstream layers can read either form.
        id: synthId,
        coordKey: synthCoord,
        name: synthName,
        londonMinutes: bestPrimaryJourney.durationMinutes ?? null,
        effectiveChanges: bestPrimaryJourney.changes ?? 0,
        journeys,
        isSynthetic: true,
      }
      if (isBuried) props.isBuried = true
      // Member names for the journey paragraph prefix in the overlay.
      // Stamped here so the modal-render site can read them off the
      // SelectedStation without needing to recompute the top-ranked
      // member.
      if (bestPrimaryMemberName) props.syntheticPrimaryMemberName = bestPrimaryMemberName
      if (bestFriendMemberName) props.syntheticFriendMemberName = bestFriendMemberName

      synthFeatures.push({
        type: "Feature",
        geometry: { type: "Point", coordinates: [lng, lat] },
        properties: props,
      } as unknown as Feat)
    }

    return {
      ...routedStations,
      features: [
        ...routedStations.features.map((f) => {
          const coordKey = f.properties.coordKey as string
          const id = f.properties.id as string | undefined
          // buriedStations is coord-keyed (admin state file), so we
          // still index it by coord — but cluster-membership is keyed
          // by ID post Phase 3c, so we read MEMBER_TO_SYNTHETIC and
          // ALL_CLUSTER_MEMBER_IDS using the feature's id.
          const isBuried = buriedStations.has(coordKey)
          // When a Central London terminus IS the active primary, suspend
          // the cluster-member treatment for every Central London member.
          // Without this, those members are filtered out of every regular
          // station layer (which all carry `["!", ["has", "isClusterMember"]]`)
          // AND filtered out of the cluster diamond layer (because the
          // Central London anchor isn't in visibleSynthAnchors when the
          // primary isn't the anchor) — they'd render NOWHERE. Stripping
          // the flag lets them render as ordinary station icons under
          // the standard zoom-tier rules, which matches the spec: in
          // London-terminus-as-primary mode, the cluster is "disabled"
          // and members behave like normal stations.
          const isCentralLondonMember = id ? MEMBER_TO_SYNTHETIC[id] === CENTRAL_LONDON_ANCHOR : false
          const isClusterMember =
            !!id
            && ALL_CLUSTER_MEMBER_IDS.has(id)
            && !(isLondonTerminusActive && isCentralLondonMember)
          const hadBuried = !!f.properties.isBuried
          const hadClusterMember = !!f.properties.isClusterMember
          if (isBuried === hadBuried && isClusterMember === hadClusterMember) return f
          const next: Record<string, unknown> = { ...f.properties }
          if (isBuried) next.isBuried = true; else delete next.isBuried
          if (isClusterMember) next.isClusterMember = true; else delete next.isClusterMember
          return { ...f, properties: next as typeof f.properties }
        }),
        ...synthFeatures,
      ],
    }
  }, [routedStations, buriedStations, isLondonTerminusActive])

  // Lookup sets for the admin Interchange filter. Built lazily at filter
  // time so the sets are identity-stable across renders and the memo
  // below doesn't rebuild them every slider tick.
  //   • normalise — cheap name-canonicalisation matching stitchJourney's
  //     own normalise (lowercase, strip " Station" / "London " /
  //     punctuation). Sufficient for comparing leg arrivalStation
  //     strings against the two sets below.
  //   • fullV2OriginNames — normalised names of every top-level entry
  //     in origin-routes.json. An interchange at a station in this set
  //     means we have real timetabled RTT data we can reroute through;
  //     absence = "low data" (most likely to surface routing bugs).
  //   • londonTerminalNameSet — normalised names of every terminal +
  //     alias from london-terminals.json. Distinguishes central-London
  //     terminus changes ("inner") from suburban ones ("outer").
  const interchangeLookups = useMemo(() => {
    const normaliseName = (s: string) =>
      s.toLowerCase()
        .replace(/[.'\u2019]/g, "")
        .replace(/^london\s+/, "")
        .replace(/\s+station$/, "")
        .replace(/\s*\([^)]*\)\s*$/, "")
        .trim()
    const fullV2 = new Set<string>()
    for (const entry of Object.values(originRoutes)) {
      if (entry?.name) fullV2.add(normaliseName(entry.name))
    }
    const terminals = new Set<string>()
    for (const t of londonTerminals) {
      terminals.add(normaliseName(t.name))
      for (const a of t.aliases) terminals.add(normaliseName(a))
    }
    return { normaliseName, fullV2, terminals }
  }, [])

  // Recompute filtered stations whenever the slider or raw data changes.
  // useMemo avoids re-filtering the whole array on every render.
  const filteredStations = useMemo(() => {
    if (!stations) return null
    return {
      ...stations,
      features: stations.features.filter((f) => {
        // Friend origin short-circuit — the user just picked this coord
        // as their partner's home, so it MUST be on the map even if
        // every other filter (time sliders, rating visibility, direct-
        // only, interchange, feature) would otherwise hide it. Also
        // covers the self-reachability edge case: a station isn't in
        // its own journeys dict, so the friend-mins check below would
        // null-filter it out. Hoisted to the top so it beats every
        // subsequent return-false gate.
        if (friendOrigin && (f.properties.id as string | undefined) === friendOrigin) return true

        const mins = f.properties.londonMinutes as number | null

        // Shared helper — returns true if the travel time passes both sliders.
        // When the max slider is at its admin ceiling (600), treat as unlimited.
        //
        // Stations with no time data (mins == null) are treated as
        // "arbitrarily far" — they pass only when BOTH sliders are
        // unconstrained (max at 600, min at 0). Any explicit constraint
        // hides them. Previously null-time stations always passed in
        // admin mode, which made the sliders appear broken for the
        // many distant stations whose Google Routes fetch returned
        // nothing.
        const passesTimeFilter = () => {
          if (mins == null) {
            return maxMinutes >= 600 && minMinutes <= 0
          }
          if (maxMinutes < 600 && mins > maxMinutes) return false
          if (minMinutes > 0 && mins < minMinutes) return false
          return true
        }

        // Shared helper — admin-only Feature filter. Pulled out into
        // a helper so excluded stations (which take an early return
        // path below) also get filtered. Previously this lived only
        // inline in the regular-station branch, so e.g. selecting
        // "Komoot" still showed every excluded station regardless
        // of whether they had Komoot data.
        const passesFeatureFilter = () => {
          if (primaryFeatureFilter === "off") return true
          if (primaryFeatureFilter === "alt-routes") {
            const journey = (f.properties.journeys as Record<string, JourneyInfo> | undefined)?.[primaryOrigin]
            const alts = (journey as unknown as { alternativeRoutes?: unknown[] } | undefined)?.alternativeRoutes
            return !!alts && alts.length > 0
          }
          // ID-keyed admin-state lookups. Every feature carries `id`
          // (Phase 3c) — for real NR stations it equals the CRS, for
          // non-NR stations it's the synthetic ID, and for cluster
          // anchors it's the C-prefix ID (e.g. CBIR Birmingham). Using
          // ref:crs alone would miss any cluster anchor or non-NR
          // station the user has flagged.
          const fid = f.properties.id as string | undefined
          if (primaryFeatureFilter === "private-notes") {
            const entry = fid ? stationNotes[fid] : undefined
            return !!entry?.privateNote?.trim()
          }
          if (primaryFeatureFilter === "sloppy-pics") {
            const entry = curations[f.properties.coordKey as string]
            const approvedCount = entry?.approved.length ?? 0
            return approvedCount < MAX_GALLERY_PHOTOS
          }
          if (primaryFeatureFilter === "all-sloppy-pics") {
            const entry = curations[f.properties.coordKey as string]
            const approvedCount = entry?.approved.length ?? 0
            return approvedCount === 0
          }
          if (primaryFeatureFilter === "undiscovered") {
            return !fid || !stationsHiked.has(fid)
          }
          // "Hiked" — inverse of "Undiscovered": only stations with ≥1
          // walk we've personally logged in previousWalkDates. Same
          // stationsHiked Set, opposite test.
          if (primaryFeatureFilter === "hiked") {
            return !!fid && stationsHiked.has(fid)
          }
          if (primaryFeatureFilter === "komoot") {
            return !!fid && stationsWithKomoot.has(fid)
          }
          // "No komoot" — inverse of "komoot": only stations that
          // DON'T have any attached walk with a Komoot URL. Note this
          // includes stations with no attached walks at all; the rating
          // filter still applies to gate that further if needed.
          if (primaryFeatureFilter === "no-komoot") {
            return !fid || !stationsWithKomoot.has(fid)
          }
          // "Potential month data" — stations with a Komoot route AND
          // month metadata only on admin-only walks (none on public
          // walks). Surfaces destinations where the existing admin
          // month data could be promoted to a public walk to make the
          // station appear in the public month filter.
          if (primaryFeatureFilter === "potential-month-data") {
            return !!fid && stationsPotentialMonths.has(fid)
          }
          // "Issues" — admin-flagged stations only. hasIssue is station-global
          // (set keyed by station ID, no primary-origin lookup needed).
          if (primaryFeatureFilter === "issues") {
            return !!fid && issueStations.has(fid)
          }
          // "Placemark" — admin-flagged stations whose name-label is forced
          // visible at zoom 8+. Station-global like "Issues", same Set-keyed
          // lookup pattern. Lets the admin audit the placemark set in one shot.
          if (primaryFeatureFilter === "placemark") {
            return !!fid && placemarkStations.has(fid)
          }
          // "No travel data" — destinations with no journey-time data
          // (londonMinutes is null). Only effective when the time sliders
          // are unconstrained, since passesTimeFilter() above already hides
          // null-time stations under any explicit constraint.
          if (primaryFeatureFilter === "no-travel-data") {
            return mins == null
          }
          // "Oyster" — TfL fare-area stations. Includes anything tagged
          // with an Oyster-zone network (Underground / DLR / Overground /
          // Elizabeth line) plus the curated NR list in
          // data/oyster-stations.json (Watford Junction etc.). Pulls in
          // even no-RTT-data stations (Underground, DLR), so the auto-
          // time-slider-open in the dropdown handler is what makes them
          // visible on the map.
          if (primaryFeatureFilter === "oyster") {
            const crs = f.properties["ref:crs"] as string | undefined
            if (crs && OYSTER_NR_CRS.has(crs)) return true
            const network = f.properties.network as string | undefined
            return !!network && /London Underground|Docklands Light Railway|London Overground|Elizabeth line/.test(network)
          }
          return true
        }

        // No-travel-time stations (`mins == null`) — destinations with
        // no journey-time data from the active primary. Visibility is
        // gated by the `hideNoTravelTime` toggle (admin-only checkbox;
        // default true; re-enabled on admin exit). When hidden, none
        // of the rest of the chain matters for these stations. When
        // shown, fall through to the remaining filters (feature,
        // month, rating). The time sliders + direct-only + interchange
        // filters can't act on them so skipping past those is correct.
        // The Feature dropdown's "No travel times" option lives in
        // passesFeatureFilter() below — that gates this branch on a
        // null mins AND gates the regular branch on a non-null mins,
        // collapsing the visible set to just no-travel-time stations.
        if (mins == null) {
          if (hideNoTravelTime) return false
        } else {
          if (maxMinutes < 600 && mins > maxMinutes) return false
          if (minMinutes > 0 && mins < minMinutes) return false
        }
        // "Direct trains only" for the primary origin — require 0 EFFECTIVE changes.
        // `effectiveChanges` is pre-computed above and already accounts for the
        // Kings Cross cluster (so a tube hop to Euston doesn't count as a change).
        // Falls back to raw `changes` for non-cluster origins.
        if (primaryDirectOnly) {
          const primaryChanges = f.properties.effectiveChanges as number | undefined
          if (primaryChanges == null || primaryChanges > 0) return false
        }
        // Admin-only Interchange filter — slice by where the user would
        // change trains. See `primaryInterchangeFilter` state comment for
        // the category definitions. Interchange stations are every
        // non-final leg's arrivalStation, normalised for alias matching.
        if (primaryInterchangeFilter !== "off") {
          // "direct" filters on the pre-computed effectiveChanges so it
          // behaves identically to the (now admin-mode-hidden) "Direct
          // trains only" checkbox. No leg inspection needed.
          if (primaryInterchangeFilter === "direct") {
            const primaryChanges = f.properties.effectiveChanges as number | undefined
            if (primaryChanges == null || primaryChanges > 0) return false
          } else {
            const journey = (f.properties.journeys as Record<string, JourneyInfo> | undefined)?.[primaryOrigin]
            const legs = journey?.legs ?? []
            // Non-final leg arrivals = interchange points.
            const interchanges: string[] = []
            for (let i = 0; i < legs.length - 1; i++) {
              const name = legs[i]?.arrivalStation
              if (name) interchanges.push(interchangeLookups.normaliseName(name))
            }
            if (interchanges.length === 0) return false
            if (primaryInterchangeFilter === "inner") {
              if (!interchanges.some((n) => interchangeLookups.terminals.has(n))) return false
            } else if (primaryInterchangeFilter === "outer") {
              if (!interchanges.some((n) => !interchangeLookups.terminals.has(n))) return false
            } else if (primaryInterchangeFilter === "lowdata") {
              if (!interchanges.some((n) => !interchangeLookups.fullV2.has(n))) return false
            } else if (primaryInterchangeFilter === "gooddata") {
              // Every interchange must be at a full-RTT-data station.
              // Inverse of lowdata: surfaces the cohort where the app's
              // routing shouldn't be bottlenecked by missing hub data.
              if (!interchanges.every((n) => interchangeLookups.fullV2.has(n))) return false
            }
            // "any" requires interchanges.length >= 1 which we already checked.
          }
        }
        // Admin-only Feature filter — see `passesFeatureFilter` helper
        // above for the per-option criteria.
        if (!passesFeatureFilter()) return false
        // Admin-only Source filter — keeps only stations whose attached
        // walks include at least one variant from the picked source org
        // (matches either source.orgSlug or relatedSource.orgSlug). The
        // index is built once at server build-time; here we just do a
        // Set.has lookup.
        if (sourceFilter !== "off") {
          const set = stationsBySource[sourceFilter]
          if (!set || !set.has(f.properties["ref:crs"] as string)) return false
        }
        // Month filters. Two independent filters both look up this
        // station's recommended months in stationMonths:
        //   • monthFilter (admin dropdown) — hides stations whose months
        //     don't include the selected value.
        //     Special case: "None" INVERTS the match — keeps only stations
        //     with zero month-flagged walks (missing entry OR empty array),
        //     useful for finding destinations that still need month data.
        //   • currentMonthHighlight (public checkbox) — hides stations
        //     whose months don't include the current calendar month.
        // AND semantics — both apply when both are active.
        if (monthFilter !== "off" || currentMonthHighlight) {
          // stationMonths is keyed by station ID (Phase 2c) — index by
          // the canonical id stamped on every feature.
          const fid = f.properties.id as string | undefined
          const entry = fid ? stationMonths[fid] : undefined
          const months = entry?.months ?? []
          if (monthFilter === "None") {
            if (months.length > 0) return false
          } else if (monthFilter !== "off" && !months.includes(monthFilter)) {
            return false
          }
          if (currentMonthHighlight && !months.includes(currentMonth())) return false
        }
        // When friend mode is active, also require the station to be reachable
        // from the friend's origin within the friend's max travel time
        if (friendOrigin) {
          const journeys = f.properties.journeys as Record<string, { durationMinutes?: number; changes?: number }> | undefined
          const friendJourney = getFriendJourney(journeys, friendOrigin)
          const friendMins = friendJourney?.durationMinutes
          if (friendMins == null) return false
          if (friendMaxMinutes < 600 && friendMins > friendMaxMinutes) return false
          // "Direct trains only" for the friend origin — require 0 changes
          if (friendDirectOnly) {
            const friendChanges = friendJourney?.changes
            if (friendChanges == null || friendChanges > 0) return false
          }
        }
        return true
      }),
    }
  }, [stations, maxMinutes, minMinutes, friendOrigin, friendMaxMinutes, hideNoTravelTime, primaryOrigin, primaryDirectOnly, primaryInterchangeFilter, primaryFeatureFilter, sourceFilter, stationsBySource, stationNotes, curations, interchangeLookups, friendDirectOnly, monthFilter, currentMonthHighlight, stationMonths, stationsHiked, stationsWithKomoot, stationsPotentialMonths, OYSTER_NR_CRS, issueStations, placemarkStations])

  // Further filter by search query when 3+ characters are typed.
  // We keep this separate from filteredStations so the travel-time filter is unaffected.
  const displayedStations = useMemo(() => {
    if (!filteredStations) return null
    if (!isSearching) return filteredStations
    const q = searchQuery.toLowerCase()
    return {
      ...filteredStations,
      features: filteredStations.features.filter((f) => {
        // Match on station name (substring) OR canonical station ID
        // (matched as a prefix so typing "swl" finds Swale, "swa" finds
        // Swansea/Swanley/etc., "umyl" finds Marylebone Underground,
        // and "cbic" finds the Bicester cluster — but a single letter
        // doesn't drag in every code starting with it via `includes`).
        // Phase 3c stamps `id` on every feature including non-NR and
        // synthetic cluster anchors, so this catches more than the
        // pre-Phase-3c ref:crs-only check did.
        const name = (f.properties.name as string).toLowerCase()
        if (name.includes(q)) return true
        const id = (f.properties.id as string | undefined)?.toLowerCase()
        return !!id && id.startsWith(q)
      }),
    }
  }, [filteredStations, isSearching, searchQuery])

  // Stamps each feature with its derived rating, friend-journey
  // metadata, and the `isBuriedHidden` flag that drives the zoom-12+
  // visibility gate for buried unrated stations.
  //
  // `isBuriedHidden` = true when the feature is buried AND unrated AND
  // NOT the active primary/friend or any of their cluster members AND
  // NOT a placemark. The Mapbox layer config below uses this flag
  // (combined with `minzoom` on a dedicated layer) so the gating happens
  // entirely on the GPU without re-uploading GeoJSON on every zoom change.
  //
  // Placemark wins over bury: a placemarked station should surface at
  // zoom 8 regardless of bury, so we skip the stamp for placemarks and
  // they fall through to the regular icon/label layers + the placemark
  // label layer.
  const allStationsWithRatings = useMemo(() => {
    if (!displayedStations) return null
    // Build the "active origin set" once per memo run — primary origin,
    // friend origin, and every cluster member of either. Buried stations
    // INSIDE this set are never zoom-gated (they're part of the user's
    // journey context).
    const activeOrigins = new Set<string>()
    activeOrigins.add(primaryOrigin)
    for (const c of PRIMARY_ORIGIN_CLUSTER[primaryOrigin] ?? []) activeOrigins.add(c)
    if (friendOrigin) {
      activeOrigins.add(friendOrigin)
      for (const c of FRIEND_ORIGIN_CLUSTER[friendOrigin] ?? []) activeOrigins.add(c)
    }
    return {
      ...displayedStations,
      features: displayedStations.features.map(f => {
        const coordKey = f.properties.coordKey as string
        // ratings is coord-keyed at rest (server-side response shape),
        // but every other origin/cluster lookup is now ID-based — pull
        // both off the feature so each indexes its respective map.
        const id = f.properties.id as string | undefined
        const r = ratings[coordKey]
        const extra: Record<string, unknown> = {}
        if (r) extra.rating = r
        // Flatten friend journey duration so Mapbox label expressions can read it
        if (friendOrigin) {
          const journeys = f.properties.journeys as Record<string, { durationMinutes?: number; changes?: number }> | undefined
          const mins = getFriendJourney(journeys, friendOrigin)?.durationMinutes
          if (mins != null) extra.friendMinutes = mins
          // Stamp `isFriendOrigin` on the feature that IS the friend —
          // used below by the rating-icons layer to render it as a
          // primary-colour square (same shape as primary origins) so
          // it stands out from its surrounding rating icons.
          if (id === friendOrigin) extra.isFriendOrigin = 1
        }
        // Buried + unrated + not in active-origin set → only renders
        // at zoom 12+. Stamp the flag so Mapbox's per-layer minzoom
        // can do the zoom gating without re-running this memo.
        // Placemark overrides bury — skip the stamp so the station
        // surfaces normally and the placemark label layer (zoom 8+)
        // takes effect.
        if (
          f.properties.isBuried &&
          !r &&
          !(id && activeOrigins.has(id)) &&
          !(id && placemarkStations.has(id))
        ) {
          extra.isBuriedHidden = 1
        }
        if (Object.keys(extra).length === 0) return f
        return { ...f, properties: { ...f.properties, ...extra } }
      }),
    }
  }, [displayedStations, ratings, friendOrigin, primaryOrigin, placemarkStations])

  // Categories just toggled on — their icons get isNew=1 and grow in.
  const newlyAddedRatings = useMemo(() => {
    const added = new Set<string>()
    for (const r of visibleRatings) {
      if (!prevVisibleRatings.has(r)) added.add(r)
    }
    return added
  }, [visibleRatings, prevVisibleRatings])

  // Categories just toggled off — computed as a memo (not in the effect)
  // so it's available synchronously for stationsForMap on the same render.
  const newlyRemovedRatings = useMemo(() => {
    const removed = new Set<string>()
    for (const r of prevVisibleRatings) {
      if (!visibleRatings.has(r)) removed.add(r)
    }
    return removed
  }, [visibleRatings, prevVisibleRatings])

  // Filters by visibleRatings + keeps leaving features during their shrink animation.
  // London-terminus reference markers — only shown when the Central London
  // synthetic primary is active. Renders a small diamond at each of the 18
  // cluster members (KX/StP/Euston multi-coord variants included, they
  // visually overlap in practice). Labels are deduped by station name so
  // KX NR + KX Underground don't get two "Kings Cross" texts stacked on
  // top of each other. Labels appear at zoom 11+. Non-interactive — the
  // Source and Layers aren't wired into interactiveLayerIds so clicks
  // pass through to whatever's underneath.
  const londonTerminusFeatures = useMemo(() => {
    if (!baseStations) return null
    // Diamonds render for whichever primary OR friend is currently active
    // AND synthetic — single set of features, gated by whichever is live.
    // The Source/Layer below stays mounted only when the active primary is
    // synthetic; the friend variant has its own separate Source.
    const primaryDef = getOriginDisplay(primaryOrigin)
    if (!primaryDef?.isCluster) return null
    const clusterMemberIds = PRIMARY_ORIGIN_CLUSTER[primaryOrigin] ?? []
    type PointFeature = {
      type: "Feature"
      geometry: { type: "Point"; coordinates: [number, number] }
      properties: Record<string, unknown>
    }
    const iconFeatures: PointFeature[] = []
    // Cluster members are station IDs post Phase 3c. Find each
    // member's feature directly by id, then read its geometry for
    // the diamond's lng/lat. coordKey is preserved on the diamond
    // feature for legacy click-resolution.
    for (const memberId of clusterMemberIds) {
      const bf = baseStations.features.find(
        (f) => (f.properties as { id?: string }).id === memberId,
      )
      if (!bf) continue
      const [lng, lat] = bf.geometry.coordinates as [number, number]
      if (!Number.isFinite(lng) || !Number.isFinite(lat)) continue
      const coord = `${lng},${lat}`
      // Skip tube-only members — the cluster includes Underground entrances
      // for Kings Cross and Euston as satellite IDs so cluster-member
      // taps resolve to the parent primary, but visually we only want the
      // National Rail stations shown as waypoint diamonds.
      const network = (bf.properties?.network as string | undefined) ?? ""
      const isNR = /National Rail|Elizabeth line/.test(network)
      if (!isNR) continue
      // Proximity dedupe: if a previously-added diamond is within ~70m
      // (squared-deg < 1e-6 at London's latitude) of this one, skip.
      // Collapses the double StP entry (main concourse vs HS1/SPL
      // concourse, ~80m apart) and any future near-duplicates into a
      // single icon + label. Waterloo / Waterloo East are 400m apart
      // so both survive; KX NR / KX Underground would ordinarily
      // survive too if the tube filter above hadn't already dropped
      // Underground.
      const nearPrevious = iconFeatures.some((f) => {
        const [l, a] = f.geometry.coordinates as [number, number]
        return (l - lng) ** 2 + (a - lat) ** 2 < 1e-6
      })
      if (nearPrevious) continue
      const rawName = bf?.properties?.name as string | undefined
      let cleanName = cleanTerminusLabel(rawName)
      // Disambiguate when a satellite's name collides with the
      // synthetic anchor's displayName (e.g. SRA cleans to "Stratford",
      // which is also the Stratford-cluster anchor's label). Append
      // " Station" so the satellite reads "Stratford Station" while
      // the anchor stays "Stratford".
      if (cleanName === primaryDef.displayName) {
        cleanName = `${cleanName} Station`
      }
      iconFeatures.push({
        type: "Feature",
        geometry: { type: "Point", coordinates: [lng, lat] },
        // Stamp id + coord + coordKey + name so the click handler can
        // resolve a diamond tap back to its station feature. id is the
        // canonical key for cluster lookups (MEMBER_TO_SYNTHETIC, the
        // ALL_CLUSTER_MEMBER_IDS membership test); coordKey is kept for
        // legacy callers reading f.properties.coordKey.
        //
        // isTerminus tells resolveStationIconImage to use the diamond
        // icon for the hover pulse animation — without this, the
        // pulse defaults to the unrated circle because the feature
        // has no rating/isLondon properties.
        properties: {
          id: memberId,
          coord: coord,
          coordKey: coord,
          name: cleanName,
          isTerminus: true,
        },
      })
    }
    return {
      icons: { type: "FeatureCollection" as const, features: iconFeatures },
    }
  }, [baseStations, primaryOrigin])

  // Friend cluster diamonds — same shape as the primary version above, but
  // sourced from the active synthetic friend (if any). Returns null when the
  // current friend isn't synthetic, so the friend Source/Layer below stays
  // unmounted in the common single-station case.
  const friendClusterFeatures = useMemo(() => {
    if (!baseStations || !friendOrigin) return null
    const friendDef = getOriginDisplay(friendOrigin)
    if (!friendDef?.isCluster) return null
    const memberIds = FRIEND_ORIGIN_CLUSTER[friendOrigin] ?? []
    type PointFeature = {
      type: "Feature"
      geometry: { type: "Point"; coordinates: [number, number] }
      properties: Record<string, unknown>
    }
    const iconFeatures: PointFeature[] = []
    for (const memberId of memberIds) {
      const bf = baseStations.features.find(
        (f) => (f.properties as { id?: string }).id === memberId,
      )
      if (!bf) continue
      const [lng, lat] = bf.geometry.coordinates as [number, number]
      if (!Number.isFinite(lng) || !Number.isFinite(lat)) continue
      const coord = `${lng},${lat}`
      const network = (bf.properties?.network as string | undefined) ?? ""
      const isNR = /National Rail|Elizabeth line/.test(network)
      if (!isNR) continue
      const nearPrevious = iconFeatures.some((f) => {
        const [l, a] = f.geometry.coordinates as [number, number]
        return (l - lng) ** 2 + (a - lat) ** 2 < 1e-6
      })
      if (nearPrevious) continue
      const rawName = bf.properties?.name as string | undefined
      let cleanName = cleanTerminusLabel(rawName)
      // Disambiguate satellite labels that collide with the friend
      // anchor's displayName (e.g. BHM cleans to "Birmingham New
      // Street" — fine — but if any cleaned name matches the cluster
      // label we'd append " Station" the same way the primary side
      // does for SRA).
      if (cleanName === friendDef.displayName) {
        cleanName = `${cleanName} Station`
      }
      iconFeatures.push({
        type: "Feature",
        geometry: { type: "Point", coordinates: [lng, lat] },
        properties: {
          id: memberId,
          coord: coord,
          coordKey: coord,
          name: cleanName,
          isTerminus: true,
        },
      })
    }
    return {
      icons: { type: "FeatureCollection" as const, features: iconFeatures },
    }
  }, [baseStations, friendOrigin])

  // Universal cluster-diamond features — every member of every synthetic
  // cluster (primary OR friend), regardless of which is active. Drives
  // the always-on diamond layer below; cluster members render as diamonds
  // at zoom 9+ with labels at zoom 12+, overriding the regular rating /
  // unrated / buried treatment they'd otherwise get from the station-*
  // layers. The matching `isClusterMember` flag stamped on baseStations
  // (in the `stations` memo above) excludes them from those layers.
  //
  // Same name resolution + proximity-dedupe rules as the per-cluster
  // versions above — keeps Stratford Station / St Pancras dual-platform
  // collisions tidy.
  const allClusterDiamondFeatures = useMemo(() => {
    if (!baseStations) return null
    type PointFeature = {
      type: "Feature"
      geometry: { type: "Point"; coordinates: [number, number] }
      properties: Record<string, unknown>
    }
    const iconFeatures: PointFeature[] = []
    // Combined synthetic cluster source — every member of every cluster
    // (primary, friend, or destination-only). Anchor coord and
    // displayName tag along so satellite labels can disambiguate against
    // their cluster's own display label (e.g. SRA cleans to "Stratford"
    // which collides with the Stratford anchor's label). Iterates the
    // full registry so destination-only clusters (e.g. Windsor) also
    // contribute their member diamonds.
    const clusters: { anchor: string; displayName: string; members: string[] }[] = []
    for (const [anchor, def] of Object.entries(ALL_CLUSTERS)) {
      clusters.push({ anchor, displayName: def.displayName, members: def.members })
    }
    for (const { anchor, displayName, members } of clusters) {
      for (const memberId of members) {
        const bf = baseStations.features.find(
          (f) => (f.properties as { id?: string }).id === memberId,
        )
        if (!bf) continue
        const [lng, lat] = bf.geometry.coordinates as [number, number]
        if (!Number.isFinite(lng) || !Number.isFinite(lat)) continue
        const coord = `${lng},${lat}`
        // Skip tube-only entries (matches the existing London-cluster
        // rule — Underground entrances for Kings Cross / Euston aren't
        // wanted as visible diamonds, just as cluster-routing aliases).
        const network = (bf.properties?.network as string | undefined) ?? ""
        const isNR = /National Rail|Elizabeth line/.test(network)
        if (!isNR) continue
        // Proximity dedupe within the SAME cluster — collapses St Pancras
        // main / HS1 concourses (~80m apart) into a single diamond.
        const nearPrevious = iconFeatures.some((f) => {
          const [l, a] = f.geometry.coordinates as [number, number]
          return (l - lng) ** 2 + (a - lat) ** 2 < 1e-6
        })
        if (nearPrevious) continue
        const rawName = bf.properties?.name as string | undefined
        let cleanName = cleanTerminusLabel(rawName)
        if (cleanName === displayName) cleanName = `${cleanName} Station`
        iconFeatures.push({
          type: "Feature",
          geometry: { type: "Point", coordinates: [lng, lat] },
          properties: {
            id: memberId,
            coord: coord,
            coordKey: coord,
            name: cleanName,
            isTerminus: true,
            // Parent synthetic's anchor ID — drives the visibility
            // filter downstream (a diamond only renders when its
            // parent synthetic survives the filter pipeline).
            synthAnchor: anchor,
          },
        })
      }
    }
    return {
      icons: { type: "FeatureCollection" as const, features: iconFeatures },
    }
  }, [baseStations])

  // Stamps boolean flags (isNew / isLeaving) — NOT the scale values themselves.
  // Scale values live in the Layer expressions so stationsForMap doesn't recompute
  // on every animation frame, and avoids stale-value flashes on the first render.
  const stationsForMap = useMemo(() => {
    if (!allStationsWithRatings) return null
    return {
      ...allStationsWithRatings,
      features: allStationsWithRatings.features
        .filter(f => {
          // The active friend origin always shows regardless of rating filters (coord-keyed)
          if (friendOrigin && (f.properties.id as string | undefined) === friendOrigin) return true
          // Empty rating checkboxes = empty map. Falls straight through to
          // the per-category gates below, both of which return false when
          // visibleRatings + newlyRemovedRatings are both empty. Animations
          // still work because newlyRemovedRatings keeps a category visible
          // for the shrink-out frames after the user unchecks it.
          //
          // `category` is the stringified numeric rating ("4","3","2","1")
          // or the special "unrated" pseudo-category. Buried stations are
          // categorised by their underlying rating — being buried just
          // gates *visibility at low zoom*, it's not a separate filter.
          const ratingNum = f.properties.rating as number | undefined
          const category = ratingNum != null ? String(ratingNum) : 'unrated'
          return visibleRatings.has(category) || newlyRemovedRatings.has(category)
        })
        .map(f => {
          const ratingNum = f.properties.rating as number | undefined
          const category = ratingNum != null ? String(ratingNum) : 'unrated'
          // Admin-only "hasIssue" flag — true when the station has been
          // explicitly flagged via the issue button. Station-global, so
          // the halo follows the station across primary switches. Computed
          // here (not in the filter layer) so the layer's `has` filter
          // can read a cheap boolean property.
          const coord = f.properties.coordKey as string
          const isDest = coord !== primaryOrigin
          // issueStations + placemarkStations are keyed by station ID
          // post Phase 2b/2d. Every feature carries `id` (Phase 3c) —
          // includes synthetic cluster anchors like CBIR, so flagging
          // a cluster as an issue/placemark stamps the diamond too.
          const stationId = f.properties.id as string | undefined
          const hasIssue = isDest && !!stationId && issueStations.has(stationId)
          // Admin-only "placemark" flag — same shape as hasIssue, stamped
          // here so label-layer filters can read a cheap `isPlacemark` boolean
          // and gate visibility at zoom 8+ for stations whose rating would
          // otherwise hide them until zoom 9+ (rating 2) or 10+ (unrated).
          const isPlacemark = !!stationId && placemarkStations.has(stationId)
          let base: typeof f.properties = f.properties
          if (hasIssue) base = { ...base, hasIssue: 1 }
          if (isPlacemark) base = { ...base, isPlacemark: 1 }
          if (newlyAddedRatings.has(category)) {
            return { ...f, properties: { ...base, isNew: 1 } }
          }
          if (newlyRemovedRatings.has(category)) {
            return { ...f, properties: { ...base, isLeaving: 1 } }
          }
          return { ...f, properties: base }
        }),
    }
  }, [allStationsWithRatings, visibleRatings, newlyAddedRatings, newlyRemovedRatings, friendOrigin, issueStations, placemarkStations, primaryOrigin])

  // Set of synthetic-anchor coordKeys that survived the filter pipeline
  // — i.e. the synthetic features that ARE rendered as rating icons in
  // stationsForMap, plus the active primary/friend synthetics (which
  // don't enter stationsForMap because their hexagon/square renders them
  // separately, but their cluster diamonds should still show).
  // Drives the visibleClusterDiamondFeatures filter below — a diamond
  // only renders when its parent synthetic is on the map. If the user
  // filters their synthetic out (e.g. unchecks rating-3 and the
  // synthetic was rated 3), the diamonds vanish in lockstep.
  const visibleSynthAnchors = useMemo(() => {
    const out = new Set<string>()
    // Active primary/friend synthetics always count as visible — their
    // hexagon/square IS on the map regardless of filter checkboxes.
    // Both origins are station IDs post Phase 3c.
    if (PRIMARY_ORIGIN_CLUSTER[primaryOrigin]) out.add(primaryOrigin)
    if (friendOrigin && FRIEND_ORIGIN_CLUSTER[friendOrigin]) out.add(friendOrigin)
    // Non-active synthetics that survived the filter chain. Read from
    // the virtual feature's `id` (post Phase 3c, every synthetic
    // virtual feature carries its anchor ID) — the diamond features
    // downstream filter via `synthAnchor`, also an ID, so the Set
    // and the filter agree.
    if (stationsForMap) {
      for (const f of stationsForMap.features) {
        if ((f.properties as { isSynthetic?: boolean }).isSynthetic) {
          const id = (f.properties as { id?: string }).id
          if (id) out.add(id)
        }
      }
    }
    return out
  }, [stationsForMap, primaryOrigin, friendOrigin])

  // Pre-filter the always-on cluster diamonds by visibleSynthAnchors.
  // The all-cluster-diamonds layer reads from this filtered version —
  // diamonds whose parent synthetic is filtered out simply aren't in
  // the source data and don't render.
  const visibleClusterDiamondFeatures = useMemo(() => {
    if (!allClusterDiamondFeatures) return null
    return {
      icons: {
        type: "FeatureCollection" as const,
        features: allClusterDiamondFeatures.icons.features
          .filter((f) => visibleSynthAnchors.has(f.properties.synthAnchor as string)),
      },
    }
  }, [allClusterDiamondFeatures, visibleSynthAnchors])

  // Filter-change pill: flash "{N} stations" at viewport-centre when
  // the user toggles a filter input. Trigger is signature-based —
  // only fires when one of the listed filter inputs has actually
  // changed. Origin swaps (primary, friend) leave the signature
  // alone, so they don't fire the pill even though stationsForMap
  // rebuilt. Each fire resets a 3s fade-out timer so back-to-back
  // filter tweaks coalesce.
  useEffect(() => {
    if (!stationsForMap) return
    // Build a signature of every input that narrows the visible set —
    // when this changes between renders we know the recompute came
    // from a user filter action, not a primary/friend swap. Origin
    // changes don't appear here, so picking a new home leaves the
    // signature unchanged and the pill stays quiet.
    const signature = JSON.stringify({
      ratings: [...visibleRatings].sort(),
      maxMinutes,
      minMinutes,
      friendMaxMinutes,
      primaryDirectOnly,
      friendDirectOnly,
      primaryInterchangeFilter,
      primaryFeatureFilter,
      monthFilter,
      currentMonthHighlight,
      searchQuery,
    })
    // First time we see a signature — record it and skip. The pill
    // shouldn't fire on initial page load.
    if (filterNotifSignatureRef.current === null) {
      filterNotifSignatureRef.current = signature
      return
    }
    // Signature unchanged → recompute came from a non-filter source
    // (origin change, routing data load, …). Stay quiet.
    if (filterNotifSignatureRef.current === signature) return
    filterNotifSignatureRef.current = signature
    // Compute the visible-station count for the toast. Two adjustments
    // versus a naive features.length:
    //   1. Exclude the user's own anchor points (primary + cluster
    //      members + friend) — those are the user's home dots, not
    //      destinations to consider.
    //   2. Exclude features that are only in stationsForMap because
    //      they're animating out (rating just unchecked → tracked
    //      via newlyRemovedRatings). Counting them would lag the toast
    //      one tick behind the visible map: e.g. unchecking Sublime
    //      with 11 sublime stations would say "11 stations" while the
    //      map already shows 0. The count below reads visibleRatings
    //      directly, so leaving features don't slip through.
    const exclude = new Set<string>()
    exclude.add(primaryOrigin)
    for (const c of PRIMARY_ORIGIN_CLUSTER[primaryOrigin] ?? []) exclude.add(c)
    if (friendOrigin) exclude.add(friendOrigin)
    let count = 0
    for (const f of stationsForMap.features) {
      const coordKey = f.properties.coordKey as string
      if (exclude.has(coordKey)) continue
      // Friend overrides everything — counted in `exclude` above, so
      // this branch never sees the active friend origin coord.
      const ratingNum = f.properties.rating as number | undefined
      const category = ratingNum != null ? String(ratingNum) : "unrated"
      if (!visibleRatings.has(category)) continue
      count += 1
    }
    setFilterNotif({ count, visible: true })
    if (filterNotifTimerRef.current != null) {
      clearTimeout(filterNotifTimerRef.current)
    }
    filterNotifTimerRef.current = window.setTimeout(() => {
      setFilterNotif((prev) => (prev ? { ...prev, visible: false } : null))
      filterNotifTimerRef.current = null
    }, 1300)
  }, [stationsForMap, primaryOrigin, friendOrigin, visibleRatings, maxMinutes, minMinutes, friendMaxMinutes, primaryDirectOnly, friendDirectOnly, primaryInterchangeFilter, primaryFeatureFilter, monthFilter, currentMonthHighlight, searchQuery])

  // Single effect handles both enter and leave animations when filters change.
  // newlyRemovedRatings (a memo) keeps leaving features visible synchronously —
  // no state delay, so icons don't flash before the shrink starts.
  useEffect(() => {
    if (!mapReady || !stationsForMap) return

    const hasEntering = newlyAddedRatings.size > 0
    const hasLeaving = newlyRemovedRatings.size > 0

    // No animation needed — just sync the ref
    if (!hasEntering && !hasLeaving) {
      setPrevVisibleRatings(new Set(visibleRatings))
      setIconScale(1)
      return
    }

    // Reset scales to their starting positions
    if (hasLeaving) setLeaveScale(1)
    if (hasEntering) setIconScale(0.01)

    const duration = 400 // ms
    const startTime = performance.now()
    let frameId: number

    function step(now: number) {
      const elapsed = now - startTime
      const t = Math.min(elapsed / duration, 1)

      if (hasEntering) {
        // Ease-out cubic: fast start, gentle landing
        const eased = 1 - Math.pow(1 - t, 3)
        setIconScale(0.01 + 0.99 * eased)
      }
      if (hasLeaving) {
        // Ease-in cubic: gentle start, fast end
        setLeaveScale(Math.max(0.01, Math.pow(1 - t, 3)))
      }

      if (t < 1) {
        frameId = requestAnimationFrame(step)
      } else {
        // Animation done — update the ref so newlyRemoved/newlyAdded become empty,
        // which removes isLeaving features from stationsForMap on the next render.
        setPrevVisibleRatings(new Set(visibleRatings))
        if (hasLeaving) setLeaveScale(1)
      }
    }

    frameId = requestAnimationFrame(step)
    return () => cancelAnimationFrame(frameId)
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mapReady, visibleRatings])

  // Dev action: toggle a station's "buried" flag. Buried unrated
  // stations only render at zoom 12+ (unless they're the active
  // primary/friend or a cluster member of either) — useful for hiding
  // inner-suburb noise that crowds the map at city scale.
  //
  // Direct synchronous toggle: updates local state immediately so the
  // map icon flips on the same render. The cascade through the useMemo
  // chain (stations → filtered → displayed → allStationsWithRatings →
  // stationsForMap → Mapbox re-upload) means a brief freeze, but the
  // instant feedback is preferred over fire-and-forget.
  const handleToggleBuried = useCallback((name: string, coordKey: string) => {
    setBuriedStations((prev) => {
      const next = new Set(prev)
      if (next.has(coordKey)) next.delete(coordKey); else next.add(coordKey)
      return next
    })
    fetch("/api/dev/toggle-buried", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name, coordKey }),
    }).catch((err) => console.error("toggle-buried POST failed:", err))
  }, [])

  // Admin-only: toggle "approved for this home" for a (home, dest) pair.
  // Keyed by the composite "homeCoord|destCoord" string so the backing
  // file's JSON keys are unambiguous and lookups are O(1).
  const handleToggleIssue = useCallback(async (
    stationId: string,
    name: string,
    hasIssue: boolean,
  ) => {
    setIssueStations((prev) => {
      const next = new Set(prev)
      if (hasIssue) next.add(stationId); else next.delete(stationId)
      return next
    })
    outbox.enqueue({
      endpoint: "/api/dev/has-issue-station",
      method: "POST",
      body: { stationId, name, hasIssue },
      key: `has-issue:${stationId}`,
      label: `${hasIssue ? "Flag" : "Clear"} issue on ${name}`,
    })
  }, [])

  // Admin-only: toggle "placemark" on a station (forces name-label at zoom 8+).
  // Same shape as handleToggleIssue — local Set update + outbox-queued POST so
  // the map updates instantly and the GitHub commit happens in the background.
  const handleTogglePlacemark = useCallback(async (
    stationId: string,
    name: string,
    isPlacemark: boolean,
  ) => {
    setPlacemarkStations((prev) => {
      const next = new Set(prev)
      if (isPlacemark) next.add(stationId); else next.delete(stationId)
      return next
    })
    outbox.enqueue({
      endpoint: "/api/dev/toggle-placemark",
      method: "POST",
      body: { stationId, name, isPlacemark },
      key: `placemark:${stationId}`,
      label: `${isPlacemark ? "Mark" : "Unmark"} placemark on ${name}`,
    })
  }, [])

  // Dev action: approve a photo for a station — persists to data/photo-curations.json.
  // Approvals are now uncapped (admins can keep a "bench" beyond the visible
  // 12); the non-admin gallery still only shows the first 12.
  const handleApprovePhoto = useCallback(async (coordKey: string, name: string, photo: FlickrPhoto) => {
    setCurations((prev) => {
      const entry = prev[coordKey] ?? { name, approved: [] }
      if (entry.approved.some((p) => p.id === photo.id)) return prev
      return {
        ...prev,
        [coordKey]: { ...entry, name, approved: [...entry.approved, photo] },
      }
    })
    outbox.enqueue({
      endpoint: "/api/dev/curate-photo",
      method: "POST",
      body: { coordKey, name, photoId: photo.id, action: "approve", photo },
      key: `photo:${coordKey}:${photo.id}`,
      label: `Approve photo for ${name}`,
    })
  }, [])

  // Dev action: move an approved photo within the approved list. All moves
  // respect the pin/non-pin section boundary — pinned photos stay in the
  // pinned prefix, non-pinned stay below it.
  //   "up" / "down" — skip-swap with the nearest photo in that direction
  //                   that isn't a non-moving pin. Pinned photos we skip over
  //                   keep their absolute index.
  //   "top"         — repeat "up" skip-swaps until no further move is possible
  //                   (bubble to the topmost reachable slot, stopping below
  //                   any pinned photos stacked above).
  //   "bottom"      — mirror of "top".
  const handleMovePhoto = useCallback(async (coordKey: string, name: string, photoId: string, direction: "up" | "down" | "top" | "bottom") => {
    setCurations((prev) => {
      const entry = prev[coordKey]
      if (!entry) return prev
      const approved = [...entry.approved]
      const idx = approved.findIndex((p) => p.id === photoId)
      if (idx < 0) return prev
      const pinnedSet = new Set(entry.pinnedIds ?? [])
      const isMovingPinned = pinnedSet.has(photoId)
      // skipSwap does one step in `dir`. Pin semantics are asymmetric:
      //   - If the moving photo is PINNED, it can swap with any adjacent
      //     photo (pins don't block pins).
      //   - If the moving photo is NOT pinned, it skips over any pinned
      //     occupants and swaps with the first non-pinned slot in that
      //     direction — pins hold their absolute positions for non-pins.
      // Returns the new index (or `from` if no move).
      const skipSwap = (from: number, dir: "up" | "down"): number => {
        const step = dir === "up" ? -1 : 1
        const stop = dir === "up" ? -1 : approved.length
        let t = from + step
        while (t !== stop) {
          const occ = approved[t].id
          if (isMovingPinned || !pinnedSet.has(occ) || occ === photoId) {
            ;[approved[from], approved[t]] = [approved[t], approved[from]]
            return t
          }
          t += step
        }
        return from
      }
      if (direction === "up" || direction === "down") {
        skipSwap(idx, direction)
      } else {
        const step: "up" | "down" = direction === "top" ? "up" : "down"
        let cur = idx
        for (let n = 0; n < approved.length; n++) {
          const next = skipSwap(cur, step)
          if (next === cur) break
          cur = next
        }
      }
      return { ...prev, [coordKey]: { ...entry, approved } }
    })
    outbox.enqueue({
      endpoint: "/api/dev/curate-photo",
      method: "POST",
      body: { coordKey, name, photoId, action: "move", direction },
      key: `photo:${coordKey}:${photoId}`,
      label: `Move photo ${direction} for ${name}`,
    })
  }, [])

  // Dev action: un-approve a photo — removes from the approved list and from
  // the pinned set (if it was pinned).
  const handleUnapprovePhoto = useCallback(async (coordKey: string, name: string, photoId: string) => {
    setCurations((prev) => {
      const entry = prev[coordKey]
      if (!entry) return prev
      const updated: CurationEntry = {
        ...entry,
        approved: entry.approved.filter((p) => p.id !== photoId),
        pinnedIds: (entry.pinnedIds ?? []).filter((id) => id !== photoId),
      }
      if (updated.pinnedIds?.length === 0) delete updated.pinnedIds
      if (updated.approved.length === 0) {
        const next = { ...prev }
        delete next[coordKey]
        return next
      }
      return { ...prev, [coordKey]: updated }
    })
    outbox.enqueue({
      endpoint: "/api/dev/curate-photo",
      method: "POST",
      body: { coordKey, name, photoId, action: "unapprove" },
      key: `photo:${coordKey}:${photoId}`,
      label: `Unapprove photo for ${name}`,
    })
  }, [])

  // Dev action: approve a photo and insert it as high in the list as
  // possible, skipping past any pins at the top. So index 0 if nothing
  // pinned is there; otherwise the first non-pinned index.
  const handleApproveAtTop = useCallback(async (coordKey: string, name: string, photo: FlickrPhoto) => {
    setCurations((prev) => {
      const entry = prev[coordKey] ?? { name, approved: [] }
      const photoId = photo.id
      const approvedWithoutPhoto = entry.approved.filter((p) => p.id !== photoId)
      const pinnedSet = new Set(entry.pinnedIds ?? [])
      let insertAt = 0
      while (insertAt < approvedWithoutPhoto.length && pinnedSet.has(approvedWithoutPhoto[insertAt].id)) insertAt++
      const nextApproved = [...approvedWithoutPhoto]
      nextApproved.splice(insertAt, 0, photo)
      return { ...prev, [coordKey]: { ...entry, name, approved: nextApproved } }
    })
    outbox.enqueue({
      endpoint: "/api/dev/curate-photo",
      method: "POST",
      body: { coordKey, name, photoId: photo.id, action: "approveAtTop", photo },
      key: `photo:${coordKey}:${photo.id}`,
      label: `Approve photo (top) for ${name}`,
    })
  }, [])

  // Dev action: pin a photo. The photo STAYS at its current index — pinning
  // just adds the pin badge and marks the slot as "fixed" so other photos
  // skip over it when they move. If the photo isn't in approved[] yet
  // (pinning from a non-Approved tab), it's appended first — but that case
  // doesn't occur through the UI anymore, since the pin button is gated to
  // the Approved tab.
  const handlePinPhoto = useCallback(async (coordKey: string, name: string, photo: FlickrPhoto) => {
    setCurations((prev) => {
      const entry = prev[coordKey] ?? { name, approved: [], pinnedIds: [] }
      const photoId = photo.id
      const alreadyApproved = entry.approved.some((p) => p.id === photoId)
      const nextApproved = alreadyApproved ? entry.approved : [...entry.approved, photo]
      const prevPins = (entry.pinnedIds ?? []).filter((id) => id !== photoId)
      return {
        ...prev,
        [coordKey]: {
          ...entry,
          name,
          approved: nextApproved,
          pinnedIds: [...prevPins, photoId],
        },
      }
    })
    outbox.enqueue({
      endpoint: "/api/dev/curate-photo",
      method: "POST",
      body: { coordKey, name, photoId: photo.id, action: "pin", photo },
      key: `photo:${coordKey}:${photo.id}`,
      label: `Pin photo for ${name}`,
    })
  }, [])

  // Dev action: unpin a photo. Photo stays in place (which becomes the top
  // of the non-pinned section — a natural transition).
  const handleUnpinPhoto = useCallback(async (coordKey: string, name: string, photoId: string) => {
    setCurations((prev) => {
      const entry = prev[coordKey]
      if (!entry) return prev
      const nextPins = (entry.pinnedIds ?? []).filter((id) => id !== photoId)
      const updated: CurationEntry = { ...entry, pinnedIds: nextPins }
      if (updated.pinnedIds?.length === 0) delete updated.pinnedIds
      return { ...prev, [coordKey]: updated }
    })
    outbox.enqueue({
      endpoint: "/api/dev/curate-photo",
      method: "POST",
      body: { coordKey, name, photoId, action: "unpin" },
      key: `photo:${coordKey}:${photoId}`,
      label: `Unpin photo for ${name}`,
    })
  }, [])

  // Save public/private notes for a station — called when the overlay
  // closes. Walk prose (adminWalksAll / publicWalksS2S /
  // publicWalksS2SEnding / publicWalksCircular) is build-only and
  // preserved on the existing entry by the API route, so we don't
  // pass it in.
  const handleSaveNotes = useCallback(async (coordKey: string, name: string, publicNote: string, privateNote: string) => {
    // Optimistic update — preserve the build-output walk fields from
    // any existing entry so the optimistic state matches what the
    // server will produce.
    setStationNotes((prev) => {
      const existing = prev[coordKey]
      const hasAnyWalkProse = !!(
        existing?.adminWalksAll
        || existing?.publicWalksS2S
        || existing?.publicWalksS2SEnding
        || existing?.publicWalksCircular
      )
      if (!publicNote && !privateNote && !hasAnyWalkProse) {
        const next = { ...prev }
        delete next[coordKey]
        return next
      }
      return {
        ...prev,
        [coordKey]: {
          name,
          publicNote,
          privateNote,
          adminWalksAll: existing?.adminWalksAll,
          publicWalksS2S: existing?.publicWalksS2S,
          publicWalksS2SEnding: existing?.publicWalksS2SEnding,
          publicWalksCircular: existing?.publicWalksCircular,
        },
      }
    })
    outbox.enqueue({
      endpoint: "/api/dev/station-notes",
      method: "POST",
      body: { coordKey, name, publicNote, privateNote },
      key: `notes:${coordKey}`,
      label: `Update notes for ${name}`,
    })
  }, [])

  // Refresh stationNotes + stationMonths after a structured walk edit.
  // The PATCH /api/dev/walk/[id] route re-runs the build server-side,
  // so we just need to pull the regenerated data back into the client
  // state — the overlay's ramblerNote prop will then update with the
  // new prose. Fire-and-forget, no optimistic update (the build
  // derives both files so there's no straightforward single-key patch).
  const refreshStationDerivedData = useCallback(async () => {
    const [notes, months] = await Promise.all([
      fetch("/api/dev/station-notes").then((r) => r.json()),
      fetch("/api/dev/station-months").then((r) => r.json()),
    ])
    setStationNotes(notes)
    setStationMonths(months)
  }, [])

  // Save / clear per-station custom Flickr tag config. Pass custom=null to
  // clear. Admins can no longer pick an algo per-station — that's decided by
  // cluster/excluded membership (see defaultAlgoFor below).
  const handleSaveCustom = useCallback(
    async (coordKey: string, name: string, custom: CustomSettings | null) => {
      setFlickrSettings((prev) => {
        const next = { ...prev }
        if (!custom) delete next[coordKey]
        else next[coordKey] = { name, custom }
        return next
      })
      outbox.enqueue({
        endpoint: "/api/dev/flickr-settings",
        method: "POST",
        body: { coordKey, name, custom },
        key: `flickr-settings:${coordKey}`,
        label: custom ? `Save Flickr settings for ${name}` : `Clear Flickr settings for ${name}`,
      })
    },
    [],
  )

  // Save a global Flickr preset. Affects every station that uses this algo as
  // its default or fallback.
  const handleSavePreset = useCallback(
    async (name: "landscapes" | "hikes" | "station", preset: CustomSettings) => {
      setPresets((prev) => (prev ? { ...prev, [name]: preset } : prev))
      outbox.enqueue({
        endpoint: "/api/dev/flickr-presets",
        method: "POST",
        body: { name, preset },
        key: `flickr-preset:${name}`,
        label: `Save Flickr preset: ${name}`,
      })
    },
    [],
  )

  // Reset a global Flickr preset to its hardcoded default. Unlike the
  // other admin actions we KEEP this as a direct fetch — the response
  // body carries the server's notion of the defaults, which we then
  // splash into local state. Reset is a rare, deliberate admin action
  // (not something you'd queue from a train) so the offline-tolerance
  // we get from the outbox doesn't really matter here.
  const handleResetPreset = useCallback(
    async (name: "landscapes" | "hikes" | "station") => {
      const res = await fetch("/api/dev/flickr-presets", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name, reset: true }),
      })
      const json = await res.json() as { preset?: CustomSettings }
      if (json.preset) {
        setPresets((prev) => (prev ? { ...prev, [name]: json.preset! } : prev))
      }
    },
    [],
  )

  // useEffect runs once after the component first renders (the empty [] means "run once only").
  // Gate BOTH the stations fetch AND the downstream heavy routing memo
  // behind a double-requestAnimationFrame: this guarantees the browser
  // has had one full composite cycle to paint the welcome-banner
  // spinner AND kick its CSS animation onto the compositor layer
  // BEFORE the routing pass fires and temporarily freezes the main
  // thread. Without this, the spinner often doesn't visibly animate
  // at all on first load — the heavy pass preempts the first paint.
  useEffect(() => {
    let raf1 = 0
    let raf2 = 0
    // Fire the precomputed-routing fetch in parallel with the (also
    // deferred) stations.json fetch. If the snapshot file exists,
    // the heavy routedStations useMemo will short-circuit to its
    // result instead of recomputing. If the snapshot is missing or
    // 404s we just fall through to the live compute path — same
    // behaviour as today. No need to block the stations fetch on
    // this; the two resolve independently and the memo picks
    // whichever arrives first.
    // No longer eager-fetches only central-london. A separate
    // useEffect below watches `primaryOrigin` and lazy-fetches the
    // current primary's routing file on first use. This way users
    // who immediately switch primary don't download the default
    // file just to discard it.

    raf1 = requestAnimationFrame(() => {
      raf2 = requestAnimationFrame(() => {
    fetch("/stations.json")
      .then((res) => res.json())
      .then((data: StationCollection) => {
        // Stamp each feature with a "lng,lat" string in properties. We compute it here
        // from the original parsed coordinates so the string is exact and consistent.
        // Storing it in properties (not just geometry) means it survives Mapbox's
        // internal tile processing — Mapbox may slightly alter float values when
        // returning geometry from click events, but string properties always pass through intact.
        const stamped = data.features.map((f) => {
          const [lng, lat] = f.geometry.coordinates
          const coordKey = `${lng},${lat}`
          // Stamp both coordKey AND the canonical station ID. coordKey
          // stays as the geometry-derived "lng,lat" string (used by a
          // handful of legacy lookups + Mapbox click round-trips); id
          // is the registry's canonical identifier — CRS for real NR
          // stations, 4-char synthetic for everything else. id is what
          // Phase 3c comparisons (=== primaryOrigin / friendOrigin) all
          // key off, so every consumer reads it from properties.id.
          const id = resolveCoordKey(coordKey)
          const extra: Record<string, unknown> = { coordKey }
          if (id) extra.id = id
          // Apply Central London terminus name overrides (see
          // TERMINUS_DISPLAY_OVERRIDES). Overriding `name` on the base
          // feature propagates the cleaner short form to every consumer
          // — Mapbox label layers via ["get","name"], searchableStations,
          // coordToName, the station modal title — without each
          // consumer needing to know about the override map.
          // Keyed by station ID post Phase 3c (the literals were
          // ID-rewritten by scripts/migrate-map-tsx-coord-literals.mjs).
          const nameOverride = id ? TERMINUS_DISPLAY_OVERRIDES[id] : undefined
          if (nameOverride) extra.name = nameOverride
          // Cast restores the index signature that TypeScript loses when spreading a mapped type
          return { ...f, properties: { ...f.properties, ...extra } as StationFeature["properties"] }
        })

        // Keep only stations of interest — we DON'T filter out excluded ones here;
        // those are kept in data and hidden later in stationsForMap (so admin mode can show them).
        const outside = stamped.filter((f) => {
          return (
            // Keep National Rail/Overground/Elizabeth line stations (have a CRS code),
            // or TfL stations (London Underground / DLR). Blocks heritage railways,
            // which OSM tags with usage=tourism and no CRS code.
            (f.properties["ref:crs"] != null ||
              f.properties["network"] === "London Underground" ||
              f.properties["network"] === "Docklands Light Railway") &&
            f.properties["usage"] !== "tourism"
          )
        })
        setBaseStations({ ...data, features: outside })
      })
      })
    })
    return () => { cancelAnimationFrame(raf1); cancelAnimationFrame(raf2) }
  }, [])

  // Remembers the last hovered position so the radius circles stay rendered
  // while their opacity transitions to 0. Without this, the geometry disappears
  // instantly on unhover and there's nothing left for the fade-out to show.
  // Updated in the mouse handlers (not during render) to satisfy React's rules.
  const [radiusPos, setRadiusPos] = useState<{ lng: number; lat: number } | null>(null)

  const emptyPolygon = useMemo(() => ({
    type: "Feature" as const,
    geometry: { type: "Polygon" as const, coordinates: [[]] as [number, number][][] },
    properties: {},
  }), [])

  const radiusCircle = useMemo(() => {
    if (!radiusPos) return emptyPolygon
    return createCircleGeoJSON(radiusPos.lng, radiusPos.lat, INNER_RADIUS_KM)
  }, [radiusPos, emptyPolygon])

  const outerRadiusCircle = useMemo(() => {
    if (!radiusPos) return emptyPolygon
    return createCircleGeoJSON(radiusPos.lng, radiusPos.lat, OUTER_RADIUS_KM)
  }, [radiusPos, emptyPolygon])

  // Label points — positioned at the bottom of each circle so the text sits on the dashed line.
  // Latitude offset = radius_km / Earth_radius_km * (180/π), same formula used in createCircleGeoJSON.
  const innerLabelPoint = useMemo(() => {
    if (!radiusPos) return null
    const latOffset = (INNER_RADIUS_KM / 6371) * (180 / Math.PI)
    return { lng: radiusPos.lng, lat: radiusPos.lat - latOffset } // negative = south
  }, [radiusPos])

  const outerLabelPoint = useMemo(() => {
    if (!radiusPos) return null
    const latOffset = (OUTER_RADIUS_KM / 6371) * (180 / Math.PI)
    return { lng: radiusPos.lng, lat: radiusPos.lat - latOffset } // negative = south
  }, [radiusPos])

  // GeoJSON LineString for the hovered station's journey polyline from London.
  // Always mounted (with an empty geometry when not hovered) so the opacity
  // can transition smoothly, same pattern as the radius circles.
  const emptyLine = useMemo(() => ({
    type: "Feature" as const,
    geometry: { type: "LineString" as const, coordinates: [] as [number, number][] },
    properties: {},
  }), [])

  // Decodes the full set of coordinates for the hovered station's journey.
  // Returns the array (not GeoJSON) so the animation can slice it progressively.
  // Two sources:
  //   `polyline`       — encoded string from Google Routes (follows real track)
  //   `polylineCoords` — pre-decoded [lng,lat][] from RTT synthesis (straight
  //                      lines between CRS coords; looks jagged)
  // Prefer the Google-encoded polyline when both are present.
  type JourneyWithGeom = {
    polyline?: string
    polylineCoords?: [number, number][]
    legs?: { vehicleType?: string; departureStation?: string; arrivalStation?: string }[]
  }
  const resolveJourneyCoords = (j: JourneyWithGeom | undefined): [number, number][] | null => {
    if (!j) return null
    if (j.polyline) return decodePolyline(j.polyline)
    if (j.polylineCoords && j.polylineCoords.length > 1) return j.polylineCoords
    return null
  }
  // Polyline resolver — the primary's journey is already the best source we
  // have. For Google-fetched primaries it carries an encoded polyline
  // (real track). For RTT-direct synth journeys at a synthetic primary, the
  // stations memo has already spliced in a sibling's curvy polyline suffix
  // (via trimSiblingPolylineToRttRoute), so polylineCoords here contains
  // that hybrid rather than plain straight lines. For concrete primaries or
  // RTT-direct journeys with no sibling help available, polylineCoords is
  // the raw CRS-chain straight lines — still accurate for the route, just
  // jaggy-looking.
  //
  // Phase 2 hybrid: when no encoded Google polyline is present, try the
  // rail-segment composer. If it resolves every edge to a real segment
  // (isHighQualityComposition), use its track-following output; otherwise
  // fall through to the existing polylineCoords. Encoded polylines always
  // win — they're already real. The composer never overrides them.
  const preferGooglePolyline = (
    journeys: Record<string, JourneyWithGeom> | undefined,
    originKey: string,
    destId: string | undefined,
  ): [number, number][] | null => {
    if (!journeys) return null
    const primaryJourney = journeys[originKey]
    if (primaryJourney?.polyline) return decodePolyline(primaryJourney.polyline)
    if (destId) {
      const composed = composePolylineForJourney(originKey, destId, primaryJourney?.legs)
      if (composed && isHighQualityComposition(composed)) return composed.coords
    }
    if (primaryJourney?.polylineCoords && primaryJourney.polylineCoords.length > 1) {
      return primaryJourney.polylineCoords
    }
    return null
  }
  const hoveredJourneyCoords = useMemo(() => {
    if (!hovered || !stations) return null
    const feature = stations.features.find(
      (f) => `${f.geometry.coordinates[0]},${f.geometry.coordinates[1]}` === hovered.coordKey
    )
    const journeys = feature?.properties?.journeys as Record<string, JourneyWithGeom> | undefined
    const destId = feature?.properties?.id as string | undefined
    return preferGooglePolyline(journeys, primaryOrigin, destId)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hovered, stations, primaryOrigin])

  // When the Central London synthetic is the active primary AND a journey
  // is being hovered, identify which of the 16 terminus diamonds matches
  // the journey's origin — i.e. the London station where the polyline
  // starts. That one diamond should remain visible at all zoom levels
  // (below the main-layer's minzoom=9) so the user sees where the
  // highlighted train actually departs from, even zoomed out to a
  // country-wide view.
  //
  // Matched by proximity: take the polyline's first coord and find the
  // closest cluster member within ~250m (squared-deg threshold).
  // Squared-deg keeps the comparison cheap and accurate enough at
  // London's latitude.
  const journeyOriginClusterCoord = useMemo(() => {
    if (!hoveredJourneyCoords || hoveredJourneyCoords.length === 0) return null
    if (!londonTerminusFeatures) return null
    if (!getOriginDisplay(primaryOrigin)?.isCluster) return null
    const [firstLng, firstLat] = hoveredJourneyCoords[0]
    let best: [number, number] | null = null
    let bestDist = Infinity
    for (const f of londonTerminusFeatures.icons.features) {
      const [l, a] = f.geometry.coordinates as [number, number]
      const d = (l - firstLng) ** 2 + (a - firstLat) ** 2
      if (d < bestDist) {
        bestDist = d
        best = [l, a]
      }
    }
    // Tolerance of 5e-5 squared-deg ≈ 700m at London's latitude. Large
    // enough to absorb the 200m drift between a cluster member's OSM
    // coord (what the diamond is drawn at) and the terminal coord used
    // by sliceFromTerminal (from london-terminals.json) — that drift
    // alone plus any wobble on the closest-polyline-point match pushed
    // a Mortimer/Paddington case over an older 1e-5 threshold and the
    // diamond silently failed to show. Still tight enough that journeys
    // starting far from any London terminus (non-London primary edge
    // cases) don't accidentally match.
    return bestDist < 5e-5 ? best : null
  }, [hoveredJourneyCoords, londonTerminusFeatures, primaryOrigin])

  // "Sticky" copy of the journey-origin diamond's coord so it can fade out on
  // unhover instead of vanishing the moment journeyOriginClusterCoord goes
  // null. Updated whenever the live value is non-null; CLEARED only at the
  // end of the polyline fade-out effect below (the diamond keeps rendering
  // with diminishing opacity until then).
  const [persistentOriginCoord, setPersistentOriginCoord] = useState<[number, number] | null>(null)
  useEffect(() => {
    if (journeyOriginClusterCoord) setPersistentOriginCoord(journeyOriginClusterCoord)
    // Intentionally NOT clearing on null — the fade-out effect handles that
    // once the 250ms fade finishes, so the diamond fades instead of blinking off.
  }, [journeyOriginClusterCoord])

  // Friend origin polyline — same Google-preferred resolution as the primary.
  const hoveredFriendJourneyCoords = useMemo(() => {
    if (!friendOrigin || !hovered || !stations) return null
    const feature = stations.features.find(
      (f) => `${f.geometry.coordinates[0]},${f.geometry.coordinates[1]}` === hovered.coordKey
    )
    const journeys = feature?.properties?.journeys as Record<string, JourneyWithGeom> | undefined
    const destId = feature?.properties?.id as string | undefined
    return preferGooglePolyline(journeys, friendOrigin, destId)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [friendOrigin, hovered, stations])

  // Whether the currently hovered station is the active friend origin —
  // used to show "liberate your friend" instead of travel times in the label
  const hoveredIsFriendOrigin = useMemo(() => {
    if (!friendOrigin || !hovered) return false
    const feature = stationsForMap?.features.find(
      f => (f.properties.coordKey as string) === hovered.coordKey
    )
    // friendOrigin is a station ID post Phase 3c; compare against the
    // feature's id rather than its coordKey.
    return (feature?.properties.id as string | undefined) === friendOrigin
  }, [friendOrigin, hovered, stationsForMap])

  // The animated journey line GeoJSON — grows from origin to destination over time.
  // Starts with 0 points, progressively adds more, ends with the full line.
  // On unhover, opacity is manually animated to 0 via requestAnimationFrame
  // (Mapbox's line-opacity-transition doesn't survive React re-renders).
  const JOURNEY_ANIM_MS = 800
  const JOURNEY_FADE_MS = 250
  const [journeyLine, setJourneyLine] = useState(emptyLine)
  // Numeric opacity driven by rAF — avoids relying on Mapbox paint transitions
  const [journeyOpacity, setJourneyOpacity] = useState(0)
  const journeyAnimRef = useRef<number | null>(null)
  const journeyFadeRef = useRef<number | null>(null)
  const prevJourneyKey = useRef<string | null>(null)

  // --- Draw-in animation on hover ---
  useEffect(() => {
    if (!hoveredJourneyCoords) {
      prevJourneyKey.current = null
      return
    }
    // Cancel any running fade-out so the new line appears at full opacity
    if (journeyFadeRef.current) {
      cancelAnimationFrame(journeyFadeRef.current)
      journeyFadeRef.current = null
    }
    const key = hovered?.coordKey ?? null
    if (key === prevJourneyKey.current) return

    prevJourneyKey.current = key
    if (journeyAnimRef.current) cancelAnimationFrame(journeyAnimRef.current)
    setJourneyOpacity(0.5)

    const coords = hoveredJourneyCoords
    const total = coords.length
    const start = performance.now()

    function step(now: number) {
      const elapsed = now - start
      // Ease-out cubic: fast start, gentle arrival
      const t = Math.min(elapsed / JOURNEY_ANIM_MS, 1)
      const eased = 1 - Math.pow(1 - t, 3)
      // Show at least 2 points (minimum for a LineString) up to all points
      const count = Math.max(2, Math.round(eased * total))
      setJourneyLine({
        type: "Feature" as const,
        geometry: { type: "LineString" as const, coordinates: coords.slice(0, count) },
        properties: {},
      })
      if (t < 1) journeyAnimRef.current = requestAnimationFrame(step)
    }
    journeyAnimRef.current = requestAnimationFrame(step)

    return () => {
      if (journeyAnimRef.current) cancelAnimationFrame(journeyAnimRef.current)
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hoveredJourneyCoords, hovered])

  // --- Fade-out animation on unhover ---
  useEffect(() => {
    if (hoveredJourneyCoords) return // still hovered, nothing to fade
    if (journeyOpacity === 0) return // already invisible

    const start = performance.now()
    const startOpacity = journeyOpacity

    function fade(now: number) {
      const t = Math.min((now - start) / JOURNEY_FADE_MS, 1)
      setJourneyOpacity(startOpacity * (1 - t))
      if (t < 1) {
        journeyFadeRef.current = requestAnimationFrame(fade)
      } else {
        journeyFadeRef.current = null
        setJourneyLine(emptyLine)
        // Let the terminus-origin diamond drop once the fade is complete —
        // until now it's been fading alongside the polyline.
        setPersistentOriginCoord(null)
      }
    }
    journeyFadeRef.current = requestAnimationFrame(fade)

    return () => {
      if (journeyFadeRef.current) cancelAnimationFrame(journeyFadeRef.current)
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hoveredJourneyCoords])

  // --- Friend origin polyline animation (mirrors London polyline above) ---
  const [friendJourneyLine, setFriendJourneyLine] = useState(emptyLine)
  const [friendJourneyOpacity, setFriendJourneyOpacity] = useState(0)
  const friendJourneyAnimRef = useRef<number | null>(null)
  const friendJourneyFadeRef = useRef<number | null>(null)
  const prevFriendJourneyKey = useRef<string | null>(null)

  useEffect(() => {
    if (!hoveredFriendJourneyCoords) {
      prevFriendJourneyKey.current = null
      return
    }
    if (friendJourneyFadeRef.current) {
      cancelAnimationFrame(friendJourneyFadeRef.current)
      friendJourneyFadeRef.current = null
    }
    const key = hovered?.coordKey ?? null
    if (key === prevFriendJourneyKey.current) return

    prevFriendJourneyKey.current = key
    if (friendJourneyAnimRef.current) cancelAnimationFrame(friendJourneyAnimRef.current)
    setFriendJourneyOpacity(0.5)

    const coords = hoveredFriendJourneyCoords
    const total = coords.length
    const start = performance.now()

    function step(now: number) {
      const elapsed = now - start
      const t = Math.min(elapsed / JOURNEY_ANIM_MS, 1)
      const eased = 1 - Math.pow(1 - t, 3)
      const count = Math.max(2, Math.round(eased * total))
      setFriendJourneyLine({
        type: "Feature" as const,
        geometry: { type: "LineString" as const, coordinates: coords.slice(0, count) },
        properties: {},
      })
      if (t < 1) friendJourneyAnimRef.current = requestAnimationFrame(step)
    }
    friendJourneyAnimRef.current = requestAnimationFrame(step)

    return () => {
      if (friendJourneyAnimRef.current) cancelAnimationFrame(friendJourneyAnimRef.current)
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hoveredFriendJourneyCoords, hovered])

  useEffect(() => {
    if (hoveredFriendJourneyCoords) return
    if (friendJourneyOpacity === 0) return

    const start = performance.now()
    const startOpacity = friendJourneyOpacity

    function fade(now: number) {
      const t = Math.min((now - start) / JOURNEY_FADE_MS, 1)
      setFriendJourneyOpacity(startOpacity * (1 - t))
      if (t < 1) {
        friendJourneyFadeRef.current = requestAnimationFrame(fade)
      } else {
        friendJourneyFadeRef.current = null
        setFriendJourneyLine(emptyLine)
      }
    }
    friendJourneyFadeRef.current = requestAnimationFrame(fade)

    return () => {
      if (friendJourneyFadeRef.current) cancelAnimationFrame(friendJourneyFadeRef.current)
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hoveredFriendJourneyCoords])

  // --- Inter-terminal polylines on diamond hover ---
  // Pure eye-candy: when the user hovers a London-terminus diamond, fan out
  // Google-quality tube polylines from that terminus to every OTHER terminus
  // for which `terminal-matrix.json` has a pre-fetched route. Typically 13 per
  // diamond (all NR termini minus the hovered one and Farringdon — the
  // matrix's from-set covers 14 of 15). Fades in/out on hover/unhover with
  // the same rAF pattern the journey polyline uses.
  //
  // Lookup: terminal-matrix keys by canonical terminal name ("Kings Cross",
  // "St Pancras"...). The hovered diamond's `hovered.coordKey` doesn't map
  // directly there, but the terminus-feature's `name` property (already
  // canonicalised via matchTerminal at feature-build) does — so we route
  // coordKey → diamond feature → name → matrix row.
  const emptyCollection = useMemo(() => ({
    type: "FeatureCollection" as const,
    features: [] as Array<{
      type: "Feature"
      geometry: { type: "LineString"; coordinates: [number, number][] }
      properties: Record<string, unknown>
    }>,
  }), [])
  const interTerminalLines = useMemo(() => {
    // Only fire when the user is hovering a terminus diamond.
    if (!hovered || hovered.iconImage !== "icon-london-terminus") return null
    if (!londonTerminusFeatures) return null
    const diamondFeature = londonTerminusFeatures.icons.features.find(
      (f) => f.properties.coordKey === hovered.coordKey,
    )
    const hoveredName = diamondFeature?.properties?.name as string | undefined
    if (!hoveredName) return null
    const row = terminalMatrix[hoveredName]
    if (!row) return null
    // Decode each Google tube polyline — geographically accurate routes
    // (including Jubilee under-Thames curves etc.). The grow animation
    // slices from coord 0 outward, and each matrix row's polylines start
    // at the hovered terminus, so the fan naturally emanates from the
    // hovered diamond.
    const features: Array<{
      type: "Feature"
      geometry: { type: "LineString"; coordinates: [number, number][] }
      properties: Record<string, unknown>
    }> = []
    for (const [target, entry] of Object.entries(row)) {
      if (!entry?.polyline) continue
      const decoded = decodePolyline(entry.polyline)
      if (decoded.length < 2) continue
      features.push({
        type: "Feature" as const,
        geometry: { type: "LineString" as const, coordinates: decoded },
        properties: { target },
      })
    }
    return features.length > 0
      ? { type: "FeatureCollection" as const, features }
      : null
  }, [hovered, londonTerminusFeatures])

  // Data + opacity state drive the Mapbox Source/Layer below. Data stays set
  // during the fade-out so the lines don't disappear instantly; it's cleared
  // at the END of the fade (when opacity hits 0) — mirror of the journey-
  // line pattern.
  const [interTerminalData, setInterTerminalData] = useState(emptyCollection)

  // Admin-only region labels — converts the hand-edited array in
  // data/region-labels.json into the GeoJSON FeatureCollection shape Mapbox
  // expects. Each entry becomes a Point feature carrying `name` and
  // `category` properties so the symbol layer can render the label and (if
  // we ever want per-category styling) branch on category. Computed only
  // when admin mode is active — non-admin viewers never pay the cost.
  // Region-label opacity is driven declaratively by the rating-checkbox
  // state and the admin toggle (showRegions). Computed here, applied via
  // the Layer's `paint` prop below. The transition spec lives in the
  // same paint object — react-map-gl iterates paint keys in insertion
  // order when syncing changes, so listing `text-opacity-transition`
  // BEFORE `text-opacity` guarantees the transition is in place when
  // the value update lands. (Earlier this was an imperative
  // setPaintProperty effect, but react-map-gl tears down + re-creates
  // the layer on its own schedule, which clobbered the imperative value
  // and left the labels invisible until the user toggled the checkbox.)
  const regionLabelsOpacity = showRegions || visibleRatings.size === 0 ? 1 : 0
  const regionLabelsTransition = showRegions
    ? { duration: 2000, delay: 0 }       // fade in when toggled on
    : visibleRatings.size === 0
      ? { duration: 2000, delay: 5000 }  // fade in after a short pause when all ratings are off
      : { duration: 2000, delay: 0 }     // fade out when any rating is on
  // Always populate the source — visibility is driven entirely by the
  // text-opacity paint property, which Mapbox interpolates smoothly.
  // (Earlier version returned empty features when "off", but that
  // unmounted the labels synchronously the moment opacity flipped to 0,
  // which killed the fade-out animation. ~150 small Point features cost
  // is negligible.)
  const regionLabelsCollection = useMemo(() => {
    return {
      type: "FeatureCollection" as const,
      features: (regionLabelsData as Array<{ name: string; category: string; coord: [number, number] }>).map((r) => ({
        type: "Feature" as const,
        properties: { name: r.name, category: r.category },
        geometry: { type: "Point" as const, coordinates: r.coord },
      })),
    }
  }, [])

  // Historic county borders — sit alongside the region labels and follow
  // the SAME opacity formula, so labels and borders fade together. Data is
  // a 3.5 MB GeoJSON in /public; Mapbox fetches by URL the first time the
  // Source mounts, then caches. We lazy-mount via `historicCountiesNeeded`
  // so users who never reveal the labels in prod don't pay the fetch.
  // Once flipped to true it stays true — toggling off doesn't unmount,
  // it just fades opacity to 0, so re-toggling is instant (no re-fetch).
  const [historicCountiesNeeded, setHistoricCountiesNeeded] = useState(false)
  useEffect(() => {
    if (regionLabelsOpacity > 0) setHistoricCountiesNeeded(true)
  }, [regionLabelsOpacity])

  // Keyboard shortcut: `h` toggles region labels (and the borders that
  // ride along with them). Listens on window, not the map element, so it
  // works regardless of focus. Guards keep it from firing when the user
  // is typing in the search bar / any input, and let browser chords like
  // ⌘H pass through unmolested.
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key !== "h" && e.key !== "H") return
      if (e.metaKey || e.ctrlKey || e.altKey) return
      const t = e.target as HTMLElement | null
      if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable)) return
      setShowRegions((s) => !s)
    }
    window.addEventListener("keydown", onKey)
    return () => window.removeEventListener("keydown", onKey)
  }, [])
  const [interTerminalOpacity, setInterTerminalOpacity] = useState(0)
  const interFadeRef = useRef<number | null>(null)
  const interAnimRef = useRef<number | null>(null)
  const INTER_PEAK_OPACITY = 0.35
  // 2× the journey polyline's grow duration — the inter-terminal fan looks
  // better taking its time (user has a full view of central London while
  // the lines splay; a fast zip undersells the pattern).
  const INTER_ANIM_MS = JOURNEY_ANIM_MS * 2
  // Coord-slice "grow" animation when a diamond is hovered. Opacity snaps
  // to full peak immediately — same as the journey polyline — then each
  // line's coordinates reveal progressively from the hovered diamond toward
  // its target over INTER_ANIM_MS. Ease-out cubic gives a quick initial
  // splay that gradually arrives at each terminus. All 13 lines animate
  // in parallel off one rAF loop.
  useEffect(() => {
    if (!interTerminalLines) return
    if (interFadeRef.current) {
      cancelAnimationFrame(interFadeRef.current)
      interFadeRef.current = null
    }
    if (interAnimRef.current) cancelAnimationFrame(interAnimRef.current)
    // Opacity to peak immediately — the grow is carried by coord slicing,
    // not opacity, matching the journey polyline's feel.
    setInterTerminalOpacity(INTER_PEAK_OPACITY)

    const fullFeatures = interTerminalLines.features
    const start = performance.now()
    function step(now: number) {
      const t = Math.min((now - start) / INTER_ANIM_MS, 1)
      const eased = 1 - Math.pow(1 - t, 3)
      // Slice each polyline independently — different pairs have different
      // coord counts, but they all finish at t=1 so the fan-out lands in
      // sync at each target. Min 2 points keeps Mapbox from treating a
      // 1-point "line" as invalid and dropping the feature mid-animation.
      const features = fullFeatures.map((f) => {
        const total = f.geometry.coordinates.length
        const count = Math.max(2, Math.round(eased * total))
        return {
          ...f,
          geometry: {
            type: "LineString" as const,
            coordinates: f.geometry.coordinates.slice(0, count),
          },
        }
      })
      setInterTerminalData({ type: "FeatureCollection" as const, features })
      if (t < 1) interAnimRef.current = requestAnimationFrame(step)
    }
    interAnimRef.current = requestAnimationFrame(step)

    return () => {
      if (interAnimRef.current) cancelAnimationFrame(interAnimRef.current)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [interTerminalLines])
  useEffect(() => {
    if (interTerminalLines) return // still hovering — nothing to fade
    if (interTerminalOpacity === 0) return // already invisible
    const start = performance.now()
    const startOp = interTerminalOpacity
    function fade(now: number) {
      const t = Math.min((now - start) / JOURNEY_FADE_MS, 1)
      setInterTerminalOpacity(startOp * (1 - t))
      if (t < 1) {
        interFadeRef.current = requestAnimationFrame(fade)
      } else {
        interFadeRef.current = null
        setInterTerminalData(emptyCollection)
      }
    }
    interFadeRef.current = requestAnimationFrame(fade)
    return () => {
      if (interFadeRef.current) cancelAnimationFrame(interFadeRef.current)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [interTerminalLines])

  // --- Cluster anchor lines on cluster hover ---
  // When ANY element of a cluster is hovered (the anchor itself or any of
  // its diamonds), draw a dotted line from each diamond to the cluster
  // anchor. The line "grows" from the diamond outward over CLUSTER_ANCHOR_GROW_MS.
  // Resolves the effective anchor coord, mapping the London marker's
  // sentinel "london" coordKey back to primaryOrigin (which is what each
  // diamond's synthAnchor property holds).
  // STABLE string id of the currently hovered cluster's anchor (or null).
  // The animation effect below depends on this string — NOT on the line-
  // targets array — so it fires once per cluster-hover instead of once
  // per render. Without this, every setState from the rAF would create
  // a new memo reference and the effect cleanup would cancel the rAF
  // before it could advance (feedback loop → progress stuck at 0).
  const hoveredClusterAnchor = useMemo(() => {
    if (!hovered) return null
    // hovered.coordKey is a real coord (or the magic string "london"
    // for the active-primary hexagon). Translate to the canonical
    // anchor ID via the registry — coord→ID resolution covers both
    // synthetic anchor centroids AND real station coords; only
    // anchor-coord hits will then survive ALL_SYNTHETIC_IDS.
    const effective = hovered.coordKey === "london"
      ? primaryOrigin
      : (resolveCoordKey(hovered.coordKey) ?? hovered.coordKey)
    return ALL_SYNTHETIC_IDS.has(effective) ? effective : null
  }, [hovered, primaryOrigin])

  const clusterAnchorLineTargets = useMemo(() => {
    if (!hoveredClusterAnchor || !visibleClusterDiamondFeatures) return null
    // hoveredClusterAnchor is now an anchor ID; resolve to its
    // centroid coord for the line endpoint.
    const anchorCoord = SYNTHETIC_COORDS[hoveredClusterAnchor]
    if (!anchorCoord) return null
    const { lng: anchorLng, lat: anchorLat } = parseCoordKey(anchorCoord)
    if (!Number.isFinite(anchorLng) || !Number.isFinite(anchorLat)) return null
    // Pair each cluster member's diamond coord with the anchor coord.
    // Result is the FULL line — the rAF effect below interpolates the
    // endpoint each frame to make the line appear to grow.
    const pairs = visibleClusterDiamondFeatures.icons.features
      .filter((f) => f.properties.synthAnchor === hoveredClusterAnchor)
      .map((f) => {
        const [lng, lat] = f.geometry.coordinates as [number, number]
        return { from: [lng, lat] as [number, number], to: [anchorLng, anchorLat] as [number, number], coordKey: f.properties.coordKey as string }
      })
    return pairs.length > 0 ? pairs : null
  }, [hoveredClusterAnchor, visibleClusterDiamondFeatures])

  // Grow progress 0 → 1. Drives the line endpoint lerp below. Resets
  // to 0 whenever the hovered cluster changes (so the lines re-grow
  // for each new cluster), and snaps to 0 when no cluster is hovered.
  const [clusterAnchorProgress, setClusterAnchorProgress] = useState(0)
  const clusterAnchorAnimRef = useRef<number | null>(null)
  const CLUSTER_ANCHOR_GROW_MS = 2000
  useEffect(() => {
    if (clusterAnchorAnimRef.current) {
      cancelAnimationFrame(clusterAnchorAnimRef.current)
      clusterAnchorAnimRef.current = null
    }
    if (!hoveredClusterAnchor) {
      setClusterAnchorProgress(0)
      return
    }
    setClusterAnchorProgress(0)
    const start = performance.now()
    function step(now: number) {
      const t = Math.min((now - start) / CLUSTER_ANCHOR_GROW_MS, 1)
      // ease-out cubic — quick start, gentle landing on the anchor
      const eased = 1 - Math.pow(1 - t, 3)
      setClusterAnchorProgress(eased)
      if (t < 1) {
        clusterAnchorAnimRef.current = requestAnimationFrame(step)
      } else {
        clusterAnchorAnimRef.current = null
      }
    }
    clusterAnchorAnimRef.current = requestAnimationFrame(step)
    return () => {
      if (clusterAnchorAnimRef.current) cancelAnimationFrame(clusterAnchorAnimRef.current)
    }
  }, [hoveredClusterAnchor])

  // Walking-route cache. Each entry holds the full polyline (real
  // footpaths from Mapbox Directions) plus pre-computed cumulative
  // distances along the path. The cumulative array makes the
  // arc-length slicing in the build memo a binary-search-cheap
  // operation per frame (vs. recomputing distances every render).
  // Keyed "fromLng,fromLat|toLng,toLat" so each from→to pair is
  // fetched once per session and reused on every subsequent hover.
  // `Map` is shadowed by the react-map-gl Map import at the top of
  // this file, so reach for the JS-builtin constructor explicitly.
  const walkingRouteCacheRef = useRef<globalThis.Map<string, { coords: [number, number][]; cumLengths: number[]; total: number }>>(new globalThis.Map())
  // Bumped when new routes land in the cache, forcing the
  // clusterAnchorLines memo to recompute. Without this, the lines
  // would keep using the straight-line fallback even after the
  // walking polyline is available — useMemo can't see ref mutations.
  const [walkingRouteCacheVersion, setWalkingRouteCacheVersion] = useState(0)

  // Fetch walking routes from Mapbox Directions API when the hovered
  // cluster changes. Misses are filled in parallel; hits are skipped.
  // Falls back silently to straight-line in the build memo below if a
  // request fails — the line still grows, just without the winding
  // footpath shape. Uses the existing NEXT_PUBLIC_MAPBOX_TOKEN; this
  // request is included in the standard Mapbox subscription.
  useEffect(() => {
    if (!hoveredClusterAnchor || !visibleClusterDiamondFeatures) return
    const token = process.env.NEXT_PUBLIC_MAPBOX_TOKEN
    if (!token) return
    // Re-derive the from→to pairs here (rather than depending on the
    // clusterAnchorLineTargets memo) so this effect's dep array stays
    // a stable string and we don't refetch on every render.
    // hoveredClusterAnchor is an anchor ID — resolve to centroid coord.
    const anchorCoord = SYNTHETIC_COORDS[hoveredClusterAnchor]
    if (!anchorCoord) return
    const { lng: anchorLng, lat: anchorLat } = parseCoordKey(anchorCoord)
    if (!Number.isFinite(anchorLng) || !Number.isFinite(anchorLat)) return
    const pairs = visibleClusterDiamondFeatures.icons.features
      .filter((f) => f.properties.synthAnchor === hoveredClusterAnchor)
      .map((f) => {
        const [lng, lat] = f.geometry.coordinates as [number, number]
        return { from: [lng, lat] as [number, number], to: [anchorLng, anchorLat] as [number, number] }
      })
    const tasks = pairs
      .map((p) => ({ ...p, key: `${p.from[0]},${p.from[1]}|${p.to[0]},${p.to[1]}` }))
      .filter((t) => !walkingRouteCacheRef.current.has(t.key))
    if (tasks.length === 0) return
    let cancelled = false
    Promise.all(tasks.map(async (t) => {
      try {
        // overview=full keeps every coord (default would simplify),
        // which we want for the most authentic "winding footpath" feel.
        const url = `https://api.mapbox.com/directions/v5/mapbox/walking/${t.from[0]},${t.from[1]};${t.to[0]},${t.to[1]}?geometries=geojson&overview=full&access_token=${token}`
        const res = await fetch(url)
        if (!res.ok) return null
        const data = await res.json()
        const coords = data.routes?.[0]?.geometry?.coordinates as [number, number][] | undefined
        if (!coords || coords.length < 2) return null
        // Pre-compute cumulative distances. Degree-space distance is
        // fine for slicing — we just need RELATIVE lengths to find
        // the point at progress * total. No geographic correction
        // needed since we never expose the values, only their ratios.
        const cumLengths: number[] = [0]
        for (let i = 1; i < coords.length; i++) {
          const dx = coords[i][0] - coords[i - 1][0]
          const dy = coords[i][1] - coords[i - 1][1]
          cumLengths.push(cumLengths[i - 1] + Math.sqrt(dx * dx + dy * dy))
        }
        return { key: t.key, route: { coords, cumLengths, total: cumLengths[cumLengths.length - 1] } }
      } catch {
        return null
      }
    })).then((results) => {
      if (cancelled) return
      let added = 0
      for (const r of results) {
        if (r) {
          walkingRouteCacheRef.current.set(r.key, r.route)
          added++
        }
      }
      if (added > 0) setWalkingRouteCacheVersion((v) => v + 1)
    })
    return () => { cancelled = true }
  }, [hoveredClusterAnchor, visibleClusterDiamondFeatures])

  // Build the GeoJSON line features for the current animation frame.
  // For routes that have arrived in the cache, slice the real walking
  // polyline by ARC LENGTH so the line reveals at uniform speed along
  // the actual footpath (not in equal-coord chunks — which would race
  // along straight stretches and crawl through twisty bits). For
  // routes still in flight, fall back to a straight-line lerp from
  // diamond → anchor; the route will swap in seamlessly when the
  // fetch resolves.
  const clusterAnchorLines = useMemo(() => {
    if (!clusterAnchorLineTargets) return null
    const features = clusterAnchorLineTargets.map(({ from, to, coordKey }) => {
      const key = `${from[0]},${from[1]}|${to[0]},${to[1]}`
      const cached = walkingRouteCacheRef.current.get(key)
      let coordinates: [number, number][]
      if (cached && cached.total > 0) {
        const target = clusterAnchorProgress * cached.total
        // Walk forward to the segment containing `target`, then
        // interpolate the partial segment so the head of the line
        // lands exactly at progress * total — no quantisation steps.
        let i = 1
        while (i < cached.coords.length && cached.cumLengths[i] < target) i++
        if (i >= cached.coords.length) {
          coordinates = cached.coords
        } else {
          const segLen = cached.cumLengths[i] - cached.cumLengths[i - 1]
          const segFrac = segLen > 0 ? (target - cached.cumLengths[i - 1]) / segLen : 0
          const interp: [number, number] = [
            cached.coords[i - 1][0] + (cached.coords[i][0] - cached.coords[i - 1][0]) * segFrac,
            cached.coords[i - 1][1] + (cached.coords[i][1] - cached.coords[i - 1][1]) * segFrac,
          ]
          coordinates = [...cached.coords.slice(0, i), interp]
        }
      } else {
        // Straight-line fallback while route is loading or if fetch failed.
        const lerpedTo: [number, number] = [
          from[0] + (to[0] - from[0]) * clusterAnchorProgress,
          from[1] + (to[1] - from[1]) * clusterAnchorProgress,
        ]
        coordinates = [from, lerpedTo]
      }
      return {
        type: "Feature" as const,
        geometry: { type: "LineString" as const, coordinates },
        properties: { coordKey },
      }
    })
    return { type: "FeatureCollection" as const, features }
    // walkingRouteCacheVersion is the trigger for re-running this memo
    // when new routes are added to the cache (refs alone don't trigger
    // memo recomputes).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [clusterAnchorLineTargets, clusterAnchorProgress, walkingRouteCacheVersion])

  // Tracks which station is currently hovered without triggering re-renders.
  // We compare against this ref in onMouseMove to skip redundant state updates.
  const hoveredRef = useRef<string | null>(null)

  // Ref to the Mapbox map instance — needed to call queryRenderedFeatures for touch events
  const mapRef = useRef<MapRef>(null)
  // Timer for long-press detection on touch devices
  const longPressTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  // Set to true when a long press fires — suppresses the click that follows touchend
  const longPressFired = useRef(false)
  // DEDICATED ref for the two-tap touch sequence. DO NOT use hoveredRef here —
  // hoveredRef is also mutated by mouse events (including iOS Safari's
  // synthesised mousemove right before a tap's click), which can erroneously
  // make the first touch look like a second tap. Keeping this isolated means
  // only real touchstart events decide whether the next click opens the modal.
  const touchFirstTapCoord = useRef<string | null>(null)
  // Timestamp of the most recent first-tap. If the second tap doesn't arrive
  // within this window, we treat the next tap on that station as a FRESH
  // first-tap again — prevents stale "second-tap" state from accidentally
  // matching much later (e.g. user tap-previews a station, gets distracted,
  // taps the same station minutes later expecting a preview, not the modal).
  const touchFirstTapAt = useRef<number>(0)
  const SECOND_TAP_WINDOW_MS = 8_000
  // Click-based second-layer gate for touch devices. Purely defensive —
  // if handleTouchStart somehow doesn't run (an iOS quirk reported where
  // the first tap after closing a modal opens the modal immediately),
  // handleClick uses THIS ref to enforce the two-tap requirement. Only
  // consulted when running on a touch device (hover: none).
  const clickFirstTapCoord = useRef<string | null>(null)
  const clickFirstTapAt = useRef<number>(0)
  // Timestamp of the last handleTouchStart run. When the click fires within
  // ~500ms after a touchstart, we KNOW touchstart ran and its two-tap gate
  // is handling the sequence — so we skip the click-based fallback (which
  // would otherwise double-gate and require 3 taps instead of 2 to open a
  // modal). The click-based fallback only activates for "naked" clicks
  // (mouse, or iOS quirk where touchstart didn't fire).
  const touchStartFiredAt = useRef<number>(0)
  // True on phones/tablets where the only input is taps (no hover).
  // Hybrid desktops with a touchscreen report hover:none = false and get
  // single-click-opens-modal behaviour — that's intentional.
  const [isTouchDevice, setIsTouchDevice] = useState(false)
  useEffect(() => {
    const mq = window.matchMedia("(hover: none)")
    setIsTouchDevice(mq.matches)
    const listener = () => setIsTouchDevice(mq.matches)
    mq.addEventListener("change", listener)
    return () => mq.removeEventListener("change", listener)
  }, [])

  // Breathing animation on the hovered station: halo ring + icon pulse.
  // Single rAF sine wave drives both so they read as one heartbeat. The
  // icon pulse lives on a DEDICATED single-feature layer (hovered-station-
  // icon) — that's what makes per-frame `setLayoutProperty("icon-size")`
  // cheap: Mapbox only has to re-layout one symbol instead of the ~500
  // on the main station layers, so there's no judder even on mobile.
  useEffect(() => {
    if (!hovered || !mapRef.current) return
    const map = mapRef.current.getMap()
    let frame: number | null = null
    const loop = () => {
      // sine wave mapped to 0..1, period 1.6s
      const s = 0.5 + 0.5 * Math.sin((Date.now() / 1600) * Math.PI * 2)
      // Halo ring (paint, GPU-cheap): radius 22→34, opacity 0.35→0.75
      if (map.getLayer("hovered-station-glow")) {
        map.setPaintProperty("hovered-station-glow", "circle-radius", 22 + s * 12)
        map.setPaintProperty("hovered-station-glow", "circle-opacity", 0.35 + s * 0.4)
      }
      // Icon pulse (layout, one feature): 1.3× at trough → 1.5× at peak.
      // Never goes below the base layer's 1.3× hover scale so the static
      // icon is always covered and the pulse reads as a single icon
      // gently breathing rather than two stacked icons.
      if (map.getLayer("hovered-station-icon")) {
        map.setLayoutProperty("hovered-station-icon", "icon-size", 1.3 + s * 0.2)
      }
      // Cluster-diamond pulse — ALL diamonds in the hovered cluster
      // breathe together via the hovered-synth layer.
      if (map.getLayer("cluster-diamond-icon-hovered-synth")) {
        map.setLayoutProperty("cluster-diamond-icon-hovered-synth", "icon-size", 0.6 + s * 0.2)
      }
      frame = requestAnimationFrame(loop)
    }
    frame = requestAnimationFrame(loop)
    return () => { if (frame != null) cancelAnimationFrame(frame) }
  }, [hovered])


  // Fires on every cursor movement over the map.
  // Unlike onMouseEnter (which is layer-level and won't re-fire when moving
  // between features in the same layer), onMouseMove always reports whatever
  // feature is under the cursor — so hover updates correctly between stations.
  const handleMouseMove = useCallback((e: MapMouseEvent) => {
    // Track the raw cursor lng/lat for the admin-only coord-key readout.
    // Cheap: one state update per mousemove. The readout UI is gated by
    // devExcludeActive so non-admin users never see it.
    setCursorCoord({ lng: e.lngLat.lng, lat: e.lngLat.lat })
    const feature = e.features?.[0]
    if (!feature) {
      if (hoveredRef.current !== null) {
        hoveredRef.current = null
        setHovered(null)
        setHoveredDiamond(null)
      }
      return
    }
    const coordKey = feature.properties?.coordKey as string
    // Only update state when the hovered station actually changes
    if (hoveredRef.current === coordKey) return
    hoveredRef.current = coordKey
    const [lng, lat] = (feature.geometry as unknown as { coordinates: [number, number] }).coordinates

    // Cluster-diamond hover special case. A diamond carries a
    // `synthAnchor` property pointing at its parent synthetic's
    // centroid coord. We don't want a pulsing rating-icon stacked on
    // top of the diamond (the "Stratford 7m" overlap shown in the bug
    // report) — instead, redirect the main `hovered` state to the
    // SYNTHETIC's coord (so its icon pulses at the centroid) and stamp
    // the diamond on a dedicated `hoveredDiamond` state so the diamond
    // itself can grow + pulse via its own dedicated layer.
    // Resolve the synthetic anchor — diamond features carry it directly
    // as `synthAnchor` (a station ID post Phase 3c), but station-hit-
    // area-cluster features (which Mapbox often returns first because
    // their layer renders on top) only have `isClusterMember`. Fall
    // back to MEMBER_TO_SYNTHETIC keyed by the feature's id so both
    // paths enter the diamond hover branch.
    const featureIdProp = feature.properties?.id as string | undefined
    const synthAnchor = (feature.properties?.synthAnchor as string | undefined)
      ?? (feature.properties?.isClusterMember && featureIdProp
        ? MEMBER_TO_SYNTHETIC[featureIdProp]
        : undefined)
    if (synthAnchor) {
      // Anchor coord (lng/lat) for the hover pulse — read from the
      // SYNTHETIC_COORDS map since synthAnchor is an ID.
      const synthCoord = SYNTHETIC_COORDS[synthAnchor] ?? ""
      const [synthLngStr, synthLatStr] = synthCoord.split(",")
      const synthLng = parseFloat(synthLngStr)
      const synthLat = parseFloat(synthLatStr)
      // Look up the synthetic's underlying station feature for icon
      // resolution: a non-active synthetic appears as a regular rating
      // icon (rating icon / unrated circle), the active primary
      // synthetic appears as icon-london (square), the active friend
      // synthetic appears as icon-origin (also a square). Falling
      // through to the synthetic anchor's feature in `stations` lets
      // resolveStationIconImage do that resolution naturally.
      const synthFeat = stations?.features.find(
        (f) => (f.properties as { id?: string }).id === synthAnchor
      )
      // The synthetic feature in `stations` is built without a `rating`
      // — that property is stamped later in allStationsWithRatings.
      // Pull it from the `ratings` state directly so the hover icon
      // matches the static one (e.g. London = hexagon for rating 2).
      // Without this, resolveStationIconImage sees no rating and
      // returns "icon-unrated" — the pulse renders as a circle on top
      // of the static hexagon. ratings is coord-keyed (legacy server
      // shape), so look up via the synthetic's coord.
      const synthRating = synthCoord ? ratings[synthCoord] : undefined
      const synthPropsForIcon = synthRating != null
        ? { ...(synthFeat?.properties ?? {}), rating: synthRating }
        : (synthFeat?.properties ?? undefined)
      const synthIconImage = synthAnchor === primaryOrigin
        ? "icon-london"
        : synthAnchor === friendOrigin
        ? "icon-origin"
        : resolveStationIconImage(synthPropsForIcon)
      setHovered({ lng: synthLng, lat: synthLat, coordKey: synthCoord, iconImage: synthIconImage })
      setHoveredDiamond({
        coordKey,
        id: featureIdProp,
        lng,
        lat,
        name: (feature.properties?.name as string | undefined) ?? "",
      })
      setRadiusPos(null)
      return
    }

    // `feature.properties` on a GeoJSON Feature is `Record<string, unknown> | null`,
    // but resolveStationIconImage takes `Record<string, unknown> | undefined`. Coerce
    // a null properties bag to undefined so the call type-checks — the helper treats
    // both the same way (no properties → "icon-unrated" default).
    setHovered({ lng, lat, coordKey, iconImage: resolveStationIconImage(feature.properties ?? undefined) })
    setHoveredDiamond(null)
    // Secret admin marker — ignore hover entirely (no cursor, no radius)
    if (feature.properties?.isSecretAdmin) {
      hoveredRef.current = null
      setHovered(null)
      setHoveredDiamond(null)
      setRadiusPos(null)
      return
    }
    // London marker and terminus diamonds shouldn't produce radius circles.
    // Hike-radii only make sense for destination stations — the hexagon is
    // the home origin, and the 18 cluster-terminus diamonds are anchors for
    // the journey polyline, neither are hiking destinations.
    if (feature.properties?.isLondon || feature.properties?.isTerminus) setRadiusPos(null)
    else setRadiusPos({ lng, lat })
  }, [stations, primaryOrigin, friendOrigin, ratings])

  const handleMouseLeave = useCallback(() => {
    hoveredRef.current = null
    setHovered(null)
    setHoveredDiamond(null)
  }, [])

  // Mobile two-tap behaviour (replaces old long-press):
  //   1st tap on a station → show radius circles + pulse (like desktop hover).
  //   2nd tap on the SAME station → open the modal.
  //   Tap anywhere else / another station → move the hover there.
  //   Desktop (non-touch) still opens the modal on a single click — this
  //   handler is only wired to the touchstart event.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const handleTouchStart = useCallback((e: any) => {
    // Stamp every touchstart immediately, even if we bail early — that way
    // handleClick knows a real touchstart fired for this tap (relevant for
    // the click-based fallback gate below).
    touchStartFiredAt.current = Date.now()
    const point = e.point
    const map = mapRef.current?.getMap()
    if (!map || !point) return
    // Include the larger hovered-station-hit layer so that when a station is
    // already in the hover/preview state, the second tap's hit target is the
    // generously-sized invisible circle — easier to land with a fingertip.
    // CRITICAL: filter the layer list to ones that currently exist on the
    // map. queryRenderedFeatures returns EMPTY for the whole call if ANY
    // named layer is missing — and hovered-station-hit only exists while
    // something is hovered. Before this fix, first-tap queries silently
    // returned 0 features, making touchstart bail and never set
    // longPressFired → first-tap opened the modal instead of previewing.
    const TAP_SLOP = 25
    const bbox: [[number, number], [number, number]] = [
      [point.x - TAP_SLOP, point.y - TAP_SLOP],
      [point.x + TAP_SLOP, point.y + TAP_SLOP],
    ]
    const candidateLayers = [
      "hovered-station-hit", "station-hit-area", "london-hit-area",
      // Terminus diamonds are tappable on mobile too — include them in
      // the candidate set so first-tap detection fires for diamonds
      // the same way it does for regular station hit areas.
      "london-terminus-icon", "london-terminus-origin-icon",
      "cluster-diamond-icon",
      "station-hit-area-cluster",
    ]
      .filter((id) => !!map.getLayer(id))
    const features = candidateLayers.length
      ? map.queryRenderedFeatures(bbox, { layers: candidateLayers })
      : []
    if (!features.length) return

    // Pick the best feature rather than just features[0]. With a 25px tap-
    // slop bbox, multiple stations can be inside, and Mapbox doesn't always
    // return them strictly in circle-sort-key order. We prefer features that
    // have a specific type (origin / excluded / rated) over unrated ones so
    // the pulse icon + modal routing reflect what the user most likely
    // intended to tap. Ties are broken by the source order (features[i]).
    //
    // HIGHEST PRIORITY: features from hovered-station-hit (the enlarged
    // preview-state layer). Without this boost, a station in preview state
    // loses taps to any neighbouring highlight/verified station inside the
    // 25px slop, because hovered-station-hit's feature carries only coordKey
    // and scores 0 in the rating-based tie-break. Giving it a score of 10
    // guarantees the enlarged hit area wins, regardless of what rating the
    // station has — which is what makes the 64px "unmissable" zone on
    // mobile actually unmissable.
    const priority = (
      p: Record<string, unknown> | undefined,
      layerId: string | undefined,
    ): number => {
      if (layerId === "hovered-station-hit") return 10
      if (!p) return 0
      if (p.isBuriedHidden) return 1
      switch (p.rating) {
        case 4:
        case 3:
        case 2:
        case 1:
          return 2
        default:
          return 0
      }
    }
    const feature = [...features].sort(
      (a, b) =>
        priority(b.properties as Record<string, unknown>, b.layer?.id)
        - priority(a.properties as Record<string, unknown>, a.layer?.id),
    )[0]
    const coordKey = feature.properties?.coordKey as string
    // Second-tap detection uses the dedicated touchFirstTapCoord ref (NOT
    // hoveredRef) so a stray mousemove — e.g. iOS Safari's synthesised one
    // that fires before click — can't pre-mark the station and cause the
    // first real tap to skip the preview and open the modal.
    // We also require the previous first-tap to be RECENT (within
    // SECOND_TAP_WINDOW_MS). Anything older is treated as stale state and
    // the current tap becomes a fresh first-tap — this prevents the "after
    // N taps it breaks" edge case where the ref gets out of sync with user
    // intent after distractions or close-then-navigate sequences.
    const now = Date.now()
    const isFreshSecondTap =
      touchFirstTapCoord.current === coordKey &&
      now - touchFirstTapAt.current < SECOND_TAP_WINDOW_MS
    if (isFreshSecondTap) {
      // Real second tap. Clear our flag and let the click fall through to
      // open the modal.
      touchFirstTapCoord.current = null
      touchFirstTapAt.current = 0
      return
    }
    // First tap (or switching to a different station). Show preview + suppress
    // the click that follows this touchstart.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const [lng, lat] = (feature.geometry as any).coordinates as [number, number]
    touchFirstTapCoord.current = coordKey
    touchFirstTapAt.current = now
    hoveredRef.current = coordKey
    // `feature.properties` on a GeoJSON Feature is `Record<string, unknown> | null`,
    // but resolveStationIconImage takes `Record<string, unknown> | undefined`. Coerce
    // a null properties bag to undefined so the call type-checks — the helper treats
    // both the same way (no properties → "icon-unrated" default).
    setHovered({ lng, lat, coordKey, iconImage: resolveStationIconImage(feature.properties ?? undefined) })
    // Mirror the desktop rule — no hike-radii for the home hexagon or for
    // cluster-terminus diamonds. Neither is a hiking destination, so
    // showing the concentric walk-radius circles around them misleads.
    if (feature.properties?.isLondon || feature.properties?.isTerminus) setRadiusPos(null)
    else setRadiusPos({ lng, lat })
    longPressFired.current = true
  }, [])

  // No-op on touchend/touchmove — we now persist the hover state between taps
  // instead of clearing on lift, so the 2nd tap has something to detect.
  const handleTouchEndOrMove = useCallback(() => {
    // Intentionally empty. Retained so existing prop wiring (<Map onTouchStart
    // … onTouchEnd={handleTouchEndOrMove} />) doesn't break; can remove in a
    // later refactor.
  }, [])

  // Dev only. Right-click behaviour depends on what's under the cursor:
  //   - On a regular station → toggle its buried flag.
  //   - On the London hexagon → no-op (it has its own click behaviour).
  //   - On empty map → copy the cursor coord-key ("lng,lat", 2 decimals)
  //     to the clipboard so the admin can paste it into a data file
  //     (region-labels.json etc) without retyping. Format matches the
  //     on-screen coord readout so what they see is what gets copied.
  const handleContextMenu = useCallback((e: MapMouseEvent) => {
    if (!devExcludeActive) return
    const feature = e.features?.[0]
    if (feature) {
      if (feature.properties?.isLondon) return
      const name = feature.properties?.name as string
      const coordKey = feature.properties?.coordKey as string
      handleToggleBuried(name, coordKey)
      return
    }
    // Empty space — copy coord to clipboard.
    const coordKey = `${e.lngLat.lng.toFixed(2)},${e.lngLat.lat.toFixed(2)}`
    navigator.clipboard.writeText(coordKey).then(() => {
      setCoordCopied(true)
      setTimeout(() => setCoordCopied(false), 1000)
    }).catch(() => {/* clipboard blocked — silent fail */})
  }, [devExcludeActive, handleToggleBuried])

  // Handles station clicks — always opens the detail modal (with dev tools when dev mode is on).
  // Clicking empty map space closes the modal.
  const handleClick = useCallback((e: MapMouseEvent) => {
    // A long press just ended — the browser fires a click on touchend, ignore it
    if (longPressFired.current) {
      longPressFired.current = false
      return
    }
    // Prefer a hovered-station-hit feature over anything else in the click
    // event. e.features[0] is usually this layer (it renders last in the
    // Mapbox stack), but on a mobile tap that lands just inside the enlarged
    // 64px radius and also clips a neighbouring station's 16px hit area,
    // Mapbox can occasionally return the neighbour first. Explicitly
    // searching for the hovered layer guarantees the "station in preview
    // state" always wins the tap and opens ITS modal — regardless of
    // neighbour ratings.
    let feature =
      e.features?.find((f) => f.layer?.id === "hovered-station-hit")
      ?? e.features?.[0]

    // Friend-anchor click — opens the synthetic friend's stripped-down
    // overlay (with the cluster header). Same UX as clicking a London
    // hexagon when London is the active primary. Handled before the
    // general feature dispatch because the friend-anchor's coord is
    // synthetic and won't match any baseStations feature.
    const friendAnchorHit = e.features?.find(
      (f) => f.layer?.id === "friend-anchor-icon" || f.layer?.id === "friend-anchor-hit",
    )
    if (friendAnchorHit && friendOrigin) {
      const friendDef = getOriginDisplay(friendOrigin)
      if (friendDef?.isCluster) {
        // friendOrigin is now an ID; SYNTHETIC_COORDS / the registry
        // surface the centroid coord we draw at.
        const friendCoord = SYNTHETIC_COORDS[friendOrigin] ?? registryGetCoordKey(friendOrigin) ?? ""
        const [aLngStr, aLatStr] = friendCoord.split(",")
        const aLng = parseFloat(aLngStr)
        const aLat = parseFloat(aLatStr)
        const pt = mapRef.current?.project([aLng, aLat])
        setSelectedStation({
          name: friendDef.overlayName ?? friendDef.displayName,
          lng: aLng,
          lat: aLat,
          minutes: 0,
          coordKey: friendCoord,
          id: friendOrigin,
          flickrCount: null,
          screenX: pt?.x ?? window.innerWidth / 2,
          screenY: pt?.y ?? window.innerHeight / 2,
        })
        hoveredRef.current = null
        touchFirstTapCoord.current = null
        touchFirstTapAt.current = 0
        setHovered(null)
        return
      }
    }

    if (!feature) {
      // Tap on empty map — clear BOTH two-tap layers so the next station
      // tap starts fresh as a first tap, rather than a stale "second tap".
      touchFirstTapCoord.current = null
      touchFirstTapAt.current = 0
      clickFirstTapCoord.current = null
      clickFirstTapAt.current = 0
      setSelectedStation(null)
      return
    }
    // Cluster diamond click — open the synthetic's stripped-down overlay
    // directly (NOT the individual member's). User UX rule: a tap on any
    // diamond reads as "open the cluster", since the diamond is the
    // visual representation of cluster membership. The synthetic anchor
    // owns the cluster-header copy and shared photos.
    //
    // Resolution uses the global MEMBER_TO_SYNTHETIC lookup so it works
    // for ANY visible synthetic — not just the active primary/friend.
    // After the visibility-rules change (cluster diamonds appear
    // whenever their parent synthetic is on the map), a click on, say,
    // a Birmingham diamond while London is the primary should still
    // open the Birmingham overlay.
    //
    // Also covers `cluster-diamond-icon` from the always-on
    // all-cluster-diamonds layer (added to interactiveLayerIds below).
    if (
      feature.layer?.id === "london-terminus-icon" ||
      feature.layer?.id === "london-terminus-origin-icon" ||
      feature.layer?.id === "friend-cluster-icon" ||
      feature.layer?.id === "cluster-diamond-icon" ||
      feature.layer?.id === "station-hit-area-cluster"
    ) {
      // Diamond features carry the member's station ID; synthetic
      // virtual features carry the anchor ID directly. Either way,
      // resolving via MEMBER_TO_SYNTHETIC handles both: a member ID
      // maps to its anchor, and a non-member ID falls through (we
      // then fall back to the ID itself when it IS a synthetic anchor).
      const diamondId = feature.properties?.id as string | undefined
      const anchorId = diamondId
        ? (MEMBER_TO_SYNTHETIC[diamondId] ?? (ALL_SYNTHETIC_IDS.has(diamondId) ? diamondId : undefined))
        : undefined
      const anchorName = anchorId
        ? (getOriginDisplay(anchorId)?.overlayName
          ?? getOriginDisplay(anchorId)?.displayName
          // Final fallback: destination-only clusters (e.g. Windsor)
          // aren't in the registry as origins, but every cluster has
          // a displayName in SYNTHETIC_DISPLAY_NAMES.
          ?? SYNTHETIC_DISPLAY_NAMES[anchorId]
          ?? null)
        : null
      if (anchorId && anchorName) {
        const anchorCoord = SYNTHETIC_COORDS[anchorId]
        const [aLngStr, aLatStr] = (anchorCoord ?? ",").split(",")
        const aLng = parseFloat(aLngStr)
        const aLat = parseFloat(aLatStr)
        const pt = mapRef.current?.project([aLng, aLat])
        // Look up the synthetic's virtual feature (built in the
        // `stations` memo) so the modal gets the synthetic's
        // top-ranked-member journey + cluster member labels. The
        // virtual feature carries `id: anchorId` for direct lookup.
        const synthFeat = stations?.features.find(
          (g) => (g.properties as { id?: string }).id === anchorId
        )
        const synthProps = (synthFeat?.properties ?? {}) as Record<string, unknown>
        setSelectedStation({
          name: anchorName,
          lng: aLng,
          lat: aLat,
          minutes: (synthProps.londonMinutes as number | null | undefined) ?? 0,
          coordKey: anchorCoord ?? "",
          id: anchorId,
          flickrCount: null,
          screenX: pt?.x ?? window.innerWidth / 2,
          screenY: pt?.y ?? window.innerHeight / 2,
          journeys: synthProps.journeys as Record<string, JourneyInfo> | undefined,
        })
        hoveredRef.current = null
        touchFirstTapCoord.current = null
        touchFirstTapAt.current = 0
        setHovered(null)
        return
      }
    }

    // If the click landed on the enlarged hovered-hit layer, its feature only
    // carries { coordKey }. Resolve to the real station feature (with name,
    // journeys, etc.) so all downstream logic works normally.
    if (feature.layer?.id === "hovered-station-hit") {
      const hoveredCoordKey = feature.properties?.coordKey as string | undefined
      // Special case: the London hexagon's hovered form has coordKey "london"
      // (set by the source at the hexagon's origin coords). For a real-station
      // primary we resolve to that station's feature and let the normal modal
      // flow run. For a synthetic primary (e.g. the "London" cluster anchor,
      // which has no station feature of its own) we short-circuit and open
      // the modal here, using the primary's displayName — no "Station"
      // suffix, no lookup.
      if (hoveredCoordKey === "london") {
        const primaryDef = getOriginDisplay(primaryOrigin)
        if (primaryDef?.isCluster) {
          const pt = mapRef.current?.project([originCoords.lng, originCoords.lat])
          setSelectedStation({
            name: primaryDef.overlayName ?? primaryDef.displayName,
            lng: originCoords.lng,
            lat: originCoords.lat,
            minutes: 0,
            coordKey: registryGetCoordKey(primaryOrigin) ?? "",
            id: primaryOrigin,
            flickrCount: null,
            screenX: pt?.x ?? window.innerWidth / 2,
            screenY: pt?.y ?? window.innerHeight / 2,
          })
          hoveredRef.current = null
          touchFirstTapCoord.current = null
          touchFirstTapAt.current = 0
          setHovered(null)
          return
        }
        const primaryFeature = stations?.features.find(
          (f) => (f.properties as { id?: string } | undefined)?.id === primaryOrigin
        )
        if (primaryFeature) feature = primaryFeature as unknown as typeof feature
      } else {
        const real = stations?.features.find(
          (f) => (f.properties as { coordKey?: string } | undefined)?.coordKey === hoveredCoordKey
        )
        if (real) feature = real as unknown as typeof feature
      }
    }
    // Cloud admin doorway — invisible marker at a fixed map coord.
    // Works in production too: the admin API allows writes for the
    // non-bundled data files (photos, notes, ratings, etc.) and the
    // outbox handles offline tolerance. Bundled-file routes are still
    // blocked at the middleware layer — those need a redeploy anyway.
    if (feature.properties?.isSecretAdmin) {
      // The doorway toggles admin mode WITHOUT
      // touching any filter UI state. This entry point is meant for
      // quick peeking — I'm already looking at a particular slice of
      // the map and just want admin overlays (red halos, admin-only
      // rows, etc.) on top of what I'm seeing, without losing my
      // sliders / checkboxes / interchange dropdown selection.
      //
      // The "admin" button at the bottom of the screen is the OTHER
      // entry point — that one DOES reset to the curated admin preset
      // (indirect-only, low-data hubs, Heavenly/Good/Probably/Okay
      // ratings) because it's the intentional "start a testing
      // session" flow.
      setDevExcludeActive((v) => !v)
      return
    }
    // London hexagon + primary-station dots are both "active primary" clicks.
    // Their behaviour is controlled by PRIMARY_CLICK_BEHAVIOUR:
    //   "modal"  → open photo modal (simplified view: title + photos only).
    //   "banner" → open the welcome banner instead.
    // Flip the flag at the top of the file to switch modes; no other edits.
    if (feature.properties?.isLondon) {
      if (PRIMARY_CLICK_BEHAVIOUR === "banner") {
        const pt = mapRef.current?.project([originCoords.lng, originCoords.lat])
        setBannerOrigin(pt ? { x: pt.x, y: pt.y } : null)
        setBannerVisible(true)
        return
      }
      // Synthetic primaries (e.g. the "London" cluster anchor, the
      // synthetic Stratford anchor) have no real station feature to
      // substitute — open the modal directly with the displayName as the
      // title (the StationModal will suppress its " Station" suffix via the
      // isSynthetic prop). Real-station primaries fall through to the feature-
      // substitution path below and take the normal modal flow.
      const primaryDef = getOriginDisplay(primaryOrigin)
      if (primaryDef?.isCluster) {
        const pt = mapRef.current?.project([originCoords.lng, originCoords.lat])
        setSelectedStation({
          name: primaryDef.overlayName ?? primaryDef.displayName,
          lng: originCoords.lng,
          lat: originCoords.lat,
          minutes: 0,
          coordKey: registryGetCoordKey(primaryOrigin) ?? "",
          id: primaryOrigin,
          flickrCount: null,
          screenX: pt?.x ?? window.innerWidth / 2,
          screenY: pt?.y ?? window.innerHeight / 2,
        })
        return
      }
      const primaryFeature = stations?.features.find(
        (f) => (f.properties as { id?: string } | undefined)?.id === primaryOrigin
      )
      if (primaryFeature) {
        feature = primaryFeature as unknown as typeof feature
      } else {
        // Real-station primary with no feature match (shouldn't happen in
        // practice — curated primaries always live in stations.json). Fall
        // back to the banner so something visible opens.
        const pt = mapRef.current?.project([originCoords.lng, originCoords.lat])
        setBannerOrigin(pt ? { x: pt.x, y: pt.y } : null)
        setBannerVisible(true)
        return
      }
    }
    const clickedCoordKey = feature.properties?.coordKey as string | undefined
    const clickedId = feature.properties?.id as string | undefined
    // Scope to the active primary's cluster — a tap on a London cluster
    // member (e.g. Moorgate) when the active primary is Charing Cross is a
    // normal station tap, not a primary-dot tap.
    // getActivePrimaryCoords returns IDs (post Phase 3c), so compare
    // against the feature's id rather than its coordKey.
    const isPrimaryDot =
      !!clickedId && getActivePrimaryCoords(primaryOrigin).includes(clickedId)
    if (isPrimaryDot && PRIMARY_CLICK_BEHAVIOUR === "banner") {
      const pt = mapRef.current?.project([originCoords.lng, originCoords.lat])
      setBannerOrigin(pt ? { x: pt.x, y: pt.y } : null)
      setBannerVisible(true)
      return
    }
    const [lng, lat] = (feature.geometry as unknown as { coordinates: [number, number] }).coordinates
    // Convert geo coords → screen pixels so the modal can animate from this point
    const screenPt = mapRef.current?.project([lng, lat])
    const coordKey = feature.properties?.coordKey as string
    const featureId = (feature.properties?.id as string | undefined) ?? clickedCoordKey ?? ""

    // Look up journey data from the raw GeoJSON (Mapbox flattens nested props)
    const rawFeature = stations?.features.find(
      (f) => `${f.geometry.coordinates[0]},${f.geometry.coordinates[1]}` === coordKey
    )
    const journeys = rawFeature?.properties?.journeys as
      Record<string, JourneyInfo> | undefined
    setHovered(null)
    // Reset ALL two-tap state on modal open. hoveredRef for mouse-hover
    // correctness; touchFirstTapCoord and clickFirstTapCoord (plus their
    // timestamps) so the next tap on any station is treated as a fresh
    // first-tap rather than a lingering second-tap.
    hoveredRef.current = null
    touchFirstTapCoord.current = null
    touchFirstTapAt.current = 0
    clickFirstTapCoord.current = null
    clickFirstTapAt.current = 0
    setSelectedStation({
      name: feature.properties?.name as string,
      lng,
      lat,
      minutes: feature.properties?.londonMinutes as number,
      coordKey,
      id: featureId,
      flickrCount: feature.properties?.flickrCount as number | null ?? null,
      screenX: screenPt?.x ?? window.innerWidth / 2,
      screenY: screenPt?.y ?? window.innerHeight / 2,
      journeys,
    })
  }, [devExcludeActive, setMaxMinutes, setVisibleRatings, stations, primaryOrigin, originCoords, isTouchDevice])

  // Deep-link support: when the URL carries `?station=<station-id>`,
  // jump to that station and open its modal on mount. The param holds
  // a canonical station ID (CRS or 4-char synthetic) post Phase 3 —
  // older bookmarks with coordKey values no longer resolve.
  // Split across two effects so the admin-enable fires immediately on
  // mount (it doesn't need stations data) while the station modal
  // waits for the stations memo to populate. Otherwise ?admin=1 would
  // only take effect after the heavy routing memo finished, which can
  // take 5-10s on a cold page load and is wasted time.
  useEffect(() => {
    // Dev-only deep-link: `?admin=1` flips admin on at mount. Ignored in
    // production so that sharing an admin URL with someone doesn't give
    // them admin-mode UI (the server blocks the writes too, but the UI
    // affordances should also stay hidden on the live site).
    if (process.env.NODE_ENV !== "development") return
    const params = new URLSearchParams(window.location.search)
    if (params.get("admin") !== "1") return
    setDevExcludeActive(true)
    const url = new URL(window.location.href)
    url.searchParams.delete("admin")
    window.history.replaceState(null, "", url.toString())
  }, [])

  useEffect(() => {
    // Use `baseStations` (raw stations.json) rather than the `stations`
    // memo — the latter waits on the heavy routing memo, which can take
    // 5-10s on a cold load. All we need to render the modal is the
    // feature's name/coords/basic props; routing data will populate
    // lazily once the memo catches up.
    if (!baseStations) return
    const params = new URLSearchParams(window.location.search)
    const stationId = params.get("station")
    if (!stationId) return
    // Resolve the ID to its coord via the registry, then look up the
    // feature by coordKey (the property the GeoJSON layer carries).
    const coordKey = registryGetCoordKey(stationId)
    if (!coordKey) return
    const feature = baseStations.features.find(
      (f) => (f.properties?.coordKey as string | undefined) === coordKey,
    )
    if (!feature) return
    const [lng, lat] = (feature.geometry as unknown as { coordinates: [number, number] }).coordinates
    const map = mapRef.current?.getMap()
    if (map) map.jumpTo({ center: [lng, lat], zoom: 13 })
    const screenPt = mapRef.current?.project([lng, lat])
    const journeys = feature.properties?.journeys as Record<string, JourneyInfo> | undefined
    setSelectedStation({
      name: feature.properties?.name as string,
      lng,
      lat,
      minutes: feature.properties?.londonMinutes as number,
      coordKey,
      id: stationId,
      flickrCount: (feature.properties?.flickrCount as number | null) ?? null,
      screenX: screenPt?.x ?? window.innerWidth / 2,
      screenY: screenPt?.y ?? window.innerHeight / 2,
      journeys,
    })
    const url = new URL(window.location.href)
    url.searchParams.delete("station")
    window.history.replaceState(null, "", url.toString())
  }, [baseStations])

  // Called on initial map load and handles icon registration.
  // Also registers a style.load listener for theme swaps.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  function handleMapLoad(e: any) {
    const map = e.target
    // Dev-only: expose the Mapbox map instance on window for browser-
    // console debugging (e.g. window.__ttgMap.getSource('stations')._data).
    if (process.env.NODE_ENV === "development") {
      (window as unknown as { __ttgMap: unknown }).__ttgMap = map
    }
    // Touch zoom and rotate share one handler. disableRotation() keeps pinch-zoom
    // but removes the two-finger twist gesture that rotates the map on touchscreens.
    map.touchZoomRotate.disableRotation()

    // Hide the "Improve this map" link — not required by Mapbox ToS
    // (only the logo + © attributions are). We inject a <style> tag
    // because Tailwind v4 strips unknown class selectors from globals.css.
    const style = document.createElement('style')
    style.textContent = `
      .mapbox-improve-map { display: none !important; }
      /* Attribution strip — transparent background on BOTH desktop and
         mobile (previously .mapboxgl-compact only targeted the mobile
         collapsed variant, so desktop kept its default white pill). */
      .mapboxgl-ctrl-attrib,
      .mapboxgl-ctrl-attrib.mapboxgl-compact {
        background: transparent !important;
      }
      .mapboxgl-ctrl-attrib-button {
        opacity: 0.4;
        background-color: transparent !important;
        background-image: none !important;
        font-size: 16px;
        line-height: 24px;
        text-align: center;
      }
      /* Lay out the bottom-left control group horizontally so the © sits
         to the RIGHT of the Mapbox logo instead of stacking below it.
         Applies on mobile only — the JS below moves the attrib into
         bottom-left only on mobile; on desktop the attrib stays in its
         default bottom-right corner (single element, flex harmless).
         align-items: center keeps the © text vertically aligned with
         the logo's midline; gap gives breathing room between them. */
      .mapboxgl-ctrl-bottom-left {
        display: flex;
        flex-direction: row;
        align-items: center;
        gap: 4px;
      }
      /* Mobile: attrib lives in bottom-left next to the logo (moved
         there by the JS below). 6px bottom margin lifts © clear of
         the screen edge; align-items: center on the parent vertically
         centres it against the logo. */
      .mapboxgl-ctrl-bottom-left .mapboxgl-ctrl-attrib {
        margin: 0 0 6px 0 !important;
      }
      /* Desktop: attrib stays in its default bottom-right corner.
         6px on all sides — tight against the edge, same visual weight
         as the mobile © at the opposite corner. */
      .mapboxgl-ctrl-bottom-right .mapboxgl-ctrl-attrib {
        margin: 6px !important;
      }
    `
    document.head.appendChild(style)

    // Replace the ⓘ icon with a © character.
    const attribBtn = document.querySelector('.mapboxgl-ctrl-attrib-button')
    if (attribBtn) attribBtn.textContent = '©'

    // On MOBILE only, move the © attribution from its default
    // bottom-right slot to the bottom-left, next to the Mapbox logo —
    // that frees bottom-right for the help button (?), which lives at
    // bottom-right on mobile (top-right on desktop). The row layout +
    // vertical-center alignment of the bottom-left container is set
    // via injected CSS above so the © reads as part of the same
    // horizontal strip as the logo.
    //
    // On DESKTOP we leave attrib in its default bottom-right corner —
    // the help button is at top-right so no conflict, and the © is more
    // readable in its own corner there.
    //
    // Mirrors the same breakpoint (md/768px) the help button uses.
    if (window.matchMedia('(max-width: 767.98px)').matches) {
      const attribCtrl = document.querySelector('.mapboxgl-ctrl-bottom-right .mapboxgl-ctrl-attrib')
      const bottomLeftCtrl = document.querySelector('.mapboxgl-ctrl-bottom-left')
      if (attribCtrl && bottomLeftCtrl) bottomLeftCtrl.appendChild(attribCtrl)
    }

    // First `idle` event — all tiles / sources rendered. `once`
    // gives us just the first one so subsequent pans/zooms don't
    // retrigger the loader gate.
    map.once('idle', () => setMapFirstIdle(true))

    // Register custom icon images for station markers.
    registerIcons(map)
    // Force a repaint on the next frame so the symbol layers pick up
    // the freshly-added images on the first render. Without this, on
    // slower first-paint environments (notably Vercel cold loads) the
    // layers sometimes mount before Mapbox has associated the image
    // names with the layer — icons appear invisible until a hover or
    // zoom triggers a repaint.
    map.triggerRepaint()

    // Safety net: if a layer requests an icon image that isn't
    // registered yet (race on first paint), re-register all icons
    // and repaint. Mapbox fires 'styleimagemissing' exactly for this
    // recovery path.
    map.on('styleimagemissing', (e: { id: string }) => {
      // Only our own icon names — ignore anything Mapbox's basemap
      // might ask for.
      if (typeof e.id === 'string' && e.id.startsWith('icon-')) {
        registerIcons(map)
        map.triggerRepaint()
      }
    })

    // Re-register icons on every subsequent style change (dark/light theme swap).
    // The flat styles already have road/label hiding baked in, so no basemap
    // configuration is needed — just icon re-registration.
    map.on('style.load', () => {
      registerIcons(map)
      map.triggerRepaint()
      setMapReady(true)
    })

    // Both mobile and desktop positioning come from computeInitialView()
    // via initialViewState. Calling fitBounds here would set an internal
    // viewport state in react-map-gl that silently overrides the zoom on
    // the first user interaction (pan/pinch).

    setMapReady(true)
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  function registerIcons(map: any) {
    // getColors() reads --primary and --secondary from CSS at runtime so Mapbox
    // stays in sync with the current theme's CSS variables.
    const colors = getColors()
    const dpr = window.devicePixelRatio || 1
    // White stroke in light mode, black in dark — keeps icons readable on both maps.
    // Reads from themeRef so the style.load callback always gets the current theme.
    const stroke = themeRef.current === 'dark' ? '#000000' : '#ffffff'
    // addImage throws if the name already exists, so check first
    const add = (name: string, img: ImageData) => {
      if (map.hasImage(name)) map.removeImage(name)
      map.addImage(name, img, { pixelRatio: dpr })
    }
    // Rating sprites — keys mirror the numeric Rating type.
    //   4 (Sublime)   → star, --primary
    //   3 (Charming)  → triangle-up, --primary
    //   2 (Pleasant)  → hexagon, --primary
    //   1 (Flawed)    → triangle-down, --secondary
    add('icon-rating-4', createRatingIcon('star',          colors.primary,   stroke))
    add('icon-rating-3', createRatingIcon('triangle-up',   colors.primary,   stroke))
    add('icon-rating-2', createRatingIcon('hexagon',       colors.primary,   stroke))
    add('icon-rating-1', createRatingIcon('triangle-down', colors.secondary, stroke))
    add('icon-unrated',  createRatingIcon('circle',        colors.secondary, stroke))
    add('icon-origin',   createRatingIcon('square',        colors.primary,   stroke))
    add('icon-london',   createRatingIcon('square',        colors.primary,   stroke))
    // Small diamond used for the 18 London-terminus reference markers when
    // the Central London synthetic is the active primary. Rendered at ~0.6×
    // icon-size in the layer below so it reads as a compact waypoint.
    add('icon-london-terminus', createRatingIcon('diamond', "#2f6544", stroke))
  }

  // No configureBasemap needed — the flat styles (Outdoors v12-based) have road
  // hiding, label visibility, and zoom ranges baked in at the style level.

  // Declarative icon-registration retry. The imperative path in
  // handleMapLoad (run on Mapbox's `load` event) registers icons
  // synchronously and is the primary code path — but on some slow/
  // cold Vercel loads, a race was observed where symbol layers
  // rendered before Mapbox had associated the freshly-added images
  // with their names, leaving destination markers invisible until a
  // hover/zoom triggered a repaint. Belt-and-braces: React effect
  // that fires whenever `mapReady` flips (post-load) or theme
  // changes, re-registers all icons against the current map style,
  // and forces a repaint. `registerIcons` is idempotent
  // (`hasImage`-checked `removeImage` + `addImage`), so calling it
  // an extra time is cheap and safe.
  useEffect(() => {
    if (!mapReady) return
    const map = mapRef.current?.getMap()
    if (!map) return
    registerIcons(map)
    map.triggerRepaint()
    // `registerIcons` is stable across renders (defined inside the
    // component body, but captures themeRef which we read via .current).
    // Depending on `theme` is the meaningful trigger — a re-run on
    // `mapReady` alone would only matter on the first transition.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mapReady, theme])

  return (
    <div className="relative h-full w-full">
      <FilterPanel
        maxMinutes={maxMinutes}
        onChange={setMaxMinutes}
        minMinutes={minMinutes}
        onMinChange={setMinMinutes}
        showTrails={showTrails}
        onToggleTrails={setShowTrails}
        showRegions={showRegions}
        onToggleRegions={setShowRegions}
        onShowAll={() => {
          // Admin "Show all" — wipe every filter back to the most permissive
          // state so every station passes through. Covers: rating
          // checkboxes (all 6 ticked), all dropdowns to "off", max-time
          // slider to admin ceiling (600 = unlimited), min-time slider
          // to "off" (0), friend origin cleared, station-search field
          // cleared, both direct-only checkboxes cleared.
          setVisibleRatings(new Set(["4", "3", "2", "1", "unrated"]))
          setHideNoTravelTime(false)
          setPrimaryInterchangeFilter("off")
          setPrimaryFeatureFilter("off")
          setSourceFilter("off")
          setMonthFilter("off")
          setMaxMinutes(600)
          setMinMinutes(0)
          setFriendMaxMinutes(600)
          setFriendOriginWithTransition(null)
          setSearchQuery("")
          setPrimaryDirectOnly(false)
          setFriendDirectOnly(false)
        }}
        visibleRatings={visibleRatings}
        onToggleRating={(key: string) => {
          setVisibleRatings((prev) => {
            const next = new Set(prev)
            next.has(key) ? next.delete(key) : next.add(key)
            return next
          })
        }}
        // Right-click on a rating row "solos" it — wipes the set and
        // re-seeds with just that one key. Replacement, not toggle, so
        // the new Set isn't derived from prev.
        onSoloRating={(key: string) => setVisibleRatings(new Set([key]))}
        searchQuery={searchQuery}
        onSearchChange={setSearchQuery}
        adminMode={devExcludeActive}
        bannerVisible={bannerVisible}
        primaryOrigin={primaryOrigin}
        // Pinned primary IDs — always rendered at the top of the
        // dropdown, never evicted. Currently just CLON (Central London).
        pinnedPrimaries={PINNED_PRIMARIES}
        onPrimaryOriginChange={setPrimaryOrigin}
        // The filter-panel labels both roles (primary AND friend) with
        // one callback set — getOriginDisplay resolves any ID, station
        // or cluster, with display fallbacks already applied.
        originDisplayName={(key) => getOriginDisplay(key)?.displayName ?? key}
        originMobileDisplayName={(key) => getOriginDisplay(key)?.mobileDisplayName}
        originMenuName={(key) => getOriginDisplay(key)?.menuName ?? key}
        searchableStations={searchableStations}
        // User picks (prepended via selectCustomPrimary) merged with
        // the curated defaults — picking a default just floats it to
        // the top, the rest stay visible.
        recentPrimaries={[
          ...recentCustomPrimaries,
          ...DEFAULT_RECENT_PRIMARIES.filter((c) => !recentCustomPrimaries.includes(c)),
        ]}
        onCustomPrimarySelect={selectCustomPrimary}
        coordToName={coordToName}
        friendOrigin={friendOrigin}
        // Pinned friend IDs — currently empty; reserved for future.
        pinnedFriends={PINNED_FRIENDS}
        // Same merge pattern as the primary side.
        recentFriends={[
          ...recentCustomFriends,
          ...DEFAULT_RECENT_FRIENDS.filter((c) => !recentCustomFriends.includes(c)),
        ]}
        // Search universe for the friend dropdown — every UK NR station,
        // with hasData=false rows rendered as disabled 'Coming soon'.
        searchableFriendStations={searchableFriendStations}
        onFriendOriginChange={setFriendOriginWithTransition}
        friendMaxMinutes={friendMaxMinutes}
        onFriendMaxMinutesChange={setFriendMaxMinutes}
        onActivateFriend={() => setFriendOriginWithTransition(DEFAULT_FRIEND_ID)}
        onDeactivateFriend={() => setFriendOriginWithTransition(null)}
        primaryDirectOnly={primaryDirectOnly}
        // Toggling "Direct" clears "Indirect" (and vice-versa below) — they're
        // mutually exclusive. Without this, a user could leave both ticked
        // and see zero stations rendered, which reads as a bug rather than
        // a configuration choice.
        onPrimaryDirectOnlyChange={(v) => {
          setPrimaryDirectOnly(v)
          // Direct-only and interchange filter are mutually exclusive:
          // picking direct-only resets the dropdown to "off".
          if (v) setPrimaryInterchangeFilter("off")
        }}
        primaryInterchangeFilter={primaryInterchangeFilter}
        onPrimaryInterchangeFilterChange={(v) => {
          setPrimaryInterchangeFilter(v)
          if (v !== "off") setPrimaryDirectOnly(false)
        }}
        primaryFeatureFilter={primaryFeatureFilter}
        onPrimaryFeatureFilterChange={setPrimaryFeatureFilter}
        sourceFilter={sourceFilter}
        onSourceFilterChange={setSourceFilter}
        monthFilter={monthFilter}
        onMonthFilterChange={setMonthFilter}
        currentMonthLabel={MONTH_LABELS[currentMonth()]}
        currentMonthHighlight={currentMonthHighlight}
        onCurrentMonthHighlightChange={setCurrentMonthHighlight}
        friendDirectOnly={friendDirectOnly}
        onFriendDirectOnlyChange={setFriendDirectOnly}
        hideNoTravelTime={hideNoTravelTime}
        onHideNoTravelTimeChange={setHideNoTravelTime}
      />

      <WelcomeBanner
        ref={welcomeBannerRef}
        open={bannerVisible}
        onDismiss={() => {
          // Session-only dismiss — no persistence, so reloading the page
          // brings the banner back. (Previously this also set
          // setHasSeenWelcome(true) against a persisted localStorage key;
          // that was removed so every fresh load greets the user.)
          setBannerVisible(false)
        }}
        originX={bannerOrigin?.x}
        originY={bannerOrigin?.y}
        summoned={bannerSummoned}
        // Spinner gated on `mapFirstIdle` — flips true on Mapbox's
        // first `idle` event (all tiles + icons rendered). Shows the
        // LogoSpinner while the map is still doing its initial paint
        // and crossfades to the "Find stations" CTA once the map has
        // fully settled. Vercel cold loads are noticeably slower
        // than local dev, so the gate earns its keep there.
        isLoading={!mapFirstIdle}
      />

      {/* Help button — bottom-right on mobile (attribution © is moved to
          the bottom-left to free this slot; avoids overlapping with the
          filter menu in the top-left). Top-right on desktop as the
          rightmost of the pair (theme toggle is shifted to right-14 in
          page.tsx). Clicking re-opens the welcome banner, animating out
          from the button's own position. */}
      {/* Sub-sm (< 640px, true mobile): bottom-right, 7px from the
          bottom + 7px from the right (explicit px because our
          --spacing: 0.6rem mobile override would turn Tailwind's
          default bottom-4/right-4 into ~38px). Also sits BELOW
          overlays via z-10 so photo modals + welcome banner obscure it.
          sm+ (tablet + desktop): top-right, default Tailwind spacing
          (right-4 = 16px), z-50 to match the page's other top-right
          chrome. Switches at the sm breakpoint to match the
          help-button.tsx internals, which also use max-sm: for its
          mobile-only size + opacity overrides. */}
      <div className="absolute bottom-[7px] right-[7px] sm:bottom-auto sm:top-4 sm:right-4 z-10 sm:z-50">
        <HelpButton
          onClick={(origin) => {
            // Toggle: if the banner is already open, a second click on ?
            // dismisses it. Route through the banner's imperative close()
            // so the exit animation (shrink-to-origin on desktop, slide-
            // down on mobile) plays, exactly as if the user had clicked
            // the backdrop or the X.
            if (bannerVisible) {
              welcomeBannerRef.current?.close()
              return
            }
            // Not open — summon it, animating FROM the button's own
            // position so the banner reads as "emerging" from whatever
            // summoned it, not from the London hexagon.
            setBannerOrigin(origin)
            setBannerSummoned(true)
            setBannerVisible(true)
          }}
        />
      </div>

      {/* Admin bar — rendered in two situations:
          1. Local dev (NODE_ENV === "development"), where the visible
             "admin" toggle button below flips devExcludeActive.
          2. Cloud production, but only AFTER the cloud doorway has set
             devExcludeActive = true. The toggle itself stays hidden in
             production (see the inner gate below) so casual visitors
             don't see a stray button — they have to find the doorway.
          process.env.NODE_ENV is inlined at build time, but because the
          condition is now an OR, dead-code elimination keeps the whole
          block in the production bundle. */}
      {(process.env.NODE_ENV === "development" || devExcludeActive) && (
        // z-[60] keeps the admin bar on top of the StationModal dialog
        // (Radix renders its overlay + content at z-50), so the "admin"
        // toggle remains clickable while an overlay is showing — useful
        // for hopping out of admin without closing the current station.
        <div className="absolute bottom-4 left-1/2 z-[60] flex -translate-x-1/2 items-center gap-2">
          {/* The toggle button itself stays dev-only. Cloud users enter
              admin via the doorway, not this button, so showing it in
              production would just be a visible "admin" affordance for
              random visitors. */}
          {process.env.NODE_ENV === "development" && (
          <button
            onClick={() => {
              const next = !devExcludeActive
              setDevExcludeActive(next)
              // Entering admin mode: do NOT touch any filters. The admin
              // may be toggling back and forth mid-task and doesn't want
              // their working state blown away.
              //
              // Leaving admin mode: reset only the filters that either
              //   (a) set an admin-only value the non-admin UI can't undo
              //       — "no RTT data" toggle, min-time-from-London beyond
              //       what the non-admin slider exposes — or
              //   (b) are admin-only dropdowns (Feature, Interchange)
              //       whose current selection wouldn't make sense to a
              //       returning non-admin.
              // Everything else (rating checkboxes, direct-only toggles,
              // friend filters) stays put so the admin's working state
              // carries over.
              if (!next) {
                // Search bar is admin-only — clear it on the way out
                // so a returning non-admin doesn't see a filtered map
                // with no visible search input.
                setSearchQuery("")
                // Re-hide no-travel-time stations on admin exit. The
                // checkbox is admin-only and defaults true, but the
                // admin may have unticked it during their session;
                // a non-admin viewer should always start with them
                // hidden again.
                setHideNoTravelTime(true)
                setMinMinutes(0)
                setPrimaryInterchangeFilter("off")
                setPrimaryFeatureFilter("off")
                setSourceFilter("off")
                // Admin-only month dropdown — clear its selection on
                // admin-off so a returning non-admin doesn't see a
                // filtered map with no visible control.
                setMonthFilter("off")
                if (maxMinutes > 150) setMaxMinutes(150)
              }
            }}
            className={`rounded px-2 py-1 font-mono text-xs text-white transition-colors ${
              devExcludeActive ? "bg-red-600/80" : "bg-black/40 hover:bg-black/60"
            }`}
          >
            {devExcludeActive ? "admin ✕" : "admin"}
          </button>
          )}
          {/* Zoom level indicator — only visible when dev mode is active */}
          {devExcludeActive && (
            <div className="pointer-events-none rounded bg-black/60 px-2 py-1 font-mono text-xs text-white">
              z {zoom.toFixed(1)}
            </div>
          )}
          {/* Cursor coord-key readout — admin-only, sibling of the zoom
              indicator. Shows "lng,lat" rounded to 4 decimals (≈11 m
              precision) — same shape as coordKey strings stored in
              buried-stations.json, station-notes.json etc, so the value
              can be copy-pasted directly into those files. */}
          {devExcludeActive && cursorCoord && (
            <div className={`pointer-events-none rounded px-2 py-1 font-mono text-xs text-white transition-colors ${
              coordCopied ? "bg-green-600/80" : "bg-black/60"
            }`}>
              {cursorCoord.lng.toFixed(2)},{cursorCoord.lat.toFixed(2)}
            </div>
          )}
          {/* RTT status panel trigger — admin-only. Opens a modal
              showing the live origin-routes.json summary (destinations,
              journeys, sampled Saturdays per primary). Auto-refreshes
              every 4s so admins can watch in-flight fetches land. */}
          {devExcludeActive && (
            <button
              onClick={() => setRttStatusOpen(true)}
              className="rounded bg-black/40 px-2 py-1 font-mono text-xs text-white transition-colors hover:bg-black/60"
            >
              rtt
            </button>
          )}
          {/* Edits button — opens the audit dialog showing the local
              outbox (pending/sending/failed admin saves) + the most
              recent admin commits to main. Admin-only. */}
          {devExcludeActive && (
            <button
              onClick={() => setEditsDialogOpen(true)}
              className="rounded bg-black/40 px-2 py-1 font-mono text-xs text-white transition-colors hover:bg-black/60"
            >
              edits
            </button>
          )}
          {/* Design-system mini-app entry — admin-only. Opens the
              isolated /design-system route tree (sibling of the main
              app, not nested under /admin). */}
          {devExcludeActive && (
            <a
              href="/design-system"
              target="_blank"
              rel="noopener noreferrer"
              className="rounded bg-black/40 px-2 py-1 font-mono text-xs text-white transition-colors hover:bg-black/60"
            >
              ds
            </a>
          )}
          {/* Clear-session step is now part of the combined
              "Regenerate" button below — it wipes ttg:* localStorage
              before kicking off the per-primary regen loop. No
              standalone Clear-session button any more. */}
          {/* Regenerate — admin-only. A single button that:
                1. Wipes ttg:* localStorage (formerly the standalone
                   "Clear session" button) so testing starts fresh.
                2. For each slug in PRIMARY_SLUG (Central London +
                   Stratford — the synthetic primaries that have no
                   per-origin journey file and so genuinely need a
                   precomputed routing diff to skip the ~10s live
                   compute):
                   - deletes the existing on-disk snapshot so runtime
                     can't short-circuit to stale data
                   - switches primary to that coord + flags the
                     precompute cache as bypassed
                   - waits for the routing memo to live-compute (~10s)
                   - builds a lean diff from the fresh routedStations
                     (simplified polylines + only fields routing
                     added/changed) + POSTs to /api/dev/save-routing
                3. Reloads as a fresh visitor.
              When to use: after changing routing logic OR upstream
              data (origin-routes.json, excluded stations, …) so the
              cheat-sheet files reflect the new output.
              Concrete primaries (Birmingham, Manchester, …) used to
              be in this loop too, but their precomputed diffs ended
              up byte-identical because the diff filter strips fields
              that already match baseStations — and ensureOriginLoaded
              merges /journeys/<slug>.json into baseStations BEFORE
              the routing memo runs. So those files were always empty
              of primary-specific data. They've been removed. */}
          {devExcludeActive && (
            <Tooltip>
              <TooltipTrigger asChild>
            <button
              onClick={async () => {
                // Dedupe by slug — multiple coords can map to the same slug
                // (e.g. SRA coord + synthetic Stratford midpoint both map to
                // "stratford"). Keep the LAST entry per slug, which favours
                // the synthetic anchor over its real-station member when
                // both exist (the synthetic is what the user actually picks
                // as primary). Plain Record rather than `Map` — the latter
                // is shadowed by the react-map-gl import at the top of this
                // file.
                const slugSeen: Record<string, string> = {}
                for (const [coord, slug] of Object.entries(PRIMARY_SLUG)) {
                  slugSeen[slug] = coord
                }
                const slugEntries: [string, string][] = Object.entries(slugSeen).map(([slug, coord]) => [coord, slug])
                // Auto-clear the friend origin if one is active —
                // precomputed diffs are saved from a clean friend-less
                // state so the file reflects the "visitor lands here
                // with no friend picked" baseline. Friend-merged
                // journeys would otherwise leak into the saved diff
                // through baseStations. Done before the confirm()
                // dialog so if the admin cancels, the friend stays
                // cleared anyway (cheaper than restoring after).
                if (friendOrigin) setFriendOrigin(null)
                if (!confirm(
                  `Regenerate everything?\n\n`
                  + `• Wipes ttg:* localStorage (simulates a fresh visit)\n`
                  + `• Rebuilds all ${slugEntries.length} precomputed routing files\n\n`
                  + `Live compute runs per primary (≈10s each, total ≈${10 * slugEntries.length}s).\n\n`
                  + `Primaries: ${slugEntries.map(([, s]) => s).join(", ")}`,
                )) return
                // Step 0: wipe ttg:* localStorage (what "Clear session"
                // used to do). We DON'T reload here — the regen loop
                // below runs in-page so the admin can keep watching
                // the spinner.
                for (let i = localStorage.length - 1; i >= 0; i--) {
                  const k = localStorage.key(i)
                  if (k && k.startsWith("ttg:")) localStorage.removeItem(k)
                }
                const origPrimary = primaryOrigin
                // ── helpers (hoisted per-click to keep the onclick
                //    self-contained; same logic as before). ──
                const roundCoord = (c: [number, number]): [number, number] =>
                  [Math.round(c[0] * 100000) / 100000, Math.round(c[1] * 100000) / 100000]
                const simplifyPolyline = (
                  coords: [number, number][],
                  tol: number,
                ): [number, number][] => {
                  if (coords.length <= 2) return coords
                  const tolSq = tol * tol
                  const keep = new Uint8Array(coords.length)
                  keep[0] = 1
                  keep[coords.length - 1] = 1
                  const stack: [number, number][] = [[0, coords.length - 1]]
                  while (stack.length > 0) {
                    const [iStart, iEnd] = stack.pop()!
                    if (iEnd - iStart < 2) continue
                    const [x0, y0] = coords[iStart]
                    const [x1, y1] = coords[iEnd]
                    const dx = x1 - x0
                    const dy = y1 - y0
                    const segLenSq = dx * dx + dy * dy
                    let maxDistSq = 0
                    let maxIdx = iStart
                    for (let i = iStart + 1; i < iEnd; i++) {
                      const [px, py] = coords[i]
                      let distSq: number
                      if (segLenSq === 0) {
                        const ex = px - x0, ey = py - y0
                        distSq = ex * ex + ey * ey
                      } else {
                        const t = ((px - x0) * dx + (py - y0) * dy) / segLenSq
                        const tc = Math.max(0, Math.min(1, t))
                        const cx = x0 + tc * dx
                        const cy = y0 + tc * dy
                        const ex = px - cx, ey = py - cy
                        distSq = ex * ex + ey * ey
                      }
                      if (distSq > maxDistSq) { maxDistSq = distSq; maxIdx = i }
                    }
                    if (maxDistSq > tolSq) {
                      keep[maxIdx] = 1
                      stack.push([iStart, maxIdx])
                      stack.push([maxIdx, iEnd])
                    }
                  }
                  const out: [number, number][] = []
                  for (let i = 0; i < coords.length; i++) if (keep[i]) out.push(coords[i])
                  return out
                }
                const buildDiff = (rs: StationCollection, bs: StationCollection) => {
                  const baseByCoord: Record<string, StationFeature> = {}
                  for (const f of bs.features) baseByCoord[f.properties.coordKey as string] = f
                  const diff: Record<string, Record<string, unknown>> = {}
                  for (const rf of rs.features) {
                    const coordKey = rf.properties.coordKey as string
                    const bf = baseByCoord[coordKey]
                    if (!bf) continue
                    const baseProps = bf.properties as Record<string, unknown>
                    const routedProps = rf.properties as Record<string, unknown>
                    const delta: Record<string, unknown> = {}
                    for (const k of Object.keys(routedProps)) {
                      if (k in baseProps && JSON.stringify(baseProps[k]) === JSON.stringify(routedProps[k])) continue
                      if (k === "journeys") {
                        const rj = routedProps[k] as Record<string, unknown> | undefined
                        const bj = (baseProps[k] as Record<string, unknown> | undefined) ?? {}
                        if (!rj) continue
                        const addedOrChanged: Record<string, unknown> = {}
                        for (const origin of Object.keys(rj)) {
                          if (JSON.stringify(rj[origin]) === JSON.stringify(bj[origin])) continue
                          const entry = { ...(rj[origin] as Record<string, unknown>) }
                          const pc = entry.polylineCoords as [number, number][] | undefined
                          if (Array.isArray(pc)) {
                            const simplified = simplifyPolyline(pc, 0.0005)
                            entry.polylineCoords = simplified.map(roundCoord)
                          }
                          addedOrChanged[origin] = entry
                        }
                        if (Object.keys(addedOrChanged).length > 0) delta[k] = addedOrChanged
                        continue
                      }
                      delta[k] = routedProps[k]
                    }
                    if (Object.keys(delta).length > 0) diff[coordKey] = delta
                  }
                  return diff
                }
                // ── main loop ──
                const results: { slug: string; mb?: string; error?: string }[] = []
                for (let i = 0; i < slugEntries.length; i++) {
                  const [coord, slug] = slugEntries[i]
                  // Advertise "working on <slug>" before kicking off
                  // the compute so the button shows the current step.
                  setRegenProgress({ index: i + 1, total: slugEntries.length, slug })
                  // Give React a chance to paint the progress label
                  // BEFORE we start the blocking compute.
                  await new Promise((r) => setTimeout(r, 0))
                  // Step 1: delete the on-disk snapshot so a mid-flow
                  // reload can't accidentally short-circuit to it.
                  await fetch("/api/dev/delete-routing", {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({ key: slug }),
                  }).catch(() => { /* ignore — next step handles missing files */ })
                  // Step 2: bypass the in-memory cache for this slug
                  // and switch primary. Use the raw setter (not
                  // transition) so we can await subsequent ticks
                  // directly. Setting both in the same tick means
                  // React batches into one re-render.
                  setBypassPrecomputeForSlug(slug)
                  setPrimaryOriginRaw(coord)
                  // Step 3: yield so React flushes the re-render and
                  // the memo runs live. The compute blocks the main
                  // thread for ~10s; a setTimeout yield after that
                  // won't fire until the compute completes, so this
                  // effectively awaits the compute.
                  await new Promise((r) => setTimeout(r, 0))
                  // Extra safety margin — give post-commit effects a
                  // chance to sync routedStationsRef.
                  await new Promise((r) => setTimeout(r, 250))
                  const rs = routedStationsRef.current
                  const bs = baseStationsRef.current
                  if (!rs || !bs) { results.push({ slug, error: "data not ready" }); continue }
                  // Step 4: save the lean diff.
                  const diff = buildDiff(rs, bs)
                  const resp = await fetch("/api/dev/save-routing", {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({ key: slug, payload: diff }),
                  })
                  const result = await resp.json()
                  if (!resp.ok) {
                    results.push({ slug, error: result.error ?? `HTTP ${resp.status}` })
                  } else {
                    results.push({ slug, mb: (result.bytes / (1024 * 1024)).toFixed(2) })
                  }
                }
                // Step 5: reload as a brand-new visitor.
                //
                // IMPORTANT ORDERING: alert() first, THEN wipe, THEN
                // navigate. The alert is synchronous/blocking — React
                // batches no state and fires no effects while it's up —
                // so wiping localStorage AFTER it closes guarantees
                // nothing gets re-persisted between wipe and navigate.
                // Previously the wipe happened before the alert, and
                // pending usePersistedState write-backs occasionally
                // squeezed in during the tick after alert dismissed
                // but before reload(), re-populating `ttg:primaryOrigin`
                // with the loop's last per-slug primary.
                //
                // We also swap location.reload() for location.replace("/")
                // so the navigation is a fresh top-level GET. Any
                // pending React effects that would otherwise run on the
                // next tick get torn down immediately by the navigation.
                //
                // We intentionally do NOT call setBypassPrecomputeForSlug,
                // setPrecomputedRoutingByPrimary, or setRegenProgress
                // here — they queue React updates that could trigger
                // persisted-state write-backs, and the full-page
                // navigation makes them pointless anyway.
                const summary = results.map((r) =>
                  r.error ? `  ${r.slug}: FAIL — ${r.error}` : `  ${r.slug}: ${r.mb} MB`,
                ).join("\n")
                alert(`Regen complete:\n${summary}\n\nReloading as a fresh visitor…`)
                for (let i = localStorage.length - 1; i >= 0; i--) {
                  const k = localStorage.key(i)
                  if (k && k.startsWith("ttg:")) localStorage.removeItem(k)
                }
                window.location.replace("/")
              }}
              disabled={regenProgress != null}
              className="rounded bg-black/40 px-2 py-1 font-mono text-xs text-white transition-colors hover:bg-black/60 disabled:opacity-70 disabled:cursor-default inline-flex items-center gap-2"
            >
              {regenProgress ? (
                <>
                  {/* Logo-spinner in its compact form. CSS-animated
                      (compositor layer) so the rod keeps rotating
                      during each primary's 10s main-thread freeze. */}
                  <LogoSpinner className="h-3" label="" />
                  <span>{regenProgress.slug} ({regenProgress.index}/{regenProgress.total})</span>
                </>
              ) : (
                <>regenerate</>
              )}
            </button>
              </TooltipTrigger>
              {/* Use side="bottom" so the tooltip drops down out of the
                  admin bar; the button sits at the top of the viewport. */}
              <TooltipContent side="bottom" className="max-w-sm whitespace-normal text-left leading-snug">
                Rebuilds the precomputed routing snapshots for the
                synthetic primaries (Central London, Stratford) so
                visitors land on instant data instead of paying the
                ~10s live compute. Click this after changing routing
                logic or upstream data (origin-routes.json,
                terminal-matrix.json, excluded stations, …) so the
                cheat-sheet files reflect the new output. Reloads the
                page when done.
              </TooltipContent>
            </Tooltip>
          )}
          {/* "pull all" — bulk-pulls Komoot data (distance, hours,
              uphill, difficulty, name) for every walk that has a
              komootUrl. Sequential client-side loop so progress is
              visible AND each save individually rebuilds derived
              files (the public view stays in sync as the loop runs).
              Total runtime: ~3 min for 60-90 walks at ~2s per fetch. */}
          {devExcludeActive && (
            <Tooltip>
              <TooltipTrigger asChild>
                <button
                  onClick={async () => {
                    if (pullAllProgress) return
                    if (!confirm(
                      "Pull Komoot data for every walk with a komootUrl?\n\n"
                      + "• Updates distance, hours, uphill, difficulty, and name\n"
                      + "• Rebuilds derived files after each save (public view stays in sync)\n"
                      + "• Sequential — takes ~3 minutes for ~80 walks\n\n"
                      + "Walks already in sync are skipped silently."
                    )) return
                    let listResp
                    try {
                      listResp = await fetch("/api/dev/walks-with-komoot")
                    } catch (e) {
                      alert(`Couldn't fetch walks list: ${(e as Error).message}`)
                      return
                    }
                    if (!listResp.ok) {
                      alert(`Couldn't fetch walks list: HTTP ${listResp.status}`)
                      return
                    }
                    type WalkRef = {
                      id: string
                      slug: string
                      komootUrl: string
                      distanceKm: number | null
                      hours: number | null
                      uphillMetres: number | null
                      difficulty: string | null
                      name: string
                    }
                    const list: WalkRef[] = await listResp.json()
                    const updated: string[] = []
                    const unchanged: string[] = []
                    const failed: { id: string; error: string }[] = []
                    // Sequential loop — concurrent PATCHes would race
                    // each other on the file system since they all
                    // rebuild the same derived files.
                    for (let i = 0; i < list.length; i++) {
                      const walk = list[i]
                      setPullAllProgress({ index: i + 1, total: list.length, walkId: walk.id })
                      // Yield so React paints the progress label before
                      // each iteration's network round-trip starts.
                      await new Promise((r) => setTimeout(r, 0))
                      try {
                        // 1. Scrape Komoot.
                        const kr = await fetch("/api/dev/komoot-distance", {
                          method: "POST",
                          headers: { "Content-Type": "application/json" },
                          body: JSON.stringify({ url: walk.komootUrl }),
                        })
                        const kj = await kr.json()
                        if (!kr.ok) throw new Error(kj?.error || `komoot HTTP ${kr.status}`)
                        // 2. Build the PATCH body — only send fields that
                        //    actually changed, so the server's "no-op"
                        //    detection skips unnecessary commits when the
                        //    walk already matches Komoot.
                        const newDistance = Math.round(kj.distanceKm * 100) / 100
                        const newUphill = typeof kj.uphillMetres === "number" ? Math.round(kj.uphillMetres * 100) / 100 : null
                        const body: Record<string, unknown> = {}
                        if (newDistance !== walk.distanceKm) body.distanceKm = newDistance
                        if (kj.hours !== walk.hours) body.hours = kj.hours
                        if (newUphill !== null && newUphill !== walk.uphillMetres) body.uphillMetres = newUphill
                        if (kj.difficulty && kj.difficulty !== walk.difficulty) body.difficulty = kj.difficulty
                        if (kj.name && kj.name !== walk.name) body.name = kj.name
                        if (Object.keys(body).length === 0) {
                          unchanged.push(walk.id)
                          continue
                        }
                        // 3. Save.
                        const sr = await fetch(`/api/dev/walk/${walk.id}`, {
                          method: "PATCH",
                          headers: { "Content-Type": "application/json" },
                          body: JSON.stringify(body),
                        })
                        if (!sr.ok) throw new Error(`save HTTP ${sr.status}: ${await sr.text()}`)
                        updated.push(walk.id)
                      } catch (e) {
                        failed.push({ id: walk.id, error: (e as Error).message })
                      }
                    }
                    setPullAllProgress(null)
                    const failedSummary = failed.length === 0
                      ? ""
                      : `\n\nFailed:\n${failed.map((f) => `  ${f.id}: ${f.error}`).join("\n")}`
                    alert(
                      `Pull all complete:\n`
                      + `  ${updated.length} updated\n`
                      + `  ${unchanged.length} unchanged\n`
                      + `  ${failed.length} failed`
                      + failedSummary,
                    )
                  }}
                  disabled={pullAllProgress != null}
                  className="rounded bg-black/40 px-2 py-1 font-mono text-xs text-white transition-colors hover:bg-black/60 disabled:opacity-70 disabled:cursor-default inline-flex items-center gap-2"
                >
                  {pullAllProgress ? (
                    <>
                      <LogoSpinner className="h-3" label="" />
                      <span>{pullAllProgress.walkId} ({pullAllProgress.index}/{pullAllProgress.total})</span>
                    </>
                  ) : (
                    <>pull all</>
                  )}
                </button>
              </TooltipTrigger>
              <TooltipContent side="bottom" className="max-w-sm whitespace-normal text-left leading-snug">
                Bulk-pulls Komoot data (distance, duration, uphill,
                difficulty, name) for every walk with a komootUrl.
                Sequential — runs through ~80 walks at roughly 2s
                each, so allow ~3 minutes total. Each save rebuilds
                derived files individually so the public view stays
                in sync as the loop runs. Walks already matching
                Komoot are skipped silently.
              </TooltipContent>
            </Tooltip>
          )}
        </div>
      )}

      {/* RTT status modal — mounted always so its Dialog's portal is
          ready, but `open` is driven by the admin-only button above. */}
      <RTTStatusPanel open={rttStatusOpen} onOpenChange={setRttStatusOpen} />

      {/* Admin edits dialog — same pattern: mounted always, gated by
          state. Surfaces the outbox queue and recent commits. */}
      <AdminEditsDialog open={editsDialogOpen} onOpenChange={setEditsDialogOpen} />

      <Map
        mapboxAccessToken={process.env.NEXT_PUBLIC_MAPBOX_TOKEN}
        initialViewState={INITIAL_VIEW}
        mapStyle={mapStyle}
        style={{ width: "100%", height: "100%" }}
        onLoad={handleMapLoad}
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        onZoom={(e: any) => setZoom(e.viewState.zoom)}
        pitchWithRotate={false} // disables 3D tilt on desktop
        dragRotate={false}      // disables rotation (locks north-up)
        touchPitch={false}      // disables 3D tilt on touch devices
        // Bounding box that covers all of mainland Britain (incl. the
        // Highlands and a margin around the Outer Hebrides). Prevents
        // panning into open sea or onto continental Europe.
        // Format: [[west, south], [east, north]] in longitude/latitude
        // west: higher numbers cut more off
        // south: higher numbers cut more off
        // east: lower numbers cut more off
        // north: lower numbers cut more off
        maxBounds={[[-8.0, 49.5], [2.5, 59.0]]}
        // interactiveLayerIds tells Mapbox which layers fire mouse events.
        // Without this, onMouseEnter/[[-4.0, 50.0], [2.0, 54.0]]Leave won't receive feature data.
        // Both layers are interactive so rated stations (icons) are also hoverable/clickable
        interactiveLayerIds={[
          "hovered-station-hit", "station-hit-area", "station-hit-area-buried-zoomed", "station-hit-area-cluster", "london-hit-area", "secret-admin-hit",
          // Terminus diamonds open the same stripped-down station modal
          // that other active-primary cluster members get (title + photos
          // only, no journey info, no Hike button). Both main (zoom 9+)
          // and origin-overlay layers are interactive so the diamond
          // works at every zoom level where it's visible.
          "london-terminus-icon", "london-terminus-origin-icon", "friend-cluster-icon",
          "friend-anchor-icon", "friend-anchor-hit",
          // Always-on cluster diamonds (renders for every visible
          // synthetic, active or not). Click resolves to the parent
          // synthetic's overlay via MEMBER_TO_SYNTHETIC.
          "cluster-diamond-icon",
        ]}
        cursor={hovered ? "pointer" : undefined}
        onMouseMove={handleMouseMove}
        onMouseLeave={handleMouseLeave}
        onClick={handleClick}
        onContextMenu={handleContextMenu}
        ref={mapRef}
        onTouchStart={handleTouchStart}
        onTouchEnd={handleTouchEndOrMove}
        onTouchMove={handleTouchEndOrMove}
      >
        {/* Wait for the map style to finish loading before mounting any Sources/Layers */}
        {mapReady && <>
        {/* Waymarked Trails raster overlay — always mounted so it keeps its position
            in the layer stack (below station labels). Toggled via layout visibility
            instead of conditional rendering, because mounting later would push it on top. */}
        <Source
          id="trails-overlay"
          type="raster"
          tiles={["https://tile.waymarkedtrails.org/hiking/{z}/{x}/{y}.png"]}
          tileSize={256}
        >
          <Layer
            id="trails-raster"
            type="raster"
            layout={{ visibility: showTrails ? "visible" : "none" }}
            paint={{ "raster-opacity": 0.5 }}
          />
        </Source>

        {/* Historic county borders — fade in/out together with the region
            labels (same opacity expression). Lazy-mounted: only appears in
            the tree once the labels have been visible at least once, so
            the 3.5 MB GeoJSON isn't fetched until needed. Mounted BEFORE
            the region-labels source so the dashed lines render UNDER the
            text labels. URL data — Mapbox fetches and caches itself. */}
        {historicCountiesNeeded && (
          <Source id="historic-counties-source" type="geojson" data="/boundaries/historic-counties.geojson">
            <Layer
              id="historic-counties-borders"
              type="line"
              minzoom={6}
              maxzoom={12}
              paint={{
                // Muted neutral grey, matching the county-label colour so
                // borders + labels read as one connected admin layer.
                "line-color": theme === "dark" ? "#a1a1aa" : "#6b7280",
                // Hairline width — borders are background context, not
                // a primary visual element.
                "line-width": 0.75,
                // Dashed pattern signals "administrative boundary" rather
                // than "physical line on the ground". [dashLength, gapLength]
                // in units of line-width.
                "line-dasharray": [2, 2],
                // Cap opacity well below 1 so even at full visibility the
                // borders sit quietly behind the rest of the map content.
                "line-opacity-transition": regionLabelsTransition,
                "line-opacity": regionLabelsOpacity * 0.6,
              }}
            />
          </Source>
        )}

        {/* Admin-only region labels — counties, national parks, AONBs.
            Mounted near the bottom of the layer stack so labels sit BENEATH
            station markers (stations win the visual battle when they
            collide). The Source data is empty when admin mode is off, so the
            layer renders nothing without changing position in the stack.
            Visible roughly zoom 6–12: country-wide overview through to mid-
            detail, dropping out at street-level zooms where they'd fight
            with built-in place labels. */}
        <Source id="region-labels-source" type="geojson" data={regionLabelsCollection}>
          <Layer
            id="region-labels"
            type="symbol"
            minzoom={6}
            maxzoom={12}
            layout={{
              "text-field": ["get", "name"],
              "text-font": ["Open Sans Regular", "Arial Unicode MS Regular"],
              "text-size": 12,
              // Allow all labels to render, even when they collide. With
              // ~150 entries (counties, parks, AONBs across England,
              // Wales, Scotland) Mapbox's default collision detection
              // silently hides labels that sit close to each other —
              // Surrey Hills swallowed by Surrey, Kent Downs by Kent.
              // Showing overlapping labels is the visual cue that tells
              // you which entries to nudge in data/region-labels.json.
              "text-allow-overlap": true,
              "text-ignore-placement": true,
              // Long names like "Suffolk Coast & Heaths" wrap onto a
              // second line at the default text-max-width (10 ems);
              // bump to 20 so they stay on a single line.
              "text-max-width": 20,
            }}
            paint={{
              // Two visual groups, branched on the `category` property:
              //   - counties → muted neutral grey: they're admin context
              //     and should recede behind the map content.
              //   - national parks + landscapes (AONBs) → green: they're
              //     the "nature areas" a hiker actually cares about.
              // ["match", input, label, output, …, defaultOutput] is
              // Mapbox's switch expression — the trailing value is the
              // default and catches both "national-park" and
              // "national-landscape" without listing them twice.
              "text-color": [
                "match",
                ["get", "category"],
                "county", theme === "dark" ? "#a1a1aa" : "#6b7280",
                // green for both park categories
                theme === "dark" ? "#86efac" : "#15803d",
              ],
              // Halo is the soft outline behind the text. Counties keep
              // the existing theme halo (white in light, black in dark) so
              // they stay neutral; parks/landscapes get a tinted-green
              // halo so the text reads as a green glow rather than a
              // green letter on a white shape. Pale green-100 in light,
              // deep green-900 in dark — both contrast the green text
              // enough to keep it legible.
              "text-halo-color": [
                "match",
                ["get", "category"],
                "county", haloColor,
                theme === "dark" ? "#14532d" : "#dcfce7",
              ],
              "text-halo-width": 1.5,
              // Transition spec MUST come before text-opacity in the
              // object — react-map-gl applies paint changes in insertion
              // order, and the transition needs to land before the value
              // change for the new transition to govern the interpolation.
              "text-opacity-transition": regionLabelsTransition,
              "text-opacity": regionLabelsOpacity,
            }}
          />
        </Source>

        {/* Inter-terminal lines — rendered UNDER the journey polyline so
            that if both ever appear at once (shouldn't happen since they
            respond to mutually exclusive hover states), the main journey
            line reads on top. Google-quality tube polylines fanning out
            from a hovered terminus diamond to every other terminus with
            a matrix entry. Pure fun feature — helps visualise how the
            18 London termini relate geographically. */}
        <Source id="inter-terminal-lines" type="geojson" data={interTerminalData}>
          <Layer
            id="inter-terminal-lines-stroke"
            type="line"
            paint={{
              "line-color": "#2f6544",
              "line-width": 1.5,
              "line-opacity": interTerminalOpacity,
            }}
          />
        </Source>

        {/* Journey polyline — shows the rail route from London on hover.
            Always mounted with empty geometry so the opacity can transition.
            The geometry itself grows progressively via coordinate slicing in the
            animation effect above — no need for line-trim-offset. */}
        <Source id="journey-line" type="geojson" data={journeyLine}>
          <Layer
            id="journey-line-stroke"
            type="line"
            paint={{
              "line-color": "#2f6544",
              "line-width": 2.5,
              "line-opacity": journeyOpacity,
            }}
          />
        </Source>

        {/* Friend origin polyline — same as above but for the second origin */}
        <Source id="friend-journey-line" type="geojson" data={friendJourneyLine}>
          <Layer
            id="friend-journey-line-stroke"
            type="line"
            paint={{
              "line-color": "#2f6544",
              "line-width": 2.5,
              "line-opacity": friendJourneyOpacity,
            }}
          />
        </Source>

        {/* Outer radius circle — always mounted so opacity can transition in/out.
            Uses emptyGeoJSON when not hovered to keep the layer alive. */}
        <Source id="outer-radius-circle" type="geojson" data={outerRadiusCircle}>
          <Layer
            id="outer-radius-fill"
            type="fill"
            paint={{
              "fill-color": "#2f6544",
              "fill-opacity": hovered ? 0.03 : 0,
              "fill-opacity-transition": { duration: 300 },
            }}
          />
          <Layer
            id="outer-radius-outline"
            type="line"
            paint={{
              "line-color": "#2f6544",
              "line-width": 1,
              "line-opacity": hovered ? 0.25 : 0,
              "line-opacity-transition": { duration: 300 },
              "line-dasharray": [4, 3],
            }}
          />
        </Source>

        {/* Inner radius circle — fades in on hover via paint transitions */}
        <Source id="radius-circle" type="geojson" data={radiusCircle}>
          <Layer
            id="radius-fill"
            type="fill"
            paint={{
              "fill-color": "#2f6544",
              "fill-opacity": hovered ? 0.07 : 0,
              "fill-opacity-transition": { duration: 300 },
            }}
          />
          <Layer
            id="radius-outline"
            type="line"
            paint={{
              "line-color": "#2f6544",
              "line-width": 1.0,
              "line-opacity": hovered ? 0.3 : 0,
              "line-opacity-transition": { duration: 300 },
              "line-dasharray": [4, 3],
            }}
          />
        </Source>

        {/* Circle labels — only rendered while a station is hovered at zoom 9+.
            Each is a single point at the top of its circle, centered on the dashed line. */}
        {hovered && zoom >= 9 && innerLabelPoint && (
          <Source
            id="inner-label"
            type="geojson"
            data={{ type: "Feature", geometry: { type: "Point", coordinates: [innerLabelPoint.lng, innerLabelPoint.lat] }, properties: {} }}
          >
            <Layer
              id="inner-label-text"
              type="symbol"
              layout={{
                "text-field": "Easy hike",
                "text-size": 10,
                "text-anchor": "bottom", // top edge sits on the circle line, so the label hangs just below it
                "text-font": ["Open Sans Regular", "Arial Unicode MS Regular"],
                "text-allow-overlap": true,
                "text-letter-spacing": 0.08,
              }}
              paint={{
                "text-color": "#2f6544", /* --tree-800 */
              }}
            />
          </Source>
        )}
        {hovered && zoom >= 9 && outerLabelPoint && (
          <Source
            id="outer-label"
            type="geojson"
            data={{ type: "Feature", geometry: { type: "Point", coordinates: [outerLabelPoint.lng, outerLabelPoint.lat] }, properties: {} }}
          >
            <Layer
              id="outer-label-text"
              type="symbol"
              layout={{
                "text-field": "Epic hike",
                "text-size": 10,
                "text-anchor": "bottom",
                "text-font": ["Open Sans Regular", "Arial Unicode MS Regular"],
                "text-allow-overlap": true,
                "text-letter-spacing": 0.08,
              }}
              paint={{
                "text-color": "#2f6544", /* --tree-800 */
              }}
            />
          </Source>
        )}

        {/* The London origin marker (the hexagon at the home station)
            used to live here — before the stations Source. That put
            it BENEATH every station icon, so whenever a custom primary
            was picked (Kentish Town, Farringdon, …) the station's own
            rating icon overlapped the hexagon at the same coord and
            hid it. Moved below the stations Source so it always
            renders on top of station icons. */}

        {/* Cloud admin doorway — invisible tap target at a fixed off-canvas coord.
            Same pattern as the London hit area but with zero visual presence.
            Always mounted so it works in production. */}
        <Source
          id="secret-admin"
          type="geojson"
          data={{
            type: "FeatureCollection",
            features: [{
              type: "Feature",
              geometry: { type: "Point", coordinates: [1.6096, 50.7231] },
              properties: { isSecretAdmin: true },
            }],
          }}
        >
          <Layer
            id="secret-admin-hit"
            type="circle"
            paint={{
              "circle-radius": 16,
              "circle-color": "#000000",
              // Virtually invisible but non-zero so Mapbox treats it as a hit target
              "circle-opacity": 0.005,
            }}
          />
        </Source>

        {/* Cluster anchor lines — dotted line from each diamond to its
            cluster anchor, mounted while a cluster element is hovered.
            Each line "grows" from the diamond toward the anchor over
            ~220ms (rAF lerps the endpoint). Rendered BEFORE the
            cluster-diamonds Source so the lines sit beneath the
            diamond icons. */}
        {clusterAnchorLines && (
          <Source id="cluster-anchor-lines" type="geojson" data={clusterAnchorLines}>
            <Layer
              id="cluster-anchor-lines-layer"
              type="line"
              layout={{
                "line-cap": "round",
                "line-join": "round",
              }}
              paint={{
                // Brand green, matches the hover-glow palette.
                "line-color": "#15803d",
                "line-width": 1.5,
                "line-opacity": 0.7,
                // Dotted look: short on-segment, larger gap (multiples of line-width).
                "line-dasharray": [0.6, 2],
              }}
            />
          </Source>
        )}

        {/* Universal cluster-diamond layer — every member of every
            synthetic cluster (London / Stratford / Birmingham /
            Manchester / Edinburgh / Glasgow / Cardiff / Portsmouth /
            Liverpool), regardless of which primary or friend is
            currently active. Cluster members ALWAYS render as diamonds
            with this layer's zoom rules, overriding the rating /
            unrated / buried treatment they'd otherwise pick up from
            the regular station-* layers. Placed BEFORE the stations
            Source so the diamonds render BENEATH any other icon/label
            in case of overlap. Not in interactiveLayerIds — clicks
            pass through to the station hit-area below. */}
        {visibleClusterDiamondFeatures && (
          <Source id="all-cluster-diamonds" type="geojson" data={visibleClusterDiamondFeatures.icons}>
            {/* Static diamonds — single tier, all diamonds appear at
                zoom 11 regardless of their parent cluster's state.
                When hovered, the diamonds of the hovered cluster are
                filtered out here so the pulsing hovered-synth layer
                below owns their rendering. The London primary marker
                carries coordKey "london" (a sentinel string), so we
                map that back to the actual primaryOrigin coord — which
                is what the diamonds' synthAnchor property holds. */}
            <Layer
              id="cluster-diamond-icon"
              type="symbol"
              minzoom={11}
              filter={
                hovered
                  /* eslint-disable @typescript-eslint/no-explicit-any */
                  ? (["!=", ["get", "synthAnchor"], hovered.coordKey === "london" ? primaryOrigin : hovered.coordKey] as any)
                  : (true as any)
                  /* eslint-enable @typescript-eslint/no-explicit-any */
              }
              layout={{
                "icon-image": "icon-london-terminus",
                "icon-size": 0.6,
                "icon-allow-overlap": true,
                "icon-ignore-placement": true,
              }}
            />
            {/* Hover override — when ANY cluster element is hovered,
                show ALL diamonds of that cluster and pulse them together
                via the rAF loop. Bypasses zoom-tier minzooms while
                hover is active. */}
            {hovered && (
              <Layer
                id="cluster-diamond-icon-hovered-synth"
                type="symbol"
                filter={
                  /* eslint-disable @typescript-eslint/no-explicit-any */
                  ["==", ["get", "synthAnchor"], hovered.coordKey === "london" ? primaryOrigin : hovered.coordKey] as any
                  /* eslint-enable @typescript-eslint/no-explicit-any */
                }
                layout={{
                  "icon-image": "icon-london-terminus",
                  "icon-size": 0.6,
                  "icon-allow-overlap": true,
                  "icon-ignore-placement": true,
                }}
              />
            )}
            <Layer
              id="cluster-diamond-label"
              type="symbol"
              minzoom={12}
              // Hide the static label for the currently-hovered diamond
              // so the dedicated hover label below (which shows at any
              // zoom 9+) doesn't double up with this one at zoom 12+.
              filter={
                hoveredDiamond
                  /* eslint-disable @typescript-eslint/no-explicit-any */
                  ? (["!=", ["get", "coordKey"], hoveredDiamond.coordKey] as any)
                  /* eslint-enable @typescript-eslint/no-explicit-any */
                  : true
              }
              layout={{
                "text-field": ["get", "name"],
                "text-size": 11,
                "text-offset": [0, 1.2],
                "text-anchor": "top",
                "text-font": ["Open Sans Regular", "Arial Unicode MS Regular"],
                "text-allow-overlap": true,
              }}
              paint={{
                "text-color": labelColor,
                "text-halo-color": haloColor,
                "text-halo-width": 1.5,
              }}
            />
          </Source>
        )}

        {/* Hover label for the directly-hovered diamond. The icon
            is handled by cluster-diamond-icon-hovered-synth (all
            diamonds pulse together); this just adds the station name
            so you can tell which diamond you're pointing at. */}
        {hoveredDiamond && (
          <Source
            id="hovered-diamond"
            type="geojson"
            data={{
              type: "Feature",
              geometry: { type: "Point", coordinates: [hoveredDiamond.lng, hoveredDiamond.lat] },
              properties: {
                coordKey: hoveredDiamond.coordKey,
                // Stamp id when known so the admin-mode label can read
                // it via ["get","id"] — matches the main hover label's
                // "ID + name" treatment.
                ...(hoveredDiamond.id ? { id: hoveredDiamond.id } : {}),
                name: hoveredDiamond.name,
              },
            }}
          >
            <Layer
              id="hovered-diamond-label"
              type="symbol"
              minzoom={9}
              layout={{
                "text-field": devExcludeActive
                  ? ["case",
                      ["has", "id"],
                      ["concat", ["get", "id"], " ", ["get", "name"]],
                      ["get", "name"],
                    ]
                  : ["get", "name"],
                "text-size": 11,
                "text-offset": [0, 1.2],
                "text-anchor": "top",
                "text-font": ["Open Sans Regular", "Arial Unicode MS Regular"],
                "text-allow-overlap": true,
              }}
              paint={{
                "text-color": labelColor,
                "text-halo-color": haloColor,
                "text-halo-width": 1.5,
              }}
            />
          </Source>
        )}

        {/* London-terminus reference markers — only when Central London is
            the active primary. Placed BEFORE the stations Source so they
            render beneath every station icon / label (bottom-most z-index —
            the user's rule: "they should not obscure anything"). Neither
            layer is wired into interactiveLayerIds, so clicks pass straight
            through to whatever's underneath. */}
        {getOriginDisplay(primaryOrigin)?.isCluster && londonTerminusFeatures && (
          <>
            <Source id="london-termini-icons" type="geojson" data={londonTerminusFeatures.icons}>
              <Layer
                id="london-terminus-icon"
                type="symbol"
                // Diamonds cluster tightly in central London — only start
                // showing from zoom 9 so they don't form a single
                // unreadable blob at nationwide zoom. Exception for the
                // journey-origin diamond below, which stays visible at
                // all zooms to anchor the polyline.
                minzoom={9}
                layout={{
                  "icon-image": "icon-london-terminus",
                  // ~0.6× of the standard rating-icon size — reads as a
                  // compact waypoint at all zooms without competing with
                  // the hiking-destination icons. Kept the same in admin
                  // and non-admin mode so the termini anchor the map
                  // consistently regardless of which mode you're in.
                  "icon-size": 0.6,
                  // Always render even if another symbol is in the way
                  // (e.g. Mapbox's own base-style station symbols).
                  "icon-allow-overlap": true,
                  "icon-ignore-placement": true,
                }}
              />
              {/* Base labels — all 18 diamonds get a name below them at
                  zoom 12+. Slightly later than the default rated-station
                  labels (zoom 11) so the central-London terminus cluster
                  doesn't spam the map with 15 stacked labels before
                  individual diamonds are properly resolvable. Text-field
                  reads the canonical `name` property we stamped on each
                  feature ("Kings Cross", "St Pancras", etc.). No
                  `text-optional: false` fallback — we want the text to
                  show even if the anchor icon is culled for overlap. */}
              <Layer
                id="london-terminus-icon-label"
                type="symbol"
                minzoom={12}
                // Suppress the diamond's plain label for the currently-
                // hovered terminus — `station-label-hover` (further down,
                // inside the stations Source) renders the full
                // "name + minutes" version at a slightly different
                // text-offset, so without this filter both labels stack
                // and the name visibly doubles.
                /* eslint-disable @typescript-eslint/no-explicit-any */
                filter={(hovered?.coordKey
                  ? ["!=", ["get", "coordKey"], hovered.coordKey]
                  : true) as any}
                /* eslint-enable @typescript-eslint/no-explicit-any */
                layout={{
                  "text-field": ["get", "name"],
                  "text-size": 11,
                  "text-offset": [0, 1.2],
                  "text-anchor": "top",
                  "text-font": ["Open Sans Regular", "Arial Unicode MS Regular"],
                  "text-allow-overlap": true,
                }}
                paint={{
                  "text-color": labelColor,
                  "text-halo-color": haloColor,
                  "text-halo-width": 1.5,
                }}
              />
            </Source>

            {/* Journey-origin overlay — the single diamond matching the
                currently-hovered journey's departure terminus. No
                minzoom gating, so the user sees WHERE their train
                starts even when zoomed out to a country-wide view.
                No label — the user explicitly didn't want terminus
                names appearing on the map; only the diamond itself
                reveals the origin-below-the-zoom-threshold.

                CRITICAL: Source is ALWAYS mounted — toggling data
                rather than conditionally mounting the Source. A
                conditionally-mounted Source re-adds its layers to
                Mapbox's style on every re-mount, which puts them on
                TOP of later-declared sources (like london-marker).
                Always-mounting keeps the layers at a fixed position
                in the style, so they stay beneath london-icon
                regardless of hover churn. */}
            <Source
              id="london-termini-origin"
              type="geojson"
              data={{
                type: "FeatureCollection",
                // Drives off `persistentOriginCoord` (not the live
                // `journeyOriginClusterCoord`) so the diamond stays in the
                // source during the 250ms fade-out on unhover. The coord is
                // cleared at the END of the polyline fade, so the feature
                // vanishes exactly when opacity hits 0.
                //
                // Feature properties mirror the main terminus source's
                // (coordKey + name) so when the user hovers this overlay
                // diamond below zoom 9, handleMouseMove still stamps a
                // coordKey on `hovered` — which the terminus hover-label
                // layer below uses to decide whether to render the name.
                features: persistentOriginCoord
                  ? (() => {
                      const [lng, lat] = persistentOriginCoord
                      const coordKey = `${lng},${lat}`
                      const match = londonTerminusFeatures?.icons.features.find((f) => {
                        const [l, a] = f.geometry.coordinates as [number, number]
                        return l === lng && a === lat
                      })
                      const name = (match?.properties?.name as string | undefined) ?? ""
                      return [{
                        type: "Feature" as const,
                        geometry: { type: "Point" as const, coordinates: persistentOriginCoord },
                        properties: { isTerminus: true, coordKey, name },
                      }]
                    })()
                  : [],
              }}
            >
              <Layer
                id="london-terminus-origin-icon"
                type="symbol"
                layout={{
                  "icon-image": "icon-london-terminus",
                  "icon-size": 0.6,
                  "icon-allow-overlap": true,
                  "icon-ignore-placement": true,
                }}
                paint={{
                  // Track the polyline's opacity curve so the diamond fades
                  // in and out at the same rate. journeyOpacity peaks at 0.5
                  // when a journey is hovered; doubling and clamping to 1
                  // keeps the diamond fully opaque while hovered, then it
                  // decays to 0 in lockstep with the polyline fade-out.
                  "icon-opacity": Math.min(1, journeyOpacity * 2),
                }}
              />
            </Source>
          </>
        )}

        {/* Friend-cluster reference markers — only when the active friend is
            synthetic (e.g. Birmingham). Same diamond + label pattern as the
            primary cluster above, but no journey-origin overlay (friend has
            no animated polyline). */}
        {friendOrigin && getOriginDisplay(friendOrigin)?.isCluster && friendClusterFeatures && (
          <Source id="friend-cluster-icons" type="geojson" data={friendClusterFeatures.icons}>
            <Layer
              id="friend-cluster-icon"
              type="symbol"
              minzoom={9}
              layout={{
                "icon-image": "icon-london-terminus",
                "icon-size": 0.6,
                "icon-allow-overlap": true,
                "icon-ignore-placement": true,
              }}
            />
            <Layer
              id="friend-cluster-icon-label"
              type="symbol"
              minzoom={12}
              layout={{
                "text-field": ["get", "name"],
                "text-size": 11,
                "text-offset": [0, 1.2],
                "text-anchor": "top",
                "text-font": ["Open Sans Regular", "Arial Unicode MS Regular"],
                "text-allow-overlap": true,
              }}
              paint={{
                "text-color": labelColor,
                "text-halo-color": haloColor,
                "text-halo-width": 1.5,
              }}
            />
          </Source>
        )}

        {stationsForMap && (
          <Source id="stations" type="geojson" data={stationsForMap}>
            {/* Admin-only red halo for stations explicitly flagged as
                having an issue. Station-global (no longer scoped to a
                home→dest pair). Sits BENEATH the icon layers so the
                halo reads as a backdrop. Filter matches the `hasIssue=1`
                property set upstream in stationsForMap's map callback.
                Excluded stations that are also flagged get the halo too.
                The outer {devExcludeActive && …} gate keeps the layer
                completely unmounted in non-admin mode. */}
            {devExcludeActive && (
              <Layer
                id="station-issue-halo"
                type="circle"
                filter={["all", ["has", "hasIssue"], ["!", ["has", "isClusterMember"]]]}
                paint={{
                  "circle-color": "#dc2626", // red-600 — matches admin exclude cross
                  "circle-radius": 10,
                  "circle-opacity": 0.55,
                  "circle-stroke-color": "#dc2626",
                  "circle-stroke-width": 0,
                }}
              />
            )}
            {/* Unrated stations — canvas-drawn circle icon. Excludes rated
                stations (they have their own layer) and buried-hidden stations
                (those render via the dedicated zoom-11+ layer below). */}
            <Layer
              id="station-dots"
              type="symbol"
              // Also exclude isFriendOrigin so an unrated friend (e.g.
              // Nottingham — single-station friend, no rating) doesn't
              // get its unrated-circle drawn UNDER the square that the
              // rating-icons layer is drawing for it. Without this the
              // user sees a green circle inside a green square frame.
              filter={["all", ["!", ["has", "rating"]], ["!", ["has", "isBuriedHidden"]], ["!", ["has", "isClusterMember"]], ["!", ["has", "isFriendOrigin"]]]}
              layout={{
                "icon-image": "icon-unrated",
                "icon-allow-overlap": true,
                "icon-ignore-placement": true,
                // ["has", "isNew"/"isLeaving"] picks the right scale; stable icons get base size.
                "icon-size": hovered
                  ? ["case",
                      ["==", ["get", "coordKey"], hovered.coordKey],
                        ["case", ["has", "isNew"], 1.3 * iconScale, ["has", "isLeaving"], 1.3 * leaveScale, 1.3],
                        ["case", ["has", "isNew"], 0.7 * iconScale, ["has", "isLeaving"], 0.7 * leaveScale, 0.7],
                    ]
                  : ["case", ["has", "isNew"], 0.7 * iconScale, ["has", "isLeaving"], 0.7 * leaveScale, 0.7],
              }}
              paint={{
                // Fade opacity in sync with scale so the icon's drop shadow
                // (rendered by the Mapbox Standard basemap) doesn't pop away
                // abruptly when the feature is removed after the shrink animation.
                "icon-opacity": ["case", ["has", "isNew"], iconScale, ["has", "isLeaving"], leaveScale, 1],
              }}
            />
            {/* Buried unrated stations gated to zoom 12+. Renders the
                same circle icon as the regular unrated layer — buried
                just controls *visibility at low zoom*, not the icon
                itself. */}
            <Layer
              id="station-dots-buried-zoomed"
              type="symbol"
              minzoom={12}
              filter={["all", ["has", "isBuriedHidden"], ["!", ["has", "isClusterMember"]]]}
              layout={{
                "icon-image": "icon-unrated",
                "icon-allow-overlap": true,
                "icon-ignore-placement": true,
                "icon-size": 0.7,
              }}
              paint={{
                "icon-opacity": ["case", ["has", "isNew"], iconScale, ["has", "isLeaving"], leaveScale, 1],
              }}
            />
            {/* Rated stations — heart/circle icons indexed by numeric rating. */}
            {mapReady && (
              <Layer
                id="station-rating-icons"
                type="symbol"
                filter={["all", ["any", ["has", "rating"], ["has", "isFriendOrigin"]], ["!", ["has", "isClusterMember"]]]}
                layout={{
                  // Friend origin wins over rating — the active friend
                  // renders as a primary-colour square (same shape as
                  // the primary origin) for consistency.
                  "icon-image": ["case",
                    ["has", "isFriendOrigin"], "icon-origin",
                    ["match", ["get", "rating"],
                      4, "icon-rating-4",
                      3, "icon-rating-3",
                      2, "icon-rating-2",
                      1, "icon-rating-1",
                      "" // fallback
                    ],
                  ],
                  "icon-allow-overlap": true,    // don't hide icons when they overlap labels
                  "icon-ignore-placement": true, // don't let icons block other symbols
                  // Higher value = drawn on top — best ratings render last.
                  "symbol-sort-key": ["match", ["get", "rating"],
                    4, 4,
                    3, 3,
                    2, 2,
                    1, 1,
                    0
                  ],
                  // Slightly larger icon when hovered.
                  "icon-size": hovered
                    ? ["case",
                        ["==", ["get", "coordKey"], hovered.coordKey],
                          ["case", ["has", "isNew"], 1.3 * iconScale, ["has", "isLeaving"], 1.3 * leaveScale, 1.3],
                          ["case", ["has", "isNew"], iconScale, ["has", "isLeaving"], leaveScale, 1],
                      ]
                    : ["case", ["has", "isNew"], iconScale, ["has", "isLeaving"], leaveScale, 1],
                }}
                paint={{
                  // Fade opacity in sync with scale so the icon's drop shadow
                  // (rendered by the Mapbox Standard basemap) doesn't pop away
                  // abruptly when the feature is removed after the shrink animation.
                  "icon-opacity": ["case", ["has", "isNew"], iconScale, ["has", "isLeaving"], leaveScale, 1],
                }}
              />
            )}
            {/* Invisible hit-area layer — covers ALL stations with a larger radius
                than the visual icons, making them easier to hover/click.
                circle-sort-key ensures higher-rated stations render on top, so when
                hit areas overlap, Mapbox returns the best-rated station first. */}
            {/* Hit-area layers — split so that hit-testing matches the icon
                visibility rules. Hovering over a feature whose icon ISN'T
                rendered (because of zoom gating or cluster-member rules)
                should never trigger the hover preview, so each visible-icon
                layer gets its own hit-area sibling with the same minzoom +
                filter. Sort-key + radius + opacity rules are kept in sync
                so the rated-station hit-test still wins ties. */}
            {/* Base hit area — covers stations rendered by station-dots
                and station-rating-icons (i.e. NOT cluster members,
                NOT buried-hidden). Always visible. */}
            <Layer
              id="station-hit-area"
              type="circle"
              filter={["all", ["!", ["has", "isClusterMember"]], ["!", ["has", "isBuriedHidden"]]]}
              layout={{
                "circle-sort-key": ["match", ["get", "rating"],
                  4, 4, 3, 3, 2, 2, 1, 1, 0,
                ],
              }}
              paint={{
                "circle-radius": isMobile ? 16 : 12,
                "circle-color": "#000000",
                "circle-opacity": ["case",
                  ["has", "isLeaving"], 0.005 * leaveScale,
                  ["has", "isNew"],     0.005 * iconScale,
                  0.005,
                ],
              }}
            />
            {/* Buried-hidden hit area — only at zoom 12+, mirroring
                station-dots-buried-zoomed. Below z=12 these features have
                no visible icon, so no hit area either. */}
            <Layer
              id="station-hit-area-buried-zoomed"
              type="circle"
              minzoom={12}
              filter={["all", ["has", "isBuriedHidden"], ["!", ["has", "isClusterMember"]]]}
              layout={{
                "circle-sort-key": -1,
              }}
              paint={{
                "circle-radius": 10,
                "circle-color": "#000000",
                "circle-opacity": ["case",
                  ["has", "isLeaving"], 0.005 * leaveScale,
                  ["has", "isNew"],     0.005 * iconScale,
                  0.005,
                ],
              }}
            />
            {/* Cluster-member hit area — single tier matching the
                unified diamond icon layer at zoom 11. */}
            <Layer
              id="station-hit-area-cluster"
              type="circle"
              minzoom={11}
              filter={["has", "isClusterMember"]}
              paint={{
                "circle-radius": isMobile ? 14 : 10,
                "circle-color": "#000000",
                "circle-opacity": 0.005,
              }}
            />
            {/* Name-only labels — each rating tier appears at a different zoom.
                These layers cap at maxzoom 11 where the full label layer takes over.
                Camera expressions (like step/zoom) can't go inside "format", so we
                use separate layers for name-only vs name+time instead.
                Hidden entirely when searching — the full label layer (minzoom=0 when
                searching) takes over, and having both active at once causes overlapping text. */}
            {!isSearching && ([
              // [layerId, minzoom, filter]
              // Cluster members are excluded from EVERY rating-tier label
              // layer so the diamond layer's own label (zoom 12+) is the
              // only label they get — overrides whatever rating they
              // carry from their underlying walks.
              ["station-labels-highlight", isMobile ? 6 : 7, ["all", ["==", ["get", "rating"], 4], ["!", ["has", "isClusterMember"]]]],
              ["station-labels-rated", 8, ["all", ["==", ["get", "rating"], 3], ["!", ["has", "isClusterMember"]]]],
              // Unverified (rating 2): normally surfaces at zoom 9, but if the
              // station is a placemark, the dedicated placemark layer below
              // takes over at zoom 8 — exclude here to avoid double-rendering.
              ["station-labels-unverified", 9, ["all", ["==", ["get", "rating"], 2], ["!", ["has", "isClusterMember"]], ["!", ["has", "isPlacemark"]]]],
              ["station-labels-not-recommended", 8, ["all", ["==", ["get", "rating"], 1], ["!", ["has", "isClusterMember"]]]],
              // Unrated: normally surfaces at zoom 10, same placemark override
              // as unverified — placemark layer below catches these at zoom 8.
              ["station-labels-unrated", 10, ["all", ["!", ["has", "rating"]], ["!", ["has", "isBuriedHidden"]], ["!", ["has", "isClusterMember"]], ["!", ["has", "isPlacemark"]]]],
              // Placemark: forces label visible at zoom 8+ for stations whose
              // rating would otherwise hide them until zoom 9 (rating 2) or
              // zoom 10 (unrated). Rating 4/3/1 stations already surface by
              // zoom 8 via the layers above, so the filter here only catches
              // rating 2 and unrated — placemark is a no-op for the others.
              ["station-labels-placemark", 8, ["all", ["has", "isPlacemark"], ["any", ["==", ["get", "rating"], 2], ["!", ["has", "rating"]]], ["!", ["has", "isBuriedHidden"]], ["!", ["has", "isClusterMember"]]]],
            ] as const).map(([id, minZ, filter]) => (
              <Layer
                key={id}
                id={id}
                type="symbol"
                minzoom={minZ}
                maxzoom={11}
                /* eslint-disable @typescript-eslint/no-explicit-any */
                filter={(hovered
                  ? ["all", filter, ["!=", ["get", "coordKey"], hovered.coordKey]]
                  : filter) as any}
                /* eslint-enable @typescript-eslint/no-explicit-any */
                layout={{
                  "text-field": ["get", "name"],
                  "text-size": 11,
                  "text-offset": [0, 1.4],
                  "text-anchor": "top",
                  "text-font": ["Open Sans Regular", "Arial Unicode MS Regular"],
                  "text-allow-overlap": true,
                }}
                paint={{
                  "text-color": labelColor,
                  "text-halo-color": haloColor,
                  "text-halo-width": 1.5,
                  // Fade in/out with the icon grow/shrink animation
                  "text-opacity": ["case", ["has", "isNew"], iconScale, ["has", "isLeaving"], leaveScale, 1],
                }}
              />
            ))}
            {/* Full labels (name + travel time) — shown for ALL stations at zoom 11+,
                EXCEPT buried-hidden ones (those get their own layer below, gated to
                zoom 12 so icon + label appear together). When the user is searching
                the buried-hidden exclusion is dropped — finding a buried station via
                search should still surface its label even at low zoom. */}
            {(() => {
              // Always exclude cluster members — they get their own
              // diamond label layer (zoom 12+). Buried-hidden are also
              // excluded outside of search mode (their dedicated layer
              // below covers them at zoom 12+).
              const clusterExclude = ["!", ["has", "isClusterMember"]] as const
              const buriedExclude = ["!", ["has", "isBuriedHidden"]] as const
              const baseFilter = isSearching
                ? clusterExclude
                : ["all", buriedExclude, clusterExclude]
              const fullFilter = hovered
                ? ["all", baseFilter, ["!=", ["get", "coordKey"], hovered.coordKey]]
                : baseFilter
              return (
                <Layer
                  id="station-labels-full"
                  type="symbol"
                  minzoom={isSearching ? 0 : 11}
                  // eslint-disable-next-line @typescript-eslint/no-explicit-any
                  filter={fullFilter as any}
                  layout={{
                    "text-field": [
                      "format",
                      ["get", "name"], { "font-scale": 1 },
                      "\n", {},
                      // Friend-mode separator: "&" with two spaces on either
                      // side. The double-space visually breathes the two
                      // times apart so the label doesn't read as one run-on
                      // figure.
                      ...(friendOrigin
                        ? [["concat", timeExpression("londonMinutes"), "  &  ", timeExpression("friendMinutes")], { "font-scale": 0.8 }]
                        : [timeExpression("londonMinutes"), { "font-scale": 0.8 }]
                      ),
                    ],
                    "text-size": 11,
                    "text-offset": [0, 1.4],
                    "text-anchor": "top",
                    "text-font": ["Open Sans Regular", "Arial Unicode MS Regular"],
                    "text-allow-overlap": true,
                  }}
                  paint={{
                    "text-color": labelColor,
                    "text-halo-color": haloColor,
                    "text-halo-width": 1.5,
                    // Fade in/out with the icon grow/shrink animation
                    "text-opacity": ["case", ["has", "isNew"], iconScale, ["has", "isLeaving"], leaveScale, 1],
                  }}
                />
              )
            })()}
            {/* Sister layer for buried-hidden labels — kicks in at zoom 12 so
                the label appears in lockstep with the buried icon (which has
                its own minzoom: 12 layer). Outside the search-mode override
                because labels for buried-hidden stations are part of the
                regular zoom-12 reveal, not the low-zoom search behaviour. */}
            <Layer
              id="station-labels-buried-zoomed"
              type="symbol"
              minzoom={12}
              // eslint-disable-next-line @typescript-eslint/no-explicit-any
              filter={(hovered
                ? ["all", ["has", "isBuriedHidden"], ["!", ["has", "isClusterMember"]], ["!=", ["get", "coordKey"], hovered.coordKey]]
                : ["all", ["has", "isBuriedHidden"], ["!", ["has", "isClusterMember"]]]) as any}
              layout={{
                "text-field": [
                  "format",
                  ["get", "name"], { "font-scale": 1 },
                  "\n", {},
                  ...(friendOrigin
                    ? [["concat", timeExpression("londonMinutes"), "  &  ", timeExpression("friendMinutes")], { "font-scale": 0.8 }]
                    : [timeExpression("londonMinutes"), { "font-scale": 0.8 }]
                  ),
                ],
                "text-size": 11,
                "text-offset": [0, 1.4],
                "text-anchor": "top",
                "text-font": ["Open Sans Regular", "Arial Unicode MS Regular"],
                "text-allow-overlap": true,
              }}
              paint={{
                "text-color": labelColor,
                "text-halo-color": haloColor,
                "text-halo-width": 1.5,
                "text-opacity": ["case", ["has", "isNew"], iconScale, ["has", "isLeaving"], leaveScale, 1],
              }}
            />
            {/* Friend-origin label — matches the home marker's "always
                visible" treatment. Unlike other station labels
                (which only appear at zoom 11+), the active friend
                station's label is shown at every zoom level so the
                user can always see where their friend is travelling
                from. Filtered to the friend origin's coord and uses
                text-allow-overlap + ignore-placement so Mapbox
                doesn't cull it in favour of other symbols. */}
            {friendOrigin && (
              <Layer
                id="station-label-friend"
                type="symbol"
                /* eslint-disable @typescript-eslint/no-explicit-any */
                filter={["==", ["get", "id"], friendOrigin] as any}
                /* eslint-enable @typescript-eslint/no-explicit-any */
                layout={{
                  // Persistent label — name only. The admin-mode code
                  // prefix is supplied by the dedicated `station-label-
                  // hover` layer when the user actually hovers, so this
                  // persistent label stays uncluttered.
                  "text-field": ["format", ["get", "name"], { "font-scale": 1 }],
                  "text-size": 11,
                  "text-offset": [0, 1.4],
                  "text-anchor": "top",
                  "text-font": ["Open Sans Regular", "Arial Unicode MS Regular"],
                  "text-allow-overlap": true,
                  "text-ignore-placement": true,
                }}
                paint={{
                  "text-color": labelColor,
                  "text-halo-color": haloColor,
                  "text-halo-width": 1.5,
                }}
              />
            )}
            {/* Hover label — shows the full name+time label for the hovered station
                at ANY zoom level, temporarily overriding the normal zoom restrictions. */}
            {hovered && (
              <Layer
                id="station-label-hover"
                type="symbol"
                /* eslint-disable @typescript-eslint/no-explicit-any */
                filter={["==", ["get", "coordKey"], hovered.coordKey] as any}
                /* eslint-enable @typescript-eslint/no-explicit-any */
                layout={{
                  "text-field": hoveredIsFriendOrigin
                    ? ["format", ["get", "name"], { "font-scale": 1 }]
                    : [
                        "format",
                        // In admin mode, prefix the station name with its
                        // canonical station ID — "TRI Tring", "UMYL
                        // Marylebone (Underground)", "CLON London" — for
                        // quick station identification. Every map feature
                        // gets `id` stamped (Phase 3c, in the fetch
                        // handler + virtual-feature builders), so the
                        // case fallback only fires for the rare feature
                        // we couldn't resolve through the registry.
                        devExcludeActive
                          ? ["case",
                              ["has", "id"],
                              ["concat", ["get", "id"], " ", ["get", "name"]],
                              ["get", "name"],
                            ]
                          : ["get", "name"],
                        { "font-scale": 1 },
                        "\n", {},
                        // Time-to-station label at font-scale 0.9 —
                        // slightly smaller than the station name so
                        // it reads as secondary info. Dual-origin
                        // rendering uses "/" (was "&") to read as a
                        // pair of alternatives rather than a
                        // summation.
                        ...(friendOrigin
                          ? [["concat", timeExpression("londonMinutes"), "  &  ", timeExpression("friendMinutes")], { "font-scale": 0.9 }]
                          : [timeExpression("londonMinutes"), { "font-scale": 0.9 }]
                        ),
                      ],
                  "text-size": 11,
                  "text-offset": [0, 1.4],
                  "text-anchor": "top",
                  "text-font": ["Open Sans Regular", "Arial Unicode MS Regular"],
                  "text-allow-overlap": true,
                }}
                paint={{
                  "text-color": labelColor,
                  "text-halo-color": haloColor,
                  "text-halo-width": 1.5,
                }}
              />
            )}
          </Source>
        )}

        {/* Home-station marker — the hexagon + label sitting at the
            currently-selected primary origin coord. Rendered AFTER the
            stations Source so the hexagon draws on top of any station
            icon that might be at the same coord (common for custom
            primaries picked via the search: the hexagon sits exactly
            where that station's rating dot is). Kept BEFORE the
            hovered-station source so the pulse/glow animation on
            hover still draws over the hexagon when the user mouses
            into it. */}
        <Source
          id="london-marker"
          type="geojson"
          data={{
            type: "FeatureCollection",
            features: [{
              type: "Feature",
              geometry: { type: "Point", coordinates: [originCoords.lng, originCoords.lat] },
              properties: { isLondon: true, coordKey: "london" },
            }],
          }}
        >
          {mapReady && (
            <Layer
              id="london-icon"
              type="symbol"
              layout={{
                "icon-image": "icon-london",
                "icon-allow-overlap": true,
                "icon-ignore-placement": true,
                "icon-size": hovered?.coordKey === "london" ? 1.3 : 1,
              }}
            />
          )}
          {/* Label — always visible beneath the hexagon, showing the current
              primary origin name plus a "time to escape" sublabel. Falls back to
              canonicalName if displayName isn't set, and finally to the raw coord key. */}
          {mapReady && (() => {
            // Primary's display name. Map label uses the full displayName
            // (even on mobile). The mobileDisplayName "super-shorthand"
            // is intentionally only applied to the filter-panel dropdown
            // trigger where horizontal space is tight — the map has more
            // room and users benefit from seeing the full name of their
            // origin. For a custom primary (NR station picked via the
            // search), PRIMARY_ORIGINS has no entry → fall back to
            // coordToName (the station's own name).
            const displayName = getOriginDisplay(primaryOrigin)?.displayName
              ?? getOriginDisplay(primaryOrigin)?.canonicalName
              ?? coordToName[primaryOrigin]
              ?? primaryOrigin
            // Admin mode prefixes with the canonical station ID — but
            // ONLY while this hexagon is being hovered, matching the
            // hover-only behaviour of every other admin code prefix on
            // the map. Hover handler stamps hovered.coordKey = "london"
            // when the primary hexagon is the hover target.
            const isHovered = hovered?.coordKey === "london"
            const labelText = devExcludeActive && isHovered
              ? `${primaryOrigin} ${displayName}`
              : displayName
            return (
            <Layer
              id="london-label"
              type="symbol"
              layout={{
                "text-field": [
                  "format",
                  labelText, { "font-scale": 1 },
                  "\n", {},
                  "time to escape", { "font-scale": 0.8 },
                ],
                "text-size": 11,
                "text-offset": [0, 1.4],
                "text-anchor": "top",
                "text-font": ["Open Sans Regular", "Arial Unicode MS Regular"],
                // allow-overlap: this label renders even if it collides
                // with one placed earlier. ignore-placement: this label
                // doesn't "steal" a slot from others, and crucially
                // is NOT itself culled by earlier labels that already
                // claimed the area — Charing Cross's diamond label
                // sits 300m east and was occasionally demoting the
                // "London" label visually at mid-zooms before this
                // setting was explicit.
                "text-allow-overlap": true,
                "text-ignore-placement": true,
              }}
              paint={{
                "text-color": labelColor,
                "text-halo-color": haloColor,
                "text-halo-width": 1.5,
              }}
            />
            )
          })()}
          {/* Invisible hit area for click detection */}
          <Layer
            id="london-hit-area"
            type="circle"
            paint={{
              "circle-radius": 16,
              "circle-color": "#000000",
              "circle-opacity": 0.01,
            }}
          />
        </Source>

        {/* Friend-anchor marker — same hexagon + label treatment as the
            primary's london-marker, but pinned to the active friend's
            synthetic centroid. Only mounts when a synthetic friend is
            selected; non-synthetic friends already render their own
            primary-colour square via the rating-icons layer (the friend's
            real station coord matches a baseStations feature, which then
            gets isFriendOrigin=1 stamped on it). The synthetic centroid
            doesn't match any real station, so without this layer the
            friend would have no visible anchor on the map. */}
        {friendOrigin && getOriginDisplay(friendOrigin)?.isCluster && (() => {
          // friendOrigin is a station ID; resolve to its centroid coord
          // via the synthetic-coord lookup before drawing the anchor.
          const friendCoord = SYNTHETIC_COORDS[friendOrigin] ?? registryGetCoordKey(friendOrigin) ?? ""
          const [fLngStr, fLatStr] = friendCoord.split(",")
          const fLng = parseFloat(fLngStr)
          const fLat = parseFloat(fLatStr)
          if (!Number.isFinite(fLng) || !Number.isFinite(fLat)) return null
          return (
            <Source
              id="friend-marker"
              type="geojson"
              data={{
                type: "FeatureCollection",
                features: [{
                  type: "Feature",
                  geometry: { type: "Point", coordinates: [fLng, fLat] },
                  // isFriendOrigin = 1 mirrors the property used by the
                  // standard friend rendering, but the source it lives on is
                  // separate — drives this layer alone, not the stations
                  // rating-icons layer.
                  properties: { isFriendOrigin: 1, id: friendOrigin, coordKey: friendCoord },
                }],
              }}
            >
              {mapReady && (
                <Layer
                  id="friend-anchor-icon"
                  type="symbol"
                  layout={{
                    "icon-image": "icon-origin",
                    "icon-allow-overlap": true,
                    "icon-ignore-placement": true,
                  }}
                />
              )}
              {mapReady && (
                <Layer
                  id="friend-anchor-label"
                  type="symbol"
                  layout={{
                    "text-field": (() => {
                      const name = getOriginDisplay(friendOrigin)?.displayName ?? ""
                      // Code prefix only while the friend hexagon is
                      // hovered. friendCoord is the centroid the hover
                      // handler stamps onto hovered.coordKey for this
                      // anchor.
                      const isHovered = hovered?.coordKey === friendCoord
                      return devExcludeActive && isHovered
                        ? `${friendOrigin} ${name}`
                        : name
                    })(),
                    "text-size": 11,
                    "text-offset": [0, 1.4],
                    "text-anchor": "top",
                    "text-font": ["Open Sans Regular", "Arial Unicode MS Regular"],
                    "text-allow-overlap": true,
                    "text-ignore-placement": true,
                  }}
                  paint={{
                    "text-color": labelColor,
                    "text-halo-color": haloColor,
                    "text-halo-width": 1.5,
                  }}
                />
              )}
              {/* Invisible hit area for click detection — same pattern as
                  the london-marker. Without this the icon-symbol layer
                  alone has tiny pixel-accurate hit detection. */}
              <Layer
                id="friend-anchor-hit"
                type="circle"
                paint={{
                  "circle-radius": 16,
                  "circle-color": "#000000",
                  "circle-opacity": 0.01,
                }}
              />
            </Source>
          )
        })()}

        {/* Hovered-station decorations (mobile two-tap "preview" state).
            - A soft green glow that animates via setPaintProperty (see the
              useEffect above) — visual indicator that the station is armed for
              the next tap to open.
            - A larger, top-layer hit area so the second tap lands reliably
              even if the user's finger drifts slightly or the station sits
              under a cluster of neighbours. Rendered AFTER all other station
              layers, so it's on top of them in the tap-priority order. */}
        {hovered && (
          <Source
            id="hovered-station"
            type="geojson"
            data={{
              type: "Feature",
              geometry: { type: "Point", coordinates: [hovered.lng, hovered.lat] },
              // Carry the coordKey through so tap handlers (which read
              // feature.properties.coordKey) see the hovered-station-hit as
              // the hovered station and open the right modal on second tap.
              // iconImage is passed through as a feature property so the
              // hovered-station-icon Layer can read it via ["get", "iconImage"]
              // — more robust than binding icon-image directly to hovered.iconImage
              // via the layout prop, which was occasionally not picking up the
              // change when only hovered.iconImage differed between renders.
              properties: { coordKey: hovered.coordKey, iconImage: hovered.iconImage },
            }}
          >
            {/* beforeId pushes this layer BENEATH the station icons so the
                halo sits outside/around the icon rather than tinting the
                icon itself from on top. station-dots always exists (even
                when its filter returns no features) so this reference is
                stable across admin/non-admin modes. */}
            <Layer
              id="hovered-station-glow"
              type="circle"
              beforeId="station-dots"
              paint={{
                "circle-radius": 23,            // overwritten by the rAF loop
                "circle-color": "#22c55e",      // Tailwind green-500
                "circle-blur": 2,               // softer diffusion → reads as a glow, not a dot
                "circle-opacity": 0.3,          // overwritten by the rAF loop
                "circle-pitch-alignment": "map",
              }}
            />
            {/* Pulsing icon overlay for the hovered station. Renders the same
                icon image as the base layer (resolved to hovered.iconImage at
                set-hover time) in a dedicated single-feature layer so we can
                animate its icon-size at 60fps without triggering Mapbox's
                symbol-layout on every station. The pulse ALWAYS stays ≥ 1.3×
                so it fully covers the static base icon underneath (which also
                renders the hovered station at 1.3×) — no peek-through. */}
            <Layer
              id="hovered-station-icon"
              type="symbol"
              layout={{
                // Read the icon image from the source feature's properties via
                // expression. This gives us two benefits:
                //   1. When hovered changes (different station, different icon),
                //      react-map-gl's source.setData triggers a re-evaluation —
                //      Mapbox is VERY reliable about that, less so about
                //      detecting layout-prop scalar changes.
                //   2. Layer spec stays stable across renders, so Mapbox never
                //      sees a "removed/re-added layer" scenario that could
                //      leave the icon showing a stale image for a frame.
                "icon-image": ["coalesce", ["get", "iconImage"], "icon-unrated"],
                "icon-allow-overlap": true,
                "icon-ignore-placement": true,
                "icon-size": 1.3,               // overwritten by the rAF loop
              }}
            />
            <Layer
              id="hovered-station-hit"
              type="circle"
              paint={{
                // Desktop: 12px — matches the visible pulsing-icon radius so
                // the hit area doesn't extend beyond what the user sees pulsing.
                // Mobile: 4x the desktop default (64px) — once a station is
                // already in the pulsing "preview" state, we want a huge,
                // unmissable tap target so the second tap reliably opens the
                // modal even if the finger drifts beyond the visible icon.
                // This layer is rendered LAST in the Mapbox layer stack,
                // which combined with the handleTouchStart/handleClick feature
                // preference (see below) means the hovered station always
                // wins taps within this enlarged zone — regardless of
                // whether a neighbouring station is highlight/verified/etc.
                "circle-radius": isMobile ? 64 : 12,
                "circle-color": "transparent",
                "circle-opacity": 0.01,
              }}
            />
          </Source>
        )}

        {/* Station modal — opens when a dot is clicked, dismissed by clicking overlay.
            Uses displayStation (ref-backed) so the component stays mounted during the
            exit animation even after selectedStation is set to null. */}
        {displayStation && (
          <StationModal
            open={!!selectedStation}
            onClose={() => {
              setSelectedStation(null)
              // Reset ALL two-tap state on ANY modal close (X, backdrop,
              // Escape). Both touch-based (touchstart) AND click-based
              // layers need clearing so the next tap on any station is
              // treated as a fresh first-tap. Without this, a closing path
              // that skips handleClick could leave a coord ref pointing at
              // the just-opened station, turning the next tap into a stale
              // "second tap".
              touchFirstTapCoord.current = null
              touchFirstTapAt.current = 0
              clickFirstTapCoord.current = null
              clickFirstTapAt.current = 0
              hoveredRef.current = null
              longPressFired.current = false
            }}
            lat={displayStation.lat}
            lng={displayStation.lng}
            // Title resolution:
            //   1. Click on the primary coord itself of a SYNTHETIC primary
            //      (Central London) → prefer overlayName (an explicit
            //      modal-only override, e.g. "London termini"),
            //      falling back to menuName, then to displayStation.name.
            //      There's no real station at the synthetic coord.
            //   2. Any other click → prefer the london-terminals.json
            //      canonical name if this station matches one. Rewrites
            //      OSM-raw names like "London King's Cross" /
            //      "London St. Pancras International" / "London Liverpool
            //      Street" to their clean forms ("Kings Cross" / "St Pancras"
            //      / "Liverpool Street"). Non-terminus stations pass through
            //      unchanged.
            // The isSynthetic prop below decides whether " Station" is
            // suffixed — Case 1 strips it (place, not a station); Case 2
            // keeps it for all cluster members so "Kings Cross" reads as
            // "Kings Cross Station" in the modal.
            stationName={
              displayStation.id === primaryOrigin &&
              !!getOriginDisplay(primaryOrigin)?.isCluster
                ? (getOriginDisplay(primaryOrigin)?.overlayName
                    ?? getOriginDisplay(primaryOrigin)?.menuName
                    ?? displayStation.name)
                // Shared helper resolves "London Waterloo East" → "Waterloo
                // East" and similar canonicalisations via matchTerminal.
                : cleanTerminusLabel(displayStation.name)
            }
            minutes={displayStation.minutes}
            flickrCount={displayStation.flickrCount}
            originX={displayStation.screenX}
            originY={displayStation.screenY}
            devMode={devExcludeActive}
            adminMode={devExcludeActive}
            // The canonical station ID for display + predicates. For
            // real NR stations this is the CRS; for non-NR (Underground/
            // DLR) and cluster anchors it's the canonical synthetic ID
            // (UMYL, CLON, CSTR, …). The modal title prefix in admin
            // mode uses this directly.
            stationCrs={displayStation.id || undefined}
            // Real 3-char CRS for the WalksAdminPanel's "new walk"
            // default station. For real NR stations this matches
            // stationCrs above; for cluster anchors it falls back to
            // the first member that has a real CRS (so the picker
            // defaults to a sensible NR station, not "CLON" which has
            // no walks). For non-NR standalone stations there's no
            // real CRS — undefined keeps the panel unmounted.
            walkDefaultCrs={(() => {
              const own = stations?.features.find(
                (x) => (x.properties as { coordKey?: string } | undefined)?.coordKey === displayStation.coordKey,
              )?.properties?.["ref:crs"] as string | undefined
              if (own) return own
              if (ALL_SYNTHETIC_IDS.has(displayStation.id)) {
                const memberIds = ALL_CLUSTERS[displayStation.id]?.members ?? []
                for (const m of memberIds) {
                  const f = baseStations?.features.find(
                    (bf) => (bf.properties as { id?: string }).id === m,
                  )
                  const crs = f?.properties?.["ref:crs"] as string | undefined
                  if (crs) return crs
                }
              }
              return undefined
            })()}
            isLondonHome={primaryOrigin === "CLON"}
            {...(() => {
              // Direct lookup — works for non-synthetic stations.
              let f = baseStations?.features.find(
                (x) => `${x.geometry.coordinates[0]},${x.geometry.coordinates[1]}` === displayStation.coordKey,
              )
              // Synthetic clusters have no feature at the anchor coord, so
              // borrow location info from the first member that has it.
              if (!f?.properties?.county && ALL_SYNTHETIC_IDS.has(displayStation.id)) {
                const memberIds = ALL_CLUSTERS[displayStation.id]?.members ?? []
                for (const m of memberIds) {
                  const memberF = baseStations?.features.find(
                    (x) => (x.properties as { id?: string }).id === m,
                  )
                  if (memberF?.properties?.county) {
                    f = memberF
                    break
                  }
                }
              }
              return {
                county: f?.properties?.county as string | undefined,
                historicCounty: f?.properties?.historicCounty as string | undefined,
                country: f?.properties?.country as string | undefined,
                protectedArea: f?.properties?.protectedArea as string | undefined,
                protectedAreaType: f?.properties?.protectedAreaType as string | undefined,
              }
            })()}
            hasIssue={issueStations.has(resolveCoordKey(displayStation.coordKey) ?? "")}
            onToggleIssue={(hasIssue: boolean) => handleToggleIssue(
              resolveCoordKey(displayStation.coordKey) ?? "",
              displayStation.name,
              hasIssue,
            )}
            isPlacemark={placemarkStations.has(resolveCoordKey(displayStation.coordKey) ?? "")}
            onTogglePlacemark={(isPlacemark: boolean) => handleTogglePlacemark(
              resolveCoordKey(displayStation.coordKey) ?? "",
              displayStation.name,
              isPlacemark,
            )}
            currentRating={ratings[displayStation.coordKey] ?? null}
            onBury={() => handleToggleBuried(displayStation.name, displayStation.coordKey)}
            isBuried={buriedStations.has(displayStation.coordKey)}
            approvedPhotos={curations[displayStation.coordKey]?.approved ?? []}
            pinnedIds={new Set(curations[displayStation.coordKey]?.pinnedIds ?? [])}
            onApprovePhoto={(photo) => handleApprovePhoto(displayStation.coordKey, displayStation.name, photo)}
            onApprovePhotoAtTop={(photo) => handleApproveAtTop(displayStation.coordKey, displayStation.name, photo)}
            onUnapprovePhoto={(photoId) => handleUnapprovePhoto(displayStation.coordKey, displayStation.name, photoId)}
            onPinPhoto={(photo) => handlePinPhoto(displayStation.coordKey, displayStation.name, photo)}
            onUnpinPhoto={(photoId) => handleUnpinPhoto(displayStation.coordKey, displayStation.name, photoId)}
            onMovePhoto={(photoId, direction) => handleMovePhoto(displayStation.coordKey, displayStation.name, photoId, direction)}
            // stationNotes is keyed by station ID (CRS or 4-char synthetic) post Phase 2b.
            // The modal can open for either a real station or a cluster anchor —
            // resolveCoordKey handles both via the registry.
            publicNote={stationNotes[resolveCoordKey(displayStation.coordKey) ?? ""]?.publicNote ?? ""}
            privateNote={stationNotes[resolveCoordKey(displayStation.coordKey) ?? ""]?.privateNote ?? ""}
            adminWalksAll={stationNotes[resolveCoordKey(displayStation.coordKey) ?? ""]?.adminWalksAll ?? ""}
            publicWalksS2S={stationNotes[resolveCoordKey(displayStation.coordKey) ?? ""]?.publicWalksS2S ?? ""}
            publicWalksS2SEnding={stationNotes[resolveCoordKey(displayStation.coordKey) ?? ""]?.publicWalksS2SEnding ?? ""}
            publicWalksCircular={stationNotes[resolveCoordKey(displayStation.coordKey) ?? ""]?.publicWalksCircular ?? ""}
            onSaveNotes={(pub, priv) => handleSaveNotes(displayStation.coordKey, displayStation.name, pub, priv)}
            onWalkSaved={refreshStationDerivedData}
            defaultAlgo={
              // Synthetic anchors and any of their cluster members (London,
              // Stratford, Birmingham, Manchester, etc.) plus buried stations
              // default to "station"; everything else defaults to "landscapes".
              syntheticClusterCoords.has(displayStation.id) || buriedStations.has(displayStation.coordKey)
                ? "station"
                : "landscapes"
            }
            customSettings={flickrSettings[displayStation.coordKey]?.custom ?? null}
            onSaveCustom={(custom) => handleSaveCustom(displayStation.coordKey, displayStation.name, custom)}
            presets={presets}
            onSavePreset={handleSavePreset}
            // StationModal's internal API is name-based (it calls getEffectiveJourney
            // which expects a name, and prints "X minutes from <name>"). Translate
            // coord-keyed state → names at the boundary. journeys are re-keyed too.
            journeys={modalJourneys}
            friendOrigin={friendOrigin ? (getOriginDisplay(friendOrigin)?.canonicalName ?? null) : null}
            // For a curated primary (Farringdon, KX, CHX, …) this is the
            // canonicalName which matches a key in modalJourneys. For a
            // CUSTOM primary picked via the dropdown search (e.g. Kentish
            // Town) there's no PRIMARY_ORIGINS entry and no pre-fetched
            // journey, so we pass the station's own name from coordToName.
            // The modal's journey lookup won't find a match and will fall
            // through to the "from {primaryOrigin}" fallback copy.
            primaryOrigin={
              getOriginDisplay(primaryOrigin)?.canonicalName
                ?? coordToName[primaryOrigin]
                ?? primaryOrigin
            }
            isFriendOrigin={!!friendOrigin && displayStation.id === friendOrigin}
            // Active-primary coords (the primary itself + its cluster members)
            // get the same stripped-down modal as friend stations — title +
            // photos only, no journey info or Hike button. Scoped to the
            // ACTIVE primary so a click on, say, Moorgate while primary is
            // Charing Cross opens the normal modal (Moorgate is only a
            // cluster member of the London synthetic primary).
            isPrimaryOrigin={getActivePrimaryCoords(primaryOrigin).includes(displayStation.id)}
            // Suppress the " Station" suffix ONLY for the synthetic-primary
            // coord itself (Central London hexagon) — the title there is a
            // place name, not a station. Clicks on cluster members (KX NR,
            // St Pancras, Liverpool Street, Waterloo East, etc.) get the
            // suffix so they read as "Kings Cross Station", "St Pancras
            // Station", and so on. Earlier we suppressed for any cluster
            // primary, which produced "Kings Cross, St Pancras, & Euston"
            // as the title — too verbose for a single-station click.
            isSynthetic={ALL_SYNTHETIC_IDS.has(displayStation.id)}
            // Cluster header — populated for ANY synthetic anchor (active
            // primary, active friend, OR a non-active synthetic that the
            // user clicked on). Resolves member coords → station names
            // via baseStations. Tube-only entries are skipped (Underground
            // entrances for Kings X / Euston are routing aliases, not
            // user-facing cluster members).
            // Plain cluster displayName (e.g. "London", "Birmingham") — used
            // by the modal's cluster description copy. Distinct from the
            // modal title above, which may use `overlayName` ("London
            // termini") for a more polished header.
            clusterDisplayName={ALL_CLUSTERS[displayStation.id]?.displayName}
            clusterMemberNames={(() => {
              if (!ALL_SYNTHETIC_IDS.has(displayStation.id)) return undefined
              // Lookup via the unified cluster registry so destination-
              // only clusters (no origin flags) resolve their members
              // the same way primary/friend clusters do.
              const memberIds = ALL_CLUSTERS[displayStation.id]?.members ?? []
              const names: string[] = []
              const seen = new Set<string>()
              for (const m of memberIds) {
                const f = baseStations?.features.find(
                  (bf) => (bf.properties as { id?: string }).id === m,
                )
                const network = (f?.properties?.network as string | undefined) ?? ""
                const isNR = /National Rail|Elizabeth line/.test(network)
                if (!isNR) continue
                const raw = f?.properties?.name as string | undefined
                const cleaned = cleanTerminusLabel(raw)
                if (!cleaned || seen.has(cleaned)) continue
                seen.add(cleaned)
                names.push(cleaned)
              }
              return names.length > 0 ? names : undefined
            })()}
            // Cluster members with coords + names — drives the
            // "Hikes from stations ▾" dropdown. Same rules as
            // clusterMemberNames (NR-only, dedup) but kept as
            // {name, lat, lng} so the dropdown items can build
            // per-member Komoot URLs.
            clusterMembers={(() => {
              if (!ALL_SYNTHETIC_IDS.has(displayStation.id)) return undefined
              const memberIds = ALL_CLUSTERS[displayStation.id]?.members ?? []
              const out: { name: string; lat: number; lng: number }[] = []
              const seen = new Set<string>()
              for (const m of memberIds) {
                const f = baseStations?.features.find(
                  (bf) => (bf.properties as { id?: string }).id === m,
                )
                const network = (f?.properties?.network as string | undefined) ?? ""
                const isNR = /National Rail|Elizabeth line/.test(network)
                if (!isNR) continue
                const raw = f?.properties?.name as string | undefined
                const cleaned = cleanTerminusLabel(raw)
                if (!cleaned || seen.has(cleaned)) continue
                seen.add(cleaned)
                const [lng, lat] = f!.geometry.coordinates as [number, number]
                out.push({ name: cleaned, lat, lng })
              }
              return out.length > 0 ? out : undefined
            })()}
            // Synthetic cluster member CRS codes — drives WalksAdminPanel
            // multi-station fetch. Each CRS contributes its walks to the
            // panel; the synthetic itself has no CRS.
            clusterMemberCrsCodes={(() => {
              if (!ALL_SYNTHETIC_IDS.has(displayStation.id)) return undefined
              const memberIds = ALL_CLUSTERS[displayStation.id]?.members ?? []
              const out: string[] = []
              for (const m of memberIds) {
                // For real NR stations the canonical ID IS the CRS, so
                // we can return 3-char IDs directly. 4-char synthetic
                // member IDs (Underground entrances etc.) are skipped
                // — they have no walks.
                if (m.length === 3) out.push(m)
              }
              return out.length > 0 ? out : undefined
            })()}
            // Top-ranked cluster member name per origin — when the
            // destination is a synthetic, the journey paragraph reads
            // "Birmingham New Street is 1h19 from Euston" so the user
            // knows which member station the time is to. Sourced from
            // the syntheticPrimaryMemberName / syntheticFriendMemberName
            // properties stamped on the virtual synthetic feature in
            // the `stations` memo.
            syntheticJourneyMember={(() => {
              const f = stations?.features.find(
                (g) => (g.properties as { coordKey?: string }).coordKey === displayStation.coordKey
              )
              if (!f) return undefined
              const props = f.properties as {
                syntheticPrimaryMemberName?: string
                syntheticFriendMemberName?: string
              }
              if (!props.syntheticPrimaryMemberName && !props.syntheticFriendMemberName) return undefined
              return {
                primary: props.syntheticPrimaryMemberName,
                friend: props.syntheticFriendMemberName,
              }
            })()}
            // Friend cluster-member full station names — used by the
            // friend journey paragraph to extra-bold the WHOLE station
            // name (e.g. "Birmingham New Street") rather than only the
            // first matching word ("Birmingham"). Only populated when
            // the active friend is synthetic; undefined otherwise so
            // non-synthetic friends keep the existing single-word bold.
            friendClusterMemberNames={(() => {
              if (!friendOrigin) return undefined
              if (!getOriginDisplay(friendOrigin)?.isCluster) return undefined
              const memberIds = FRIEND_ORIGIN_CLUSTER[friendOrigin] ?? []
              const names: string[] = []
              for (const m of memberIds) {
                const f = baseStations?.features.find(
                  (bf) => (bf.properties as { id?: string }).id === m,
                )
                const raw = f?.properties?.name as string | undefined
                if (raw) names.push(raw)
              }
              return names.length > 0 ? names : undefined
            })()}
          />
        )}
        </>}

      </Map>

      {/* Home-station transition spinner.
          Renders a centered pill with a spinner + label whenever the
          useTransition started by picking a new primary origin is
          still in flight. Positioned over the viewport centre — the
          map is always London-focused so "centred over the viewport"
          is effectively "over London" for this app.

          Why absolute/pointer-events-none:
            - absolute with inset-0 in a relative-positioned parent
              gives us a full-page overlay without affecting layout.
            - pointer-events-none on the outer wrapper means clicks
              pass straight through to the map/FilterPanel behind —
              no accidental interaction blocks.
            - The inner pill stays visible because it sits at a high
              z-index and uses its own background.

          Animation polish:
            - opacity transition gives it a gentle fade-in/out rather
              than a sudden pop.
            - animate-spin is Tailwind's stock 1s linear rotation,
              applied to a classic CSS ring (border-4 transparent on
              one side + coloured on the rest). */}
      {/* Filter-change pill — viewport-centred on sm+ desktop, pinned
          to the bottom on sub-sm mobile (matches the loading pill below
          so the two never collide vertically). Same chrome as the
          "Looking up trains from..." notification: background, ring,
          shadow, fixed-width spinner slot. Spinner is decorative here
          (no actual async work) — it gives the pill the same "something
          happened" energy as the loading one. Fades out 1.5s after the
          most recent filter change. */}
      {/* Visibility gate: filter pill hides whenever the loading pill
          is active (notificationPhase !== "idle"). The two share the
          same screen position; "Looking up trains" is always the
          priority because it represents in-flight network work the
          user kicked off intentionally. */}
      {(() => {
        const filterPillVisible = !!filterNotif?.visible && notificationPhase === "idle"
        return (
          <div
            aria-hidden={!filterPillVisible}
            className={cn(
              // z-[100] keeps the toast above the mobile search sheet
              // (z-[60]) and any other Radix-portalled overlays. Without
              // this the pill gets hidden behind the search results when
              // a primary/friend pick is in flight on mobile.
              "pointer-events-none absolute inset-0 z-[100] flex items-end sm:items-center justify-center pb-4 sm:pb-0 px-4",
              "transition-opacity duration-700",
              filterPillVisible ? "opacity-100" : "opacity-0",
            )}
          >
            <div className="flex items-center gap-2 rounded-full bg-background/90 px-4 py-2 shadow-lg ring-1 ring-border">
              {/* Same fixed-width spinner slot as the loading pill, so
                  the two pills are visually flush if they ever overlap
                  mid-fade. */}
              <span
                className="inline-flex items-center justify-center text-primary"
                style={{ width: "3.2rem", height: "1.25rem" }}
              >
                <LogoSpinner className="h-4" label="Updating" />
              </span>
              <span className="text-sm font-semibold text-muted-foreground">
                {filterNotif?.count ?? 0} {filterNotif?.count === 1 ? "station" : "stations"}
              </span>
            </div>
          </div>
        )
      })()}

      <div
        aria-hidden={notificationPhase === "idle"}
        className={cn(
          // Mobile: pin to bottom of viewport with matching pb-4
          // (same visual margin as the horizontal px-4). Desktop
          // (sm+): center vertically, no extra bottom padding.
          // z-[100] keeps the toast above the mobile search sheet
          // (z-[60]) so a friend/primary pick mid-search still
          // surfaces "Finding meeting points..." rather than getting
          // hidden behind the results list.
          "pointer-events-none absolute inset-0 z-[100] flex items-end sm:items-center justify-center pb-4 sm:pb-0",
          // `px-4` keeps the inner pill off the viewport edges on
          // narrow mobile widths when the label is long (e.g.
          // "Looking up trains from Kings Cross, St Pancras, & Euston"
          // would otherwise touch both screen edges).
          "px-4",
          // Bumped from 200ms → 700ms so the post-success fade
          // lingers long enough to register as "that worked, moving
          // on" rather than feeling abrupt. Fade-IN uses the same
          // duration but the loading state typically commits faster
          // than that, so the in-fade mostly overlaps with the
          // spinner being visible — a non-issue.
          "transition-opacity duration-700",
          notificationPhase !== "idle" ? "opacity-100" : "opacity-0",
        )}
      >
        <div className="flex items-center gap-2 rounded-full bg-background/90 px-4 py-2 shadow-lg ring-1 ring-border">
          {/* Fixed-width icon slot. Width is the spinner's natural
              rendered width at h-4 (viewBox aspect 132:50 →
              4 × 132/50 ≈ 10.56 spacing units, rounded to w-11) so
              swapping from spinner to tick doesn't reflow the pill.
              The tick sits centred inside; the spinner fills the
              width naturally. h-5 keeps the height consistent. */}
          <span
            className="inline-flex items-center justify-center text-primary"
            // Explicit aspect-derived width — can't rely on a Tailwind
            // step alone because the spinner is the authoritative
            // reference (aspect 132:50 × h-4 ≈ 3.168rem). Slightly
            // generous rounding (3.2rem) to avoid clipping halo/stroke.
            style={{ width: "3.2rem", height: "1.25rem" }}
          >
            {/* Spinner stays visible for the entire pill lifecycle —
                loading, the post-load "success" fade window, and the
                idle fade-out. Previously the pill flipped to a green
                tick for ~400ms after loading finished; the user asked
                for that celebratory beat to go away. Keeping the
                spinner through the fade is harmless: the pill's
                opacity animates to 0 over 200ms so the remaining
                rotation is barely perceptible. */}
            <LogoSpinner className="h-4" label="Loading" />
            {/* Silences an unused-variable lint when the only remaining
                reference to `notificationPhase` is inside the useEffect
                that drives it. */}
            {notificationPhase === "loading" ? null : null}
          </span>
          {/* Label resolution, most-specific first:
                1. menuName — used when the primary has a cluster
                   (KX→"Kings Cross, St Pancras, & Euston",
                   Waterloo→"Waterloo & Waterloo East", synthetic→
                   "Any London terminus"). Reads more accurately than
                   the short displayName because picking the cluster
                   primary actually fetches trains from ALL its
                   member stations.
                2. displayName — short curated label ("Charing
                   Cross", "Victoria") for primaries without
                   clusters.
                3. coordToName[coord] — the OSM station name, covers
                   seeded/searched picks that aren't in PRIMARY_ORIGINS
                   at all (Stratford, Farringdon, Kentish Town, …).
                4. "new home" — generic fallback. Shouldn't happen in
                   practice; the outer opacity-0 hides the pill in
                   the idle phase anyway. */}
          <span className="text-sm font-semibold text-muted-foreground">
            {(() => {
              // Resolve a coord to a human-readable place name. Tries
              // PRIMARY_ORIGINS' menuName when the coord is a cluster
              // anchor (so synthetic Central London reads as "Central
              // London", not "London"), then displayName, then the
              // cluster-friend FRIEND_ORIGINS displayName, then OSM
              // name, then a friendly fallback.
              const placeNameFor = (c: string | null, fallback: string) => {
                if (!c) return fallback
                // Primary clusters prefer their menuName (e.g. "Central
                // London" over plain "London"); other origins use the
                // straight displayName. coordToName covers the rare
                // edge case of an origin whose registry entry has been
                // removed in transit.
                if (PRIMARY_ORIGIN_CLUSTER[c]) {
                  return (
                    getOriginDisplay(c)?.menuName
                    ?? coordToName[c]
                    ?? fallback
                  )
                }
                return (
                  getOriginDisplay(c)?.displayName
                  ?? coordToName[c]
                  ?? fallback
                )
              }
              if (goodbyeFriendCoord) {
                return `Saying goodbye to ${placeNameFor(goodbyeFriendCoord, "friend")}`
              }
              if (pendingFriendCoord) {
                // Friend add/switch — frame it as a meeting between the
                // two endpoints rather than a one-sided lookup.
                const primaryPlace = placeNameFor(primaryOrigin, "your home")
                const friendPlace = placeNameFor(pendingFriendCoord, "your friend")
                return `Finding meeting points between ${primaryPlace} and ${friendPlace}`
              }
              return `Looking up trains from ${placeNameFor(pendingPrimaryCoord, "new home")}`
            })()}
          </span>
        </div>
      </div>
    </div>
  )
}

