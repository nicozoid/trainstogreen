// One-shot: migrate the legacy `name` field on walk variants into a
// cleaner split between derivable titles (empty name, optional
// `suffix`) and legacy overrides (full `name` preserved).
//
// For each station-to-station variant with resolvable CRS codes:
//
//   name === "Main Walk"                    → clear name
//   name === "{start} to {end}"             → clear name
//   name === "{start} circular"             → clear name
//   name === "{start} to {end} <tail>"      → clear name, suffix = <tail>
//   name === "{start} circular <tail>"      → clear name, suffix = <tail>
//   everything else                         → leave name as-is (legacy override)
//
// After this runs, the renderer can derive titles from station names
// + suffix, falling back to `name` when present (legacy overrides).
//
// Idempotent: a variant already lacking `name` (or with a matching
// suffix) stays untouched.
//
// Usage:
//   node scripts/backfill-walk-suffix.mjs --dry-run
//   node scripts/backfill-walk-suffix.mjs

import { readFileSync, writeFileSync } from "fs"
import { fileURLToPath } from "url"
import { dirname, join } from "path"

const __dirname = dirname(fileURLToPath(import.meta.url))
const PROJECT_ROOT = join(__dirname, "..")

const WALKS_FILES = ["data/walks.json"]

function parseArgs(argv) {
  return { dryRun: argv.includes("--dry-run") }
}

function buildCrsIndex() {
  const stations = JSON.parse(
    readFileSync(join(PROJECT_ROOT, "public", "stations.json"), "utf-8"),
  )
  const map = new Map()
  for (const f of stations.features) {
    const crs = f.properties?.["ref:crs"]
    const name = f.properties?.name
    if (crs && name) map.set(crs, name)
  }
  return map
}

function main() {
  const args = parseArgs(process.argv.slice(2))
  const crsName = buildCrsIndex()

  const loaded = WALKS_FILES.map((rel) => {
    const full = join(PROJECT_ROOT, rel)
    try { return { rel, full, data: JSON.parse(readFileSync(full, "utf-8")) } }
    catch (err) {
      if (err && /ENOENT/.test(err.message)) return null
      throw err
    }
  }).filter(Boolean)

  let total = 0
  let cleared = 0          // name wiped because it matched derivable form
  let suffixExtracted = 0  // name wiped + suffix populated
  let mainWalkCleared = 0  // specifically the "Main Walk" placeholder
  let keptOverride = 0     // kept as-is because non-derivable
  let skipped = 0          // not station-to-station or unresolved CRS — nothing to do

  for (const { data } of loaded) {
    for (const entry of Object.values(data)) {
      if (!Array.isArray(entry.walks)) continue
      for (const v of entry.walks) {
        total++
        if (!v.stationToStation) { skipped++; continue }
        const start = crsName.get(v.startStation)
        const end = crsName.get(v.endStation)
        if (!start || !end) { skipped++; continue }

        const name = (v.name ?? "").trim()
        if (!name) { continue } // already clean

        if (name === "Main Walk") {
          v.name = ""
          mainWalkCleared++
          continue
        }

        const isCircular = v.startStation === v.endStation
        // Accept both capitalisations of "circular" since pre-April
        // data mixed them — either form on disk collapses to the
        // canonical derived "Start Circular" after backfill.
        const exact = isCircular ? [`${start} Circular`, `${start} circular`] : [`${start} to ${end}`]

        if (exact.some((pat) => name === pat)) {
          v.name = ""
          cleared++
          continue
        }

        // Try "{derivable} <tail>" — the tail becomes the suffix.
        // We require a space between the derivable part and the tail
        // so "Milford to Haslemere via X" matches but
        // "Milford to Haslemere Extended" would also match — that's
        // intentional, the tail is whatever trails after.
        const found = exact.find((pat) => name.startsWith(pat + " "))
        if (found) {
          const tail = name.slice(found.length).trim()
          // Normalise parenthesised suffixes like "(via ferry)" — the
          // leading ( is fine to keep, it reads naturally after the title.
          if (tail) {
            v.suffix = tail
            v.name = ""
            suffixExtracted++
            continue
          }
        }

        // Non-derivable — leave as legacy override.
        keptOverride++
      }
    }
  }

  // eslint-disable-next-line no-console
  console.log(`Variants seen:              ${total}`)
  // eslint-disable-next-line no-console
  console.log(`  skipped (not s2s/unknown): ${skipped}`)
  // eslint-disable-next-line no-console
  console.log(`  "Main Walk" placeholder cleared: ${mainWalkCleared}`)
  // eslint-disable-next-line no-console
  console.log(`  exact derivable → cleared:       ${cleared}`)
  // eslint-disable-next-line no-console
  console.log(`  suffix extracted → cleared:      ${suffixExtracted}`)
  // eslint-disable-next-line no-console
  console.log(`  kept as legacy override:         ${keptOverride}`)

  if (args.dryRun) {
    // eslint-disable-next-line no-console
    console.log("\n--dry-run: not writing.")
    return
  }

  for (const { full, data } of loaded) {
    writeFileSync(full, JSON.stringify(data, null, 2) + "\n", "utf-8")
  }
  // eslint-disable-next-line no-console
  console.log(`\nWrote ${loaded.length} files.`)
}

main()
