#!/usr/bin/env node
// Orchestrator: runs scripts/fetch-direct-reachable.mjs for every London
// terminus CRS across every date passed via --dates. Each child run merges
// into data/origin-routes.json in place, so the file accumulates coverage.
//
// Usage:
//   RTT_TOKEN=<jwt> node scripts/refresh-all-origin-routes.mjs --dates=2026-04-18,2026-07-25,2026-10-03
//   RTT_TOKEN=<jwt> node scripts/refresh-all-origin-routes.mjs --dates=... --only=CHX,MOG
//
// Why a wrapper script instead of looping inside fetch-direct-reachable.mjs?
//   - Each CRS × date pair takes 5–15 minutes and burns ~300 RTT calls. When
//     a run fails mid-way (flaky network, token refresh, transient 5xx from
//     a specific operator's services) you want to retry just that pair, not
//     start over from scratch. Keeping fetch-direct-reachable.mjs single-CRS
//     makes retry one bash command away.
//   - Each spawned process gets a fresh access token, avoiding the long-run
//     token-expiry edge case that forces a mid-stream refresh.
//
// Rate-limit budget (personal tier):
//   30/min, 750/hour, 9000/day, 30000/week. A single CRS run averages ~300
//   calls over ~10 minutes = ~30/min, right at the per-minute cap. Between
//   runs we sleep WRAPPER_GAP_MS (default 90s) so we don't spike into the
//   next minute. For full-breadth runs (16 primaries × 3 dates = 48 runs at
//   ~10 min each = 8 hours), expect to bump the --throttle= upward if you
//   share your token with other tools.

import { spawn } from "node:child_process"
import { fileURLToPath } from "node:url"
import { dirname, join } from "node:path"

const __dirname = dirname(fileURLToPath(import.meta.url))
const FETCH_SCRIPT = join(__dirname, "fetch-direct-reachable.mjs")

// CRS codes of every London terminus we treat as a primary origin. This MUST
// stay in sync with the terminal list used by the app (PRIMARY_ORIGINS in
// components/map.tsx, and data/london-terminals.json). Stratford is included
// even though it's adminOnly — its journeys still populate the destination
// times for users who pick it via the search bar.
const DEFAULT_PRIMARIES = [
  "CHX",  // Charing Cross
  "LST",  // Liverpool Street
  "MOG",  // Moorgate
  "ZFD",  // Farringdon
  "BFR",  // Blackfriars
  "CST",  // Cannon Street
  "FST",  // Fenchurch Street
  "LBG",  // London Bridge
  "MYB",  // Marylebone
  "PAD",  // Paddington
  "VIC",  // Victoria
  "WAT",  // Waterloo
  "WAE",  // Waterloo East
  "KGX",  // London King's Cross
  "STP",  // St Pancras International
  "EUS",  // Euston
  "SRA",  // Stratford
]

function getFlag(name) {
  const arg = process.argv.find((a) => a.startsWith(`${name}=`))
  return arg ? arg.slice(name.length + 1) : null
}

const datesArg = getFlag("--dates")
if (!datesArg) {
  console.error("Usage: RTT_TOKEN=<jwt> node scripts/refresh-all-origin-routes.mjs --dates=YYYY-MM-DD[,YYYY-MM-DD,...]")
  console.error("       Optional: --only=CRS1,CRS2  to run a subset of primaries")
  console.error("                 --throttle=MS     forwarded to child fetch script")
  console.error("                 --gap=MS          sleep between runs (default 90000)")
  process.exit(1)
}
const dates = datesArg.split(",").map((s) => s.trim()).filter(Boolean)

const onlyArg = getFlag("--only")
const primaries = onlyArg
  ? onlyArg.split(",").map((s) => s.trim().toUpperCase()).filter(Boolean)
  : DEFAULT_PRIMARIES

const throttleArg = getFlag("--throttle")
const gapArg = getFlag("--gap")
// --hours=HH,HH — passed through to each child. Lets the orchestrator run
// an afternoon-only pass (e.g. --hours=12,18) to top up destinations that
// the default 07:00–12:00 window misses because the relevant services
// only run in the afternoon direction. See the comment in
// fetch-direct-reachable.mjs near the `hFrom`/`hTo` defaults for why this
// matters (Hounslow-loop anti-clockwise + Reading-slows both end up
// under-represented by a morning-only fetch).
const hoursArg = getFlag("--hours")
const WRAPPER_GAP_MS = gapArg ? parseInt(gapArg, 10) : 90_000

if (!process.env.RTT_TOKEN) {
  console.error("Error: RTT_TOKEN env var is required")
  process.exit(1)
}

// One invocation per CRS; the child handles all the dates internally via its
// own --dates flag. Keeps the pattern simple: 1 child per primary, retries
// operate at that level.
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

function run(crs) {
  return new Promise((resolve, reject) => {
    const args = [FETCH_SCRIPT, crs, `--dates=${dates.join(",")}`]
    if (throttleArg) args.push(`--throttle=${throttleArg}`)
    if (hoursArg) args.push(`--hours=${hoursArg}`)
    const child = spawn("node", args, { stdio: "inherit", env: process.env })
    child.on("exit", (code) => {
      if (code === 0) resolve()
      else reject(new Error(`${crs} exited with code ${code}`))
    })
    child.on("error", reject)
  })
}

const started = Date.now()
const failures = []
for (let i = 0; i < primaries.length; i++) {
  const crs = primaries[i]
  console.log(`\n========================================`)
  console.log(`[${i + 1}/${primaries.length}] ${crs} — dates: ${dates.join(", ")}`)
  console.log(`========================================`)
  try {
    await run(crs)
  } catch (e) {
    console.warn(`${crs} failed: ${e.message}`)
    failures.push(crs)
  }
  if (i < primaries.length - 1) {
    console.log(`Sleeping ${WRAPPER_GAP_MS}ms before next primary...`)
    await sleep(WRAPPER_GAP_MS)
  }
}

const elapsed = Math.round((Date.now() - started) / 1000)
console.log(`\n========================================`)
console.log(`Done in ${elapsed}s`)
console.log(`Ran ${primaries.length} primaries across ${dates.length} date(s)`)
if (failures.length > 0) {
  console.log(`\nFailures (${failures.length}) — rerun individually with:`)
  for (const crs of failures) {
    console.log(`  RTT_TOKEN=$RTT_TOKEN node ${FETCH_SCRIPT} ${crs} --dates=${dates.join(",")}`)
  }
  process.exit(1)
}
