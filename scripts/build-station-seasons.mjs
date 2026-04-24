// Build data/station-seasons.json from the ramblerNote text in
// station-notes.json.
//
// Rule: for each station, scan the ramblerNote for month mentions (both
// short and long forms — "Nov" / "November") and map each to a season.
// Months in a season set → station is recommended for that season.
//
// Month → season:
//   Spring: Mar, Apr, May
//   Summer: Jun, Jul, Aug
//   Autumn: Sep, Oct, Nov
//   Winter: Dec, Jan, Feb
//
// The regex uses word boundaries so "March" matches but "marching" doesn't.
// Case-insensitive. Month tokens are matched individually (not tied to a
// phrase like "best in …") — any mention counts.
//
// Output schema (data/station-seasons.json):
//   { [coordKey]: { name: string, seasons: ("Spring"|"Summer"|"Autumn"|"Winter")[] } }
//
// Entries with an empty seasons set are omitted, so the file only lists
// stations with at least one recommended season. Seasons inside each entry
// are emitted in calendar order (Spring → Winter) for stability.
//
// Flags:
//   --dry-run   — print the diff without writing

import { readFileSync, writeFileSync, existsSync } from "fs"
import { fileURLToPath } from "url"
import { dirname, join } from "path"

const __dirname = dirname(fileURLToPath(import.meta.url))
const PROJECT_ROOT = join(__dirname, "..")
const NOTES_PATH = join(PROJECT_ROOT, "data", "station-notes.json")
const SEASONS_PATH = join(PROJECT_ROOT, "data", "station-seasons.json")

const SEASON_ORDER = ["Spring", "Summer", "Autumn", "Winter"]

// Map each month's short + long form to a season. The regex below is built
// from the keys of this object so adding/removing an alias is a one-line edit.
const MONTH_TO_SEASON = {
  jan: "Winter", january: "Winter",
  feb: "Winter", february: "Winter",
  mar: "Spring", march: "Spring",
  apr: "Spring", april: "Spring",
  may: "Spring",
  jun: "Summer", june: "Summer",
  jul: "Summer", july: "Summer",
  aug: "Summer", august: "Summer",
  sep: "Autumn", sept: "Autumn", september: "Autumn",
  oct: "Autumn", october: "Autumn",
  nov: "Autumn", november: "Autumn",
  dec: "Winter", december: "Winter",
}

// Build a single case-insensitive regex with word boundaries. Longest
// alternatives first so "September" is preferred over "Sep" when both
// could match at the same index (JS alternation picks the first match).
const MONTH_REGEX = new RegExp(
  `\\b(${Object.keys(MONTH_TO_SEASON)
    .sort((a, b) => b.length - a.length)
    .join("|")})\\b`,
  "gi",
)

function seasonsFromText(text) {
  if (!text) return []
  const seasons = new Set()
  for (const match of text.matchAll(MONTH_REGEX)) {
    const season = MONTH_TO_SEASON[match[1].toLowerCase()]
    if (season) seasons.add(season)
  }
  // Return in calendar order for stable output
  return SEASON_ORDER.filter((s) => seasons.has(s))
}

function parseArgs(argv) {
  return { dryRun: argv.includes("--dry-run") }
}

function main() {
  const args = parseArgs(process.argv.slice(2))

  const notes = JSON.parse(readFileSync(NOTES_PATH, "utf-8"))
  const existing = existsSync(SEASONS_PATH)
    ? JSON.parse(readFileSync(SEASONS_PATH, "utf-8"))
    : {}

  const next = {}
  let added = 0
  let changed = 0
  let skipped = 0

  for (const [coordKey, entry] of Object.entries(notes)) {
    const seasons = seasonsFromText(entry.ramblerNote)
    if (seasons.length === 0) {
      skipped++
      continue
    }
    next[coordKey] = { name: entry.name ?? coordKey, seasons }

    const prev = existing[coordKey]
    if (!prev) added++
    else if (JSON.stringify(prev.seasons) !== JSON.stringify(seasons)) changed++
  }

  const removed = Object.keys(existing).filter((k) => !next[k]).length

  console.log(`Stations scanned: ${Object.keys(notes).length}`)
  console.log(`Stations without seasons (skipped): ${skipped}`)
  console.log(`Stations with seasons: ${Object.keys(next).length}`)
  console.log(`  added:   ${added}`)
  console.log(`  changed: ${changed}`)
  console.log(`  removed: ${removed}`)

  if (args.dryRun) {
    console.log("\n--dry-run: not writing.")
    return
  }

  // Sort entries by coordKey for stable diffs
  const sorted = Object.fromEntries(
    Object.entries(next).sort(([a], [b]) => a.localeCompare(b)),
  )
  writeFileSync(SEASONS_PATH, JSON.stringify(sorted, null, 2) + "\n")
  console.log(`\nWrote ${SEASONS_PATH}`)
}

main()
