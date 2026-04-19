"use client"

import { useCallback, useEffect, useMemo, useRef, useState, useTransition } from "react"
import { useTheme } from "next-themes"
import Map, { Layer, MapMouseEvent, MapRef, Source } from "react-map-gl/mapbox"
import "mapbox-gl/dist/mapbox-gl.css"
import FilterPanel from "@/components/filter-panel"
import { WelcomeBanner } from "@/components/welcome-banner"
import { HelpButton } from "@/components/help-button"
import StationModal, { type FlickrPhoto, type JourneyInfo } from "@/components/photo-overlay"
import excludedStationsList from "@/data/excluded-stations.json"
// Stations that are TECHNICALLY a London NR station (so they match the
// searchableStations criteria) but produce no useful data when picked as
// a home station — because they have no RTT-reachable hub in any of our
// origin-routes.json primaries. Currently: Kensington (Olympia), whose NR
// service is sparse and event-driven. Coord-keyed, same shape as
// data/excluded-stations.json.
import excludedPrimariesList from "@/data/excluded-primaries.json"
import originStationsList from "@/data/origin-stations.json"
import originRoutesData from "@/data/origin-routes.json"
import londonTerminalsData from "@/data/london-terminals.json"
import terminalMatrixData from "@/data/terminal-matrix.json"
import { cn } from "@/lib/utils"
import { getColors } from "@/lib/tokens"
import { usePersistedState } from "@/lib/use-persisted-state"
import { getEffectiveJourney } from "@/lib/effective-journey"
import { stitchJourney, matchTerminal, type Terminal, type TerminalMatrix } from "@/lib/stitch-journey"

// Universal rating applied by a dev — stored in data/station-ratings.json, not per-user
type Rating = 'highlight' | 'verified' | 'unverified' | 'not-recommended'

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
//  - All other origins (CHX, LST+MOG, City cluster, MYB, PAD, VIC, WAT+WAE):
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
  // Kings Cross primary represents the KX/St Pancras/Euston group — they're
  // next-door and share a tube interchange, so most riders pick any of the
  // three interchangeably. Cluster members are declared below.
  "-0.1239491,51.530609":  { canonicalName: "Kings Cross St Pancras", displayName: "Kings Cross",      menuName: "Kings Cross, St Pancras, & Euston" },
  "-0.1236888,51.5074975": { canonicalName: "Charing Cross",          displayName: "Charing Cross",    menuName: "Charing Cross", mobileDisplayName: "Charing X" },
  "-0.163592,51.5243712":  { canonicalName: "Marylebone",              displayName: "Marylebone",       menuName: "Marylebone" },
  "-0.177317,51.5170952":  { canonicalName: "Paddington",              displayName: "Paddington",       menuName: "Paddington" },
  "-0.1445802,51.4947328": { canonicalName: "Victoria",                displayName: "Victoria",         menuName: "Victoria" },
  // Waterloo primary — clustered with Waterloo East (cross-platform walk).
  "-0.112801,51.5028379":  { canonicalName: "Waterloo",                displayName: "Waterloo",         menuName: "Waterloo & Waterloo East" },
  // Stratford primary — clustered with Stratford International (a short
  // walk across the plaza). Cluster member declared below.
  "-0.0035472,51.541289":  { canonicalName: "Stratford",                displayName: "Stratford",        menuName: "Stratford & Stratford International" },
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
const byDisplayName = (a: string, b: string) =>
  (PRIMARY_ORIGINS[a]?.displayName ?? a).localeCompare(PRIMARY_ORIGINS[b]?.displayName ?? b)
// ONLY the synthetic primary (currently just "Any London terminus") is shown
// as a permanent curated dropdown item. Individual London termini (Charing
// Cross, Victoria, Waterloo, …) are treated like any other London NR station
// — reachable via search + promoted into the "recents" list when picked.
// Admin mode still gets to see admin-only entries as an extra group below
// the synthetic so they remain one-click accessible for dev work.
const PRIMARY_ORIGIN_GROUPS_ALL: string[][] = [
  Object.keys(PRIMARY_ORIGINS)
    .filter((k) => !PRIMARY_ORIGINS[k]?.adminOnly && PRIMARY_ORIGINS[k]?.isSynthetic)
    .sort(byDisplayName),
  Object.keys(PRIMARY_ORIGINS)
    .filter((k) => PRIMARY_ORIGINS[k]?.adminOnly)
    .sort(byDisplayName),
].filter((group) => group.length > 0)
const PRIMARY_ORIGIN_GROUPS_PUBLIC: string[][] = PRIMARY_ORIGIN_GROUPS_ALL
  .map((group) => group.filter((key) => !PRIMARY_ORIGINS[key]?.adminOnly))
  .filter((group) => group.length > 0)

// Clustered satellite stations — when a primary is active, these extra coord
// keys are also consulted for direct-reachable lookups AND stitching attempts,
// and the fastest train from any cluster member wins.
//  - Liverpool Street ← Moorgate: short walk, MOG has distinct GN suburban pattern.
//  - City cluster ← six City-area stations (synthetic primary coord at Bank).
//    Admin-only while we validate whether aggregating 6 origins into one is
//    useful UX.
const PRIMARY_ORIGIN_CLUSTER: Record<string, string[]> = {
  // Waterloo primary ← Waterloo East. Cross-platform walkway makes them a
  // single practical interchange.
  "-0.112801,51.5028379": ["-0.1082027,51.5042171"],
  // Stratford primary ← Stratford International. Separate-but-near (a few
  // minutes' walk across the plaza), historically treated as one logical
  // origin — tapping either maps back to the Stratford primary.
  "-0.0035472,51.541289": ["-0.0087494,51.5447954"],
  // Kings Cross primary ← all NR/Underground variants of KX, St Pancras,
  // and Euston. Underground + NR coords appear at slightly different OSM
  // nodes, so listing each ensures a tap on any of them maps back to the
  // one primary.
  "-0.1239491,51.530609": [
    "-0.1230224,51.5323954",   // Kings Cross (National Rail / KGX)
    "-0.1270027,51.5327196",   // St Pancras International (STP, main concourse)
    "-0.1276185,51.5322106",   // St Pancras International (SPL, HS1/domestic concourse)
    "-0.1341909,51.5288526",   // Euston (National Rail / EUS)
    "-0.1338745,51.5282865",   // Euston (Underground)
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
// mode. Same shape as PRIMARY_ORIGINS.
const FRIEND_ORIGINS: Record<string, OriginDef> = {
  "-1.898694,52.4776459":  { canonicalName: "Birmingham New Street", displayName: "Birmingham", menuName: "Birmingham New St" },
  "-1.1449555,52.9473037": { canonicalName: "Nottingham",            displayName: "Nottingham", menuName: "Nottingham" },
}

// Flat arrays of keys for filter-panel's "list of origins to render" props.
const FRIEND_ORIGIN_KEYS = Object.keys(FRIEND_ORIGINS)

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
const terminalMatrix = terminalMatrixData as TerminalMatrix

// Stations manually excluded — edit data/excluded-stations.json to add/remove entries.
// Entries are either station names (legacy) or "lng,lat" coord keys (preferred — unambiguous when two stations share a name).
// INITIAL_EXCLUDED_STATIONS seeds the state; admin toggling mutates the state set.
const INITIAL_EXCLUDED_STATIONS = new Set(excludedStationsList)

// Origin stations — shown as squares, only visible in admin mode (except London/Farringdon
// which has its own dedicated marker). Keyed by "lng,lat" coord key so that
// same-named stations (e.g. London vs Glasgow Charing Cross) stay independent.
// INITIAL_ORIGIN_STATIONS seeds the state; admin toggling mutates the state set.
const INITIAL_ORIGIN_STATIONS = new Set(originStationsList)

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
  // layer. Resolved from the station's rating / isOrigin / isExcluded at
  // hover-set time so the overlay matches the base station's visual.
  iconImage: string
}

// Maps a station feature's properties to the matching registered icon image
// name. Kept in sync with the `icon-image` expressions used in the base
// station-dots and station-rating-icons layers.
// Uses the same property-existence semantics as the Mapbox `["has", ...]`
// expressions in those layers (not strict truthiness) so origin + excluded
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
  if (hasProp("isOrigin")) return "icon-origin"
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
function createRatingIcon(shape: 'star' | 'triangle-up' | 'triangle-down' | 'circle' | 'square' | 'hexagon' | 'cross' | 'diamond', color: string, strokeColor: string): ImageData {
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
    // This is the intended semantic for excluded stations.
    ctx.strokeStyle = color
    ctx.lineWidth = 3
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
    // Regular hexagon — 6 vertices evenly spaced, flat top edge
    // Smaller radius (7) so it reads as a more compact shape
    ctx.beginPath()
    const cx = 12, cy = 12, hexR = 5.8
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
  // Seeded on first load (when localStorage is empty) with three commonly-
  // used picks: the Kings Cross cluster primary, Farringdon, and Stratford.
  // Gives new users something to click immediately rather than an empty
  // recents section. Existing users keep whatever's in their localStorage.
  const [recentCustomPrimaries, setRecentCustomPrimaries] = usePersistedState<string[]>(
    "ttg:recentCustomPrimaries",
    [
      "-0.0035472,51.541289",   // Stratford
      "-0.104555,51.519964",    // Farringdon
      "-0.1239491,51.530609",   // Kings Cross (primary coord; renders as the full "Kings Cross, St Pancras, & Euston" menuName)
      "-0.1705184,51.4644589",  // Clapham Junction — first suburban hub released under conservative admin-only search gating
    ],
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
    if (!primaryOrigin.includes(",")) {
      setPrimaryOriginRaw(migrateOriginKey(primaryOrigin, PRIMARY_ORIGINS, "-0.1269,51.5196"))
    } else if (!PRIMARY_ORIGINS[primaryOrigin] && !recentCustomPrimaries.includes(primaryOrigin)) {
      // Stored coord isn't a valid primary anymore — reset to default.
      setPrimaryOriginRaw("-0.1269,51.5196")
    }
  }, [primaryOrigin, setPrimaryOriginRaw, recentCustomPrimaries])
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
  // Ref to the auto-dismiss timer so a fast double-selection can
  // cancel the previous cycle's pending idle-flip. Without this,
  // picking station B while station A's success pill is still
  // visible would see A's setTimeout fire mid-loading-of-B and
  // wipe the new spinner back to idle.
  const dismissTimerRef = useRef<number | null>(null)
  useEffect(() => {
    if (isPending) {
      setNotificationPhase("loading")
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
        }, 400)
        return "success"
      })
    }
  }, [isPending])
  const setPrimaryOrigin = useCallback((next: string) => {
    setPendingPrimaryCoord(next)
    startTransition(() => setPrimaryOriginRaw(next))
  }, [setPrimaryOriginRaw])
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
  // Set of coords inside the LONDON SYNTHETIC cluster (the 18 true termini
  // plus the synthetic coord itself). Used to decide whether a search-picked
  // coord should bypass the "recents" list. Only London-terminus coords
  // bypass recents — Stratford, Farringdon, Kentish Town, East Croydon etc.
  // all go to recents even if they happen to be in PRIMARY_ORIGINS.
  const londonClusterCoords = useMemo(() => {
    const syntheticCoord = Object.keys(PRIMARY_ORIGINS).find(
      (k) => PRIMARY_ORIGINS[k]?.isSynthetic,
    )
    const set = new Set<string>()
    if (syntheticCoord) {
      set.add(syntheticCoord)
      for (const m of PRIMARY_ORIGIN_CLUSTER[syntheticCoord] ?? []) set.add(m)
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
        // Last-10 slice: user-facing recents cap is 10 (was 5 previously).
        return [resolved, ...filtered].slice(0, 10)
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
  // Origin stations (lowercase names). Seeded from data/origin-stations.json,
  // mutated via the admin-mode square-icon toggle in the station overlay.
  const [originStations, setOriginStations] = useState<Set<string>>(() => new Set(INITIAL_ORIGIN_STATIONS))
  // Excluded stations (names + "lng,lat" coord keys — whichever the JSON stores).
  // Seeded from data/excluded-stations.json, mutated via the admin cross toggle.
  const [excludedStations, setExcludedStations] = useState<Set<string>>(() => new Set(INITIAL_EXCLUDED_STATIONS))
  // Default 150min (2h30m) — the non-admin slider cap. In admin mode the cap
  // extends to 600min ("Max" = no upper limit).
  // Filter state (max time, direct-only, rating checkboxes, trails) intentionally
  // does NOT persist across reloads — every visit starts from a clean slate.
  const [maxMinutes, setMaxMinutes] = useState(150)
  // Admin-only lower bound on travel time — 0 means "no minimum" (disabled)
  const [minMinutes, setMinMinutes] = useState(0)
  // Friend origin mode — when non-null, a second origin filters stations.
  // Not persisted — every reload starts with no friend (same as the other
  // filter state). Value is a "lng,lat" coord key.
  const [friendOrigin, setFriendOrigin] = useState<string | null>(null)
  const [friendMaxMinutes, setFriendMaxMinutes] = useState(150)
  // "Direct trains only" toggles — when true, only keep stations reachable
  // from the matching origin with zero interchanges (journeys[origin].changes === 0)
  const [primaryDirectOnly, setPrimaryDirectOnly] = useState(false)
  const [friendDirectOnly, setFriendDirectOnly] = useState(false)
  // "Indirect trains only" — admin-only inverse of the above. Shows stations
  // that require ≥1 change from the primary. Useful for debugging the
  // stitcher: the union of this and "Direct trains only" equals the full
  // destination set, and any visual oddity (missing station, weird time)
  // is easier to spot when only one cohort renders at a time.
  const [primaryIndirectOnly, setPrimaryIndirectOnly] = useState(false)
  const [hovered, setHovered] = useState<HoveredStation | null>(null)
  const [showTrails, setShowTrails] = useState(false)
  // Start hidden by default — hydration from localStorage runs after mount,
  // so the welcome banner briefly flashes on first return visit. That's a
  // small price for never showing a wrongly-hidden banner to new users.
  // See hasSeenWelcome hook below which handles first-visit logic.
  const [bannerVisible, setBannerVisible] = useState(true)
  const [hasSeenWelcome, setHasSeenWelcome] = usePersistedState("ttg:hasSeenWelcome", false)
  // Sync bannerVisible with hasSeenWelcome after localStorage hydrates on mount.
  // We can't start `bannerVisible` as `!hasSeenWelcome` because the hook reads
  // from localStorage in a useEffect (after first render), so on returning
  // visits the banner is briefly visible then closes. An effect mirrors that
  // hidden/visible flip back onto `bannerVisible`.
  useEffect(() => {
    if (hasSeenWelcome) setBannerVisible(false)
  }, [hasSeenWelcome])
  // Screen-pixel origin of the London icon — null on initial page load (no icon click)
  const [bannerOrigin, setBannerOrigin] = useState<{ x: number; y: number } | null>(null)
  const [zoom, setZoom] = useState(INITIAL_VIEW.zoom)
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
  // Which rating categories to filter to — empty means "show all" (no filter active).
  // "unrated" is a pseudo-category for stations without any rating.
  // Empty set = no filter = all stations visible. Not persisted — rating
  // filters reset to "show everything" on every reload, matching the rest
  // of the filter state.
  const [visibleRatings, setVisibleRatings] = useState<Set<string>>(new Set())

  // Photo curations — per-station approved/rejected photo lists, loaded from
  // data/photo-curations.json via API. Only used in admin mode.
  type CurationEntry = { name: string; approved: FlickrPhoto[]; rejected: string[] }
  const [curations, setCurations] = useState<Record<string, CurationEntry>>({})

  // Station notes — public (visible to all) and private (admin-only) text per station
  type NotesEntry = { name: string; publicNote: string; privateNote: string }
  const [stationNotes, setStationNotes] = useState<Record<string, NotesEntry>>({})

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
    type SearchableStation = {
      coord: string
      name: string
      crs: string
      primaryCoord: string
      displayLabel: string
    }
    const out: SearchableStation[] = []
    const isLondonBox = (lat: number, lng: number) =>
      lat > 51.28 && lat < 51.70 && lng > -0.55 && lng < 0.30
    for (const f of baseStations.features) {
      const crs = f.properties?.["ref:crs"] as string | undefined
      if (!crs) continue
      const [lng, lat] = f.geometry.coordinates
      if (!isLondonBox(lat, lng)) continue
      const network = f.properties?.["network"] as string | undefined
      if (!network || !/National Rail|Elizabeth line/.test(network)) continue
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
      out.push({
        coord,
        name: stationName,
        crs,
        primaryCoord,
        displayLabel,
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
  const stations = useMemo(() => {
    if (!baseStations) return null
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
      const downstream = entry.fastestCallingPoints
        .slice(1, -1)
        .map((crs) => {
          const station = crsToStation[crs]
          if (!station || !station.isLondon) return null
          // Skip the primary origin itself — see header comment.
          if (station.coordKey === primaryOrigin) return null
          const sub = winnerRoutes?.directReachable?.[station.coordKey]
          if (!sub) return null
          return { name: station.name, crs, minutesFromOrigin: sub.minMinutes }
        })
        .filter((p): p is { name: string; crs: string; minutesFromOrigin: number } => !!p)
      const upstream = (entry.upstreamCallingPoints ?? [])
        .map((u) => {
          const station = crsToStation[u.crs]
          if (!station || !station.isLondon) return null
          // Same reason as downstream — skip the primary origin.
          if (station.coordKey === primaryOrigin) return null
          return { name: u.name, crs: u.crs, minutesExtra: u.minutesBeforeOrigin }
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
    const CUSTOM_INTERCHANGE_MIN = 5
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

    return {
      ...baseStations,
      features: baseStations.features.map((f) => {
        // Origin + exclusion sets are both coord-keyed now, so same-named stations
        // (Glasgow vs London Charing Cross) stay independent.
        const coordKey = f.properties.coordKey as string
        const shouldBeOrigin = originStations.has(coordKey)
        const shouldBeExcluded = excludedStations.has(coordKey)

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
            const effective = getEffectiveJourney(prefetchedPrimaryJourney, primaryName)
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
            const coords = rttReachable.fastestCallingPoints
              .map((crs) => crsToCoord[crs])
              .filter((c): c is [number, number] => !!c)
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
              if (!stitchedCandidate || enriched.durationMinutes! < stitchedCandidate.mins) {
                stitchedCandidate = { mins: enriched.durationMinutes!, journey: enriched as unknown as JourneyInfo }
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
            // No data at all for this destination → clear londonMinutes so it's filtered out.
            rttClearLondonMinutes = true
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
            const effective = getEffectiveJourney(primaryJourney, primaryName)
            originMins = effective?.effectiveMinutes
            effectiveChanges = effective?.effectiveChanges
            // No synthJourney to build — the journey already lives
            // under f.properties.journeys[primaryOrigin], so the
            // modal + hover polyline read it natively.
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
              kind: "rtt-direct" | "source-stitched" | "double-hop"
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
                  mins: hub.pToCustomMins + pToD + CUSTOM_INTERCHANGE_MIN,
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
                  mins: hub.pToCustomMins + CUSTOM_INTERCHANGE_MIN + srcJourney.durationMinutes,
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
                      CUSTOM_INTERCHANGE_MIN * 2 +
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

              if (winner.kind === "rtt-direct") {
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

        // Build next properties — flip isOrigin + isExcluded flags, and optionally override londonMinutes
        const next: Record<string, unknown> = { ...f.properties }
        if (shouldBeOrigin) next.isOrigin = true
        else delete next.isOrigin
        if (shouldBeExcluded) next.isExcluded = true
        else delete next.isExcluded
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
        }

        return { ...f, properties: next as StationFeature["properties"] }
      }),
    }
  }, [baseStations, primaryOrigin, originStations, excludedStations, coordToName])

  // Recompute filtered stations whenever the slider or raw data changes.
  // useMemo avoids re-filtering the whole array on every render.
  const filteredStations = useMemo(() => {
    if (!stations) return null
    return {
      ...stations,
      features: stations.features.filter((f) => {
        const mins = f.properties.londonMinutes as number | null

        // Shared helper — returns true if the travel time passes both sliders.
        // Stations with no time data pass (they can't be filtered by time).
        // When the max slider is at its admin ceiling (600), treat as unlimited.
        const passesTimeFilter = () => {
          if (mins == null) return true
          if (maxMinutes < 600 && mins > maxMinutes) return false
          if (minMinutes > 0 && mins < minMinutes) return false
          return true
        }

        // Excluded stations: admin-only, and now respect the time sliders so
        // admins can narrow the view to excluded stations in a specific band.
        // The direct-only checkbox applies here too — an excluded station with
        // no direct-train data from the primary origin shouldn't appear even
        // in admin mode when "Direct trains only" is ticked.
        if (f.properties.isExcluded) {
          if (!devExcludeActive) return false
          if (!passesTimeFilter()) return false
          if (primaryDirectOnly) {
            const primaryChanges = f.properties.effectiveChanges as number | undefined
            if (primaryChanges == null || primaryChanges > 0) return false
          }
          return true
        }

        // Origin stations: hidden in non-admin mode (except the active friend origin).
        // In admin mode they now respect the time sliders too.
        if (f.properties.isOrigin) {
          if (!devExcludeActive) {
            // friendOrigin is a coord key now, matched against each feature's coordKey
            if (friendOrigin && (f.properties.coordKey as string) === friendOrigin) return true
            return false
          }
          return passesTimeFilter()
        }

        // Regular destination stations — must have time data in range
        if (mins == null) return false
        if (maxMinutes < 600 && mins > maxMinutes) return false
        if (minMinutes > 0 && mins < minMinutes) return false
        // "Direct trains only" for the primary origin — require 0 EFFECTIVE changes.
        // `effectiveChanges` is pre-computed above and already accounts for the
        // Kings Cross cluster (so a tube hop to Euston doesn't count as a change).
        // Falls back to raw `changes` for non-cluster origins.
        if (primaryDirectOnly) {
          const primaryChanges = f.properties.effectiveChanges as number | undefined
          if (primaryChanges == null || primaryChanges > 0) return false
        }
        // "Indirect trains only" (admin-only inverse) — require ≥1 effective
        // change. Stations without journey data are dropped (no way to know
        // if they'd be direct or not). UI toggle is exclusive with
        // primaryDirectOnly — the filter-panel unchecks one when the other
        // is checked, so both flags shouldn't be true simultaneously, but we
        // still evaluate them as independent conditions for safety.
        if (primaryIndirectOnly) {
          const primaryChanges = f.properties.effectiveChanges as number | undefined
          if (primaryChanges == null || primaryChanges === 0) return false
        }
        // When friend mode is active, also require the station to be reachable
        // from the friend's origin within the friend's max travel time
        if (friendOrigin) {
          const journeys = f.properties.journeys as Record<string, { durationMinutes?: number; changes?: number }> | undefined
          const friendMins = journeys?.[friendOrigin]?.durationMinutes
          if (friendMins == null) return false
          if (friendMaxMinutes < 600 && friendMins > friendMaxMinutes) return false
          // "Direct trains only" for the friend origin — require 0 changes
          if (friendDirectOnly) {
            const friendChanges = journeys?.[friendOrigin]?.changes
            if (friendChanges == null || friendChanges > 0) return false
          }
        }
        return true
      }),
    }
  }, [stations, maxMinutes, minMinutes, friendOrigin, friendMaxMinutes, devExcludeActive, primaryOrigin, primaryDirectOnly, primaryIndirectOnly, friendDirectOnly])

  // Further filter by search query when 3+ characters are typed.
  // We keep this separate from filteredStations so the travel-time filter is unaffected.
  const displayedStations = useMemo(() => {
    if (!filteredStations) return null
    if (!isSearching) return filteredStations
    const q = searchQuery.toLowerCase()
    return {
      ...filteredStations,
      features: filteredStations.features.filter((f) =>
        (f.properties.name as string).toLowerCase().includes(q)
      ),
    }
  }, [filteredStations, isSearching, searchQuery])

  // Stamps each feature with its rating but does NOT filter by visibleRatings.
  // Filtering happens in stationsForMap so we can keep leaving features during their animation.
  const allStationsWithRatings = useMemo(() => {
    if (!displayedStations) return null
    return {
      ...displayedStations,
      features: displayedStations.features.map(f => {
        const r = ratings[f.properties.coordKey as string]
        const extra: Record<string, unknown> = {}
        if (r) extra.rating = r
        // Flatten friend journey duration so Mapbox label expressions can read it
        if (friendOrigin) {
          const journeys = f.properties.journeys as Record<string, { durationMinutes?: number }> | undefined
          const mins = journeys?.[friendOrigin]?.durationMinutes
          if (mins != null) extra.friendMinutes = mins
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
    const syntheticCoord = Object.keys(PRIMARY_ORIGINS).find(
      (k) => PRIMARY_ORIGINS[k]?.isSynthetic,
    )
    if (!syntheticCoord) return null
    const clusterCoords = PRIMARY_ORIGIN_CLUSTER[syntheticCoord] ?? []
    type PointFeature = {
      type: "Feature"
      geometry: { type: "Point"; coordinates: [number, number] }
      properties: Record<string, unknown>
    }
    const iconFeatures: PointFeature[] = []
    const labelFeatures: PointFeature[] = []
    const seenNames = new Set<string>()
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
      iconFeatures.push({
        type: "Feature",
        geometry: { type: "Point", coordinates: [lng, lat] },
        // Stamp coord + coordKey + name so the click handler can
        // resolve a diamond tap back to its station feature (via
        // baseStations) and open the stripped-down active-primary
        // modal. coordKey matches the same-named property on
        // regular station features — lets the existing click-to-
        // modal plumbing reuse the cluster-member branch.
        properties: {
          coord: coord,
          coordKey: coord,
          name: rawName ?? "",
        },
      })
      if (!rawName) continue
      // Label resolution: prefer the primary's displayName when the coord
      // is itself a PRIMARY_ORIGINS key; otherwise use the baseStations
      // OSM name. Then apply a few targeted normalisations so the
      // terminus waypoint labels read consistently:
      //   - "London King's Cross" → "Kings Cross" (drop "London" prefix,
      //     apostrophe-free to match the other cluster labels)
      //   - "London St. Pancras International" → "St Pancras International"
      //   - "Liverpool Street" → "Liverpool St" (avoids running into the
      //     adjacent Moorgate label)
      const primaryDisplayName = PRIMARY_ORIGINS[coord]?.displayName
      let label = primaryDisplayName ?? rawName
      if (label === "London King's Cross") label = "Kings Cross"
      if (label === "London St. Pancras International") label = "St Pancras"
      if (label === "Liverpool Street") label = "Liverpool St"
      if (label === "Cannon Street") label = "Cannon St"
      if (label === "Fenchurch Street") label = "Fenchurch St"
      if (seenNames.has(label)) continue
      seenNames.add(label)
      labelFeatures.push({
        type: "Feature",
        geometry: { type: "Point", coordinates: [lng, lat] },
        properties: { name: label },
      })
    }
    return {
      icons: { type: "FeatureCollection" as const, features: iconFeatures },
      labels: { type: "FeatureCollection" as const, features: labelFeatures },
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
          if (friendOrigin && (f.properties.coordKey as string) === friendOrigin) return true
          // No filters active → show everything that reached this layer.
          // (Non-admin users never see excluded/origin — those are already removed
          // upstream in filteredStations, so this branch is safe for them too.)
          if (visibleRatings.size === 0 && newlyRemovedRatings.size === 0) return true
          // Excluded stations (admin-only) — gated on the "excluded" checkbox.
          if (f.properties.isExcluded) {
            return visibleRatings.has('excluded') || newlyRemovedRatings.has('excluded')
          }
          // Origin stations (admin-only) — gated on the "origin" checkbox.
          if (f.properties.isOrigin) {
            return visibleRatings.has('origin') || newlyRemovedRatings.has('origin')
          }
          const category = (f.properties.rating as string | undefined) ?? 'unrated'
          return visibleRatings.has(category) || newlyRemovedRatings.has(category)
        })
        .map(f => {
          const category = (f.properties.rating as string | undefined) ?? 'unrated'
          if (newlyAddedRatings.has(category)) {
            return { ...f, properties: { ...f.properties, isNew: 1 } }
          }
          if (newlyRemovedRatings.has(category)) {
            return { ...f, properties: { ...f.properties, isLeaving: 1 } }
          }
          return f
        }),
    }
  }, [allStationsWithRatings, visibleRatings, newlyAddedRatings, newlyRemovedRatings, friendOrigin])
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
  // rating checkbox is on. Mirrors the origin-toggle flow.
  const handleToggleExclusion = useCallback(async (name: string, coordKey: string) => {
    let nowExcluded = false
    setExcludedStations((prev) => {
      const next = new Set(prev)
      // The state set is keyed by coordKey only — legacy name entries were migrated
      // to coordKeys in data/excluded-stations.json, so ambiguous names can no longer
      // cascade across stations that share a display name.
      if (next.has(coordKey)) {
        next.delete(coordKey); nowExcluded = false
      } else {
        next.add(coordKey); nowExcluded = true
      }
      return next
    })
    // Use existing exclude/include routes so the JSON stays consistent
    const endpoint = nowExcluded ? "/api/dev/exclude-station" : "/api/dev/include-station"
    await fetch(endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name, coordKey }),
    })
  }, [])

  // Dev action: toggle a station's origin-station status.
  // Optimistic local update + POST to API which updates data/origin-stations.json.
  // `name` is sent alongside the coord key purely so the git commit message is readable.
  const handleToggleOrigin = useCallback(async (coordKey: string, name: string) => {
    let nextIsOrigin = false
    setOriginStations((prev) => {
      const next = new Set(prev)
      if (next.has(coordKey)) { next.delete(coordKey); nextIsOrigin = false }
      else { next.add(coordKey); nextIsOrigin = true }
      return next
    })
    await fetch("/api/dev/toggle-origin-station", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ coordKey, name, isOrigin: nextIsOrigin }),
    })
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

  // Dev action: approve a photo for a station — persists to data/photo-curations.json
  const handleApprovePhoto = useCallback(async (coordKey: string, name: string, photo: FlickrPhoto) => {
    // Optimistic update
    setCurations((prev) => {
      const entry = prev[coordKey] ?? { name, approved: [], rejected: [] }
      if (entry.approved.some((p) => p.id === photo.id)) return prev // already approved
      return {
        ...prev,
        [coordKey]: {
          ...entry,
          name,
          approved: [...entry.approved, photo],
          rejected: entry.rejected.filter((id) => id !== photo.id),
        },
      }
    })
    await fetch("/api/dev/curate-photo", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ coordKey, name, photoId: photo.id, action: "approve", photo }),
    })
  }, [])

  // Dev action: reject a photo for a station — it disappears and won't return
  const handleRejectPhoto = useCallback(async (coordKey: string, name: string, photoId: string) => {
    // Optimistic update
    setCurations((prev) => {
      const entry = prev[coordKey] ?? { name, approved: [], rejected: [] }
      if (entry.rejected.includes(photoId)) return prev // already rejected
      return {
        ...prev,
        [coordKey]: {
          ...entry,
          name,
          approved: entry.approved.filter((p) => p.id !== photoId),
          rejected: [...entry.rejected, photoId],
        },
      }
    })
    await fetch("/api/dev/curate-photo", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ coordKey, name, photoId, action: "reject" }),
    })
  }, [])

  // Dev action: move an approved photo up or down in the display order
  const handleMovePhoto = useCallback(async (coordKey: string, name: string, photoId: string, direction: "up" | "down" | "top") => {
    // Optimistic update — swap with neighbour, or splice to front for "top"
    setCurations((prev) => {
      const entry = prev[coordKey]
      if (!entry) return prev
      const approved = [...entry.approved]
      const idx = approved.findIndex((p) => p.id === photoId)
      if (idx < 0) return prev
      if (direction === "top") {
        const [photo] = approved.splice(idx, 1)
        approved.unshift(photo)
      } else {
        const targetIdx = direction === "up" ? idx - 1 : idx + 1
        if (targetIdx < 0 || targetIdx >= approved.length) return prev
        ;[approved[idx], approved[targetIdx]] = [approved[targetIdx], approved[idx]]
      }
      return { ...prev, [coordKey]: { ...entry, approved } }
    })
    await fetch("/api/dev/curate-photo", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ coordKey, name, photoId, action: "move", direction }),
    })
  }, [])

  // Dev action: un-approve a photo — removes from approved without rejecting it
  const handleUnapprovePhoto = useCallback(async (coordKey: string, name: string, photoId: string) => {
    setCurations((prev) => {
      const entry = prev[coordKey]
      if (!entry) return prev
      const updated = {
        ...entry,
        approved: entry.approved.filter((p) => p.id !== photoId),
      }
      // Clean up if both lists are now empty
      if (updated.approved.length === 0 && updated.rejected.length === 0) {
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

  // Save public/private notes for a station — called when the overlay closes
  const handleSaveNotes = useCallback(async (coordKey: string, name: string, publicNote: string, privateNote: string) => {
    // Optimistic update
    setStationNotes((prev) => {
      if (!publicNote && !privateNote) {
        const next = { ...prev }
        delete next[coordKey]
        return next
      }
      return { ...prev, [coordKey]: { name, publicNote, privateNote } }
    })
    await fetch("/api/dev/station-notes", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ coordKey, name, publicNote, privateNote }),
    })
  }, [])

  // useEffect runs once after the component first renders (the empty [] means "run once only")
  useEffect(() => {
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
          // Stamp coordKey for consistent identity, and isOrigin for origin stations
          const extra: Record<string, unknown> = { coordKey }
          if (INITIAL_ORIGIN_STATIONS.has(coordKey)) extra.isOrigin = true
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
  // Handles two sources: `polyline` (encoded string from Google Routes) and
  // `polylineCoords` (pre-decoded [lng,lat][] from RTT-synthesised journeys).
  type JourneyWithGeom = { polyline?: string; polylineCoords?: [number, number][] }
  const resolveJourneyCoords = (j: JourneyWithGeom | undefined): [number, number][] | null => {
    if (!j) return null
    if (j.polylineCoords && j.polylineCoords.length > 1) return j.polylineCoords
    if (j.polyline) return decodePolyline(j.polyline)
    return null
  }
  const hoveredJourneyCoords = useMemo(() => {
    if (!hovered || !stations) return null
    const feature = stations.features.find(
      (f) => `${f.geometry.coordinates[0]},${f.geometry.coordinates[1]}` === hovered.coordKey
    )
    const journeys = feature?.properties?.journeys as Record<string, JourneyWithGeom> | undefined
    // Use the primary origin's journey (not first-found) to avoid picking up friend origin's
    return resolveJourneyCoords(journeys?.[primaryOrigin])
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

  // Friend origin polyline — same logic but for the friend's journey
  const hoveredFriendJourneyCoords = useMemo(() => {
    if (!friendOrigin || !hovered || !stations) return null
    const feature = stations.features.find(
      (f) => `${f.geometry.coordinates[0]},${f.geometry.coordinates[1]}` === hovered.coordKey
    )
    const journeys = feature?.properties?.journeys as Record<string, JourneyWithGeom> | undefined
    return resolveJourneyCoords(journeys?.[friendOrigin])
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
    // London marker shouldn't produce radius circles — clear any previous station's circles
    if (feature.properties?.isLondon) setRadiusPos(null)
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
      if (p.isOrigin) return 3
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
    setRadiusPos({ lng, lat })
    longPressFired.current = true
  }, [])

  // No-op on touchend/touchmove — we now persist the hover state between taps
  // instead of clearing on lift, so the 2nd tap has something to detect.
  const handleTouchEndOrMove = useCallback(() => {
    // Intentionally empty. Retained so existing prop wiring (<Map onTouchStart
    // … onTouchEnd={handleTouchEndOrMove} />) doesn't break; can remove in a
    // later refactor.
  }, [])

  // Dev only — right-clicking a station immediately excludes it without opening the modal.
  const handleContextMenu = useCallback((e: MapMouseEvent) => {
    if (!devExcludeActive) return
    const feature = e.features?.[0]
    if (!feature || feature.properties?.isLondon) return
    const name = feature.properties?.name as string
    const coordKey = feature.properties?.coordKey as string
    // Right-click in admin mode toggles exclusion — either hide or re-show the station.
    handleToggleExclusion(name, coordKey)
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
    // Terminus diamond click — resolve to the real station feature so
    // the usual modal opens. The diamond's properties carry coordKey
    // already, so we can look up the baseStations feature directly.
    // No `getActivePrimaryCoords` short-circuit needed: since London
    // synthetic IS the active primary whenever these layers are
    // interactive, and every diamond's coord is in the cluster, the
    // stripped-down modal branch fires on its own via the existing
    // isPrimaryOrigin plumbing.
    if (
      feature.layer?.id === "london-terminus-icon" ||
      feature.layer?.id === "london-terminus-origin-icon"
    ) {
      const diamondCoord = feature.properties?.coordKey as string | undefined
      if (diamondCoord) {
        const real = stations?.features.find(
          (f) => (f.properties as { coordKey?: string } | undefined)?.coordKey === diamondCoord
        )
        if (real) feature = real as unknown as typeof feature
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
    // Secret admin toggle — invisible marker at Boulogne-Tintelleries (France)
    if (feature.properties?.isSecretAdmin) {
      const next = !devExcludeActive
      setDevExcludeActive(next)
      if (next) {
        // Admin on — max slider extends to 600; open wide so nothing is hidden
        setMaxMinutes(600)
        setFriendMaxMinutes(600)
        setVisibleRatings(new Set())
      } else {
        // Admin off — clamp sliders to the non-admin cap (150) so the thumb stays in range
        setMaxMinutes((m) => Math.min(m, 150))
        setFriendMaxMinutes((m) => Math.min(m, 150))
      }
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
      .mapboxgl-ctrl-attrib.mapboxgl-compact { background: transparent !important; }
      .mapboxgl-ctrl-attrib-button {
        opacity: 0.4;
        background-color: transparent !important;
        background-image: none !important;
        font-size: 16px;
        line-height: 24px;
        text-align: center;
      }
    `
    document.head.appendChild(style)

    // Replace the ⓘ icon with a © character.
    const attribBtn = document.querySelector('.mapboxgl-ctrl-attrib-button')
    if (attribBtn) attribBtn.textContent = '©'

    // Move the attribution control from the default bottom-right corner to
    // the bottom-left, sitting just after the Mapbox logo. Frees the bottom-
    // right slot for the mobile help button (? icon).
    const attribCtrl = document.querySelector('.mapboxgl-ctrl-bottom-right .mapboxgl-ctrl-attrib')
    const bottomLeftCtrl = document.querySelector('.mapboxgl-ctrl-bottom-left')
    if (attribCtrl && bottomLeftCtrl) bottomLeftCtrl.appendChild(attribCtrl)

    // Register custom icon images for station markers.
    registerIcons(map)

    // Re-register icons on every subsequent style change (dark/light theme swap).
    // The flat styles already have road/label hiding baked in, so no basemap
    // configuration is needed — just icon re-registration.
    map.on('style.load', () => {
      registerIcons(map)
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
    add('icon-unverified',      createRatingIcon('hexagon',        colors.secondary, stroke))
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
  }

  // No configureBasemap needed — the flat styles (Outdoors v12-based) have road
  // hiding, label visibility, and zoom ranges baked in at the style level.

  return (
    <div className="relative h-full w-full">
      <FilterPanel
        maxMinutes={maxMinutes}
        onChange={setMaxMinutes}
        minMinutes={minMinutes}
        onMinChange={setMinMinutes}
        showTrails={showTrails}
        onToggleTrails={setShowTrails}
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
        // Admin-only origins (e.g. Charing Cross) are visible in the dropdown
        // only when devExcludeActive is on.
        primaryOriginGroups={devExcludeActive ? PRIMARY_ORIGIN_GROUPS_ALL : PRIMARY_ORIGIN_GROUPS_PUBLIC}
        onPrimaryOriginChange={setPrimaryOrigin}
        // Both callbacks receive a coord key now. ALL_ORIGINS merges primary+friend
        // so the filter-panel can label either role with one callback.
        originDisplayName={(key) => ALL_ORIGINS[key]?.displayName ?? key}
        originMobileDisplayName={(key) => ALL_ORIGINS[key]?.mobileDisplayName}
        originMenuName={(key) => ALL_ORIGINS[key]?.menuName ?? key}
        // Phase 2: admin-only search / custom primary support.
        searchableStations={searchableStations}
        recentPrimaries={recentCustomPrimaries}
        onCustomPrimarySelect={selectCustomPrimary}
        coordToName={coordToName}
        friendOrigin={friendOrigin}
        friendOrigins={FRIEND_ORIGIN_KEYS}
        onFriendOriginChange={setFriendOrigin}
        friendMaxMinutes={friendMaxMinutes}
        onFriendMaxMinutesChange={setFriendMaxMinutes}
        onActivateFriend={() => setFriendOrigin(FRIEND_ORIGIN_KEYS[0])}
        onDeactivateFriend={() => setFriendOrigin(null)}
        primaryDirectOnly={primaryDirectOnly}
        // Toggling "Direct" clears "Indirect" (and vice-versa below) — they're
        // mutually exclusive. Without this, a user could leave both ticked
        // and see zero stations rendered, which reads as a bug rather than
        // a configuration choice.
        onPrimaryDirectOnlyChange={(v) => {
          setPrimaryDirectOnly(v)
          if (v) setPrimaryIndirectOnly(false)
        }}
        primaryIndirectOnly={primaryIndirectOnly}
        onPrimaryIndirectOnlyChange={(v) => {
          setPrimaryIndirectOnly(v)
          if (v) setPrimaryDirectOnly(false)
        }}
        friendDirectOnly={friendDirectOnly}
        onFriendDirectOnlyChange={setFriendDirectOnly}
      />

      <WelcomeBanner
        open={bannerVisible}
        onDismiss={() => {
          setBannerVisible(false)
          // Remember the user has seen it — subsequent visits skip the
          // banner unless they explicitly click the hexagon again.
          setHasSeenWelcome(true)
        }}
        originX={bannerOrigin?.x}
        originY={bannerOrigin?.y}
      />

      {/* Help button — bottom-right on mobile (attribution © is moved to
          the bottom-left to free this slot; avoids overlapping with the
          filter menu in the top-left). Top-right on desktop as the
          rightmost of the pair (theme toggle is shifted to right-14 in
          page.tsx). Clicking re-opens the welcome banner, animating out
          from the button's own position. */}
      <div className="absolute bottom-4 right-4 md:bottom-auto md:top-4 z-50">
        <HelpButton
          onClick={(origin) => {
            // Animate from the button itself (passed through from the click),
            // NOT from the London hexagon — matches the visual expectation
            // that the banner "emerges" from whatever summoned it.
            setBannerOrigin(origin)
            setBannerVisible(true)
          }}
        />
      </div>


      {/* Dev mode toggle + zoom badge — only rendered in local development.
          process.env.NODE_ENV is inlined at build time by Next.js, so this
          entire block is stripped from production bundles (dead-code elimination). */}
      {process.env.NODE_ENV === "development" && (
        <div className="absolute bottom-4 left-1/2 z-10 flex -translate-x-1/2 items-center gap-2">
          <button
            onClick={() => {
              const next = !devExcludeActive
              setDevExcludeActive(next)
              // Show all stations when entering dev mode so nothing is hidden while curating
              if (next) {
                setMaxMinutes(600)
                setFriendMaxMinutes(600)
                // Clear all rating checkboxes — empty set means "show all" in the filter logic
                setVisibleRatings(new Set())
              } else {
                setMaxMinutes((m) => Math.min(m, 150))
                setFriendMaxMinutes((m) => Math.min(m, 150))
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
        </div>
      )}

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
          "london-terminus-icon", "london-terminus-origin-icon",
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
                  // the hiking-destination icons.
                  "icon-size": 0.6,
                  // Always render even if another symbol is in the way
                  // (e.g. Mapbox's own base-style station symbols).
                  "icon-allow-overlap": true,
                  "icon-ignore-placement": true,
                }}
              />
            </Source>
            <Source id="london-termini-labels" type="geojson" data={londonTerminusFeatures.labels}>
              <Layer
                id="london-terminus-label"
                type="symbol"
                // Names only start showing in when you've zoomed in enough
                // to distinguish individual termini from the cluster.
                minzoom={11}
                layout={{
                  "text-field": ["get", "name"],
                  "text-size": 11,
                  // Nudge the label below the diamond so the icon stays visible.
                  "text-offset": [0, 0.9],
                  "text-anchor": "top",
                  "text-font": ["Open Sans Regular", "Arial Unicode MS Regular"],
                  "text-allow-overlap": false,
                }}
                paint={{
                  "text-color": labelColor,
                  "text-halo-color": haloColor,
                  "text-halo-width": 1.5,
                }}
              />
            </Source>

            {/* Journey-origin overlay — the single diamond (+ label)
                matching the currently-hovered journey's departure
                terminus. No minzoom gating, so the user sees WHERE
                their train starts even when zoomed out to a
                country-wide view.

                CRITICAL: Source is ALWAYS mounted — toggling data
                rather than conditionally mounting the Source. A
                conditionally-mounted Source re-adds its layers to
                Mapbox's style on every re-mount, which puts them on
                TOP of later-declared sources (like london-marker).
                The hexagon would then get buried under the diamond
                every time a new journey was hovered. Always-mounting
                keeps the layers at a fixed position in the style,
                so they stay beneath london-icon / london-label
                regardless of hover churn. */}
            <Source
              id="london-termini-origin"
              type="geojson"
              data={{
                type: "FeatureCollection",
                features: journeyOriginClusterCoord
                  ? [{
                      type: "Feature",
                      geometry: {
                        type: "Point",
                        coordinates: journeyOriginClusterCoord,
                      },
                      properties: {
                        // Find matching label for the origin coord.
                        // Label layer reads properties.name — empty
                        // string when no matching label means the
                        // label layer renders nothing.
                        name: (() => {
                          const [oLng, oLat] = journeyOriginClusterCoord
                          let bestLabel: string | null = null
                          let bestDist = Infinity
                          for (const lf of londonTerminusFeatures.labels.features) {
                            const [l, a] = lf.geometry.coordinates as [number, number]
                            const d = (l - oLng) ** 2 + (a - oLat) ** 2
                            if (d < bestDist) {
                              bestDist = d
                              bestLabel = lf.properties.name as string
                            }
                          }
                          return bestDist < 1e-5 ? (bestLabel ?? "") : ""
                        })(),
                      },
                    }]
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
              />
              <Layer
                id="london-terminus-origin-label"
                type="symbol"
                // Don't render when the data feature has empty name
                // (i.e. there's no journey hovered, or the polyline
                // doesn't originate at a known terminus). Cleaner
                // than conditionally rendering the <Layer>.
                filter={["!=", ["get", "name"], ""]}
                layout={{
                  "text-field": ["get", "name"],
                  "text-size": 11,
                  "text-offset": [0, 0.9],
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
          </>
        )}

        {stationsForMap && (
          <Source id="stations" type="geojson" data={stationsForMap}>
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
                filter={["any", ["has", "rating"], ["has", "isOrigin"], ["has", "isExcluded"]]}
                layout={{
                  // Excluded (admin-only): cross. Origin: square. Others: rating-based.
                  "icon-image": ["case",
                    ["has", "isExcluded"], "icon-excluded",
                    ["has", "isOrigin"], "icon-origin",
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
                  // Higher value = drawn on top — origins above all, then rating, then excluded at the back
                  "symbol-sort-key": ["case",
                    ["has", "isExcluded"], -1,
                    ["has", "isOrigin"], 5,
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
                  // Excluded stations render at half the normal size — multiplying the base
                  // expression by 0.5 keeps hover and enter/leave animations working correctly.
                  "icon-size": ["*",
                    ["case", ["has", "isExcluded"], 0.5, 1],
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
                // Origin wins over everything; excluded is explicitly ranked below even
                // unrated stations so overlapping origins/excluded always resolve to origin.
                "circle-sort-key": ["case",
                  ["has", "isOrigin"], 5,
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
                // - Origin: enlarged (20px) so it's easier to click when overlapping other stations.
                // - Excluded: shrunk (10px) so it loses hit-tests near any non-excluded station.
                // - Others: default 16px.
                // Radius depends only on feature properties (not hover state), so Mapbox
                // doesn't repaint the layer on hover — that would cause hover flicker.
                "circle-radius": ["case",
                  ["has", "isOrigin"], 20,
                  ["has", "isExcluded"], 10,
                  16,
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
              ["station-labels-rated", 8, ["in", ["get", "rating"], ["literal", ["verified", "unverified"]]]],
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
                  // When friend mode is active, show both times separated by " & "
                  ...(friendOrigin
                    ? [["concat", timeExpression("londonMinutes"), " & ", timeExpression("friendMinutes")], { "font-scale": 0.8 }]
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
                        ["get", "name"], { "font-scale": 1 },
                        "\n", {},
                        ...(friendOrigin
                          ? [["concat", timeExpression("londonMinutes"), " & ", timeExpression("friendMinutes")], { "font-scale": 0.8 }]
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
                // Desktop: ~2x the default 16px station-hit-area radius.
                // Mobile: 4x the default (64px) — once a station is already
                // in the pulsing "preview" state, we want a huge, unmissable
                // tap target so the second tap reliably opens the modal
                // even if the finger drifts beyond the visible icon. This
                // layer is rendered LAST in the Mapbox layer stack, which
                // combined with the handleTouchStart/handleClick feature
                // preference (see below) means the hovered station always
                // wins taps within this enlarged zone — regardless of
                // whether a neighbouring station is highlight/verified/etc.
                "circle-radius": isMobile ? 64 : 32,
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
            // When the click is on the PRIMARY station itself AND that
            // primary has a cluster (KX, Waterloo, Stratford, or the
            // London synthetic), show the cluster's menuName as the
            // overlay title — "Kings Cross, St Pancras, & Euston" /
            // "Waterloo & Waterloo East" / "Stratford & Stratford
            // International" / "Central London" — rather than just the
            // shorthand displayName. The map label stays shorthand via
            // displayName on the hexagon's own text-field; this affects
            // the modal/overlay only.
            //
            // No " Station" suffix in any of these cases (handled via
            // the isSynthetic prop below — set true for both true
            // synthetics AND primaries-with-clusters, so the title reads
            // as a place, not a single station).
            stationName={
              displayStation.coordKey === primaryOrigin &&
              !!PRIMARY_ORIGIN_CLUSTER[primaryOrigin]
                ? (PRIMARY_ORIGINS[primaryOrigin]?.menuName ?? displayStation.name)
                : displayStation.name
            }
            minutes={displayStation.minutes}
            flickrCount={displayStation.flickrCount}
            originX={displayStation.screenX}
            originY={displayStation.screenY}
            devMode={devExcludeActive}
            currentRating={ratings[displayStation.coordKey] ?? null}
            onRate={(rating: Rating | null) => handleRate(displayStation.coordKey, displayStation.name, rating)}
            onExclude={() => handleToggleExclusion(displayStation.name, displayStation.coordKey)}
            isExcluded={excludedStations.has(displayStation.coordKey)}
            isOrigin={originStations.has(displayStation.coordKey)}
            onToggleOrigin={() => handleToggleOrigin(displayStation.coordKey, displayStation.name)}
            approvedPhotos={curations[displayStation.coordKey]?.approved ?? []}
            rejectedIds={new Set(curations[displayStation.coordKey]?.rejected ?? [])}
            onApprovePhoto={(photo) => handleApprovePhoto(displayStation.coordKey, displayStation.name, photo)}
            onRejectPhoto={(photoId) => handleRejectPhoto(displayStation.coordKey, displayStation.name, photoId)}
            onUnapprovePhoto={(photoId) => handleUnapprovePhoto(displayStation.coordKey, displayStation.name, photoId)}
            onMovePhoto={(photoId, direction) => handleMovePhoto(displayStation.coordKey, displayStation.name, photoId, direction)}
            publicNote={stationNotes[displayStation.coordKey]?.publicNote ?? ""}
            privateNote={stationNotes[displayStation.coordKey]?.privateNote ?? ""}
            onSaveNotes={(pub, priv) => handleSaveNotes(displayStation.coordKey, displayStation.name, pub, priv)}
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
            // Suppress the " Station" suffix in two cases:
            //   1. Synthetic primaries (City of London at Guildhall) — the
            //      name is a place, not a station.
            //   2. Clicks on a clustered-primary station (KX, Waterloo) —
            //      the title is the cluster's menuName, which already
            //      enumerates the stations, so " Station" reads oddly.
            isSynthetic={
              !!PRIMARY_ORIGINS[displayStation.coordKey]?.isSynthetic ||
              (displayStation.coordKey === primaryOrigin && !!PRIMARY_ORIGIN_CLUSTER[primaryOrigin])
            }
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
      <div
        aria-hidden={notificationPhase === "idle"}
        className={cn(
          "pointer-events-none absolute inset-0 z-[50] flex items-center justify-center",
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
        <div className="flex items-center gap-3 rounded-full bg-background/90 px-4 py-2 shadow-lg ring-1 ring-border">
          {notificationPhase !== "loading" ? (
            /* Tick. Rendered whenever we're NOT actively loading —
                i.e. during "success" AND "idle". Using "not loading"
                rather than "success only" matters during the fade-out:
                phase flips success→idle INSTANTLY, but the pill's
                opacity takes 200ms to animate to 0. If the icon
                swapped back to the spinner the moment phase became
                "idle", the user would see the checkmark briefly
                replaced by a spinner as the pill faded away. By
                keeping the tick during "idle", it stays visible
                throughout the fade-out. During the INITIAL idle
                (before any interaction) the outer opacity-0 hides
                the pill anyway, so there's no visual cost.

                Same 20px footprint as the spinner so the pill
                doesn't reflow when the icon swaps. Inline SVG
                (rather than pulling in an icon lib for a single
                glyph) — path is a classic Heroicons checkmark. */
            <svg
              aria-label="Done"
              // text-primary maps to CSS --primary, the same token
              // used for Heavenly (icon-highlight) and Good
              // (icon-verified) map icons via colors.primary.
              // Keeping success messaging on-brand instead of a
              // generic green.
              className="h-5 w-5 text-primary"
              viewBox="0 0 20 20"
              fill="currentColor"
            >
              <path
                fillRule="evenodd"
                clipRule="evenodd"
                d="M16.707 5.293a1 1 0 010 1.414l-8 8a1 1 0 01-1.414 0l-4-4a1 1 0 011.414-1.414L8 12.586l7.293-7.293a1 1 0 011.414 0z"
              />
            </svg>
          ) : (
            <span
              aria-label="Loading"
              className="inline-block h-5 w-5 animate-spin rounded-full border-2 border-muted-foreground/30 border-t-primary"
            />
          )}
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
          <span className="text-sm font-medium">
            Looking up trains from {pendingPrimaryCoord
              ? (
                  PRIMARY_ORIGIN_CLUSTER[pendingPrimaryCoord]
                    ? (PRIMARY_ORIGINS[pendingPrimaryCoord]?.menuName
                        ?? PRIMARY_ORIGINS[pendingPrimaryCoord]?.displayName
                        ?? pendingPrimaryCoord)
                    : (PRIMARY_ORIGINS[pendingPrimaryCoord]?.displayName
                        ?? coordToName[pendingPrimaryCoord]
                        ?? "new home")
                )
              : "new home"}
          </span>
        </div>
      </div>
    </div>
  )
}

