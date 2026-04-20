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

type PrimarySummary = {
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
  primaries: PrimarySummary[]
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

// Format an ISO date string (YYYY-MM-DD) as "25 Apr". Falls back to the
// raw string when parsing fails so malformed values surface visibly in
// the admin panel rather than silently disappearing.
function formatShortDate(iso: string): string {
  const d = new Date(`${iso}T00:00:00`)
  if (Number.isNaN(d.getTime())) return iso
  return d.toLocaleDateString("en-GB", { day: "numeric", month: "short" })
}

// Primaries we care about getting proper 2-date coverage on. Anything in
// origin-routes.json that isn't in this list still shows in the table
// (it's "bonus" data), but isn't flagged as "missing" when absent. The
// set mirrors v2-complete.sh's target list — keep in sync when we
// expand or contract fetch targets.
const TARGET_PRIMARIES = new Set([
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
const TARGET_DISPLAY_NAMES: Record<string, string> = {
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
  // Phase 1 — 14 termini top-up with 2nd Saturday
  "CHX", "LST", "MOG", "CST", "FST", "LBG", "MYB", "PAD",
  "VIC", "WAT", "WAE", "KGX", "STP", "EUS",
  // Phase 2 — BFR (2026-04-25 had engineering works, uses alt dates)
  "BFR",
  // Phase 3 — hub fetches, high-priority first
  "LWS", "MAI", "CLJ",
  // Phase 3 continued — suburban / regional primaries added 2026-04-20
  // in user-specified priority order.
  "RDG", "DFD", "WOK", "FPK", "ECR", "RMD", "WFJ", "WIJ",
  "SVS", "HRW", "FOG", "HAY", "EAL",
]

// Primaries we deliberately DON'T top up — their Google Routes data is
// comprehensive enough that re-fetching would burn API budget without
// adding real value. Surfaced with 🪦 in the admin table so it's clear
// they're frozen on purpose, not overlooked.
const INTENTIONALLY_STALE_PRIMARIES = new Set(["ZFD", "SRA"])

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
          // Merge real primaries with synthesised rows for TARGET_PRIMARIES
          // that don't yet exist in origin-routes.json. Without this,
          // stations queued for an upcoming fetch (Lewes, Maidenhead
          // before Phase 3 hits them) would be invisible, making the
          // admin panel misleading — looks like those primaries aren't
          // being worked on when they actually are.
          const presentCrs = new Set(data.primaries.map((p) => p.crs))
          const synthesisedMissing: PrimarySummary[] = []
          for (const crs of TARGET_PRIMARIES) {
            if (presentCrs.has(crs)) continue
            synthesisedMissing.push({
              coord: `__missing:${crs}`,
              name: TARGET_DISPLAY_NAMES[crs] ?? crs,
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
          function groupAndTiebreaker(p: PrimarySummary): [number, number, string] {
            if (INTENTIONALLY_STALE_PRIMARIES.has(p.crs)) return [4, 0, p.name]
            const isInProgress = inProgressSet.has(p.crs)
            const isTracked = TARGET_PRIMARIES.has(p.crs)
            const dateCount = p.dates.length
            const isIncomplete =
              isTracked && (p.destinations === 0 || dateCount < 2)
            const qIdx = QUEUE_ORDER.indexOf(p.crs)
            const qRank = qIdx >= 0 ? qIdx : Number.MAX_SAFE_INTEGER
            if (isInProgress) return [1, qRank, p.name]
            if (isIncomplete) return [2, qRank, p.name]
            // Complete (✅) or untracked bonus (·) — middle bucket.
            return [3, 0, p.name]
          }
          const rows = [...data.primaries, ...synthesisedMissing].sort((a, b) => {
            const [ga, na, sa] = groupAndTiebreaker(a)
            const [gb, nb, sb] = groupAndTiebreaker(b)
            if (ga !== gb) return ga - gb
            if (na !== nb) return na - nb
            return sa.localeCompare(sb)
          })
          return (
          <>
            <table className="w-full border-collapse text-sm font-mono">
              <thead>
                <tr className="border-b border-border text-left">
                  <th className="py-2 pr-3 font-semibold">Station</th>
                  <th className="py-2 pr-3 text-right font-semibold">Dest.</th>
                  <th className="py-2 pr-3 text-right font-semibold">Journeys</th>
                  <th className="py-2 pr-3 font-semibold">Sampled dates</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((p) => {
                  const isTracked = TARGET_PRIMARIES.has(p.crs)
                  const dateCount = p.dates.length
                  // Hourglass states (shown separately from the ⚠️/✅ badge):
                  //   - in-progress: a fetch-direct-reachable.mjs is
                  //     currently running for this CRS (pulse to show
                  //     activity).
                  //   - queued: orchestrator wrapper is alive AND this
                  //     tracked primary hasn't hit 2-date coverage yet.
                  //     Doesn't animate — just "this is planned".
                  const isInProgress = data.inProgressCrs.includes(p.crs)
                  const isQueued = !isInProgress
                    && data.wrapperRunning
                    && isTracked
                    && dateCount < 2
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
                  if (INTENTIONALLY_STALE_PRIMARIES.has(p.crs)) {
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
                          // 🏃 = "actively running right now". Pulses so
                          // it catches the eye vs the static ⏳ we use
                          // for primaries merely waiting their turn.
                          <span
                            className="ml-1.5 inline-block animate-pulse"
                            title="Fetch in progress — fetch-direct-reachable.mjs is running for this primary right now"
                          >
                            🏃
                          </span>
                        )}
                        {isQueued && (
                          <span
                            className="ml-1.5 inline-block opacity-60"
                            title="Queued — waiting for the orchestrator to reach this primary"
                          >
                            ⏳
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
                {" "}⚠️ tracked but incomplete (missing destinations,
                {" "}fewer than 2 Saturdays, or a fetch is pending) ·
                {" "}🪦 deliberately stale (Google Routes covers it) ·
                {" "}· untracked (bonus data) ·
                {" "}🏃 fetch running now ·
                {" "}⏳ queued for an upcoming fetch
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
