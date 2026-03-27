// One-off script to enrich stations.json with journey times from London.
// Run with: GOOGLE_MAPS_API_KEY=your_key node scripts/fetch-journey-times.mjs
//
// Safe to interrupt and re-run — already-computed stations are skipped.
// Pass --recompute to force all stations to be re-fetched (e.g. after changing the methodology).

import { readFileSync, writeFileSync } from "fs"

const API_KEY = process.env.GOOGLE_MAPS_API_KEY
// --recompute flag clears existing londonMinutes so all stations are re-fetched
const RECOMPUTE = process.argv.includes("--recompute")

if (!API_KEY) {
  console.error("Error: set GOOGLE_MAPS_API_KEY environment variable")
  process.exit(1)
}

// Farringdon Station — central, equidistant from most London termini
const ORIGIN = "51.5203,-0.1053"

// Returns Unix timestamps for Saturday 4 July 2026 at each time in the departure window.
// We query multiple departure times so we catch the fastest train, not just the first.
// Date is hardcoded to avoid accidentally running on a disrupted weekend (e.g. engineering works).
function getDepartureWindow() {
  // Query every 15 minutes from 09:30 to 10:30 — 5 departure times total
  const times = [
    [9, 30],
    [9, 45],
    [10, 0],
    [10, 15],
    [10, 30],
  ]

  return times.map(([h, m]) => {
    // Month is 0-indexed in JS: 6 = July
    const d = new Date(2026, 6, 4, h, m, 0, 0)
    return Math.floor(d.getTime() / 1000)
  })
}

const DEPARTURE_WINDOW = getDepartureWindow()
console.log(`Querying ${DEPARTURE_WINDOW.length} departure times per station:`)
DEPARTURE_WINDOW.forEach((t) => console.log(`  ${new Date(t * 1000).toUTCString()}`))
console.log()

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

// Query Google Maps for a single departure time. Returns journey minutes or null.
async function queryJourneyMinutes(lat, lng, departureTime) {
  const url =
    `https://maps.googleapis.com/maps/api/directions/json` +
    `?origin=${ORIGIN}` +
    `&destination=${lat},${lng}` +
    `&mode=transit` +
    `&transit_mode=rail` +
    `&departure_time=${departureTime}` +
    `&key=${API_KEY}`

  // Retry up to 3 times on network errors (e.g. ECONNRESET) with exponential backoff
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const res = await fetch(url)
      const data = await res.json()

      if (data.status !== "OK" || !data.routes.length) return null

      const totalSeconds = data.routes[0].legs.reduce(
        (sum, leg) => sum + leg.duration.value,
        0
      )
      return Math.round(totalSeconds / 60)
    } catch (err) {
      if (attempt < 2) {
        const delay = 1000 * 2 ** attempt // 1s, then 2s
        console.warn(`  Network error, retrying in ${delay / 1000}s... (${err.message})`)
        await sleep(delay)
      }
    }
  }
  return null
}

// Query all departure times in the window and return the shortest journey found.
// This ensures we capture the fastest available train, not just whichever one
// Google happens to return for a single departure time.
async function getFastestJourneyMinutes(lat, lng) {
  const results = []

  for (const departureTime of DEPARTURE_WINDOW) {
    const minutes = await queryJourneyMinutes(lat, lng, departureTime)
    if (minutes != null) results.push(minutes)
    await sleep(150) // stay within Google's rate limits between each sub-query
  }

  return results.length > 0 ? Math.min(...results) : null
}

async function main() {
  const filePath = "public/stations.json"
  const data = JSON.parse(readFileSync(filePath, "utf-8"))
  const excluded = new Set(JSON.parse(readFileSync("data/excluded-stations.json", "utf-8")))

  const total = data.features.length
  let processed = 0
  let skipped = 0

  for (const feature of data.features) {
    const name = feature.properties.name ?? "Unknown"

    // Skip excluded stations entirely — no point computing journey times for them
    if (excluded.has(name)) {
      skipped++
      continue
    }

    // Skip stations that already have a journey time (allows resuming),
    // unless --recompute was passed to force a full refresh
    if (!RECOMPUTE && feature.properties.londonMinutes != null) {
      skipped++
      continue
    }

    const [lng, lat] = feature.geometry.coordinates
    const minutes = await getFastestJourneyMinutes(lat, lng)
    feature.properties.londonMinutes = minutes

    processed++
    const pct = Math.round(((processed + skipped) / total) * 100)
    console.log(`[${pct}%] ${name}: ${minutes ?? "no route found"} min`)

    // Save progress every 10 stations so we don't lose work if interrupted
    if (processed % 10 === 0) {
      writeFileSync(filePath, JSON.stringify(data, null, 2))
    }

    // Small delay to stay well within Google's rate limits
    await sleep(150)
  }

  // Final save
  writeFileSync(filePath, JSON.stringify(data, null, 2))
  console.log(`\nDone. Processed ${processed} stations, skipped ${skipped} already computed.`)
}

main().catch(console.error)
