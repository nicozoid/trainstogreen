// Phase 7: reconcile rambler recommendations with the excluded-stations
// list and the station-ratings file.
//
// Recurring rules (applied every run):
//   1. Any excluded station that now has a ramblerNote is un-excluded.
//   2. Any "Unknown" station (no entry in station-ratings.json) that has
//      a ramblerNote is upgraded to "Probably" (rating: unverified).
//
// One-off flag (`--downgrade-probably-without-notes`):
//   3. Any station currently rated "Probably" that has no ramblerNote is
//      downgraded back to "Unknown" (its entry is removed). This is a
//      one-time cleanup — going forward, Probably ratings can exist
//      without notes, so this flag stays off by default.
//
// Dry-run flag (`--dry-run`) — prints the diff without writing.

import { readFileSync, writeFileSync } from "fs"
import { fileURLToPath } from "url"
import { dirname, join } from "path"

const __dirname = dirname(fileURLToPath(import.meta.url))
const PROJECT_ROOT = join(__dirname, "..")
const EXCLUDED_PATH = join(PROJECT_ROOT, "data", "excluded-stations.json")
const RATINGS_PATH = join(PROJECT_ROOT, "data", "station-ratings.json")
const NOTES_PATH = join(PROJECT_ROOT, "data", "station-notes.json")
const STATIONS_PATH = join(PROJECT_ROOT, "public", "stations.json")

function parseArgs(argv) {
  return {
    dryRun: argv.includes("--dry-run"),
    downgradeOrphans: argv.includes("--downgrade-probably-without-notes"),
  }
}

// Build a coordKey → name lookup from stations.json so we can report
// human-readable names alongside coord-key diffs.
function buildCrsNameIndex() {
  const geo = JSON.parse(readFileSync(STATIONS_PATH, "utf-8"))
  const map = new Map()
  for (const f of geo.features) {
    const name = f.properties?.name
    const [lng, lat] = f.geometry?.coordinates ?? []
    if (!name || lng == null || lat == null) continue
    map.set(`${lng},${lat}`, name)
  }
  return map
}

function main() {
  const args = parseArgs(process.argv.slice(2))

  const excluded = new Set(JSON.parse(readFileSync(EXCLUDED_PATH, "utf-8")))
  const ratings = JSON.parse(readFileSync(RATINGS_PATH, "utf-8"))
  const notes = JSON.parse(readFileSync(NOTES_PATH, "utf-8"))
  const nameByCoord = buildCrsNameIndex()

  // Set of coordKeys that have a non-empty ramblerNote right now.
  const withRamblerNote = new Set()
  for (const [coordKey, entry] of Object.entries(notes)) {
    if (entry.ramblerNote?.trim()) withRamblerNote.add(coordKey)
  }

  // Step 1 — un-exclude stations that now have a RamblerNote.
  const unExcluded = []
  for (const coordKey of withRamblerNote) {
    if (excluded.has(coordKey)) {
      excluded.delete(coordKey)
      unExcluded.push({ coordKey, name: nameByCoord.get(coordKey) ?? "(unknown)" })
    }
  }

  // Step 2 — upgrade "Unknown" stations (no entry in ratings) with a
  // RamblerNote to "Probably".
  const upgraded = []
  for (const coordKey of withRamblerNote) {
    if (!ratings[coordKey]) {
      ratings[coordKey] = {
        name: nameByCoord.get(coordKey) ?? notes[coordKey]?.name ?? "(unknown)",
        rating: "unverified",
      }
      upgraded.push({ coordKey, name: ratings[coordKey].name })
    }
  }

  // Step 3 — one-off: downgrade any "Probably" station without a
  // RamblerNote back to "Unknown" (removes the rating entry).
  const downgraded = []
  if (args.downgradeOrphans) {
    for (const [coordKey, entry] of Object.entries(ratings)) {
      if (entry.rating !== "unverified") continue
      if (withRamblerNote.has(coordKey)) continue
      // Don't downgrade anything we just upgraded in step 2.
      if (upgraded.some((u) => u.coordKey === coordKey)) continue
      downgraded.push({ coordKey, name: entry.name })
      delete ratings[coordKey]
    }
  }

  // Report
  // eslint-disable-next-line no-console
  console.log(`Stations with RamblerNote: ${withRamblerNote.size}`)
  // eslint-disable-next-line no-console
  console.log(`Step 1 — un-excluded: ${unExcluded.length}`)
  for (const u of unExcluded) console.log(`  • ${u.name}  (${u.coordKey})`)
  // eslint-disable-next-line no-console
  console.log(`Step 2 — upgraded Unknown → Probably: ${upgraded.length}`)
  for (const u of upgraded) console.log(`  • ${u.name}  (${u.coordKey})`)
  if (args.downgradeOrphans) {
    // eslint-disable-next-line no-console
    console.log(`Step 3 — downgraded Probably → Unknown: ${downgraded.length}`)
    for (const d of downgraded) console.log(`  • ${d.name}  (${d.coordKey})`)
  }

  if (args.dryRun) {
    // eslint-disable-next-line no-console
    console.log("\n(dry run — no files written)")
    return
  }

  // Write back — always stable-sorted for a clean diff in git.
  const sortedExcluded = [...excluded].sort()
  writeFileSync(EXCLUDED_PATH, JSON.stringify(sortedExcluded, null, 2) + "\n", "utf-8")

  const sortedRatingsEntries = Object.entries(ratings).sort(([a], [b]) => a.localeCompare(b))
  const sortedRatings = Object.fromEntries(sortedRatingsEntries)
  writeFileSync(RATINGS_PATH, JSON.stringify(sortedRatings, null, 2) + "\n", "utf-8")

  // eslint-disable-next-line no-console
  console.log(`\nWrote: ${EXCLUDED_PATH} (${sortedExcluded.length} entries)`)
  // eslint-disable-next-line no-console
  console.log(`Wrote: ${RATINGS_PATH} (${Object.keys(sortedRatings).length} entries)`)
}

main()
