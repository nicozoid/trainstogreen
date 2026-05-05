import { NextRequest, NextResponse } from "next/server"
import { readDataFile } from "@/lib/github-data"
import type { Place, PlaceRegistry } from "@/lib/places"

// Single unified walks file (each entry carries a top-level `source`
// field identifying its origin).
const WALKS_FILE = "data/walks.json"
// Phase 1 places-registry data file. Walk rows for sights/lunch/
// destination are now { placeId, kmIntoRoute } stubs; we hydrate
// them here so the editor receives the same flat venue shape it
// always saw. Hydrated rows also carry placeId so the editor can
// round-trip it back on save.
const PLACES_FILE = "data/places.json"

// Build a CRS → station name lookup from public/stations.json so the
// admin UI can render derived walk titles ("Milford to Haslemere")
// without needing to ship the full station list client-side. Read
// once per request; the file is ~300 KB and cached by Node.
async function loadCrsNameIndex(): Promise<Map<string, string>> {
  const { data } = await readDataFile<{ features: Array<{ properties?: Record<string, unknown>; geometry?: unknown }> }>(
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

// Fields we send back per walk variant. The admin UI only needs the
// identifying info + the editable fields + read-only context (sights,
// terrain, etc.) for display. Page-level fields (title, url, favourite)
// travel alongside so each card can link to its source page.
type WalkPayload = {
  // page-level (legacy, for backward compat; source.* is authoritative going forward)
  slug: string
  pageTitle: string
  pageUrl: string
  favourite: boolean
  // variant-level
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
  // Each row carries its `placeId` round-trip so the editor can
  // POST it back unchanged on save (the server uses it to find the
  // right registry entry to update).
  sights: { placeId: string; name: string; location?: string; url?: string | null; description?: string; lat?: number | null; lng?: number | null; kmIntoRoute?: number | null; businessStatus?: string | null; types?: string[] | null }[]
  lunchStops: { placeId: string; name: string; location?: string; url?: string | null; notes?: string; rating?: string; busy?: "busy" | "quiet"; lat?: number | null; lng?: number | null; kmIntoRoute?: number | null; businessStatus?: string | null; types?: string[] | null }[]
  // Free-text override for the lunch line in the public prose. When
  // populated, the build script emits this verbatim instead of
  // formatting the lunchStops list. Lets the admin write a single
  // sentence like "BYO — there are no good lunch stops on this walk"
  // without inventing a venue row to fit the formatter.
  lunchOverride: string
  // Destination pub(s) — the place(s) at the end of the walk. Same
  // shape as lunchStops minus `location` (the location is always
  // implicit — the walk destination). The editor hides the location
  // input for this section; the field is preserved on the data shape
  // for type compatibility with the shared editor and stays empty.
  destinationStops: { placeId: string; name: string; location?: string; url?: string | null; notes?: string; rating?: string; busy?: "busy" | "quiet"; lat?: number | null; lng?: number | null; kmIntoRoute?: number | null; businessStatus?: string | null; types?: string[] | null }[]
  destinationStopsOverride: string
  // editable
  miscellany: string
  trainTips: string
  // Admin-only scratchpad on the walk. Never exposed to the public
  // (build script ignores it entirely). Useful for curation TODOs
  // like "check distance, SWC says 14.5 but Komoot says 13.8".
  privateNote: string
  mudWarning: boolean
  bestSeasons: string[]
  /** Free-text rationale appended after the public "Best …" sentence. */
  bestSeasonsNote: string
  komootUrl: string
  // Entry-level GPX URL (shared across all variants on the same page).
  // Undefined when the source doesn't publish one.
  gpx?: string
  // True when the walk needs a bus / taxi / heritage rail to return,
  // OR when one endpoint is a non-mainline station (e.g. a village).
  // Drives the admin `bus` chip and pushes the walk to the bottom of
  // the CMS list. Public prose NEVER renders these walks (build-
  // script already filters on `stationToStation === true`), so this
  // field is an admin-only visibility signal.
  requiresBus: boolean
  rating: number | null
  // Optional admin-authored sentence appended to the rating flourish
  // in the public prose (e.g. "Highly recommended by T2G! Best
  // springtime walk."). Stored without a trailing period — the
  // renderer adds it.
  ratingExplanation: string
  updatedAt: string | null
  // Provenance — list of organisations that have documented this walk.
  // Each row carries its own type (main / shorter / longer / alternative
  // / variant) and optional walk-specific page link. The public render
  // picks ONE row to attribute to via tie-break order; the rest are
  // kept for admin cross-reference. walkNumber is currently only
  // meaningful for the two Time Out Country Walks orgs.
  orgs?: Array<{
    orgSlug: string
    type: string
    pageURL?: string
    pageTitle?: string
    walkNumber?: string
  }>
  // admin-only metadata (not editable in v1 but preserved on write)
  previousWalkDates?: string[]
  // Page-level tags (e.g. "TO1:24" for Time Out Book 1, Walk 24).
  // Read-only in the editor — derived from source URL matching.
  pageTags: string[]
  // Read-only "hidden metadata" surfaced for the editor's Metadata
  // section. Mostly entry-level fields populated by the source
  // scraper/extractor (tagline, regions, places…) and admin/build
  // flags (extracted, onMap, issues, resolved, …). Field-presence is
  // intentional: only populated values are emitted, so the UI can
  // render the section only when there's something to show.
  meta?: WalkMeta
}

type WalkMeta = {
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
  // Admin/build flags
  extracted?: boolean
  onMap?: boolean
  issues?: boolean
  outsideMainlandBritain?: boolean
  resolved?: boolean
  resolution?: string
  sourceIndex?: number
}

// Walk ordering — automatic, not admin-overridable.
// Sort keys (ASC — lower value wins):
//   1. requiresBus       (bus-requiring walks always drop to the BOTTOM;
//                         they're never published to the public anyway
//                         so the CMS list keeps the publishable walks
//                         on top)
//   2. !komootUrl        (walks with a Komoot route come first)
//   3. sectionPriority   (circular → S2S-starting-here → S2S-ending-here;
//                         groups walks of the same section together
//                         in the admin list. The public view doesn't
//                         use this key directly — it's already split
//                         into three sectioned blocks server-side —
//                         but the admin's mixed list benefits.)
//   4. !isMain           (main walks first; non-mains are not
//                         further sorted among themselves by subtype —
//                         the SOURCE_TYPES dropdown order no longer
//                         affects position)
//   5. ratingTier        (4, 3, 2, 1, unrated — any rating beats unrated)
//   6. distanceScore     (|distanceKm - IDEAL_LENGTH_KM| — closest to
//                         ideal first; missing distance sorts last)
//   7. pageTitle         (deterministic tiebreaker)
// Keep IDEAL_LENGTH_KM in sync with scripts/build-rambler-notes.mjs.
const IDEAL_LENGTH_KM = 13
// Mirrors the paragraph order used by scripts/build-rambler-notes.mjs
// so the admin cards appear in the same order as the rendered prose.
const RATING_TIERS: Record<string, number> = {
  "4": 0,
  "3": 1,
  "2": 2,
  "1": 3,
  unrated: 4,
}
// Pull all the entry-level "hidden metadata" off a walks-file entry
// into the read-only meta blob. Only emits fields that have a
// non-empty value so the editor can render the Metadata section
// conditionally (and skip rendering empty rows inside it).
function buildMeta(entry: any): WalkMeta | undefined {
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

  if (entry.places && typeof entry.places === "object") {
    const p: NonNullable<WalkMeta["places"]> = {}
    for (const k of ["villages", "landmarks", "historic", "modern", "nature", "paths"] as const) {
      const list = arrIfSet(entry.places[k])
      if (list?.length) p[k] = list
    }
    if (Object.keys(p).length > 0) meta.places = p
  }

  // Build flags — only emit when explicitly true (or, for the optional
  // flags, when present). Defaults look the same as "field absent" in
  // the JSON, so omitting them keeps the UI clean.
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

function ratingTier(rating: number | null | undefined): number {
  if (rating == null) return RATING_TIERS.unrated
  const key = String(Math.round(rating))
  return RATING_TIERS[key] ?? RATING_TIERS.unrated
}

export async function GET(req: NextRequest) {
  const crs = req.nextUrl.searchParams.get("crs")
  if (!crs) return NextResponse.json({ error: "missing crs" }, { status: 400 })

  const crsName = await loadCrsNameIndex()

  const out: WalkPayload[] = []
  const { data } = await readDataFile<Record<string, any>>(WALKS_FILE)
  const { data: placesData } = await readDataFile<PlaceRegistry>(PLACES_FILE)
  // Hydrate a stub array (sights / lunchStops / destinationStops)
  // into full venue rows. Stubs whose placeId can't be resolved are
  // dropped — the migration is exhaustive so this only fires if the
  // registry got out of sync (e.g. a walk references a place that's
  // since been deleted). Carrying placeId on the hydrated row lets
  // the editor send it back unchanged on save.
  const hydrate = (
    list: unknown,
  ): Array<Place & { placeId: string; kmIntoRoute: number | null }> => {
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
  for (const entry of Object.values(data)) {
    if (!Array.isArray(entry.walks)) continue
    for (const v of entry.walks) {
      // Each walk attaches to BOTH its endpoints — admin gets every
      // walk that touches this station, whether it starts or ends
      // here, mixed in a single list. Circular walks (start === end)
      // still appear once because there's no duplicate filter loop;
      // the OR below matches the same walk variant only once per CRS.
      if (v.startStation !== crs && v.endStation !== crs) continue
      out.push({
        slug: entry.slug,
        pageTitle: entry.title,
        pageUrl: entry.url,
        favourite: !!entry.favourite,
        id: v.id,
        role: v.role,
        name: v.name ?? "",
        suffix: v.suffix ?? "",
        startStation: v.startStation ?? null,
        endStation: v.endStation ?? null,
        startStationName: v.startStation ? (crsName.get(v.startStation) ?? null) : null,
        endStationName: v.endStation ? (crsName.get(v.endStation) ?? null) : null,
        startPlace: v.startPlace ?? "",
        endPlace: v.endPlace ?? "",
        stationToStation: !!v.stationToStation,
        distanceKm: v.distanceKm ?? null,
        hours: v.hours ?? null,
        uphillMetres: typeof v.uphillMetres === "number" ? v.uphillMetres : null,
        difficulty: typeof v.difficulty === "string" && ["easy", "moderate", "hard"].includes(v.difficulty) ? v.difficulty : null,
        terrain: v.terrain ?? "",
        sights: hydrate(v.sights) as WalkPayload["sights"],
        lunchStops: hydrate(v.lunchStops) as WalkPayload["lunchStops"],
        lunchOverride: typeof v.lunchOverride === "string" ? v.lunchOverride : "",
        destinationStops: hydrate(v.destinationStops) as WalkPayload["destinationStops"],
        destinationStopsOverride: typeof v.destinationStopsOverride === "string" ? v.destinationStopsOverride : "",
        miscellany: v.miscellany ?? "",
        trainTips: v.trainTips ?? "",
        privateNote: v.privateNote ?? "",
        mudWarning: !!v.mudWarning,
        bestSeasons: Array.isArray(v.bestSeasons) ? v.bestSeasons : [],
        bestSeasonsNote: typeof v.bestSeasonsNote === "string" ? v.bestSeasonsNote : "",
        komootUrl: v.komootUrl ?? "",
        gpx: typeof entry.gpx === "string" && entry.gpx ? entry.gpx : undefined,
        requiresBus: !!v.requiresBus,
        rating: typeof v.rating === "number" ? v.rating : null,
        ratingExplanation: typeof v.ratingExplanation === "string" ? v.ratingExplanation : "",
        updatedAt: typeof v.updatedAt === "string" ? v.updatedAt : null,
        orgs: Array.isArray(v.orgs) ? v.orgs : undefined,
        previousWalkDates: Array.isArray(v.previousWalkDates) ? v.previousWalkDates : undefined,
        pageTags: Array.isArray(entry.tags) ? entry.tags : [],
        meta: buildMeta(entry),
      })
    }
  }

  // Dedupe by id — defensive against the unlikely case of a walk id
  // appearing on multiple entries (e.g. an extractor bug). Last
  // occurrence wins.
  const dedup = new Map<string, WalkPayload>()
  for (const w of out) dedup.set(w.id, w)
  const deduped = [...dedup.values()]

  // Proximity to the ideal walk length. Closer to IDEAL_LENGTH_KM
  // sorts first; missing distances fall to the bottom of their tier
  // via Infinity so gaps in the data don't win ties.
  const distanceScore = (km: number | null) =>
    typeof km === "number" && Number.isFinite(km)
      ? Math.abs(km - IDEAL_LENGTH_KM)
      : Number.POSITIVE_INFINITY

  // Section priority — relative to the queried CRS. Circular walks
  // (same start & end station) come first, then S2S walks where this
  // station is the start, then S2S walks where this station is the
  // end. For multi-CRS synthetic queries the sort still runs per
  // batch in the API; the client merges pre-sorted batches without
  // re-sorting (acceptable approximation — this is admin-only).
  const sectionPriority = (w: WalkPayload): number => {
    if (w.startStation && w.startStation === w.endStation) return 0
    if (w.startStation === crs) return 1
    return 2
  }

  deduped.sort((a, b) => {
    // 1. Bus-requiring walks always sink to the bottom. These can
    //    never be published to the public (the build script filters
    //    on stationToStation), so they're admin-curation-only — no
    //    reason for them to compete with publishable walks on the
    //    other keys.
    const ba = a.requiresBus ? 1 : 0
    const bb = b.requiresBus ? 1 : 0
    if (ba !== bb) return ba - bb
    // 2. Komoot walks first.
    const ka = a.komootUrl ? 0 : 1
    const kb = b.komootUrl ? 0 : 1
    if (ka !== kb) return ka - kb
    // 3. Section priority (circular → starting here → ending here).
    const sa = sectionPriority(a), sb = sectionPriority(b)
    if (sa !== sb) return sa - sb
    // 4. Main walks first. No further type-subtype ordering among
    //    non-mains. A walk counts as "main" if ANY org row has
    //    type==="main"; we fall back to the legacy `role` field for
    //    walks that somehow have no orgs[] (rare — empty-orgs walks
    //    are usually our own routes with no external attribution).
    const isMain = (w: WalkPayload) =>
      Array.isArray(w.orgs) && w.orgs.some((o) => o.type === "main")
        ? true
        : w.role === "main"
    const ma = isMain(a) ? 0 : 1
    const mb = isMain(b) ? 0 : 1
    if (ma !== mb) return ma - mb
    // 5. Rating tier (4 → 3 → 2 → 1 → unrated).
    const ta = ratingTier(a.rating), tb = ratingTier(b.rating)
    if (ta !== tb) return ta - tb
    // 6. Distance proximity to IDEAL_LENGTH_KM — closest first; missing last.
    const da = distanceScore(a.distanceKm)
    const db = distanceScore(b.distanceKm)
    if (da !== db) return da - db
    // 7. Alphabetic pageTitle for deterministic tiebreak.
    return a.pageTitle.localeCompare(b.pageTitle)
  })

  return NextResponse.json(deduped)
}
