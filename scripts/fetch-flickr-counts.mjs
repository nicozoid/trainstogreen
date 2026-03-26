// One-off script to enrich stations.json with a Flickr photo count per station.
// Queries the Flickr API for geotagged landscape photos within 7km of each station.
// The count is used on the map to size station circles — more photos = bigger dot.
//
// Run with:
//   node --env-file=.env.local scripts/fetch-flickr-counts.mjs
//
// Safe to interrupt and re-run — stations that already have a flickrCount are skipped.

import { readFileSync, writeFileSync } from "fs"

const API_KEY = process.env.NEXT_PUBLIC_FLICKR_API_KEY
if (!API_KEY) {
  console.error("Missing NEXT_PUBLIC_FLICKR_API_KEY — add it to .env.local")
  process.exit(1)
}

const RADIUS_KM = 7

// Must match SEARCH_TAGS in lib/flickr.ts
const TAGS =
  "countryside,landscape,view,greenery,hills,woods,forest,meadow,meadows,valley," +
  "hike,walk,trail,bridleway,byway,path,trek"

// These must match the filters in components/map.tsx exactly
const LONDON_CENTRE = { lat: 51.5203, lng: -0.1053 }
const MIN_DISTANCE_KM = 12

const EXCLUDED_STATIONS = new Set(
  JSON.parse(readFileSync("data/excluded-stations.json", "utf-8"))
)

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

// Only fetch for stations that will actually appear on the map
function isVisible(feature) {
  const [lng, lat] = feature.geometry.coordinates
  const coordKey = `${lng},${lat}`
  return (
    feature.properties["ref:crs"] != null &&
    distanceFromLondon(lat, lng) >= MIN_DISTANCE_KM &&
    !EXCLUDED_STATIONS.has(feature.properties.name) &&
    !EXCLUDED_STATIONS.has(coordKey)
  )
}

// Only fetch for National Rail stations (ref:crs = CRS station code)
function isNationalRail(feature) {
  return feature.properties["ref:crs"] != null
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

async function fetchCount(lat, lng) {
  const params = new URLSearchParams({
    method: "flickr.photos.search",
    api_key: API_KEY,
    lat: String(lat),
    lon: String(lng),
    radius: String(RADIUS_KM),
    radius_units: "km",
    tags: TAGS,
    tag_mode: "any",
    per_page: "1",   // only need the total, not the photos
    format: "json",
    nojsoncallback: "1",
  })

  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const res = await fetch(`https://www.flickr.com/services/rest/?${params}`)
      if (!res.ok) {
        console.warn(`    attempt ${attempt} failed: HTTP ${res.status}`)
        await sleep(3000 * attempt)
        continue
      }
      const data = await res.json()
      if (data.stat !== "ok") {
        console.warn(`    attempt ${attempt} Flickr error: ${data.message}`)
        await sleep(3000 * attempt)
        continue
      }
      return parseInt(data.photos?.total ?? "0", 10)
    } catch (err) {
      console.warn(`    attempt ${attempt} error: ${err.message}`)
      await sleep(3000 * attempt)
    }
  }

  return null // all attempts failed
}

async function main() {
  const filePath = "public/stations.json"
  const data = JSON.parse(readFileSync(filePath, "utf-8"))

  const targets = data.features.filter(isVisible)
  const total = targets.length
  let processed = 0
  let skipped = 0

  console.log(`${total} visible stations to process (excluded and inner-London stations skipped)`)
  console.log(`(non-visible stations will be set to flickrCount: 0)\n`)

  // Set non-visible stations to 0 upfront so the field always exists
  for (const feature of data.features) {
    if (!isVisible(feature)) {
      feature.properties.flickrCount = 0
    }
  }

  for (const feature of data.features) {
    if (!isVisible(feature)) continue

    const name = feature.properties.name ?? "Unknown"

    // Skip if already fetched — allows safe resume after interruption
    if (feature.properties.flickrCount != null) {
      skipped++
      continue
    }

    const [lng, lat] = feature.geometry.coordinates
    const count = await fetchCount(lat, lng)
    feature.properties.flickrCount = count

    processed++
    const pct = Math.round(((processed + skipped) / total) * 100)
    console.log(`[${pct}%] ${name}: ${count ?? "FAILED"} photos`)

    // Save progress every 10 stations so we don't lose work if interrupted
    if (processed % 10 === 0) {
      writeFileSync(filePath, JSON.stringify(data))
    }

    // Flickr API rate limit: ~1 req/sec for API key auth — 1.2s gives comfortable headroom
    await sleep(1200)
  }

  writeFileSync(filePath, JSON.stringify(data))
  console.log(`\nDone. Processed ${processed}, skipped ${skipped} already computed.`)
}

main().catch(console.error)
