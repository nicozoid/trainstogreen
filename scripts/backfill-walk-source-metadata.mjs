// One-shot migration: add a structured `source` object to every walk
// variant, populated from the entry's URL/title + the variant's role.
//
// Going forward each walk stands alone with its own source provenance
// rather than inheriting it implicitly from the nested page entry.
// The nested structure (entries with walks[]) stays on disk for now —
// this is purely additive. A future pass can drop the entry-level
// title/url/favourite once the build script switches to reading from
// variant.source.* instead.
//
// Idempotent: variants that already have a `source` object are not
// touched, so re-running only fills gaps (e.g. after a new walk is
// added to one of the source files).
//
// Usage:
//   node scripts/backfill-walk-source-metadata.mjs --dry-run
//   node scripts/backfill-walk-source-metadata.mjs

import { readFileSync, writeFileSync } from "fs"
import { fileURLToPath } from "url"
import { dirname, join } from "path"

const __dirname = dirname(fileURLToPath(import.meta.url))
const PROJECT_ROOT = join(__dirname, "..")

// Each walks file maps 1:1 to a source organisation. Keep this in
// sync with data/sources.json — the keys on the right must exist
// there.
const FILE_TO_ORG_SLUG = {
  "data/rambler-walks.json":          "saturday-walkers-club",
  "data/leicester-ramblers-walks.json": "leicester-ramblers",
  "data/heart-rail-trails-walks.json":  "heart-rail-trails",
  "data/abbey-line-walks.json":         "abbey-line",
}

function parseArgs(argv) {
  return { dryRun: argv.includes("--dry-run") }
}

function main() {
  const args = parseArgs(process.argv.slice(2))

  const sources = JSON.parse(
    readFileSync(join(PROJECT_ROOT, "data", "sources.json"), "utf-8"),
  )

  let totalVariants = 0
  let assigned = 0
  let skipped = 0
  const perFile = {}

  for (const [relPath, orgSlug] of Object.entries(FILE_TO_ORG_SLUG)) {
    if (!sources[orgSlug]) {
      throw new Error(`orgSlug "${orgSlug}" missing from data/sources.json`)
    }
    const fullPath = join(PROJECT_ROOT, relPath)
    let data
    try {
      data = JSON.parse(readFileSync(fullPath, "utf-8"))
    } catch (err) {
      if (err && /ENOENT/.test(err.message)) continue
      throw err
    }

    let localAssigned = 0
    let localSkipped = 0
    for (const entry of Object.values(data)) {
      if (!Array.isArray(entry.walks)) continue
      for (const variant of entry.walks) {
        totalVariants++
        if (variant.source && typeof variant.source === "object") {
          skipped++
          localSkipped++
          continue
        }
        variant.source = {
          orgSlug,
          pageName: entry.title ?? "",
          pageURL: entry.url ?? "",
          type: variant.role ?? "variant",
        }
        assigned++
        localAssigned++
      }
    }
    perFile[relPath] = { assigned: localAssigned, skipped: localSkipped, data, fullPath }
  }

  // eslint-disable-next-line no-console
  console.log(`Variants scanned: ${totalVariants}`)
  // eslint-disable-next-line no-console
  console.log(`source objects assigned: ${assigned}`)
  // eslint-disable-next-line no-console
  console.log(`source objects skipped (already present): ${skipped}`)
  for (const [path, { assigned: a, skipped: s }] of Object.entries(perFile)) {
    // eslint-disable-next-line no-console
    console.log(`  ${path}: +${a}, skip ${s}`)
  }

  if (args.dryRun) {
    // eslint-disable-next-line no-console
    console.log("\n--dry-run: not writing.")
    return
  }

  for (const { data, fullPath } of Object.values(perFile)) {
    writeFileSync(fullPath, JSON.stringify(data, null, 2) + "\n", "utf-8")
  }
  // eslint-disable-next-line no-console
  console.log("\nWrote all files.")
}

main()
