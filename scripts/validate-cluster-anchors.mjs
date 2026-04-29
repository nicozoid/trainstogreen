// Validates that every cluster anchor in lib/clusters-data.json sits at a
// foot-accessible point. Reports anchors where Mapbox's walking router
// snaps the destination meaningfully away from the configured anchor coord
// — those anchors are on a roof, in the river, in the middle of a motorway,
// or otherwise not directly walkable.
//
// How the check works:
//   For each cluster, pick the first member (any cluster diamond), and ask
//   the Mapbox Directions API for a walking route from that member to the
//   anchor. The router will snap the END of the route to the nearest road/
//   footpath if the anchor itself isn't reachable. The gap between the
//   anchor and that snapped end coord is the validation signal.
//
//   Gap < THRESHOLD_M   → anchor is fine (router landed on or near it).
//   Gap ≥ THRESHOLD_M   → anchor is off-piste; the report suggests the
//                         snapped coord as a candidate replacement.
//
// Output:
//   Table to stdout summarising every cluster. Anchors that need attention
//   are flagged "SNAP" with the gap distance and the suggested coord. Pass
//   `--json` for a machine-readable report instead.
//
// Usage:
//   NEXT_PUBLIC_MAPBOX_TOKEN=pk.xxx node scripts/validate-cluster-anchors.mjs
//   node scripts/validate-cluster-anchors.mjs --json
//
// The script is read-only — it never edits clusters-data.json. Any anchor
// move is a deliberate manual edit informed by this report.

import { readFileSync, existsSync } from "fs"

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const CLUSTERS_PATH = "lib/clusters-data.json"
// Below this gap, treat the anchor as fine. 25m covers normal router
// snapping (anchors right at a kerb often resolve to the centreline of
// the road, ~5-15m away). Anything past this threshold suggests the
// anchor isn't actually reachable.
const THRESHOLD_M = 25
const JSON_OUTPUT = process.argv.includes("--json")

// Token resolution: prefer process.env (so the script slots into the
// existing pattern), fall back to parsing .env.local so a fresh checkout
// works without extra setup.
function loadToken() {
  if (process.env.NEXT_PUBLIC_MAPBOX_TOKEN) return process.env.NEXT_PUBLIC_MAPBOX_TOKEN
  if (!existsSync(".env.local")) return null
  const env = readFileSync(".env.local", "utf-8")
  const m = env.match(/^NEXT_PUBLIC_MAPBOX_TOKEN=(.+)$/m)
  return m ? m[1].trim() : null
}

const TOKEN = loadToken()
if (!TOKEN) {
  console.error("Missing NEXT_PUBLIC_MAPBOX_TOKEN (env or .env.local).")
  process.exit(1)
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

// Haversine distance in metres. Good enough for the small distances we
// care about (anchor-to-snap-point gaps measured in tens of metres).
function haversineMeters([lng1, lat1], [lng2, lat2]) {
  const R = 6_371_000
  const toRad = (d) => (d * Math.PI) / 180
  const dLat = toRad(lat2 - lat1)
  const dLng = toRad(lng2 - lng1)
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2
  return 2 * R * Math.asin(Math.sqrt(a))
}

async function fetchWalkingRoute(from, to) {
  const url =
    `https://api.mapbox.com/directions/v5/mapbox/walking/` +
    `${from[0]},${from[1]};${to[0]},${to[1]}?` +
    `geometries=geojson&overview=full&access_token=${TOKEN}`
  const res = await fetch(url)
  if (!res.ok) throw new Error(`HTTP ${res.status} on ${from} → ${to}`)
  const data = await res.json()
  const coords = data.routes?.[0]?.geometry?.coordinates
  if (!coords || coords.length < 2) throw new Error(`No route from ${from} to ${to}`)
  return coords
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

const { CLUSTERS } = JSON.parse(readFileSync(CLUSTERS_PATH, "utf-8"))

const results = []
for (const [anchorKey, def] of Object.entries(CLUSTERS)) {
  const member = def.members?.[0]
  if (!member) {
    results.push({ cluster: def.displayName, anchorKey, status: "EMPTY", note: "no members" })
    continue
  }
  const anchor = anchorKey.split(",").map(Number)
  const fromCoord = member.split(",").map(Number)
  try {
    const coords = await fetchWalkingRoute(fromCoord, anchor)
    const snapped = coords[coords.length - 1]
    const gap = haversineMeters(anchor, snapped)
    const ok = gap < THRESHOLD_M
    results.push({
      cluster: def.displayName,
      anchorKey,
      gapM: Math.round(gap),
      status: ok ? "OK" : "SNAP",
      suggestedAnchor: ok ? null : `${snapped[0].toFixed(7)},${snapped[1].toFixed(7)}`,
    })
  } catch (e) {
    results.push({ cluster: def.displayName, anchorKey, status: "ERROR", note: e.message })
  }
}

if (JSON_OUTPUT) {
  console.log(JSON.stringify(results, null, 2))
} else {
  // Human-readable table. Pad column widths to the longest entry so the
  // grid reads cleanly when several clusters need attention.
  const colW = (key) => Math.max(key.length, ...results.map((r) => String(r[key] ?? "").length))
  const widths = {
    cluster: colW("cluster"),
    status: colW("status"),
    gapM: Math.max(5, ...results.map((r) => String(r.gapM ?? "").length)),
    anchorKey: colW("anchorKey"),
    suggestedAnchor: colW("suggestedAnchor"),
  }
  const pad = (s, w) => String(s ?? "").padEnd(w)
  console.log(
    pad("cluster", widths.cluster),
    pad("status", widths.status),
    pad("gap m", widths.gapM),
    pad("current anchor", widths.anchorKey),
    "suggested anchor",
  )
  console.log("-".repeat(widths.cluster + widths.status + widths.gapM + widths.anchorKey + 24))
  for (const r of results) {
    console.log(
      pad(r.cluster, widths.cluster),
      pad(r.status, widths.status),
      pad(r.gapM ?? "", widths.gapM),
      pad(r.anchorKey, widths.anchorKey),
      r.suggestedAnchor ?? r.note ?? "",
    )
  }
  const flagged = results.filter((r) => r.status !== "OK").length
  console.log(`\n${flagged} of ${results.length} cluster(s) need attention.`)
}
