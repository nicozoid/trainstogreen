#!/usr/bin/env node
/**
 * Split the fat public/stations.json into:
 *   - a slim public/stations.json (OSM + routing metadata only, no journeys)
 *   - public/journeys/<origin-key>.json, one per pre-fetched Google Routes
 *     origin
 *
 * The original 27.5 MB file inlines 5 origin × ~3k destination journey
 * dictionaries, each with its own polyline blob. Most page loads (Central
 * London home, no friend) need zero of that data — the runtime can
 * lazy-load individual origin files only when the user picks that origin as
 * friend, or switches home to a Routes-API primary.
 *
 * Input:  public/stations.json (current fat file)
 * Outputs:
 *   - public/stations.json (overwritten with slim version)
 *   - data/stations.fat.json (backup of the original, so future journey
 *     regenerations can rebuild from a reference copy)
 *   - public/journeys/{farringdon,kings-cross,stratford,nottingham,
 *     birmingham}.json
 *
 * Usage: node scripts/split-stations.mjs
 */

import fs from "node:fs/promises"
import path from "node:path"
import { fileURLToPath } from "node:url"

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")

// Map each known pre-fetched Google Routes origin coordKey to a filename-
// friendly slug. Any origin in baseStations.journeys that isn't listed here
// still gets split out into a file — we just fall back to a sanitised form
// of the coord itself.
const ORIGIN_SLUG = {
  "-0.104555,51.519964": "farringdon",
  "-0.1239491,51.530609": "kings-cross",
  "-0.0035472,51.541289": "stratford",
  "-1.1449555,52.9473037": "nottingham",
  "-1.898694,52.4776459": "birmingham",
}

// Feature-level properties the runtime actually reads. Everything else is
// dead OSM metadata that bloats the file without UI purpose. Keep this in
// sync with how the app consumes f.properties in components/.
const KEEP_PROPS = new Set([
  "name",            // station name, shown everywhere
  "ref:crs",         // CRS code — London-terminal matching, RTT lookups
  "network",         // filter: London Underground vs DLR vs NR
  "usage",           // filter: exclude `usage=tourism` heritage railways
  "londonMinutes",   // default home-journey time from Central London
  "flickrCount",     // photo modal availability indicator
  "popularityScore", // rating / filter
  "trailScore",      // rating / filter
])

async function main() {
  const fatPath = path.join(REPO_ROOT, "public", "stations.json")
  const rawFat = await fs.readFile(fatPath, "utf-8")
  const fat = JSON.parse(rawFat)

  console.log(`Read ${rawFat.length.toLocaleString()} bytes from public/stations.json`)
  console.log(`  features: ${fat.features.length}`)

  const journeysByOrigin = {}

  const slimFeatures = fat.features.map((f) => {
    const slimProps = {}
    for (const [k, v] of Object.entries(f.properties)) {
      if (KEEP_PROPS.has(k)) slimProps[k] = v
    }
    const journeys = f.properties.journeys
    if (journeys) {
      const [lng, lat] = f.geometry.coordinates
      const coordKey = `${lng},${lat}`
      for (const [originCoord, entry] of Object.entries(journeys)) {
        if (!journeysByOrigin[originCoord]) journeysByOrigin[originCoord] = {}
        journeysByOrigin[originCoord][coordKey] = entry
      }
    }
    return { type: f.type, geometry: f.geometry, properties: slimProps }
  })

  // Only rewrite the backup if the current public/stations.json still has
  // journeys inlined (i.e. we're running the split on a fat source). If the
  // public file is already slim, leave the existing backup alone.
  const alreadySlim = fat.features.every((f) => !f.properties.journeys)
  const backupPath = path.join(REPO_ROOT, "data", "stations.fat.json")
  await fs.mkdir(path.dirname(backupPath), { recursive: true })
  if (!alreadySlim) {
    await fs.writeFile(backupPath, rawFat, "utf-8")
    console.log(`Wrote backup → ${path.relative(REPO_ROOT, backupPath)} (${rawFat.length.toLocaleString()} bytes)`)
  }

  const slim = { ...fat, features: slimFeatures }
  const slimStr = JSON.stringify(slim)
  await fs.writeFile(fatPath, slimStr, "utf-8")
  console.log(`Wrote slim → ${path.relative(REPO_ROOT, fatPath)} (${slimStr.length.toLocaleString()} bytes, ${(slimStr.length/1024/1024).toFixed(2)} MB)`)

  const journeysDir = path.join(REPO_ROOT, "public", "journeys")
  await fs.mkdir(journeysDir, { recursive: true })

  for (const [originCoord, map] of Object.entries(journeysByOrigin)) {
    const slug = ORIGIN_SLUG[originCoord] ?? originCoord.replace(/[^a-z0-9-]/gi, "_")
    const outPath = path.join(journeysDir, `${slug}.json`)
    const body = JSON.stringify({ origin: originCoord, journeys: map })
    await fs.writeFile(outPath, body, "utf-8")
    const entries = Object.keys(map).length
    console.log(`  journeys/${slug}.json → ${(body.length/1024/1024).toFixed(2)} MB, ${entries} destinations`)
  }
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
