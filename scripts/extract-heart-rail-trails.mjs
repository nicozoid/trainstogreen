// Extracts structured walk data from the 36 Heart Community Rail
// "Rail Trails" PDFs (https://www.heartcommunityrail.org.uk/railtrails).
//
// Each PDF describes ONE circular walk from a named Warwickshire-area
// station. Unlike the SWC site — where each page can have several
// station-to-station variants — Heart PDFs are single-walk, always
// circular, with a consistent layout: title, distance, hours,
// description, named sights with URLs, and recommended pubs/cafes.
//
// Output shape matches data/rambler-walks.json (one entry per walk)
// so build-rambler-notes.mjs can merge the two without code changes.
//
// Usage:
//   export ANTHROPIC_API_KEY=sk-ant-…
//   node scripts/extract-heart-rail-trails.mjs
//   node scripts/extract-heart-rail-trails.mjs --slug heart-rail-trail-warwick
//   node scripts/extract-heart-rail-trails.mjs --recompute        # re-run all
//   node scripts/extract-heart-rail-trails.mjs --max-cost 5

import { readFileSync, writeFileSync, existsSync } from "fs"
import { fileURLToPath } from "url"
import { dirname, join } from "path"
import Anthropic from "@anthropic-ai/sdk"

const __dirname = dirname(fileURLToPath(import.meta.url))
const PROJECT_ROOT = join(__dirname, "..")
const STATIONS_PATH = join(PROJECT_ROOT, "public", "stations.json")
const OUT_PATH = join(PROJECT_ROOT, "data", "heart-rail-trails-walks.json")

const MODEL = "claude-sonnet-4-6"

// Same pricing model as the SWC extractor; used for running-total +
// cost cap only.
const PRICE_IN = 3.0, PRICE_OUT = 15.0, PRICE_CACHE_WRITE = 3.75, PRICE_CACHE_READ = 0.3

// Hard-coded list of the 36 PDFs. Each entry maps a human station
// name to the document URL. A follow-up fetch of the Heart page
// would refresh this automatically; for a one-off extraction the
// list is baked in.
const HEART_WALKS = [
  { station: "Wythall", url: "https://api.warwickshire.gov.uk/documents/WCCC-1615347118-830" },
  { station: "Wootton Wawen", url: "https://api.warwickshire.gov.uk/documents/WCCC-1615347118-871" },
  { station: "Wilmcote", url: "https://api.warwickshire.gov.uk/documents/WCCC-1615347118-828" },
  { station: "Whitlocks End", url: "https://api.warwickshire.gov.uk/documents/WCCC-1615347118-827" },
  { station: "Warwick Parkway", url: "https://api.warwickshire.gov.uk/documents/WCCC-1615347118-826" },
  { station: "Warwick", url: "https://api.warwickshire.gov.uk/documents/WCCC-1615347118-683" },
  { station: "The Lakes", url: "https://api.warwickshire.gov.uk/documents/WCCC-1615347118-825" },
  { station: "Tile Hill", url: "https://api.warwickshire.gov.uk/documents/WCCC-1615347118-913" },
  { station: "Stratford-upon-Avon", url: "https://api.warwickshire.gov.uk/documents/WCCC-1615347118-1237" },
  { station: "Stratford-upon-Avon Parkway", url: "https://api.warwickshire.gov.uk/documents/WCCC-1615347118-823" },
  { station: "Shirley", url: "https://api.warwickshire.gov.uk/documents/WCCC-1615347118-822" },
  { station: "Rugby", url: "https://api.warwickshire.gov.uk/documents/WCCC-1615347118-821" },
  { station: "Nuneaton", url: "https://api.warwickshire.gov.uk/documents/WCCC-1615347118-820" },
  { station: "Marston Green", url: "https://api.warwickshire.gov.uk/documents/WCCC-1615347118-819" },
  { station: "Leamington Spa", url: "https://api.warwickshire.gov.uk/documents/WCCC-1615347118-678" },
  { station: "Henley-in-Arden", url: "https://api.warwickshire.gov.uk/documents/WCCC-1615347118-817" },
  { station: "Hatton", url: "https://api.warwickshire.gov.uk/documents/WCCC-1615347118-1238" },
  { station: "Earlswood", url: "https://api.warwickshire.gov.uk/documents/WCCC-1615347118-818" },
  { station: "Claverdon", url: "https://api.warwickshire.gov.uk/documents/WCCC-1615347118-816" },
  { station: "Canley", url: "https://api.warwickshire.gov.uk/documents/WCCC-1615347118-869" },
  { station: "Bermuda Park", url: "https://api.warwickshire.gov.uk/documents/WCCC-1615347118-814" },
  { station: "Bedworth", url: "https://api.warwickshire.gov.uk/documents/WCCC-1615347118-831" },
  { station: "Bearley", url: "https://api.warwickshire.gov.uk/documents/WCCC-1615347118-813" },
  { station: "Birmingham International", url: "https://api.warwickshire.gov.uk/documents/WCCC-1615347118-675" },
  { station: "Coventry", url: "https://api.warwickshire.gov.uk/documents/WCCC-1615347118-701" },
  { station: "Coventry Arena", url: "https://api.warwickshire.gov.uk/documents/WCCC-1615347118-1236" },
  { station: "Berkswell", url: "https://api.warwickshire.gov.uk/documents/WCCC-1615347118-853" },
  { station: "Danzey", url: "https://api.warwickshire.gov.uk/documents/WCCC-1615347118-851" },
  { station: "Olton", url: "https://api.warwickshire.gov.uk/documents/WCCC-1615347118-856" },
  { station: "Kenilworth", url: "https://api.warwickshire.gov.uk/documents/WCCC-1615347118-852" },
  { station: "Hampton-in-Arden", url: "https://api.warwickshire.gov.uk/documents/WCCC-1615347118-850" },
  { station: "Lapworth", url: "https://api.warwickshire.gov.uk/documents/WCCC-1615347118-854" },
  { station: "Solihull", url: "https://api.warwickshire.gov.uk/documents/WCCC-1615347118-855" },
  { station: "Dorridge", url: "https://api.warwickshire.gov.uk/documents/WCCC-1615347118-885" },
  { station: "Widney Manor", url: "https://api.warwickshire.gov.uk/documents/WCCC-1615347118-888" },
  { station: "Wood End", url: "https://api.warwickshire.gov.uk/documents/WCCC-1615347118-887" },
]

const INDEX_URL = "https://www.heartcommunityrail.org.uk/railtrails"

// ── CLI ────────────────────────────────────────────────────────────────────
function parseArgs(argv) {
  const args = { slug: null, recompute: false, maxCost: 10 }
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--slug") args.slug = argv[++i]
    else if (argv[i] === "--recompute") args.recompute = true
    else if (argv[i] === "--max-cost") args.maxCost = Number(argv[++i])
    else throw new Error(`Unknown arg: ${argv[i]}`)
  }
  return args
}

// ── Station CRS lookup (aliases for common name variants) ──────────────────
const stationsGeo = JSON.parse(readFileSync(STATIONS_PATH, "utf-8"))
const coordByName = new Map()
const crsByName = new Map()
for (const f of stationsGeo.features) {
  const name = f.properties?.name
  const crs = f.properties?.["ref:crs"]
  const [lng, lat] = f.geometry?.coordinates ?? []
  if (name && crs) {
    crsByName.set(name, crs)
    coordByName.set(name, `${lng},${lat}`)
  }
}
// Heart-specific aliases — the PDF titles don't always match our
// stations.json names exactly. This table handles the deltas.
// Alias table — kept empty at the moment since all 36 Heart station
// names now match stations.json exactly. Retained as a seam in case
// future Heart additions need a rename mapping.
const NAME_ALIASES = {}
function resolveCrs(name) {
  const aliased = NAME_ALIASES[name] ?? name
  return crsByName.get(aliased) ?? null
}

// ── Tool definition ────────────────────────────────────────────────────────
const EXTRACT_TOOL = {
  name: "extract_heart_walk",
  description: "Emit structured data for one Heart Community Rail circular walk PDF. Call once.",
  input_schema: {
    type: "object",
    required: [
      "walkTitle", "distanceMiles", "hours", "difficulty", "tagline",
      "terrain", "sights", "lunchStops", "warnings",
    ],
    properties: {
      walkTitle: {
        type: "string",
        description: "Walk title exactly as on page 1 (e.g. 'Warwick Circular Walk').",
      },
      distanceMiles: {
        type: ["number", "null"],
        description: "Distance in miles as shown on page 1 (e.g. 7.8). Null if not given.",
      },
      hours: {
        type: ["number", "null"],
        description: "Walking time in hours from page 1 (e.g. 4 for '4 Hours'). Null if not given.",
      },
      difficulty: {
        type: "string",
        description: "Difficulty label from page 1 — 'Easy', 'Moderate', 'Hard', etc. Empty string if not given.",
      },
      tagline: {
        type: "string",
        description:
          "The one-paragraph description of the walk from the start-info box on page 1 (e.g. 'Explore Warwickshire's historic county town and its world famous Castle as you wander along the banks of the River Avon.'). Verbatim.",
      },
      terrain: {
        type: "string",
        description:
          "ONE short clipped sentence listing terrain types and atmosphere. Commas, not prose. Example: 'Historic market town, river, canal towpath, open fields, golf course.' Do NOT mention hazards — those go in warnings.",
      },
      sights: {
        type: "array",
        items: {
          type: "object",
          required: ["name"],
          properties: {
            name: { type: "string", description: "Sight name — no location suffix, no description." },
            url: { type: ["string", "null"], description: "URL from the PDF if present, otherwise null." },
          },
        },
        description:
          "All named sights in the 'Trail Highlights' section and also any notable named landmarks mentioned on page 1 (castles, churches, museums, gardens, ruins, historic buildings). Each entry: name + URL (if printed). Exclude pubs/cafes — those go in lunchStops.",
      },
      lunchStops: {
        type: "array",
        items: {
          type: "object",
          required: ["name", "location"],
          properties: {
            name: { type: "string", description: "Pub/cafe/eatery name (without leading 'The')." },
            location: { type: "string", description: "Village/area if given, otherwise empty string." },
            url: { type: ["string", "null"], description: "URL from the PDF if present." },
          },
        },
        description:
          "Pubs, cafes, bakeries, restaurants, tea rooms recommended on pages 1-2. Include the URL if printed next to the name.",
      },
      warnings: {
        type: "string",
        maxLength: 35,
        description:
          "ONE ultra-short hazard warning — 2-4 words. 'Can be muddy.' or 'Cliff edges crumbly.' Empty string if no warning.",
      },
    },
  },
}

const SYSTEM_PROMPT = `You are extracting structured walk data from a Heart Community Rail "Rail Trails" PDF.
Each PDF describes ONE circular walk that starts and ends at a single Warwickshire-area station.

Layout: page 1 has the title, distance, hours, difficulty, a one-paragraph tagline, and a main-sights list. Page 2 has "Trail Highlights" (sights A-F, usually including eateries with URLs). Page 3 is the map + turn-by-turn directions.

Rules:
- Extract all fields per the extract_heart_walk tool schema.
- For lunchStops, include every recommended pub/cafe/eatery on page 1 or 2 — include their URL when printed.
- For sights, include every named castle/church/museum/garden/ruin/etc. mentioned — with URLs when printed. Skip pubs/cafes (those are lunch stops).
- terrain must be ONE short clipped sentence (commas, no prose, no hazard mentions).
- warnings: 2-4 words or empty string.
- If the walk is not a circular (e.g. point-to-point), note that in terrain and still emit the schema.
- Output only via the tool call. No prose.`

const client = new Anthropic()

async function fetchPdfBase64(url) {
  const res = await fetch(url)
  if (!res.ok) throw new Error(`PDF fetch failed: ${res.status} ${res.statusText}`)
  const buf = Buffer.from(await res.arrayBuffer())
  return buf.toString("base64")
}

async function extractWalk(station, url) {
  const base64 = await fetchPdfBase64(url)
  const response = await client.messages.create({
    model: MODEL,
    max_tokens: 4096,
    system: [
      {
        type: "text",
        text: SYSTEM_PROMPT,
        cache_control: { type: "ephemeral" },
      },
    ],
    tools: [EXTRACT_TOOL],
    tool_choice: { type: "tool", name: "extract_heart_walk" },
    messages: [
      {
        role: "user",
        content: [
          {
            type: "document",
            source: { type: "base64", media_type: "application/pdf", data: base64 },
          },
          {
            type: "text",
            text: `Extract the walk for "${station}" (source PDF: ${url}).`,
          },
        ],
      },
    ],
  })
  const toolUse = response.content.find((b) => b.type === "tool_use" && b.name === "extract_heart_walk")
  if (!toolUse) throw new Error(`No tool_use in response for ${station}`)
  return { extracted: toolUse.input, usage: response.usage }
}

function computeCost(usage) {
  const inputUncached = usage.input_tokens ?? 0
  const cacheWrite = usage.cache_creation_input_tokens ?? 0
  const cacheRead = usage.cache_read_input_tokens ?? 0
  const output = usage.output_tokens ?? 0
  return (
    (inputUncached / 1e6) * PRICE_IN +
    (cacheWrite / 1e6) * PRICE_CACHE_WRITE +
    (cacheRead / 1e6) * PRICE_CACHE_READ +
    (output / 1e6) * PRICE_OUT
  )
}

// Convert extracted data + station lookup into a rambler-walks-shaped entry.
function buildEntry(station, url, x) {
  const crs = resolveCrs(station)
  const slug = "heart-rail-trail-" + station
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/(^-|-$)/g, "")
  // Issue criteria:
  //   - station name not found in stations.json (CRS resolution failed)
  //   - distance or hours missing (should always be present on page 1)
  const ambiguities = []
  if (!crs) ambiguities.push(`Station "${station}" not found in stations.json`)
  if (x.distanceMiles == null) ambiguities.push(`No distance listed on page 1`)
  if (x.hours == null) ambiguities.push(`No walking time listed on page 1`)

  const stationToStation = Boolean(crs)
  const notesText = ambiguities.length
    ? `Source: ${url} | ${ambiguities.join(" | ")}`
    : ""

  return {
    slug,
    title: x.walkTitle || `${station} Circular`,
    url,
    favourite: false,
    region: "Warwickshire",
    tags: ["heart-community-rail"],
    categories: ["Circular", x.difficulty].filter(Boolean),
    places: { villages: [], landmarks: [], historic: [], modern: [], nature: [], paths: [] },
    features: [],
    walks: [
      {
        role: "main",
        name: x.walkTitle || `${station} Circular Walk`,
        startPlace: station,
        endPlace: station,
        startStation: crs,
        endStation: crs,
        requiresBus: false,
        stationToStation,
        distanceKm: null,
        distanceMiles: x.distanceMiles ?? null,
        hours: x.hours ?? null,
        lunchStops: (x.lunchStops ?? []).map((l) => ({
          name: l.name,
          location: l.location ?? "",
          url: l.url ?? null,
        })),
        terrain: x.tagline && !x.terrain ? x.tagline : (x.terrain ?? ""),
        sights: (x.sights ?? []).map((s) => ({ name: s.name, url: s.url ?? null })),
        warnings: x.warnings ?? "",
      },
    ],
    extracted: true,
    onMap: false,
    issues: ambiguities.length > 0,
    notes: notesText,
    outsideMainlandBritain: false,
    sourceIndex: INDEX_URL,
  }
}

// ── Main loop ──────────────────────────────────────────────────────────────
async function main() {
  const args = parseArgs(process.argv.slice(2))
  if (!process.env.ANTHROPIC_API_KEY) throw new Error("Missing ANTHROPIC_API_KEY")

  const existing = existsSync(OUT_PATH) ? JSON.parse(readFileSync(OUT_PATH, "utf-8")) : {}
  const targets = args.slug
    ? HEART_WALKS.filter((w) => "heart-rail-trail-" + w.station.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "") === args.slug)
    : HEART_WALKS
  // eslint-disable-next-line no-console
  console.log(`Extracting ${targets.length} Heart rail-trail PDFs.`)
  let totalCost = 0
  for (let i = 0; i < targets.length; i++) {
    const { station, url } = targets[i]
    const slug = "heart-rail-trail-" + station.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "")
    if (!args.recompute && existing[slug]?.extracted) {
      // eslint-disable-next-line no-console
      console.log(`[${i + 1}/${targets.length}] ${slug}  (already extracted — skip)`)
      continue
    }
    try {
      const { extracted, usage } = await extractWalk(station, url)
      const cost = computeCost(usage)
      totalCost += cost
      const entry = buildEntry(station, url, extracted)
      existing[slug] = entry
      writeFileSync(OUT_PATH, JSON.stringify(existing, null, 2) + "\n", "utf-8")
      // eslint-disable-next-line no-console
      console.log(
        `[${i + 1}/${targets.length}] ${slug}  $${cost.toFixed(4)}  running $${totalCost.toFixed(3)}  ` +
          `crs=${entry.walks[0].startStation ?? "—"}  miles=${entry.walks[0].distanceMiles ?? "—"}  issues=${entry.issues ? "Y" : "n"}`
      )
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error(`[${i + 1}/${targets.length}] ${slug}  ERROR: ${err instanceof Error ? err.message : err}`)
    }
    if (totalCost > args.maxCost) {
      // eslint-disable-next-line no-console
      console.error(`\nCost cap $${args.maxCost} exceeded ($${totalCost.toFixed(2)}). Stopping.`)
      break
    }
  }
  // eslint-disable-next-line no-console
  console.log(`\nDone. Total cost: $${totalCost.toFixed(3)}`)
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error(err)
  process.exit(1)
})
