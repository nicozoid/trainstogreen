// Shared builder for the WalkPayload shape used by:
//   - GET /api/dev/walks-for-station
//   - GET /api/dev/walks-list
//
// Centralised here so both endpoints stay in lockstep — adding a field
// to one (e.g. lastPullAt) reaches both without copy/paste drift.

import { readDataFile } from "@/lib/github-data"
import type { Place, PlaceRegistry } from "@/lib/places"

export type WalkPayload = {
  slug: string
  pageTitle: string
  pageUrl: string
  favourite: boolean
  id: string
  role: string
  name: string
  suffix: string
  startStation: string | null
  endStation: string | null
  startStationName: string | null
  endStationName: string | null
  startPlace: string
  endPlace: string
  stationToStation: boolean
  distanceKm: number | null
  hours: number | null
  uphillMetres: number | null
  difficulty: "easy" | "moderate" | "hard" | null
  terrain: string
  sights: Array<Place & { placeId: string; kmIntoRoute: number | null }>
  lunchStops: Array<Place & { placeId: string; kmIntoRoute: number | null }>
  lunchOverride: string
  destinationStops: Array<Place & { placeId: string; kmIntoRoute: number | null }>
  destinationStopsOverride: string
  miscellany: string
  trainTips: string
  privateNote: string
  mudWarning: boolean
  bestSeasons: string[]
  bestSeasonsNote: string
  komootUrl: string
  gpx?: string
  requiresBus: boolean
  rating: number | null
  ratingExplanation: string
  updatedAt: string | null
  lastPullAt: string | null
  orgs?: Array<{
    orgSlug: string
    type: string
    pageURL?: string
    pageTitle?: string
    walkNumber?: string
  }>
  previousWalkDates?: string[]
  pageTags: string[]
  meta?: WalkMeta
}

export type WalkMeta = {
  tagline?: string
  notes?: string
  regions?: string[]
  categories?: string[]
  features?: string[]
  places?: {
    villages?: string[]
    landmarks?: string[]
    historic?: string[]
    modern?: string[]
    nature?: string[]
    paths?: string[]
  }
  extracted?: boolean
  onMap?: boolean
  issues?: boolean
  outsideMainlandBritain?: boolean
  resolved?: boolean
  resolution?: string
  sourceIndex?: number
}

export const WALKS_FILE = "data/walks.json"
export const PLACES_FILE = "data/places.json"

// CRS → station name lookup, sourced from public/stations.json. Read
// once per request so derived titles ("Milford to Haslemere") can be
// rendered without shipping the full station list to the client.
export async function loadCrsNameIndex(): Promise<Map<string, string>> {
  const { data } = await readDataFile<{ features: Array<{ properties?: Record<string, unknown> }> }>(
    "public/stations.json",
  )
  const map = new Map<string, string>()
  for (const f of data.features) {
    const crs = f.properties?.["ref:crs"] as string | undefined
    const name = f.properties?.name as string | undefined
    if (crs && name) map.set(crs, name)
  }
  return map
}

// Hydrate a walks.json stub array (sights / lunch / destination —
// each row is `{ placeId, kmIntoRoute }`) into full venue rows by
// looking up the placeId in places.json. Stubs whose placeId can't be
// resolved are dropped (only happens when the registry got out of
// sync — the migration is exhaustive). Hydrated rows still carry
// placeId so the editor can round-trip it back unchanged on save.
export function hydratePlaces(
  list: unknown,
  placesData: PlaceRegistry,
): Array<Place & { placeId: string; kmIntoRoute: number | null }> {
  if (!Array.isArray(list)) return []
  const out: Array<Place & { placeId: string; kmIntoRoute: number | null }> = []
  for (const stub of list) {
    if (!stub || typeof stub !== "object") continue
    const placeId = (stub as { placeId?: unknown }).placeId
    if (typeof placeId !== "string") continue
    const place = placesData[placeId]
    if (!place) continue
    const km = (stub as { kmIntoRoute?: unknown }).kmIntoRoute
    out.push({
      ...place,
      placeId,
      kmIntoRoute: typeof km === "number" && Number.isFinite(km) ? km : null,
    })
  }
  return out
}

// Pull entry-level "hidden metadata" off a walks-file entry into the
// read-only meta blob surfaced to the editor. Only emits fields that
// have a non-empty value so the Metadata section can render
// conditionally.
export function buildMeta(entry: Record<string, unknown>): WalkMeta | undefined {
  const meta: WalkMeta = {}
  const strIfSet = (v: unknown) => (typeof v === "string" && v.trim() ? v : undefined)
  const arrIfSet = (v: unknown) =>
    Array.isArray(v) && v.length > 0 ? v.filter((x) => typeof x === "string" && x.trim()) : undefined

  const tagline = strIfSet(entry.tagline)
  if (tagline) meta.tagline = tagline
  const notes = strIfSet(entry.notes)
  if (notes) meta.notes = notes

  const regions = arrIfSet(entry.regions)
  if (regions?.length) meta.regions = regions
  const categories = arrIfSet(entry.categories)
  if (categories?.length) meta.categories = categories
  const features = arrIfSet(entry.features)
  if (features?.length) meta.features = features

  const placesField = entry.places
  if (placesField && typeof placesField === "object") {
    const p: NonNullable<WalkMeta["places"]> = {}
    const src = placesField as Record<string, unknown>
    for (const k of ["villages", "landmarks", "historic", "modern", "nature", "paths"] as const) {
      const list = arrIfSet(src[k])
      if (list?.length) p[k] = list
    }
    if (Object.keys(p).length > 0) meta.places = p
  }

  if (entry.extracted === true) meta.extracted = true
  if (entry.onMap === true) meta.onMap = true
  if (entry.issues === true) meta.issues = true
  if (entry.outsideMainlandBritain === true) meta.outsideMainlandBritain = true
  if (entry.resolved === true) meta.resolved = true
  const resolution = strIfSet(entry.resolution)
  if (resolution) meta.resolution = resolution
  if (typeof entry.sourceIndex === "number") meta.sourceIndex = entry.sourceIndex

  return Object.keys(meta).length > 0 ? meta : undefined
}

// Build one WalkPayload from a walks.json entry + variant. Returns a
// fully-populated row including hydrated places and resolved station
// names. Both the [crs] and walks-list endpoints call this in their
// inner loop.
export function buildWalkPayload(
  entry: Record<string, unknown>,
  v: Record<string, unknown>,
  crsName: Map<string, string>,
  placesData: PlaceRegistry,
): WalkPayload {
  const startStation = (v.startStation as string | undefined) ?? null
  const endStation = (v.endStation as string | undefined) ?? null
  const difficulty = typeof v.difficulty === "string" && ["easy", "moderate", "hard"].includes(v.difficulty)
    ? (v.difficulty as "easy" | "moderate" | "hard")
    : null
  return {
    slug: entry.slug as string,
    pageTitle: entry.title as string,
    pageUrl: entry.url as string,
    favourite: !!entry.favourite,
    id: v.id as string,
    role: (v.role as string) ?? "",
    name: (v.name as string) ?? "",
    suffix: (v.suffix as string) ?? "",
    startStation,
    endStation,
    startStationName: startStation ? (crsName.get(startStation) ?? null) : null,
    endStationName: endStation ? (crsName.get(endStation) ?? null) : null,
    startPlace: (v.startPlace as string) ?? "",
    endPlace: (v.endPlace as string) ?? "",
    stationToStation: !!v.stationToStation,
    distanceKm: (v.distanceKm as number | undefined) ?? null,
    hours: (v.hours as number | undefined) ?? null,
    uphillMetres: typeof v.uphillMetres === "number" ? v.uphillMetres : null,
    difficulty,
    terrain: (v.terrain as string) ?? "",
    sights: hydratePlaces(v.sights, placesData),
    lunchStops: hydratePlaces(v.lunchStops, placesData),
    lunchOverride: typeof v.lunchOverride === "string" ? v.lunchOverride : "",
    destinationStops: hydratePlaces(v.destinationStops, placesData),
    destinationStopsOverride: typeof v.destinationStopsOverride === "string" ? v.destinationStopsOverride : "",
    miscellany: (v.miscellany as string) ?? "",
    trainTips: (v.trainTips as string) ?? "",
    privateNote: (v.privateNote as string) ?? "",
    mudWarning: !!v.mudWarning,
    bestSeasons: Array.isArray(v.bestSeasons) ? (v.bestSeasons as string[]) : [],
    bestSeasonsNote: typeof v.bestSeasonsNote === "string" ? v.bestSeasonsNote : "",
    komootUrl: (v.komootUrl as string) ?? "",
    gpx: typeof entry.gpx === "string" && entry.gpx ? (entry.gpx as string) : undefined,
    requiresBus: !!v.requiresBus,
    rating: typeof v.rating === "number" ? v.rating : null,
    ratingExplanation: typeof v.ratingExplanation === "string" ? v.ratingExplanation : "",
    updatedAt: typeof v.updatedAt === "string" ? v.updatedAt : null,
    lastPullAt: typeof v.lastPullAt === "string" ? v.lastPullAt : null,
    orgs: Array.isArray(v.orgs) ? (v.orgs as WalkPayload["orgs"]) : undefined,
    previousWalkDates: Array.isArray(v.previousWalkDates) ? (v.previousWalkDates as string[]) : undefined,
    pageTags: Array.isArray(entry.tags) ? (entry.tags as string[]) : [],
    meta: buildMeta(entry),
  }
}

// Read every walk variant from data/walks.json + data/places.json and
// return them as flat WalkPayload[]. No filtering, no sort — callers
// pick their own. Used by the walks-manager table page and the
// single-walk endpoint (find-by-id).
//
// Defensive: dedupe by walk id. The walks file shouldn't contain the
// same id on multiple entries, but extractor bugs occasionally leak
// dupes through; if we let them flow into a React list with
// `key={walk.id}` the renderer warns and behavior is undefined.
// Last occurrence wins, matching the per-station endpoint's pattern.
export async function loadAllWalks(): Promise<WalkPayload[]> {
  const crsName = await loadCrsNameIndex()
  const { data } = await readDataFile<Record<string, Record<string, unknown>>>(WALKS_FILE)
  const { data: placesData } = await readDataFile<PlaceRegistry>(PLACES_FILE)
  const byId = new Map<string, WalkPayload>()
  for (const entry of Object.values(data)) {
    const variants = entry.walks
    if (!Array.isArray(variants)) continue
    for (const v of variants) {
      if (!v || typeof v !== "object") continue
      const payload = buildWalkPayload(entry, v as Record<string, unknown>, crsName, placesData)
      byId.set(payload.id, payload)
    }
  }
  return [...byId.values()]
}
