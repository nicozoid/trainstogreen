// Assigns a memorable id to every walk variant across every walks
// source file.
//
// Format: `[startCRS][endCRS][word]`, all lowercase. For example:
//   - hunhunfox  : HUN circular + "fox"
//   - saldenwren : SAL → DEN + "wren"
//   - nullnulwren: walk with no station endpoints (uses "nul" placeholder)
//                  (well-formed: "nul" + "nul" + "wren" → "nulnulwren")
// The word comes from WALK_ID_WORDS — short British flora/fauna.
// Collisions are resolved by picking a different word.
//
// Behaviour:
//   - Walks WITHOUT an id get one assigned.
//   - Walks WITH an id in the LEGACY 4-char base36 format are
//     migrated to the new format (their old id is replaced).
//   - Walks WITH an id already in the new format are left alone
//     (idempotent — re-runs are no-ops once everything is migrated).
//
// Usage:
//   node scripts/assign-walk-ids.mjs            # writes to disk
//   node scripts/assign-walk-ids.mjs --dry-run  # preview, no write

import { readFileSync, writeFileSync } from "fs"
import { fileURLToPath } from "url"
import { dirname, join } from "path"
import { WALK_ID_WORDS } from "./walk-id-words.mjs"

const __dirname = dirname(fileURLToPath(import.meta.url))
const PROJECT_ROOT = join(__dirname, "..")

const WALKS_FILES = [
  join(PROJECT_ROOT, "data", "rambler-walks.json"),
  join(PROJECT_ROOT, "data", "leicester-ramblers-walks.json"),
  join(PROJECT_ROOT, "data", "heart-rail-trails-walks.json"),
  join(PROJECT_ROOT, "data", "abbey-line-walks.json"),
  join(PROJECT_ROOT, "data", "manual-walks.json"),
]

// "nul" stands in for a missing station endpoint — keeps every id
// the same shape (3 letters per slot) so the format stays uniform.
const NUL = "nul"

// Legacy ids: 4 chars, alphanumeric, lower-case. New ids start at 9
// chars (3 + 3 + 3) and are letters-only, so the two formats can't
// be confused.
const LEGACY_RE = /^[0-9a-z]{4}$/
const NEW_RE = /^[a-z]{6,}$/

function isNewFormat(id) {
  return typeof id === "string" && NEW_RE.test(id) && !LEGACY_RE.test(id)
}

function stationSlot(crs) {
  // Rambler walks sometimes have undefined/null/empty endpoints
  // (pub-to-pub walks etc.). Map every "absent" shape to NUL so we
  // don't end up with a malformed id.
  if (typeof crs !== "string" || crs.length !== 3) return NUL
  return crs.toLowerCase()
}

// Pick a word for a (start,end) pair, avoiding ids already in use.
// Falls back to appending a numeric suffix if every word collides
// (extremely unlikely for ~1500 walks across 200+ words).
function pickId(startSlot, endSlot, taken) {
  const prefix = startSlot + endSlot
  // Shuffle a copy of the word list for this pick so order is random
  // but the chosen word is then locked in for that walk.
  const shuffled = [...WALK_ID_WORDS].sort(() => Math.random() - 0.5)
  for (const w of shuffled) {
    const id = prefix + w
    if (!taken.has(id)) return id
  }
  // Fallback: append digits. Should never trigger in practice.
  for (let n = 2; n < 1000; n++) {
    for (const w of WALK_ID_WORDS) {
      const id = `${prefix}${w}${n}`
      if (!taken.has(id)) return id
    }
  }
  throw new Error(`exhausted all ids for prefix ${prefix}`)
}

function parseArgs(argv) {
  return { dryRun: argv.includes("--dry-run") }
}

function main() {
  const args = parseArgs(process.argv.slice(2))

  // Load every file. Missing files are silently skipped — some
  // optional sources may not exist locally.
  const loaded = WALKS_FILES.map((path) => {
    try {
      return { path, data: JSON.parse(readFileSync(path, "utf-8")) }
    } catch (err) {
      if (err && /ENOENT/.test(err.message)) return null
      throw err
    }
  }).filter(Boolean)

  // First pass: collect every id already in NEW format. Those are
  // reserved (locked-in) so the random picker won't collide with them.
  // Legacy ids are NOT reserved — they're going to be replaced.
  const taken = new Set()
  for (const { data } of loaded) {
    for (const entry of Object.values(data)) {
      if (!Array.isArray(entry.walks)) continue
      for (const variant of entry.walks) {
        if (isNewFormat(variant.id)) taken.add(variant.id)
      }
    }
  }

  // Second pass: assign ids where missing or legacy.
  let migrated = 0
  let assigned = 0
  const perFile = {}
  const samples = []
  for (const { path, data } of loaded) {
    let local = 0
    for (const entry of Object.values(data)) {
      if (!Array.isArray(entry.walks)) continue
      for (const variant of entry.walks) {
        if (isNewFormat(variant.id)) continue
        const startSlot = stationSlot(variant.startStation)
        const endSlot = stationSlot(variant.endStation)
        const oldId = typeof variant.id === "string" ? variant.id : null
        const newId = pickId(startSlot, endSlot, taken)
        taken.add(newId)
        variant.id = newId
        if (oldId && LEGACY_RE.test(oldId)) migrated++
        else assigned++
        local++
        if (samples.length < 12) samples.push({ oldId, newId })
      }
    }
    perFile[path] = local
  }

  console.log(`Walks updated: ${migrated + assigned} (migrated legacy: ${migrated}, newly assigned: ${assigned})`)
  console.log(`Total new-format ids in dataset: ${taken.size}`)
  for (const [path, n] of Object.entries(perFile)) {
    console.log(`  ${path.split("/").slice(-2).join("/")}: ${n}`)
  }
  if (samples.length) {
    console.log(`\nSamples:`)
    for (const s of samples) {
      console.log(`  ${s.oldId ?? "(no id)"} → ${s.newId}`)
    }
  }

  if (args.dryRun) {
    console.log("\n--dry-run: not writing.")
    return
  }

  for (const { path, data } of loaded) {
    writeFileSync(path, JSON.stringify(data, null, 2) + "\n", "utf-8")
  }
  console.log(`\nWrote ${loaded.length} file(s).`)
}

main()
