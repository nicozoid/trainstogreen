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

// Primaries we care about getting proper 2-date coverage on. Anything in
// origin-routes.json that isn't in this list still shows in the table
// (it's "bonus" data), but isn't flagged as "missing" when absent. The
// set mirrors v2-complete.sh's target list — keep in sync when we
// expand or contract fetch targets.
// Stations we explicitly fetched or are fetching (the "tracked" set).
// Seeded with the original Phase 1-3 targets; every CRS later added to
// QUEUE_ORDER for a batch orchestrator is auto-appended below so the
// panel treats it as tracked (⚠️/✅ badges, colour, ETA column) without
// manual upkeep every time we queue a new batch.
const TRACKED_SEED = [
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
]

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
  // Phase D — /tmp/ttg-rtt/batch-2-hubs.sh (was first-after-v2 in the
  // original chain; moved to head of queue after v2-priority.sh was
  // killed mid-WIJ because the RTT rate-limit had burned out — the
  // highest-priority suburban hubs were re-sequenced to the tail so
  // they'd get the freshest API quota). Sourced from the London-as-
  // home NRE spot-check: each fixes an over-estimated route.
  "HAT", "PUR", "SVG", "HWN", "LTN",
  // Phase E — /tmp/ttg-rtt/batch-3-hubs.sh. Top-ranked unfetched
  // interchanges by day-hike-range frequency. Hiking-region gateways.
  "BTN", "IPS", "WSB", "DVP", "SOO", "BLY", "TAM", "PBO",
  // Phase F — /tmp/ttg-rtt/batch-4-hubs.sh. Second-tier interchanges.
  "SOU", "SAY", "SIT", "BTH", "COV", "BHM", "CMB", "WIC", "MNG", "NOT",
  // Phase G — /tmp/ttg-rtt/batch-5-hubs.sh. Third-tier AONB / National
  // Park gateway hubs.
  "HWY", "BCU", "OXF", "CBG", "TWY", "BAA", "COL", "DID", "BRI", "SOA",
  // Phase H — /tmp/ttg-rtt/batch-6-hubs.sh (formerly suburban-hubs.sh,
  // renamed to avoid colliding with batch-2's wait pattern). Highest-
  // priority hubs — re-sequenced last so they fetch with maximum
  // rate-limit headroom after everything else completes.
  "RDH", "TON", "PDW",                           // high priority
  "SEV", "AFK", "HHE", "GTW", "GLD",             // medium
  "SLO", "SAC", "SNF", "BSK",                    // low
  // Phase I — /tmp/ttg-rtt/batch-7-hubs.sh. Cleanup re-queue for the
  // Phase C stations that got skipped when v2-priority.sh was killed
  // mid-WIJ on 2026-04-20. Runs when the pipeline is otherwise idle.
  "WIJ", "SVS", "HRW", "FOG", "HAY", "EAL",
  // Phase J — /tmp/ttg-rtt/batch-8-hubs.sh. Comprehensive low-data-
  // interchange pass: every station that appears as a rail-to-rail
  // interchange in any Central-London journey but isn't yet fetched.
  // Ordered by frequency across journeys. 62 hubs — from major
  // regional termini (CRE, CDF, MAN) down to single-journey edges
  // (SAL, FTN, WIN). Runs when everything else is idle.
  "CRE", "CDF", "SOT", "DBY", "GRA", "NRW", "EXD", "SGB", "DON",
  "WBQ", "RET", "GCR", "LTV", "STA", "SHF", "LEI", "LMS", "RGL",
  "NUN", "WML", "CTR", "HIT", "WGN", "BDM", "SPT", "NWE", "MKT",
  "TLS", "SWI", "HAV", "PTR", "CHD", "ELY", "LCN", "SFN", "ATL",
  "LBO", "NBY", "SAL", "FTN", "WIN", "SBJ", "EGR", "ABW", "LGE",
  "WMD", "TAU", "BGN", "BND", "HKM", "NWD", "HRH", "AHV", "ACT",
  "HSL", "FEL", "WYB", "MAR", "BXB", "FAV", "BSR", "MAN",
  // Phase K — /tmp/ttg-rtt/batch-9-hubs.sh. Every London-area NR /
  // Elizabeth-line station that isn't already fully V2 captured.
  // 321 codes total; order matches the script's for-loop so the
  // panel's queue-rank logic produces correct ETAs.
  "WAL", "WDT", "SMY", "MIL", "CTF", "WIM", "NLT", "KGL", "BWO",
  "GSN", "WFN", "HWW", "DGC", "DNM", "SDH", "NDL", "IVR", "THD",
  "CDN", "WME", "KND", "RHM", "SIH", "SUC", "RMF", "SUR", "MOT",
  "SMO", "HEN", "RDT", "OLD", "BMN", "WDO", "HAF", "WCY", "UPM",
  "BSH", "HGY", "SRH", "STW", "GFD", "IFD", "SVK", "WHR", "BAK",
  "KDB", "ZLW", "DMK", "QRP", "EDR", "BRX", "CHP", "CSS", "ZFD",
  "FLW", "HMP", "KMP", "SUU", "UPH", "SHP", "QRB", "VXH", "HYW",
  "PNW", "WLI", "BNH", "ELW", "ERH", "WNT", "BRS", "NEM", "CTK",
  "MAL", "TOL", "CSN", "STE", "EPH", "SUO", "BNS", "ESH", "HMW",
  "CHE", "OTF", "EFF", "WBO", "NSH", "IMW", "EAD", "CHN", "WBY",
  "TOO", "HYR", "WSW", "AHD", "ORP", "HNH", "CSD", "EPD", "BFN",
  "BXY", "BAL", "MTL", "WSU", "BBL", "EYN", "WWC", "SMG", "OXS",
  "CLG", "WRU", "HMC", "TAD", "CLW", "RIC", "HOH", "CAT", "WEH",
  "SRA", "KLY", "WHS", "WHY", "UWL", "WOH", "LNY", "KTN", "GNW",
  "LHS", "KCK", "HDW", "MTC", "MDS", "BKH", "DEP", "CYP", "BKA",
  "HER", "RAY", "WCP", "SNL", "LHD", "CSH", "EWE", "SYD", "FOH",
  "HPA", "NXG", "NWX", "SAJ", "WCB", "WWD", "WWA", "PLU", "SGR",
  "GRP", "HGR", "ESD", "CIT", "PET", "CLD", "DNG", "SCY", "SNR",
  "RDD", "LAD", "CFB", "LSY", "NBC", "CLK", "WWI", "EDN", "ELE",
  "EGH", "SNS", "TWI", "WRY", "WTN", "BNI", "CHK", "KWB", "BFD",
  "SYL", "ISL", "HOU", "CHY", "ASN", "NBT", "TED", "HCB", "KPA",
  "SRU", "NUM", "BMD", "ENL", "WLC", "MIJ", "CUF", "CWH", "GDH",
  "GPK", "PAL", "HRN", "BOP", "ANZ", "KNL", "HHY", "DYP", "BKG",
  "TOM", "CMD", "MRW", "SBM", "MYL", "LEW", "WHP", "SRS", "HWV",
  "BCY", "MNP", "EPS", "HXX", "TAT", "EWW", "EBD", "SRT", "LGF",
  "WDU", "SYH", "PNE", "KTH", "BKJ", "BKL", "BMS", "SEH", "KMS",
  "BRG", "FNR", "NHD", "CFT", "BGM", "BEC", "RVB", "LGJ", "GRY",
  "DDK", "RNM", "CFH", "OCK", "ENC", "SFA", "CSB", "WLT", "PUO",
  "BLM", "SRC", "NRB", "TTH", "LEE", "MTG", "NEH", "SID", "CRY",
  "AYP", "NFL", "SWM", "GNH", "SCG", "GDP", "PFL", "PMR", "SPB",
  "BRE", "HRO", "PBR", "WIH", "CTH", "WEA", "STL", "HAN", "GMY",
  "AML", "HAC", "PUT", "EXR", "CRI", "HYS", "MZH", "BXH", "BVD",
  "CDS", "AFS", "FCN", "CTN", "PON", "LEB", "ELS", "KNG", "BAD",
  "WCX", "SUD", "WMB", "AAP", "NSG", "OKL", "NBA", "SUP", "WNW",
  "GIP", "BIK", "EDW", "SGN", "CBP", "DRG", "TUH", "BCZ", "CWX",
  "CUS", "BDS", "TCR", "PDX", "SPL", "LSX",
  // Phase L — /tmp/ttg-rtt/batch-10-hubs.sh. Friend-origin candidates
  // — stations where a friend of a London user plausibly lives, so
  // they can be picked as a friend origin once the friend-picker
  // feature lands. Covers major regional cities + Home Counties /
  // coastal commuter towns.
  "YRK", "LDS", "LIV", "NCL", "PMH", "PMS", "SOC", "BMO",
  "EBN", "HGS", "CBE", "CBW", "BMH", "POO", "CCH", "WRH",
  "TBW", "REI", "DKG", "CHM",
  // Phase M — /tmp/ttg-rtt/batch-11-hubs.sh. Future-scope coverage
  // for "any London home + any-within-3h friend": major cities,
  // National Park gateways, cathedral / university towns.
  "PRE", "WVH", "NMP", "LAN", "HFD", "SWA", "SHR", "WOF", "WOS", "BPN",
  "WDM", "SKI", "MAT", "BUX", "KEI", "ALM", "BWK", "KGM", "MIM", "PAN", "GOR",
  "DHM", "HUL", "TRU", "PLY", "WRW",
  // Phase N — /tmp/ttg-rtt/batch-12-hubs.sh. Remaining 50k+ population
  // centres within 3h45m of London not yet covered. MKC (Milton Keynes)
  // was the biggest oversight; rest are Yorkshire textile cities,
  // Medway towns, Sussex/Hampshire commuters, Midlands suburbs, etc.
  "BBN", "BON", "RCD", "BDI", "BDQ", "HUD", "HFX", "WKF", "RMC",
  "MBR", "SUN", "DAR", "MKC", "AYS", "BAN", "RUG", "BHI", "BSW",
  "SUT", "SOL", "WSL", "RDC", "KID", "BUT", "MFT", "MDE", "MDW",
  "CTM", "GLM", "FKC", "GRV", "BSO", "AHT", "FNB", "CRW", "WSM",
  "CNM", "RAM", "SCA",
]

// Primaries we deliberately DON'T top up. Empty now — earlier we
// graveyarded ZFD (Farringdon) and SRA (Stratford) because their
// Google Routes data was good enough, but batch-9 re-queues every
// London-area NR station that isn't fully V2 captured, including
// those two. Kept as a Set (not deleted) so future intentional
// stale-flags can still be added without reintroducing the const.
const INTENTIONALLY_STALE_STATIONS = new Set<string>()

// Union of TRACKED_SEED and every CRS in QUEUE_ORDER. Any station we
// queue for a batch fetch automatically becomes a "tracked" primary in
// the panel — gets the ⚠️/✅ badge, row colour, and completion-datetime
// ETA. Without this the badge / ETA logic only recognised the original
// 28 seed stations and every new-batch CRS (HAT, PUR, BTN, etc.)
// rendered as a neutral "·" with no colour.
const TARGET_STATIONS = new Set([...TRACKED_SEED, ...QUEUE_ORDER])

// The 15 London termini — hardcoded CRS set used by the category
// filter. A station is categorised as "termini" iff its CRS is in this
// set; "london" iff its coord lies inside LONDON_BOX; "provincial"
// otherwise. The CRS-first check for termini means WAE (Waterloo East,
// technically just outside the Waterloo footprint) still counts as a
// terminus even if its coord edges out of a tight London bounding box.
const LONDON_TERMINI_CRS = new Set([
  "CHX", "LST", "MOG", "BFR", "CST", "FST", "LBG", "MYB",
  "PAD", "VIC", "WAT", "WAE", "KGX", "STP", "EUS",
])
// Loose bounding box around Greater London — roughly TfL zones 1–6
// plus a small margin so edge-of-London stations (Dartford, Shenfield,
// Watford Junction, Richmond) still fall inside. Anything outside the
// box is classified as provincial.
const LONDON_BOX = { minLng: -0.55, maxLng: 0.35, minLat: 51.28, maxLat: 51.72 }
type StationCategory = "termini" | "london" | "provincial"
function categoriseCoord(coord: string | undefined): StationCategory | null {
  if (!coord || coord.startsWith("__")) return null
  const [lngStr, latStr] = coord.split(",")
  const lng = parseFloat(lngStr), lat = parseFloat(latStr)
  if (!Number.isFinite(lng) || !Number.isFinite(lat)) return null
  return lng >= LONDON_BOX.minLng && lng <= LONDON_BOX.maxLng &&
         lat >= LONDON_BOX.minLat && lat <= LONDON_BOX.maxLat
    ? "london" : "provincial"
}

export function RTTStatusPanel({ open, onOpenChange }: {
  open: boolean
  onOpenChange: (open: boolean) => void
}) {
  const [data, setData] = useState<StatusPayload | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [lastFetchAt, setLastFetchAt] = useState<Date | null>(null)
  // Category filter — shows either "all", just London termini, just
  // London non-termini, or just provincial. Not persisted; each modal
  // open starts with "all" so the admin sees the complete pipeline.
  const [categoryFilter, setCategoryFilter] = useState<"all" | StationCategory>("all")
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

        {/* Category filter pills. Four options; clicking an active pill
            is a no-op (rather than clearing) because "all" is already
            the explicit clear option. Pill style mirrors the compact
            monospace aesthetic the rest of the panel uses. */}
        <div className="flex items-center gap-1.5 text-xs font-mono">
          {([
            { key: "all", label: "All" },
            { key: "termini", label: "London termini" },
            { key: "london", label: "London, other" },
            { key: "provincial", label: "Provincial" },
          ] as const).map((opt) => (
            <button
              key={opt.key}
              onClick={() => setCategoryFilter(opt.key)}
              className={`rounded px-2 py-1 transition-colors ${
                categoryFilter === opt.key
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
          // Classify a row into termini / london / provincial. Termini
          // wins purely on CRS (matches LONDON_TERMINI_CRS), since a
          // few termini coords sit on the edge of the bounding box.
          // Otherwise parses the coord: real rows carry a "lng,lat"
          // string; synthetic rows carry "__queued:X" / "__missing:X"
          // and fall back to the API-provided scrapedCoords map.
          const rowCategory = (p: StationSummary): StationCategory | null => {
            if (LONDON_TERMINI_CRS.has(p.crs)) return "termini"
            const coord = p.coord.startsWith("__")
              ? (data.scrapedCoords?.[p.crs] ?? "")
              : p.coord
            return categoriseCoord(coord)
          }
          const rows = [...data.stations, ...synthesisedMissing]
            .filter((p) => {
              if (categoryFilter === "all") return true
              return rowCategory(p) === categoryFilter
            })
            .sort((a, b) => {
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
                  // Synthetic-queued rows come from orchestrator-script
                  // scraping — they aren't in TARGET_STATIONS (which
                  // pre-dates the batched hub additions), but visually
                  // they ARE tracked: we WILL fetch them. Carry the
                  // ⚠️/amber treatment through by detecting the coord
                  // prefix. Without this, every batch-2-through-6 hub
                  // rendered as a neutral "·" while the original 28
                  // tracked stations kept their colour + icon.
                  const isSyntheticQueued = p.coord.startsWith("__queued:")
                  let rowClass = ""
                  let badge = ""
                  if (INTENTIONALLY_STALE_STATIONS.has(p.crs)) {
                    // Deliberately frozen — Google Routes data covers
                    // these primaries well enough that re-fetching is a
                    // waste of RTT budget.
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
