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
  notes: string
  outsideMainlandBritain?: boolean
}

// How often the page re-polls /api/dev/rambler-walks. 4s matches the RTT
// panel and is slow enough to be free; the admin isn't editing hundreds of
// walks per minute so faster polling would just waste battery.
const POLL_MS = 4000

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
  const [bucket, setBucket] = useState<Bucket>("all")
  const [search, setSearch] = useState("")
  // Station name → coordKey lookup. Built once from /stations.json and
  // used to turn any station mentions in the notes column into links
  // that deep-link back to the map's overlay via ?station=<coordKey>.
  const [nameToCoord, setNameToCoord] = useState<Map<string, string> | null>(null)

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
      .then((geo: { features: Array<{ geometry: { coordinates: [number, number] }; properties: { name?: string } }> }) => {
        if (cancelled) return
        const map = new Map<string, string>()
        for (const f of geo.features) {
          const [lng, lat] = f.geometry?.coordinates ?? []
          const name = f.properties?.name
          if (lng == null || lat == null || !name) continue
          // First-wins on duplicate names (e.g. two stations sharing a name).
          // Doesn't affect correctness — both map to "a" station on the map.
          if (!map.has(name)) map.set(name, `${lng},${lat}`)
        }
        setNameToCoord(map)
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

  // Compute per-bucket counts once per data change. `useMemo` skips the
  // recompute when `data` hasn't changed (e.g. when only `bucket` flips).
  const counts = useMemo(() => {
    if (!data) return { all: 0, todo: 0, extracted: 0, onMap: 0, issues: 0, favourites: 0 }
    const rows = Object.values(data)
    return {
      all: rows.length,
      todo: rows.filter((r) => !r.extracted).length,
      extracted: rows.filter((r) => r.extracted).length,
      onMap: rows.filter((r) => r.onMap).length,
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
        if (bucket === "onMap" && !r.onMap) return false
        if (bucket === "issues" && !r.issues) return false
        if (bucket === "favourites" && !r.favourite) return false
        if (q && !r.slug.toLowerCase().includes(q) && !r.title.toLowerCase().includes(q)) return false
        return true
      })
      .sort((a, b) => a.slug.localeCompare(b.slug))
  }, [data, bucket, search])

  return (
    // Absolute-positioned scroll container — globals.css sets
    // `body { overflow: hidden }` to lock the map page, so admin pages
    // need their own in-viewport scroll layer to be readable.
    <div className="absolute inset-0 overflow-y-auto">
    <div className="mx-auto max-w-5xl p-6">
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
      </div>

      {/* Main table. Tailwind `tabular-nums` keeps boolean glyph columns
          visually aligned even when different rows have different booleans. */}
      {data && (
        <table className="mt-4 w-full border-collapse font-mono text-sm">
          <thead>
            <tr className="border-b border-border text-left text-xs font-medium uppercase text-muted-foreground">
              <th className="py-2 pr-3">page</th>
              <th className="py-2 px-2 text-center">★</th>
              <th className="py-2 px-2 text-center">extracted</th>
              <th className="py-2 px-2 text-center">on&nbsp;map</th>
              <th className="py-2 px-2 text-center">issues</th>
              <th className="py-2 pl-2">notes</th>
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
                <td className="py-1.5 px-2 text-center">{r.extracted ? "✓" : ""}</td>
                <td className="py-1.5 px-2 text-center">{r.onMap ? "✓" : ""}</td>
                <td className="py-1.5 px-2 text-center">{r.issues ? "⚠" : ""}</td>
                <td className="py-1.5 pl-2 text-xs">{renderNotes(r.notes)}</td>
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
