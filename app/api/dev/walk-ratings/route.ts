import { NextResponse } from "next/server"
import { readDataFile } from "@/lib/github-data"
import { ALL_CLUSTERS } from "@/lib/clusters"

// Single unified walks file (each entry carries a top-level `source`
// field identifying its origin).
const WALKS_FILE = "data/walks.json"

type WalkVariant = {
  id?: string
  startStation?: string | null
  endStation?: string | null
  rating?: number | null
  komootUrl?: string | null
  stationToStation?: boolean
  source?: { type?: string }
  role?: string
}
type WalkEntry = { walks?: WalkVariant[]; gpx?: string }

// Lightweight record of one walk-station attachment, carrying just the
// fields the rating + tier filter need. Each S2S walk produces TWO
// attachments (one for each endpoint) so the rating reflects walks
// that end at the station too. The `role` distinguishes which
// endpoint this attachment represents — used by deriveRating to
// enforce the "rating-4 only if a rated-4 walk STARTS here" rule.
type Attachment = {
  walkId: string  // for synthetic-level dedup when a walk has both endpoints inside the same cluster
  role: "starting" | "ending"
  rating: number | null
  hasKomoot: boolean
  hasGpx: boolean
  isMain: boolean
}

// Returns a map of coordKey → derived station rating (1..4). Stations
// without an entry in the response are unrated.
//
// Only PUBLICLY-VISIBLE walks count. Public visibility is determined
// the same way scripts/build-rambler-notes.mjs decides what prose to
// publish:
//   1. Walks with stationToStation === false are skipped outright —
//      bus walks and walks with non-mainline endpoints never reach
//      the public view, so they don't influence the rating either.
//   2. The remaining walks at a station go through a station-wide
//      tier cascade (matching publicTierFilter in build-rambler-notes):
//        Tier 1: any Komoot or GPX walk → only those count
//        Tier 2: else any main walk → only mains count
//        Tier 3: else all (already filtered to S2S above)
//   3. The rating is computed from the survivors.
//
// Derivation rules on the surviving set:
//   - No survivors → unrated (absent from response).
//   - max >= 3 → max wins outright (upward deviation beats everything).
//   - else if any rated-1 walk → 1 (downward deviation).
//   - else → 2 (default for "we know there's something here").
//
// Concrete table (against the surviving set):
//   walks       │ rating
//   ───────────────────
//   [2, 4]      │ 4   (upward deviation wins)
//   [1, 4]      │ 4   (upward beats downward)
//   [2, 3]      │ 3
//   [1, 2]      │ 1
//   [1]         │ 1
//   [2, 2, 2]   │ 2
//   [unrated]   │ 2
//   (none)      │ unrated
//
// Synthetic clusters (Central London, Lymington, …) aggregate every
// member's S2S walks, dedup by walk id, then run the same tier filter
// + derivation against the union — exactly like the build script.
export async function GET() {
  // Load the station list to resolve CRS → coordKey.
  const { data: stations } = await readDataFile<{
    features: Array<{
      geometry?: { coordinates?: [number, number] }
      properties?: { "ref:crs"?: string; coordKey?: string }
    }>
  }>("public/stations.json")

  const crsToCoord = new Map<string, string>()
  for (const f of stations.features) {
    const crs = f.properties?.["ref:crs"]
    if (!crs) continue
    const ck = f.properties?.coordKey
      ?? (f.geometry?.coordinates ? `${f.geometry.coordinates[0]},${f.geometry.coordinates[1]}` : null)
    if (ck) crsToCoord.set(crs, ck)
  }

  // Per CRS: every S2S walk attachment touching this station, kept
  // raw (not yet tier-filtered) so the synthetic aggregation step
  // can re-tier on the cluster's union.
  const byCrs = new Map<string, Attachment[]>()

  const { data: entries } = await readDataFile<Record<string, WalkEntry>>(WALKS_FILE)
  for (const entry of Object.values(entries)) {
    if (!Array.isArray(entry.walks)) continue
    const entryHasGpx = typeof entry.gpx === "string" && entry.gpx.trim() !== ""
    for (const v of entry.walks) {
      // Skip non-public walks entirely. Mirrors the build script's
      // `entry.walks.filter((v) => v.stationToStation)` gate.
      if (!v.stationToStation) continue

      const isMain = (v.source?.type ?? v.role ?? "main") === "main"
      const baseAttachment = {
        walkId: v.id ?? "",
        rating: typeof v.rating === "number" ? v.rating : null,
        hasKomoot: typeof v.komootUrl === "string" && v.komootUrl.trim() !== "",
        hasGpx: entryHasGpx,
        isMain,
      }

      // Attach to BOTH endpoints with distinct roles so the rating
      // derivation can enforce the "rating-4 only via a starting
      // walk" rule. Circular walks (start === end) get a single
      // "starting" attachment via the seenStations dedup.
      const seenStations = new Set<string>()
      for (const { crs, role } of [
        { crs: v.startStation, role: "starting" as const },
        { crs: v.endStation, role: "ending" as const },
      ]) {
        if (!crs) continue
        if (seenStations.has(crs)) continue
        seenStations.add(crs)
        const arr = byCrs.get(crs) ?? []
        arr.push({ ...baseAttachment, role })
        byCrs.set(crs, arr)
      }
    }
  }

  // Tier filter — station-wide cascade. Returns the visible subset.
  function publicTierFilter(items: Attachment[]): Attachment[] {
    if (items.some((a) => a.hasKomoot || a.hasGpx)) {
      return items.filter((a) => a.hasKomoot || a.hasGpx)
    }
    if (items.some((a) => a.isMain)) {
      return items.filter((a) => a.isMain)
    }
    return items
  }

  // Apply the derivation rules to a tier-filtered set. Returns null
  // when the set is empty (station ends up unrated).
  //
  // Priority cascade — first matching rule wins:
  //   1. any rating-4 walk that STARTS here          → 4
  //   2. else any rating-3 or rating-4 walk          → 3
  //   3. else any rating-2 walk                      → 2
  //   4. else any rating-1 walk                      → 1
  //   5. else at least one walk (all unrated)        → 2  (default)
  //   6. else                                        → null (unrated)
  //
  // Note: rule 3 fires BEFORE rule 4, so [2, 1] → 2. A rating-1 walk
  // only pulls the rating down when there's nothing else around. The
  // role distinction matters only for rule 1 (rating-4 lift); for
  // ratings 1, 2, 3 starting walks and ending walks count equally.
  function deriveRating(visible: Attachment[]): 1 | 2 | 3 | 4 | null {
    if (visible.length === 0) return null
    let hasStartingR4 = false
    let hasR3OrR4 = false
    let hasR2 = false
    let hasR1 = false
    for (const a of visible) {
      if (typeof a.rating !== "number") continue
      const r = Math.round(a.rating)
      if (r === 4) {
        hasR3OrR4 = true
        if (a.role === "starting") hasStartingR4 = true
      } else if (r === 3) {
        hasR3OrR4 = true
      } else if (r === 2) {
        hasR2 = true
      } else if (r === 1) {
        hasR1 = true
      }
    }
    if (hasStartingR4) return 4
    if (hasR3OrR4) return 3
    if (hasR2) return 2
    if (hasR1) return 1
    return 2
  }

  const out: Record<string, 1 | 2 | 3 | 4> = {}

  for (const [crs, attachments] of byCrs) {
    const ck = crsToCoord.get(crs)
    if (!ck) continue
    const visible = publicTierFilter(attachments)
    const rating = deriveRating(visible)
    if (rating != null) out[ck] = rating
  }

  // ── Synthetic ratings ──────────────────────────────────────────────
  // Aggregate raw attachments from every member, dedup by walkId so
  // an intra-cluster walk (both endpoints in the same cluster) only
  // counts once, then re-tier and re-derive on the union. The tier
  // chosen for the cluster can differ from any individual member's
  // tier — e.g. one member with only mains + another member with one
  // Komoot walk → the cluster is tier 1 (Komoot only).
  //
  // ALL_CLUSTERS is ID-keyed (Phase 3c): each member is a station ID.
  // 3-char IDs ARE the CRS code; 4-char synthetic IDs (Underground/DLR/
  // etc.) have no walks and are skipped via the byCrs lookup miss.
  // The output map stays coord-keyed so the client can index directly
  // by feature.coordKey.

  for (const def of Object.values(ALL_CLUSTERS)) {
    // Dedup by walkId across members. When a walk has both endpoints
    // inside the cluster (e.g. a Charing Cross → Waterloo walk on the
    // Central London cluster), it appears twice — once via the start
    // member's bucket as "starting", once via the end member's bucket
    // as "ending". Prefer the "starting" attachment so the rating-4
    // rule sees it correctly: a walk starting in the cluster lets
    // the cluster reach 4; a walk only ending in the cluster doesn't.
    const seenWalks = new Map<string, Attachment>()
    const unkeyed: Attachment[] = []
    for (const memberId of def.members) {
      const memberAttachments = byCrs.get(memberId)
      if (!memberAttachments) continue
      for (const a of memberAttachments) {
        if (!a.walkId) { unkeyed.push(a); continue }
        const existing = seenWalks.get(a.walkId)
        if (!existing || (existing.role === "ending" && a.role === "starting")) {
          seenWalks.set(a.walkId, a)
        }
      }
    }
    const aggregated = [...seenWalks.values(), ...unkeyed]
    const visible = publicTierFilter(aggregated)
    const rating = deriveRating(visible)
    if (rating != null) out[def.coord] = rating
  }

  return NextResponse.json(out)
}
