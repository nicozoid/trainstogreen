// One-off script to enrich stations.json with a hiking route popularity score.
// Queries Overpass API (free, no key needed) to count named OSM hiking route
// relations within 10km of each station.
//
// OSM "route=hiking" relations are curated named routes (e.g. "North Downs Way",
// "Greensand Way") — a strong proxy for how popular an area is for walking,
// since volunteers only map routes that people actually use.
//
// Run with: node scripts/fetch-popularity-scores.mjs
//
// Safe to interrupt and re-run — already-computed stations are skipped.

import { readFileSync, writeFileSync } from "fs"

const RADIUS_METRES = 10000 // 10km — wider than trailScore to capture routes passing nearby

// These must match the filters in components/map.tsx exactly
const LONDON_CENTRE = { lat: 51.5203, lng: -0.1053 }
const MIN_DISTANCE_KM = 12

const EXCLUDED_STATIONS = new Set([
  "Anerley", "East Croydon", "Northwick Park", "Harrow & Wealdstone",
  "Queensbury", "Burnt Oak", "Colindale", "Kingsbury", "Kenton",
  "Harrow-on-the-Hill", "West Harrow", "Rayners Lane", "Pinner",
  "Winchmore Hill", "Southgate", "Oakleigh Park", "New Barnet",
  "Southbury", "Bush Hill Park", "Enfield Town", "Grange Park",
  "Dagenham Dock", "Becontree", "Dagenham Heathway", "Upney",
])

function distanceFromLondon(lat, lng) {
  const R = 6371
  const dLat = ((lat - LONDON_CENTRE.lat) * Math.PI) / 180
  const dLng = ((lng - LONDON_CENTRE.lng) * Math.PI) / 180
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos((LONDON_CENTRE.lat * Math.PI) / 180) *
      Math.cos((lat * Math.PI) / 180) *
      Math.sin(dLng / 2) ** 2
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a))
}

function isVisible(feature) {
  const [lng, lat] = feature.geometry.coordinates
  const mins = feature.properties.londonMinutes
  return (
    distanceFromLondon(lat, lng) >= MIN_DISTANCE_KM &&
    !EXCLUDED_STATIONS.has(feature.properties.name) &&
    mins != null && mins > 30
  )
}

// Multiple public Overpass instances — rotate through them to avoid rate limits
const OVERPASS_ENDPOINTS = [
  "https://overpass-api.de/api/interpreter",
  "https://overpass.kumi.systems/api/interpreter",
  "https://maps.mail.ru/osm/tools/overpass/api/interpreter",
]
let endpointIndex = 0
function nextEndpoint() {
  const url = OVERPASS_ENDPOINTS[endpointIndex % OVERPASS_ENDPOINTS.length]
  endpointIndex++
  return url
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

// Count OSM hiking route relations within the given radius.
// route=hiking covers named walking routes (long-distance paths, local trails).
// Retries up to 3 times on failure. Returns null if all attempts fail.
async function getPopularityScore(lat, lng) {
  // relation(around:...)  — relations within radius of lat/lng
  // [route=hiking]        — only hiking route relations (not cycling, bus, etc.)
  // out count             — return just the count, not full geometry
  const query = `
    [out:json][timeout:60];
    relation(around:${RADIUS_METRES},${lat},${lng})[route=hiking];
    out count;
  `

  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const res = await fetch(nextEndpoint(), {
        method: "POST",
        body: "data=" + encodeURIComponent(query),
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
      })

      if (!res.ok) {
        console.warn(`    attempt ${attempt} failed: HTTP ${res.status}`)
        await sleep(5000 * attempt)
        continue
      }

      const data = await res.json()
      return parseInt(data.elements?.[0]?.tags?.relations ?? "0", 10)
    } catch (err) {
      console.warn(`    attempt ${attempt} error: ${err.message}`)
      await sleep(5000 * attempt)
    }
  }

  return null
}

async function main() {
  const filePath = "public/stations.json"
  const data = JSON.parse(readFileSync(filePath, "utf-8"))

  const total = data.features.length
  let processed = 0
  let skipped = 0

  for (const feature of data.features) {
    const name = feature.properties.name ?? "Unknown"

    // Skip stations that are never shown on the map
    if (!isVisible(feature)) {
      skipped++
      continue
    }

    // Skip stations that already have a popularity score (allows resuming)
    if (feature.properties.popularityScore != null) {
      skipped++
      continue
    }

    const [lng, lat] = feature.geometry.coordinates
    const count = await getPopularityScore(lat, lng)
    feature.properties.popularityScore = count

    processed++
    const pct = Math.round(((processed + skipped) / total) * 100)
    console.log(`[${pct}%] ${name}: ${count ?? "FAILED"} hiking routes`)

    // Save progress every 5 stations so we don't lose work if interrupted
    if (processed % 5 === 0) {
      writeFileSync(filePath, JSON.stringify(data, null, 2))
    }

    // Polite delay between requests — Overpass is a shared public service
    await sleep(3000)
  }

  // Final save
  writeFileSync(filePath, JSON.stringify(data, null, 2))
  console.log(`\nDone. Processed ${processed} stations, skipped ${skipped} already computed.`)
}

main().catch(console.error)
