import { NextRequest, NextResponse } from "next/server"
import { readDataFile } from "@/lib/github-data"

// Every file that contributes walk entries. Mirrors EXTRA_WALKS_PATHS
// in scripts/build-rambler-notes.mjs — keep in sync when adding
// new sources.
const WALKS_FILES = [
  "data/rambler-walks.json",
  "data/leicester-ramblers-walks.json",
  "data/heart-rail-trails-walks.json",
  "data/abbey-line-walks.json",
  "data/manual-walks.json",
]

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
  sights: { name: string; url?: string | null; description?: string }[]
  lunchStops: { name: string; location?: string; url?: string | null; notes?: string; rating?: string; busy?: "busy" | "quiet" }[]
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
  destinationPubs: { name: string; location?: string; url?: string | null; notes?: string; rating?: string; busy?: "busy" | "quiet" }[]
  destinationPubsOverride: string
  // editable
  miscellany: string
  trainTips: string
  // Admin-only scratchpad on the walk. Never exposed to the public
  // (build script ignores it entirely). Useful for curation TODOs
  // like "check distance, SWC says 14.5 but Komoot says 13.8".
  privateNote: string
  mudWarning: boolean
  bestSeasons: string[]
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
  // provenance (read-only in v1 — populated by
  // scripts/backfill-walk-source-metadata.mjs)
  source?: {
    orgSlug: string
    pageName: string
    pageURL: string
    type: string
  }
  // Admin-only cross-reference to a related walk page. Same shape
  // as `source` but optional — when unset the whole field is
  // absent from the JSON. Not rendered in public prose.
  relatedSource?: {
    orgSlug: string
    pageName: string
    pageURL: string
    type: string
  }
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
  for (const file of WALKS_FILES) {
    let data: Record<string, any>
    try {
      const { data: d } = await readDataFile<Record<string, any>>(file)
      data = d
    } catch {
      // Missing file is fine (some sources are optional)
      continue
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
          sights: v.sights ?? [],
          lunchStops: v.lunchStops ?? [],
          lunchOverride: typeof v.lunchOverride === "string" ? v.lunchOverride : "",
          destinationPubs: Array.isArray(v.destinationPubs) ? v.destinationPubs : [],
          destinationPubsOverride: typeof v.destinationPubsOverride === "string" ? v.destinationPubsOverride : "",
          miscellany: v.miscellany ?? "",
          trainTips: v.trainTips ?? "",
          privateNote: v.privateNote ?? "",
          mudWarning: !!v.mudWarning,
          bestSeasons: Array.isArray(v.bestSeasons) ? v.bestSeasons : [],
          komootUrl: v.komootUrl ?? "",
          gpx: typeof entry.gpx === "string" && entry.gpx ? entry.gpx : undefined,
          requiresBus: !!v.requiresBus,
          rating: typeof v.rating === "number" ? v.rating : null,
          ratingExplanation: typeof v.ratingExplanation === "string" ? v.ratingExplanation : "",
          updatedAt: typeof v.updatedAt === "string" ? v.updatedAt : null,
          source: v.source && typeof v.source === "object" ? v.source : undefined,
          relatedSource: v.relatedSource && typeof v.relatedSource === "object" ? v.relatedSource : undefined,
          previousWalkDates: Array.isArray(v.previousWalkDates) ? v.previousWalkDates : undefined,
          pageTags: Array.isArray(entry.tags) ? entry.tags : [],
          meta: buildMeta(entry),
        })
      }
    }
  }

  // Dedupe by id — the same walk variant can appear in multiple data
  // files (110 such duplicates exist between rambler-walks.json and the
  // per-source files). The build script's "later file overrides on slug
  // collision" rule means the LAST occurrence is authoritative; mirror
  // that here so the editor displays the same copy that gets rendered
  // into public prose. Without this dedupe the editor would show two
  // identical cards and saves would appear to "lose" data when the
  // refetch surfaces the un-edited duplicate.
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
    //    non-mains. source.type is the modern home; fall back to
    //    legacy `role` for older walks.
    const ma = (a.source?.type ?? a.role) === "main" ? 0 : 1
    const mb = (b.source?.type ?? b.role) === "main" ? 0 : 1
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
