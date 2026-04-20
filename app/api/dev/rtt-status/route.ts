// Admin-only endpoint that summarises the current state of
// data/origin-routes.json for the RTT status panel in the admin UI.
//
// Returns per-primary counts:
//   - destinations: directReachable entry count
//   - journeys: total observations (= sum of serviceDepMinutes array lengths)
//   - sampledDates: dates listed in the primary's sampledDates metadata
//
// Stats are computed from the V2 schema only — observations without
// serviceDepMinutes don't contribute to the journey count. This matches
// what the Option 2 splice sees and what the prune script retains.
//
// No caching — every GET reads fresh from disk so the admin panel can
// poll and see the dataset update as the v2-complete.sh fetcher writes.

import { NextResponse } from "next/server"
import { readFile, stat } from "node:fs/promises"
import { join } from "node:path"
import { exec } from "node:child_process"
import { promisify } from "node:util"

const execAsync = promisify(exec)
// Every orchestrator log we want to reconcile "which station has
// what dates written" against. Add new orchestrator logs here as they
// come online; duplicates are harmless because the parsed dates are
// union'd into the same CRS key.
const ORCHESTRATOR_LOGS = [
  "/tmp/ttg-rtt/v2-complete.log",
  "/tmp/ttg-rtt/v2-priority.log",
  "/tmp/ttg-rtt/v2-rerun.log",
  "/tmp/ttg-rtt/v2-backfill-slow.log",
  "/tmp/ttg-rtt/phase-1-5-followup.log",
]

export const dynamic = "force-dynamic"

// Parse all known orchestrator logs for stations whose fetches
// SUCCESSFULLY wrote back. Each [N/M] CRS — dates: DATES header marks
// the start of a fetch; a "Wrote …" line before the next header means
// the write succeeded with those dates.
//
// Returns a map CRS → Set<dateString>, unioned across every log so
// historical runs (v2-complete, v2-priority, v2-rerun, etc.) all
// contribute. Reconciled against the file's v2FetchedDates at API
// time so the panel is accurate even when a mid-flight fetch running
// old code writes back without the v2FetchedDates field.
async function parseOrchestratorLogs(): Promise<Map<string, Set<string>>> {
  const map = new Map<string, Set<string>>()
  const headerRe = /^\[\d+\/\d+\] ([A-Z]+) — dates: ([0-9,\-]+)/
  for (const path of ORCHESTRATOR_LOGS) {
    let log = ""
    try { log = await readFile(path, "utf8") } catch { continue }
    const lines = log.split("\n")
    let currentCrs: string | null = null
    let currentDates: string[] = []
    for (const line of lines) {
      const m = headerRe.exec(line)
      if (m) {
        currentCrs = m[1]
        currentDates = m[2].split(",").map((d) => d.trim()).filter(Boolean)
        continue
      }
      if (line.startsWith("Wrote ") && currentCrs) {
        const set = map.get(currentCrs) ?? new Set<string>()
        for (const d of currentDates) set.add(d)
        map.set(currentCrs, set)
        currentCrs = null
        currentDates = []
      }
    }
  }
  return map
}

// Inspect the process table for any currently-running fetch scripts.
// Returns the CRS codes of stations with an in-flight
// fetch-direct-reachable.mjs process, and a flag for whether an
// orchestrator wrapper (v2-complete.sh / v2-rerun.sh / etc.) is alive.
//
// `ps -Ao command=` gives us the full command line on both macOS and
// Linux; BSD `pgrep -af` only prints PIDs on macOS (the Linux-style
// -a flag isn't honoured), which is why our earlier regex never
// matched a CRS. `ps` is portable.
//
// This only works when the Next.js server has access to the process
// table (i.e. local dev). On Vercel serverless the `ps` call would
// fail harmlessly — panel just shows no hourglasses. Admin mode is
// only practically useful locally anyway.
async function getProcessState(): Promise<{ inProgressCrs: string[]; wrapperRunning: boolean }> {
  const state = { inProgressCrs: [] as string[], wrapperRunning: false }
  try {
    const { stdout } = await execAsync("ps -Ao command=")
    const keepPattern = /fetch-direct-reachable|v2-complete|v2-priority|v2-rerun|v2-backfill|tier1-fetch|clj-fetch|bfr-retry|phase-1-5-followup/
    for (const line of stdout.split("\n")) {
      if (!keepPattern.test(line)) continue
      // Wrapper scripts count as "something is queued/running"
      if (/v2-complete|v2-priority|v2-rerun|v2-backfill|tier1-fetch|clj-fetch|bfr-retry|phase-1-5-followup/.test(line)) {
        state.wrapperRunning = true
      }
      // fetch-direct-reachable.mjs <CRS> --dates=... — extract CRS
      const m = line.match(/fetch-direct-reachable\.mjs\s+([A-Z]{3})\b/)
      if (m) state.inProgressCrs.push(m[1])
    }
  } catch {
    // ps failed (unusual) — treat as nothing running.
  }
  return state
}

type Entry = {
  name: string
  crs: string
  serviceDepMinutes?: number[]
}

type Station = {
  name: string
  crs: string
  directReachable: Record<string, Entry>
  sampledDates?: string[]
  v2FetchedDates?: string[]
  generatedAt?: string
}

type StationSummary = {
  coord: string
  name: string
  crs: string
  destinations: number
  journeys: number
  /**
   * Dates that contributed V2-schema observations (serviceDepMinutes /
   * serviceDurationsMinutes) to this station. Preferred over `sampledDates`
   * for completeness checks because `sampledDates` can include legacy
   * pre-V2 fetch dates whose observations were later pruned when we
   * narrowed the scope to Saturday-morning 09:00–12:00.
   * Falls back to sampledDates when v2FetchedDates isn't present yet
   * (older rows written before 2026-04-20's schema extension).
   */
  dates: string[]
  generatedAt: string | null
}

export async function GET() {
  const path = join(process.cwd(), "data", "origin-routes.json")
  try {
    const [raw, meta] = await Promise.all([
      readFile(path, "utf8"),
      stat(path),
    ])
    const data = JSON.parse(raw) as Record<string, Station>
    // Log-derived "confirmed V2 write" dates per CRS. Union'd with
    // whatever the file's v2FetchedDates says so an old-code write
    // that dropped the field doesn't regress the panel.
    const logCompleted = await parseOrchestratorLogs()
    const stations: StationSummary[] = []
    for (const [coord, station] of Object.entries(data)) {
      const dr = station.directReachable ?? {}
      // Only count directReachable entries backed by V2-schema
      // observations. Any legacy entry that slipped past the prune (or
      // hasn't been re-fetched yet) is treated as worthless for this
      // panel — admin wants an honest "real Saturday-morning V2
      // coverage" view, not a total that includes pre-V2 cruft.
      let destinations = 0
      let journeys = 0
      for (const entry of Object.values(dr)) {
        const deps = Array.isArray(entry.serviceDepMinutes) ? entry.serviceDepMinutes : []
        if (deps.length === 0) continue
        destinations += 1
        journeys += deps.length
      }
      // V2 fetched dates — union of:
      //   - the file's v2FetchedDates (written by NEW fetch code)
      //   - dates confirmed via v2-complete.log (handles the case
      //     where a mid-flight old-code fetch wrote back without the
      //     v2FetchedDates field)
      //   - 2026-04-25 implicitly, IF the primary has any V2 obs
      //     (every successful V2 write since 2026-04-20 has touched
      //     that date — it's the earliest Saturday we've sampled).
      // V1 legacy dates in `sampledDates` are ignored on purpose.
      const dateSet = new Set<string>()
      if (Array.isArray(station.v2FetchedDates)) {
        for (const d of station.v2FetchedDates) dateSet.add(d)
      }
      const fromLog = logCompleted.get(station.crs)
      if (fromLog) for (const d of fromLog) dateSet.add(d)
      if (destinations > 0) dateSet.add("2026-04-25")
      const dates = [...dateSet].sort()
      stations.push({
        coord,
        name: station.name,
        crs: station.crs,
        destinations,
        journeys,
        dates,
        generatedAt: station.generatedAt ?? null,
      })
    }
    // Sort by CRS for stable display order.
    stations.sort((a, b) => a.crs.localeCompare(b.crs))
    const { inProgressCrs, wrapperRunning } = await getProcessState()
    return NextResponse.json({
      stations,
      inProgressCrs,
      wrapperRunning,
      fileUpdatedAt: meta.mtime.toISOString(),
    })
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "unknown" },
      { status: 500 },
    )
  }
}
