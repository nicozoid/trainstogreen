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
import excludedStationsList from "@/data/excluded-stations.json"
// Stations that are TECHNICALLY a London NR station (so they match the
// searchableStations criteria) but produce no useful data when picked as
// a home station — because they have no RTT-reachable hub in any of our
// origin-routes.json primaries. Currently: Kensington (Olympia), whose NR
// service is sparse and event-driven. Coord-keyed, same shape as
// data/excluded-stations.json.
import excludedPrimariesList from "@/data/excluded-primaries.json"
import originRoutesData from "@/data/origin-routes.json"
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

// Universal rating applied by a dev — stored in data/station-ratings.json, not per-user
type Rating = 'highlight' | 'verified' | 'unverified' | 'not-recommended'

// Meteorological seasons (Mar/Jun/Sep/Dec boundaries) — used by the
// "[current season] highlights" checkbox. Matches the month→season mapping
// in scripts/build-rambler-notes.mjs (where station-seasons.json is
// now derived). `new Date().getMonth()` returns 0 = January → 11 = December.
function currentSeason(): "Spring" | "Summer" | "Autumn" | "Winter" {
  const m = new Date().getMonth()
  if (m >= 2 && m <= 4) return "Spring"   // Mar–May
  if (m >= 5 && m <= 7) return "Summer"   // Jun–Aug
  if (m >= 8 && m <= 10) return "Autumn"  // Sep–Nov
  return "Winter"                          // Dec, Jan, Feb
}

// Only the fields the popup needs — simpler than the old sidebar type
type SelectedStation = {
  name: string
  lng: number
  lat: number
  minutes: number
  // "lng,lat" string used as the unique rating key — two stations with the same name
  // (e.g. Newport Essex vs Newport Wales) get distinct ratings this way
  coordKey: string
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

// One table per origin role — keyed by "lng,lat" coord key (longitude-first,
// matching the rest of the app). The coord IS the key, which means we no
// longer need a separate ORIGIN_COORDS lookup; the lat/lng is parsed from the
// key when needed. Each entry carries the canonical name (for look-up in
// stations.json if ever needed) and the short/long display strings shown in
// the filter panel and map label.
type OriginDef = {
  canonicalName: string   // matches .properties.name in public/stations.json
  displayName: string     // short label for the filter panel trigger and the London-label
  menuName: string        // longer label for the dropdown menu items
  /**
   * Extra-short "super-shorthand" used ONLY on mobile (below the sm
   * breakpoint). Lets long names like "Charing Cross" shrink to "Charing X"
   * on narrow viewports without visible truncation. Falls back to displayName
   * when undefined.
   */
  mobileDisplayName?: string
  /**
   * If true, only visible in the dropdown when admin mode is active. Used for
   * origins whose journey data is partial (e.g. RTT-only origins where stations
   * off the origin's own lines have no journey data yet).
   */
  adminOnly?: boolean
  /**
   * True when the primary's coord doesn't correspond to a real train station
   * — e.g. "City of London" lives at Guildhall so the hexagon can sit at the
   * geographic centre of its cluster. Triggers modal-title/lookup differences
   * so the overlay shows "City of London" (no "Station" suffix, no
   * stations-collection lookup).
   */
  isSynthetic?: boolean
}

// Primary origins — the station that drives the "from" filter, the polyline
// animation, and the londonMinutes override.
//  - Farringdon, Kings Cross, Stratford: full Google Routes journey data per
//    destination (fetched via scripts/fetch-journeys.mjs).
//  - All other origins (CHX, LST+MOG, City cluster, MYB, PAD, VIC, WAT, WAE):
//    hybrid — RTT direct times for destinations on their own lines, stitched
//    via terminal-matrix + existing KX/Farringdon journeys for everywhere else.
const PRIMARY_ORIGINS: Record<string, OriginDef> = {
  // Farringdon and Stratford are deliberately ABSENT from PRIMARY_ORIGINS.
  // They're non-termini that happen to have full per-station Google Routes
  // data (because they're our stitcher sources) — but from a user's point
  // of view they deserve no special treatment vs any other intermediate
  // London NR station. If someone wants either as a primary, they can
  // search for it via the "Other stations" field; it then lives in the
  // recents list like any other custom pick.
  // London synthetic mega-cluster — primary coord sits at the British
  // Museum in Bloomsbury. Originally at the Charles I statue in
  // Trafalgar Square, but that's 300m from Charing Cross and the
  // "London" hexagon + terminus diamond were visually fighting each
  // other for attention at mid-zoom levels. British Museum is centrally-
  // located, far enough from every NR terminus that there's no overlap,
  // and reads as a universally-recognised "middle of London" anchor.
  // The cluster members below are what drive direct-reachable +
  // stitching lookups (the coord of the synthetic itself is not in
  // origin-routes.json — it's just a map-label anchor).
  // canonicalName "London" matches the entry we'll add to londonTerminals
  // later if we want to treat the whole cluster as a stitch source; for now
  // it's just a label.
  "-0.1269,51.5196":       { canonicalName: "London",                  displayName: "London",           menuName: "Central London", mobileDisplayName: "London", isSynthetic: true },
  // Stratford synthetic — anchor at the midpoint between SRA and SFA so
  // the cluster reads as a balanced pair on the map (not pinned to one
  // station). The synthetic coord isn't in origin-routes.json, but the
  // diff merge below mirrors the first cluster member's journey data
  // under this anchor key so primary-side filters still resolve.
  "-0.0061483,51.5430422": { canonicalName: "Stratford",                displayName: "Stratford",        menuName: "Stratford", isSynthetic: true },
  "-0.1236888,51.5074975": { canonicalName: "Charing Cross",          displayName: "Charing Cross",    menuName: "Charing Cross", mobileDisplayName: "Charing X" },
  "-0.163592,51.5243712":  { canonicalName: "Marylebone",              displayName: "Marylebone",       menuName: "Marylebone" },
  "-0.177317,51.5170952":  { canonicalName: "Paddington",              displayName: "Paddington",       menuName: "Paddington" },
  "-0.1445802,51.4947328": { canonicalName: "Victoria",                displayName: "Victoria",         menuName: "Victoria" },
  // Waterloo primary — standalone. Waterloo East is reachable via the
  // Central London synthetic; users wanting WAT specifically still get
  // it as their own primary here, but its old WAE cluster mapping is
  // gone.
  "-0.112801,51.5028379":  { canonicalName: "Waterloo",                displayName: "Waterloo",         menuName: "Waterloo" },
  // Remaining standalone termini — each has RTT direct-reachable data
  // (see data/origin-routes.json) and matches a london-terminals.json entry
  // by canonicalName or alias, so stitching works too.
  "-0.0890625,51.5182516": { canonicalName: "Moorgate",                 displayName: "Moorgate",         menuName: "Moorgate" },
  "-0.0814269,51.5182105": { canonicalName: "Liverpool Street",         displayName: "Liverpool Street", menuName: "Liverpool Street", mobileDisplayName: "Liverpool St" },
  // Cannon Street — a real weekend terminus. An earlier RTT fetch landed on
  // a Saturday with limited service and recorded zero direct hiking
  // destinations, which got CST demoted to adminOnly. Confirmed on a later
  // Saturday (25 July) that direct services do run from CST (e.g. to
  // Gravesend), so restored as a public primary. A future multi-date RTT
  // merge will pick up the missing direct services permanently.
  "-0.0906046,51.5106685": { canonicalName: "Cannon Street",            displayName: "Cannon Street",    menuName: "Cannon Street", mobileDisplayName: "Cannon St" },
  "-0.0774191,51.5113281": { canonicalName: "Fenchurch Street",         displayName: "Fenchurch Street", menuName: "Fenchurch Street", mobileDisplayName: "Fenchurch St" },
  "-0.1032417,51.5104871": { canonicalName: "Blackfriars",              displayName: "Blackfriars",      menuName: "Blackfriars" },
  "-0.0851473,51.5048764": { canonicalName: "London Bridge",            displayName: "London Bridge",    menuName: "London Bridge" },
}

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
const CENTRAL_LONDON_COORD = "-0.1269,51.5196"
const byDisplayName = (a: string, b: string) => {
  if (a === CENTRAL_LONDON_COORD) return -1
  if (b === CENTRAL_LONDON_COORD) return 1
  return (PRIMARY_ORIGINS[a]?.displayName ?? a).localeCompare(PRIMARY_ORIGINS[b]?.displayName ?? b)
}
// Pinned primary coords — always shown at the top of the primary dropdown,
// always present, never evicted. For now just Central London; the rest of
// the menu is composed of seeded/user recents below.
const PINNED_PRIMARIES: string[] = [CENTRAL_LONDON_COORD]
// Pinned friend coords — same idea on the friend side, currently empty.
// Kept as a const so future "always-visible" picks can be added without
// touching the dropdown rendering.
const PINNED_FRIENDS: string[] = []
// Admin-only primary group — separate from pinned, only rendered when
// adminMode is on. Hidden from regular users; useful as a one-click pick
// for dev work on partially-fetched origins.
const ADMIN_ONLY_PRIMARIES: string[] = Object.keys(PRIMARY_ORIGINS)
  .filter((k) => PRIMARY_ORIGINS[k]?.adminOnly)
  .sort(byDisplayName)

// Coord-key migrations: when a previously-standalone primary moves to a new
// synthetic anchor coord, redirect stored picks (in primaryOrigin AND recents)
// so users coming back with stale localStorage don't end up with duplicates
// or get reset to the default.
const COORD_MIGRATIONS: Record<string, string> = {
  // Old Stratford (SRA) standalone primary → new synthetic midpoint
  "-0.0035472,51.541289": "-0.0061483,51.5430422",
  // Old Kings Cross cluster primary (now removed) → Central London synthetic
  "-0.1239491,51.530609": "-0.1269,51.5196",
}

// Seeded recents for the primary dropdown — coords pre-populated as if
// the user had recently searched for and picked each one. Merged with
// the actual user recents at render time (user picks float to the top,
// defaults below — deduped). Picked for major-interchange status,
// geographic spread, and population catchment.
const DEFAULT_RECENT_PRIMARIES: string[] = [
  "-0.1705184,51.4644589",   // Clapham Junction (CLJ)
  "-0.0035472,51.541289",    // Stratford (SRA)
  "-0.2435041,51.5321956",   // Willesden Junction (WIJ)
  "-0.0746988,51.3971695",   // Norwood Junction (NWD)
  "-0.1064144,51.5648345",   // Finsbury Park (FPK)
  "-0.0599442,51.588123",    // Tottenham Hale (TOM)
  "-0.3004067,51.5149803",   // Ealing Broadway (EAL)
  "0.0232808,51.549251",     // Forest Gate (FOG)
  "-0.0927317,51.3758448",   // East Croydon (ECR)
  "0.2191164,51.4474203",    // Dartford (DFD)
  "0.0887195,51.3736037",    // Orpington (ORP)
  "-0.3004127,51.4632072",   // Richmond (RMD)
  "-0.3961114,51.6639446",   // Watford Junction (WFJ)
  "-0.3276687,51.7504966",   // St Albans City (SAC)
  "0.1826107,51.5747271",    // Romford (RMF)
  "-0.4191564,51.5029246",   // Hayes and Harlington (HAY)
  "-0.104555,51.519964",     // Farringdon (ZFD)
]
// DEFAULT_RECENT_FRIENDS is declared after FRIEND_ORIGINS below (it's
// just Object.keys(FRIEND_ORIGINS)) — keeping it close to the source
// keeps maintenance simple.

// Clustered satellite stations — when a primary is active, these extra coord
// keys are also consulted for direct-reachable lookups AND stitching attempts,
// and the fastest train from any cluster member wins.
//  - Liverpool Street ← Moorgate: short walk, MOG has distinct GN suburban pattern.
//  - City cluster ← six City-area stations (synthetic primary coord at Bank).
//    Admin-only while we validate whether aggregating 6 origins into one is
//    useful UX.
const PRIMARY_ORIGIN_CLUSTER: Record<string, string[]> = {
  // Stratford synthetic ← SRA + SFA. Both render as satellite diamonds
  // around the midpoint anchor; first member's journey data drives the
  // routing alias on the synthetic coord (see diff merge below).
  "-0.0061483,51.5430422": [
    "-0.0035472,51.541289",   // Stratford (SRA)
    "-0.0087494,51.5447954",  // Stratford International (SFA)
  ],
  // London — the 18 true termini. Primary coord is the Charles I statue
  // (synthetic, no station there). Every cluster member is a real terminus;
  // Farringdon is intentionally EXCLUDED (it's a through-station, not a
  // terminus). When London is the active primary, direct-reachable and
  // stitched journeys are computed across all 18 termini and the quickest
  // route wins (with the 15-min direct-preference + 2h30m cutoff rules).
  "-0.1269,51.5196": [
    "-0.1239491,51.530609",   // Kings Cross (Underground)
    "-0.1230224,51.5323954",  // Kings Cross (National Rail / KGX)
    "-0.1270027,51.5327196",  // St Pancras International (STP, main concourse)
    "-0.1276185,51.5322106",  // St Pancras International (SPL, HS1/domestic concourse)
    "-0.1341909,51.5288526",  // Euston (National Rail / EUS)
    "-0.1338745,51.5282865",  // Euston (Underground)
    "-0.1236888,51.5074975",  // Charing Cross
    "-0.1445802,51.4947328",  // Victoria
    "-0.112801,51.5028379",   // Waterloo
    "-0.1082027,51.5042171",  // Waterloo East
    "-0.163592,51.5243712",   // Marylebone
    "-0.177317,51.5170952",   // Paddington
    "-0.0890625,51.5182516",  // Moorgate
    "-0.0814269,51.5182105",  // Liverpool Street
    "-0.0906046,51.5106685",  // Cannon Street
    "-0.0774191,51.5113281",  // Fenchurch Street
    "-0.1032417,51.5104871",  // Blackfriars
    "-0.0851473,51.5048764",  // London Bridge
  ],
}

// Farringdon coord / CRS — used by the City cluster's Thameslink-Farringdon
// preference: when any other cluster member would have been the RTT winner
// but is on the same Thameslink through-service as Farringdon, override back
// to Farringdon as the departure point.
const FARRINGDON_COORD = "-0.104555,51.519964"
const FARRINGDON_CRS = "ZFD"

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

// Friend origins — the secondary station used for filtering in "meet a friend"
// mode. Same shape as PRIMARY_ORIGINS. Synthetic friends (e.g. Birmingham,
// Manchester) anchor at one of their cluster member's coords (so RTT + Google
// Routes journey data still resolves) and declare satellite cluster members
// in FRIEND_ORIGIN_CLUSTER below. The synthetic flag triggers diamond
// rendering for those satellites and a cluster header in the overlay.
const FRIEND_ORIGINS: Record<string, OriginDef> = {
  // Birmingham synthetic — anchor at the centroid of BHM/BMO/BSW so the
  // cluster reads as a balanced trio. Friend journeys are RTT-derived
  // (scripts/build-friend-journeys-from-rtt.mjs), so coverage matches the
  // primary side rather than the older Google Routes set.
  "-1.8967682,52.4801267": { canonicalName: "Birmingham",          displayName: "Birmingham", menuName: "Birmingham", isSynthetic: true },
  // Manchester synthetic — anchor at the centroid of MAN/MCV/MCO. Same
  // RTT-derived journey-file approach as Birmingham; no Google Routes
  // spend was needed thanks to the BMO/BSW + queue junction fetches.
  "-2.2383003,53.4796574": { canonicalName: "Manchester",          displayName: "Manchester", menuName: "Manchester", isSynthetic: true },
  "-1.1449555,52.9473037": { canonicalName: "Nottingham",          displayName: "Nottingham", menuName: "Nottingham" },
  // Tier 2 — UK city friends, RTT-derived journeys built via
  // scripts/build-friend-journeys-from-rtt.mjs and stored under
  // public/journeys/<slug>.json. Cities with multiple central
  // stations (Edinburgh / Glasgow / Cardiff / Portsmouth) are
  // synthetic anchors with cluster members listed in
  // FRIEND_ORIGIN_CLUSTER below; everywhere else is single-station.
  // Centroid-anchored synthetics — same pattern as Birmingham / Manchester.
  // The synthetic coord sits at the geographic mean of the cluster
  // members so the principal station can render as a normal diamond
  // alongside its siblings instead of doubling as the synthetic square.
  "-3.2048968,55.9485428":  { canonicalName: "Edinburgh",     displayName: "Edinburgh",      menuName: "Edinburgh", isSynthetic: true },
  "-4.2547767,55.8604359":  { canonicalName: "Glasgow",       displayName: "Glasgow",        menuName: "Glasgow", isSynthetic: true },
  "-3.1749991,51.4787758":  { canonicalName: "Cardiff",       displayName: "Cardiff",        menuName: "Cardiff", isSynthetic: true },
  "-2.5804029,51.4490991":  { canonicalName: "Bristol",       displayName: "Bristol",        menuName: "Bristol" },
  "-2.3567189,51.3776019":  { canonicalName: "Bath",          displayName: "Bath",           menuName: "Bath" },
  "-1.2699542,51.7534512":  { canonicalName: "Oxford",        displayName: "Oxford",         menuName: "Oxford" },
  "0.1377154,52.1941089":   { canonicalName: "Cambridge",     displayName: "Cambridge",      menuName: "Cambridge" },
  "-0.1407393,50.8288602":  { canonicalName: "Brighton",      displayName: "Brighton",       menuName: "Brighton" },
  "-1.548621,53.794414":    { canonicalName: "Leeds",         displayName: "Leeds",          menuName: "Leeds" },
  "-2.9831014,53.4056107":  { canonicalName: "Liverpool",     displayName: "Liverpool",      menuName: "Liverpool", isSynthetic: true },
  // Reading — single-station anchor. Useful as a friend for the
  // M4-corridor commuter belt; not part of the central-Bristol/Cardiff
  // mega-cluster.
  "-0.9723182,51.4592197":  { canonicalName: "Reading",       displayName: "Reading",        menuName: "Reading" },
  "-1.616046,54.9683364":   { canonicalName: "Newcastle",     displayName: "Newcastle",      menuName: "Newcastle" },
  "-1.4621381,53.3783713":  { canonicalName: "Sheffield",     displayName: "Sheffield",      menuName: "Sheffield" },
  "-1.0937301,53.9577037":  { canonicalName: "York",          displayName: "York",           menuName: "York" },
  "-1.1236065,52.6321088":  { canonicalName: "Leicester",     displayName: "Leicester",      menuName: "Leicester" },
  "-1.5135474,52.400739":   { canonicalName: "Coventry",      displayName: "Coventry",       menuName: "Coventry" },
  "-1.462612,52.9165243":   { canonicalName: "Derby",         displayName: "Derby",          menuName: "Derby" },
  "-2.1810781,53.0079887":  { canonicalName: "Stoke-on-Trent",displayName: "Stoke-on-Trent", menuName: "Stoke-on-Trent", mobileDisplayName: "Stoke" },
  "-2.120242,52.5879884":   { canonicalName: "Wolverhampton", displayName: "Wolverhampton",  menuName: "Wolverhampton",  mobileDisplayName: "Wolves" },
  "-4.1433925,50.3780967":  { canonicalName: "Plymouth",      displayName: "Plymouth",       menuName: "Plymouth" },
  "-3.5435703,50.7292155":  { canonicalName: "Exeter",        displayName: "Exeter",         menuName: "Exeter" },
  "-1.4142289,50.9074977":  { canonicalName: "Southampton",   displayName: "Southampton",    menuName: "Southampton",    mobileDisplayName: "S'hampton" },
  "-1.0997297,50.7974525":  { canonicalName: "Portsmouth",    displayName: "Portsmouth",     menuName: "Portsmouth",     mobileDisplayName: "P'mouth", isSynthetic: true },
  "1.3076876,52.626307":    { canonicalName: "Norwich",       displayName: "Norwich",        menuName: "Norwich" },
  "1.1447878,52.0504188":   { canonicalName: "Ipswich",       displayName: "Ipswich",        menuName: "Ipswich" },
  "-0.2503162,52.5746038":  { canonicalName: "Peterborough",  displayName: "Peterborough",   menuName: "Peterborough",   mobileDisplayName: "P'borough" },
  "-1.1399149,53.5219538":  { canonicalName: "Doncaster",     displayName: "Doncaster",      menuName: "Doncaster" },
  "-0.3475977,53.7438351":  { canonicalName: "Hull",          displayName: "Hull",           menuName: "Hull" },
  "-2.0976346,57.1426487":  { canonicalName: "Aberdeen",      displayName: "Aberdeen",       menuName: "Aberdeen" },
  "-4.2227142,57.4802331":  { canonicalName: "Inverness",     displayName: "Inverness",      menuName: "Inverness" },
  "-3.9403729,51.6256789":  { canonicalName: "Swansea",       displayName: "Swansea",        menuName: "Swansea" },
  "-0.7748261,52.0342006":  { canonicalName: "Milton Keynes", displayName: "Milton Keynes",  menuName: "Milton Keynes",  mobileDisplayName: "Milton K" },
  "-0.9069697,52.2373719":  { canonicalName: "Northampton",   displayName: "Northampton",    menuName: "Northampton",    mobileDisplayName: "N'hampton" },
  "-2.4326364,53.0889629":  { canonicalName: "Crewe",         displayName: "Crewe",          menuName: "Crewe" },
  "-2.7071573,53.7552898":  { canonicalName: "Preston",       displayName: "Preston",        menuName: "Preston" },
  "-2.807799,54.0488361":   { canonicalName: "Lancaster",     displayName: "Lancaster",      menuName: "Lancaster" },
  "-2.9330473,54.8902575":  { canonicalName: "Carlisle",      displayName: "Carlisle",       menuName: "Carlisle" },
}

// Friend cluster members — same shape as PRIMARY_ORIGIN_CLUSTER. Listed
// coords appear as satellite diamonds when the parent friend is active,
// and tap-to-resolve back to the parent. Anchors live at the FIRST listed
// real station for each friend, so the anchor itself isn't included as a
// member.
const FRIEND_ORIGIN_CLUSTER: Record<string, string[]> = {
  // Birmingham (synthetic centroid anchor) ← BHM + BMO + BSW.
  "-1.8967682,52.4801267": [
    "-1.898694,52.4776459",    // Birmingham New Street (BHM)
    "-1.8919518,52.4789357",   // Birmingham Moor Street (BMO)
    "-1.8996588,52.4837984",   // Birmingham Snow Hill (BSW)
  ],
  // Manchester (synthetic centroid anchor) ← MAN + MCV + MCO.
  "-2.2383003,53.4796574": [
    "-2.2301402,53.4772197",   // Manchester Piccadilly (MAN)
    "-2.2424846,53.4879748",   // Manchester Victoria (MCV)
    "-2.2422762,53.4737777",   // Manchester Oxford Road (MCO)
  ],
  // Edinburgh (centroid anchor) ← Waverley + Haymarket satellites.
  "-3.2048968,55.9485428": [
    "-3.1904199,55.9519018",   // Edinburgh Waverley (EDB)
    "-3.2193738,55.9451838",   // Haymarket (HYM)
  ],
  // Glasgow (centroid anchor) ← Central + Queen Street satellites.
  "-4.2547767,55.8604359": [
    "-4.2584361,55.8583132",   // Glasgow Central (GLC)
    "-4.2511172,55.8625587",   // Glasgow Queen Street (GLQ)
  ],
  // Cardiff (centroid anchor) ← Central + Queen Street satellites.
  "-3.1749991,51.4787758": [
    "-3.1797057,51.4755495",   // Cardiff Central (CDF)
    "-3.1702926,51.4820022",   // Cardiff Queen Street (CDQ)
  ],
  // Portsmouth (centroid anchor) ← & Southsea + Harbour satellites.
  "-1.0997297,50.7974525": [
    "-1.0906787,50.7982014",   // Portsmouth & Southsea (PMS)
    "-1.1087807,50.7967035",   // Portsmouth Harbour (PMH)
  ],
  // Liverpool (centroid anchor) ← Lime Street + Central + James Street.
  // All three sit within ~1 km of each other in central Liverpool.
  "-2.9831014,53.4056107": [
    "-2.9775854,53.4076085",   // Liverpool Lime Street (LIV)
    "-2.9795092,53.4042207",   // Liverpool Central (LVC)
    "-2.9922097,53.4050028",   // Liverpool James Street (LVJ)
  ],
}

// Flat arrays of keys for filter-panel's "list of origins to render" props.
const FRIEND_ORIGIN_KEYS = Object.keys(FRIEND_ORIGINS)

// Coord → journey-file slug for every friend in FRIEND_ORIGINS. Slugs
// match the filenames under public/journeys/ that
// scripts/build-friend-journeys-from-rtt.mjs writes. Without this
// mapping, ensureOriginLoaded can't fetch the right file when the user
// picks Leicester (et al.) as a friend, so the map appears empty even
// though the data exists on disk.
const FRIEND_SLUGS: Record<string, string> = (() => {
  const out: Record<string, string> = {}
  // Kebab-case the canonical name to match the on-disk slug —
  // 'Stoke-on-Trent' → 'stoke-on-trent', 'Milton Keynes' → 'milton-keynes'.
  const kebab = (s: string) =>
    s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "")
  for (const [coord, def] of Object.entries(FRIEND_ORIGINS)) {
    if (def?.canonicalName) out[coord] = kebab(def.canonicalName)
  }
  return out
})()

// Seeded recents for the friend dropdown. Order is the user's curated
// priority — picked for population catchment + geographic spread, with
// the largest cities first. Each coord is the friend's anchor (the
// synthetic centroid for cluster friends like Birmingham/Manchester,
// or the single-station coord for everywhere else). Other friends still
// exist in FRIEND_ORIGINS for searchability — they're just not seeded.
const DEFAULT_RECENT_FRIENDS: string[] = [
  "-1.8967682,52.4801267",   // Birmingham (BHM·BMO·BSW cluster)
  "-0.9723182,51.4592197",   // Reading
  "-0.1407393,50.8288602",   // Brighton
  "-1.1236065,52.6321088",   // Leicester
  "-2.2383003,53.4796574",   // Manchester (MAN·MCV·MCO cluster)
  "-1.5135474,52.400739",    // Coventry
  "-2.5804029,51.4490991",   // Bristol (Temple Meads only — not a cluster)
  "-1.1449555,52.9473037",   // Nottingham
  "-1.548621,53.794414",     // Leeds
  "-1.4142289,50.9074977",   // Southampton (Central only — not a cluster)
  "-3.1749991,51.4787758",   // Cardiff (CDF·CDQ cluster, centroid anchor)
  "-2.9831014,53.4056107",   // Liverpool (LIV·LVC·LVJ cluster, centroid anchor)
  "-1.4621381,53.3783713",   // Sheffield
  "-1.2699542,51.7534512",   // Oxford
  "-1.0997297,50.7974525",   // Portsmouth (PMS·PMH cluster, centroid anchor)
  "0.1377154,52.1941089",    // Cambridge
  "-0.7748261,52.0342006",   // Milton Keynes
  "-4.2547767,55.8604359",   // Glasgow (GLC·GLQ cluster, centroid anchor)
  "-1.462612,52.9165243",    // Derby
  "-3.2048968,55.9485428",   // Edinburgh (EDB·HYM cluster, centroid anchor)
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
  if (!FRIEND_ORIGINS[friendOrigin]?.isSynthetic) return undefined
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

// Unified lookup for display/menu strings — used by the single callback we
// pass into filter-panel (which renders labels for both primary AND friend origins).
const ALL_ORIGINS: Record<string, OriginDef> = { ...PRIMARY_ORIGINS, ...FRIEND_ORIGINS }

// Parse "-0.12,51.53" → { lng, lat }. Coord keys are longitude-first because
// that matches GeoJSON [lng, lat] ordering we use elsewhere.
function parseCoordKey(key: string): { lng: number; lat: number } {
  const [lng, lat] = key.split(",").map(Number)
  return { lng, lat }
}

// Legacy→coord migration for localStorage. If the stored value is an old
// name string (no comma), resolve it via canonicalName. Unknown values fall
// back to `fallback`. Comma-containing values are assumed to already be coord keys.
function migrateOriginKey(stored: string | null | undefined, table: Record<string, OriginDef>, fallback: string): string {
  if (!stored) return fallback
  if (stored.includes(",")) return stored
  const entry = Object.entries(table).find(([, v]) => v.canonicalName === stored)
  return entry?.[0] ?? fallback
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
// primaries like Clapham Junction. Same shape as terminal-matrix —
// stitchJourney's lookup `matrix[newOrigin.name][mainlineTerminal]`
// resolves both cases without any code change.
const terminalMatrix: TerminalMatrix = {
  ...(tflHopMatrixData as TerminalMatrix),
  ...(terminalMatrixData as TerminalMatrix),
}

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
      const { lng: cLng, lat: cLat } = parseCoordKey(customCoord)
      const { lng: hLng, lat: hLat } = parseCoordKey(hub.pCoord)
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
  "-0.112801,51.5028379":   { "-0.1082027,51.5042171": { minutes: 5 } },  // WAT → WAE
  "-0.1082027,51.5042171":  { "-0.112801,51.5028379":  { minutes: 5 } },  // WAE → WAT
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
        const { lng: cLng, lat: cLat } = parseCoordKey(customCoord)
        const { lng: h1Lng, lat: h1Lat } = parseCoordKey(h1.pCoord)
        const { lng: h2Lng, lat: h2Lat } = parseCoordKey(h2Coord)
        const { lng: h3Lng, lat: h3Lat } = parseCoordKey(h3Coord)
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
        const { lng: dLng, lat: dLat } = parseCoordKey(destCoordKey)
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

// Stations manually excluded — edit data/excluded-stations.json to add/remove entries.
// Entries are either station names (legacy) or "lng,lat" coord keys (preferred — unambiguous when two stations share a name).
// INITIAL_EXCLUDED_STATIONS seeds the state; admin toggling mutates the state set.
const INITIAL_EXCLUDED_STATIONS = new Set(excludedStationsList)

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
  // layer. Resolved from the station's rating / isExcluded at
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
  if (hasProp("isExcluded")) return "icon-excluded"
  // The London hexagon marker uses icon-london (also a square shape). It's
  // tapped often — the primary-selection hexagon sits on top of the map —
  // so if we resolve it as "icon-unrated" the pulse renders a circle
  // on top of the hexagon. Match the base layer's icon-image here too.
  if (hasProp("isLondon")) return "icon-london"
  // Terminus diamond features carry isTerminus — match their base-layer
  // icon so the hover pulse animates as a primary-colour diamond rather
  // than defaulting to the unrated circle.
  if (hasProp("isTerminus")) return "icon-london-terminus"
  switch (props.rating) {
    case "highlight": return "icon-highlight"
    case "verified": return "icon-verified"
    case "unverified": return "icon-unverified"
    case "not-recommended": return "icon-not-recommended"
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
  // Primary origin is a "lng,lat" coord key. Default is the City of London
  // mega-cluster (synthetic coord at Guildhall) — gives new users broad
  // access to the City's 7 terminals without needing to pick one manually.
  // Users with the old name string in localStorage get translated below via migrateOriginKey.
  const [primaryOrigin, setPrimaryOriginRaw] = usePersistedState("ttg:primaryOrigin", "-0.1269,51.5196")
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
  // Mirror of recentCustomPrimaries on the friend side — coord keys the
  // user has previously picked as a friend's home. Merged with
  // DEFAULT_RECENT_FRIENDS at render time so user picks float to the top
  // of the friend dropdown.
  const [recentCustomFriends, setRecentCustomFriends] = usePersistedState<string[]>(
    "ttg:recentCustomFriends",
    [],
  )
  // One-shot localStorage migration: name → coord key, and reset if the stored
  // coord isn't a current primary option (e.g. we removed the Liverpool Street
  // standalone primary — users who had LST selected should fall back to default).
  // A custom-primary coord (from the search bar) is also valid: recognised by
  // being present in recentCustomPrimaries, which persists independently.
  // useEffect (rather than useState lazy init) because usePersistedState hydrates
  // from localStorage asynchronously via its own effect.
  useEffect(() => {
    if (!primaryOrigin) return
    if (COORD_MIGRATIONS[primaryOrigin]) {
      setPrimaryOriginRaw(COORD_MIGRATIONS[primaryOrigin])
      return
    }
    if (!primaryOrigin.includes(",")) {
      setPrimaryOriginRaw(migrateOriginKey(primaryOrigin, PRIMARY_ORIGINS, "-0.1269,51.5196"))
    } else if (!PRIMARY_ORIGINS[primaryOrigin] && !recentCustomPrimaries.includes(primaryOrigin)) {
      // Stored coord isn't a valid primary anymore — reset to default.
      setPrimaryOriginRaw("-0.1269,51.5196")
    }
  }, [primaryOrigin, setPrimaryOriginRaw, recentCustomPrimaries])

  // Recents-list cleanup: any synthetic primary anchor that ends up in the
  // recents list (e.g. Stratford, which used to be seeded as a recent before
  // it was promoted to a synthetic primary in the top group) gets removed,
  // since synthetic primaries already have a permanent slot in the dropdown
  // and shouldn't appear twice. Also strips legacy coords that would migrate
  // to a synthetic — without this, users with the old SRA coord in localStorage
  // see Stratford twice (once as the synthetic, once as the unmigrated recent).
  useEffect(() => {
    const cleaned = recentCustomPrimaries.filter((c) => {
      if (PRIMARY_ORIGINS[c]?.isSynthetic) return false
      const migrated = COORD_MIGRATIONS[c]
      if (migrated && PRIMARY_ORIGINS[migrated]?.isSynthetic) return false
      return true
    })
    if (cleaned.length !== recentCustomPrimaries.length) {
      setRecentCustomPrimaries(cleaned)
    }
  }, [recentCustomPrimaries, setRecentCustomPrimaries])
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
    for (const [primary, members] of Object.entries(PRIMARY_ORIGIN_CLUSTER)) {
      if (PRIMARY_ORIGINS[primary]?.isSynthetic) continue
      for (const m of members) out[m] = primary
    }
    return out
  }, [])
  // Set of coords inside ANY synthetic primary's cluster (anchor + all
  // members). Used to decide whether a search-picked coord should bypass the
  // "recents" list. Synthetic-cluster coords bypass recents because their
  // anchor is already in the curated dropdown; non-synthetic standalone
  // primaries (Charing Cross, Waterloo) and other NR stations (Farringdon,
  // East Croydon) all go to recents.
  const londonClusterCoords = useMemo(() => {
    const set = new Set<string>()
    for (const k of Object.keys(PRIMARY_ORIGINS)) {
      if (!PRIMARY_ORIGINS[k]?.isSynthetic) continue
      set.add(k)
      for (const m of PRIMARY_ORIGIN_CLUSTER[k] ?? []) set.add(m)
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
    const resolved = PRIMARY_ORIGINS[coord]?.isSynthetic
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
      // Synthetic primary — no recents entry, just select.
      if (PRIMARY_ORIGINS[coord]?.isSynthetic) {
        setPrimaryOriginRaw(coord)
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
  const originCoords = parseCoordKey(primaryOrigin)
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
  // Excluded stations (names + "lng,lat" coord keys — whichever the JSON stores).
  // Seeded from data/excluded-stations.json, mutated via the admin cross toggle.
  const [excludedStations, setExcludedStations] = useState<Set<string>>(() => new Set(INITIAL_EXCLUDED_STATIONS))
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
      const slug = ORIGIN_SLUGS[originCoord]
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
          // Merge into baseStations: for each feature whose coordKey
          // appears in the loaded journeys map, add an entry under
          // f.properties.journeys[originCoord]. Everything else in the
          // app already reads journeys[origin] so no other code needs
          // to change.
          setBaseStations((prev) => {
            if (!prev) return prev
            const perCoord = payload.journeys
            return {
              ...prev,
              features: prev.features.map((f) => {
                const coordKey = f.properties.coordKey as string
                const entry = perCoord[coordKey]
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
  // Same for the home primary — switching to Farringdon / Kings
  // Cross / Stratford eager-loads that origin's file so the live
  // compute path has the Routes journeys it expects.
  useEffect(() => {
    if (primaryOrigin) ensureOriginLoaded(primaryOrigin)
  }, [primaryOrigin, ensureOriginLoaded])
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
  // routing file available. Narrow: only the primaries that actually
  // appear in the public dropdowns by default get precomputed.
  // Anything else (user searches a non-preloaded London station)
  // falls through to live compute.
  const PRIMARY_SLUG: Record<string, string> = {
    "-0.1269,51.5196":       "central-london",
    "-0.0035472,51.541289":  "stratford",
    // Synthetic Stratford midpoint anchor — uses the same routing diff
    // as the SRA primary above; the diff merge in routedStations mirrors
    // SRA's journey data under this synthetic key so filters resolve.
    "-0.0061483,51.5430422": "stratford",
    // Preloaded friend-dropdown defaults — also precomputable as
    // primaries in case admin / a future feature wants to use them
    // as home origins. Their journey-file counterparts live under
    // public/journeys/ for friend-side rendering; these are the
    // home-side precomputed routing diffs.
    "-1.898694,52.4776459":  "birmingham",
    "-2.2301402,53.4772197": "manchester",
    "-1.1449555,52.9473037": "nottingham",
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
        if (data && typeof data === "object") {
          setPrecomputedRoutingByPrimary((prev) => ({ ...prev, [slug]: data }))
        }
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
  type FeatureFilter = "off" | "alt-routes" | "private-notes" | "sloppy-pics" | "all-sloppy-pics" | "undiscovered" | "komoot" | "issues" | "no-travel-data" | "oyster"
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
  // Admin-only "Season" dropdown — slice destinations to those recommended
  // for the chosen season. "off" = no filter. Cleared on admin-off (below).
  type SeasonFilter = "off" | "Spring" | "Summer" | "Autumn" | "Winter" | "None"
  const [seasonFilter, setSeasonFilter] = useState<SeasonFilter>("off")
  // Public "[current-season] highlights" checkbox — when on, only stations
  // recommended for the current season are shown. Coexists with seasonFilter
  // (both filters applied independently, AND semantics).
  const [currentSeasonHighlight, setCurrentSeasonHighlight] = useState(false)
  const [hovered, setHovered] = useState<HoveredStation | null>(null)
  const [showTrails, setShowTrails] = useState(false)
  // Region labels (counties, parks, AONBs) — controlled by a checkbox in
  // FilterPanel sitting under "Waymarked trails". Off by default. Visible
  // to all users (not admin-only) once toggled on.
  const [showRegions, setShowRegions] = useState(false)
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
  // Screen-pixel origin of the London icon — null on initial page load (no icon click)
  const [bannerOrigin, setBannerOrigin] = useState<{ x: number; y: number } | null>(null)
  const [zoom, setZoom] = useState(INITIAL_VIEW.zoom)
  // Admin-only readout — last known cursor lng/lat. Updated from
  // handleMouseMove via e.lngLat. Rendered as a small badge next to the zoom
  // indicator. Uses the same coordKey format as the rest of the app
  // ("lng,lat" with 4 decimals) so the value can be copy-pasted into
  // station-keyed JSON files (excluded-stations.json, station-notes.json,
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
  // Coord → filename-slug mapping for the 5 pre-fetched Routes
  // origins. Any origin not in this map isn't lazy-loadable and
  // falls through to the RTT-based routing path.
  const ORIGIN_SLUGS: Record<string, string> = {
    // Primary-side journey files (same shape as friend files, just
    // generated for primaries we want fully precomputed).
    "-0.104555,51.519964": "farringdon",
    "-0.1239491,51.530609": "kings-cross",
    "-0.0035472,51.541289": "stratford",
    "-1.1449555,52.9473037": "nottingham",
    "-1.898694,52.4776459": "birmingham",
    // Cluster-anchor coords for Stratford / Birmingham / Manchester —
    // ensureOriginLoaded stamps the loaded journeys under whatever
    // origin coord we pass in, so passing the synthetic coord makes
    // journeys[syntheticAnchor] resolve directly without any fallback.
    "-0.0061483,51.5430422": "stratford",
    "-1.8967682,52.4801267": "birmingham",
    "-2.2383003,53.4796574": "manchester",
    // Every other friend in FRIEND_ORIGINS — its anchor coord maps to
    // the slug derived from its canonicalName. Without this, picking
    // Leicester (or any of the 35 other tier-2 friends) would leave the
    // map empty because no journey file ever gets fetched.
    ...FRIEND_SLUGS,
  }
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
  // Maps coordKey → rating; loaded from data/station-ratings.json via API.
  // Universal (not per-user) — ratings are set in dev mode and affect all viewers.
  const [ratings, setRatings] = useState<Record<string, Rating>>({})
  // Admin-only: set of "homeCoord|destCoord" pairs the admin has tested
  // and approved. Controls the red-tint overlay on the map in admin
  // mode (any non-approved destination for the current primary gets a
  // red dot) and the "Approved for this home" checkbox in the modal.
  // Station-global "has issue" flag — a Set of coordKeys flagged via the
  // admin issue button. Drives the red halo overlay regardless of which
  // primary is selected.
  const [issueStations, setIssueStations] = useState<Set<string>>(new Set())
  // Which rating categories to filter to — empty means "show all" (no filter active).
  // "unrated" is a pseudo-category for stations without any rating.
  // Empty set = no filter = all stations visible. Not persisted — rating
  // filters reset to "show everything" on every reload, matching the rest
  // of the filter state.
  // Default: start with the three positive ratings ticked so new visitors
  // see a focused map (curated picks only), not every rated station plus
  // every "Okay" and every "Unknown". Admins can click extras on manually.
  const [visibleRatings, setVisibleRatings] = useState<Set<string>>(
    () => new Set(["highlight", "verified", "unverified"]),
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
    /** Public sectioned prose — station-to-station walks. Filtered to
     *  3 walks max (mains plus top variants up to the gap). */
    publicWalksS2S?: string
    /** Public sectioned prose — circular walks. Same 3-walks-per-section
     *  filter as publicWalksS2S. */
    publicWalksCircular?: string
    /** Public free-form extras (notes about the station, not walks).
     *  Always shown in full, no quota. Rendered without a section header. */
    publicWalksExtras?: string
  }
  const [stationNotes, setStationNotes] = useState<Record<string, NotesEntry>>({})

  // Free-form "rambler extras" — admin-editable markdown paragraphs
  // that render AFTER the walk summaries in each station's ramblerNote
  // prose. Keyed by coordKey. Lives in data/station-rambler-extras.json;
  // derived into station-notes.json by the build script. We store it
  // client-side as `Record<coordKey, string[]>` and thread the current
  // station's entry into the photo overlay for editing.
  const [ramblerExtras, setRamblerExtras] = useState<Record<string, string[]>>({})

  // Seasons metadata per station. Purely a build output derived from each
  // walk variant's structured `bestSeasons` field (aggregated in
  // scripts/build-rambler-notes.mjs). Not editable — the source of truth
  // is the per-walk data. Used by two filters: the admin "Season" dropdown
  // and the public "[current season] highlights" checkbox.
  type Season = "Spring" | "Summer" | "Autumn" | "Winter"
  type SeasonsEntry = { name: string; seasons: Season[] }
  const [stationSeasons, setStationSeasons] = useState<Record<string, SeasonsEntry>>({})

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
    fetch("/api/dev/rate-station")
      .then((res) => res.json())
      .then((data) => setRatings(data))
    fetch("/api/dev/curate-photo")
      .then((res) => res.json())
      .then((data) => setCurations(data))
    fetch("/api/dev/station-notes")
      .then((res) => res.json())
      .then((data) => setStationNotes(data))
    fetch("/api/dev/station-rambler-extras")
      .then((res) => res.json())
      .then((data: Record<string, string[]>) => setRamblerExtras(data))
    fetch("/api/dev/station-seasons")
      .then((res) => res.json())
      .then((data) => setStationSeasons(data))
    fetch("/api/dev/stations-hiked")
      .then((res) => res.json())
      .then((data: string[]) => setStationsHiked(new Set(data)))
    fetch("/api/dev/stations-with-komoot")
      .then((res) => res.json())
      .then((data: string[]) => setStationsWithKomoot(new Set(data)))
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
  const [prevVisibleRatings, setPrevVisibleRatings] = useState<Set<string>>(new Set())

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
  //      event-day-only service). Distinct from data/excluded-stations.json,
  //      which excludes stations as DESTINATIONS; this list excludes them
  //      as HOME stations.
  // Memoized on baseStations so it's rebuilt once per data load.
  const excludedPrimariesSet = useMemo(
    () => new Set(excludedPrimariesList as string[]),
    [],
  )
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
    //   - hasData: true if the station (or its cluster primary, for cluster
    //       members) has full RTT origin-routes data. Drives the dropdown's
    //       "Coming soon" disabled state — rows without data are greyed out
    //       and unselectable, with a tooltip on desktop hover.
    type SearchableStation = {
      coord: string
      name: string
      crs: string
      primaryCoord: string
      displayLabel: string
      hasData: boolean
    }
    // Set of coord keys that have fetched RTT data — check once per station
    // rather than indexing into originRoutesData inside the loop.
    const dataCoords = new Set(Object.keys(originRoutesData))
    const out: SearchableStation[] = []
    // Bounding box for the primary-search dropdown. Wide enough to
    // include every station we have full RTT + TfL hop data for —
    // outer-belt commuter origins (Reading, Luton, St Albans, Watford
    // Junction) and airport rail-heads (Gatwick, Stansted) included.
    // Outliers defining the bounds: Gatwick (south), Stansted (north),
    // Reading (west), Shenfield (east).
    const isLondonBox = (lat: number, lng: number) =>
      lat > 51.10 && lat < 51.95 && lng > -1.05 && lng < 0.40
    for (const f of baseStations.features) {
      const crs = f.properties?.["ref:crs"] as string | undefined
      if (!crs) continue
      const [lng, lat] = f.geometry.coordinates
      if (!isLondonBox(lat, lng)) continue
      const network = f.properties?.["network"] as string | undefined
      // Include London Overground alongside NR/Elizabeth line — Overground
      // stations have real CRS codes and plenty serve areas where hikes are
      // reachable. Harrow & Wealdstone and Willesden Junction, which sit in
      // our curated recents seed, are Overground-only in OSM and were
      // invisible to search before this was widened.
      if (!network || !/National Rail|Elizabeth line|London Overground/.test(network)) continue
      const coord = `${lng},${lat}`
      if (excludedPrimariesSet.has(coord)) continue
      const stationName = f.properties.name as string
      // Resolve to the parent cluster primary if this coord is a cluster
      // member. clusterMemberToPrimary deliberately excludes synthetic
      // clusters (London "Any London terminus") so a search for "kings
      // cross" maps to the KX primary, not the London-synthetic.
      const primaryCoord = clusterMemberToPrimary[coord] ?? coord
      const hasCluster = !!PRIMARY_ORIGIN_CLUSTER[primaryCoord]
      const displayLabel = hasCluster
        ? (PRIMARY_ORIGINS[primaryCoord]?.menuName ?? stationName)
        : stationName
      // Check primaryCoord first so cluster members (St Pancras, Waterloo
      // East, etc.) inherit their parent's data status — picking St Pancras
      // redirects to the KX primary, which has data.
      const hasData = dataCoords.has(primaryCoord) || dataCoords.has(coord)
      out.push({
        coord,
        name: stationName,
        crs,
        primaryCoord,
        displayLabel,
        hasData,
      })
    }
    return out
  }, [baseStations, excludedPrimariesSet, clusterMemberToPrimary])
  // Coord → display name lookup — used to render the recents list in the
  // filter-panel dropdown, and to show the custom primary's name in the
  // trigger / map label. Same source data as searchableStations.
  const coordToName = useMemo(() => {
    const map: Record<string, string> = {}
    for (const s of searchableStations) map[s.coord] = s.name
    return map
  }, [searchableStations])

  // Cluster-member → anchor lookup for friend origins. Mirrors
  // clusterMemberToPrimary on the friend side so picking a cluster
  // member (e.g. Birmingham Moor Street, Cardiff Queen Street) via
  // friend search activates the parent cluster rather than the
  // individual station.
  const friendClusterMemberToPrimary = useMemo(() => {
    const map: Record<string, string> = {}
    for (const [anchor, members] of Object.entries(FRIEND_ORIGIN_CLUSTER)) {
      for (const m of members) map[m] = anchor
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
    }
    const friendAnchors = new Set(Object.keys(FRIEND_ORIGINS))
    const out: SearchableStation[] = []
    for (const f of baseStations.features) {
      const crs = f.properties?.["ref:crs"] as string | undefined
      if (!crs) continue
      const network = f.properties?.["network"] as string | undefined
      if (!network || !/National Rail|Elizabeth line|London Overground/.test(network)) continue
      const [lng, lat] = f.geometry.coordinates
      const coord = `${lng},${lat}`
      const stationName = f.properties.name as string
      // Cluster members redirect to their anchor for selection. The
      // displayed label still uses the cluster's menuName (e.g.
      // 'Birmingham') rather than the station's own OSM name (e.g.
      // 'Birmingham Moor Street') so search results dedupe naturally.
      const anchorCoord = friendClusterMemberToPrimary[coord] ?? coord
      const hasData = friendAnchors.has(anchorCoord)
      const displayLabel = hasData && FRIEND_ORIGINS[anchorCoord]?.menuName
        ? (FRIEND_ORIGINS[anchorCoord]?.menuName as string)
        : stationName
      out.push({
        coord,
        name: stationName,
        crs,
        primaryCoord: anchorCoord,
        displayLabel,
        hasData,
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
      const name = ALL_ORIGINS[key]?.canonicalName ?? coordToName[key] ?? key
      out[name] = value
    }
    return out
  }, [displayStation?.journeys, coordToName])

  // Derived stations — overrides londonMinutes when primaryOrigin isn't Farringdon,
  // so slider filtering and Mapbox labels show the selected origin's travel times.
  // Recomputes when the user switches origin via the dropdown, without re-fetching.
  // Heavy routing pass — computes journeys, alt routes, effective
  // minutes, etc. for every feature against the active primary.
  // Deliberately NOT dependent on excludedStations: the flag is applied
  // in a cheap downstream useMemo so admin toggles don't re-trigger
  // this expensive pass (~10s stall).
  const routedStations = useMemo(() => {
    if (!baseStations) return null
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
              nextProps.journeys = {
                ...((f.properties as Record<string, unknown>).journeys as Record<string, unknown> | undefined),
                ...(v as Record<string, unknown>),
              }
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
    const crsToCoord: Record<string, [number, number]> = {}
    const crsToStation: Record<string, { name: string; coord: [number, number]; coordKey: string; isLondon: boolean }> = {}
    for (const f of baseStations.features) {
      const crs = f.properties?.["ref:crs"] as string | undefined
      if (!crs) continue
      const [lng, lat] = f.geometry.coordinates as [number, number]
      crsToCoord[crs] = [lng, lat]
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
          if (station.coordKey === primaryOrigin) return null
          const sub = winnerRoutes?.directReachable?.[station.coordKey]
          if (!sub) return null
          return { name: nicerTerminusName(station.name, crs), crs, minutesFromOrigin: sub.minMinutes }
        })
        .filter((p): p is { name: string; crs: string; minutesFromOrigin: number } => !!p)
      const upstream = (entry.upstreamCallingPoints ?? [])
        .map((u) => {
          const station = crsToStation[u.crs]
          if (!station || !station.isLondon) return null
          // Same reason as downstream — skip the primary origin.
          if (station.coordKey === primaryOrigin) return null
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
      boardAtCoord: string,
      destCoord: string,
    ): { downstream: { name: string; crs: string; minutesFromOrigin: number }[]
       ; upstream: { name: string; crs: string; minutesExtra: number }[] } | null => {
      for (const donorCoord of Object.keys(originRoutes)) {
        const donor = originRoutes[donorCoord]
        const entry = donor?.directReachable?.[destCoord]
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
        const boardAtInUpstream = entry.upstreamCallingPoints?.find((u) => u.coord === boardAtCoord)
        let boardAtT: number | null = null
        if (boardAtInUpstream) {
          boardAtT = -boardAtInUpstream.minutesBeforeOrigin
        } else if (donorCoord === boardAtCoord) {
          boardAtT = 0
        } else {
          // Check fastestCallingPoints — see if boardAt coord appears as an
          // intermediate stop on the train from donor to destination.
          for (const crs of entry.fastestCallingPoints.slice(1, -1)) {
            const station = crsToStation[crs]
            if (station && station.coordKey === boardAtCoord) {
              const sub = donor?.directReachable?.[boardAtCoord]
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
        const routeStations: Array<{ name: string; crs: string; coordKey: string; tDonor: number }> = []
        // Upstream of donor (negative tDonor).
        for (const u of entry.upstreamCallingPoints ?? []) {
          const station = crsToStation[u.crs]
          if (!station) continue
          routeStations.push({ name: u.name, crs: u.crs, coordKey: station.coordKey, tDonor: -u.minutesBeforeOrigin })
        }
        // Donor itself at tDonor = 0.
        routeStations.push({
          name: donor?.name ?? "",
          crs: donor?.crs ?? "",
          coordKey: donorCoord,
          tDonor: 0,
        })
        // Intermediate stops between donor and destination.
        for (const crs of entry.fastestCallingPoints.slice(1, -1)) {
          const station = crsToStation[crs]
          if (!station) continue
          const sub = donor?.directReachable?.[station.coordKey]
          if (!sub) continue
          routeStations.push({ name: station.name, crs, coordKey: station.coordKey, tDonor: sub.minMinutes })
        }
        // Destination itself (will be filtered out below — it IS the target).
        // routeStations.push({ ..., tDonor: destT })

        // Classify each station relative to boardAt.
        const downstream: { name: string; crs: string; minutesFromOrigin: number }[] = []
        const upstream: { name: string; crs: string; minutesExtra: number }[] = []
        for (const s of routeStations) {
          // Skip boardAt, destination, and primary-origin.
          if (s.coordKey === boardAtCoord) continue
          if (s.coordKey === destCoord) continue
          if (s.coordKey === primaryOrigin) continue
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
      terminalCoord: string,
      destCoord: string,
      xTimeRelativeToP: number,
    ): { downstream: { name: string; crs: string; minutesFromOrigin: number }[]
       ; upstream: { name: string; crs: string; minutesExtra: number }[] } | null => {
      const winnerRoutes = originRoutes[terminalCoord]
      const entry = winnerRoutes?.directReachable?.[destCoord]
      if (!entry) return null

      // Build a flat list: every station on the train (except D) with its
      // time relative to P. Positive = after P, negative = before P.
      const route: Array<{ name: string; coord: string; crs: string; tP: number }> = []

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
        coord: terminalCoord,
        crs: terminalCrs,
        tP: 0,
      })

      // Upstream of P — stations the train calls at BEFORE reaching P.
      // tP is NEGATIVE (the earlier the stop, the more negative).
      for (const u of entry.upstreamCallingPoints ?? []) {
        const station = crsToStation[u.crs]
        if (!station) continue
        route.push({
          name: u.name,
          coord: station.coordKey,
          crs: u.crs,
          tP: -u.minutesBeforeOrigin,
        })
      }

      // Intermediate stops (between P and D). fastestCallingPoints[0] is P
      // (already pushed above); last entry is D (skip). tP is POSITIVE and
      // comes from the terminal's own directReachable[intermediate coord].
      for (const crs of entry.fastestCallingPoints.slice(1, -1)) {
        const station = crsToStation[crs]
        if (!station) continue
        const sub = winnerRoutes.directReachable?.[station.coordKey]
        if (!sub) continue
        route.push({ name: station.name, coord: station.coordKey, crs, tP: sub.minMinutes })
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
        if (s.coord === primaryOrigin) continue
        const [lngStr, latStr] = s.coord.split(",")
        const sLng = parseFloat(lngStr)
        const sLat = parseFloat(latStr)
        if (!isLondonBox(sLat, sLng)) continue
        const delta = s.tP - xTimeRelativeToP
        if (delta < 0) upstream.push({ name: s.name, crs: s.crs, minutesExtra: -delta })
        else if (delta > 0) downstream.push({ name: s.name, crs: s.crs, minutesFromOrigin: delta })
      }
      return { downstream, upstream }
    }

    // Custom-primary prep. When the user picks an NR station that isn't in
    // PRIMARY_ORIGINS (via the dropdown search), there are no pre-fetched
    // journeys for it. We derive approximate times using RTT data from the
    // curated primaries as a transfer hub:
    //   total(custom → D) ≈ P→custom + P→D + interchange
    //   where P is the fastest curated primary that direct-reaches both.
    // P→custom and P→D both come from originRoutes[P].directReachable.
    // Train times on the NR are roughly symmetric so reversing P→custom to
    // get custom→P is a safe approximation. The interchange buffer covers
    // the walk + wait at P.
    const isCustomPrimary = !PRIMARY_ORIGINS[primaryOrigin]
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
    ): { journey: JourneyInfo; mins: number; changes: number } | null {
      const hopRow = terminalMatrix[primaryName]
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
            const tToDCoords = (tToD.fastestCallingPoints ?? [])
              .map((crs) => crsToCoord[crs])
              .filter((c): c is [number, number] => !!c)
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
      for (const [pCoord, routes] of Object.entries(originRoutes)) {
        const entry = routes?.directReachable?.[primaryOrigin]
        if (entry?.minMinutes != null) {
          customHubs.push({ pCoord, pToCustomMins: entry.minMinutes, routes })
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
    for (const k of Object.keys(PRIMARY_ORIGINS)) {
      if (PRIMARY_ORIGINS[k]?.isSynthetic) continue
      londonTerminalCoords.push(k)
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
        const primaryName = PRIMARY_ORIGINS[primaryOrigin]?.canonicalName ?? primaryOrigin
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
        if (isRttPrimary) {
          for (const ck of clusterCoords) {
            const entry = originRoutes[ck]
            const candidate = entry?.directReachable?.[coordKey]
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
            const frn = originRoutes[FARRINGDON_COORD]?.directReachable?.[coordKey]
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
            if (PRIMARY_ORIGINS[primaryOrigin]?.isSynthetic) {
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
            // cluster member (rttReachableOriginCoord).
            const cp = rttReachableOriginCoord
              ? buildCallingPoints(rttReachableOriginCoord, coordKey)
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
            let canonical = PRIMARY_ORIGINS[ck]?.canonicalName
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
          if (primaryOrigin === coordKey) {
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
            const viaHub = buildViaDirectHubJourney(
              customHubs,
              coordKey,
              coordToName[primaryOrigin] ?? primaryOrigin,
              primaryOrigin,
            )
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
            const viaWalk = tryComposeViaWalkingDoubleHub(
              customHubs,
              coordKey,
              coordToName[primaryOrigin] ?? primaryOrigin,
              primaryOrigin,
            )
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
            const viaTflHop = tryComposeViaPrimaryHop(
              coordToName[primaryOrigin] ?? primaryOrigin,
              coordKey,
              primaryOrigin,
            )
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
            const selfEntry = originRoutes[primaryOrigin]?.directReachable?.[coordKey]
            if (selfEntry) {
              const cp = buildCallingPoints(primaryOrigin, coordKey)
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
          } else if (originRoutes[primaryOrigin]?.directReachable?.[coordKey]?.minMinutes != null) {
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
            const selfEntry = originRoutes[primaryOrigin]!.directReachable[coordKey]
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
            const cp = buildCallingPoints(primaryOrigin, coordKey)
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
            for (const terminalCoord of Object.keys(originRoutes)) {
              const entry = originRoutes[terminalCoord]?.directReachable?.[coordKey]
              if (!entry) continue
              const pToDestMins = entry.minMinutes

              // Upstream: X is before P. Match by coord (upstreamCallingPoints
              // carries a pre-formatted "lng,lat" string).
              const upstreamMatch = entry.upstreamCallingPoints?.find(
                (u) => u.coord === primaryOrigin,
              )
              if (upstreamMatch) {
                const mins = pToDestMins + upstreamMatch.minutesBeforeOrigin
                if (sameTrainMins == null || mins < sameTrainMins) {
                  sameTrainMins = mins
                  sameTrainTerminalCoord = terminalCoord
                  // X is BEFORE P → negative tP.
                  sameTrainXTimeRelativeToP = -upstreamMatch.minutesBeforeOrigin
                }
                continue
              }

              // Intermediate: X is between P and D on fastestCallingPoints.
              // Excludes first (= P) and last (= D) entries; either of those
              // would mean X is the terminal or the destination, neither
              // gives us a new same-train shortcut.
              const fastCP = entry.fastestCallingPoints
              const isIntermediate = fastCP.slice(1, -1).some((crs) => {
                const c = crsToCoord[crs]
                return c && `${c[0]},${c[1]}` === primaryOrigin
              })
              if (isIntermediate) {
                // P→X time comes from P's OWN directReachable[X] entry,
                // which every intermediate stop on P's line should have
                // (Old Street gets its own MOG→OLD entry with minMins=2).
                const pToX = originRoutes[terminalCoord]?.directReachable?.[primaryOrigin]?.minMinutes
                if (pToX != null) {
                  const mins = pToDestMins - pToX
                  if (mins > 0 && (sameTrainMins == null || mins < sameTrainMins)) {
                    sameTrainMins = mins
                    sameTrainTerminalCoord = terminalCoord
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
              const cp = sameTrainTerminalCoord != null && sameTrainXTimeRelativeToP != null
                ? buildSameTrainCallingPoints(sameTrainTerminalCoord, coordKey, sameTrainXTimeRelativeToP)
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
              if (sameTrainTerminalCoord != null) {
                const winnerEntry = originRoutes[sameTrainTerminalCoord]?.directReachable?.[coordKey]
                const fastCP = winnerEntry?.fastestCallingPoints ?? []
                if ((sameTrainXTimeRelativeToP ?? 0) >= 0) {
                  // Intermediate — slice fastCP from X forward.
                  const idxX = fastCP.findIndex((crs) => {
                    const c = crsToCoord[crs]
                    return c && `${c[0]},${c[1]}` === primaryOrigin
                  })
                  if (idxX > -1) {
                    const sliced = fastCP.slice(idxX)
                      .map((crs) => crsToCoord[crs])
                      .filter((c): c is [number, number] => !!c)
                    if (sliced.length > 1) stPolylineCoords = sliced
                  }
                } else {
                  // Upstream — prepend X's coord to the full P→D chain.
                  const { lng: xLng, lat: xLat } = parseCoordKey(primaryOrigin)
                  const pToDestCoords = fastCP
                    .map((crs) => crsToCoord[crs])
                    .filter((c): c is [number, number] => !!c)
                  if (pToDestCoords.length > 0) {
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
              const pToD = hub.routes.directReachable?.[coordKey]?.minMinutes
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
                for (const [sourceCoord, journey] of Object.entries(featureJourneys)) {
                  if (!journey?.durationMinutes) continue
                  if (sourceCoord === hub.pCoord) continue  // already covered by Option B
                  // Find the terminal name of this source-journey origin.
                  // Source coords come from stations.json entries we fetched
                  // Google Routes from (Farringdon, KX NR, Stratford, …).
                  const srcStationFeat = baseStations.features.find(
                    (x) => `${x.geometry.coordinates[0]},${x.geometry.coordinates[1]}` === sourceCoord,
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
            {
              const composed = tryComposeViaTerminal(
                f,
                customHubs,
                coordToName[primaryOrigin] ?? primaryOrigin,
                primaryOrigin,
              )
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
              const viaWalk = tryComposeViaWalkingDoubleHub(
                customHubs,
                coordKey,
                coordToName[primaryOrigin] ?? primaryOrigin,
                primaryOrigin,
              )
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
              const viaTflHop = tryComposeViaPrimaryHop(
                coordToName[primaryOrigin] ?? primaryOrigin,
                coordKey,
                primaryOrigin,
              )
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
              const { lng: pLng, lat: pLat } = parseCoordKey(primaryOrigin)
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
                const hubEntry = winner.hub.routes.directReachable?.[coordKey]
                const hubEntryName = hubEntry?.name ?? ""
                const cp = buildCallingPoints(winner.hub.pCoord, coordKey)
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
                const { lng: hLng, lat: hLat } = parseCoordKey(winner.hub.pCoord)
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
              const entry = originRoutes[tc]?.directReachable?.[coordKey]
              if (!entry) continue
              const upstreamMatch = entry.upstreamCallingPoints?.find(
                (u) => u.coord === primaryOrigin,
              )
              if (upstreamMatch) {
                terminalCoord = tc
                xTimeRelativeToP = -upstreamMatch.minutesBeforeOrigin
                break
              }
              const isIntermediate = entry.fastestCallingPoints.slice(1, -1).some((crs) => {
                const c = crsToCoord[crs]
                return c && `${c[0]},${c[1]}` === primaryOrigin
              })
              if (isIntermediate) {
                const pToX = originRoutes[tc]?.directReachable?.[primaryOrigin]?.minMinutes
                if (pToX != null) {
                  terminalCoord = tc
                  xTimeRelativeToP = pToX
                  break
                }
              }
            }
            if (terminalCoord != null && xTimeRelativeToP != null) {
              const cp = buildSameTrainCallingPoints(terminalCoord, coordKey, xTimeRelativeToP)
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
        // then stash routing results. The isExcluded flag is
        // intentionally NOT applied here — it gets applied in a
        // separate thin useMemo downstream (see
        // `allStationsWithRatings` below) so toggling it doesn't
        // force this heavy routing pass to re-run.
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
        if (primaryOrigin === "-0.1269,51.5196") {
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
              const entry = tRoutes.directReachable?.[coordKey]
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
              const cp = buildCallingPoints(tCoord, coordKey)
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
            const isInZone1 = (coord: string) => {
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
                const hToD = hRoutes.directReachable?.[coordKey]
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

  // Thin wrapper that applies the isExcluded flag per feature. Cheap
  // (a single Set.has + object spread per feature, no routing work),
  // so toggling via admin actions is instant.
  const stations = useMemo(() => {
    if (!routedStations) return null
    return {
      ...routedStations,
      features: routedStations.features.map((f) => {
        const coordKey = f.properties.coordKey as string
        const isExcluded = excludedStations.has(coordKey)
        // Skip allocation if nothing's changing — most features stay
        // plain on every toggle.
        const hadExcluded = !!f.properties.isExcluded
        if (isExcluded === hadExcluded) return f
        const next: Record<string, unknown> = { ...f.properties }
        if (isExcluded) next.isExcluded = true; else delete next.isExcluded
        return { ...f, properties: next as typeof f.properties }
      }),
    }
  }, [routedStations, excludedStations])

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
        if (friendOrigin && (f.properties.coordKey as string) === friendOrigin) return true

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
          if (primaryFeatureFilter === "private-notes") {
            const entry = stationNotes[f.properties.coordKey as string]
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
            return !stationsHiked.has(f.properties.coordKey as string)
          }
          if (primaryFeatureFilter === "komoot") {
            return stationsWithKomoot.has(f.properties.coordKey as string)
          }
          // "Issues" — admin-flagged stations only. hasIssue is station-global
          // (set keyed by coordKey alone), so no primary-origin lookup needed.
          if (primaryFeatureFilter === "issues") {
            return issueStations.has(f.properties.coordKey as string)
          }
          // "No travel data" — destinations with no journey-time data
          // (londonMinutes is null). Only effective when the time sliders
          // are unconstrained, since passesTimeFilter() above already hides
          // null-time stations under any explicit constraint.
          if (primaryFeatureFilter === "no-travel-data") {
            return mins == null
          }
          // "Oyster" — TfL fare-area stations. Includes Underground / DLR /
          // Elizabeth (any Z-prefix CRS) plus the curated NR list in
          // data/oyster-stations.json. Pulls in even no-RTT-data stations
          // (Underground, DLR), so the auto-time-slider-open in the
          // dropdown handler is what makes them visible on the map.
          if (primaryFeatureFilter === "oyster") {
            const crs = f.properties["ref:crs"] as string | undefined
            if (!crs) return false
            return crs.startsWith("Z") || OYSTER_NR_CRS.has(crs)
          }
          return true
        }

        // Excluded stations: admin-only, and now respect the time sliders so
        // admins can narrow the view to excluded stations in a specific band.
        // The direct-only checkbox applies here too — an excluded station with
        // no direct-train data from the primary origin shouldn't appear even
        // in admin mode when "Direct trains only" is ticked.
        if (f.properties.isExcluded) {
          // Active friend origin always shows even if excluded — the user
          // just picked it as their origin, so it must be visible on the map.
          if (friendOrigin && (f.properties.coordKey as string) === friendOrigin) return true
          if (!devExcludeActive) return false
          if (!passesTimeFilter()) return false
          if (primaryDirectOnly) {
            const primaryChanges = f.properties.effectiveChanges as number | undefined
            if (primaryChanges == null || primaryChanges > 0) return false
          }
          // Apply the admin Feature filter to excluded stations too —
          // narrowing filters like "Komoot" or "Undiscovered" should
          // respect their criterion regardless of exclusion status.
          if (!passesFeatureFilter()) return false
          return true
        }

        // Regular destination stations — must have time data in range,
        // EXCEPT in admin mode where stations with no journey data
        // (Sheringham etc. — too far for the Google Routes fetch
        // budget) can still appear. They show ONLY when both time
        // sliders are unconstrained, so moving either slider actually
        // filters these stations out the way an admin expects.
        // Non-admin users stay filtered — no time info = no action.
        //
        // PREVIOUSLY this early-returned true and silently skipped the
        // Feature / Season filters below. That meant the admin's
        // "Oyster" / "Issues" / etc. selections had no effect on
        // null-time stations (e.g. Claverdon CLV would show under any
        // Feature filter). Now we just gate the time check and fall
        // through to the rest of the filter chain.
        if (mins == null) {
          if (!devExcludeActive) return false
          if (maxMinutes < 600 || minMinutes > 0) return false
          // fall through to the remaining filters (direct, interchange,
          // feature, season) so Feature/Season selections still apply.
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
        // Season filters. Two independent filters both look up this
        // station's recommended seasons in stationSeasons:
        //   • seasonFilter (admin dropdown) — hides stations whose seasons
        //     don't include the selected value.
        //     Special case: "None" INVERTS the match — keeps only stations
        //     with zero month-flagged walks (missing entry OR empty array),
        //     useful for finding destinations that still need seasonality
        //     data.
        //   • currentSeasonHighlight (public checkbox) — hides stations
        //     whose seasons don't include the current calendar season.
        // AND semantics — both apply when both are active.
        if (seasonFilter !== "off" || currentSeasonHighlight) {
          const entry = stationSeasons[f.properties.coordKey as string]
          const seasons = entry?.seasons ?? []
          if (seasonFilter === "None") {
            if (seasons.length > 0) return false
          } else if (seasonFilter !== "off" && !seasons.includes(seasonFilter)) {
            return false
          }
          if (currentSeasonHighlight && !seasons.includes(currentSeason())) return false
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
  }, [stations, maxMinutes, minMinutes, friendOrigin, friendMaxMinutes, devExcludeActive, primaryOrigin, primaryDirectOnly, primaryInterchangeFilter, primaryFeatureFilter, stationNotes, curations, interchangeLookups, friendDirectOnly, seasonFilter, currentSeasonHighlight, stationSeasons, stationsHiked, stationsWithKomoot, OYSTER_NR_CRS, issueStations])

  // Further filter by search query when 3+ characters are typed.
  // We keep this separate from filteredStations so the travel-time filter is unaffected.
  const displayedStations = useMemo(() => {
    if (!filteredStations) return null
    if (!isSearching) return filteredStations
    const q = searchQuery.toLowerCase()
    return {
      ...filteredStations,
      features: filteredStations.features.filter((f) => {
        // Match on station name (substring) OR CRS code (3-letter code,
        // matched as a prefix so typing "swl" finds Swale, "swa" finds
        // Swansea/Swanley/etc., but a single letter doesn't drag in
        // every code starting with it via `includes`).
        const name = (f.properties.name as string).toLowerCase()
        if (name.includes(q)) return true
        const crs = (f.properties["ref:crs"] as string | undefined)?.toLowerCase()
        return !!crs && crs.startsWith(q)
      }),
    }
  }, [filteredStations, isSearching, searchQuery])

  // Stamps each feature with its rating but does NOT filter by visibleRatings.
  // Filtering happens in stationsForMap so we can keep leaving features during their animation.
  //
  // Also stamps `isCuratedExcluded` on excluded stations that nonetheless
  // carry meaning: those with any rating (Probably/Okay/Good/Heavenly)
  // or that sit in PRIMARY_ORIGINS / PRIMARY_ORIGIN_CLUSTER. Admin-only
  // visual cue — drives a diamond marker instead of the cross.
  const allStationsWithRatings = useMemo(() => {
    if (!displayedStations) return null
    return {
      ...displayedStations,
      features: displayedStations.features.map(f => {
        const coordKey = f.properties.coordKey as string
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
          if (coordKey === friendOrigin) extra.isFriendOrigin = 1
        }
        // Curated-excluded marker — only applies to already-excluded
        // stations. A rated excluded station, or one that's a primary
        // origin / cluster sibling, gets the curated marker.
        if (f.properties.isExcluded) {
          const isPrimaryOrCluster =
            coordKey in PRIMARY_ORIGINS ||
            Object.values(PRIMARY_ORIGIN_CLUSTER).some((arr) => arr.includes(coordKey))
          if (r || isPrimaryOrCluster) extra.isCuratedExcluded = true
        }
        if (Object.keys(extra).length === 0) return f
        return { ...f, properties: { ...f.properties, ...extra } }
      }),
    }
  }, [displayedStations, ratings, friendOrigin])

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
    const primaryDef = PRIMARY_ORIGINS[primaryOrigin]
    if (!primaryDef?.isSynthetic) return null
    const clusterCoords = PRIMARY_ORIGIN_CLUSTER[primaryOrigin] ?? []
    type PointFeature = {
      type: "Feature"
      geometry: { type: "Point"; coordinates: [number, number] }
      properties: Record<string, unknown>
    }
    const iconFeatures: PointFeature[] = []
    for (const coord of clusterCoords) {
      const [lngStr, latStr] = coord.split(",")
      const lng = parseFloat(lngStr)
      const lat = parseFloat(latStr)
      if (!Number.isFinite(lng) || !Number.isFinite(lat)) continue
      // Skip tube-only coords — the cluster includes Underground entrances
      // for Kings Cross and Euston as satellite coords so cluster-member
      // taps resolve to the parent primary, but visually we only want the
      // National Rail stations shown as waypoint diamonds. Identify tube-
      // only coords by their network tag.
      const bf = baseStations.features.find((f) => {
        const [l, a] = f.geometry.coordinates as [number, number]
        return `${l},${a}` === coord
      })
      const network = (bf?.properties?.network as string | undefined) ?? ""
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
        // Stamp coord + coordKey + name so the click handler can
        // resolve a diamond tap back to its station feature (via
        // baseStations) and open the stripped-down active-primary
        // modal. coordKey matches the same-named property on
        // regular station features — lets the existing click-to-
        // modal plumbing reuse the cluster-member branch.
        //
        // isTerminus tells resolveStationIconImage to use the diamond
        // icon for the hover pulse animation — without this, the
        // pulse defaults to the unrated circle because the feature
        // has no rating/isLondon properties.
        properties: {
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
    const friendDef = FRIEND_ORIGINS[friendOrigin]
    if (!friendDef?.isSynthetic) return null
    const clusterCoords = FRIEND_ORIGIN_CLUSTER[friendOrigin] ?? []
    type PointFeature = {
      type: "Feature"
      geometry: { type: "Point"; coordinates: [number, number] }
      properties: Record<string, unknown>
    }
    const iconFeatures: PointFeature[] = []
    for (const coord of clusterCoords) {
      const [lngStr, latStr] = coord.split(",")
      const lng = parseFloat(lngStr)
      const lat = parseFloat(latStr)
      if (!Number.isFinite(lng) || !Number.isFinite(lat)) continue
      const bf = baseStations.features.find((f) => {
        const [l, a] = f.geometry.coordinates as [number, number]
        return `${l},${a}` === coord
      })
      const network = (bf?.properties?.network as string | undefined) ?? ""
      const isNR = /National Rail|Elizabeth line/.test(network)
      if (!isNR) continue
      const nearPrevious = iconFeatures.some((f) => {
        const [l, a] = f.geometry.coordinates as [number, number]
        return (l - lng) ** 2 + (a - lat) ** 2 < 1e-6
      })
      if (nearPrevious) continue
      const rawName = bf?.properties?.name as string | undefined
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
          if (friendOrigin && (f.properties.coordKey as string) === friendOrigin) return true
          // Empty rating checkboxes = empty map. Falls straight through to
          // the per-category gates below, both of which return false when
          // visibleRatings + newlyRemovedRatings are both empty. Animations
          // still work because newlyRemovedRatings keeps a category visible
          // for the shrink-out frames after the user unchecks it.
          // Excluded stations (admin-only) — gated on the "excluded" checkbox.
          if (f.properties.isExcluded) {
            return visibleRatings.has('excluded') || newlyRemovedRatings.has('excluded')
          }
          const category = (f.properties.rating as string | undefined) ?? 'unrated'
          return visibleRatings.has(category) || newlyRemovedRatings.has(category)
        })
        .map(f => {
          const category = (f.properties.rating as string | undefined) ?? 'unrated'
          // Admin-only "hasIssue" flag — true when the station has been
          // explicitly flagged via the issue button. Station-global, so
          // the halo follows the station across primary switches. Computed
          // here (not in the filter layer) so the layer's `has` filter
          // can read a cheap boolean property.
          const coord = f.properties.coordKey as string
          const isDest = coord !== primaryOrigin
          const hasIssue = isDest && issueStations.has(coord)
          const base = hasIssue
            ? { ...f.properties, hasIssue: 1 }
            : f.properties
          if (newlyAddedRatings.has(category)) {
            return { ...f, properties: { ...base, isNew: 1 } }
          }
          if (newlyRemovedRatings.has(category)) {
            return { ...f, properties: { ...base, isLeaving: 1 } }
          }
          return { ...f, properties: base }
        }),
    }
  }, [allStationsWithRatings, visibleRatings, newlyAddedRatings, newlyRemovedRatings, friendOrigin, issueStations, primaryOrigin])

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
      seasonFilter,
      currentSeasonHighlight,
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
      if (f.properties.isExcluded) {
        if (!visibleRatings.has("excluded")) continue
      } else {
        const category = (f.properties.rating as string | undefined) ?? "unrated"
        if (!visibleRatings.has(category)) continue
      }
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
  }, [stationsForMap, primaryOrigin, friendOrigin, visibleRatings, maxMinutes, minMinutes, friendMaxMinutes, primaryDirectOnly, friendDirectOnly, primaryInterchangeFilter, primaryFeatureFilter, seasonFilter, currentSeasonHighlight, searchQuery])

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

  // Dev action: toggle a station's excluded status. Excluded stations are hidden
  // from normal users; in admin mode they appear as crosses when the "Excluded"
  // rating checkbox is on.
  // Admin-only "pending" toggles for exclude. We DELIBERATELY
  // do NOT update excludedStations state at runtime before — the
  // Set is the input to a big useMemo chain (stations →
  // filteredStations → displayedStations → allStationsWithRatings →
  // stationsForMap) and eventually Mapbox's setData which re-uploads
  // ~3700 features to the map source. That cycle takes 5-10s of UI
  // freeze on every toggle.
  //
  // Direct synchronous toggle: updates local state immediately so the
  // modal button + map icon flip on the same render. This cascades
  // through the heavy useMemo chain (routing → stations → filtered →
  // map features → Mapbox re-upload), which causes a multi-second
  // freeze on every toggle. Admin explicitly preferred the freeze-
  // plus-instant-feedback trade-off over the previous fire-and-
  // forget approach where the map only updated on next reload.
  const handleToggleExclusion = useCallback((name: string, coordKey: string) => {
    let nowExcluded = false
    setExcludedStations((prev) => {
      const next = new Set(prev)
      if (next.has(coordKey)) next.delete(coordKey); else next.add(coordKey)
      nowExcluded = next.has(coordKey)
      return next
    })
    const endpoint = nowExcluded ? "/api/dev/exclude-station" : "/api/dev/include-station"
    fetch(endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name, coordKey }),
    }).catch((err) => console.error("toggle-exclusion POST failed:", err))
  }, [])

  // Dev action: set or clear a station's universal rating via the API
  const handleRate = useCallback(async (coordKey: string, name: string, rating: Rating | null) => {
    // Optimistic update — apply locally before the API call completes
    setRatings((prev) => {
      const next = { ...prev }
      if (rating) { next[coordKey] = rating } else { delete next[coordKey] }
      return next
    })
    await fetch("/api/dev/rate-station", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ coordKey, name, rating }),
    })
  }, [])

  // Admin-only: toggle "approved for this home" for a (home, dest) pair.
  // Keyed by the composite "homeCoord|destCoord" string so the backing
  // file's JSON keys are unambiguous and lookups are O(1).
  const handleToggleIssue = useCallback(async (
    coordKey: string,
    name: string,
    hasIssue: boolean,
  ) => {
    setIssueStations((prev) => {
      const next = new Set(prev)
      if (hasIssue) next.add(coordKey); else next.delete(coordKey)
      return next
    })
    await fetch("/api/dev/has-issue-station", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ coordKey, name, hasIssue }),
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
    await fetch("/api/dev/curate-photo", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ coordKey, name, photoId: photo.id, action: "approve", photo }),
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
    await fetch("/api/dev/curate-photo", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ coordKey, name, photoId, action: "move", direction }),
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
    await fetch("/api/dev/curate-photo", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ coordKey, name, photoId, action: "unapprove" }),
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
    await fetch("/api/dev/curate-photo", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ coordKey, name, photoId: photo.id, action: "approveAtTop", photo }),
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
    await fetch("/api/dev/curate-photo", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ coordKey, name, photoId: photo.id, action: "pin", photo }),
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
    await fetch("/api/dev/curate-photo", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ coordKey, name, photoId, action: "unpin" }),
    })
  }, [])

  // Save public/private notes for a station — called when the overlay
  // closes. Walk prose (adminWalksAll / publicWalksS2S / publicWalksCircular
  // / publicWalksExtras) is build-only and preserved on the existing entry
  // by the API route, so we don't pass it in.
  const handleSaveNotes = useCallback(async (coordKey: string, name: string, publicNote: string, privateNote: string) => {
    // Optimistic update — preserve the build-output walk fields from
    // any existing entry so the optimistic state matches what the
    // server will produce.
    setStationNotes((prev) => {
      const existing = prev[coordKey]
      const hasAnyWalkProse = !!(
        existing?.adminWalksAll
        || existing?.publicWalksS2S
        || existing?.publicWalksCircular
        || existing?.publicWalksExtras
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
          publicWalksCircular: existing?.publicWalksCircular,
          publicWalksExtras: existing?.publicWalksExtras,
        },
      }
    })
    await fetch("/api/dev/station-notes", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ coordKey, name, publicNote, privateNote }),
    })
  }, [])

  // Save the free-form "rambler extras" for a station. Accepts the
  // full replacement array; empty array clears the entry. The server
  // trims + drops blanks and re-runs the build, so we also refetch
  // stationNotes afterwards to pick up the regenerated prose.
  const handleSaveRamblerExtras = useCallback(async (coordKey: string, lines: string[]) => {
    // Optimistic update of the local map so the photo-overlay
    // re-renders with the new list immediately. Server will strip
    // empties; mirror that here so the optimistic state matches.
    const cleaned = lines.map((s) => s.trim()).filter(Boolean)
    setRamblerExtras((prev) => {
      const next = { ...prev }
      if (cleaned.length === 0) delete next[coordKey]
      else next[coordKey] = cleaned
      return next
    })
    await fetch("/api/dev/station-rambler-extras", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ coordKey, lines: cleaned }),
    })
    // The server rebuilt station-notes.json as part of the write —
    // refetch so the overlay's ramblerNote prose reflects the change.
    const notes = await fetch("/api/dev/station-notes").then((r) => r.json())
    setStationNotes(notes)
  }, [])

  // Refresh stationNotes + stationSeasons after a structured walk edit.
  // The PATCH /api/dev/walk/[id] route re-runs the build server-side,
  // so we just need to pull the regenerated data back into the client
  // state — the overlay's ramblerNote prop will then update with the
  // new prose. Fire-and-forget, no optimistic update (the build
  // derives both files so there's no straightforward single-key patch).
  const refreshStationDerivedData = useCallback(async () => {
    const [notes, seasons] = await Promise.all([
      fetch("/api/dev/station-notes").then((r) => r.json()),
      fetch("/api/dev/station-seasons").then((r) => r.json()),
    ])
    setStationNotes(notes)
    setStationSeasons(seasons)
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
      await fetch("/api/dev/flickr-settings", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ coordKey, name, custom }),
      })
    },
    [],
  )

  // Save a global Flickr preset. Affects every station that uses this algo as
  // its default or fallback.
  const handleSavePreset = useCallback(
    async (name: "landscapes" | "hikes" | "station", preset: CustomSettings) => {
      setPresets((prev) => (prev ? { ...prev, [name]: preset } : prev))
      await fetch("/api/dev/flickr-presets", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name, preset }),
      })
    },
    [],
  )

  // Reset a global Flickr preset to its hardcoded default.
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
          // Stamp coordKey for consistent identity
          const extra: Record<string, unknown> = { coordKey }
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
  type JourneyWithGeom = { polyline?: string; polylineCoords?: [number, number][] }
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
  const preferGooglePolyline = (
    journeys: Record<string, JourneyWithGeom> | undefined,
    originKey: string,
  ): [number, number][] | null => {
    if (!journeys) return null
    const primaryJourney = journeys[originKey]
    if (primaryJourney?.polyline) return decodePolyline(primaryJourney.polyline)
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
    return preferGooglePolyline(journeys, primaryOrigin)
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
    if (!PRIMARY_ORIGINS[primaryOrigin]?.isSynthetic) return null
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
    return preferGooglePolyline(journeys, friendOrigin)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [friendOrigin, hovered, stations])

  // Whether the currently hovered station is the active friend origin —
  // used to show "liberate your friend" instead of travel times in the label
  const hoveredIsFriendOrigin = useMemo(() => {
    if (!friendOrigin || !hovered) return false
    const feature = stationsForMap?.features.find(
      f => (f.properties.coordKey as string) === hovered.coordKey
    )
    // friendOrigin is a coord key — compare against the feature's coordKey
    return (feature?.properties.coordKey as string) === friendOrigin
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
  const regionLabelsCollection = useMemo(() => {
    // Empty collection when the Regions toggle is off — keeps the Source
    // mounted in a stable position in the layer stack but renders nothing.
    if (!showRegions) {
      return { type: "FeatureCollection" as const, features: [] }
    }
    return {
      type: "FeatureCollection" as const,
      features: (regionLabelsData as Array<{ name: string; category: string; coord: [number, number] }>).map((r) => ({
        type: "Feature" as const,
        properties: { name: r.name, category: r.category },
        geometry: { type: "Point" as const, coordinates: r.coord },
      })),
    }
  }, [showRegions])
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
      }
      return
    }
    const coordKey = feature.properties?.coordKey as string
    // Only update state when the hovered station actually changes
    if (hoveredRef.current === coordKey) return
    hoveredRef.current = coordKey
    const [lng, lat] = (feature.geometry as unknown as { coordinates: [number, number] }).coordinates
    // `feature.properties` on a GeoJSON Feature is `Record<string, unknown> | null`,
    // but resolveStationIconImage takes `Record<string, unknown> | undefined`. Coerce
    // a null properties bag to undefined so the call type-checks — the helper treats
    // both the same way (no properties → "icon-unrated" default).
    setHovered({ lng, lat, coordKey, iconImage: resolveStationIconImage(feature.properties ?? undefined) })
    // Secret admin marker — ignore hover entirely (no cursor, no radius)
    if (feature.properties?.isSecretAdmin) {
      hoveredRef.current = null
      setHovered(null)
      setRadiusPos(null)
      return
    }
    // London marker and terminus diamonds shouldn't produce radius circles.
    // Hike-radii only make sense for destination stations — the hexagon is
    // the home origin, and the 18 cluster-terminus diamonds are anchors for
    // the journey polyline, neither are hiking destinations.
    if (feature.properties?.isLondon || feature.properties?.isTerminus) setRadiusPos(null)
    else setRadiusPos({ lng, lat })
  }, [])

  const handleMouseLeave = useCallback(() => {
    hoveredRef.current = null
    setHovered(null)
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
      if (p.isExcluded) return 1
      switch (p.rating) {
        case "highlight":
        case "verified":
        case "unverified":
        case "not-recommended":
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
  //   - On a regular station → toggle its exclusion (hide / re-show).
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
      handleToggleExclusion(name, coordKey)
      return
    }
    // Empty space — copy coord to clipboard.
    const coordKey = `${e.lngLat.lng.toFixed(2)},${e.lngLat.lat.toFixed(2)}`
    navigator.clipboard.writeText(coordKey).then(() => {
      setCoordCopied(true)
      setTimeout(() => setCoordCopied(false), 1000)
    }).catch(() => {/* clipboard blocked — silent fail */})
  }, [devExcludeActive, handleToggleExclusion])

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
      const friendDef = FRIEND_ORIGINS[friendOrigin]
      if (friendDef?.isSynthetic) {
        const [aLngStr, aLatStr] = friendOrigin.split(",")
        const aLng = parseFloat(aLngStr)
        const aLat = parseFloat(aLatStr)
        const pt = mapRef.current?.project([aLng, aLat])
        setSelectedStation({
          name: friendDef.displayName,
          lng: aLng,
          lat: aLat,
          minutes: 0,
          coordKey: friendOrigin,
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
    if (
      feature.layer?.id === "london-terminus-icon" ||
      feature.layer?.id === "london-terminus-origin-icon" ||
      feature.layer?.id === "friend-cluster-icon"
    ) {
      const diamondCoord = feature.properties?.coordKey as string | undefined
      // Determine which synthetic owns this diamond — the active primary or
      // the active friend. Members exclusively belong to one of the two
      // because diamonds are only mounted when their owning synthetic is
      // active, so a single owning-anchor lookup is unambiguous.
      const primaryDef = PRIMARY_ORIGINS[primaryOrigin]
      const primaryMembers = primaryDef?.isSynthetic
        ? (PRIMARY_ORIGIN_CLUSTER[primaryOrigin] ?? [])
        : []
      const friendDef = friendOrigin ? FRIEND_ORIGINS[friendOrigin] : undefined
      const friendMembers = friendOrigin && friendDef?.isSynthetic
        ? (FRIEND_ORIGIN_CLUSTER[friendOrigin] ?? [])
        : []
      let anchorCoord: string | null = null
      let anchorName: string | null = null
      if (diamondCoord && primaryMembers.includes(diamondCoord)) {
        anchorCoord = primaryOrigin
        anchorName = primaryDef?.displayName ?? null
      } else if (diamondCoord && friendOrigin && friendMembers.includes(diamondCoord)) {
        anchorCoord = friendOrigin
        anchorName = friendDef?.displayName ?? null
      }
      if (anchorCoord && anchorName) {
        const [aLngStr, aLatStr] = anchorCoord.split(",")
        const aLng = parseFloat(aLngStr)
        const aLat = parseFloat(aLatStr)
        const pt = mapRef.current?.project([aLng, aLat])
        setSelectedStation({
          name: anchorName,
          lng: aLng,
          lat: aLat,
          minutes: 0,
          coordKey: anchorCoord,
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

    // If the click landed on the enlarged hovered-hit layer, its feature only
    // carries { coordKey }. Resolve to the real station feature (with name,
    // journeys, etc.) so all downstream logic works normally.
    if (feature.layer?.id === "hovered-station-hit") {
      const hoveredCoordKey = feature.properties?.coordKey as string | undefined
      // Special case: the London hexagon's hovered form has coordKey "london"
      // (set by the source at the hexagon's origin coords). For a real-station
      // primary we resolve to that station's feature and let the normal modal
      // flow run. For a synthetic primary (e.g. City of London at Guildhall
      // with no station feature) we short-circuit and open the modal here,
      // using the primary's displayName — no "Station" suffix, no lookup.
      if (hoveredCoordKey === "london") {
        const primaryDef = PRIMARY_ORIGINS[primaryOrigin]
        if (primaryDef?.isSynthetic) {
          const pt = mapRef.current?.project([originCoords.lng, originCoords.lat])
          setSelectedStation({
            name: primaryDef.displayName,
            lng: originCoords.lng,
            lat: originCoords.lat,
            minutes: 0,
            coordKey: primaryOrigin,
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
          (f) => (f.properties as { coordKey?: string } | undefined)?.coordKey === primaryOrigin
        )
        if (primaryFeature) feature = primaryFeature as unknown as typeof feature
      } else {
        const real = stations?.features.find(
          (f) => (f.properties as { coordKey?: string } | undefined)?.coordKey === hoveredCoordKey
        )
        if (real) feature = real as unknown as typeof feature
      }
    }
    // Secret admin toggle — invisible marker at Boulogne-Tintelleries (France).
    // Dev-only: on production deployments the admin API is disabled at the
    // middleware layer, so we also refuse to flip the client-side state.
    // process.env.NODE_ENV is inlined at build time — this branch is dead-
    // code-eliminated from production bundles entirely.
    if (process.env.NODE_ENV === "development" && feature.properties?.isSecretAdmin) {
      // Boulogne (hidden secret-admin marker) toggles admin mode WITHOUT
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
      // Synthetic primaries (e.g. City of London) have no real station feature
      // to substitute — open the modal directly with the displayName as the
      // title (the StationModal will suppress its " Station" suffix via the
      // isSynthetic prop). Real-station primaries fall through to the feature-
      // substitution path below and take the normal modal flow.
      const primaryDef = PRIMARY_ORIGINS[primaryOrigin]
      if (primaryDef?.isSynthetic) {
        const pt = mapRef.current?.project([originCoords.lng, originCoords.lat])
        setSelectedStation({
          name: primaryDef.displayName,
          lng: originCoords.lng,
          lat: originCoords.lat,
          minutes: 0,
          coordKey: primaryOrigin,
          flickrCount: null,
          screenX: pt?.x ?? window.innerWidth / 2,
          screenY: pt?.y ?? window.innerHeight / 2,
        })
        return
      }
      const primaryFeature = stations?.features.find(
        (f) => (f.properties as { coordKey?: string } | undefined)?.coordKey === primaryOrigin
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
    // Scope to the active primary's cluster — a tap on a London cluster
    // member (e.g. Moorgate) when the active primary is Charing Cross is a
    // normal station tap, not a primary-dot tap.
    const isPrimaryDot =
      !!clickedCoordKey && getActivePrimaryCoords(primaryOrigin).includes(clickedCoordKey)
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
      flickrCount: feature.properties?.flickrCount as number | null ?? null,
      screenX: screenPt?.x ?? window.innerWidth / 2,
      screenY: screenPt?.y ?? window.innerHeight / 2,
      journeys,
    })
  }, [devExcludeActive, setMaxMinutes, setVisibleRatings, stations, primaryOrigin, originCoords, isTouchDevice])

  // Deep-link support: when the URL carries `?station=<coordKey>` (used
  // by the admin rambler-walks page to link station names straight to
  // their overlay), jump to that station and open its modal on mount.
  // Runs once per (mapReady, stations, route) trio — the `stations`
  // dep also covers routedStations being available. We then strip the
  // param from the URL so a reload doesn't silently re-open it.
  // URL-param handling for deep-links from the /admin/rambler-walks page.
  // Split across two effects so the admin-enable fires immediately on
  // mount (it doesn't need stations data) while the station modal waits
  // for the stations memo to populate. Otherwise ?admin=1 would only
  // take effect after the heavy routing memo finished, which can take
  // 5-10s on a cold page load and is wasted time.
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
    const coordKey = params.get("station")
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
    add('icon-highlight',       createRatingIcon('star',          colors.primary,   stroke))
    add('icon-verified',        createRatingIcon('triangle-up',   colors.primary,   stroke))
    add('icon-unrated',         createRatingIcon('circle',        colors.secondary, stroke))
    // Probably/unverified — primary colour (matches Heavenly/Good) so it
    // reads as a positive-curation tier. Previously secondary, which blurred
    // the visual line against the Unknown dot.
    add('icon-unverified',      createRatingIcon('hexagon',        colors.primary,   stroke))
    add('icon-not-recommended', createRatingIcon('triangle-down', colors.secondary, stroke))
    add('icon-origin',          createRatingIcon('square',        colors.primary,   stroke))
    add('icon-london',          createRatingIcon('square',        colors.primary,   stroke))
    // Small diamond used for the 18 London-terminus reference markers when
    // the Central London synthetic is the active primary. Rendered at ~0.6×
    // icon-size in the layer below so it reads as a compact waypoint.
    // Uses the SAME hardcoded #2f6544 (--tree-800) as the journey polyline
    // layers so the diamonds visually match the route lines drawn on top
    // — a visual "here's a terminus" anchor consistent with the polyline
    // that threads between them.
    add('icon-london-terminus', createRatingIcon('diamond',       "#2f6544",        stroke))
    // Excluded stations — only shown in admin mode. Uses --primary so the cross
    // reads with the same visual weight as Heavenly/Good/Origin markers.
    add('icon-excluded',        createRatingIcon('cross',         colors.primary,   stroke))
    // Curated-excluded: an admin-only variant of the excluded marker that
    // renders for excluded stations we nevertheless care about — ones
    // that carry a rating, or that act as a primary origin / cluster
    // sibling. Same Latin cross as `icon-excluded`, but drawn with a
    // thicker stroke; combined with the 2× icon-size (set on the layer),
    // it reads as a louder version of the cross — "excluded, yes, but
    // don't forget about this one".
    add('icon-curated-excluded', createRatingIcon('cross',        colors.primary,   stroke, { crossLineWidth: 6 }))
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
          setVisibleRatings(new Set(["highlight", "verified", "unverified", "not-recommended", "unrated", "excluded"]))
          setPrimaryInterchangeFilter("off")
          setPrimaryFeatureFilter("off")
          setSeasonFilter("off")
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
        searchQuery={searchQuery}
        onSearchChange={setSearchQuery}
        adminMode={devExcludeActive}
        bannerVisible={bannerVisible}
        primaryOrigin={primaryOrigin}
        // Pinned primary coords — always rendered at the top of the
        // dropdown, never evicted. Currently just Central London.
        pinnedPrimaries={PINNED_PRIMARIES}
        // Admin-only primary group, only rendered when adminMode is on.
        adminOnlyPrimaries={devExcludeActive ? ADMIN_ONLY_PRIMARIES : []}
        onPrimaryOriginChange={setPrimaryOrigin}
        // Both callbacks receive a coord key now. ALL_ORIGINS merges primary+friend
        // so the filter-panel can label either role with one callback.
        originDisplayName={(key) => ALL_ORIGINS[key]?.displayName ?? key}
        originMobileDisplayName={(key) => ALL_ORIGINS[key]?.mobileDisplayName}
        originMenuName={(key) => ALL_ORIGINS[key]?.menuName ?? key}
        searchableStations={searchableStations}
        // Merge user picks (prepended naturally by selectCustomPrimary)
        // with the curated defaults — picking a default just floats it
        // to the top, the others stay visible.
        recentPrimaries={[
          ...recentCustomPrimaries,
          ...DEFAULT_RECENT_PRIMARIES.filter((c) => !recentCustomPrimaries.includes(c)),
        ]}
        onCustomPrimarySelect={selectCustomPrimary}
        coordToName={coordToName}
        friendOrigin={friendOrigin}
        // Pinned friend coords — currently empty; reserved for future
        // always-visible picks.
        pinnedFriends={PINNED_FRIENDS}
        // Same merge pattern as the primary side.
        recentFriends={[
          ...recentCustomFriends,
          ...DEFAULT_RECENT_FRIENDS.filter((c) => !recentCustomFriends.includes(c)),
        ]}
        // Search universe for the friend dropdown — every UK NR station,
        // with hasData=false rows rendered as disabled 'Coming soon'.
        searchableFriendStations={searchableFriendStations}
        friendOrigins={FRIEND_ORIGIN_KEYS}
        onFriendOriginChange={setFriendOriginWithTransition}
        friendMaxMinutes={friendMaxMinutes}
        onFriendMaxMinutesChange={setFriendMaxMinutes}
        onActivateFriend={() => setFriendOriginWithTransition(FRIEND_ORIGIN_KEYS[0])}
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
        seasonFilter={seasonFilter}
        onSeasonFilterChange={setSeasonFilter}
        currentSeason={currentSeason()}
        currentSeasonHighlight={currentSeasonHighlight}
        onCurrentSeasonHighlightChange={setCurrentSeasonHighlight}
        friendDirectOnly={friendDirectOnly}
        onFriendDirectOnlyChange={setFriendDirectOnly}
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
            setBannerVisible(true)
          }}
        />
      </div>

      {/* Dev mode toggle + zoom badge — only rendered in local development.
          process.env.NODE_ENV is inlined at build time by Next.js, so this
          entire block is stripped from production bundles (dead-code elimination). */}
      {process.env.NODE_ENV === "development" && (
        // z-[60] keeps the admin bar on top of the StationModal dialog
        // (Radix renders its overlay + content at z-50), so the "admin"
        // toggle remains clickable while an overlay is showing — useful
        // for hopping out of admin without closing the current station.
        <div className="absolute bottom-4 left-1/2 z-[60] flex -translate-x-1/2 items-center gap-2">
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
              //       — "excluded" rating, min-time-from-London beyond
              //       what the non-admin slider exposes — or
              //   (b) are admin-only dropdowns (Feature, Interchange)
              //       whose current selection wouldn't make sense to a
              //       returning non-admin.
              // Everything else (visible ratings except excluded,
              // direct-only toggles, friend filters) stays put so the
              // admin's working state carries over.
              if (!next) {
                setVisibleRatings((prev) => {
                  if (!prev.has("excluded")) return prev
                  const copy = new Set(prev)
                  copy.delete("excluded")
                  return copy
                })
                setMinMinutes(0)
                setPrimaryInterchangeFilter("off")
                setPrimaryFeatureFilter("off")
                // Admin-only season dropdown — clear its selection on
                // admin-off so a returning non-admin doesn't see a
                // filtered map with no visible control.
                setSeasonFilter("off")
                if (maxMinutes > 150) setMaxMinutes(150)
              }
            }}
            className={`rounded px-2 py-1 font-mono text-xs text-white transition-colors ${
              devExcludeActive ? "bg-red-600/80" : "bg-black/40 hover:bg-black/60"
            }`}
          >
            {devExcludeActive ? "admin ✕" : "admin"}
          </button>
          {/* Zoom level indicator — only visible when dev mode is active */}
          {devExcludeActive && (
            <div className="pointer-events-none rounded bg-black/60 px-2 py-1 font-mono text-xs text-white">
              z {zoom.toFixed(1)}
            </div>
          )}
          {/* Cursor coord-key readout — admin-only, sibling of the zoom
              indicator. Shows "lng,lat" rounded to 4 decimals (≈11 m
              precision) — same shape as coordKey strings stored in
              excluded-stations.json, station-notes.json etc, so the value
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
          {/* Rambler walks admin page trigger — admin-only. Opens a
              standalone page showing extraction status for every walk
              on walkingclub.org.uk (extracted / onMap / issues). */}
          {devExcludeActive && (
            <a
              href="/admin/rambler-walks"
              target="_blank"
              rel="noopener noreferrer"
              className="rounded bg-black/40 px-2 py-1 font-mono text-xs text-white transition-colors hover:bg-black/60"
            >
              walks
            </a>
          )}
          {/* Clear-session step is now part of the combined
              "Regenerate" button below — it wipes ttg:* localStorage
              before kicking off the per-primary regen loop. No
              standalone Clear-session button any more. */}
          {/* Regenerate — admin-only. A single button that:
                1. Wipes ttg:* localStorage (formerly the standalone
                   "Clear session" button) so testing starts fresh.
                2. For each slug in PRIMARY_SLUG:
                   - deletes the existing on-disk snapshot so runtime
                     can't short-circuit to stale data
                   - switches primary to that coord + flags the
                     precompute cache as bypassed
                   - waits for the routing memo to live-compute (~10s)
                   - builds a lean diff from the fresh routedStations
                     (simplified polylines + only fields routing
                     added/changed) + POSTs to /api/dev/save-routing
                3. Restores the admin's original primary and clears
                   the bypass flag.
              When to use: after changing routing logic OR upstream
              data (origin-routes.json, excluded stations, …) so the
              cheat-sheet files reflect the new output. */}
          {devExcludeActive && (
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
              title="Delete + regenerate all precomputed routing files"
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
          )}
        </div>
      )}

      {/* RTT status modal — mounted always so its Dialog's portal is
          ready, but `open` is driven by the admin-only button above. */}
      <RTTStatusPanel open={rttStatusOpen} onOpenChange={setRttStatusOpen} />

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
        // Bounding box that covers England — prevents panning to Europe, open sea, etc.
        // Format: [[west, south], [east, north]] in longitude/latitude
        // west: higher numbers cut more off
        // south: higher numbers cut more off
        // east: lower numbers cut more off
        // north: lower numbers cut more off
        maxBounds={[[-6.5, 49.5], [2.5, 56.0]]}
        // interactiveLayerIds tells Mapbox which layers fire mouse events.
        // Without this, onMouseEnter/[[-4.0, 50.0], [2.0, 54.0]]Leave won't receive feature data.
        // Both layers are interactive so rated stations (icons) are also hoverable/clickable
        interactiveLayerIds={[
          "hovered-station-hit", "station-hit-area", "london-hit-area", "secret-admin-hit",
          // Terminus diamonds open the same stripped-down station modal
          // that other active-primary cluster members get (title + photos
          // only, no journey info, no Hike button). Both main (zoom 9+)
          // and origin-overlay layers are interactive so the diamond
          // works at every zoom level where it's visible.
          "london-terminus-icon", "london-terminus-origin-icon", "friend-cluster-icon",
          "friend-anchor-icon", "friend-anchor-hit",
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

        {/* Secret admin toggle — invisible tap target at Boulogne-Tintelleries
            (France, across the Channel). Same pattern as the London hit area but
            with zero visual presence. Always mounted so it works in production. */}
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

        {/* London-terminus reference markers — only when Central London is
            the active primary. Placed BEFORE the stations Source so they
            render beneath every station icon / label (bottom-most z-index —
            the user's rule: "they should not obscure anything"). Neither
            layer is wired into interactiveLayerIds, so clicks pass straight
            through to whatever's underneath. */}
        {PRIMARY_ORIGINS[primaryOrigin]?.isSynthetic && londonTerminusFeatures && (
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
              {/* Hover label — shows the terminus name for the currently-
                  hovered diamond at ANY zoom (below the minzoom of the
                  base label layer above). Filter matches by coordKey,
                  which comes either from this source's 18 diamond
                  features (zoom 9+) or from the origin-overlay source
                  below (at any zoom — that source mirrors coordKey on
                  its feature for exactly this reason). */}
              {hovered?.coordKey && (
                <Layer
                  id="london-terminus-icon-hover-label"
                  type="symbol"
                  /* eslint-disable @typescript-eslint/no-explicit-any */
                  filter={["==", ["get", "coordKey"], hovered.coordKey] as any}
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
              )}
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
        {friendOrigin && FRIEND_ORIGINS[friendOrigin]?.isSynthetic && friendClusterFeatures && (
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
                filter={["has", "hasIssue"]}
                paint={{
                  "circle-color": "#dc2626", // red-600 — matches admin exclude cross
                  "circle-radius": 10,
                  "circle-opacity": 0.55,
                  "circle-stroke-color": "#dc2626",
                  "circle-stroke-width": 0,
                }}
              />
            )}
            {/* Unrated stations — canvas-drawn circle icon, same approach as rated icons */}
            <Layer
              id="station-dots"
              type="symbol"
              // Exclude both rated stations AND excluded stations (the latter get their own cross layer)
              filter={["all", ["!", ["has", "rating"]], ["!", ["has", "isExcluded"]]]}
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
            {/* Rated stations — shown as heart/circle icons instead of grey-green dots */}
            {mapReady && (
              <Layer
                id="station-rating-icons"
                type="symbol"
                filter={["any", ["has", "rating"], ["has", "isExcluded"], ["has", "isFriendOrigin"]]}
                layout={{
                  // Friend origin wins over everything else — the active
                  // friend station renders as a primary-colour square,
                  // matching the primary-origin convention so the two
                  // "origins" on the map (yours + your friend's) look
                  // consistent. Checked FIRST so it beats isExcluded
                  // (friend origins can be excluded — Birmingham is).
                  // Curated-excluded (admin-only): thick cross in the
                  // same primary colour as the regular cross; signals
                  // "excluded but meaningful". Regular excluded
                  // (admin-only): cross. Others: rating-based.
                  "icon-image": ["case",
                    ["has", "isFriendOrigin"],     "icon-origin",
                    ["has", "isCuratedExcluded"], "icon-curated-excluded",
                    ["has", "isExcluded"],         "icon-excluded",
                    ["match", ["get", "rating"],
                      "highlight",       "icon-highlight",
                      "verified",        "icon-verified",
                      "unverified",      "icon-unverified",
                      "not-recommended", "icon-not-recommended",
                      "" // fallback
                    ],
                  ],
                  "icon-allow-overlap": true,    // don't hide icons when they overlap labels
                  "icon-ignore-placement": true, // don't let icons block other symbols
                  // Higher value = drawn on top — rating first, excluded at the back
                  "symbol-sort-key": ["case",
                    ["has", "isExcluded"], -1,
                    ["match", ["get", "rating"],
                      "highlight",       4,
                      "verified",        3,
                      "unverified",      2,
                      "not-recommended", 1,
                      0
                    ],
                  ],
                  // Slightly larger icon when hovered
                  // ["has", "isNew"/"isLeaving"] picks the right scale; stable icons get base size.
                  // Regular excluded (cross) renders at half the normal size.
                  // Curated-excluded (diamond, admin-only) renders at full size
                  // so it reads 2× as big as the cross — the admin cue the
                  // user asked for ("diamond icons twice as big in admin mode").
                  "icon-size": ["*",
                    ["case",
                      // Friend origin gets full base scale (square icon) —
                      // even if it's also excluded (Birmingham is), so
                      // the friend shouldn't shrink to the 0.5× cross
                      // scaling that excluded stations normally get.
                      ["has", "isFriendOrigin"], 1,
                      ["has", "isCuratedExcluded"], 1,
                      ["has", "isExcluded"], 0.5,
                      1,
                    ],
                    hovered
                      ? ["case",
                          ["==", ["get", "coordKey"], hovered.coordKey],
                            ["case", ["has", "isNew"], 1.3 * iconScale, ["has", "isLeaving"], 1.3 * leaveScale, 1.3],
                            ["case", ["has", "isNew"], iconScale, ["has", "isLeaving"], leaveScale, 1],
                        ]
                      : ["case", ["has", "isNew"], iconScale, ["has", "isLeaving"], leaveScale, 1],
                  ],
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
            <Layer
              id="station-hit-area"
              type="circle"
              layout={{
                // Sort key: higher value = drawn on top = returned first by queryRenderedFeatures.
                // Rating wins over excluded, which is explicitly ranked below even
                // unrated stations.
                "circle-sort-key": ["case",
                  ["has", "isExcluded"], -1,
                  ["match", ["get", "rating"],
                    "highlight",       4,
                    "verified",        3,
                    "unverified",      2,
                    "not-recommended", 1,
                    0, // unrated stations get lowest priority
                  ],
                ],
              }}
              paint={{
                // Per-station hit-area size.
                // - Excluded: shrunk (10px) so it loses hit-tests near any non-excluded station.
                // - Others: 12px on desktop (matches the visible pulsing icon —
                //   cursor precision makes a forgiving target unnecessary) and
                //   16px on mobile (the finger-friendly default we've always had).
                // Radius depends only on feature properties (not hover state), so Mapbox
                // doesn't repaint the layer on hover — that would cause hover flicker.
                "circle-radius": ["case",
                  ["has", "isExcluded"], 10,
                  isMobile ? 16 : 12,
                ],
                "circle-color": "#000000",
                // Near-invisible but still detected by Mapbox hit testing.
                // Fades with the leave/enter animation so the faint circle
                // doesn't pop away abruptly when features are removed.
                "circle-opacity": ["case",
                  ["has", "isLeaving"], 0.005 * leaveScale,
                  ["has", "isNew"],     0.005 * iconScale,
                  0.005,
                ],
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
              ["station-labels-highlight", isMobile ? 6 : 7, ["==", ["get", "rating"], "highlight"]],
              ["station-labels-rated", 8, ["==", ["get", "rating"], "verified"]],
              // Pleasant tier surfaces one zoom level later than Sublime/Charming
              // so the map stays calmer at city-wide zooms.
              ["station-labels-unverified", 9, ["==", ["get", "rating"], "unverified"]],
              ["station-labels-not-recommended", 8, ["==", ["get", "rating"], "not-recommended"]],
              // Unrated label tier — excludes "isExcluded" stations so their labels only
              // start showing at zoom 11+ (via station-labels-full).
              ["station-labels-unrated", 10, ["all", ["!", ["has", "rating"]], ["!", ["has", "isExcluded"]]]],
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
            {/* Full labels (name + travel time) — shown for ALL stations at zoom 11+.
                Uses "format" to render the name and time on separate lines with
                different font scales. */}
            <Layer
              id="station-labels-full"
              type="symbol"
              minzoom={isSearching ? 0 : 11}
              // Exclude the hovered station — it gets its own layer below
              // so the full label shows at any zoom, not just 11+
              /* eslint-disable @typescript-eslint/no-explicit-any */
              filter={(hovered
                ? ["!=", ["get", "coordKey"], hovered.coordKey]
                : true) as any}
              /* eslint-enable @typescript-eslint/no-explicit-any */
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
                filter={["==", ["get", "coordKey"], friendOrigin] as any}
                /* eslint-enable @typescript-eslint/no-explicit-any */
                layout={{
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
                        // CRS code — "TRI Tring" — for quick station
                        // identification. Falls back to plain name when
                        // ref:crs is absent (e.g. London terminus pseudo-
                        // features). Built here at render time, not as a
                        // Mapbox `case`, because devExcludeActive is React
                        // state, not a feature property.
                        devExcludeActive
                          ? ["case",
                              // Non-NR detection: no CRS, OR a Z-prefix
                              // code that isn't on our allowlist of Z-prefix
                              // codes that ARE actually National Rail
                              // stations (ZFD Farringdon, ZLW Whitechapel,
                              // ZEL Elephant & Castle, ZCW Canada Water,
                              // ZTU Turnham Green). Without the allowlist,
                              // ZFD would be wrongly flagged — it's a
                              // critical Thameslink + Elizabeth stitcher
                              // source. Mirrors isNonNrStation() in
                              // photo-overlay.tsx; keep them in sync.
                              ["any",
                                ["!", ["has", "ref:crs"]],
                                ["all",
                                  ["==", ["index-of", "Z", ["get", "ref:crs"]], 0],
                                  ["!", ["in", ["get", "ref:crs"], ["literal", ["ZFD", "ZLW", "ZEL", "ZCW", "ZTU"]]]],
                                ],
                              ],
                              ["concat", "NULL ", ["get", "name"]],
                              ["concat", ["get", "ref:crs"], " ", ["get", "name"]],
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
          {mapReady && (
            <Layer
              id="london-label"
              type="symbol"
              layout={{
                "text-field": [
                  "format",
                  // Map label uses the full displayName (even on mobile).
                  // The mobileDisplayName "super-shorthand" is intentionally
                  // only applied to the filter-panel dropdown trigger where
                  // horizontal space is tight — the map has more room and
                  // users benefit from seeing the full name of their origin.
                  // For a custom primary (NR station picked via the search),
                  // PRIMARY_ORIGINS has no entry → fall back to coordToName
                  // (the station's own name from stations.json).
                  PRIMARY_ORIGINS[primaryOrigin]?.displayName
                    ?? PRIMARY_ORIGINS[primaryOrigin]?.canonicalName
                    ?? coordToName[primaryOrigin]
                    ?? primaryOrigin, { "font-scale": 1 },
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
          )}
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
        {friendOrigin && FRIEND_ORIGINS[friendOrigin]?.isSynthetic && (() => {
          const [fLngStr, fLatStr] = friendOrigin.split(",")
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
                  properties: { isFriendOrigin: 1, coordKey: friendOrigin },
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
                    "text-field": FRIEND_ORIGINS[friendOrigin]?.displayName ?? "",
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
            //      (Central London) → use the cluster menuName as the title.
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
              displayStation.coordKey === primaryOrigin &&
              !!PRIMARY_ORIGINS[primaryOrigin]?.isSynthetic
                ? (PRIMARY_ORIGINS[primaryOrigin]?.menuName ?? displayStation.name)
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
            stationCrs={
              stations?.features.find(
                (x) => (x.properties as { coordKey?: string } | undefined)?.coordKey === displayStation.coordKey,
              )?.properties?.["ref:crs"] as string | undefined
            }
            isLondonHome={primaryOrigin === "-0.1269,51.5196"}
            hasIssue={issueStations.has(displayStation.coordKey)}
            onToggleIssue={(hasIssue: boolean) => handleToggleIssue(
              displayStation.coordKey,
              displayStation.name,
              hasIssue,
            )}
            currentRating={ratings[displayStation.coordKey] ?? null}
            onRate={(rating: Rating | null) => handleRate(displayStation.coordKey, displayStation.name, rating)}
            onExclude={() => handleToggleExclusion(displayStation.name, displayStation.coordKey)}
            isExcluded={excludedStations.has(displayStation.coordKey)}
            approvedPhotos={curations[displayStation.coordKey]?.approved ?? []}
            pinnedIds={new Set(curations[displayStation.coordKey]?.pinnedIds ?? [])}
            onApprovePhoto={(photo) => handleApprovePhoto(displayStation.coordKey, displayStation.name, photo)}
            onApprovePhotoAtTop={(photo) => handleApproveAtTop(displayStation.coordKey, displayStation.name, photo)}
            onUnapprovePhoto={(photoId) => handleUnapprovePhoto(displayStation.coordKey, displayStation.name, photoId)}
            onPinPhoto={(photo) => handlePinPhoto(displayStation.coordKey, displayStation.name, photo)}
            onUnpinPhoto={(photoId) => handleUnpinPhoto(displayStation.coordKey, displayStation.name, photoId)}
            onMovePhoto={(photoId, direction) => handleMovePhoto(displayStation.coordKey, displayStation.name, photoId, direction)}
            publicNote={stationNotes[displayStation.coordKey]?.publicNote ?? ""}
            privateNote={stationNotes[displayStation.coordKey]?.privateNote ?? ""}
            adminWalksAll={stationNotes[displayStation.coordKey]?.adminWalksAll ?? ""}
            publicWalksS2S={stationNotes[displayStation.coordKey]?.publicWalksS2S ?? ""}
            publicWalksCircular={stationNotes[displayStation.coordKey]?.publicWalksCircular ?? ""}
            publicWalksExtras={stationNotes[displayStation.coordKey]?.publicWalksExtras ?? ""}
            onSaveNotes={(pub, priv) => handleSaveNotes(displayStation.coordKey, displayStation.name, pub, priv)}
            ramblerExtras={ramblerExtras[displayStation.coordKey] ?? []}
            onSaveRamblerExtras={(lines) => handleSaveRamblerExtras(displayStation.coordKey, lines)}
            onWalkSaved={refreshStationDerivedData}
            defaultAlgo={
              // Central London terminals (18 + synthetic) and excluded stations
              // default to "station"; everything else defaults to "landscapes".
              londonClusterCoords.has(displayStation.coordKey) || excludedStations.has(displayStation.coordKey)
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
            friendOrigin={friendOrigin ? (ALL_ORIGINS[friendOrigin]?.canonicalName ?? null) : null}
            // For a curated primary (Farringdon, KX, CHX, …) this is the
            // canonicalName which matches a key in modalJourneys. For a
            // CUSTOM primary picked via the dropdown search (e.g. Kentish
            // Town) there's no PRIMARY_ORIGINS entry and no pre-fetched
            // journey, so we pass the station's own name from coordToName.
            // The modal's journey lookup won't find a match and will fall
            // through to the "from {primaryOrigin}" fallback copy.
            primaryOrigin={
              PRIMARY_ORIGINS[primaryOrigin]?.canonicalName
                ?? coordToName[primaryOrigin]
                ?? primaryOrigin
            }
            isFriendOrigin={!!friendOrigin && displayStation.coordKey === friendOrigin}
            // Active-primary coords (the primary itself + its cluster members)
            // get the same stripped-down modal as friend stations — title +
            // photos only, no journey info or Hike button. Scoped to the
            // ACTIVE primary so a click on, say, Moorgate while primary is
            // Charing Cross opens the normal modal (Moorgate is only a
            // cluster member of the London synthetic primary).
            isPrimaryOrigin={getActivePrimaryCoords(primaryOrigin).includes(displayStation.coordKey)}
            // Suppress the " Station" suffix ONLY for the synthetic-primary
            // coord itself (Central London hexagon) — the title there is a
            // place name, not a station. Clicks on cluster members (KX NR,
            // St Pancras, Liverpool Street, Waterloo East, etc.) get the
            // suffix so they read as "Kings Cross Station", "St Pancras
            // Station", and so on. Earlier we suppressed for any cluster
            // primary, which produced "Kings Cross, St Pancras, & Euston"
            // as the title — too verbose for a single-station click.
            isSynthetic={
              !!PRIMARY_ORIGINS[displayStation.coordKey]?.isSynthetic ||
              !!FRIEND_ORIGINS[displayStation.coordKey]?.isSynthetic ||
              (displayStation.coordKey === primaryOrigin && !!PRIMARY_ORIGINS[primaryOrigin]?.isSynthetic) ||
              (!!friendOrigin && displayStation.coordKey === friendOrigin && !!FRIEND_ORIGINS[friendOrigin]?.isSynthetic)
            }
            // Cluster header — populated when the open modal's coord is a
            // synthetic anchor. Resolves member coords → station names via
            // baseStations (origin-routes also has names but baseStations is
            // already in scope for this render). Falls back gracefully when
            // a member isn't found in baseStations.
            clusterMemberNames={(() => {
              const isPrimarySynthetic = displayStation.coordKey === primaryOrigin
                && !!PRIMARY_ORIGINS[primaryOrigin]?.isSynthetic
              const isFriendSynthetic = !!friendOrigin
                && displayStation.coordKey === friendOrigin
                && !!FRIEND_ORIGINS[friendOrigin]?.isSynthetic
              if (!isPrimarySynthetic && !isFriendSynthetic) return undefined
              const memberCoords = isPrimarySynthetic
                ? (PRIMARY_ORIGIN_CLUSTER[primaryOrigin] ?? [])
                : (FRIEND_ORIGIN_CLUSTER[friendOrigin!] ?? [])
              const names: string[] = []
              const seen = new Set<string>()
              for (const c of memberCoords) {
                const f = baseStations?.features.find(
                  (bf) => `${bf.geometry.coordinates[0]},${bf.geometry.coordinates[1]}` === c
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
            // Friend cluster-member full station names — used by the
            // friend journey paragraph to extra-bold the WHOLE station
            // name (e.g. "Birmingham New Street") rather than only the
            // first matching word ("Birmingham"). Only populated when
            // the active friend is synthetic; undefined otherwise so
            // non-synthetic friends keep the existing single-word bold.
            friendClusterMemberNames={(() => {
              if (!friendOrigin) return undefined
              if (!FRIEND_ORIGINS[friendOrigin]?.isSynthetic) return undefined
              const memberCoords = FRIEND_ORIGIN_CLUSTER[friendOrigin] ?? []
              const names: string[] = []
              for (const c of memberCoords) {
                const f = baseStations?.features.find(
                  (bf) => `${bf.geometry.coordinates[0]},${bf.geometry.coordinates[1]}` === c
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
              "pointer-events-none absolute inset-0 z-[50] flex items-end sm:items-center justify-center pb-4 sm:pb-0 px-4",
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
          "pointer-events-none absolute inset-0 z-[50] flex items-end sm:items-center justify-center pb-4 sm:pb-0",
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
            {goodbyeFriendCoord
              ? `Saying goodbye to ${
                  FRIEND_ORIGINS[goodbyeFriendCoord]?.displayName
                  ?? PRIMARY_ORIGINS[goodbyeFriendCoord]?.displayName
                  ?? coordToName[goodbyeFriendCoord]
                  ?? "friend"
                }`
              : `Looking up trains from ${pendingFriendCoord
                ? (
                    FRIEND_ORIGINS[pendingFriendCoord]?.displayName
                    ?? PRIMARY_ORIGINS[pendingFriendCoord]?.displayName
                    ?? coordToName[pendingFriendCoord]
                    ?? "friend"
                  )
                : (pendingPrimaryCoord
                  ? (
                      PRIMARY_ORIGIN_CLUSTER[pendingPrimaryCoord]
                        ? (PRIMARY_ORIGINS[pendingPrimaryCoord]?.menuName
                            ?? PRIMARY_ORIGINS[pendingPrimaryCoord]?.displayName
                            ?? pendingPrimaryCoord)
                        : (PRIMARY_ORIGINS[pendingPrimaryCoord]?.displayName
                            ?? coordToName[pendingPrimaryCoord]
                            ?? "new home")
                    )
                  : "new home")}`}
          </span>
        </div>
      </div>
    </div>
  )
}

