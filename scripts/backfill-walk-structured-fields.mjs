// One-shot migration: populate the new structured fields on every walk
// variant from the existing free-text `bestTime` / `miscellany` prose.
//
//   bestTime    → bestSeasons: 3-letter month codes
//   miscellany  → mudWarning: true if prose mentions "mud" / "muddy"
//
// The original `bestTime` and `miscellany` fields are intentionally left
// in place — they hold details not captured by the structured flags
// (e.g. "MOD closures apply", "Can be very cold in winter") and are
// still the fallback in the build script when bestSeasons is absent.
// A follow-up pass can drop them once coverage is complete.
//
// Idempotent: a variant that already has bestSeasons/mudWarning is not
// touched, so running this repeatedly only fills gaps.
//
// Usage:
//   node scripts/backfill-walk-structured-fields.mjs --dry-run   # preview
//   node scripts/backfill-walk-structured-fields.mjs             # writes

import { readFileSync, writeFileSync } from "fs"
import { fileURLToPath } from "url"
import { dirname, join } from "path"

const __dirname = dirname(fileURLToPath(import.meta.url))
const PROJECT_ROOT = join(__dirname, "..")

const WALKS_FILES = [join(PROJECT_ROOT, "data", "walks.json")]

// ── Month/season parsing ──────────────────────────────────────────────────

const MONTH_ORDER = ["jan","feb","mar","apr","may","jun","jul","aug","sep","oct","nov","dec"]

// Every short/long form we might see in prose, mapped to its canonical
// 3-letter code. Order matters inside the alternation only because
// "sept" must match before "sep" (longest-first) — we handle that below.
const MONTH_ALIASES = {
  jan: "jan", january: "jan",
  feb: "feb", february: "feb",
  mar: "mar", march: "mar",
  apr: "apr", april: "apr",
  may: "may",
  jun: "jun", june: "jun",
  jul: "jul", july: "jul",
  aug: "aug", august: "aug",
  sept: "sep", sep: "sep", september: "sep",
  oct: "oct", october: "oct",
  nov: "nov", november: "nov",
  dec: "dec", december: "dec",
}

// Season → months. "fall" is included as a US synonym that occasionally
// sneaks in from American Rambler contributions.
const SEASON_TO_MONTHS = {
  spring: ["mar","apr","may"],
  summer: ["jun","jul","aug"],
  autumn: ["sep","oct","nov"],
  fall:   ["sep","oct","nov"],
  winter: ["dec","jan","feb"],
}

// Culturally-known seasonal phrases that the Rambler writers use as a
// shorthand for specific months. Add more here as new idioms show up
// in the prose — each key is matched as a case-insensitive substring.
const IDIOMS_TO_MONTHS = {
  "bluebell season": ["apr","may"], // UK bluebells peak late Apr–early May
}

// Longest-first so "September" matches before "Sep" when both are
// present at the same index (JS alternation picks the first match).
const MONTH_ALT = Object.keys(MONTH_ALIASES)
  .sort((a, b) => b.length - a.length)
  .join("|")

// Range separators we want to treat as "X through Y, inclusive":
// " to ", " through ", hyphen, en-dash, em-dash, and "–" (appears a lot
// in our data). Surrounded by optional whitespace.
const RANGE_SEP = `\\s*(?:to|through|-|–|—)\\s*`

// Parse the free-text best-time prose into a Set of month codes.
// Rules (from the plan doc):
//   - "avoid" / "avoided" anywhere → purely advisory, return empty set
//   - Season name → its three months
//   - Month name (short or long) → that month
//   - "X to Y" / "X–Y" → inclusive range, fill months between
//   - Multiple matches union into one set
//   - Pure vibes prose ("bluebell season", "at high tide") → empty set;
//     user can fill those manually later.
function parseBestTime(text) {
  const months = new Set()
  if (!text) return months
  const lower = text.toLowerCase()

  // Advisory / negative phrases — skip entirely.
  if (/\bavoid(?:ed)?\b/.test(lower)) return months

  // Ranges first (so "May to October" gets jun–sep as well, not just the
  // two endpoints). Deliberately permissive on separators to catch the
  // many dash variants.
  const rangeRe = new RegExp(`\\b(${MONTH_ALT})${RANGE_SEP}(${MONTH_ALT})\\b`, "gi")
  for (const m of lower.matchAll(rangeRe)) {
    const start = MONTH_ALIASES[m[1]]
    const end = MONTH_ALIASES[m[2]]
    if (!start || !end) continue
    // Walk forward, wrapping at December, stopping when we hit the end
    // month. In practice every range in our data is within one calendar
    // year, but wrapping costs nothing and handles "Oct to Mar" sanely.
    let i = MONTH_ORDER.indexOf(start)
    const j = MONTH_ORDER.indexOf(end)
    while (true) {
      months.add(MONTH_ORDER[i])
      if (i === j) break
      i = (i + 1) % 12
      // safety: bail if we've somehow looped (shouldn't happen with the
      // `i === j` guard, but guards against pathological input)
      if (months.size > 12) break
    }
  }

  // Individual month mentions (short and long forms). Same regex as
  // rangeRe's alternation but standalone — catches "Best in April" or
  // "Apr/May" slash forms (each month token matches individually).
  const monthRe = new RegExp(`\\b(${MONTH_ALT})\\b`, "gi")
  for (const m of lower.matchAll(monthRe)) {
    const normalized = MONTH_ALIASES[m[1]]
    if (normalized) months.add(normalized)
  }

  // Season names expand to three months each.
  const seasonRe = /\b(spring|summer|autumn|fall|winter)\b/gi
  for (const m of lower.matchAll(seasonRe)) {
    for (const month of SEASON_TO_MONTHS[m[1].toLowerCase()]) {
      months.add(month)
    }
  }

  // Culturally-known idioms (e.g. "bluebell season" → Apr/May).
  // Simple substring match — the phrases are distinctive enough that
  // false positives are unlikely.
  for (const [phrase, idiomMonths] of Object.entries(IDIOMS_TO_MONTHS)) {
    if (lower.includes(phrase)) {
      for (const month of idiomMonths) months.add(month)
    }
  }

  return months
}

// Return months ordered jan → dec for stable output.
function monthsInCalendarOrder(set) {
  return MONTH_ORDER.filter((m) => set.has(m))
}

// ── Main ──────────────────────────────────────────────────────────────────

function parseArgs(argv) {
  return { dryRun: argv.includes("--dry-run") }
}

function main() {
  const args = parseArgs(process.argv.slice(2))

  const loaded = WALKS_FILES.map((path) => {
    try { return { path, data: JSON.parse(readFileSync(path, "utf-8")) } }
    catch (err) {
      if (err && /ENOENT/.test(err.message)) return null
      throw err
    }
  }).filter(Boolean)

  let variantsSeen = 0
  let seasonsAssigned = 0
  let seasonsSkippedExisting = 0
  let seasonsEmpty = 0
  let mudAssigned = 0
  let mudSkippedExisting = 0
  let ratingAssigned = 0
  let ratingSkippedExisting = 0
  const samples = [] // one-line summaries for dry-run review
  const empties = [] // bestTime values that parsed to zero months

  for (const { data } of loaded) {
    for (const entry of Object.values(data)) {
      if (!Array.isArray(entry.walks)) continue
      for (const variant of entry.walks) {
        variantsSeen++

        // ── rating ─────────────────────────────────────────────────
        // Seed with 3 for every variant of a page-level "favourite"
        // entry. Unrated walks stay absent (the build script treats
        // absence as "unrated"). Later the admin UI can push them to
        // 1–4 individually.
        if (typeof variant.rating === "number") {
          ratingSkippedExisting++
        } else if (entry.favourite === true) {
          variant.rating = 3
          ratingAssigned++
        }

        // ── mudWarning ─────────────────────────────────────────────
        if (variant.mudWarning !== undefined) {
          mudSkippedExisting++
        } else {
          const w = (variant.miscellany ?? "").trim()
          if (/\bmud/i.test(w)) {
            variant.mudWarning = true
            mudAssigned++
          }
          // No miscellany or no mud → leave the field absent. Writing
          // `false` would add noise to the file without carrying info;
          // absence reads the same.
        }

        // ── bestSeasons ────────────────────────────────────────────
        if (Array.isArray(variant.bestSeasons)) {
          seasonsSkippedExisting++
        } else {
          const bt = (variant.bestTime ?? "").trim()
          if (bt) {
            const months = monthsInCalendarOrder(parseBestTime(bt))
            if (months.length > 0) {
              variant.bestSeasons = months
              seasonsAssigned++
              if (samples.length < 20) samples.push(`  ${bt}  →  [${months.join(",")}]`)
            } else {
              seasonsEmpty++
              if (empties.length < 20) empties.push(`  ${bt}`)
            }
          }
        }
      }
    }
  }

  // eslint-disable-next-line no-console
  console.log(`Variants scanned: ${variantsSeen}`)
  // eslint-disable-next-line no-console
  console.log(`\nrating:`)
  // eslint-disable-next-line no-console
  console.log(`  assigned 3 (from entry.favourite): ${ratingAssigned}`)
  // eslint-disable-next-line no-console
  console.log(`  skipped (already rated):           ${ratingSkippedExisting}`)
  // eslint-disable-next-line no-console
  console.log(`\nmudWarning:`)
  // eslint-disable-next-line no-console
  console.log(`  assigned true:      ${mudAssigned}`)
  // eslint-disable-next-line no-console
  console.log(`  skipped (existing): ${mudSkippedExisting}`)
  // eslint-disable-next-line no-console
  console.log(`\nbestSeasons:`)
  // eslint-disable-next-line no-console
  console.log(`  assigned:           ${seasonsAssigned}`)
  // eslint-disable-next-line no-console
  console.log(`  skipped (existing): ${seasonsSkippedExisting}`)
  // eslint-disable-next-line no-console
  console.log(`  parsed to empty:    ${seasonsEmpty}  (prose the parser couldn't resolve — left untouched)`)

  if (samples.length > 0) {
    // eslint-disable-next-line no-console
    console.log(`\nSample parses (bestTime → bestSeasons):`)
    for (const s of samples) console.log(s)
  }
  if (empties.length > 0) {
    // eslint-disable-next-line no-console
    console.log(`\nSample bestTime values that didn't resolve to any month:`)
    for (const s of empties) console.log(s)
  }

  if (args.dryRun) {
    // eslint-disable-next-line no-console
    console.log("\n--dry-run: not writing.")
    return
  }

  for (const { path, data } of loaded) {
    writeFileSync(path, JSON.stringify(data, null, 2) + "\n", "utf-8")
  }
  // eslint-disable-next-line no-console
  console.log(`\nWrote ${loaded.length} file(s).`)
}

main()
