// Enriches stations.json with detailed journey data using the Google Maps
// Routes API (successor to the Directions API).
//
// Usage:
//   GOOGLE_MAPS_API_KEY=your_key node scripts/fetch-journeys.mjs --origin "Farringdon" --filter highlight
//
// Flags:
//   --origin "Station Name"  Origin station (looked up by name in stations.json). Required.
//   --station "Station Name" Process a single destination station only (by name).
//   --coordKey "lng,lat"     Process only the destination at this exact coordinate —
//                            use this instead of --station when two stations share a name.
//   --filter highlight       Only process stations with this rating (from station-ratings.json).
//                            Omit to process all non-excluded stations.
//   --recompute              Re-fetch even if journey data already exists for this origin.
//
// Safe to interrupt and re-run — already-computed stations are skipped.
// Journey data is stored per-origin, so running from different origins won't
// overwrite each other:
//
//   feature.properties.journeys = {
//     "Farringdon": { durationMinutes, departureTime, changes, legs, polyline },
//     "Blackfriars": { ... }
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

// Optional rating filter (e.g. "highlight", "verified")
const RATING_FILTER = getFlag("--filter")

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
const ORIGIN = { latitude: originLat, longitude: originLng }
console.log(
  `Origin: ${originFeature.properties.name} (${originLat}, ${originLng})`
)

// Origin stations are never treated as destinations — skip all of them, not
// just the one we're querying from. This list is the single source of truth
// for which stations are origins vs destinations.
const originStations = new Set(
  JSON.parse(readFileSync("data/origin-stations.json", "utf-8")).map(
    (n) => n.toLowerCase()
  )
)

if (!originStations.has(ORIGIN_NAME.toLowerCase())) {
  console.error(
    `Error: "${ORIGIN_NAME}" is not listed in data/origin-stations.json`
  )
  process.exit(1)
}

// Load ratings so we can filter by rating if --filter is set
const ratings = JSON.parse(readFileSync("data/station-ratings.json", "utf-8"))

if (RATING_FILTER) {
  console.log(`Filter: only "${RATING_FILTER}" stations`)
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
  const excluded = new Set(
    JSON.parse(readFileSync("data/excluded-stations.json", "utf-8"))
  )

  // Build the list of stations to process
  const candidates = stationData.features.filter((feature) => {
    const name = feature.properties.name ?? "Unknown"
    const [lng, lat] = feature.geometry.coordinates
    const coordKey = `${lng},${lat}`

    // Skip excluded stations (deliberately hidden from the map).
    // excluded-stations.json is now coordKey-only — unambiguous for stations with shared names.
    if (excluded.has(coordKey)) return false

    // Skip all origin stations — they're origins, not destinations
    if (originStations.has(name.toLowerCase())) return false

    // If --station is set, only include that specific station
    if (STATION_FILTER && name.toLowerCase() !== STATION_FILTER.toLowerCase()) {
      return false
    }

    // If --coordKey is set, only include the feature at that exact "lng,lat".
    // Needed when two stations share a name (e.g. three Whitchurches).
    if (COORD_KEY_FILTER && coordKey !== COORD_KEY_FILTER) return false

    // If --filter is set, only include stations that match the rating
    if (RATING_FILTER) {
      const stationRating = ratings[coordKey]?.rating
      if (stationRating !== RATING_FILTER) return false
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

    const existingJourney = feature.properties.journeys[ORIGIN_NAME] ?? null

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
      feature.properties.journeys[ORIGIN_NAME] = bestJourney
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
        feature.properties.journeys[ORIGIN_NAME] = newJourney
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
