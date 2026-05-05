"use client"

// Walks-manager table — admin view of every walk that has a Komoot
// route attached. Each row links out to:
//   - the start / end station overlay (via the public map at
//     `/?station=<crs>`)
//   - the Komoot tour page (external)
//   - a standalone /walks-manager/[walkId] editor (clicking the row
//     anywhere except the three explicit links)
//
// Default sort: updatedAt desc (most recently modified first). Walks
// that have never been touched (no create/edit timestamp) fall to the
// bottom. Clicking any column header cycles desc → asc → off (back
// to default).
//
// Search: typing in the box above the table filters rows. Token rules:
//   GOM-DKT     → start=GOM AND end=DKT (directional, cluster-expandable)
//   GOM         → start OR end matches GOM (cluster-expandable). Multiple
//                 bare codes AND together (GOM DKT = GOM + DKT touching the walk).
//   anything else → fuzzy substring on id, name, komoot URL (AND with stations).
//
// Per-column filters: each header has a filter icon-button on hover;
// clicking opens a column-specific popover.

import { useEffect, useMemo, useRef, useState } from "react"
import type { WalkPayload } from "@/components/walks-admin-panel"
import { formatOrgTag, orgShorthand } from "@/lib/org-shorthand"
import { ALL_CLUSTERS } from "@/lib/clusters"
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from "@/components/ui/dialog"

// ─── Helpers ────────────────────────────────────────────────────────

function formatTimestamp(iso: string | null | undefined): string {
  if (!iso) return "—"
  const d = new Date(iso)
  if (!Number.isFinite(d.getTime())) return "—"
  const pad = (n: number) => String(n).padStart(2, "0")
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
}

// Compact relative time: "just now", "5m ago", "3h ago", "2d ago",
// "3w ago", "4mo ago", "2y ago". Used by the Modified column so the
// admin can scan recency at a glance without parsing absolute
// timestamps. The exact-time tooltip is rendered alongside via the
// title attribute on the cell so the precise value stays available
// on hover.
function formatRelativeTime(iso: string | null | undefined): string {
  if (!iso) return "—"
  const t = Date.parse(iso)
  if (!Number.isFinite(t)) return "—"
  // Diff in seconds. Negative diffs (future timestamps from clock
  // skew) collapse to "just now" so we don't render "−3s ago".
  const diffSec = Math.max(0, Math.round((Date.now() - t) / 1000))
  if (diffSec < 60) return "just now"
  const diffMin = Math.round(diffSec / 60)
  if (diffMin < 60) return `${diffMin}m ago`
  const diffHr = Math.round(diffMin / 60)
  if (diffHr < 24) return `${diffHr}h ago`
  const diffDay = Math.round(diffHr / 24)
  if (diffDay < 7) return `${diffDay}d ago`
  if (diffDay < 30) return `${Math.round(diffDay / 7)}w ago`
  if (diffDay < 365) return `${Math.round(diffDay / 30)}mo ago`
  return `${Math.round(diffDay / 365)}y ago`
}

function latestDate(dates: string[] | undefined): string | null {
  if (!Array.isArray(dates) || dates.length === 0) return null
  return [...dates].sort().at(-1) ?? null
}

function walkTitle(w: WalkPayload): string {
  if (w.name?.trim()) return w.name.trim()
  if (w.startStationName && w.endStationName) {
    const base =
      w.startStation === w.endStation
        ? `${w.startStationName} Circular`
        : `${w.startStationName} to ${w.endStationName}`
    return w.suffix?.trim() ? `${base} ${w.suffix.trim()}` : base
  }
  return w.pageTitle
}

function locationCount(w: WalkPayload): number {
  return (w.sights?.length ?? 0) + (w.lunchStops?.length ?? 0) + (w.destinationStops?.length ?? 0)
}

// Resolve a typed code to the set of CRS station codes it represents.
// Handles three cases:
//   1. Cluster anchor ID (e.g. "CDOR") → its members CRS list
//   2. Real CRS code (e.g. "GOM") → singleton set
//   3. Anything else → null (token isn't a station-like code)
// Search pass uses this to decide which tokens are station filters
// vs free-text fuzzy matches. Cluster matching is case-insensitive on
// the typed input but data IDs are upper-case in clusters-data.json /
// CRS lists, so we uppercase the input first.
function expandStationToken(token: string): Set<string> | null {
  const up = token.trim().toUpperCase()
  if (!up) return null
  // Cluster anchor? Members are typically real CRS codes; expand them.
  const cluster = ALL_CLUSTERS[up]
  if (cluster) {
    // Cluster members may themselves be cluster IDs in some setups —
    // we just take them as listed; the CRS values on walks are real
    // codes so the membership test still works.
    return new Set(cluster.members.map((m) => m.toUpperCase()))
  }
  // Otherwise treat as a bare station code. We don't validate against
  // a master station list here — if no walk's start/end matches, the
  // filter just returns 0 rows, which is acceptable.
  return new Set([up])
}

// ─── Search bar ────────────────────────────────────────────────────

// Search input with a clear-button affordance + station-name
// autocomplete. Max-width is 500 px so the search reads as a control,
// not a page-wide bar.
//
// Autocomplete: once the user has typed 3+ chars we fetch a lightweight
// {crs,name}[] list from /stations.json and surface every station whose
// name OR CRS contains the query (substring, case-insensitive). Each
// suggestion renders as "Name (CRS)"; clicking one replaces the
// search with the bare CRS — that's what the rest of the search
// pipeline matches against (cluster expansion + station-token rules
// in `applySearch`).
function SearchBar({
  value,
  onChange,
}: {
  value: string
  onChange: (next: string) => void
}) {
  const [stations, setStations] = useState<{ crs: string; name: string }[] | null>(null)
  const [focused, setFocused] = useState(false)
  const wrapperRef = useRef<HTMLDivElement | null>(null)

  // Lazy-fetch the station list once on mount. /stations.json is the
  // public GeoJSON the map already uses; we only need name + ref:crs
  // from each feature, so we strip everything else immediately to
  // keep memory in check.
  useEffect(() => {
    let cancelled = false
    fetch("/stations.json")
      .then((r) => r.json())
      .then((d: { features: Array<{ properties?: Record<string, unknown> }> }) => {
        if (cancelled) return
        const list: { crs: string; name: string }[] = []
        for (const f of d.features) {
          const crs = f.properties?.["ref:crs"] as string | undefined
          const name = f.properties?.name as string | undefined
          if (crs && name) list.push({ crs, name })
        }
        list.sort((a, b) => a.name.localeCompare(b.name))
        setStations(list)
      })
      .catch(() => { /* best-effort; suggestions stay disabled if fetch fails */ })
    return () => { cancelled = true }
  }, [])

  // Compute suggestions: ≥3 chars, substring match against name or
  // CRS, capped to 8 rows so the dropdown never explodes. Skipped
  // entirely when the search already exactly matches a station code
  // (the user committed a CRS — no point still suggesting).
  const suggestions = useMemo(() => {
    const q = value.trim()
    if (q.length < 3 || !stations) return []
    const upper = q.toUpperCase()
    if (stations.some((s) => s.crs === upper)) return []
    const lower = q.toLowerCase()
    const out: { crs: string; name: string }[] = []
    for (const s of stations) {
      if (s.name.toLowerCase().includes(lower) || s.crs.toLowerCase().includes(lower)) {
        out.push(s)
        if (out.length >= 8) break
      }
    }
    return out
  }, [value, stations])

  // Close the dropdown on outside-click. Necessary because we keep it
  // open while the input is focused; clicking another part of the
  // page should dismiss it without forcing the user to also defocus.
  useEffect(() => {
    if (!focused) return
    const onDown = (e: MouseEvent) => {
      const el = wrapperRef.current
      if (el && e.target instanceof Node && !el.contains(e.target)) {
        setFocused(false)
      }
    }
    window.addEventListener("mousedown", onDown)
    return () => window.removeEventListener("mousedown", onDown)
  }, [focused])

  const showSuggestions = focused && suggestions.length > 0

  return (
    <div ref={wrapperRef} className="relative mb-3 max-w-[500px]">
      <input
        type="text"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        onFocus={() => setFocused(true)}
        placeholder="Search by id, station (GOM), pair (GOM-DKT), name, or komoot URL"
        // Right padding leaves room for the absolutely-positioned
        // clear button so typed text never slides under it.
        className="w-full rounded border border-border bg-background px-3 py-1.5 pr-8 text-xs"
      />
      {value && (
        <button
          type="button"
          onClick={() => onChange("")}
          aria-label="Clear search"
          // Centred vertically inside the input via top-1/2 +
          // -translate-y-1/2; right-1.5 anchors against the input's
          // right padding. Lower z-stack than the dropdown so it
          // disappears beneath it if they ever overlap (they don't,
          // but defensive).
          className="absolute right-1.5 top-1/2 flex h-5 w-5 -translate-y-1/2 items-center justify-center rounded text-muted-foreground hover:bg-muted hover:text-foreground"
        >
          <svg viewBox="0 0 16 16" className="h-3 w-3 fill-current" aria-hidden>
            <path d="M3.22 3.22a.75.75 0 011.06 0L8 6.94l3.72-3.72a.75.75 0 111.06 1.06L9.06 8l3.72 3.72a.75.75 0 11-1.06 1.06L8 9.06l-3.72 3.72a.75.75 0 01-1.06-1.06L6.94 8 3.22 4.28a.75.75 0 010-1.06z" />
          </svg>
        </button>
      )}
      {showSuggestions && (
        <ul
          // Absolute popover below the input. z-30 stays above the
          // table headers (z-20 in the filter popovers) so suggestions
          // never get clipped behind row content.
          className="absolute left-0 right-0 z-30 mt-1 max-h-60 overflow-y-auto rounded border border-border bg-background py-1 text-xs shadow-md"
        >
          {suggestions.map((s) => (
            <li key={s.crs}>
              <button
                type="button"
                // onMouseDown beats the input's blur, so the click
                // commits before focus moves away and the dropdown
                // collapses out from under us.
                onMouseDown={(e) => {
                  e.preventDefault()
                  onChange(s.crs)
                  setFocused(false)
                }}
                className="flex w-full items-center justify-between gap-2 px-3 py-1.5 text-left hover:bg-muted/60"
              >
                <span className="truncate">{s.name}</span>
                <span className="font-mono text-[10px] text-muted-foreground">{s.crs}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}

// ─── Column config ──────────────────────────────────────────────────

type SortDir = "desc" | "asc" | null
type ColumnKey =
  | "id"
  | "start"
  | "end"
  | "name"
  | "orgs"
  | "rating"
  | "locations"
  | "lastHiked"
  | "komoot"
  | "lastPull"
  | "modified"

// Sort + filter values are pulled from a walk via these accessors. The
// sort accessor returns a primitive comparable; the filter accessor
// returns whatever the column-specific filter UI expects to test
// against (string for text fields, number for rating/locations, …).
type Column = {
  key: ColumnKey
  label: string
  // Optional title attribute for the header (hover tooltip).
  title?: string
  // Sort accessor — must return number or string for stable Array.sort.
  // Missing values should sort to the end on desc; we coerce nulls to
  // sentinel values inside the sort comparator below.
  sortValue: (w: WalkPayload) => number | string | null
  render: (w: WalkPayload) => React.ReactNode
  // Filter spec — describes the popover UI for this column. Optional;
  // columns without a filter spec just render the bare label.
  filter?: ColumnFilter
}

type ColumnFilter =
  | { kind: "text"; placeholder?: string }
  | { kind: "number-range" }
  | { kind: "rating" } // 1..4 multi-select
  | { kind: "has-value"; trueLabel: string; falseLabel: string } // present / absent

// One walk's filter pass-through value per column. `null` means the
// column can't filter against this row (e.g. station code with no
// startStation set) and the filter treats it as "doesn't match" when
// active.
function filterValue(w: WalkPayload, key: ColumnKey): string | number | null {
  switch (key) {
    case "id": return w.id
    case "start": return w.startStation
    case "end": return w.endStation
    case "name": return walkTitle(w).toLowerCase()
    case "orgs":
      // Compose all org tags into a single haystack so a substring
      // text-filter against "swc" or "to1:23" matches the row.
      return (w.orgs ?? []).map(formatOrgTag).join(" ").toLowerCase()
    case "rating": return w.rating ?? null
    case "locations": return locationCount(w)
    case "lastHiked": return latestDate(w.previousWalkDates) ?? null
    case "komoot": return w.komootUrl?.toLowerCase() ?? ""
    case "lastPull": return w.lastPullAt ?? null
    case "modified": return w.updatedAt ?? null
  }
}

// ─── Page ───────────────────────────────────────────────────────────

export default function WalksManagerPage() {
  const [walks, setWalks] = useState<WalkPayload[] | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    setError(null)
    fetch("/api/dev/walks-list")
      .then((r) => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`)
        return r.json() as Promise<WalkPayload[]>
      })
      .then((data) => { if (!cancelled) setWalks(data) })
      .catch((e: Error) => { if (!cancelled) setError(e.message) })
      .finally(() => { if (!cancelled) setLoading(false) })
    return () => { cancelled = true }
  }, [])

  // Sort state — `null` direction means "use default" (lastPull desc).
  const [sortKey, setSortKey] = useState<ColumnKey | null>(null)
  const [sortDir, setSortDir] = useState<SortDir>(null)

  // Search input. Persisted in component state only — not in URL for
  // v1; can be lifted to a query string later if the admin asks.
  const [search, setSearch] = useState("")

  // Per-column filter values, keyed by column key. Each filter UI
  // pushes/clears its own entry. `undefined` for a key = no filter.
  // Default filter: "Has Komoot" on. Komoot-routed walks are the
  // primary curation target for this manager; the admin can clear or
  // flip the filter via the Komoot column's funnel popover when they
  // want to see the others.
  const [filters, setFilters] = useState<Record<string, FilterState>>({
    komoot: { kind: "has-value", want: "yes" },
  })

  // All walks (Komoot-routed and not). The Komoot column renders an
  // em-dash for walks without a URL; admins can use the Komoot column
  // filter ("has-value: yes") to scope the view back down to Komoot-
  // routed walks when they want.
  const allWalks = useMemo(() => walks ?? [], [walks])

  // Apply search tokens. See the file-level comment for the rules.
  const searched = useMemo(() => applySearch(allWalks, search), [allWalks, search])

  // Apply column filters on top of the search-filtered list.
  const filtered = useMemo(() => applyFilters(searched, filters), [searched, filters])

  // Sorted final list — uses the active sort col/dir or the default.
  const rows = useMemo(() => sortRows(filtered, sortKey, sortDir), [filtered, sortKey, sortDir])

  // Click a column header to cycle: default → desc → asc → default.
  // Every column starts at DESC on first click so the cycle is
  // predictable regardless of which column was tapped — no per-column
  // "natural direction" exception. Three clicks always return you to
  // the table default (lastPull desc, never-pulled at the bottom).
  //
  // Both setters are called in the same event tick so React batches
  // them into a single render — no nested state updaters, no follow-up
  // useEffect needed to reconcile a half-step.
  const onHeaderClick = (key: ColumnKey) => {
    if (sortKey !== key) {
      // Switching columns — jump straight to that column's first step.
      setSortKey(key)
      setSortDir("desc")
      return
    }
    // Same column — advance the cycle.
    if (sortDir === "desc") {
      setSortDir("asc")
    } else if (sortDir === "asc") {
      setSortKey(null)
      setSortDir(null)
    } else {
      // Edge case: same key but dir is null (shouldn't happen via the
      // UI since we always clear key when dir is null, but guard for
      // hypothetical external state mutations).
      setSortDir("desc")
    }
  }

  return (
    // The global body has `overflow: hidden` (set so the full-screen
    // map page doesn't scroll). On the walks-manager route we DO want
    // a scrollable page, so we own the viewport with h-screen and
    // overflow-y-auto on this wrapper. Inner padding lives on a child
    // so the scrollbar still hugs the right edge.
    <div className="h-screen overflow-y-auto">
      <main className="mx-auto max-w-screen-2xl p-6">
        <header className="mb-4 flex items-center justify-between gap-4">
        <h1 className="text-lg font-semibold">Walks manager</h1>
        <MissingWalksButton />
      </header>

      <SearchBar value={search} onChange={setSearch} />

      {loading && <p className="text-sm italic text-muted-foreground">Loading…</p>}
      {error && <p className="text-sm text-destructive">Failed to load: {error}</p>}

      {walks && (
        <p className="mb-3 text-xs text-muted-foreground">
          {rows.length} of {allWalks.length} walk{allWalks.length === 1 ? "" : "s"}{" "}
          {(search || Object.keys(filters).length > 0) && "matching"}
        </p>
      )}

      {walks && (
        <WalksTable
          rows={rows}
          sortKey={sortKey}
          sortDir={sortDir}
          onHeaderClick={onHeaderClick}
          filters={filters}
          setFilters={setFilters}
        />
      )}
      </main>
    </div>
  )
}

// ─── Search + filter logic ─────────────────────────────────────────

// Runs the search input against the walks list. See file-level comment
// for the token rules. Empty input returns the input list unchanged.
function applySearch(list: WalkPayload[], query: string): WalkPayload[] {
  const trimmed = query.trim()
  if (!trimmed) return list

  // Tokenise on whitespace. Each token gets classified as one of:
  //   - directional pair (`AAA-BBB`) — matches start=AAA AND end=BBB
  //   - bare station/cluster — matches walk's start OR end
  //   - free text — substring match on id / name / komoot URL
  const tokens = trimmed.split(/\s+/)
  const directional: Array<{ start: Set<string>; end: Set<string> }> = []
  const bareStations: Array<Set<string>> = []
  const freeText: string[] = []
  for (const raw of tokens) {
    // Directional pair: hyphen with non-empty halves on both sides.
    const dash = raw.match(/^([A-Za-z0-9]+)-([A-Za-z0-9]+)$/)
    if (dash) {
      const s = expandStationToken(dash[1])
      const e = expandStationToken(dash[2])
      if (s && e) {
        directional.push({ start: s, end: e })
        continue
      }
    }
    // Bare station-ish: 3-letter all-alpha (CRS) or known cluster ID.
    // We restrict bare-station classification to alpha tokens only —
    // anything with digits or punctuation falls through to free text
    // so 4-char walk IDs ("ml6i") don't get misread as stations.
    if (/^[A-Za-z]{3,4}$/.test(raw)) {
      const expanded = expandStationToken(raw)
      if (expanded) {
        bareStations.push(expanded)
        continue
      }
    }
    freeText.push(raw.toLowerCase())
  }

  return list.filter((w) => {
    const startUp = w.startStation?.toUpperCase() ?? null
    const endUp = w.endStation?.toUpperCase() ?? null

    // Directional: start ∈ AAA AND end ∈ BBB. All directional
    // constraints must be satisfied (rare to have multiple; AND keeps
    // the rule predictable).
    for (const { start, end } of directional) {
      const ok = startUp && endUp && start.has(startUp) && end.has(endUp)
      if (!ok) return false
    }

    // Bare stations: each bare token's expanded set must contain at
    // least one of the walk's two endpoints.
    for (const set of bareStations) {
      const matchesStart = startUp ? set.has(startUp) : false
      const matchesEnd = endUp ? set.has(endUp) : false
      if (!matchesStart && !matchesEnd) return false
    }

    // Free text: each free-text token must hit id, name, or komoot URL.
    if (freeText.length > 0) {
      const haystack = [
        w.id.toLowerCase(),
        walkTitle(w).toLowerCase(),
        (w.komootUrl ?? "").toLowerCase(),
      ].join(" ")
      for (const ft of freeText) {
        if (!haystack.includes(ft)) return false
      }
    }

    return true
  })
}

// Per-column filter shape. Each filter UI writes one of these into the
// page-level filters map; applyFilters reads it back. `kind` doubles
// as a discriminator so the predicate can switch on its variant.
type FilterState =
  | { kind: "text"; value: string }
  | { kind: "number-range"; min: number | null; max: number | null }
  | { kind: "rating"; selected: number[] } // 1..4
  | { kind: "has-value"; want: "yes" | "no" }

function applyFilters(list: WalkPayload[], filters: Record<string, FilterState>): WalkPayload[] {
  const entries = Object.entries(filters)
  if (entries.length === 0) return list
  return list.filter((w) => {
    for (const [keyStr, f] of entries) {
      const key = keyStr as ColumnKey
      const v = filterValue(w, key)
      if (!matchesFilter(f, v)) return false
    }
    return true
  })
}

function matchesFilter(f: FilterState, v: string | number | null): boolean {
  switch (f.kind) {
    case "text": {
      if (!f.value.trim()) return true
      if (v == null) return false
      return String(v).toLowerCase().includes(f.value.toLowerCase())
    }
    case "number-range": {
      if (typeof v !== "number") return false
      if (f.min != null && v < f.min) return false
      if (f.max != null && v > f.max) return false
      return true
    }
    case "rating": {
      if (f.selected.length === 0) return true
      if (typeof v !== "number") return false
      return f.selected.includes(v)
    }
    case "has-value": {
      const present = v != null && v !== ""
      return f.want === "yes" ? present : !present
    }
  }
}

// Sort by active key/dir, falling back to lastPull desc (the default).
function sortRows(list: WalkPayload[], key: ColumnKey | null, dir: SortDir): WalkPayload[] {
  const out = [...list]
  if (key == null || dir == null) {
    // Default: updatedAt desc, nulls last. Walks the admin has been
    // working on most recently float to the top regardless of which
    // sub-action (creation, save, pull) drove the timestamp update.
    out.sort((a, b) => {
      const aT = a.updatedAt ? Date.parse(a.updatedAt) : Number.NEGATIVE_INFINITY
      const bT = b.updatedAt ? Date.parse(b.updatedAt) : Number.NEGATIVE_INFINITY
      return bT - aT
    })
    return out
  }
  const col = COLUMNS.find((c) => c.key === key)
  if (!col) return out
  const cmp = (a: WalkPayload, b: WalkPayload) => {
    const av = col.sortValue(a)
    const bv = col.sortValue(b)
    // Nulls always sink to the bottom regardless of direction — feels
    // natural in a list ("missing" at the end either way).
    if (av == null && bv == null) return 0
    if (av == null) return 1
    if (bv == null) return -1
    if (typeof av === "number" && typeof bv === "number") return av - bv
    return String(av).localeCompare(String(bv))
  }
  out.sort((a, b) => (dir === "desc" ? -cmp(a, b) : cmp(a, b)))
  return out
}

// ─── Column registry ───────────────────────────────────────────────

const COLUMNS: Column[] = [
  {
    key: "id",
    label: "ID",
    sortValue: (w) => w.id,
    render: (w) => <span className="font-mono">{w.id}</span>,
    filter: { kind: "text", placeholder: "id contains…" },
  },
  {
    key: "start",
    label: "Start",
    sortValue: (w) => w.startStation,
    render: (w) => <StationLink crs={w.startStation} />,
    filter: { kind: "text", placeholder: "CRS or cluster…" },
  },
  {
    key: "end",
    label: "End",
    sortValue: (w) => w.endStation,
    render: (w) => <StationLink crs={w.endStation} />,
    filter: { kind: "text", placeholder: "CRS or cluster…" },
  },
  {
    key: "name",
    label: "Name",
    sortValue: (w) => walkTitle(w).toLowerCase(),
    render: (w) => walkTitle(w),
    filter: { kind: "text", placeholder: "name contains…" },
  },
  {
    key: "orgs",
    label: "Orgs",
    // Sort by the first org's shorthand (alphabetic); walks with no
    // orgs fall to the bottom via the null sentinel.
    sortValue: (w) => (w.orgs?.[0] ? orgShorthand(w.orgs[0].orgSlug) : null),
    render: (w) => <OrgsTags orgs={w.orgs} />,
    filter: { kind: "text", placeholder: "tag contains…" },
  },
  {
    key: "rating",
    label: "Rating",
    sortValue: (w) => w.rating ?? null,
    render: (w) => (w.rating == null ? <span className="text-muted-foreground">—</span> : w.rating),
    filter: { kind: "rating" },
  },
  {
    key: "locations",
    label: "Locs",
    title: "Sights + lunch stops + destination spots",
    sortValue: (w) => locationCount(w),
    render: (w) => <span className="tabular-nums">{locationCount(w)}</span>,
    filter: { kind: "number-range" },
  },
  {
    key: "lastHiked",
    label: "Last hiked",
    sortValue: (w) => latestDate(w.previousWalkDates),
    render: (w) => {
      const d = latestDate(w.previousWalkDates)
      return <span className="tabular-nums">{d ?? <span className="text-muted-foreground">—</span>}</span>
    },
    filter: { kind: "has-value", trueLabel: "Hiked", falseLabel: "Never hiked" },
  },
  {
    key: "komoot",
    label: "Komoot",
    sortValue: (w) => w.komootUrl?.toLowerCase() ?? null,
    render: (w) => <KomootLink url={w.komootUrl} />,
    // has-value rather than text — the page-level search bar already
    // covers URL substring matching, so the column filter is most
    // useful as a quick "Komoot-routed only" / "no Komoot only" toggle.
    filter: { kind: "has-value", trueLabel: "Has Komoot", falseLabel: "No Komoot" },
  },
  {
    key: "lastPull",
    label: "Last pull",
    sortValue: (w) => w.lastPullAt ?? null,
    render: (w) => <span className="tabular-nums">{formatTimestamp(w.lastPullAt)}</span>,
    filter: { kind: "has-value", trueLabel: "Pulled", falseLabel: "Never pulled" },
  },
  {
    key: "modified",
    label: "Modified",
    title: "Last edit timestamp (creation counts as the first edit)",
    sortValue: (w) => w.updatedAt ?? null,
    // Render relative ("3h ago") with the full ISO timestamp on
    // hover via title — the exact value stays accessible without
    // dominating the cell.
    render: (w) => (
      <span title={w.updatedAt ?? undefined} className="tabular-nums">
        {formatRelativeTime(w.updatedAt)}
      </span>
    ),
    filter: { kind: "has-value", trueLabel: "Has been edited", falseLabel: "Never edited" },
  },
]

// ─── Table ─────────────────────────────────────────────────────────

function WalksTable({
  rows,
  sortKey,
  sortDir,
  onHeaderClick,
  filters,
  setFilters,
}: {
  rows: WalkPayload[]
  sortKey: ColumnKey | null
  sortDir: SortDir
  onHeaderClick: (key: ColumnKey) => void
  filters: Record<string, FilterState>
  setFilters: (next: Record<string, FilterState> | ((p: Record<string, FilterState>) => Record<string, FilterState>)) => void
}) {
  return (
    <div className="overflow-x-auto rounded border border-border">
      <table className="w-full border-collapse text-xs">
        <thead className="bg-muted/40 text-left text-[11px] uppercase tracking-wide text-muted-foreground">
          <tr>
            {COLUMNS.map((col, i) => (
              <Th
                key={col.key}
                column={col}
                sortKey={sortKey}
                sortDir={sortDir}
                onHeaderClick={onHeaderClick}
                filter={filters[col.key]}
                // Anchor the filter popover to the right edge of the
                // button only for the rightmost few columns, otherwise
                // it clips off the page when those columns sit far
                // from the right edge. For leftmost / middle columns
                // we anchor left so the popover extends into the
                // table area instead of falling off-screen.
                popoverAlign={i >= COLUMNS.length - 2 ? "right" : "left"}
                setFilter={(next) =>
                  setFilters((prev) => {
                    const out = { ...prev }
                    if (next == null) delete out[col.key]
                    else out[col.key] = next
                    return out
                  })
                }
              />
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((w) => (
            <WalkRow key={w.id} walk={w} />
          ))}
        </tbody>
      </table>
    </div>
  )
}

// Header cell — hosts the click-to-sort target, sort indicator, and
// the hover-revealed filter icon-button. The filter icon opens the
// per-column popover; outside-clicks close it.
function Th({
  column,
  sortKey,
  sortDir,
  onHeaderClick,
  filter,
  setFilter,
  popoverAlign,
}: {
  column: Column
  sortKey: ColumnKey | null
  sortDir: SortDir
  onHeaderClick: (key: ColumnKey) => void
  filter: FilterState | undefined
  setFilter: (next: FilterState | null) => void
  popoverAlign: "left" | "right"
}) {
  const active = sortKey === column.key && sortDir != null
  const arrow = active ? (sortDir === "desc" ? "↓" : "↑") : null
  const hasFilter = filter != null
  return (
    <th title={column.title} className="group relative border-b border-border px-2 py-1.5 font-medium">
      <div className="flex items-center gap-1">
        <button
          type="button"
          onClick={() => onHeaderClick(column.key)}
          className="flex flex-1 items-center gap-1 text-left uppercase tracking-wide hover:text-foreground"
        >
          <span>{column.label}</span>
          {arrow && <span className="text-foreground">{arrow}</span>}
        </button>
        {column.filter && (
          <FilterButton
            spec={column.filter}
            value={filter}
            onChange={setFilter}
            // Active filter stays visible; inactive icon only shows on
            // header hover so the row stays clean by default.
            visible={hasFilter}
            align={popoverAlign}
          />
        )}
      </div>
    </th>
  )
}

function WalkRow({ walk }: { walk: WalkPayload }) {
  const onRowClick = () => {
    window.open(`/walks-manager/${encodeURIComponent(walk.id)}`, "_blank", "noopener")
  }
  return (
    <tr
      onClick={onRowClick}
      className="cursor-pointer border-b border-border/60 hover:bg-muted/30"
    >
      {COLUMNS.map((col) => (
        <td key={col.key} className="align-top px-2 py-1.5">
          {col.render(walk)}
        </td>
      ))}
    </tr>
  )
}

// ─── Cell helpers ──────────────────────────────────────────────────

function StationLink({ crs }: { crs: string | null }) {
  if (!crs) return <span className="text-muted-foreground">—</span>
  return (
    <a
      href={`/?station=${encodeURIComponent(crs)}`}
      target="_blank"
      rel="noopener"
      onClick={(e) => e.stopPropagation()}
      className="font-mono text-foreground underline-offset-2 hover:underline"
    >
      {crs}
    </a>
  )
}

function KomootLink({ url }: { url: string }) {
  if (!url?.trim()) return <span className="text-muted-foreground">—</span>
  // Pull the numeric tour id out of the URL — that's the only stable
  // human-meaningful piece of a Komoot tour link, and it's what the
  // missing-walks scraper compares against. Falls back to the host-
  // less URL if the URL doesn't match the expected /tour/N shape
  // (defensive — keeps a stored non-tour link visible even if it
  // can't be reduced to an id).
  const tourId = /\/tour\/(\d+)/.exec(url)?.[1]
  const display = tourId ?? url.replace(/^https?:\/\/(www\.)?/, "")
  return (
    <a
      href={url}
      target="_blank"
      rel="noopener"
      onClick={(e) => e.stopPropagation()}
      title={url}
      className="block font-mono text-foreground underline-offset-2 hover:underline"
    >
      {display}
    </a>
  )
}

function OrgsTags({ orgs }: { orgs: WalkPayload["orgs"] }) {
  if (!Array.isArray(orgs) || orgs.length === 0) {
    return <span className="text-muted-foreground">—</span>
  }
  return (
    <div className="flex flex-wrap gap-1">
      {orgs.map((o, i) => (
        <span
          key={`${o.orgSlug}-${i}`}
          className="rounded border border-border bg-muted/40 px-1.5 py-[1px] font-mono text-[10px] text-foreground"
        >
          {formatOrgTag(o)}
        </span>
      ))}
    </div>
  )
}

// ─── Per-column filter popover ─────────────────────────────────────

function FilterButton({
  spec,
  value,
  onChange,
  visible,
  align,
}: {
  spec: ColumnFilter
  value: FilterState | undefined
  onChange: (next: FilterState | null) => void
  visible: boolean
  // Which edge of the funnel button to anchor the popover to. "left"
  // makes the popover extend rightward (good for left/middle columns
  // — keeps it on-screen). "right" makes it extend leftward (only
  // safe for the rightmost columns, where left-extending would clip
  // outside the table).
  align: "left" | "right"
}) {
  const [open, setOpen] = useState(false)
  const popoverRef = useRef<HTMLDivElement | null>(null)

  // Close on outside-click. The button itself stops propagation so
  // its own click doesn't immediately re-close the freshly-opened
  // popover.
  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent) => {
      const el = popoverRef.current
      if (el && e.target instanceof Node && !el.contains(e.target)) {
        setOpen(false)
      }
    }
    window.addEventListener("mousedown", onDown)
    return () => window.removeEventListener("mousedown", onDown)
  }, [open])

  return (
    <span ref={popoverRef} className="relative">
      <button
        type="button"
        onClick={(e) => {
          e.stopPropagation()
          setOpen((v) => !v)
        }}
        // Show when active OR on header hover (`group-hover` reads
        // the parent <th> with class `group`). `aria-pressed` exposes
        // the active state for screen readers.
        aria-pressed={value != null}
        className={`rounded p-0.5 text-muted-foreground transition-opacity hover:bg-muted hover:text-foreground ${
          visible ? "opacity-100" : "opacity-0 group-hover:opacity-100"
        } ${value != null ? "text-foreground" : ""}`}
        title={value != null ? "Edit filter" : "Filter this column"}
      >
        {/* Funnel icon — small inline SVG so we don't pull in a new
            icon dep just for one button. */}
        <svg viewBox="0 0 16 16" className="h-3 w-3 fill-current" aria-hidden>
          <path d="M2 3h12l-4.5 6V13l-3 1V9z" />
        </svg>
      </button>
      {open && (
        <div
          // Anchor side comes from the column position (see align prop
          // above). z-20 to clear the row hover state. mt-1 leaves a
          // small gap so the popover doesn't visually merge with the
          // header row.
          className={`absolute top-full z-20 mt-1 w-56 rounded border border-border bg-background p-2 shadow-md ${
            align === "right" ? "right-0" : "left-0"
          }`}
          onClick={(e) => e.stopPropagation()}
        >
          <FilterEditor spec={spec} value={value} onChange={onChange} />
          <div className="mt-2 flex justify-end">
            <button
              type="button"
              onClick={() => {
                onChange(null)
                setOpen(false)
              }}
              className="text-[11px] text-muted-foreground hover:text-foreground"
            >
              Clear
            </button>
          </div>
        </div>
      )}
    </span>
  )
}

// Renders the actual filter input(s) for a given column spec.
// Mutations propagate up via onChange so the page-level filters map
// stays the single source of truth.
function FilterEditor({
  spec,
  value,
  onChange,
}: {
  spec: ColumnFilter
  value: FilterState | undefined
  onChange: (next: FilterState | null) => void
}) {
  if (spec.kind === "text") {
    const cur = value?.kind === "text" ? value.value : ""
    return (
      <input
        type="text"
        autoFocus
        value={cur}
        onChange={(e) =>
          onChange(e.target.value ? { kind: "text", value: e.target.value } : null)
        }
        placeholder={spec.placeholder}
        className="w-full rounded border border-border bg-background px-2 py-1 text-xs"
      />
    )
  }
  if (spec.kind === "number-range") {
    const cur = value?.kind === "number-range" ? value : { kind: "number-range" as const, min: null, max: null }
    const update = (patch: Partial<{ min: number | null; max: number | null }>) => {
      const next = { ...cur, ...patch }
      // Drop the filter entirely when both fields are blank — the
      // map is otherwise polluted with no-op entries.
      if (next.min == null && next.max == null) onChange(null)
      else onChange(next)
    }
    return (
      <div className="flex items-center gap-1">
        <input
          type="number"
          autoFocus
          value={cur.min ?? ""}
          onChange={(e) =>
            update({ min: e.target.value === "" ? null : Number(e.target.value) })
          }
          placeholder="min"
          className="w-full rounded border border-border bg-background px-2 py-1 text-xs"
        />
        <span className="text-muted-foreground">–</span>
        <input
          type="number"
          value={cur.max ?? ""}
          onChange={(e) =>
            update({ max: e.target.value === "" ? null : Number(e.target.value) })
          }
          placeholder="max"
          className="w-full rounded border border-border bg-background px-2 py-1 text-xs"
        />
      </div>
    )
  }
  if (spec.kind === "rating") {
    const cur = value?.kind === "rating" ? value.selected : []
    const toggle = (n: number) => {
      const next = cur.includes(n) ? cur.filter((x) => x !== n) : [...cur, n].sort()
      onChange(next.length === 0 ? null : { kind: "rating", selected: next })
    }
    return (
      <div className="flex flex-wrap gap-1">
        {[1, 2, 3, 4].map((n) => (
          <button
            key={n}
            type="button"
            onClick={() => toggle(n)}
            className={`rounded border px-2 py-0.5 text-[11px] ${
              cur.includes(n)
                ? "border-foreground bg-foreground text-background"
                : "border-border text-foreground hover:bg-muted/40"
            }`}
          >
            {n}
          </button>
        ))}
      </div>
    )
  }
  if (spec.kind === "has-value") {
    const cur = value?.kind === "has-value" ? value.want : null
    return (
      <div className="flex flex-col gap-1">
        {(["yes", "no"] as const).map((want) => (
          <button
            key={want}
            type="button"
            onClick={() => onChange(cur === want ? null : { kind: "has-value", want })}
            className={`rounded border px-2 py-1 text-left text-[11px] ${
              cur === want
                ? "border-foreground bg-foreground text-background"
                : "border-border text-foreground hover:bg-muted/40"
            }`}
          >
            {want === "yes" ? spec.trueLabel : spec.falseLabel}
          </button>
        ))}
      </div>
    )
  }
  return null
}

// ─── Missing-walks button + dialog ─────────────────────────────────

// Hits /api/dev/missing-komoot-walks (which uses Puppeteer to scrape
// the user's public Komoot routes page and diff against walks.json),
// then shows the result in a dialog the admin can copy from.
function MissingWalksButton() {
  const [open, setOpen] = useState(false)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [result, setResult] = useState<{
    missing: string[]
    scrapedCount: number
    knownCount: number
  } | null>(null)

  const run = async () => {
    setOpen(true)
    setLoading(true)
    setError(null)
    setResult(null)
    try {
      // Up to ~50 s scrape time; no client-side timeout — the server
      // route caps it via Puppeteer's own 60s navigation timeout.
      const r = await fetch("/api/dev/missing-komoot-walks")
      const j = await r.json()
      if (!r.ok) throw new Error(j?.error || `HTTP ${r.status}`)
      setResult(j)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setLoading(false)
    }
  }

  return (
    <>
      <button
        type="button"
        onClick={run}
        disabled={loading}
        className="rounded border border-border bg-foreground px-3 py-1 text-xs text-background hover:opacity-90 disabled:opacity-50"
      >
        {loading ? "Scanning…" : "Missing walks"}
      </button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="sm:max-w-2xl">
          <DialogHeader>
            <DialogTitle>Missing walks</DialogTitle>
            <DialogDescription>
              Komoot routes published on your public profile that aren&apos;t yet
              tracked in walks.json.
            </DialogDescription>
          </DialogHeader>
          {loading && (
            <p className="text-sm italic text-muted-foreground">
              Scraping Komoot — lazy-loading the full list, this can take 10–30 seconds…
            </p>
          )}
          {error && <p className="text-sm text-destructive">Failed: {error}</p>}
          {result && !loading && (
            <div className="space-y-3">
              <p className="text-xs text-muted-foreground">
                Scraped {result.scrapedCount} URL{result.scrapedCount === 1 ? "" : "s"} ·
                Known {result.knownCount} ·
                <span className="ml-1 font-medium text-foreground">
                  {result.missing.length} missing
                </span>
              </p>
              {result.missing.length === 0 ? (
                <p className="text-sm text-muted-foreground">
                  Nothing missing — every public Komoot route is already tracked.
                </p>
              ) : (
                // pre-wrapped so the admin can drag-select the whole
                // block and copy in one go. Monospace + small text so
                // the URLs read as data, not prose.
                <textarea
                  readOnly
                  value={result.missing.join("\n")}
                  rows={Math.min(result.missing.length + 1, 16)}
                  className="w-full resize-y rounded border border-border bg-muted/40 p-2 font-mono text-[11px]"
                  // Auto-select on focus so cmd-A → cmd-C is a one-step
                  // copy if the admin prefers keyboard.
                  onFocus={(e) => e.currentTarget.select()}
                />
              )}
            </div>
          )}
        </DialogContent>
      </Dialog>
    </>
  )
}
