"use client"

// Admin dashboard for tracking the walkingclub.org.uk extraction pipeline.
// Renders a table of every walk on the index (seeded via scripts/seed-rambler-walks.mjs)
// with per-walk status columns. Gated behind NODE_ENV === "development" so the
// page (and its data) never ship in production bundles.
//
// Columns:
//   page       — URL slug
//   extracted  — has the per-page extractor run against this walk yet
//   onMap      — has the extracted data been applied to station RamblerNotes
//   issues     — is there an unresolved ambiguity flagged on this walk
//   notes      — free-text note for the admin (e.g. "off mainland Britain")

import { useCallback, useEffect, useMemo, useState } from "react"
import { notFound } from "next/navigation"

// Keep loose — the JSON carries both index-level and extraction-payload keys
// and we only render a subset of them.
type RamblerWalk = {
  slug: string
  title: string
  url: string
  region: string
  favourite: boolean
  extracted: boolean
  onMap: boolean
  issues: boolean
  // Manually set via the admin checkbox. Optional because older entries
  // in the data file predate the field.
  resolved?: boolean
  // Free-text summary of how the issue was resolved. Shown in an inline
  // editable cell on issue rows.
  resolution?: string
  notes: string
  outsideMainlandBritain?: boolean
  // Coordinate-key list of stations whose ramblerNote currently references
  // this walk. Injected by the API (not stored on disk). Empty = walk is
  // not yet surfaced on the map anywhere.
  attachedStations?: string[]
}

// How often the page re-polls /api/dev/rambler-walks. 4s matches the RTT
// panel and is slow enough to be free; the admin isn't editing hundreds of
// walks per minute so faster polling would just waste battery.
const POLL_MS = 4000

// Extract the hostname from a URL safely — bad URLs become "" so they
// fall out of the domain dropdown instead of throwing.
function hostOf(url: string): string {
  try { return new URL(url).hostname } catch { return "" }
}

// Filter pills at the top. The counts render inline so the admin knows at a
// glance how many walks fall into each bucket.
type Bucket = "all" | "todo" | "extracted" | "onMap" | "issues" | "favourites"
const BUCKETS: { key: Bucket; label: string }[] = [
  { key: "all", label: "All" },
  { key: "todo", label: "To extract" },
  { key: "extracted", label: "Extracted" },
  { key: "onMap", label: "On map" },
  { key: "issues", label: "Issues" },
  { key: "favourites", label: "Starred" },
]

export default function RamblerWalksAdminPage() {
  // NODE_ENV is inlined at build time by Next — in a prod build this branch
  // collapses to `notFound()`, stripping the whole client component body
  // from the bundle via dead-code elimination.
  if (process.env.NODE_ENV !== "development") {
    notFound()
  }

  const [data, setData] = useState<Record<string, RamblerWalk> | null>(null)
  const [error, setError] = useState<string | null>(null)
  // Default to the Issues bucket — this page's primary use is
  // triaging unresolved extraction issues, so landing on that view
  // removes a click.
  const [bucket, setBucket] = useState<Bucket>("issues")
  const [search, setSearch] = useState("")
  // Tri-state filter that lives on the "on map" column header. Clicking the
  // header cycles: all → on → off → all. Applies on top of the bucket pill
  // and search — so e.g. bucket="issues" + onMapFilter="off" shows unresolved
  // issues that haven't been plotted yet.
  const [onMapFilter, setOnMapFilter] = useState<"all" | "on" | "off">("all")
  // Domain filter dropdown on the "page" column header. "" = all domains.
  const [domain, setDomain] = useState<string>("")
  // Region/county filter dropdown on the "page" column header. "" = all.
  const [region, setRegion] = useState<string>("")
  // Resolved-column filter. Three independent checkboxes — rows pass if
  // ANY checked category matches them. All three checked (the default)
  // = no filtering effect.
  //   resolved:   r.issues && r.resolved
  //   unresolved: r.issues && !r.resolved
  //   noIssue:    !r.issues
  const [resolvedFilter, setResolvedFilter] = useState({
    resolved: true,
    unresolved: true,
    noIssue: true,
  })
  // Station name → coordKey lookup. Built once from /stations.json and
  // used to turn any station mentions in the notes column into links
  // that deep-link back to the map's overlay via ?station=<coordKey>.
  const [nameToCoord, setNameToCoord] = useState<Map<string, string> | null>(null)
  // coordKey → CRS code, used by the new on-map column to render the
  // station codes of every station where a walk is currently visible.
  const [coordToCrs, setCoordToCrs] = useState<Map<string, string> | null>(null)

  // Clear every active filter back to defaults (keeps `data` + `error`
  // untouched — they are not filters). Triggered by the "Reset filters"
  // button in the top bar.
  const resetFilters = useCallback(() => {
    setBucket("issues")
    setSearch("")
    setOnMapFilter("all")
    setDomain("")
    setRegion("")
    setResolvedFilter({ resolved: true, unresolved: true, noIssue: true })
  }, [])

  // Generic optimistic writer for any subset of walk fields. Writes to
  // local state immediately so the UI responds without waiting for the
  // network, then POSTs the patch. On failure we roll back to the
  // previous values and surface an error — the polling loop will also
  // reconcile on the next tick either way, but the rollback gives instant
  // feedback for genuine write failures (auth, file conflict, etc.).
  const updateWalk = useCallback(
    async (slug: string, patch: Partial<RamblerWalk>) => {
      // Capture prior values outside setData so the rollback closure can
      // see them. Typed as a concrete Record so TS is happy spreading it
      // back in on failure.
      const prevValues: Record<string, unknown> = {}
      let captured = false
      setData((prev) => {
        if (!prev || !prev[slug]) return prev
        // Capture the prior values for the patched keys so we can roll
        // back individual fields without trampling anything else.
        for (const k of Object.keys(patch)) {
          prevValues[k] = (prev[slug] as Record<string, unknown>)[k]
        }
        captured = true
        return { ...prev, [slug]: { ...prev[slug], ...patch } }
      })
      try {
        const res = await fetch("/api/dev/rambler-walks", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ slug, ...patch }),
        })
        if (!res.ok) throw new Error(`status ${res.status}`)
      } catch (e) {
        if (captured) {
          setData((prev) => {
            if (!prev || !prev[slug]) return prev
            return { ...prev, [slug]: { ...prev[slug], ...prevValues } }
          })
        }
        setError(e instanceof Error ? e.message : "failed to save")
      }
    },
    []
  )

  // Poll the endpoint. AbortController lets us cancel an in-flight request
  // when the component unmounts or a new poll tick starts.
  const fetchData = useCallback(async (signal: AbortSignal) => {
    try {
      const res = await fetch("/api/dev/rambler-walks", { signal })
      if (!res.ok) throw new Error(`status ${res.status}`)
      const json = (await res.json()) as Record<string, RamblerWalk>
      setData(json)
      setError(null)
    } catch (e) {
      if ((e as Error).name === "AbortError") return
      setError(e instanceof Error ? e.message : "unknown error")
    }
  }, [])

  useEffect(() => {
    const ctrl = new AbortController()
    void fetchData(ctrl.signal)
    const id = setInterval(() => {
      ctrl.abort() // cancel any still-pending request before starting a fresh one
      void fetchData(new AbortController().signal)
    }, POLL_MS)
    return () => {
      clearInterval(id)
      ctrl.abort()
    }
  }, [fetchData])

  // Load stations.json once and build a name→coordKey map. Static file
  // served from /public; no polling.
  useEffect(() => {
    let cancelled = false
    fetch("/stations.json")
      .then((r) => r.json())
      .then((geo: { features: Array<{ geometry: { coordinates: [number, number] }; properties: { name?: string; "ref:crs"?: string; network?: string } }> }) => {
        if (cancelled) return
        const nameMap = new Map<string, string>()
        const crsMap = new Map<string, string>()
        for (const f of geo.features) {
          const [lng, lat] = f.geometry?.coordinates ?? []
          const name = f.properties?.name
          const crs = f.properties?.["ref:crs"]
          const network = f.properties?.network ?? ""
          if (lng == null || lat == null) continue
          const coord = `${lng},${lat}`
          if (name && !nameMap.has(name)) nameMap.set(name, coord)
          if (crs) {
            crsMap.set(coord, crs)
          } else if (name) {
            // TfL-only stations (Tube/DLR/Overground/Elizabeth) without a CRS —
            // synthesise a short label from the station name initials + a
            // network tag so they still render in the on-map column. e.g.
            // "Wimbledon Park" on London Underground → "WIM-TFL".
            const initials = name
              .replace(/\s*\([^)]*\)\s*/g, " ")
              .split(/\s+/)
              .filter(Boolean)
              .map((w) => w[0])
              .join("")
              .toUpperCase()
              .slice(0, 3)
            const tag = network.includes("Elizabeth") ? "ELZ"
              : network.includes("Docklands") ? "DLR"
              : network.includes("Overground") ? "OVG"
              : network.includes("Underground") ? "TFL"
              : ""
            if (initials && tag) crsMap.set(coord, `${initials}-${tag}`)
          }
        }
        setNameToCoord(nameMap)
        setCoordToCrs(crsMap)
      })
      .catch(() => {
        // Silent fail — links degrade to plain text, which is fine.
      })
    return () => { cancelled = true }
  }, [])

  // Unified regex that matches any station name as a whole word, case-
  // sensitive. Case-sensitive matching avoids false positives like
  // "Hope" (a Derbyshire station) firing on the verb "hope". Built
  // once per nameToCoord change and shared across every row's render.
  const stationNameRegex = useMemo(() => {
    if (!nameToCoord) return null
    // Longest names first so "Maidstone West" matches before bare "Maidstone".
    const names = [...nameToCoord.keys()].sort((a, b) => b.length - a.length)
    const escaped = names.map((n) => n.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
    return new RegExp(`\\b(?:${escaped.join("|")})\\b`, "g")
  }, [nameToCoord])

  // Split a notes string into text + <a> segments. Matched station names
  // become links that open the station overlay on the main map via the
  // ?station=<coordKey> URL param (handler lives in components/map.tsx).
  // Returns a flat list of React children suitable for {...} interpolation.
  const renderNotes = useCallback(
    (text: string): React.ReactNode[] => {
      if (!text) return []
      if (!stationNameRegex || !nameToCoord) return [text]
      const parts: React.ReactNode[] = []
      let lastIdx = 0
      // Reset `lastIndex` — the regex is stored with the `g` flag, and
      // `exec()` stateful across calls would otherwise miss matches on
      // the 2nd+ row's render.
      stationNameRegex.lastIndex = 0
      let match: RegExpExecArray | null
      while ((match = stationNameRegex.exec(text)) !== null) {
        if (match.index > lastIdx) parts.push(text.slice(lastIdx, match.index))
        const name = match[0]
        const coord = nameToCoord.get(name)
        if (coord) {
          parts.push(
            <a
              key={`${match.index}-${name}`}
              href={`/?station=${encodeURIComponent(coord)}&admin=1`}
              target="_blank"
              rel="noopener noreferrer"
              className="underline hover:text-foreground"
            >
              {name}
            </a>
          )
        } else {
          parts.push(name)
        }
        lastIdx = match.index + name.length
      }
      if (lastIdx < text.length) parts.push(text.slice(lastIdx))
      return parts
    },
    [nameToCoord, stationNameRegex]
  )

  // Assign each walk a stable, unique NUMERIC short code. Built by sorting
  // all slugs alphabetically and numbering from 1 → N. Width is computed
  // from the dataset size so codes stay aligned (e.g. 3 digits for ≤999
  // walks). Purely numeric so it never collides with station-name tokens
  // in notes — letters would.
  const codeMap = useMemo(() => {
    const m = new Map<string, string>()
    if (!data) return m
    const slugs = Object.keys(data).sort()
    const width = String(slugs.length).length
    slugs.forEach((slug, i) => m.set(slug, String(i + 1).padStart(width, "0")))
    return m
  }, [data])

  // Unique sorted list of source domains present in the data. Drives the
  // dropdown in the "page" column header. Keeping it derived means the
  // filter auto-updates if you seed walks from a new source later.
  const domains = useMemo(() => {
    if (!data) return [] as string[]
    const set = new Set<string>()
    for (const r of Object.values(data)) {
      const h = hostOf(r.url)
      if (h) set.add(h)
    }
    return [...set].sort()
  }, [data])

  // Unique sorted list of regions/counties present in the data. Drives a
  // sister dropdown alongside the domain filter.
  const regions = useMemo(() => {
    if (!data) return [] as string[]
    const set = new Set<string>()
    for (const r of Object.values(data)) {
      if (r.region) set.add(r.region)
    }
    return [...set].sort()
  }, [data])

  // Compute per-bucket counts once per data change. `useMemo` skips the
  // recompute when `data` hasn't changed (e.g. when only `bucket` flips).
  const counts = useMemo(() => {
    if (!data) return { all: 0, todo: 0, extracted: 0, onMap: 0, issues: 0, favourites: 0 }
    const rows = Object.values(data)
    return {
      all: rows.length,
      todo: rows.filter((r) => !r.extracted).length,
      extracted: rows.filter((r) => r.extracted).length,
      onMap: rows.filter((r) => (r.attachedStations?.length ?? 0) > 0).length,
      issues: rows.filter((r) => r.issues).length,
      favourites: rows.filter((r) => r.favourite).length,
    }
  }, [data])

  // Apply the active bucket filter and search, then sort alphabetically by
  // slug so the list is stable between polls.
  const rows = useMemo(() => {
    if (!data) return []
    const q = search.trim().toLowerCase()
    return Object.values(data)
      .filter((r) => {
        if (bucket === "todo" && r.extracted) return false
        if (bucket === "extracted" && !r.extracted) return false
        // "onMap" status is derived from attachedStations (the live source
        // of truth); the stored `r.onMap` boolean can lag behind.
        const onMap = (r.attachedStations?.length ?? 0) > 0
        if (bucket === "onMap" && !onMap) return false
        if (bucket === "issues" && !r.issues) return false
        if (bucket === "favourites" && !r.favourite) return false
        // Column-header filter on onMap — independent of bucket so it can
        // narrow e.g. "Issues" down to only those not yet plotted.
        if (onMapFilter === "on" && !onMap) return false
        if (onMapFilter === "off" && onMap) return false
        // Domain filter from the page column header dropdown.
        if (domain && hostOf(r.url) !== domain) return false
        // Region filter — exact match on the walk's region field.
        if (region && r.region !== region) return false
        // Resolved-column filter. The row's category is computed once,
        // then we check the matching flag. Special case: if NONE of the
        // three categories are checked we treat it as "no filter", same
        // as if all three were checked — avoids the weird empty-table
        // state when the user clears all checkboxes.
        const cat = r.issues ? (r.resolved ? "resolved" : "unresolved") : "noIssue"
        const allOff = !resolvedFilter.resolved && !resolvedFilter.unresolved && !resolvedFilter.noIssue
        if (!allOff && !resolvedFilter[cat]) return false
        if (q && !r.slug.toLowerCase().includes(q) && !r.title.toLowerCase().includes(q)) return false
        return true
      })
      .sort((a, b) => a.slug.localeCompare(b.slug))
  }, [data, bucket, search, onMapFilter, domain, region, resolvedFilter])

  return (
    // Absolute-positioned scroll container — globals.css sets
    // `body { overflow: hidden }` to lock the map page, so admin pages
    // need their own in-viewport scroll layer to be readable.
    <div className="absolute inset-0 overflow-y-auto">
    {/* Full-width layout — the table has many columns (including an
        editable resolution textarea) and was getting cramped at 5xl. */}
    <div className="p-6">
      <h1 className="text-2xl font-bold tracking-tight">Rambler walks — extraction status</h1>
      <p className="mt-2 text-sm text-muted-foreground">
        One row per walk on{" "}
        <a
          href="https://www.walkingclub.org.uk/walk/"
          target="_blank"
          rel="noopener noreferrer"
          className="underline hover:text-foreground"
        >
          walkingclub.org.uk/walk
        </a>
        . Re-seed from that index by running{" "}
        <code className="rounded bg-muted px-1 py-0.5 font-mono text-xs">
          node scripts/seed-rambler-walks.mjs
        </code>
        .
      </p>

      {error && (
        <div className="mt-4 rounded-md bg-red-100 p-3 text-sm text-red-800 dark:bg-red-950 dark:text-red-200">
          Failed to load: {error}
        </div>
      )}

      {/* Filter pills + search. Gap/size matches the rtt-status-panel style. */}
      <div className="mt-5 flex flex-wrap items-center gap-1.5 font-mono text-xs">
        {BUCKETS.map((b) => (
          <button
            key={b.key}
            onClick={() => setBucket(b.key)}
            className={`rounded px-2 py-1 transition-colors ${
              bucket === b.key
                ? "bg-foreground text-background"
                : "bg-muted text-muted-foreground hover:bg-muted/80 hover:text-foreground"
            }`}
          >
            {b.label} <span className="opacity-60">({counts[b.key]})</span>
          </button>
        ))}
        <input
          type="search"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search slug or title"
          className="ml-auto w-48 rounded border border-border bg-background px-2 py-1 font-mono text-xs focus:outline-none focus:ring-1 focus:ring-ring"
        />
        {/* Clears every filter back to defaults in one click — useful when
            the current view gets narrow and you want a fresh slate. */}
        <button
          type="button"
          onClick={resetFilters}
          className="rounded border border-border bg-background px-2 py-1 hover:bg-muted"
          title="Clear every filter back to defaults"
        >
          Reset filters
        </button>
      </div>

      {/* Main table. Tailwind `tabular-nums` keeps boolean glyph columns
          visually aligned even when different rows have different booleans. */}
      {data && (
        <table className="mt-4 w-full border-collapse font-mono text-sm">
          <thead>
            <tr className="border-b border-border text-left text-xs font-medium uppercase text-muted-foreground">
              {/* Page header + inline domain dropdown. `appearance-none` on
                  modern browsers would hide the native chevron — leaving it
                  visible here so the dropdown reads as interactive without
                  extra chrome. Empty value = "All sources". `w-64` caps the
                  column so long slugs wrap instead of stretching the whole
                  table. */}
              {/* w-[150px] + max-w caps the column; we stack the header
                  controls vertically and constrain the dropdown so the
                  outer width holds. */}
              <th className="w-[150px] max-w-[150px] py-2 pr-3">
                <div className="flex flex-col items-start gap-1">
                  <span>page</span>
                  <select
                    value={domain}
                    onChange={(e) => setDomain(e.target.value)}
                    // `normal-case` resets the parent uppercase. `max-w-full`
                    // keeps the <select> from expanding the column when a
                    // long domain is selected; the chevron still shows the
                    // full list on click.
                    className="max-w-full rounded border border-border bg-background px-1 py-0.5 font-mono text-[10px] normal-case focus:outline-none focus:ring-1 focus:ring-ring"
                    title="Filter rows by source domain"
                  >
                    <option value="">all sources</option>
                    {domains.map((d) => (
                      <option key={d} value={d}>{d}</option>
                    ))}
                  </select>
                  {/* Second dropdown: region/county filter. Same styling
                      as the domain select; exact-match on walk.region. */}
                  <select
                    value={region}
                    onChange={(e) => setRegion(e.target.value)}
                    className="max-w-full rounded border border-border bg-background px-1 py-0.5 font-mono text-[10px] normal-case focus:outline-none focus:ring-1 focus:ring-ring"
                    title="Filter rows by region / county"
                  >
                    <option value="">all regions</option>
                    {regions.map((rg) => (
                      <option key={rg} value={rg}>{rg}</option>
                    ))}
                  </select>
                </div>
              </th>
              <th className="py-2 px-2 text-center">★</th>
              {/* Extracted is redundant in the Issues view — having an
                  issue implies the walk was extracted — so hide it there
                  to reduce noise. */}
              {bucket !== "issues" && (
                <th className="py-2 px-2 text-center">extracted</th>
              )}
              <th className="py-2 px-2 text-center">issues</th>
              {/* Resolved column header + checkbox filter. Rows pass if
                  ANY checked category matches them, so unchecking one
                  hides that whole group. In the Issues bucket we show
                  just a single "unresolved-only" toggle, since "no issue"
                  is always empty there and filtering to "resolved only"
                  duplicates a use-case nobody asked for. */}
              <th className="py-2 px-2">
                <div className="flex flex-col items-center gap-0.5">
                  <span>resolved</span>
                  <div className="flex items-center gap-1.5 normal-case text-[10px]">
                    {bucket === "issues" ? (
                      <label className="flex items-center gap-0.5 cursor-pointer">
                        <input
                          type="checkbox"
                          checked={!resolvedFilter.resolved}
                          onChange={(e) =>
                            setResolvedFilter((s) => ({ ...s, resolved: !e.target.checked }))
                          }
                          className="h-3 w-3 accent-foreground"
                        />
                        unresolved only
                      </label>
                    ) : (
                      (["resolved", "unresolved", "noIssue"] as const).map((k) => (
                        <label key={k} className="flex items-center gap-0.5 cursor-pointer">
                          <input
                            type="checkbox"
                            checked={resolvedFilter[k]}
                            onChange={(e) =>
                              setResolvedFilter((s) => ({ ...s, [k]: e.target.checked }))
                            }
                            className="h-3 w-3 accent-foreground"
                          />
                          {k === "noIssue" ? "no issue" : k}
                        </label>
                      ))
                    )}
                  </div>
                </div>
              </th>
              <th className="min-w-[600px] py-2 px-2">notes</th>
              {/* Clickable column header — cycles the tri-state filter.
                  The indicator next to the label mirrors the ✓ glyph used
                  in the cells below so the meaning stays consistent:
                    ✓ = only rows already on the map
                    ✗ = only rows NOT yet on the map
                    (none) = no filter applied */}
              <th className="py-2 px-2 text-center">
                <button
                  type="button"
                  onClick={() =>
                    setOnMapFilter((s) => (s === "all" ? "on" : s === "on" ? "off" : "all"))
                  }
                  className={`inline-flex items-center gap-1 rounded px-1 py-0.5 uppercase hover:bg-muted ${
                    onMapFilter !== "all" ? "text-foreground" : ""
                  }`}
                  title="Click to filter: all → on map only → not on map → all"
                >
                  on&nbsp;map
                  <span className="normal-case tabular-nums">
                    {onMapFilter === "on" ? "✓" : onMapFilter === "off" ? "✗" : ""}
                  </span>
                </button>
              </th>
              <th className="py-2 px-2">resolution</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr
                key={r.slug}
                className={`border-b border-border/40 ${r.issues ? "text-amber-700 dark:text-amber-400" : ""}`}
              >
                <td className="py-1.5 pr-3">
                  <a
                    href={r.url}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="hover:underline"
                    title={r.title}
                  >
                    {r.slug}
                  </a>
                  <span className="ml-2 text-xs text-muted-foreground">{r.region}</span>
                </td>
                <td className="py-1.5 px-2 text-center">{r.favourite ? "★" : ""}</td>
                {bucket !== "issues" && (
                  <td className="py-1.5 px-2 text-center">{r.extracted ? "✓" : ""}</td>
                )}
                {/* Show the stable numeric code alongside ⚠ so you can
                    reference it in chat (e.g. "fix issue 042"). `select-all`
                    means a double-click highlights the full code for copy. */}
                <td className="py-1.5 px-2 text-center">
                  {r.issues ? (
                    <span className="inline-flex items-center gap-1">
                      <span>⚠</span>
                      <span className="select-all text-xs opacity-70">{codeMap.get(r.slug)}</span>
                    </span>
                  ) : ""}
                </td>
                {/* Checkbox only makes sense when there was an issue to
                    resolve. For non-issue rows we render an empty cell so
                    the column stays aligned. `accent-foreground` tints the
                    native checkbox to match the theme — cheaper than a
                    custom-styled shadcn/ui Checkbox for this admin-only
                    page. */}
                <td className="py-1.5 px-2 text-center">
                  {r.issues ? (
                    <input
                      type="checkbox"
                      checked={!!r.resolved}
                      onChange={(e) => updateWalk(r.slug, { resolved: e.target.checked })}
                      className="h-3.5 w-3.5 cursor-pointer accent-foreground"
                      aria-label={`Mark ${r.slug} resolved`}
                    />
                  ) : null}
                </td>
                <td className="py-1.5 px-2 text-xs">{renderNotes(r.notes)}</td>
                {/* List the CRS codes of every station whose ramblerNote
                    currently surfaces this walk. Each code links to the
                    map's admin overlay for that station, same deep-link
                    pattern used in the notes column. */}
                <td className="py-1.5 px-2 text-center text-xs">
                  {r.attachedStations && r.attachedStations.length > 0 ? (
                    <span className="inline-flex flex-wrap justify-center gap-1">
                      {r.attachedStations.map((coord) => {
                        const crs = coordToCrs?.get(coord)
                        if (!crs) return null
                        return (
                          <a
                            key={coord}
                            href={`/?station=${encodeURIComponent(coord)}&admin=1`}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="underline hover:text-foreground"
                          >
                            {crs}
                          </a>
                        )
                      })}
                    </span>
                  ) : ""}
                </td>
                {/* Inline editable resolution field. Uncontrolled
                    (defaultValue + blur save) so the textarea keeps the
                    user's typing even when the 4s poll swaps the data
                    object. `key={r.slug}` on the row ensures React reuses
                    the element, so the initial defaultValue isn't
                    re-read and typing isn't interrupted. Saves only when
                    the value actually changed, to avoid a POST on every
                    focus/blur cycle. */}
                <td className="py-1.5 px-2 text-xs">
                  {r.issues ? (
                    <textarea
                      defaultValue={r.resolution ?? ""}
                      onBlur={(e) => {
                        const next = e.target.value
                        if (next !== (r.resolution ?? "")) {
                          updateWalk(r.slug, { resolution: next })
                        }
                      }}
                      rows={1}
                      placeholder="…"
                      className="w-40 resize-y rounded border border-border bg-background px-1.5 py-1 font-mono text-xs leading-tight focus:outline-none focus:ring-1 focus:ring-ring"
                    />
                  ) : null}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      {!data && !error && (
        <p className="mt-4 text-sm text-muted-foreground">Loading…</p>
      )}

      {data && rows.length === 0 && (
        <p className="mt-4 text-sm text-muted-foreground">No walks match the current filter.</p>
      )}
    </div>
    </div>
  )
}
