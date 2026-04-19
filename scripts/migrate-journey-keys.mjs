#!/usr/bin/env node
// One-shot migration: rewrite every feature.properties.journeys in public/stations.json
// from name-keyed (e.g. "Farringdon") to coord-keyed ("lng,lat") form.
// Run once, then commit.

import { readFileSync, writeFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { dirname, join } from "node:path"

const __dirname = dirname(fileURLToPath(import.meta.url))
const REPO = join(__dirname, "..")

// Only these 5 names ever appear as journey keys in current data.
const NAME_TO_COORD = {
  "Farringdon": "-0.104555,51.519964",
  "Kings Cross St Pancras": "-0.1239491,51.530609",
  "Stratford": "-0.0035472,51.541289",
  "Birmingham New Street": "-1.898694,52.4776459",
  "Nottingham": "-1.1449555,52.9473037",
}

const path = join(REPO, "public/stations.json")
const data = JSON.parse(readFileSync(path, "utf8"))

let featuresChanged = 0
let keysRenamed = 0
const unknownKeys = new Set()

for (const feature of data.features) {
  const j = feature.properties?.journeys
  if (!j || typeof j !== "object") continue

  const next = {}
  let changedThisFeature = false
  for (const [k, v] of Object.entries(j)) {
    if (k.includes(",")) {
      // Already a coord key — preserve untouched.
      next[k] = v
    } else if (NAME_TO_COORD[k]) {
      next[NAME_TO_COORD[k]] = v
      keysRenamed++
      changedThisFeature = true
    } else {
      // Unknown key — preserve untouched so we spot it.
      unknownKeys.add(k)
      next[k] = v
    }
  }
  if (changedThisFeature) {
    feature.properties.journeys = next
    featuresChanged++
  }
}

if (unknownKeys.size > 0) {
  console.warn("Preserved unknown journey keys (add to NAME_TO_COORD if needed):", [...unknownKeys])
}

writeFileSync(path, JSON.stringify(data, null, 2) + "\n")
console.log(`Updated ${featuresChanged} features, renamed ${keysRenamed} journey keys`)
