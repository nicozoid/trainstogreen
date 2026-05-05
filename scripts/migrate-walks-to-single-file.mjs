// One-shot migration: collapse the five per-source walk files into a
// single data/walks.json, stamping each entry with a top-level `source`
// field so seeders can later preserve entries they don't own.
//
// File order matches WALKS_FILES used everywhere else in the repo.
// "Later file wins on slug collision" mirrors loadAllWalks() in
// scripts/build-rambler-notes.mjs (~110 known dupes between rambler and
// the per-source files; later files are the authoritative copies).
//
// Usage:  node scripts/migrate-walks-to-single-file.mjs
//
// Idempotent: re-running it produces the same data/walks.json.

import { readFileSync, writeFileSync, existsSync } from "fs"
import { fileURLToPath } from "url"
import { dirname, join } from "path"

const __dirname = dirname(fileURLToPath(import.meta.url))
const ROOT = join(__dirname, "..")

const SOURCES = [
  { file: "data/rambler-walks.json",            source: "saturday-walkers-club" },
  { file: "data/leicester-ramblers-walks.json", source: "leicester-ramblers" },
  { file: "data/heart-rail-trails-walks.json",  source: "heart-rail-trails" },
  { file: "data/abbey-line-walks.json",         source: "abbey-line" },
  { file: "data/manual-walks.json",             source: "manual" },
]

const OUT = join(ROOT, "data", "walks.json")

const merged = {}
let totalIn = 0
const overwrites = []

for (const { file, source } of SOURCES) {
  const path = join(ROOT, file)
  if (!existsSync(path)) {
    console.warn(`Skipping missing file: ${file}`)
    continue
  }
  const raw = JSON.parse(readFileSync(path, "utf-8"))
  let count = 0
  for (const [slug, entry] of Object.entries(raw)) {
    // manual-walks.json carries a `_readme` documentation key; drop it.
    if (slug === "_readme") continue
    if (slug in merged) overwrites.push({ slug, prev: merged[slug].source, next: source })
    merged[slug] = { ...entry, source }
    count++
    totalIn++
  }
  console.log(`  ${file.padEnd(42)} → ${count} entries (source: ${source})`)
}

writeFileSync(OUT, JSON.stringify(merged, null, 2) + "\n", "utf-8")

console.log(`\nRead ${totalIn} entries, wrote ${Object.keys(merged).length} unique slugs to ${OUT}`)
if (overwrites.length > 0) {
  console.log(`\nResolved ${overwrites.length} slug collisions (later file wins):`)
  for (const o of overwrites.slice(0, 10)) {
    console.log(`  ${o.slug}: ${o.prev} → ${o.next}`)
  }
  if (overwrites.length > 10) console.log(`  …and ${overwrites.length - 10} more`)
}
