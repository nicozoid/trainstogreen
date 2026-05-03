#!/usr/bin/env node
// Rekeys data/origin-routes.json from coordKey to station ID at both
// outer and inner (directReachable) levels. Each entry already has a
// `crs` field embedded — that's the new outer key. Inner entries
// likewise have their own `crs`. Idempotent.

import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(__dirname, "..")

const filePath = path.join(ROOT, "data/origin-routes.json")
const data = JSON.parse(fs.readFileSync(filePath, "utf8"))

const out = {}
const orphans = []
let outerTranslated = 0
let innerTranslated = 0

for (const [outerKey, entry] of Object.entries(data)) {
  // Already migrated entries (key has no comma) pass through.
  const outerId = outerKey.includes(",") ? entry.crs : outerKey
  if (!outerId) {
    orphans.push(`outer ${outerKey} has no embedded crs`)
    continue
  }
  if (outerKey.includes(",")) outerTranslated++
  const innerOut = {}
  for (const [innerKey, dest] of Object.entries(entry.directReachable ?? {})) {
    const innerId = innerKey.includes(",") ? dest.crs : innerKey
    if (!innerId) {
      orphans.push(`${outerId} → inner ${innerKey} has no embedded crs`)
      continue
    }
    if (innerKey.includes(",")) innerTranslated++
    innerOut[innerId] = dest
  }
  // Keep inner keys sorted for stable diffs.
  out[outerId] = {
    ...entry,
    directReachable: Object.fromEntries(
      Object.entries(innerOut).sort(([a], [b]) => a.localeCompare(b)),
    ),
  }
}

if (orphans.length) {
  console.error(`Could not migrate ${orphans.length} entries:`)
  for (const o of orphans.slice(0, 20)) console.error(`  ${o}`)
  process.exit(1)
}

const sorted = Object.fromEntries(Object.entries(out).sort(([a], [b]) => a.localeCompare(b)))
fs.writeFileSync(filePath, JSON.stringify(sorted, null, 2) + "\n")
console.log(`origin-routes.json: ${Object.keys(sorted).length} origins, translated ${outerTranslated} outer + ${innerTranslated} inner keys`)
