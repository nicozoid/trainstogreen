#!/usr/bin/env node
// One-time bootstrap for data/rtt-coverage.json — the small summary file
// that records each station's RTT-fetch outcome ("ready" or "ghost").
// Reads origin-routes.json (the source of truth for fetched stations
// with data) and writes a flat ID → "ready" map.
//
// Idempotent. Safe to re-run: existing "ghost" entries are preserved
// (those don't appear in origin-routes.json by design — see comment
// on the warning branch below).
//
// After this bootstrap, ongoing maintenance of rtt-coverage.json is
// the responsibility of fetch-direct-reachable.mjs, which writes
// "ready" on a successful fetch and "ghost" when a station turns
// out to have zero Saturday-morning services.
//
// Usage:
//   node scripts/init-rtt-coverage.mjs

import { readFileSync, writeFileSync, existsSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { dirname, join } from "node:path"

const __dirname = dirname(fileURLToPath(import.meta.url))
const REPO = join(__dirname, "..")
const ROUTES_PATH = join(REPO, "data/origin-routes.json")
const COVERAGE_PATH = join(REPO, "data/rtt-coverage.json")

const routes = JSON.parse(readFileSync(ROUTES_PATH, "utf8"))
const existing = existsSync(COVERAGE_PATH)
  ? JSON.parse(readFileSync(COVERAGE_PATH, "utf8"))
  : {}

const next = { ...existing }
let added = 0
let skippedAlreadyReady = 0
for (const id of Object.keys(routes)) {
  if (next[id] === "ready") { skippedAlreadyReady++; continue }
  if (next[id] === "ghost") {
    // Should never happen — origin-routes.json only contains stations with
    // at least one Saturday morning service, so a ghost-flagged station
    // shouldn't have an entry there. Flag it for manual review rather than
    // silently overwrite.
    console.warn(`Skipping ${id}: marked "ghost" but appears in origin-routes.json — investigate.`)
    continue
  }
  next[id] = "ready"
  added++
}

// Sort keys for stable diffs.
const sorted = Object.fromEntries(
  Object.entries(next).sort(([a], [b]) => a.localeCompare(b)),
)
writeFileSync(COVERAGE_PATH, JSON.stringify(sorted, null, 2) + "\n")
console.log(`Wrote ${COVERAGE_PATH}`)
console.log(`  ${Object.keys(sorted).length} total entries`)
console.log(`  ${added} newly added as "ready"`)
console.log(`  ${skippedAlreadyReady} already marked "ready"`)
const ghostCount = Object.values(sorted).filter((v) => v === "ghost").length
if (ghostCount > 0) console.log(`  ${ghostCount} marked "ghost"`)
