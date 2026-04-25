"use client"

// Admin-only panel that shows the current state of data/origin-routes.json —
// per-primary destination count, total journey observations, and the
// Saturdays that have contributed V2 data. Auto-polls /api/dev/rtt-status
// every 4 seconds while open so the admin can watch an in-flight
// v2-complete.sh fetch update the dataset in real time.
//
// The panel only mounts when admin mode is active (callers gate on
// devExcludeActive). The summary endpoint also lives under /api/dev/
// in line with the other admin-only routes.

import { Fragment, useCallback, useEffect, useRef, useState } from "react"
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog"

type StationSummary = {
  coord: string
  name: string
  crs: string
  destinations: number
  journeys: number
  /** V2-schema-fetched dates ONLY. If a primary was only ever touched
   *  by pre-V2 fetches, this is empty. The table intentionally ignores
   *  V1 metadata — the whole point is "what V2 coverage do we have?". */
  dates: string[]
  generatedAt: string | null
}

type StatusPayload = {
  stations: StationSummary[]
  // CRS codes currently being fetched by a live fetch-direct-reachable.mjs
  // process. Used to show the ⏳ hourglass on that row.
  inProgressCrs: string[]
  // True when an orchestrator wrapper (v2-complete.sh / v2-rerun.sh /
  // etc.) is alive. Tracked primaries that don't yet have 2 sampled
  // Saturdays get a queued ⏳ too when this is on.
  wrapperRunning: boolean
  // Queued but not yet fetched primaries (scanned from orchestrator
  // scripts under /tmp/ttg-rtt). Each carries the CRS plus the real
  // station name resolved from public/stations.json so the panel shows
  // e.g. "Brighton" alongside BTN. Rendered as synthetic empty rows.
  queuedCrs?: Array<{ crs: string; name: string; coord?: string }>
  // Full CRS→name map covering every scraped CRS (queued AND in-
  // progress). Queued entries are also in queuedCrs above, but
  // in-progress ones aren't — this map lets the panel resolve names
  // for any synthetic-row CRS regardless of current fetch state.
  scrapedNames?: Record<string, string>
  // Parallel coord map (lng,lat strings) keyed the same way. Used for
  // the category filter, which buckets rows by geographic location.
  scrapedCoords?: Record<string, string>

  fileUpdatedAt: string
}

const POLL_MS = 4000

// Rough per-primary runtime budget for ETA estimation. Each fetch hits
// the RTT API at 4500ms throttle and covers ~100–200 services in the
// 09:00–12:00 window, plus a 3-min gap between primaries. Averaging
// fetch (12 min) + gap (3 min) gives 15 min — close enough for a
// queue-level ETA. We don't attempt per-primary sizing (would require
// knowing service counts upfront).
const AVG_PRIMARY_MS = 15 * 60 * 1000

// Format an ISO date string (YYYY-MM-DD) as "25 Apr". Falls back to the
// raw string when parsing fails so malformed values surface visibly in
// the admin panel rather than silently disappearing.
function formatShortDate(iso: string): string {
  const d = new Date(`${iso}T00:00:00`)
  if (Number.isNaN(d.getTime())) return iso
  return d.toLocaleDateString("en-GB", { day: "numeric", month: "short" })
}

// Format an ETA Date as either "14:05" (same day) or "26 Apr 03:40"
// (different day). Local timezone.
function formatEta(d: Date): string {
  const now = new Date()
  const sameDay =
    d.getFullYear() === now.getFullYear()
    && d.getMonth() === now.getMonth()
    && d.getDate() === now.getDate()
  if (sameDay) {
    return d.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit", hour12: false })
  }
  return d.toLocaleString("en-GB", {
    day: "numeric", month: "short",
    hour: "2-digit", minute: "2-digit", hour12: false,
  })
}

// Station categorisation. Every CRS that appears in the panel falls into
// exactly one of four buckets:
//
//   - public-primary  — non-admin user picks as their own home.
//                       The 15 London termini + SRA + SFA = 17 stations.
//   - friend          — non-admin user picks as a friend's home.
//                       Currently BHM (Birmingham) + NOT (Nottingham).
//   - admin-primary   — admin-only home pick. Empty for now; populate
//                       as admin-only primaries are introduced.
//   - junction        — pure RTT-composition routing data, never
//                       user-pickable. Includes everything else in
//                       data/origin-routes.json (CRE, RDG, GTW, BHM-the-
//                       junction-side, …). Inferred — anything not in
//                       the three sets above is a junction.
//
// Why these matter: the Queue tab uses the first three sets to
// auto-synthesise "needs fetching" rows for any of the 17 + 2 + 0 = 19
// curated stations not yet at full V2 data. Junctions are not auto-
// queued — they're fetched on-demand, typically because a public-
// primary's RTT composition needs them.
const PUBLIC_PRIMARY_CRS = new Set([
  // 15 London termini
  "CHX", "LST", "MOG", "BFR", "CST", "FST", "LBG", "MYB",
  "PAD", "VIC", "WAT", "WAE", "KGX", "STP", "EUS",
  // Stratford + Stratford International — clustered with the termini
  // group in the home-station picker (see PRIMARY_ORIGIN_CLUSTER in
  // map.tsx).
  "SRA", "SFA",
])
const FRIEND_CRS = new Set(["BHM", "NOT"])
const ADMIN_PRIMARY_CRS = new Set<string>([])

type StationCategory = "public-primary" | "friend" | "admin-primary" | "junction"
function categoryOf(crs: string): StationCategory {
  if (PUBLIC_PRIMARY_CRS.has(crs)) return "public-primary"
  if (FRIEND_CRS.has(crs)) return "friend"
  if (ADMIN_PRIMARY_CRS.has(crs)) return "admin-primary"
  return "junction"
}
const CATEGORY_LABELS: Record<StationCategory, string> = {
  "public-primary": "Public primaries",
  "friend": "Friends",
  "admin-primary": "Admin primaries",
  "junction": "Junctions",
}
// Render order in the Fetched tab (Public primaries first, then Friends,
// Admin primaries, then everything else as junctions). Matches the
// importance ordering: things users see > things admins use > backend
// routing data.
const CATEGORY_ORDER: StationCategory[] = ["public-primary", "friend", "admin-primary", "junction"]

// Stations we want to track in the Queue tab. Empty queue starts with
// just the curated public-primary + friend + admin-primary lists so the
// panel auto-shows missing data for any of those that aren't yet at
// full V2 coverage. Append CRS codes here only if a JUNCTION needs to
// be explicitly queued (for example to unlock a destination missing
// travel data).
const TRACKED_SEED: string[] = []

// Pretty names for missing-target synthesised rows — used when a
// curated CRS (public primary / friend / admin primary) isn't yet
// present in origin-routes.json so we can't read its real name from
// there. Once fetched, the JSON's name wins. Keyed by CRS; only needs
// entries for stations whose name the API can't resolve from
// public/stations.json.
const STATION_DISPLAY_NAMES: Record<string, string> = {
  CHX: "Charing Cross", LST: "Liverpool Street", MOG: "Moorgate",
  BFR: "Blackfriars",   CST: "Cannon Street",    FST: "Fenchurch Street",
  LBG: "London Bridge", MYB: "Marylebone",       PAD: "Paddington",
  VIC: "Victoria",      WAT: "Waterloo",         WAE: "Waterloo East",
  KGX: "London King's Cross", STP: "London St. Pancras International",
  EUS: "Euston",
  SRA: "Stratford",     SFA: "Stratford International",
  BHM: "Birmingham New Street", NOT: "Nottingham",
}

// Canonical queue order used by /tmp/ttg-rtt/v2-complete.sh. Anything
// still in-flight or not-yet-started sorts to the TOP of the table by
// its position here, so the admin reads the panel as a todo list.
// Keep in sync with v2-complete.sh when phases change.
// Cleared 2026-04-25; repopulated with the 84-junction "perfect public-
// primary coverage" queue. Goal: every NR destination reachable from a
// public primary via direct or 1-junction composition has travel data.
// Phases ordered by impact — Phase A unlocks the 56 currently-rated
// stations that lack travel data; later phases broaden coverage of
// branch lines and regional networks.
const QUEUE_ORDER: string[] = [
  // Phase A — Rated-station unlocks (10)
  "SOL", "SHF", "LDS", "NCL", "NBY", "MKT", "BBN", "EXD", "SPT", "WEA",
  // Phase B — Major regional hubs (15)
  "MAN", "YRK", "LIV", "PRE", "HFD", "HUL", "DON", "STA", "DAR", "MBR",
  "DHM", "WGN", "SAL", "WIN", "ELY",
  // Phase C — South-East branch junctions (16)
  "HRH", "REI", "DKG", "FAV", "BSR", "MAR", "BXB", "FEL", "HSL", "EBN",
  "HGS", "CBE", "CBW", "HAV", "PTR", "WYB",
  // Phase D — Friend-candidate cities + commuter hubs (14)
  "PMH", "PMS", "BMO", "POO", "CCH", "WRH", "TBW", "CHM", "BGN", "BND",
  "HKM", "NWD", "AHV", "TAU",
  // Phase E — Mid-England + tail (15)
  "NUN", "LMS", "RGL", "LBO", "BDM", "HIT", "LTV", "LEI", "GCR", "RET",
  "WML", "SBJ", "EGR", "SFN", "LCN",
  // Phase F — Far north / Scotland (8)
  "EDB", "GLC", "CAR", "ABD", "DDE", "PER", "INV", "STG",
  // Phase G — Long-tail catch-all (6)
  "ATL", "CTR", "BAR", "NWE", "BSE", "ACT",
]

// Primaries we deliberately DON'T top up. Empty now — earlier we
// graveyarded ZFD (Farringdon) and SRA (Stratford) because their
// Google Routes data was good enough, but batch-9 re-queues every
// London-area NR station that isn't fully V2 captured, including
// those two. Kept as a Set (not deleted) so future intentional
// stale-flags can still be added without reintroducing the const.
const INTENTIONALLY_STALE_STATIONS = new Set<string>()

// Stations the panel proactively tracks (synthesises a "needs fetching"
// row for if they're not yet in origin-routes.json). Public primaries +
// friends + admin primaries are always tracked because the app requires
// them. TRACKED_SEED + QUEUE_ORDER add any explicitly-queued junctions
// on top. Junctions not in that explicit queue are still shown in the
// Fetched tab once they have data; they just don't appear as "missing"
// when absent.
const TARGET_STATIONS = new Set([
  ...PUBLIC_PRIMARY_CRS,
  ...FRIEND_CRS,
  ...ADMIN_PRIMARY_CRS,
  ...TRACKED_SEED,
  ...QUEUE_ORDER,
])

export function RTTStatusPanel({ open, onOpenChange }: {
  open: boolean
  onOpenChange: (open: boolean) => void
}) {
  const [data, setData] = useState<StatusPayload | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [lastFetchAt, setLastFetchAt] = useState<Date | null>(null)
  // Tab — Queue (stations needing fetching) vs Fetched (full V2 data
  // grouped by category). Not persisted; opens default to "queue" so the
  // admin lands on the actionable list.
  const [activeTab, setActiveTab] = useState<"queue" | "fetched">("queue")
  // AbortController for in-flight fetches — used so a rapid close+reopen
  // doesn't write stale data into state after unmount.
  const abortRef = useRef<AbortController | null>(null)

  const fetchStatus = useCallback(async () => {
    abortRef.current?.abort()
    const ctrl = new AbortController()
    abortRef.current = ctrl
    try {
      const res = await fetch("/api/dev/rtt-status", { signal: ctrl.signal })
      if (!res.ok) throw new Error(`status ${res.status}`)
      const json = (await res.json()) as StatusPayload
      setData(json)
      setError(null)
      setLastFetchAt(new Date())
    } catch (e) {
      if ((e as Error).name === "AbortError") return
      setError(e instanceof Error ? e.message : "unknown")
    }
  }, [])

  // Fetch on open + poll every POLL_MS while open. Cleanup on close
  // aborts any in-flight request and clears the interval.
  useEffect(() => {
    if (!open) return
    void fetchStatus()
    const id = setInterval(fetchStatus, POLL_MS)
    return () => {
      clearInterval(id)
      abortRef.current?.abort()
    }
  }, [open, fetchStatus])

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90dvh] w-[min(900px,94dvw)] max-w-none overflow-y-auto p-6 sm:max-w-none">
        <DialogHeader>
          <DialogTitle>RTT Saturday-morning data — current state</DialogTitle>
          <DialogDescription>
            Reads <code>data/origin-routes.json</code> every {POLL_MS / 1000}s.
            Journeys = total (depMin, duration) observations across all
            destinations. Dates = Saturdays that have contributed V2 data.
          </DialogDescription>
        </DialogHeader>

        {error && (
          <div className="rounded-md bg-red-100 px-3 py-2 text-sm text-red-800 dark:bg-red-950 dark:text-red-200">
            Failed to load: {error}
          </div>
        )}

        {/* Two tabs — Queue (stations queued up for fetching, including
            anything in PUBLIC_PRIMARY_CRS / FRIEND_CRS / ADMIN_PRIMARY_CRS
            that doesn't yet have full V2 data) and Fetched (stations
            with full V2 data, grouped by category). Same pill aesthetic
            as the rest of the panel. */}
        <div className="flex items-center gap-1.5 text-xs font-mono">
          {([
            { key: "queue", label: "Queue" },
            { key: "fetched", label: "Fetched" },
          ] as const).map((opt) => (
            <button
              key={opt.key}
              onClick={() => setActiveTab(opt.key)}
              className={`rounded px-2 py-1 transition-colors ${
                activeTab === opt.key
                  ? "bg-primary text-primary-foreground"
                  : "bg-muted text-muted-foreground hover:bg-muted-foreground/20"
              }`}
            >
              {opt.label}
            </button>
          ))}
        </div>

        {data && (() => {
          // Merge real primaries with synthesised rows for TARGET_STATIONS
          // that don't yet exist in origin-routes.json. Without this,
          // stations queued for an upcoming fetch (Lewes, Maidenhead
          // before Phase 3 hits them) would be invisible, making the
          // admin panel misleading — looks like those primaries aren't
          // being worked on when they actually are.
          const presentCrs = new Set(data.stations.map((p) => p.crs))
          // API-provided CRS→name map (resolved from public/stations.json
          // server-side). Seeded with queued-CRS entries so the TARGET
          // loop below — which runs for in-progress CRS not in either
          // stations or queuedCrs (because the server filters those out) —
          // still gets real names. Without this seeding, HWN while being
          // actively fetched displayed as "HWN HWN" instead of "HWN
          // Harlow Town" — the queuedCrs-driven fallback only fires for
          // genuinely-queued rows, not the brief in-progress window.
          const apiCrsToName: Record<string, string> = {
            // scrapedNames covers in-progress too (HWN while its fetch
            // runs). queuedCrs entries would also show here but
            // scrapedNames is a superset — prefer it.
            ...(data.scrapedNames ?? {}),
          }
          for (const entry of data.queuedCrs ?? []) {
            if (entry.name) apiCrsToName[entry.crs] = entry.name
          }
          const resolveName = (crs: string) =>
            apiCrsToName[crs] ?? STATION_DISPLAY_NAMES[crs] ?? crs
          const synthesisedMissing: StationSummary[] = []
          for (const crs of TARGET_STATIONS) {
            if (presentCrs.has(crs)) continue
            synthesisedMissing.push({
              coord: `__missing:${crs}`,
              name: resolveName(crs),
              crs,
              destinations: 0,
              journeys: 0,
              dates: [],
              generatedAt: null,
            })
          }
          // Also surface every CRS the API picked up from orchestrator
          // scripts that isn't in TARGET_STATIONS. The server already
          // filtered out CRS codes that are present in origin-routes.json
          // OR currently in-progress, so what's left is genuinely queued.
          const syntheticCrs = new Set(synthesisedMissing.map((s) => s.crs))
          for (const entry of data.queuedCrs ?? []) {
            if (presentCrs.has(entry.crs) || syntheticCrs.has(entry.crs)) continue
            // Prefer the API-resolved name (from public/stations.json);
            // fall back to the hardcoded STATION_DISPLAY_NAMES map, then
            // the bare CRS. This way new queued hubs get their real
            // station names automatically without editing the panel.
            const name = entry.name && entry.name !== entry.crs
              ? entry.name
              : (STATION_DISPLAY_NAMES[entry.crs] ?? entry.crs)
            synthesisedMissing.push({
              coord: `__queued:${entry.crs}`,
              name,
              crs: entry.crs,
              destinations: 0,
              journeys: 0,
              dates: [],
              generatedAt: null,
            })
          }
          // Row ordering (top → bottom):
          //   1. Actively RUNNING fetches (🏃) — sorted by QUEUE_ORDER
          //      position. Happening right now, deserves the top.
          //   2. Queued incomplete primaries (⚠️ ⏳) — sorted by
          //      QUEUE_ORDER position. Waiting their turn.
          //   3. Complete primaries (✅ tracked, or · untracked bonus
          //      data) — alphabetical by station name.
          //   4. Graveyarded (🪦) — last, alphabetical.
          // "Group" determines the primary sort axis, with a numeric/
          // string tiebreaker inside each group.
          const inProgressSet = new Set(data.inProgressCrs)
          // Queue rank — uses lastIndexOf so stations with a retry slot
          // (Phase 1.5) sort by the retry position, not their original
          // Phase 1 position. For stations appearing only once in
          // QUEUE_ORDER this is equivalent to indexOf.
          function queueRank(crs: string): number {
            const i = QUEUE_ORDER.lastIndexOf(crs)
            return i >= 0 ? i : Number.MAX_SAFE_INTEGER
          }
          function groupAndTiebreaker(p: StationSummary): [number, number, string] {
            if (INTENTIONALLY_STALE_STATIONS.has(p.crs)) return [4, 0, p.name]
            const isInProgress = inProgressSet.has(p.crs)
            const isTracked = TARGET_STATIONS.has(p.crs)
            const dateCount = p.dates.length
            // Queued synthetic rows (from orchestrator-script scraping)
            // carry a `__queued:` coord prefix and should rank alongside
            // the TARGET_STATIONS incomplete rows rather than falling
            // through to the "complete/bonus" bucket.
            const isSyntheticQueued = p.coord.startsWith("__queued:")
            const isIncomplete =
              isSyntheticQueued ||
              (isTracked && (p.destinations === 0 || dateCount < 2))
            const qRank = queueRank(p.crs)
            if (isInProgress) return [1, qRank, p.name]
            if (isIncomplete) return [2, qRank, p.name]
            // Complete (✅) or untracked bonus (·) — middle bucket.
            // Sort newly-completed first: negate the generatedAt epoch so
            // larger timestamps (more recent) come before smaller ones.
            // 0 fallback when generatedAt is missing/malformed — those rows
            // park at the end of the bucket and tie-break alphabetically.
            const ts = p.generatedAt ? new Date(p.generatedAt).getTime() : 0
            const recencyRank = -(Number.isFinite(ts) ? ts : 0)
            return [3, recencyRank, p.name]
          }
          // A row is "fetched" when it carries full V2 coverage —
          // ≥ 2 sampled Saturdays AND ≥ 1 destination. Anything below
          // the threshold belongs in the Queue tab (still being built
          // up). Synthesised rows from TARGET_STATIONS / queue scraping
          // always go to Queue (they've never been fetched at all).
          const isFetched = (p: StationSummary) =>
            !p.coord.startsWith("__") &&
            p.dates.length >= 2 &&
            p.destinations > 0
          // Queue tab only shows rows the admin actually queued or is
          // actively fetching — partial junction data (e.g. ZFD with
          // 1 V2 date) doesn't appear here unless explicitly tracked.
          const isInQueue = (p: StationSummary) => {
            if (isFetched(p)) return false
            if (TARGET_STATIONS.has(p.crs)) return true
            if (data.inProgressCrs.includes(p.crs)) return true
            if (p.coord.startsWith("__queued:") || p.coord.startsWith("__missing:")) return true
            return false
          }
          const allRows = [...data.stations, ...synthesisedMissing]
            .filter((p) => activeTab === "queue" ? isInQueue(p) : isFetched(p))
            .sort((a, b) => {
              const [ga, na, sa] = groupAndTiebreaker(a)
              const [gb, nb, sb] = groupAndTiebreaker(b)
              if (ga !== gb) return ga - gb
              if (na !== nb) return na - nb
              return sa.localeCompare(sb)
            })
          // Fetched view groups rows by station category so the admin
          // can see at a glance whether each category is fully covered.
          // Queue view stays flat — it's the actionable list, ordered
          // by group/queue rank from groupAndTiebreaker above.
          const groupedRows: Record<StationCategory, StationSummary[]> =
            activeTab === "fetched"
              ? CATEGORY_ORDER.reduce((acc, cat) => {
                  acc[cat] = allRows.filter((r) => categoryOf(r.crs) === cat)
                  return acc
                }, {} as Record<StationCategory, StationSummary[]>)
              : { "public-primary": [], "friend": [], "admin-primary": [], "junction": allRows }

          // Compute ETA (completion timestamp) per primary. Only meaningful
          // while the orchestrator is running and we have queue positions;
          // otherwise everything shows "—".
          //
          //   - complete primaries        → null (nothing to estimate)
          //   - graveyards / untracked    → null
          //   - currently in-flight       → now + AVG_PRIMARY_MS / 2
          //     (midway through a ~15 min fetch on average)
          //   - queued behind in-flight   → now + (queueGap + 0.5) × AVG
          //   - queued with nothing live  → null (we don't know when the
          //     pipeline will next advance)
          // Pull the non-null data fields into locals so TS narrowing
          // survives into the etaFor closure below.
          const wrapperRunning = data.wrapperRunning
          const inProgressCrs = data.inProgressCrs
          const now = Date.now()
          // Live queue index — the "where are we in the pipeline"
          // anchor for ETAs.
          //
          //   1. If a fetch is mid-run → use its queue position
          //      (indexOf — a running fetch drives the queue linearly,
          //      first occurrence wins).
          //   2. Otherwise, if wrapper is running but we're between
          //      phases (nothing currently being fetched) → use the
          //      last COMPLETED station's queue position. Keeps ETAs
          //      alive during the 300s wrapper sleeps between phases
          //      instead of collapsing to `—`.
          //   3. Wrapper not running → null, no ETAs.
          const liveQueueIdx = (() => {
            if (!wrapperRunning) return null
            if (inProgressCrs.length > 0) {
              const indices = inProgressCrs
                .map((crs) => QUEUE_ORDER.indexOf(crs))
                .filter((i) => i >= 0)
              if (indices.length > 0) return Math.min(...indices)
            }
            // Between-phases fallback: max queue-index among stations
            // that are tracked, complete (≥2 V2 dates), and actually
            // in the queue. Adding the 0.5 offset in etaFor gives the
            // "about to start next one" approximation.
            let maxCompletedIdx = -1
            for (const s of data.stations) {
              if (!TARGET_STATIONS.has(s.crs)) continue
              if (INTENTIONALLY_STALE_STATIONS.has(s.crs)) continue
              if (s.destinations > 0 && s.dates.length >= 2) {
                const idx = QUEUE_ORDER.indexOf(s.crs)
                if (idx > maxCompletedIdx) maxCompletedIdx = idx
              }
            }
            return maxCompletedIdx >= 0 ? maxCompletedIdx : null
          })()
          function etaFor(p: StationSummary): Date | null {
            if (INTENTIONALLY_STALE_STATIONS.has(p.crs)) return null
            const isTracked = TARGET_STATIONS.has(p.crs)
            // Suburban-hub queue rows (from orchestrator-script scraping)
            // aren't in TARGET_STATIONS but we still want an ETA for
            // them — they carry a `__queued:` coord prefix and a known
            // QUEUE_ORDER slot, so the rest of this function can treat
            // them exactly like incomplete tracked rows.
            const isSyntheticQueued = p.coord.startsWith("__queued:")
            if (!isTracked && !isSyntheticQueued) return null
            const dateCount = p.dates.length
            const isIncomplete = p.destinations === 0 || dateCount < 2
            // Completed tracked stations — surface when they finished
            // (the file's generatedAt timestamp, set at the fetch's
            // write-back). Lets the admin see how fresh each "done" row
            // is at a glance. Invalid / missing timestamps degrade to
            // null so the cell just shows "—".
            if (!isIncomplete) {
              if (!p.generatedAt) return null
              const d = new Date(p.generatedAt)
              return Number.isNaN(d.getTime()) ? null : d
            }
            const isInProgress = inProgressCrs.includes(p.crs)
            if (isInProgress) return new Date(now + AVG_PRIMARY_MS / 2)
            if (liveQueueIdx === null) return null
            // lastIndexOf so stuck stations pick up their Phase 1.5
            // retry slot, not their original Phase 1 position (which
            // the pipeline has already passed). Stations appearing
            // only once behave as before.
            const myIdx = QUEUE_ORDER.lastIndexOf(p.crs)
            if (myIdx < 0 || myIdx <= liveQueueIdx) return null
            const gap = myIdx - liveQueueIdx
            return new Date(now + (gap + 0.5) * AVG_PRIMARY_MS)
          }
          return (
          <>
            <table className="w-full border-collapse text-sm font-mono">
              <thead>
                <tr className="border-b border-border text-left">
                  <th className="py-2 pr-3 font-semibold">CRS / Station</th>
                  <th className="py-2 pr-3 text-right font-semibold">Dest.</th>
                  <th className="py-2 pr-3 text-right font-semibold">Journeys</th>
                  <th className="py-2 pr-3 font-semibold">Sampled dates</th>
                  <th className="py-2 pr-3 font-semibold">End time</th>
                </tr>
              </thead>
              <tbody>
                {(() => {
                  // Per-row JSX builder — used by both flat (Queue) and
                  // grouped (Fetched) renders. Pulled into a closure so
                  // the badge / colour / hourglass logic doesn't get
                  // duplicated. Returns a single <tr>.
                  const renderRow = (p: StationSummary) => {
                    const isTracked = TARGET_STATIONS.has(p.crs)
                    const dateCount = p.dates.length
                    const isInProgress = data.inProgressCrs.includes(p.crs)
                    // Synthetic-queued rows come from orchestrator-script
                    // scraping — coord starts with "__queued:". Treat as
                    // tracked-but-incomplete so they pick up the amber ⚠️.
                    const isSyntheticQueued = p.coord.startsWith("__queued:")
                    let rowClass = ""
                    let badge = ""
                    if (INTENTIONALLY_STALE_STATIONS.has(p.crs)) {
                      rowClass = "text-muted-foreground"
                      badge = "🪦"
                    } else if (!isTracked && !isSyntheticQueued) {
                      badge = "·"
                    } else {
                      const isIncomplete =
                        isSyntheticQueued || p.destinations === 0 || dateCount < 2
                      if (isIncomplete) {
                        rowClass = "text-amber-700 dark:text-amber-400"
                        badge = "⚠️"
                      } else {
                        rowClass = "text-emerald-700 dark:text-emerald-400"
                        badge = "✅"
                      }
                    }
                    return (
                      <tr key={p.coord} className={`border-b border-border/40 ${rowClass}`}>
                        <td className="py-1.5 pr-3">
                          {badge}{" "}
                          <span className="opacity-70">{p.crs}</span>{" "}
                          {p.name}
                          {isInProgress && (
                            <span
                              className="ml-1.5 inline-block animate-pulse"
                              title="Fetch in progress — fetch-direct-reachable.mjs is running for this station right now"
                            >
                              🏃
                            </span>
                          )}
                        </td>
                        <td className="py-1.5 pr-3 text-right tabular-nums">{p.destinations}</td>
                        <td className="py-1.5 pr-3 text-right tabular-nums">{p.journeys}</td>
                        <td className="py-1.5 pr-3">
                          {p.dates.length > 0
                            ? p.dates.map(formatShortDate).join(", ")
                            : "—"}
                        </td>
                        <td className="py-1.5 pr-3 text-muted-foreground">
                          {(() => {
                            const eta = etaFor(p)
                            return eta ? formatEta(eta) : "—"
                          })()}
                        </td>
                      </tr>
                    )
                  }
                  // Queue tab → flat render (everything sorted together
                  // by group/queue rank). Fetched tab → group by category
                  // with a heading row before each group, skipping empty
                  // groups so we don't render dangling headers.
                  if (activeTab === "queue") {
                    return allRows.length > 0
                      ? allRows.map(renderRow)
                      : (
                        <tr>
                          <td colSpan={5} className="py-6 text-center text-muted-foreground">
                            Queue is empty — every tracked station is fetched.
                          </td>
                        </tr>
                      )
                  }
                  return CATEGORY_ORDER.map((cat) => {
                    const groupRows = groupedRows[cat]
                    if (!groupRows || groupRows.length === 0) return null
                    return (
                      <Fragment key={cat}>
                        <tr className="border-y border-border bg-muted/40">
                          <td colSpan={5} className="px-3 py-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                            {CATEGORY_LABELS[cat]} ({groupRows.length})
                          </td>
                        </tr>
                        {groupRows.map(renderRow)}
                      </Fragment>
                    )
                  })
                })()}
              </tbody>
            </table>

            <div className="mt-4 text-xs text-muted-foreground">
              <div>
                File updated at{" "}
                <span className="tabular-nums">
                  {new Date(data.fileUpdatedAt).toLocaleString("en-GB", { hour12: false })}
                </span>
              </div>
              {lastFetchAt && (
                <div>
                  Last polled{" "}
                  <span className="tabular-nums">
                    {lastFetchAt.toLocaleTimeString("en-GB", { hour12: false })}
                  </span>
                </div>
              )}
              <div className="mt-2">
                Legend: ✅ full V2 data ·
                {" "}⚠️ incomplete (missing destinations or fewer than
                {" "}2 Saturdays) ·
                {" "}🪦 deliberately stale (Google Routes covers it) ·
                {" "}· not in any tracked category ·
                {" "}🏃 fetch running now
              </div>
            </div>
          </>
          )
        })()}

        {!data && !error && (
          <div className="py-8 text-center text-sm text-muted-foreground">Loading…</div>
        )}
      </DialogContent>
    </Dialog>
  )
}
