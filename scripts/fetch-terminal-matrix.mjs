// Fetches tube/walk connections between every pair of London terminals listed
// in data/london-terminals.json, and writes the results to data/terminal-matrix.json.
//
// This matrix lets the app construct journeys from ANY terminal to any destination
// WITHOUT fetching new per-destination data: we already have Kings Cross cluster
// journeys for every destination, and the KX journey identifies which mainline
// terminal that destination uses. lib/stitch-journey.ts then prepends a short
// tube hop from the user-selected terminal to the destination's mainline terminal,
// pulling the hop's duration + polyline from this matrix.
//
// Usage:
//   GOOGLE_MAPS_API_KEY=your_key node scripts/fetch-terminal-matrix.mjs
//
// Flags:
//   --recompute    Re-fetch even if an entry already exists in terminal-matrix.json
//
// Safe to interrupt and re-run — existing entries are skipped unless --recompute.
// ~156 pairs at ~150ms each is under a minute total.

import { readFileSync, writeFileSync, existsSync } from "fs"

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const API_KEY = process.env.GOOGLE_MAPS_API_KEY
if (!API_KEY) {
  console.error("Error: set GOOGLE_MAPS_API_KEY environment variable")
  process.exit(1)
}

const RECOMPUTE = process.argv.includes("--recompute")

const TERMINALS_PATH = "data/london-terminals.json"
const MATRIX_PATH = "data/terminal-matrix.json"

const terminals = JSON.parse(readFileSync(TERMINALS_PATH, "utf-8"))

// Load existing matrix (resumable); initialise empty if missing.
const matrix = existsSync(MATRIX_PATH)
  ? JSON.parse(readFileSync(MATRIX_PATH, "utf-8"))
  : {}

// ---------------------------------------------------------------------------
// Routes API
// ---------------------------------------------------------------------------

const ROUTES_API_URL =
  "https://routes.googleapis.com/directions/v2:computeRoutes"

// Same minimal field mask as fetch-journeys.mjs — we only need duration + polyline + first-leg vehicle type.
const FIELD_MASK = [
  "routes.duration",
  "routes.legs.duration",
  "routes.legs.steps.transitDetails",
  "routes.legs.steps.travelMode",
  "routes.legs.polyline.encodedPolyline",
].join(",")

// Pick reference departure times. We match fetch-journeys.mjs conventions —
// two Saturdays at 09:30 BST (next + furthest within 100 days) — so the matrix
// reflects the same service pattern as the per-destination journeys we stitch
// against AND we get a consistency check against engineering works / unusual
// schedules. Matters for Cannon Street (no Saturday mainline services): Routes
// will correctly report no route for some pairs, rather than returning a
// weekday-only path the app would misuse.
function nextSaturday() {
  const now = new Date()
  const day = now.getDay() // 0 = Sun, 6 = Sat
  const daysUntilSat = (6 - day + 7) % 7 || 7
  const sat = new Date(now)
  sat.setDate(now.getDate() + daysUntilSat)
  return sat
}
function furthestSaturday() {
  const now = new Date()
  const limit = new Date(now)
  limit.setDate(now.getDate() + 100)
  while (limit.getDay() !== 6) limit.setDate(limit.getDate() - 1)
  return limit
}
function toDepartureTime(date) {
  // "YYYY-MM-DDT09:30:00+01:00" — BST, matching fetch-journeys.mjs.
  const yyyy = date.getFullYear()
  const mm = String(date.getMonth() + 1).padStart(2, "0")
  const dd = String(date.getDate()).padStart(2, "0")
  return `${yyyy}-${mm}-${dd}T09:30:00+01:00`
}
const DEPARTURE_DATES = [nextSaturday(), furthestSaturday()]
const DEPARTURE_TIMES = DEPARTURE_DATES.map(toDepartureTime)
console.log("Querying departures at 09:30 BST on:")
DEPARTURE_TIMES.forEach((t) => console.log(`  ${t}`))
console.log()

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function parseDurationMinutes(durationStr) {
  if (!durationStr) return Infinity
  const seconds = parseInt(durationStr.replace("s", ""), 10)
  return Math.round(seconds / 60)
}

/** Returns the fastest matching route between two lat/lng points for the given
 *  departure time, or null. */
async function queryRoute(from, to, departureTime) {
  const body = {
    origin: { location: { latLng: { latitude: from.lat, longitude: from.lng } } },
    destination: { location: { latLng: { latitude: to.lat, longitude: to.lng } } },
    travelMode: "TRANSIT",
    departureTime,
    computeAlternativeRoutes: true,
    transitPreferences: {
      allowedTravelModes: ["RAIL"],
    },
  }

  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const res = await fetch(ROUTES_API_URL, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Goog-Api-Key": API_KEY,
          "X-Goog-FieldMask": FIELD_MASK,
        },
        body: JSON.stringify(body),
      })
      const data = await res.json()
      if (!res.ok || !data.routes?.length) return null

      // Pick the shortest route
      let best = null
      for (const route of data.routes) {
        const minutes = parseDurationMinutes(route.duration)
        if (!best || minutes < best.minutes) {
          const leg = route.legs?.[0]
          // Find the first transit step's vehicle type (SUBWAY, HEAVY_RAIL, etc.)
          const firstTransit = (leg?.steps || []).find(
            (s) => s.travelMode === "TRANSIT" && s.transitDetails
          )
          best = {
            minutes,
            polyline: leg?.polyline?.encodedPolyline ?? null,
            vehicleType:
              firstTransit?.transitDetails?.transitLine?.vehicle?.type ?? "WALK",
          }
        }
      }
      return best
    } catch (err) {
      if (attempt < 2) {
        const delay = 1000 * 2 ** attempt
        console.warn(`  Network error, retrying in ${delay / 1000}s... (${err.message})`)
        await sleep(delay)
      }
    }
  }
  return null
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  console.log(`Terminals: ${terminals.length}`)
  console.log(`Pairs to fetch: ${terminals.length * (terminals.length - 1)}`)
  console.log()

  let processed = 0
  let skipped = 0

  for (const from of terminals) {
    if (!matrix[from.name]) matrix[from.name] = {}

    for (const to of terminals) {
      if (from.name === to.name) continue

      // Skip if we already have this entry (unless --recompute)
      if (!RECOMPUTE && matrix[from.name][to.name]) {
        skipped++
        continue
      }

      // Query both dates and keep the fastest. Record whether the two dates
      // agreed (within 3 min) — disagreement flags engineering works / odd
      // scheduling on one of them.
      const perDate = []
      for (const t of DEPARTURE_TIMES) {
        const r = await queryRoute(from, to, t)
        perDate.push(r)
        await sleep(150)
      }
      const best = perDate.reduce((acc, r) => {
        if (!r) return acc
        if (!acc || r.minutes < acc.minutes) return r
        return acc
      }, null)

      if (best) {
        const mins0 = perDate[0]?.minutes
        const mins1 = perDate[1]?.minutes
        const bothFound = mins0 != null && mins1 != null
        matrix[from.name][to.name] = {
          ...best,
          consistencyCheck: {
            isConsistent: bothFound ? Math.abs(mins0 - mins1) <= 3 : null,
            dates: DEPARTURE_DATES.map((d) => d.toISOString().slice(0, 10)),
          },
        }
        const flag = bothFound && Math.abs(mins0 - mins1) > 3 ? " ⚠ inconsistent" : ""
        console.log(`  ${from.name} → ${to.name}: ${best.minutes} min (${best.vehicleType})${flag}`)
      } else {
        console.log(`  ${from.name} → ${to.name}: no route found`)
      }
      processed++

      // Save progress every 10 pairs so we can resume on interruption
      if (processed % 10 === 0) {
        writeFileSync(MATRIX_PATH, JSON.stringify(matrix, null, 2))
      }
    }
  }

  writeFileSync(MATRIX_PATH, JSON.stringify(matrix, null, 2))
  console.log(`\nDone. Processed ${processed} pairs, skipped ${skipped} already cached.`)
}

main().catch(console.error)
