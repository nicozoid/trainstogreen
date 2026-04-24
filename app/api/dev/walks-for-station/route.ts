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
  distanceMiles: number | null
  hours: number | null
  terrain: string
  sights: { name: string; url?: string | null; description?: string }[]
  lunchStops: { name: string; location?: string; url?: string | null; notes?: string; rating?: string }[]
  // editable
  warnings: string
  bestTime: string
  mudWarning: boolean
  bestSeasons: string[]
  komootUrl: string
  rating: number | null
  // provenance (read-only in v1 — populated by
  // scripts/backfill-walk-source-metadata.mjs)
  source?: {
    orgSlug: string
    pageName: string
    pageURL: string
    type: string
  }
  // admin-only metadata (not editable in v1 but preserved on write)
  previousWalkDates?: string[]
}

// Returns every walk variant whose startStation OR endStation matches
// the given CRS, across all four walk files. Results are ordered:
//   Rambler-favourite pages first, then by role priority
//   (main → shorter → longer → alternative → variant).
// This matches the order the build script uses to stack walks into
// each station's ramblerNote so the admin cards appear in the same
// order as the rendered prose.
const ROLE_PRIORITY = ["main", "shorter", "longer", "alternative", "variant"]

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
          distanceMiles: v.distanceMiles ?? null,
          hours: v.hours ?? null,
          terrain: v.terrain ?? "",
          sights: v.sights ?? [],
          lunchStops: v.lunchStops ?? [],
          warnings: v.warnings ?? "",
          bestTime: v.bestTime ?? "",
          mudWarning: !!v.mudWarning,
          bestSeasons: Array.isArray(v.bestSeasons) ? v.bestSeasons : [],
          komootUrl: v.komootUrl ?? "",
          rating: typeof v.rating === "number" ? v.rating : null,
          source: v.source && typeof v.source === "object" ? v.source : undefined,
          previousWalkDates: Array.isArray(v.previousWalkDates) ? v.previousWalkDates : undefined,
        })
      }
    }
  }

  // Sort: favourites first, then role priority, then by pageTitle for stable ties
  out.sort((a, b) => {
    if (a.favourite !== b.favourite) return a.favourite ? -1 : 1
    const ra = ROLE_PRIORITY.indexOf(a.role)
    const rb = ROLE_PRIORITY.indexOf(b.role)
    if (ra !== rb) return ra - rb
    return a.pageTitle.localeCompare(b.pageTitle)
  })

  return NextResponse.json(out)
}
