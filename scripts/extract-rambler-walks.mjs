// Extracts structured walk data from walkingclub.org.uk pages using the Claude
// API. For each walk listed in data/rambler-walks.json this script:
//
//   1. Fetches the page HTML
//   2. Strips noise (scripts, styles, HTML comments, obvious nav/footer)
//   3. Calls claude-sonnet-4-6 via the Anthropic SDK with a single tool
//      (`extract_walk`) whose input_schema defines the output shape
//   4. Post-processes: resolves place names to CRS codes, derives `features`
//      from SWC categories + extractor output, flags ambiguities
//   5. Writes the merged entry back into data/rambler-walks.json (atomic
//      per-walk so interruptions don't lose progress)
//
// Prompt caching is on — the extractor's tool schema and system prompt are
// identical across every request, so the first call pays the full prefix
// cost (~1.25×) and the remaining ~536 pay ~0.1× for that prefix. With a
// 5-minute cache TTL and sequential/low-concurrency processing the cache
// stays warm throughout a run.
//
// Usage:
//   export ANTHROPIC_API_KEY=sk-ant-…
//   node scripts/extract-rambler-walks.mjs --slug princes-risborough-to-great-missenden
//   node scripts/extract-rambler-walks.mjs --starred          # all starred walks
//   node scripts/extract-rambler-walks.mjs --todo             # walks not yet extracted (default)
//   node scripts/extract-rambler-walks.mjs --slug foo --recompute   # re-run a specific walk
//   node scripts/extract-rambler-walks.mjs --limit 5          # cap to N walks
//   node scripts/extract-rambler-walks.mjs --max-cost 10      # abort if spend exceeds $10
//
// Safe to interrupt. Re-run to resume.

import { readFileSync, writeFileSync } from "fs"
import { fileURLToPath } from "url"
import { dirname, join } from "path"
import Anthropic from "@anthropic-ai/sdk"

const __dirname = dirname(fileURLToPath(import.meta.url))
const PROJECT_ROOT = join(__dirname, "..")
const WALKS_PATH = join(PROJECT_ROOT, "data", "rambler-walks.json")
const STATIONS_PATH = join(PROJECT_ROOT, "public", "stations.json")

const MODEL = "claude-sonnet-4-6"

// Rough per-MToken pricing (USD) for cost estimation. Not authoritative —
// purely for the running-total print and the --max-cost abort.
const PRICE_IN = 3.0
const PRICE_OUT = 15.0
const PRICE_CACHE_WRITE = 3.75
const PRICE_CACHE_READ = 0.3

// User-Agent is required — the site rejects default node/curl UAs with 403.
const BROWSER_UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"

// ── Controlled vocabulary of feature slugs. Mirrored from the schema the
//    model uses so we can validate its output and strip anything off-list.
const FEATURE_VOCAB = new Set([
  "quaint-village", "mud", "woods", "sea", "hilly", "flat",
  "stately-home", "escarpments", "historic-city", "river",
  "cliffs", "beach", "heath", "moorland", "castle", "ruin",
  "canal", "pub-walk", "naturist-beach",
])

// SWC categories → features (applied after extraction). Case-insensitive.
// Only one-to-many entries listed; the rest default to no mapping.
const CATEGORY_FEATURE_MAP = {
  "coast": ["sea"],
  "beach": ["beach"],
  "naturist beach": ["naturist-beach", "beach", "sea"],
  "tough": ["hilly"],
  "easy": ["flat"],
  "palace/castle": ["castle"],
  "jurassic coast": ["cliffs", "sea"],
  "hills": ["hilly"],
}

// ── CLI parsing ────────────────────────────────────────────────────────────

function parseArgs(argv) {
  const args = { slug: null, starred: false, todo: true, recompute: false, limit: Infinity, maxCost: 50 }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === "--slug") args.slug = argv[++i]
    else if (a === "--starred") args.starred = true
    else if (a === "--todo") args.todo = true
    else if (a === "--all") args.todo = false
    else if (a === "--recompute") args.recompute = true
    else if (a === "--limit") args.limit = Number(argv[++i])
    else if (a === "--max-cost") args.maxCost = Number(argv[++i])
    else throw new Error(`Unknown arg: ${a}`)
  }
  return args
}

// ── Data loading ───────────────────────────────────────────────────────────

function loadWalks() {
  return JSON.parse(readFileSync(WALKS_PATH, "utf-8"))
}

function saveWalks(walks) {
  writeFileSync(WALKS_PATH, JSON.stringify(walks, null, 2) + "\n", "utf-8")
}

// Manual aliases for place names the SWC pages use that don't exact-match our
// official station names. Keyed by lowercase place name. Add sparingly —
// these override the automatic lookup.
const MANUAL_ALIASES = {
  "dover": "DVP",              // Dover Priory (DVC is Dovercourt in Essex — not SWC-relevant)
  "henley": "HOT",             // Henley-on-Thames (HNL is Henley-in-Arden in Warwickshire)
  "dorking (main)": "DKG",     // SWC disambiguates Dorking (Main) vs Dorking Deepdene / West
}

// Station name → CRS lookup. Case-insensitive keys; values are `{ crs, ambiguous }`.
// A name is "ambiguous" if more than one station carries that exact name
// (e.g. Lymington Town vs. Lymington Pier under the bare prefix "Lymington").
function buildStationLookup() {
  const geojson = JSON.parse(readFileSync(STATIONS_PATH, "utf-8"))
  const byLower = new Map()
  for (const f of geojson.features) {
    const name = f.properties?.name
    const crs = f.properties?.["ref:crs"]
    if (!name || !crs) continue
    const key = name.toLowerCase()
    if (byLower.has(key)) {
      // Full-name collision — shouldn't happen, but mark as ambiguous just in case.
      byLower.set(key, { ...byLower.get(key), ambiguous: true })
    } else {
      byLower.set(key, { crs, name, ambiguous: false })
    }
  }
  // Also index bare prefixes for common two-station places so "Lymington"
  // resolves to an ambiguous marker rather than a miss. Only adds prefixes
  // that map to exactly 2+ full stations (e.g. "Lymington Town" + "Lymington
  // Pier" → adds key "lymington" marked ambiguous).
  const prefixCandidates = new Map()
  for (const { name } of byLower.values()) {
    const firstWord = name.split(/\s+/)[0].toLowerCase()
    if (!prefixCandidates.has(firstWord)) prefixCandidates.set(firstWord, [])
    prefixCandidates.get(firstWord).push(name)
  }
  for (const [prefix, names] of prefixCandidates) {
    if (names.length < 2) continue
    if (byLower.has(prefix)) continue // already a full-name match → don't clobber
    byLower.set(prefix, { crs: null, name: null, ambiguous: true, candidates: names })
  }
  return byLower
}

// Resolve a place name (as written on the SWC page) to a CRS code.
// Returns `{ crs, ambiguous, candidates, match }`. Never throws.
function resolveCrs(lookup, placeName) {
  if (!placeName || typeof placeName !== "string") return { crs: null, ambiguous: false }
  const trimmed = placeName.trim()
  if (!trimmed) return { crs: null, ambiguous: false }

  const lower = trimmed.toLowerCase()

  // Try exact lowercase match first
  const direct = lookup.get(lower)
  if (direct) return { ...direct, match: "exact" }

  // Manual alias table — overrides the automatic lookup for known
  // short-name mismatches that the SWC pages use (e.g. "Dover" → DVP).
  const aliased = MANUAL_ALIASES[lower]
  if (aliased) return { crs: aliased, ambiguous: false, match: "manual-alias" }

  // Try without trailing " station"
  const stripped = trimmed.replace(/\s+station$/i, "")
  const dropped = lookup.get(stripped.toLowerCase())
  if (dropped) return { ...dropped, match: "stripped-station" }

  return { crs: null, ambiguous: false, match: "none" }
}

// ── HTML fetch + strip ─────────────────────────────────────────────────────

async function fetchWalkHtml(url) {
  const res = await fetch(url, { headers: { "User-Agent": BROWSER_UA } })
  if (!res.ok) throw new Error(`Fetch failed for ${url}: ${res.status} ${res.statusText}`)
  return res.text()
}

// Strip scripts, styles, comments, and the outer chrome (header/footer/nav)
// to cut token cost. Best-effort — aggressive but safe — the model deals
// fine with remaining whitespace and tag noise.
function stripHtml(html) {
  let s = html
  s = s.replace(/<script[\s\S]*?<\/script>/gi, "")
  s = s.replace(/<style[\s\S]*?<\/style>/gi, "")
  s = s.replace(/<!--[\s\S]*?-->/g, "")
  s = s.replace(/<noscript[\s\S]*?<\/noscript>/gi, "")
  s = s.replace(/<link[^>]*>/gi, "")
  s = s.replace(/<meta[^>]*>/gi, "")
  // Extract body to drop <head> entirely
  const bodyMatch = s.match(/<body[^>]*>([\s\S]*?)<\/body>/i)
  if (bodyMatch) s = bodyMatch[1]
  // Collapse whitespace runs
  s = s.replace(/\s{3,}/g, "\n\n").trim()
  return s
}

// ── Anthropic tool definition ──────────────────────────────────────────────

const EXTRACT_TOOL = {
  name: "extract_walk",
  description:
    "Emit structured walk data extracted from a walkingclub.org.uk page. Call this tool exactly once per page.",
  input_schema: {
    type: "object",
    required: [
      "outsideMainlandBritain", "tagline", "regions", "categories", "tags",
      "places", "walks", "features", "ambiguities",
    ],
    properties: {
      outsideMainlandBritain: {
        type: "boolean",
        description:
          "True if the walk is on an offshore island (Isle of Wight, Scilly, Lundy, Anglesey, etc.) or outside mainland Britain entirely (Ireland, continental Europe).",
      },
      tagline: {
        type: "string",
        description: "The tagline/summary sentence that appears directly beneath the walk title, verbatim.",
      },
      regions: {
        type: "array",
        items: { type: "string" },
        description:
          "Geographic region labels near the title (e.g. 'East Sussex', 'Chilterns'). Do NOT include 'My Favourites' (that's a category).",
      },
      categories: {
        type: "array",
        items: { type: "string" },
        description:
          "Theme/category labels (e.g. 'Coast', 'Tough', 'Easy', 'National Trust', 'Jurassic Coast', 'My Favourites').",
      },
      tags: {
        type: "array",
        items: { type: "string" },
        description:
          "Internal SWC tags (e.g. 'swcwalks', 'book2', 'walk28', 'tocw228'). Exclude CSS classes like 'walkicon'.",
      },
      places: {
        type: "object",
        required: ["villages", "landmarks", "historic", "modern", "nature", "paths"],
        properties: {
          villages:  { type: "array", items: { type: "string" }, description: "Villages, hamlets, small towns." },
          landmarks: { type: "array", items: { type: "string" }, description: "Natural features: headlands, valleys, beaches, named hills/cliffs." },
          historic:  { type: "array", items: { type: "string" }, description: "Castles, ruins, abbeys, stately homes, historic houses, monuments." },
          modern:    { type: "array", items: { type: "string" }, description: "Modern buildings, bridges, sculptures, visitor centres, notable cafés/pubs as buildings." },
          nature:    { type: "array", items: { type: "string" }, description: "National parks, AONBs, nature reserves, forests, woodlands." },
          paths:     { type: "array", items: { type: "string" }, description: "Named ways/trails (South Downs Way, Solent Way, Ridgeway, etc.)." },
        },
      },
      walks: {
        type: "array",
        description:
          "Every distinct station-to-station walk described on the page. IMPORTANT: include walks whose endpoints are non-stations (set requiresBus=true) so downstream logic can decide what to keep. Also include any shorter 'walk onto the station' variants described in Walk Options.",
        items: {
          type: "object",
          required: [
            "role", "name", "startPlace", "endPlace", "requiresBus",
            "distanceKm", "distanceMiles", "hours", "lunchStops",
            "terrain", "sights", "warnings",
          ],
          properties: {
            role: {
              type: "string",
              enum: ["main", "shorter", "longer", "alternative", "variant"],
              description: "The Main Walk = 'main'. Variants described in Walk Options = one of the other values.",
            },
            name: {
              type: "string",
              description:
                "How the variant is referred to on the page (e.g. 'Main Walk', 'Shorter Walk', 'To Corfe Castle', 'Walk to New Milton').",
            },
            startPlace: {
              type: "string",
              description: "Start place name exactly as written on the page (e.g. 'Lymington', not 'Lymington Town').",
            },
            endPlace: {
              type: "string",
              description: "End place name exactly as written on the page.",
            },
            requiresBus: {
              type: "boolean",
              description:
                "True if the walk requires a bus at any point between the two stations — including when the walk's endpoint is not itself a mainline station (heritage railways like Swanage DO NOT count). A bus within the same town after arrival doesn't count.",
            },
            distanceKm: { type: ["number", "null"], description: "Distance in km, or null if not given." },
            distanceMiles: { type: ["number", "null"], description: "Distance in miles, or null if not given." },
            hours: {
              type: ["number", "null"],
              description:
                "Walking time in hours (fractional OK — 4.5 means 4h30m). Null if not given. Do NOT use 'for the whole outing' times — only pure walking time.",
            },
            lunchStops: {
              type: "array",
              items: {
                type: "object",
                required: ["name", "location"],
                properties: {
                  name: { type: "string", description: "Pub/cafe name, e.g. 'Gun Inn' (without leading 'The')." },
                  location: { type: "string", description: "Village/locale, e.g. 'Keyhaven'. Empty string if not given." },
                  url: { type: ["string", "null"], description: "Official website URL if the SWC page links to one. Otherwise null." },
                },
              },
              description:
                "Recommended lunch stops for THIS variant. EXCLUDE any stops explicitly noted as closed, shut down, or no longer serving.",
            },
            terrain: {
              type: "string",
              description:
                "ONE short clipped sentence listing terrain types, landscape character, and atmosphere. Examples: 'Hills, sloping fields, beech woods, hamlets, upmarket farms, and cottages.' or 'Clifftop path with steep climbs and a remote naturist beach.' Do NOT describe route flow (A to B to C). Do NOT mention lunch, distances, or times. Keep it terse — just comma-separated phrases. End with a period.",
            },
            sights: {
              type: "array",
              items: {
                type: "object",
                required: ["name"],
                properties: {
                  name: {
                    type: "string",
                    description:
                      "JUST the sight's name — no location suffix, no description, no commas. Examples: 'Lacey Green Windmill', 'Roald Dahl Museum', 'Hastings Castle'. NOT 'Holy Trinity Church, Bledlow'.",
                  },
                  url: { type: ["string", "null"], description: "Official or Wikipedia URL if the SWC page links to one. Otherwise null." },
                },
              },
              description:
                "Notable sights along THIS variant. RULES: (1) EVERY sight the SWC page links to externally MUST be included, with its URL — these are the page's authoritative sights. (2) Include all additional non-linked sights that genuinely reward a visit: museums, castles, stately homes, historic houses, ruins, notable churches, large gardens, cathedrals, famous landmarks. No fixed cap — include what's actually worth seeing on the route. (3) Skip trivia: plaques, small markers, street furniture, minor signposts, or generic 'pretty village' features that aren't named attractions. Monuments/crosses/obelisks are fine if the page treats them as a landmark. (4) Just the names — no descriptions, no location suffixes.",
            },
            warnings: {
              type: "string",
              maxLength: 35,
              description:
                "ONE ultra-short warning — 2 to 4 words max. Examples: 'Can be muddy.' / 'Crumbly cliff edges.' / 'Check tide timings.' / 'MOD closures apply.' / 'Steep descents.' Do NOT name specific sections, seasons, or weather conditions. Empty string if nothing warrants flagging.",
            },
          },
        },
      },
      features: {
        type: "array",
        description:
          "Feature tags from the fixed vocabulary. Only include a feature if there is clear evidence on the page.",
        items: {
          type: "string",
          enum: Array.from(FEATURE_VOCAB),
        },
      },
      ambiguities: {
        type: "array",
        items: { type: "string" },
        description:
          "ONLY populate with issues that genuinely need human judgement to resolve. Valid examples: (a) a start/end place that could match multiple real stations (e.g. 'Lymington' could be Lymington Town or Lymington Pier), (b) a walk variant mentioned but not clearly described, (c) missing distances or times where the walk appears incomplete on the page, (d) uncertainty about whether a walk is station-to-station or bus-dependent. DO NOT populate with: observations about the page, notes that categories didn't map to features, mentions of taxi/bus availability when taxis aren't required, mentions of section counts, remarks about toughness ratings. If in doubt, leave empty — a quiet extraction is better than a chatty one. Empty array is the default.",
      },
    },
  },
  // Cache the tool schema — it's identical across every request. Combined
  // with the cached system prompt below this gives a large shared prefix.
  cache_control: { type: "ephemeral" },
}

const SYSTEM_PROMPT = `You extract structured data from HTML pages on walkingclub.org.uk (the Saturday Walkers Club).

Your job: given ONE walk page's HTML, extract all fields defined by the \`extract_walk\` tool. Call it exactly once.

Key rules:

1. Extract every distinct station-to-station walk variant — Main Walk plus any shorter/longer/alternative variants described in "Walk Options". Include walks whose endpoint is NOT a station by setting requiresBus=true; downstream logic decides what to keep. Heritage railway stations (Swanage Railway, etc.) DO NOT count as stations — treat them like buses.

2. Many pages have a "Return by bus" tagline for the Main Walk but describe a shorter station-to-station variant in Walk Options. EXTRACT BOTH — set requiresBus accurately for each.

3. The Main Walk is the primary route described on the page. Variants live under "Walk Options" or elsewhere in the body.

4. distanceKm / distanceMiles / hours: look in BOTH the "Length" section AND "Walk Options". Variants often only appear in Walk Options. For hours, use pure walking time only — ignore "for the whole outing including trains, sights and meals".

5. Per-walk description is NOT one paragraph — it's FOUR tightly-separated fields. Fill each independently:
   a. terrain: one clipped sentence listing terrain types and atmosphere (commas, not prose). Example: "Hills, sloping fields, beech woods, hamlets, upmarket farms, and cottages." Do NOT mention hazards (mud, cliffs, etc.) — those belong in the warnings field.
   b. sights: EVERY linked sight (with URL). PLUS all additional non-linked sights that reward a visit — museums, castles, stately homes, churches, gardens, ruins, famous landmarks. No fixed cap. Skip trivia (plaques, small markers, generic "pretty village"). Just the name — NO location suffix (NOT "Holy Trinity Church, Bledlow" — just "Holy Trinity Church").
   c. warnings: 2-4 words MAX. Just the hazard type. "Can be muddy." — NOT "Path through Dunsmore Woods can be very muddy in winter." Empty string if none.
   CRITICAL: Do NOT describe route flow (A to B to C to D). Do NOT mention lunch timing. Do NOT reference "the book" or "Book 2". Do NOT include distances or walking times in these fields. Do NOT include the "Rambler favourite!" flourish. Terser is always better.

6. places: include every named place mentioned (villages passed through, landmarks seen, historic sites visited, nature reserves crossed). Be generous — don't filter to "notable" only. Group by type per the schema.

7. features: use ONLY slugs from the vocabulary. Be evidence-based — don't guess. Don't try to infer features from SWC categories (caller does that post-extraction); focus on features you see directly in the body (mud warnings, river names, woods mentions, etc.).

8. outsideMainlandBritain: true only for walks on offshore islands (Isle of Wight, Scilly, Lundy, Anglesey offshore parts) or continental Europe. Mainland Wales/Scotland are still mainland Britain.

9. lunchStops: exclude any stop explicitly noted as closed, shut down, or no longer serving.

Output only via the extract_walk tool call. Do not write any prose in the text response.`

// ── Claude call ────────────────────────────────────────────────────────────

const client = new Anthropic()

async function extractWalk(slug, url, html) {
  const stripped = stripHtml(html)
  const userPrompt = `URL: ${url}\n\nHTML body content:\n\n${stripped}`

  const response = await client.messages.create({
    model: MODEL,
    max_tokens: 8192,
    system: [
      {
        type: "text",
        text: SYSTEM_PROMPT,
        // Cache the system prompt. Combined with the cached tool schema
        // above, this is a ~2.5k-token shared prefix that every subsequent
        // request reads from the cache.
        cache_control: { type: "ephemeral" },
      },
    ],
    tools: [EXTRACT_TOOL],
    tool_choice: { type: "tool", name: "extract_walk" },
    messages: [{ role: "user", content: userPrompt }],
  })

  const toolUse = response.content.find((b) => b.type === "tool_use" && b.name === "extract_walk")
  if (!toolUse) {
    throw new Error(`No extract_walk tool call in response for ${slug}`)
  }
  return { extracted: toolUse.input, usage: response.usage }
}

// ── Post-processing ────────────────────────────────────────────────────────

function categoriesToFeatures(categories) {
  const features = new Set()
  for (const cat of categories ?? []) {
    const mapped = CATEGORY_FEATURE_MAP[cat.toLowerCase()]
    if (mapped) mapped.forEach((f) => features.add(f))
  }
  return features
}

function validateFeatures(raw) {
  const features = new Set()
  for (const f of raw ?? []) {
    if (FEATURE_VOCAB.has(f)) features.add(f)
  }
  return features
}

function resolveWalkStations(lookup, walk) {
  const ambiguities = []
  const resolveOne = (place, label) => {
    const r = resolveCrs(lookup, place)
    if (!r.crs && !r.ambiguous) return { crs: null, flag: `${label} "${place}" not found in stations` }
    if (r.ambiguous) {
      const candidates = r.candidates?.join(", ") ?? "(multiple)"
      return { crs: null, flag: `${label} "${place}" is ambiguous (candidates: ${candidates})` }
    }
    return { crs: r.crs, flag: null }
  }
  const start = resolveOne(walk.startPlace, "Start")
  const end = resolveOne(walk.endPlace, "End")
  // Only flag CRS failures for walks that ARE meant to be station-to-station.
  // Bus walks legitimately end at non-stations (Barton-on-Sea, Beachy Head,
  // Exceat) — that's the defining characteristic, not a data error.
  if (!walk.requiresBus) {
    if (start.flag) ambiguities.push(start.flag)
    if (end.flag) ambiguities.push(end.flag)
  }
  return { startStation: start.crs, endStation: end.crs, ambiguities }
}

// Merge the extractor output into the existing walk entry, resolve CRS codes,
// derive features, and return the new entry + any ambiguity strings.
function mergeExtraction(entry, extracted, lookup) {
  const walkAmbiguities = []
  const resolvedWalks = (extracted.walks ?? []).map((w) => {
    const { startStation, endStation, ambiguities } = resolveWalkStations(lookup, w)
    walkAmbiguities.push(...ambiguities)
    // Decide whether this walk is station-to-station (usable for Phase 6).
    const stationToStation = Boolean(startStation && endStation && !w.requiresBus)
    return {
      role: w.role,
      name: w.name,
      startPlace: w.startPlace,
      endPlace: w.endPlace,
      startStation,
      endStation,
      requiresBus: w.requiresBus,
      stationToStation,
      distanceKm: w.distanceKm,
      distanceMiles: w.distanceMiles,
      hours: w.hours,
      lunchStops: w.lunchStops,
      terrain: w.terrain ?? "",
      sights: Array.isArray(w.sights) ? w.sights : [],
      warnings: w.warnings ?? "",
    }
  })

  // Derive features: SWC categories → features, union with body-detected.
  const features = new Set([
    ...categoriesToFeatures(extracted.categories),
    ...validateFeatures(extracted.features),
  ])

  const allAmbiguities = [...(extracted.ambiguities ?? []), ...walkAmbiguities]
  const hasStationToStation = resolvedWalks.some((w) => w.stationToStation)

  // `issues: true` means "needs human review during Phase 4". We flag only
  // on concrete blockers:
  //   - CRS resolution failed for a non-bus walk (walkAmbiguities is non-empty)
  //   - This is a mainland-Britain page but no valid station-to-station walk
  //     could be identified (so the page contributes nothing and that might
  //     be a filtering mistake)
  // Extractor-level observations go into `notes` for context but do NOT
  // trigger `issues: true` — otherwise the admin table floods with walks
  // that are fine.
  const hasHardIssue =
    walkAmbiguities.length > 0 ||
    (!extracted.outsideMainlandBritain && !hasStationToStation)

  return {
    ...entry,
    outsideMainlandBritain: extracted.outsideMainlandBritain,
    tagline: extracted.tagline,
    regions: [...new Set([...(entry.region ? [entry.region] : []), ...(extracted.regions ?? [])])],
    categories: extracted.categories ?? [],
    tags: extracted.tags ?? [],
    places: extracted.places ?? { villages: [], landmarks: [], historic: [], modern: [], nature: [], paths: [] },
    features: [...features].sort(),
    walks: resolvedWalks,
    extracted: true,
    issues: hasHardIssue,
    notes: extracted.outsideMainlandBritain
      ? "Outside mainland Britain — no walks extracted for T2G."
      : allAmbiguities.join(" | "),
  }
}

// ── Cost tracking ──────────────────────────────────────────────────────────

function computeCost(usage) {
  // `input_tokens` in the usage block is the uncached remainder. Cache
  // write/read counts sit alongside.
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

// ── Target selection ───────────────────────────────────────────────────────

function selectTargets(walks, args) {
  const all = Object.values(walks)
  let targets = all
  if (args.slug) {
    const one = walks[args.slug]
    if (!one) throw new Error(`Slug not found: ${args.slug}`)
    targets = [one]
  } else if (args.starred) {
    targets = all.filter((w) => w.favourite)
  }
  if (!args.recompute && args.todo && !args.slug) {
    targets = targets.filter((w) => !w.extracted)
  }
  // --slug + --recompute always runs; --slug alone skips if already extracted
  if (args.slug && !args.recompute && walks[args.slug].extracted) {
    // eslint-disable-next-line no-console
    console.log(`Walk ${args.slug} already extracted — pass --recompute to re-run.`)
    return []
  }
  targets.sort((a, b) => a.slug.localeCompare(b.slug))
  if (Number.isFinite(args.limit)) targets = targets.slice(0, args.limit)
  return targets
}

// ── Main loop ──────────────────────────────────────────────────────────────

async function main() {
  const args = parseArgs(process.argv.slice(2))
  if (!process.env.ANTHROPIC_API_KEY) {
    throw new Error("Missing ANTHROPIC_API_KEY env var")
  }

  const lookup = buildStationLookup()
  const walks = loadWalks()
  const targets = selectTargets(walks, args)

  // eslint-disable-next-line no-console
  console.log(`Extracting ${targets.length} walks with model ${MODEL}.`)
  // eslint-disable-next-line no-console
  console.log(`Cost cap: $${args.maxCost.toFixed(2)}.`)
  let totalCost = 0

  for (let i = 0; i < targets.length; i++) {
    const walk = targets[i]
    const label = `[${i + 1}/${targets.length}] ${walk.slug}`
    try {
      const html = await fetchWalkHtml(walk.url)
      const { extracted, usage } = await extractWalk(walk.slug, walk.url, html)
      const cost = computeCost(usage)
      totalCost += cost

      const merged = mergeExtraction(walks[walk.slug], extracted, lookup)
      walks[walk.slug] = merged
      saveWalks(walks) // atomic per-walk

      const cacheNote =
        (usage.cache_creation_input_tokens ?? 0) > 0
          ? `cached(wrote ${usage.cache_creation_input_tokens})`
          : `cached(read ${usage.cache_read_input_tokens ?? 0})`
      // eslint-disable-next-line no-console
      console.log(
        `${label}  $${cost.toFixed(4)}  running $${totalCost.toFixed(3)}  ${cacheNote}  ` +
          `walks:${merged.walks.length} s2s:${merged.walks.filter((w) => w.stationToStation).length} ` +
          `features:${merged.features.length}  issues:${merged.issues ? "Y" : "n"}`,
      )
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error(`${label}  ERROR: ${err instanceof Error ? err.message : err}`)
      // Leave the entry unextracted and keep going
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
