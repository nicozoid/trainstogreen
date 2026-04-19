#!/usr/bin/env node
// One-shot migration: rewrite data/origin-stations.json from name[] to "lng,lat" coord[].
// Run once, then commit. Kept in the repo for auditability.

import { readFileSync, writeFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { dirname, join } from "node:path"

const __dirname = dirname(fileURLToPath(import.meta.url))
const REPO = join(__dirname, "..")

// Canonical name → "lng,lat" coord key. Resolved from public/stations.json by
// picking the National Rail entry where one exists, else the only entry.
// For "Charing Cross" we pin the London station explicitly (Glasgow's NR entry
// shares the exact same name — that's the whole reason for this migration).
const NAME_TO_COORD = {
  "Farringdon": "-0.104555,51.519964",
  "Kings Cross St Pancras": "-0.1239491,51.530609",
  "Birmingham New Street": "-1.898694,52.4776459",
  "Nottingham": "-1.1449555,52.9473037",
  "Manchester Piccadilly": "-2.2301402,53.4772197",
  "Liverpool Lime Street": "-2.9775854,53.4076085",
  "Sheffield": "-1.4621381,53.3783713",
  "Leicester": "-1.1236065,52.6321088",
  "Rotherham Central": "-1.3610462,53.4316986",
  "Cardiff Central": "-3.1797057,51.4755495",
  "Newport (Wales)": "-3.000425,51.5887675",
  "Bristol Parkway": "-2.542979,51.5138815",
  "Bristol Temple Meads": "-2.5804029,51.4490991",
  "Bournemouth": "-1.8641943,50.7272094",
  "Southampton Central": "-1.4142289,50.9074977",
  "Portsmouth and Southsea": "-1.0906787,50.7982014",
  "Milton Keynes Central": "-0.7748261,52.0342006",
  "Stratford": "-0.0035472,51.541289",
  "Coventry": "-1.5135474,52.400739",
  "Wolverhampton": "-2.120242,52.5879884",
  "Derby": "-1.462612,52.9165243",
  "Stoke-on-Trent": "-2.1810781,53.0079887",
  "Chesterfield": "-1.4197283,53.2382236",
  "London Liverpool Street": "-0.0814269,51.5182105",
  "Charing Cross": "-0.1236888,51.5074975", // London, not Glasgow
  "London Bridge": "-0.0851473,51.5048764",
  "London Waterloo": "-0.112801,51.5028379",
}

const path = join(REPO, "data/origin-stations.json")
const names = JSON.parse(readFileSync(path, "utf8"))

const coords = []
const unresolved = []
for (const name of names) {
  const coord = NAME_TO_COORD[name]
  if (coord) coords.push(coord)
  else unresolved.push(name)
}

if (unresolved.length > 0) {
  console.error(`Unresolved names (add to NAME_TO_COORD):`, unresolved)
  process.exit(1)
}

writeFileSync(path, JSON.stringify(coords, null, 2) + "\n")
console.log(`Migrated ${coords.length} origin names → coord keys`)
