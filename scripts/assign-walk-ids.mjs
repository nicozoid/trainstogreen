// Assigns a unique 4-character base36 `id` to every walk variant across
// every walks source file. Idempotent — walks that already have an `id`
// are left alone. Re-run whenever new walks are added.
//
// The id is a short human-friendly handle for communicating about a
// specific walk (e.g. "update walk a7kq's bestSeasons"), not a
// slug/role/URL reference. Uniqueness is enforced across ALL walk
// files combined, so an id unambiguously identifies one variant.
//
// Usage:
//   node scripts/assign-walk-ids.mjs            # writes to disk
//   node scripts/assign-walk-ids.mjs --dry-run  # preview, no write

import { readFileSync, writeFileSync } from "fs"
import { fileURLToPath } from "url"
import { dirname, join } from "path"

const __dirname = dirname(fileURLToPath(import.meta.url))
const PROJECT_ROOT = join(__dirname, "..")

// Every file that holds walk entries. Add new sources here (e.g. book
// sources once Phase 6 lands) so their variants also get ids.
const WALKS_FILES = [
  join(PROJECT_ROOT, "data", "rambler-walks.json"),
  join(PROJECT_ROOT, "data", "leicester-ramblers-walks.json"),
  join(PROJECT_ROOT, "data", "heart-rail-trails-walks.json"),
  join(PROJECT_ROOT, "data", "abbey-line-walks.json"),
]

// 4 chars × 36-char alphabet = 1,679,616 possible ids. Dataset is
// ~1000 variants, so collision probability stays negligible even as
// it grows.
const ID_LEN = 4
const ALPHABET = "0123456789abcdefghijklmnopqrstuvwxyz"

function randomId() {
  let s = ""
  for (let i = 0; i < ID_LEN; i++) {
    s += ALPHABET[Math.floor(Math.random() * ALPHABET.length)]
  }
  return s
}

function parseArgs(argv) {
  return { dryRun: argv.includes("--dry-run") }
}

function main() {
  const args = parseArgs(process.argv.slice(2))

  // Load every file and collect existing ids first — these are
  // reserved so the random generator doesn't collide with them.
  const loaded = WALKS_FILES.map((path) => {
    try {
      return { path, data: JSON.parse(readFileSync(path, "utf-8")) }
    } catch (err) {
      if (err && /ENOENT/.test(err.message)) return null
      throw err
    }
  }).filter(Boolean)

  const taken = new Set()
  for (const { data } of loaded) {
    for (const entry of Object.values(data)) {
      if (!Array.isArray(entry.walks)) continue
      for (const variant of entry.walks) {
        if (typeof variant.id === "string" && variant.id) taken.add(variant.id)
      }
    }
  }

  // Second pass: assign ids to any variant missing one.
  let assigned = 0
  const perFile = {}
  for (const { path, data } of loaded) {
    let localAssigned = 0
    for (const entry of Object.values(data)) {
      if (!Array.isArray(entry.walks)) continue
      for (const variant of entry.walks) {
        if (typeof variant.id === "string" && variant.id) continue
        // Pull a fresh random id, retry on the slim chance of collision.
        let id
        do { id = randomId() } while (taken.has(id))
        taken.add(id)
        variant.id = id
        localAssigned++
        assigned++
      }
    }
    perFile[path] = localAssigned
  }

  // eslint-disable-next-line no-console
  console.log(`Total ids in dataset (existing + new): ${taken.size}`)
  // eslint-disable-next-line no-console
  console.log(`Newly assigned: ${assigned}`)
  for (const [path, n] of Object.entries(perFile)) {
    // eslint-disable-next-line no-console
    console.log(`  ${path.split("/").slice(-2).join("/")}: ${n}`)
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
