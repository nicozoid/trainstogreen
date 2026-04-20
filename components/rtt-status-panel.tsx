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

import { useCallback, useEffect, useRef, useState } from "react"
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

// Primaries we care about getting proper 2-date coverage on. Anything in
// origin-routes.json that isn't in this list still shows in the table
// (it's "bonus" data), but isn't flagged as "missing" when absent. The
// set mirrors v2-complete.sh's target list — keep in sync when we
// expand or contract fetch targets.
const TARGET_STATIONS = new Set([
  // 15 London termini — ALL need full 2-date 09:00–12:00 coverage
  "CHX", "LST", "MOG", "BFR", "CST", "FST", "LBG", "MYB",
  "PAD", "VIC", "WAT", "WAE", "KGX", "STP", "EUS",
  // Hub stations we care about for Option 2 splice routing + CLJ for
  // general suburban coverage. CLJ was pulled from the home-selector
  // dropdown's default seed but we're still fetching it — plan is to
  // verify via admin mode, then re-seed it there once trusted.
  "CLJ", "LWS", "MAI",
  // Suburban / regional primaries added 2026-04-20 for broader
  // Option-2 splice coverage. Keep in sync with the Phase 3 loop in
  // /tmp/ttg-rtt/v2-complete.sh.
  "RDG", "DFD", "WOK", "FPK", "ECR", "RMD", "WFJ", "WIJ",
  "SVS", "HRW", "FOG", "HAY", "EAL",
])

// Pretty names for missing-target synthesised rows. Only used when the
// primary isn't yet present in origin-routes.json — once it's been
// fetched, its real name from the JSON wins. Keyed by CRS.
const STATION_DISPLAY_NAMES: Record<string, string> = {
  CHX: "Charing Cross", LST: "Liverpool Street", MOG: "Moorgate",
  BFR: "Blackfriars",   CST: "Cannon Street",    FST: "Fenchurch Street",
  LBG: "London Bridge", MYB: "Marylebone",       PAD: "Paddington",
  VIC: "Victoria",      WAT: "Waterloo",         WAE: "Waterloo East",
  KGX: "London King's Cross", STP: "London St. Pancras International",
  EUS: "Euston",
  CLJ: "Clapham Junction", LWS: "Lewes", MAI: "Maidenhead",
  RDG: "Reading",       DFD: "Dartford",         WOK: "Woking",
  FPK: "Finsbury Park", ECR: "East Croydon",     RMD: "Richmond",
  WFJ: "Watford Junction", WIJ: "Willesden Junction",
  SVS: "Seven Sisters", HRW: "Harrow & Wealdstone",
  FOG: "Forest Gate",   HAY: "Hayes & Harlington",
  EAL: "Ealing Broadway",
}

// Canonical queue order used by /tmp/ttg-rtt/v2-complete.sh. Anything
// still in-flight or not-yet-started sorts to the TOP of the table by
// its position here, so the admin reads the panel as a todo list.
// Keep in sync with v2-complete.sh when phases change.
const QUEUE_ORDER: string[] = [
  // Current pipeline is /tmp/ttg-rtt/v2-priority.sh, which replaced
  // v2-complete.sh (killed at 14:15 local because its in-memory bash
  // had cached an older script — mid-run edits didn't propagate).
  //
  // QUEUE_ORDER lists ONLY pending stations; already-completed Phase 1
  // stations (CHX, LST, MYB, PAD, VIC, WAT, WAE, KGX, STP, EUS) are
  // absent — their rows show generatedAt in the "Est. complete"
  // column instead of using queue-derived ETAs.
  //
  // Phase A — retry the 4 Phase-1 failures (user priority: top)
  "MOG", "CST", "FST", "LBG",
  // Phase B — BFR (2026-04-25 had engineering works; fresh 2-date run)
  "BFR",
  // Phase C — hub fetches, high-priority first
  "LWS", "MAI", "CLJ",
  // Phase C continued — 13 suburban / regional stations, user-priority order
  "RDG", "DFD", "WOK", "FPK", "ECR", "RMD", "WFJ", "WIJ",
  "SVS", "HRW", "FOG", "HAY", "EAL",
]

// Primaries we deliberately DON'T top up — their Google Routes data is
// comprehensive enough that re-fetching would burn API budget without
// adding real value. Surfaced with 🪦 in the admin table so it's clear
// they're frozen on purpose, not overlooked.
const INTENTIONALLY_STALE_STATIONS = new Set(["ZFD", "SRA"])

export function RTTStatusPanel({ open, onOpenChange }: {
  open: boolean
  onOpenChange: (open: boolean) => void
}) {
  const [data, setData] = useState<StatusPayload | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [lastFetchAt, setLastFetchAt] = useState<Date | null>(null)
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

        {data && (() => {
          // Merge real primaries with synthesised rows for TARGET_STATIONS
          // that don't yet exist in origin-routes.json. Without this,
          // stations queued for an upcoming fetch (Lewes, Maidenhead
          // before Phase 3 hits them) would be invisible, making the
          // admin panel misleading — looks like those primaries aren't
          // being worked on when they actually are.
          const presentCrs = new Set(data.stations.map((p) => p.crs))
          const synthesisedMissing: StationSummary[] = []
          for (const crs of TARGET_STATIONS) {
            if (presentCrs.has(crs)) continue
            synthesisedMissing.push({
              coord: `__missing:${crs}`,
              name: STATION_DISPLAY_NAMES[crs] ?? crs,
              crs,
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
            const isIncomplete =
              isTracked && (p.destinations === 0 || dateCount < 2)
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
          const rows = [...data.stations, ...synthesisedMissing].sort((a, b) => {
            const [ga, na, sa] = groupAndTiebreaker(a)
            const [gb, nb, sb] = groupAndTiebreaker(b)
            if (ga !== gb) return ga - gb
            if (na !== nb) return na - nb
            return sa.localeCompare(sb)
          })

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
            if (!isTracked) return null
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
                  <th className="py-2 pr-3 font-semibold">Station</th>
                  <th className="py-2 pr-3 text-right font-semibold">Dest.</th>
                  <th className="py-2 pr-3 text-right font-semibold">Journeys</th>
                  <th className="py-2 pr-3 font-semibold">Sampled dates</th>
                  <th className="py-2 pr-3 font-semibold">End time</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((p) => {
                  const isTracked = TARGET_STATIONS.has(p.crs)
                  const dateCount = p.dates.length
                  // Hourglass states (shown separately from the ⚠️/✅ badge):
                  //   - in-progress: a fetch-direct-reachable.mjs is
                  //     currently running for this CRS (pulse to show
                  //     activity). Queued state is no longer marked
                  //     with a dedicated icon — the Est. complete
                  //     column is the visual signal instead.
                  const isInProgress = data.inProgressCrs.includes(p.crs)
                  // ⚠️ vs ✅ — based on the DATA itself, not fetch
                  // activity. A primary that already has full data but
                  // is being re-fetched / topped up reads as ✅ + 🏃,
                  // not ⚠️ + 🏃. Incomplete when either:
                  //   - zero destinations captured (fetch never landed)
                  //   - only 1 Saturday sampled (need 2 for
                  //     engineering-works resilience)
                  // Activity (🏃 / ⏳) is rendered separately below.
                  // Untracked primaries (Farringdon, Stratford — we
                  // intentionally skip them) stay neutral (·).
                  let rowClass = ""
                  let badge = ""
                  if (INTENTIONALLY_STALE_STATIONS.has(p.crs)) {
                    // Deliberately frozen — Google Routes data covers
                    // these primaries well enough that re-fetching is a
                    // waste of RTT budget.
                    rowClass = "text-muted-foreground"
                    badge = "🪦"
                  } else if (!isTracked) {
                    badge = "·"
                  } else {
                    const isIncomplete =
                      p.destinations === 0 || dateCount < 2
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
                          // 🏃 = "actively running right now". Pulses
                          // so it catches the eye. Queued state is no
                          // longer signalled with a separate icon —
                          // the Est. complete column does that job.
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
                })}
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
                Legend: ✅ tracked &amp; complete ·
                {" "}⚠️ tracked but incomplete (missing destinations
                {" "}or fewer than 2 Saturdays) ·
                {" "}🪦 deliberately stale (Google Routes covers it) ·
                {" "}· untracked (bonus data) ·
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
