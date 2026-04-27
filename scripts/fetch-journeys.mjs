// Enriches stations.json with detailed journey data using the Google Maps
// Routes API (successor to the Directions API).
//
// Usage:
//   GOOGLE_MAPS_API_KEY=your_key node scripts/fetch-journeys.mjs --origin "Farringdon" --filter 4
//
// Flags:
//   --origin "Station Name"  Origin station (looked up by name in stations.json). Required.
//   --station "Station Name" Process a single destination station only (by name).
//   --coordKey "lng,lat"     Process only the destination at this exact coordinate —
//                            use this instead of --station when two stations share a name.
//   --filter 4               Only process stations with this derived rating (1..4).
//                            Ratings are derived from each station's walks (see
//                            app/api/dev/walk-ratings/route.ts for the rules).
//                            Omit to process every station.
//   --recompute              Re-fetch even if journey data already exists for this origin.
//
// Safe to interrupt and re-run — already-computed stations are skipped.
// Journey data is stored per-origin — keyed by "lng,lat" coord key so two
// same-named origin stations stay independent:
//
//   feature.properties.journeys = {
//     "-0.104555,51.519964": { durationMinutes, departureTime, changes, legs, polyline },
//     "-0.1239491,51.530609": { ... }
//   }

import { readFileSync, writeFileSync } from "fs"
import { createInterface } from "readline"

// ---------------------------------------------------------------------------
// CLI arguments
// ---------------------------------------------------------------------------

const API_KEY = process.env.GOOGLE_MAPS_API_KEY
const RECOMPUTE = process.argv.includes("--recompute")

if (!API_KEY) {
  console.error("Error: set GOOGLE_MAPS_API_KEY environment variable")
  process.exit(1)
}

/** Reads the value after a named flag, e.g. --origin "Farringdon" → "Farringdon" */
function getFlag(name) {
  const idx = process.argv.indexOf(name)
  if (idx === -1 || idx + 1 >= process.argv.length) return null
  return process.argv[idx + 1]
}

const ORIGIN_NAME = getFlag("--origin")
if (!ORIGIN_NAME) {
  console.error('Error: --origin "Station Name" is required')
  process.exit(1)
}

// Optional: process a single destination station
const STATION_FILTER = getFlag("--station")

// Optional: process only the destination at this exact "lng,lat" coordKey.
// Use this (instead of --station) when two stations share a name.
const COORD_KEY_FILTER = getFlag("--coordKey")

// Optional rating filter — numeric 1..4 matching the derived rating
// produced by app/api/dev/walk-ratings/route.ts.
const RATING_FILTER_RAW = getFlag("--filter")
const RATING_FILTER = RATING_FILTER_RAW == null ? null : Number(RATING_FILTER_RAW)
if (RATING_FILTER != null && ![1, 2, 3, 4].includes(RATING_FILTER)) {
  console.error(`Error: --filter must be 1, 2, 3, or 4 (got "${RATING_FILTER_RAW}")`)
  process.exit(1)
}

// ---------------------------------------------------------------------------
// Load data and resolve origin
// ---------------------------------------------------------------------------

const STATIONS_PATH = "public/stations.json"
const stationData = JSON.parse(readFileSync(STATIONS_PATH, "utf-8"))

// Find the origin station by name in stations.json
const originFeature = stationData.features.find(
  (f) => f.properties.name?.toLowerCase() === ORIGIN_NAME.toLowerCase()
)

if (!originFeature) {
  console.error(`Error: station "${ORIGIN_NAME}" not found in stations.json`)
  process.exit(1)
}

const [originLng, originLat] = originFeature.geometry.coordinates
// The coord key under which we'll store this origin's journeys in each feature.
// Matches the "lng,lat" format used elsewhere in the app.
const ORIGIN_COORD_KEY = `${originLng},${originLat}`
const ORIGIN = { latitude: originLat, longitude: originLng }
console.log(
  `Origin: ${originFeature.properties.name} (${originLat}, ${originLng})`
)

// Derive station ratings from walks — same rules as
// app/api/dev/walk-ratings/route.ts. Builds a Map<coordKey, 1..4>.
//
// Rules (kept in sync with the API route):
//   1. No walks → unrated (absent from map)
//   2. max walk rating >= 3 → max wins (upward deviation has top priority)
//   3. otherwise, any walk rated 1 → 1 (downward deviation overrides default)
//   4. otherwise → 2 (default for any station-with-walks)
function deriveRatings() {
  const WALK_FILES = [
    "data/rambler-walks.json",
    "data/leicester-ramblers-walks.json",
    "data/heart-rail-trails-walks.json",
    "data/abbey-line-walks.json",
    "data/manual-walks.json",
  ]
  // Build CRS → coordKey index from stations.json.
  const crsToCoord = new Map()
  for (const f of stationData.features) {
    const crs = f.properties?.["ref:crs"]
    if (!crs) continue
    const [lng, lat] = f.geometry?.coordinates ?? []
    if (lng != null && lat != null) crsToCoord.set(crs, `${lng},${lat}`)
  }
  // Aggregate per CRS: max rating + sawAnyWalk flag (default-2 rule)
  // + sawRated1 flag (downward-deviation rule).
  const tally = new Map()
  for (const file of WALK_FILES) {
    let entries
    try { entries = JSON.parse(readFileSync(file, "utf-8")) } catch { continue }
    for (const entry of Object.values(entries)) {
      if (!Array.isArray(entry?.walks)) continue
      for (const v of entry.walks) {
        const crs = v.startStation
        if (!crs) continue
        const t = tally.get(crs) ?? { max: null, sawAnyWalk: false, sawRated1: false }
        t.sawAnyWalk = true
        if (typeof v.rating === "number") {
          const r = Math.round(v.rating)
          if (r >= 1 && r <= 4) {
            t.max = t.max == null ? r : Math.max(t.max, r)
            if (r === 1) t.sawRated1 = true
          }
        }
        tally.set(crs, t)
      }
    }
  }
  const out = new Map()
  for (const [crs, t] of tally) {
    const ck = crsToCoord.get(crs)
    if (!ck) continue
    if (!t.sawAnyWalk) continue
    if (t.max != null && t.max >= 3) out.set(ck, t.max)
    else if (t.sawRated1) out.set(ck, 1)
    else out.set(ck, 2)
  }
  return out
}

const ratings = RATING_FILTER == null ? null : deriveRatings()

if (RATING_FILTER != null) {
  console.log(`Filter: only stations with derived rating ${RATING_FILTER}`)
}

// ---------------------------------------------------------------------------
// Routes API config
// ---------------------------------------------------------------------------

const ROUTES_API_URL =
  "https://routes.googleapis.com/directions/v2:computeRoutes"

// We only need these fields from the response. Requesting fewer fields keeps
// costs down — the Routes API charges based on which field masks you use.
const FIELD_MASK = [
  "routes.duration",
  "routes.legs.duration",
  "routes.legs.steps.transitDetails",
  "routes.legs.steps.travelMode",
  "routes.legs.polyline.encodedPolyline",
].join(",")

// ---------------------------------------------------------------------------
// Date helpers
// ---------------------------------------------------------------------------

/** Returns the Date of the coming Saturday (at least 1 day ahead). */
function nextSaturday() {
  const now = new Date()
  const day = now.getDay() // 0 = Sun, 6 = Sat
  const daysUntilSat = (6 - day + 7) % 7 || 7
  const sat = new Date(now)
  sat.setDate(now.getDate() + daysUntilSat)
  return sat
}

/** Returns the furthest-away Saturday within 100 days from today. */
function furthestSaturday() {
  const now = new Date()
  const limit = new Date(now)
  limit.setDate(now.getDate() + 100)

  // Walk backwards from the limit until we land on a Saturday
  while (limit.getDay() !== 6) {
    limit.setDate(limit.getDate() - 1)
  }
  return limit
}

/** Formats a Date as an ISO 8601 string at 09:30 UK time (BST in summer). */
function toDepartureTime(date) {
  // Build "YYYY-MM-DDT09:30:00+01:00" (BST). Both target Saturdays fall
  // within British Summer Time (last Sunday of March → last Sunday of October).
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

// ---------------------------------------------------------------------------
// API helpers
// ---------------------------------------------------------------------------

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/**
 * Calls the Routes API for a single departure time. Returns an array of
 * raw route objects (up to 3 alternatives), or an empty array on failure.
 */
async function queryRoutes(lat, lng, departureTime) {
  const body = {
    origin: {
      location: { latLng: ORIGIN },
    },
    destination: {
      location: { latLng: { latitude: lat, longitude: lng } },
    },
    travelMode: "TRANSIT",
    departureTime,
    // Ask for alternative routes so we can pick the fastest
    computeAlternativeRoutes: true,
    transitPreferences: {
      // RAIL = TRAIN + SUBWAY + LIGHT_RAIL (includes trams)
      allowedTravelModes: ["RAIL"],
    },
  }

  // Retry up to 3 times on network errors with exponential backoff
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

      // The Routes API uses HTTP status codes rather than a status field.
      // A non-OK response or missing routes array means no route found.
      if (!res.ok || !data.routes?.length) return []

      return data.routes
    } catch (err) {
      if (attempt < 2) {
        const delay = 1000 * 2 ** attempt
        console.warn(
          `  Network error, retrying in ${delay / 1000}s... (${err.message})`
        )
        await sleep(delay)
      }
    }
  }
  return []
}

// ---------------------------------------------------------------------------
// Route parsing
// ---------------------------------------------------------------------------

/** Parses the "3600s" duration string the API returns into minutes. */
function parseDurationMinutes(durationStr) {
  if (!durationStr) return Infinity
  const seconds = parseInt(durationStr.replace("s", ""), 10)
  return Math.round(seconds / 60)
}

/**
 * Extracts the structured journey data we care about from a raw API route.
 * Returns null if the route has no transit steps.
 */
function parseRoute(route) {
  const leg = route.legs?.[0]
  if (!leg) return null

  // Collect only the TRANSIT steps (ignore WALK steps)
  const transitSteps = (leg.steps || []).filter(
    (s) => s.travelMode === "TRANSIT" && s.transitDetails
  )

  if (transitSteps.length === 0) return null

  const durationMinutes = parseDurationMinutes(route.duration)

  // The overall departure time is when the first transit segment leaves
  const departureTime =
    transitSteps[0].transitDetails.stopDetails?.departureTime ?? null

  const changes = transitSteps.length - 1

  // Build a leg summary for each transit segment
  const legs = transitSteps.map((step) => {
    const td = step.transitDetails
    const stops = td.stopDetails ?? {}
    return {
      line: td.transitLine?.name ?? null,
      vehicleType: td.transitLine?.vehicle?.type ?? null,
      departureStation: stops.departureStop?.name ?? null,
      departureTime: stops.departureTime ?? null,
      arrivalStation: stops.arrivalStop?.name ?? null,
      arrivalTime: stops.arrivalTime ?? null,
      // stopCount is the number of stops between departure and arrival
      stopCount: td.stopCount ?? null,
    }
  })

  // Use the leg-level polyline which covers the whole journey (walk + transit)
  const polyline = leg.polyline?.encodedPolyline ?? null

  return { durationMinutes, departureTime, changes, legs, polyline }
}

// ---------------------------------------------------------------------------
// Interactive prompt helper
// ---------------------------------------------------------------------------

/** Asks a yes/no question in the terminal. Returns true for "y", false for "n". */
function askYesNo(question) {
  const rl = createInterface({ input: process.stdin, output: process.stdout })
  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      rl.close()
      resolve(answer.trim().toLowerCase().startsWith("y"))
    })
  })
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  // (Buried stations are NOT skipped here — burying just hides a
  // station at low zoom on the map, it doesn't disqualify it as a
  // destination for journey fetching.)

  // Build the list of stations to process
  const candidates = stationData.features.filter((feature) => {
    const name = feature.properties.name ?? "Unknown"
    const [lng, lat] = feature.geometry.coordinates
    const coordKey = `${lng},${lat}`

    // If --station is set, only include that specific station
    if (STATION_FILTER && name.toLowerCase() !== STATION_FILTER.toLowerCase()) {
      return false
    }

    // If --coordKey is set, only include the feature at that exact "lng,lat".
    // Needed when two stations share a name (e.g. three Whitchurches).
    if (COORD_KEY_FILTER && coordKey !== COORD_KEY_FILTER) return false

    // If --filter is set, only include stations that match the rating
    if (RATING_FILTER != null) {
      if (ratings.get(coordKey) !== RATING_FILTER) return false
    }

    return true
  })

  console.log(`Processing ${candidates.length} stations\n`)

  let processed = 0
  let skipped = 0

  // Stations where the new journey is >10 min slower than the old one.
  // We hold off writing their data until the user decides at the end.
  const flagged = []

  for (const feature of candidates) {
    const name = feature.properties.name ?? "Unknown"

    // Ensure the journeys map exists
    if (!feature.properties.journeys) {
      feature.properties.journeys = {}
    }

    const existingJourney = feature.properties.journeys[ORIGIN_COORD_KEY] ?? null

    // Skip stations that already have journey data for this origin (allows
    // resuming), unless --recompute was passed
    if (!RECOMPUTE && existingJourney != null) {
      skipped++
      continue
    }

    const [lng, lat] = feature.geometry.coordinates

    // Query both dates and track the best journey per date separately,
    // so we can check whether the two dates give consistent results.
    const bestPerDate = [null, null]

    for (let i = 0; i < DEPARTURE_TIMES.length; i++) {
      const routes = await queryRoutes(lat, lng, DEPARTURE_TIMES[i])

      for (const route of routes) {
        const parsed = parseRoute(route)
        if (!parsed) continue

        if (
          !bestPerDate[i] ||
          parsed.durationMinutes < bestPerDate[i].durationMinutes
        ) {
          bestPerDate[i] = parsed
        }
      }

      await sleep(150) // rate limiting between queries
    }

    // Overall best journey across both dates
    const bestJourney = bestPerDate.reduce((best, j) => {
      if (!j) return best
      if (!best || j.durationMinutes < best.durationMinutes) return j
      return best
    }, null)

    // Record whether the fastest times on each date were consistent
    // (≤5 min difference). Also store which dates were compared.
    if (bestJourney) {
      const mins0 = bestPerDate[0]?.durationMinutes ?? null
      const mins1 = bestPerDate[1]?.durationMinutes ?? null
      const bothFound = mins0 != null && mins1 != null

      bestJourney.consistencyCheck = {
        isConsistent: bothFound ? Math.abs(mins0 - mins1) <= 5 : null,
        dates: DEPARTURE_DATES.map((d) => d.toISOString().slice(0, 10)),
      }
    }

    // Compare with the previous result if one exists (only relevant with --recompute)
    const oldMins = existingJourney?.durationMinutes
    const newMins = bestJourney?.durationMinutes

    if (oldMins != null && newMins != null && newMins > oldMins + 10) {
      // Flag it — don't overwrite yet, keep old data until the user decides
      flagged.push({ feature, name, oldMins, newMins, newJourney: bestJourney })
      console.log(
        `[FLAGGED] ${name}: ${oldMins} → ${newMins} min (+${newMins - oldMins}) — will ask at the end`
      )
    } else {
      feature.properties.journeys[ORIGIN_COORD_KEY] = bestJourney
    }

    processed++
    const pct = Math.round(((processed + skipped) / candidates.length) * 100)
    const mins = bestJourney?.durationMinutes ?? "no route"
    console.log(`[${pct}%] ${name}: ${mins} min`)

    // Save progress every 10 stations (only unflagged stations are written)
    if (processed % 10 === 0) {
      writeFileSync(STATIONS_PATH, JSON.stringify(stationData, null, 2))
    }

    await sleep(150) // rate limiting between stations
  }

  // Save all unflagged results before prompting
  writeFileSync(STATIONS_PATH, JSON.stringify(stationData, null, 2))

  // Resolve flagged stations interactively
  if (flagged.length > 0) {
    console.log(`\n⚠ ${flagged.length} station(s) have significantly slower new times:\n`)

    for (const { feature, name, oldMins, newMins, newJourney } of flagged) {
      console.log(`  ${name}: was ${oldMins} min, now ${newMins} min (+${newMins - oldMins})`)
      const useNew = await askYesNo(`  Use new data? (y = new, n = keep old) `)

      if (useNew) {
        feature.properties.journeys[ORIGIN_COORD_KEY] = newJourney
        console.log(`  → Updated to ${newMins} min\n`)
      } else {
        console.log(`  → Kept old (${oldMins} min)\n`)
      }
    }

    // Save again with any accepted changes
    writeFileSync(STATIONS_PATH, JSON.stringify(stationData, null, 2))
  }

  console.log(
    `\nDone. Processed ${processed} stations, skipped ${skipped} already computed.`
  )
  if (flagged.length > 0) {
    console.log(`Resolved ${flagged.length} flagged station(s).`)
  }
}

main().catch(console.error)
