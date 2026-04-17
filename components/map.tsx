"use client"

import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { useTheme } from "next-themes"
import Map, { Layer, MapMouseEvent, MapRef, Source } from "react-map-gl/mapbox"
import "mapbox-gl/dist/mapbox-gl.css"
import FilterPanel from "@/components/filter-panel"
import { WelcomeBanner } from "@/components/welcome-banner"
import StationModal, { type FlickrPhoto, type JourneyInfo } from "@/components/photo-overlay"
import excludedStationsList from "@/data/excluded-stations.json"
import originStationsList from "@/data/origin-stations.json"
import { getColors } from "@/lib/tokens"

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

// Coordinates for each supported primary origin — the active one drives the
// origin marker position, polyline lookups, and londonMinutes override.
const ORIGIN_COORDS: Record<string, { lat: number; lng: number }> = {
  Farringdon: { lat: 51.5203, lng: -0.1053 },
  Stratford:  { lat: 51.541289, lng: -0.0035472 },
}

// Extensible lists of origin stations available in each dropdown.
// Add new entries here as more origins get journey data.
const PRIMARY_ORIGINS = ["Farringdon", "Stratford"]
const FRIEND_ORIGINS = ["Birmingham New Street", "Nottingham"]

// Short display names for the filter UI — full canonical names are used
// everywhere else (data lookups, property keys). Only add entries for
// stations whose full name is too long for the panel.
const ORIGIN_DISPLAY_NAMES: Record<string, string> = {
  "Birmingham New Street": "Birmingham",
}

// White outline thickness for station icons and dots — lower = thinner strokes
const STATION_STROKE_WIDTH = 1.0

// Hover radius circles — tweak these to change the on-hover walkable-area indicators
const INNER_RADIUS_KM = 7
const OUTER_RADIUS_KM = 14

// Stations manually excluded — edit data/excluded-stations.json to add/remove entries.
// Entries are either station names (legacy) or "lng,lat" coord keys (preferred — unambiguous when two stations share a name).
// INITIAL_EXCLUDED_STATIONS seeds the state; admin toggling mutates the state set.
const INITIAL_EXCLUDED_STATIONS = new Set(excludedStationsList)

// Origin stations — shown as squares, only visible in admin mode (except London/Farringdon
// which has its own dedicated marker). Lowercase for case-insensitive matching.
// INITIAL_ORIGIN_STATIONS seeds the state; admin toggling mutates the state set.
const INITIAL_ORIGIN_STATIONS = new Set(originStationsList.map(n => n.toLowerCase()))

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
function createRatingIcon(shape: 'star' | 'triangle-up' | 'triangle-down' | 'circle' | 'square' | 'hexagon' | 'cross', color: string, strokeColor: string): ImageData {
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
  const [primaryOrigin, setPrimaryOrigin] = useState("Farringdon")
  const originCoords = ORIGIN_COORDS[primaryOrigin]
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
  const [maxMinutes, setMaxMinutes] = useState(150)
  // Admin-only lower bound on travel time — 0 means "no minimum" (disabled)
  const [minMinutes, setMinMinutes] = useState(0)
  // Friend origin mode — when non-null, a second origin filters stations
  const [friendOrigin, setFriendOrigin] = useState<string | null>(null)
  const [friendMaxMinutes, setFriendMaxMinutes] = useState(150)
  // "Direct trains only" toggles — when true, only keep stations reachable
  // from the matching origin with zero interchanges (journeys[origin].changes === 0)
  const [primaryDirectOnly, setPrimaryDirectOnly] = useState(false)
  const [friendDirectOnly, setFriendDirectOnly] = useState(false)
  const [hovered, setHovered] = useState<HoveredStation | null>(null)
  const [showTrails, setShowTrails] = useState(false)
  const [bannerVisible, setBannerVisible] = useState(true)
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
  // Mobile defaults to "Heavenly" only for a curated first impression;
  // desktop shows the three positive ratings. 640px matches Tailwind's `sm` breakpoint.
  // Empty set = no filter = all stations visible
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

  // Derived stations — overrides londonMinutes when primaryOrigin isn't Farringdon,
  // so slider filtering and Mapbox labels show the selected origin's travel times.
  // Recomputes when the user switches origin via the dropdown, without re-fetching.
  const stations = useMemo(() => {
    if (!baseStations) return null
    return {
      ...baseStations,
      features: baseStations.features.map((f) => {
        const name = (f.properties.name as string ?? '').toLowerCase()
        const shouldBeOrigin = originStations.has(name)
        // Excluded set is coordKey-only now (ambiguous name entries were migrated)
        const shouldBeExcluded = excludedStations.has(f.properties.coordKey as string)

        // Apply primaryOrigin-dependent minute override (skipped when Farringdon is primary)
        const journeys = f.properties.journeys as Record<string, { durationMinutes?: number }> | undefined
        const originMins = primaryOrigin !== "Farringdon" ? journeys?.[primaryOrigin]?.durationMinutes : undefined

        // Build next properties — flip isOrigin + isExcluded flags, and optionally override londonMinutes
        const next: Record<string, unknown> = { ...f.properties }
        if (shouldBeOrigin) next.isOrigin = true
        else delete next.isOrigin
        if (shouldBeExcluded) next.isExcluded = true
        else delete next.isExcluded
        if (originMins != null) next.londonMinutes = originMins

        return { ...f, properties: next as StationFeature["properties"] }
      }),
    }
  }, [baseStations, primaryOrigin, originStations, excludedStations])

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
        if (f.properties.isExcluded) {
          if (!devExcludeActive) return false
          return passesTimeFilter()
        }

        // Origin stations: hidden in non-admin mode (except the active friend origin).
        // In admin mode they now respect the time sliders too.
        if (f.properties.isOrigin) {
          if (!devExcludeActive) {
            if (friendOrigin && (f.properties.name as string) === friendOrigin) return true
            return false
          }
          return passesTimeFilter()
        }

        // Regular destination stations — must have time data in range
        if (mins == null) return false
        if (maxMinutes < 600 && mins > maxMinutes) return false
        if (minMinutes > 0 && mins < minMinutes) return false
        // "Direct trains only" for the primary origin — require 0 changes.
        // Pulls from the journeys record keyed by the currently selected primary origin.
        if (primaryDirectOnly) {
          const journeys = f.properties.journeys as Record<string, { changes?: number }> | undefined
          const primaryChanges = journeys?.[primaryOrigin]?.changes
          if (primaryChanges == null || primaryChanges > 0) return false
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
  }, [stations, maxMinutes, minMinutes, friendOrigin, friendMaxMinutes, devExcludeActive, primaryOrigin, primaryDirectOnly, friendDirectOnly])

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
  // Stamps boolean flags (isNew / isLeaving) — NOT the scale values themselves.
  // Scale values live in the Layer expressions so stationsForMap doesn't recompute
  // on every animation frame, and avoids stale-value flashes on the first render.
  const stationsForMap = useMemo(() => {
    if (!allStationsWithRatings) return null
    return {
      ...allStationsWithRatings,
      features: allStationsWithRatings.features
        .filter(f => {
          // The active friend origin always shows regardless of rating filters
          if (friendOrigin && (f.properties.name as string) === friendOrigin) return true
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
  const handleToggleOrigin = useCallback(async (name: string) => {
    const lower = name.toLowerCase()
    let nextIsOrigin = false
    setOriginStations((prev) => {
      const next = new Set(prev)
      if (next.has(lower)) { next.delete(lower); nextIsOrigin = false }
      else { next.add(lower); nextIsOrigin = true }
      return next
    })
    await fetch("/api/dev/toggle-origin-station", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name, isOrigin: nextIsOrigin }),
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
          const name = (f.properties.name as string ?? '').toLowerCase()
          // Stamp coordKey for consistent identity, and isOrigin for origin stations
          const extra: Record<string, unknown> = { coordKey: `${lng},${lat}` }
          if (INITIAL_ORIGIN_STATIONS.has(name)) extra.isOrigin = true
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
  const hoveredJourneyCoords = useMemo(() => {
    if (!hovered || !stations) return null
    const feature = stations.features.find(
      (f) => `${f.geometry.coordinates[0]},${f.geometry.coordinates[1]}` === hovered.coordKey
    )
    const journeys = feature?.properties?.journeys as Record<string, { polyline?: string }> | undefined
    // Use the primary origin's polyline (not first-found) to avoid picking up friend origin's
    const polyline = journeys?.[primaryOrigin]?.polyline
    if (!polyline) return null
    return decodePolyline(polyline)
  }, [hovered, stations, primaryOrigin])

  // Friend origin polyline — same logic but for the friend's journey
  const hoveredFriendJourneyCoords = useMemo(() => {
    if (!friendOrigin || !hovered || !stations) return null
    const feature = stations.features.find(
      (f) => `${f.geometry.coordinates[0]},${f.geometry.coordinates[1]}` === hovered.coordKey
    )
    const journeys = feature?.properties?.journeys as Record<string, { polyline?: string }> | undefined
    const polyline = journeys?.[friendOrigin]?.polyline
    if (!polyline) return null
    return decodePolyline(polyline)
  }, [friendOrigin, hovered, stations])

  // Whether the currently hovered station is the active friend origin —
  // used to show "liberate your friend" instead of travel times in the label
  const hoveredIsFriendOrigin = useMemo(() => {
    if (!friendOrigin || !hovered) return false
    const feature = stationsForMap?.features.find(
      f => (f.properties.coordKey as string) === hovered.coordKey
    )
    return (feature?.properties.name as string) === friendOrigin
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
    setHovered({ lng, lat, coordKey })
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

  // Long-press on touch: after 400ms hold on a station, show radius circles.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const handleTouchStart = useCallback((e: any) => {
    const point = e.point // {x, y} pixel coords on the map canvas
    const map = mapRef.current?.getMap()
    if (!map || !point) return

    // Query which station (if any) is under the finger
    const features = map.queryRenderedFeatures([point.x, point.y], {
      layers: ["station-hit-area", "london-hit-area"],
    })
    if (!features.length) return

    const feature = features[0]
    longPressTimer.current = setTimeout(() => {
      const coordKey = feature.properties?.coordKey as string
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const [lng, lat] = (feature.geometry as any).coordinates as [number, number]
      hoveredRef.current = coordKey
      setHovered({ lng, lat, coordKey })
      setRadiusPos({ lng, lat })
      longPressTimer.current = null
      longPressFired.current = true
    }, 400)
  }, [])

  // Cancel the long-press if the finger lifts or moves (pan gesture)
  const handleTouchEndOrMove = useCallback(() => {
    if (longPressTimer.current) {
      clearTimeout(longPressTimer.current)
      longPressTimer.current = null
    }
    // Clear circles when finger lifts
    hoveredRef.current = null
    setHovered(null)
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
    const feature = e.features?.[0]
    if (!feature) {
      setSelectedStation(null)
      return
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
    // London hexagon marker — open the welcome banner instead of station modal
    if (feature.properties?.isLondon) {
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
  }, [devExcludeActive, setMaxMinutes, setVisibleRatings, stations])

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

    // Replace the ⓘ icon with a © character
    const attribBtn = document.querySelector('.mapboxgl-ctrl-attrib-button')
    if (attribBtn) attribBtn.textContent = '©'

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
        primaryOrigins={PRIMARY_ORIGINS}
        onPrimaryOriginChange={setPrimaryOrigin}
        originDisplayName={(name) => ORIGIN_DISPLAY_NAMES[name] ?? name}
        friendOrigin={friendOrigin}
        friendOrigins={FRIEND_ORIGINS}
        onFriendOriginChange={setFriendOrigin}
        friendMaxMinutes={friendMaxMinutes}
        onFriendMaxMinutesChange={setFriendMaxMinutes}
        onActivateFriend={() => setFriendOrigin(FRIEND_ORIGINS[0])}
        onDeactivateFriend={() => setFriendOrigin(null)}
        primaryDirectOnly={primaryDirectOnly}
        onPrimaryDirectOnlyChange={setPrimaryDirectOnly}
        friendDirectOnly={friendDirectOnly}
        onFriendDirectOnlyChange={setFriendDirectOnly}
      />

      <WelcomeBanner
        open={bannerVisible}
        onDismiss={() => setBannerVisible(false)}
        originX={bannerOrigin?.x}
        originY={bannerOrigin?.y}
      />

      {/* Dev mode toggle + zoom badge — only rendered in local development.
          process.env.NODE_ENV is inlined at build time by Next.js, so this
          entire block is stripped from production bundles (dead-code elimination). */}
      {process.env.NODE_ENV === "development" && (
        <div className="absolute bottom-8 left-2 z-10 flex items-center gap-2">
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
        interactiveLayerIds={["station-hit-area", "london-hit-area", "secret-admin-hit"]}
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

        {/* London origin marker — hexagon at Farringdon, opens welcome banner on click */}
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
          {/* Hover label — only appears when the London hexagon is hovered,
              same pattern as station-label-hover */}
          {hovered?.coordKey === "london" && (
            <Layer
              id="london-label"
              type="symbol"
              layout={{
                "text-field": [
                  "format",
                  primaryOrigin, { "font-scale": 1 },
                  "\n", {},
                  "time to escape", { "font-scale": 0.8 },
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

        {/* Station modal — opens when a dot is clicked, dismissed by clicking overlay.
            Uses displayStation (ref-backed) so the component stays mounted during the
            exit animation even after selectedStation is set to null. */}
        {displayStation && (
          <StationModal
            open={!!selectedStation}
            onClose={() => setSelectedStation(null)}
            lat={displayStation.lat}
            lng={displayStation.lng}
            stationName={displayStation.name}
            minutes={displayStation.minutes}
            flickrCount={displayStation.flickrCount}
            originX={displayStation.screenX}
            originY={displayStation.screenY}
            devMode={devExcludeActive}
            currentRating={ratings[displayStation.coordKey] ?? null}
            onRate={(rating: Rating | null) => handleRate(displayStation.coordKey, displayStation.name, rating)}
            onExclude={() => handleToggleExclusion(displayStation.name, displayStation.coordKey)}
            isExcluded={excludedStations.has(displayStation.coordKey)}
            isOrigin={originStations.has(displayStation.name.toLowerCase())}
            onToggleOrigin={() => handleToggleOrigin(displayStation.name)}
            approvedPhotos={curations[displayStation.coordKey]?.approved ?? []}
            rejectedIds={new Set(curations[displayStation.coordKey]?.rejected ?? [])}
            onApprovePhoto={(photo) => handleApprovePhoto(displayStation.coordKey, displayStation.name, photo)}
            onRejectPhoto={(photoId) => handleRejectPhoto(displayStation.coordKey, displayStation.name, photoId)}
            onUnapprovePhoto={(photoId) => handleUnapprovePhoto(displayStation.coordKey, displayStation.name, photoId)}
            onMovePhoto={(photoId, direction) => handleMovePhoto(displayStation.coordKey, displayStation.name, photoId, direction)}
            publicNote={stationNotes[displayStation.coordKey]?.publicNote ?? ""}
            privateNote={stationNotes[displayStation.coordKey]?.privateNote ?? ""}
            onSaveNotes={(pub, priv) => handleSaveNotes(displayStation.coordKey, displayStation.name, pub, priv)}
            journeys={displayStation.journeys}
            friendOrigin={friendOrigin}
            primaryOrigin={primaryOrigin}
            isFriendOrigin={!!friendOrigin && displayStation.name === friendOrigin}
          />
        )}
        </>}

      </Map>
    </div>
  )
}

