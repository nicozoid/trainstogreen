// One-shot cleanup: decode HTML entities (&#39;, &amp;, etc.) that
// survived from the SWC extractor into the walks JSON files. The
// original scraper left page titles and other strings HTML-encoded;
// the admin UI and rendered prose show them raw, so "Tom&#39;s Hill"
// surfaces as literal ampersand-hash text. This script decodes every
// string recursively across every walks file.
//
// Idempotent: already-decoded strings pass through unchanged.
//
// Usage:
//   node scripts/fix-html-entities.mjs --dry-run
//   node scripts/fix-html-entities.mjs

import { readFileSync, writeFileSync } from "fs"
import { fileURLToPath } from "url"
import { dirname, join } from "path"

const __dirname = dirname(fileURLToPath(import.meta.url))
const PROJECT_ROOT = join(__dirname, "..")

const FILES = ["data/walks.json"]

// Named entities we've seen in the data plus the handful that are
// ubiquitous in HTML-encoded prose. Anything else falls through to
// numeric-entity decoding below.
const NAMED = {
  amp:    "&",
  lt:     "<",
  gt:     ">",
  quot:   '"',
  apos:   "'",
  nbsp:   " ",   // collapse to a regular space — rendered prose doesn't need hard spaces
  ndash:  "\u2013",
  mdash:  "\u2014",
  hellip: "\u2026",
  lsquo:  "\u2018",
  rsquo:  "\u2019",
  ldquo:  "\u201C",
  rdquo:  "\u201D",
}

function decodeEntities(s) {
  if (typeof s !== "string") return s
  return s.replace(/&(#\d+|#x[0-9a-fA-F]+|[a-zA-Z]+);/g, (full, inner) => {
    if (inner.startsWith("#x") || inner.startsWith("#X")) {
      const code = parseInt(inner.slice(2), 16)
      return Number.isFinite(code) ? String.fromCodePoint(code) : full
    }
    if (inner.startsWith("#")) {
      const code = parseInt(inner.slice(1), 10)
      return Number.isFinite(code) ? String.fromCodePoint(code) : full
    }
    return NAMED[inner] ?? full
  })
}

function walk(value) {
  if (typeof value === "string") return decodeEntities(value)
  if (Array.isArray(value)) return value.map(walk)
  if (value && typeof value === "object") {
    const out = {}
    for (const [k, v] of Object.entries(value)) out[k] = walk(v)
    return out
  }
  return value
}

function parseArgs(argv) {
  return { dryRun: argv.includes("--dry-run") }
}

function main() {
  const args = parseArgs(process.argv.slice(2))
  let totalDecoded = 0
  const summary = []

  for (const relPath of FILES) {
    const fullPath = join(PROJECT_ROOT, relPath)
    let before
    try {
      before = readFileSync(fullPath, "utf-8")
    } catch (err) {
      if (err && /ENOENT/.test(err.message)) continue
      throw err
    }
    const decoded = walk(JSON.parse(before))
    const after = JSON.stringify(decoded, null, 2) + "\n"
    // Count entity-like sequences left in the decoded output. Should
    // be zero post-fix — any leftovers are inside code blocks /
    // deliberate strings and worth eyeballing.
    const leftover = (after.match(/&(?:#\d+|#x[0-9a-fA-F]+|[a-zA-Z]+);/g) ?? []).length
    const changed = before !== after
    summary.push({ relPath, changed, leftover })
    if (changed && !args.dryRun) writeFileSync(fullPath, after, "utf-8")
    if (changed) totalDecoded++
  }

  // eslint-disable-next-line no-console
  console.log("File changes:")
  for (const s of summary) {
    // eslint-disable-next-line no-console
    console.log(`  ${s.relPath}: changed=${s.changed}, leftover entities=${s.leftover}`)
  }
  // eslint-disable-next-line no-console
  console.log(`\n${args.dryRun ? "--dry-run: " : ""}${totalDecoded} file(s) ${args.dryRun ? "would be rewritten" : "rewritten"}.`)
}

main()
