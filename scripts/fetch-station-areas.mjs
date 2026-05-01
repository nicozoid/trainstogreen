#!/usr/bin/env node
/**
 * Enrich public/stations.json with county + protected-area metadata.
 *
 * Data sources:
 *   - Counties: postcodes.io bulk reverse geocoding (free, fast)
 *   - National Parks: ONS Open Geography Portal (BUC boundaries)
 *   - AONBs / National Landscapes: DEFRA WFS (Natural England)
 *   - Historic Counties: Historic County Borders Project (HCBP), provided by
 *     the Historic Counties Trust — https://www.county-borders.co.uk
 *     (Definition A, WGS84 full resolution, simplified to ~5% with mapshaper.)
 *
 * National park / AONB boundary files are cached in data/boundaries/. If
 * missing, the script downloads them automatically (requires network).
 * The historic-counties file is checked into the repo (HCBP has no public
 * download URL).
 *
 * Usage: node scripts/fetch-station-areas.mjs
 */

import fs from "node:fs/promises"
import path from "node:path"
import { fileURLToPath } from "node:url"
import booleanPointInPolygon from "@turf/boolean-point-in-polygon"
import { point } from "@turf/helpers"

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
const BOUNDARIES_DIR = path.join(REPO_ROOT, "data", "boundaries")
const STATIONS_PATH = path.join(REPO_ROOT, "public", "stations.json")

const NP_URL =
  "https://services1.arcgis.com/ESMARspQHYMw9BZ9/arcgis/rest/services/" +
  "National_Parks_August_2016_Boundaries_GB_BUC_2022/FeatureServer/0/" +
  "query?where=1%3D1&outFields=NPARK15NM&f=geojson"

const AONB_URL =
  "https://environment.data.gov.uk/spatialdata/" +
  "areas-of-outstanding-natural-beauty-england/wfs?" +
  "service=WFS&version=2.0.0&request=GetFeature&" +
  "typeNames=dataset-0c1ea47f-3c79-47f0-b0ed-094e0a136971:" +
  "Areas_of_Outstanding_Natural_Beauty_England&" +
  "outputFormat=GEOJSON&srsName=EPSG:4326"

// ---------------------------------------------------------------------------

async function ensureBoundary(filename, url) {
  const filePath = path.join(BOUNDARIES_DIR, filename)
  try {
    await fs.access(filePath)
  } catch {
    console.log(`Downloading ${filename}...`)
    const resp = await fetch(url)
    if (!resp.ok) throw new Error(`Failed to fetch ${filename}: ${resp.status}`)
    await fs.mkdir(BOUNDARIES_DIR, { recursive: true })
    await fs.writeFile(filePath, Buffer.from(await resp.arrayBuffer()))
    console.log(`  saved ${filename}`)
  }
  return JSON.parse(await fs.readFile(filePath, "utf-8"))
}

function loadAreas(geojson, nameField, cleanName) {
  return geojson.features.map((f) => ({
    name: cleanName ? cleanName(f.properties[nameField]) : f.properties[nameField],
    geometry: f.geometry,
  }))
}

// Clean up national park display names
function cleanParkName(raw) {
  return raw
    .replace(/ National Park$/, "")
    .replace(/^The Broads Authority$/, "The Broads")
}

// Unitary authorities → ceremonial county. postcodes.io returns the UA name
// as admin_district when admin_county is null; this map resolves the UA back
// to the county most people would recognise.
const UA_TO_COUNTY = {
  // South-East / Home Counties
  "Medway": "Kent",
  "Brighton and Hove": "East Sussex",
  "Milton Keynes": "Buckinghamshire",
  "Reading": "Berkshire",
  "Slough": "Berkshire",
  "West Berkshire": "Berkshire",
  "Windsor and Maidenhead": "Berkshire",
  "Wokingham": "Berkshire",
  "Bracknell Forest": "Berkshire",
  "Portsmouth": "Hampshire",
  "Southampton": "Hampshire",
  "Southend-on-Sea": "Essex",
  "Thurrock": "Essex",
  "Luton": "Bedfordshire",
  "Central Bedfordshire": "Bedfordshire",
  "Bedford": "Bedfordshire",
  "Peterborough": "Cambridgeshire",
  // South-West
  "Plymouth": "Devon",
  "Torbay": "Devon",
  "Swindon": "Wiltshire",
  "Bath and North East Somerset": "Somerset",
  "North Somerset": "Somerset",
  "South Gloucestershire": "Gloucestershire",
  "Bournemouth, Christchurch and Poole": "Dorset",
  // Midlands
  "Stoke-on-Trent": "Staffordshire",
  "Telford and Wrekin": "Shropshire",
  "Derby": "Derbyshire",
  "Nottingham": "Nottinghamshire",
  "Leicester": "Leicestershire",
  "Rutland": "Rutland",
  "North Northamptonshire": "Northamptonshire",
  "West Northamptonshire": "Northamptonshire",
  "Herefordshire, County of": "Herefordshire",
  "Herefordshire": "Herefordshire",
  // North
  "York": "North Yorkshire",
  "Darlington": "County Durham",
  "Hartlepool": "County Durham",
  "Stockton-on-Tees": "County Durham",
  "Middlesbrough": "North Yorkshire",
  "Redcar and Cleveland": "North Yorkshire",
  "Kingston upon Hull, City of": "East Riding of Yorkshire",
  "North East Lincolnshire": "Lincolnshire",
  "North Lincolnshire": "Lincolnshire",
  "Blackburn with Darwen": "Lancashire",
  "Blackpool": "Lancashire",
  "Warrington": "Cheshire",
  "Halton": "Cheshire",
  "Cheshire East": "Cheshire",
  "Cheshire West and Chester": "Cheshire",
  // Metropolitan boroughs → metropolitan counties
  "Bolton": "Greater Manchester", "Bury": "Greater Manchester",
  "Manchester": "Greater Manchester", "Oldham": "Greater Manchester",
  "Rochdale": "Greater Manchester", "Salford": "Greater Manchester",
  "Stockport": "Greater Manchester", "Tameside": "Greater Manchester",
  "Trafford": "Greater Manchester", "Wigan": "Greater Manchester",
  "Barnsley": "South Yorkshire", "Doncaster": "South Yorkshire",
  "Rotherham": "South Yorkshire", "Sheffield": "South Yorkshire",
  "Bradford": "West Yorkshire", "Calderdale": "West Yorkshire",
  "Kirklees": "West Yorkshire", "Leeds": "West Yorkshire",
  "Wakefield": "West Yorkshire",
  "Gateshead": "Tyne and Wear", "Newcastle upon Tyne": "Tyne and Wear",
  "North Tyneside": "Tyne and Wear", "South Tyneside": "Tyne and Wear",
  "Sunderland": "Tyne and Wear",
  "Knowsley": "Merseyside", "Liverpool": "Merseyside",
  "St. Helens": "Merseyside", "Sefton": "Merseyside", "Wirral": "Merseyside",
  "Birmingham": "West Midlands", "Coventry": "West Midlands",
  "Dudley": "West Midlands", "Sandwell": "West Midlands",
  "Solihull": "West Midlands", "Walsall": "West Midlands",
  "Wolverhampton": "West Midlands",
}

// ---------------------------------------------------------------------------

async function fetchCounties(features) {
  const BATCH = 100
  const results = new Map()

  for (let i = 0; i < features.length; i += BATCH) {
    const batch = features.slice(i, i + BATCH)
    const geolocations = batch.map((f) => ({
      longitude: f.geometry.coordinates[0],
      latitude: f.geometry.coordinates[1],
      radius: 2000,
      limit: 1,
    }))

    const resp = await fetch("https://api.postcodes.io/postcodes", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ geolocations }),
    })
    if (!resp.ok) throw new Error(`postcodes.io error: ${resp.status}`)
    const data = await resp.json()

    for (let j = 0; j < batch.length; j++) {
      const hit = data.result[j]?.result?.[0]
      if (!hit) continue
      const district = hit.admin_district ?? ""
      const county =
        hit.admin_county ||
        (hit.region === "London" ? "London" : null) ||
        UA_TO_COUNTY[district] ||
        district ||
        null
      if (county) {
        const ck = `${batch[j].geometry.coordinates[0]},${batch[j].geometry.coordinates[1]}`
        // `country` is one of "England", "Wales", "Scotland", "Northern Ireland".
        // Used by the UI to decide between "Modern ceremonial: X" (Eng/Wales)
        // and "Unitary authority: X" (Scotland) labels alongside the historic name.
        results.set(ck, { county, country: hit.country ?? null })
      }
    }

    const done = Math.min(i + BATCH, features.length)
    process.stdout.write(`\r  counties: ${done}/${features.length}`)
  }
  process.stdout.write("\n")
  return results
}

// ---------------------------------------------------------------------------

async function main() {
  const stationsData = JSON.parse(await fs.readFile(STATIONS_PATH, "utf-8"))
  const features = stationsData.features
  console.log(`Loaded ${features.length} stations`)

  // Load / download boundaries
  const npData = await ensureBoundary("national-parks.geojson", NP_URL)
  const nationalParks = loadAreas(npData, "NPARK15NM", cleanParkName)
  console.log(`${nationalParks.length} national parks`)

  const aonbData = await ensureBoundary("aonb.geojson", AONB_URL)
  const aonbs = loadAreas(aonbData, "name")
  console.log(`${aonbs.length} AONBs / National Landscapes`)

  // Historic counties — no URL fallback, file is committed to the repo.
  const historicPath = path.join(BOUNDARIES_DIR, "historic-counties.geojson")
  const historicData = JSON.parse(await fs.readFile(historicPath, "utf-8"))
  const historicCounties = loadAreas(historicData, "NAME")
  console.log(`${historicCounties.length} historic counties`)

  // Protected-area tagging (local point-in-polygon)
  let npHits = 0
  let aonbHits = 0
  for (const f of features) {
    const pt = point(f.geometry.coordinates)

    // National parks first (higher designation)
    let matched = false
    for (const park of nationalParks) {
      if (booleanPointInPolygon(pt, park.geometry)) {
        f.properties.protectedArea = park.name
        f.properties.protectedAreaType = "national_park"
        npHits++
        matched = true
        break
      }
    }
    if (matched) continue

    for (const aonb of aonbs) {
      if (booleanPointInPolygon(pt, aonb.geometry)) {
        f.properties.protectedArea = aonb.name
        f.properties.protectedAreaType = "national_landscape"
        aonbHits++
        break
      }
    }
  }
  console.log(`Protected areas — national parks: ${npHits}, AONBs: ${aonbHits}`)

  // County tagging via postcodes.io
  console.log("Fetching counties from postcodes.io...")
  const counties = await fetchCounties(features)
  let countyHits = 0
  for (const f of features) {
    const ck = `${f.geometry.coordinates[0]},${f.geometry.coordinates[1]}`
    const entry = counties.get(ck)
    if (entry) {
      f.properties.county = entry.county
      if (entry.country) f.properties.country = entry.country
      countyHits++
    }
  }
  console.log(`Counties assigned: ${countyHits}/${features.length}`)

  // Historic-county tagging (local point-in-polygon, same pattern as parks/AONBs)
  let historicHits = 0
  for (const f of features) {
    const pt = point(f.geometry.coordinates)
    for (const hc of historicCounties) {
      if (booleanPointInPolygon(pt, hc.geometry)) {
        f.properties.historicCounty = hc.name
        historicHits++
        break
      }
    }
  }
  console.log(`Historic counties assigned: ${historicHits}/${features.length}`)

  // Write back
  await fs.writeFile(STATIONS_PATH, JSON.stringify(stationsData))
  console.log(`Written → public/stations.json`)
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
