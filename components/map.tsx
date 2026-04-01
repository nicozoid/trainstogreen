"use client"

import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { useTheme } from "next-themes"
import Map, { Layer, MapMouseEvent, MapRef, Source } from "react-map-gl/mapbox"
import "mapbox-gl/dist/mapbox-gl.css"
import FilterPanel from "@/components/filter-panel"
import { WelcomeBanner } from "@/components/welcome-banner"
import StationModal, { type FlickrPhoto } from "@/components/photo-overlay"
import excludedStationsList from "@/data/excluded-stations.json"
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
}

const INITIAL_VIEW = {
  longitude: -0.118,
  latitude: 51.509,
  zoom: 7.4,
}

// Farringdon Station — used as the centre of London for the London marker on the map
const LONDON_CENTRE = { lat: 51.5203, lng: -0.1053 }

// White outline thickness for station icons and dots — lower = thinner strokes
const STATION_STROKE_WIDTH = 1.0

// Hover radius circles — tweak these to change the on-hover walkable-area indicators
const INNER_RADIUS_KM = 7
const OUTER_RADIUS_KM = 14

// Stations manually excluded — edit data/excluded-stations.json to add/remove entries.
// All entries are station names. If two stations share a name, add both (they'll both be excluded).
const EXCLUDED_STATIONS = new Set(excludedStationsList)

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
function createRatingIcon(shape: 'star' | 'triangle-up' | 'triangle-down' | 'circle' | 'hexagon', color: string, strokeColor: string): ImageData {
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
  } else if (shape === 'hexagon') {
    // Regular hexagon — 6 vertices evenly spaced around the centre
    ctx.beginPath()
    const cx = 12, cy = 12, hexR = 9
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
  // Ref keeps theme accessible inside the style.load callback (which is a stale
  // closure from handleMapLoad). Without this, registerIcons would always see
  // whatever theme was active when the map first loaded.
  const themeRef = useRef(theme)
  themeRef.current = theme
  const [stations, setStations] = useState<StationCollection | null>(null)
  // Start at 180min (the max) so all stations are visible on load
  const [maxMinutes, setMaxMinutes] = useState(120)
  const [hovered, setHovered] = useState<HoveredStation | null>(null)
  const [showTrails, setShowTrails] = useState(false)
  const [bannerVisible, setBannerVisible] = useState(true)
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
  // Tracks stations excluded this session — keyed by OSM node ID so two stations
  // with the same name (e.g. Newport Essex vs Newport Wales) are treated separately
  const [sessionExcluded, setSessionExcluded] = useState<Set<string>>(new Set())
  // Name of the last excluded station, shown in the undo toast (null = no toast)
  const [undoName, setUndoName] = useState<string | null>(null)
  // OSM node ID of the last excluded station — used by undo to re-include the right one
  const [undoId, setUndoId] = useState<string | null>(null)
  // Ref holds the auto-dismiss timer so we can cancel it if undo is clicked
  const undoTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  // Dev tool — toggled on/off via the badge button; off by default
  const [devExcludeActive, setDevExcludeActive] = useState(false)
  // The station whose detail panel is open, or null if none
  const [selectedStation, setSelectedStation] = useState<SelectedStation | null>(null)
  // Maps coordKey → rating; loaded from data/station-ratings.json via API.
  // Universal (not per-user) — ratings are set in dev mode and affect all viewers.
  const [ratings, setRatings] = useState<Record<string, Rating>>({})
  // Which rating categories to filter to — empty means "show all" (no filter active).
  // "unrated" is a pseudo-category for stations without any rating.
  // Default: show only the three positive ratings; "Unworthy" and "Unknown" start hidden
  const [visibleRatings, setVisibleRatings] = useState<Set<string>>(new Set(['highlight', 'verified', 'unverified']))

  // Photo curations — per-station approved/rejected photo lists, loaded from
  // data/photo-curations.json via API. Only used in admin mode.
  type CurationEntry = { name: string; approved: FlickrPhoto[]; rejected: string[] }
  const [curations, setCurations] = useState<Record<string, CurationEntry>>({})

  // Fetch universal ratings and photo curations on mount
  useEffect(() => {
    fetch("/api/dev/rate-station")
      .then((res) => res.json())
      .then((data) => setRatings(data))
    fetch("/api/dev/curate-photo")
      .then((res) => res.json())
      .then((data) => setCurations(data))
  }, [])


  const [searchQuery, setSearchQuery] = useState("")
  // Only filter once the user has typed at least 3 characters
  const isSearching = searchQuery.length >= 3

  // Recompute filtered stations whenever the slider or raw data changes.
  // useMemo avoids re-filtering the whole array on every render.
  const filteredStations = useMemo(() => {
    if (!stations) return null
    return {
      ...stations,
      features: stations.features.filter((f) => {
        const mins = f.properties.londonMinutes as number | null
        if (mins == null || mins > maxMinutes) return false
        // In dev mode, also hide stations excluded this session (before hot-reload kicks in).
        // Read coordKey from properties — it was stamped in at load time from the original
        // coordinates, so it's guaranteed to match what the click handler stored.
        if (devExcludeActive && sessionExcluded.has(f.properties.coordKey as string)) return false
        return true
      }),
    }
  }, [stations, maxMinutes, sessionExcluded, devExcludeActive])

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

  // Injects a `rating` property into each visible feature that has one.
  // Mapbox reads it via ["get", "rating"] in layer expressions.
  // Derived from displayedStations (after search) so ratings respect the search filter.
  // Only rated stations get the property — unrated features are passed through unchanged.
  const displayedStationsWithRatings = useMemo(() => {
    if (!displayedStations) return null
    return {
      ...displayedStations,
      features: displayedStations.features
        .map(f => {
          const r = ratings[f.properties.coordKey as string]
          if (!r) return f
          return { ...f, properties: { ...f.properties, rating: r } }
        })
        // Filter by the visible-ratings checkboxes — empty set means "show all"
        .filter(f => {
          if (visibleRatings.size === 0) return true
          const r = f.properties.rating as string | undefined
          return r ? visibleRatings.has(r) : visibleRatings.has('unrated')
        }),
    }
  }, [displayedStations, ratings, visibleRatings])

  // Dev action: exclude a station (called from the modal's delete button)
  const handleExcludeFromModal = useCallback(async (name: string, coordKey: string) => {
    setSessionExcluded((prev) => new Set([...prev, coordKey]))
    setSelectedStation(null)
    // Show undo toast
    if (undoTimer.current) clearTimeout(undoTimer.current)
    setUndoName(name)
    setUndoId(coordKey)
    undoTimer.current = setTimeout(() => setUndoName(null), 5000)
    await fetch("/api/dev/exclude-station", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name, coordKey }),
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
          // Cast restores the index signature that TypeScript loses when spreading a mapped type
          return { ...f, properties: { ...f.properties, coordKey: `${lng},${lat}` } as StationFeature["properties"] }
        })

        // Filter out excluded stations
        const outside = stamped.filter((f) => {
          return (
            // Keep National Rail/Overground/Elizabeth line stations (have a CRS code),
            // or TfL stations (London Underground / DLR). Blocks heritage railways,
            // which OSM tags with usage=tourism and no CRS code.
            (f.properties["ref:crs"] != null ||
              f.properties["network"] === "London Underground" ||
              f.properties["network"] === "Docklands Light Railway") &&
            f.properties["usage"] !== "tourism" &&
            // Check both name (legacy exclusion entries) and coordKey (new entries)
            !EXCLUDED_STATIONS.has(f.properties.name as string) &&
            !EXCLUDED_STATIONS.has(f.properties.coordKey as string)
          )
        })
        setStations({ ...data, features: outside })
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
    handleExcludeFromModal(name, coordKey)
  }, [devExcludeActive, handleExcludeFromModal])

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
    // London hexagon marker — open the welcome banner instead of station modal
    if (feature.properties?.isLondon) {
      setBannerVisible(true)
      return
    }
    const [lng, lat] = (feature.geometry as unknown as { coordinates: [number, number] }).coordinates
    setHovered(null)
    setSelectedStation({
      name: feature.properties?.name as string,
      lng,
      lat,
      minutes: feature.properties?.londonMinutes as number,
      coordKey: feature.properties?.coordKey as string,
      flickrCount: feature.properties?.flickrCount as number | null ?? null,
    })
  }, [])

  // Dev only — reverses the last exclusion while the toast is still showing
  const handleUndo = useCallback(async () => {
    if (!undoName || !undoId) return
    if (undoTimer.current) clearTimeout(undoTimer.current)
    setUndoName(null)
    setUndoId(null)
    // Restore the station in local state immediately
    setSessionExcluded((prev) => {
      const next = new Set(prev)
      next.delete(undoId) // keyed by coordKey, not name
      return next
    })
    await fetch("/api/dev/include-station", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ coordKey: undoId }),
    })
  }, [undoName, undoId])

  // Called on initial map load and handles icon registration.
  // Also registers a style.load listener for theme swaps.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  function handleMapLoad(e: any) {
    const map = e.target
    // Touch zoom and rotate share one handler. disableRotation() keeps pinch-zoom
    // but removes the two-finger twist gesture that rotates the map on touchscreens.
    map.touchZoomRotate.disableRotation()

    // Register custom icon images for station markers.
    registerIcons(map)

    // Re-register icons on every subsequent style change (dark/light theme swap).
    // The flat styles already have road/label hiding baked in, so no basemap
    // configuration is needed — just icon re-registration.
    map.on('style.load', () => {
      registerIcons(map)
      setMapReady(true)
    })

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
    add('icon-unverified',      createRatingIcon('triangle-up',   colors.secondary, stroke))
    add('icon-not-recommended', createRatingIcon('triangle-down', colors.secondary, stroke))
    add('icon-london',          createRatingIcon('hexagon',       colors.primary,   stroke))
  }

  // No configureBasemap needed — the flat styles (Outdoors v12-based) have road
  // hiding, label visibility, and zoom ranges baked in at the style level.

  return (
    <div className="relative h-full w-full">
      <FilterPanel
        maxMinutes={maxMinutes}
        onChange={setMaxMinutes}
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
      />

      {bannerVisible && (
        <WelcomeBanner onDismiss={() => setBannerVisible(false)} />
      )}

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
                setMaxMinutes(180)
                // Clear all rating checkboxes — empty set means "show all" in the filter logic
                setVisibleRatings(new Set())
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

      {/* Undo toast — appears for 5s after a station is excluded.
          Centred horizontally, sits above the dev badge at the bottom. */}
      {devExcludeActive && undoName && (
        <div className="absolute bottom-16 left-1/2 z-20 flex -translate-x-1/2 items-center gap-3 rounded-lg bg-gray-900 px-4 py-2.5 shadow-lg">
          <span className="text-sm text-white">
            Excluded <span className="font-semibold">{undoName}</span>
          </span>
          {/* Undo button — styled as an inline text action, not a full button */}
          <button
            onClick={handleUndo}
            className="text-sm font-semibold text-yellow-400 hover:text-yellow-300"
          >
            Undo
          </button>
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
        interactiveLayerIds={["station-hit-area", "london-hit-area"]}
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
              geometry: { type: "Point", coordinates: [LONDON_CENTRE.lng, LONDON_CENTRE.lat] },
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
                  "London", { "font-scale": 1 },
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

        {displayedStationsWithRatings && (
          <Source id="stations" type="geojson" data={displayedStationsWithRatings}>
            {/* Unrated stations — canvas-drawn circle icon, same approach as rated icons */}
            <Layer
              id="station-dots"
              type="symbol"
              filter={["!", ["has", "rating"]]}
              layout={{
                "icon-image": "icon-unrated",
                "icon-allow-overlap": true,
                "icon-ignore-placement": true,
                // Slightly larger icon when hovered
                "icon-size": hovered
                  ? ["case", ["==", ["get", "coordKey"], hovered.coordKey], 1.3, 0.7]
                  : 0.7,
              }}
            />
            {/* Rated stations — shown as heart/circle icons instead of grey-green dots */}
            {mapReady && (
              <Layer
                id="station-rating-icons"
                type="symbol"
                filter={["has", "rating"]} // only features with a rating property
                layout={{
                  // "match" picks the right pre-loaded image by the rating value
                  "icon-image": ["match", ["get", "rating"],
                    "highlight",       "icon-highlight",
                    "verified",        "icon-verified",
                    "unverified",      "icon-unverified",
                    "not-recommended", "icon-not-recommended",
                    "" // fallback: no icon (shouldn't occur given the filter above)
                  ],
                  "icon-allow-overlap": true,    // don't hide icons when they overlap labels
                  "icon-ignore-placement": true, // don't let icons block other symbols
                  // Higher value = drawn on top — so better-rated stations sit above weaker ones
                  "symbol-sort-key": ["match", ["get", "rating"],
                    "highlight",       4,
                    "verified",        3,
                    "unverified",      2,
                    "not-recommended", 1,
                    0
                  ],
                  // Slightly larger icon when hovered
                  "icon-size": hovered
                    ? ["case", ["==", ["get", "coordKey"], hovered.coordKey], 1.3, 1]
                    : 1,
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
                // Sort key: higher value = drawn on top = returned first by queryRenderedFeatures
                "circle-sort-key": ["match", ["get", "rating"],
                  "highlight",       4,
                  "verified",        3,
                  "unverified",      2,
                  "not-recommended", 1,
                  0, // unrated stations get lowest priority
                ],
              }}
              paint={{
                // Constant radius — NOT dependent on hover state. If this changed
                // with `hovered`, every hover would trigger a Mapbox style repaint,
                // and during that repaint queryRenderedFeatures can briefly return
                // nothing — causing the hover to flicker on and off.
                "circle-radius": 16,
                "circle-color": "#000000",
                "circle-opacity": 0.01,  // near-invisible but still detected by Mapbox hit testing
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
              ["station-labels-highlight", 7, ["==", ["get", "rating"], "highlight"]],
              ["station-labels-rated", 8, ["in", ["get", "rating"], ["literal", ["verified", "unverified"]]]],
              ["station-labels-not-recommended", 10, ["==", ["get", "rating"], "not-recommended"]],
              ["station-labels-unrated", 10, ["!", ["has", "rating"]]],
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
                  ["case",
                    [">=", ["coalesce", ["get", "londonMinutes"], 0], 60],
                    ["concat",
                      ["to-string", ["floor", ["/", ["coalesce", ["get", "londonMinutes"], 0], 60]]], "h",
                      ["case",
                        [">", ["%", ["coalesce", ["get", "londonMinutes"], 0], 60], 0],
                        ["concat", " ", ["to-string", ["%", ["coalesce", ["get", "londonMinutes"], 0], 60]], "m"],
                        ""
                      ]
                    ],
                    ["concat", ["to-string", ["coalesce", ["get", "londonMinutes"], 0]], "m"]
                  ],
                  { "font-scale": 0.8 },
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
                  "text-field": [
                    "format",
                    ["get", "name"], { "font-scale": 1 },
                    "\n", {},
                    ["case",
                      [">=", ["coalesce", ["get", "londonMinutes"], 0], 60],
                      ["concat",
                        ["to-string", ["floor", ["/", ["coalesce", ["get", "londonMinutes"], 0], 60]]], "h",
                        ["case",
                          [">", ["%", ["coalesce", ["get", "londonMinutes"], 0], 60], 0],
                          ["concat", " ", ["to-string", ["%", ["coalesce", ["get", "londonMinutes"], 0], 60]], "m"],
                          ""
                        ]
                      ],
                      ["concat", ["to-string", ["coalesce", ["get", "londonMinutes"], 0]], "m"]
                    ],
                    { "font-scale": 0.8 },
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

        {/* Station modal — opens when a dot is clicked, dismissed by clicking overlay */}
        {selectedStation && (
          <StationModal
            open={!!selectedStation}
            onClose={() => setSelectedStation(null)}
            lat={selectedStation.lat}
            lng={selectedStation.lng}
            stationName={selectedStation.name}
            minutes={selectedStation.minutes}
            flickrCount={selectedStation.flickrCount}
            devMode={devExcludeActive}
            currentRating={ratings[selectedStation.coordKey] ?? null}
            onRate={(rating: Rating | null) => handleRate(selectedStation.coordKey, selectedStation.name, rating)}
            onExclude={() => handleExcludeFromModal(selectedStation.name, selectedStation.coordKey)}
            approvedPhotos={curations[selectedStation.coordKey]?.approved ?? []}
            rejectedIds={new Set(curations[selectedStation.coordKey]?.rejected ?? [])}
            onApprovePhoto={(photo) => handleApprovePhoto(selectedStation.coordKey, selectedStation.name, photo)}
            onRejectPhoto={(photoId) => handleRejectPhoto(selectedStation.coordKey, selectedStation.name, photoId)}
            onUnapprovePhoto={(photoId) => handleUnapprovePhoto(selectedStation.coordKey, selectedStation.name, photoId)}
          />
        )}
        </>}

      </Map>
    </div>
  )
}

