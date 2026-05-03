// Single source of truth for station identity across the codebase.
// Every real station and every cluster anchor maps to ONE canonical
// 3-or-4-character ID:
//
//   • 3-char CRS code — National Rail stations (e.g. "PAD", "KGX")
//   • 4-char synthetic ID — non-NR stations (e.g. "UBKR" for Baker
//     Street Underground). First letter encodes the source network:
//
//       U = London Underground            G = Glasgow Subway
//       D = Docklands Light Railway       N = Northern Ireland Railways
//       O = London Overground             Z = heritage / tourism / unknown
//       E = Elizabeth line (standalone)
//       M = Tyne & Wear Metro
//
//   • 4-char synthetic ID with C-prefix — cluster anchors (e.g.
//     "CSTR" for the Stratford cluster, "CLON" for Central London).
//
// External data sources (RTT, walk providers, OSM, map clicks) speak
// in coordKeys or station names. Resolve them AT THE BOUNDARY via
// resolveCoordKey() or resolveName(); use the resulting ID for all
// internal logic. Never let names or coordKeys leak past the boundary.

import stationsData from "../public/stations.json"
import clustersData from "./clusters-data.json"

// ── Public types ─────────────────────────────────────────────────────

// String alias rather than a branded type so existing string-typed code
// can adopt this gradually without ceremony. The 3-vs-4 char distinction
// is the visual cue.
export type StationId = string

export type StationRecord = {
  id: StationId
  name: string
  coord: [number, number]   // [lng, lat]
  coordKey: string          // `${lng},${lat}` — matches data-file convention
  network: string | null    // OSM `network` tag, or null for cluster anchors
  isSynthetic: boolean      // true = id is synthetic (4 chars), not real CRS
  isClusterAnchor: boolean  // true = synthetic centroid, not a real station
}

// ── Synthetic ID generation ──────────────────────────────────────────

// Maps an OSM `network` tag to its synthetic-ID prefix letter. Multi-
// network strings (e.g. "London Underground;London Overground") use the
// HIGHEST-priority match — Overground beats Underground, etc. — matching
// the station-disambiguation memory rule. Stations with a National Rail
// CRS never reach this function (they use their CRS as ID directly).
function networkPrefix(network: string | null | undefined): string {
  if (!network || network === "unknown" || network === "None") return "Z"
  if (network.includes("Elizabeth line")) return "E"
  if (network.includes("London Overground")) return "O"
  if (network.includes("Docklands Light Railway")) return "D"
  if (network.includes("London Underground")) return "U"
  if (network.includes("Tyne and Wear Metro")) return "M"
  if (network.includes("Glasgow Subway")) return "G"
  if (network === "NIR") return "N"
  return "Z"
}

// Strips parenthesised qualifiers, apostrophes, and punctuation so the
// letter-picker sees the core station name. Keeps "London " prefix
// intact (it's a real word in many cluster names like "London Bridge").
function cleanName(name: string): string {
  return name
    .replace(/\s*\([^)]*\)/g, "")
    .replace(/['']/g, "")
    .replace(/&/g, " and ")
    .replace(/[.,~/-]/g, " ")
    .trim()
}

// Picks 3 letters from a name to use as the ID suffix:
//   • 3+ words: first letter of each of the first 3 significant words
//   • 2 words: first letter of word 1, first 2 chars of word 2
//   • 1 word: first 3 chars
// Stopwords ("the", "of", "and", "at", "on", "in", "for", "to", "upon")
// are skipped so "Bridge of Don" → "BOD" not "BOO". When all words are
// stopwords (rare), falls back to the raw word list.
function pickLetters(name: string): string {
  const words = cleanName(name).split(/\s+/).filter(Boolean)
  const stop = new Set(["the", "of", "and", "at", "on", "in", "for", "to", "upon"])
  const significant = words.filter((w) => !stop.has(w.toLowerCase()))
  const list = significant.length ? significant : words
  if (list.length === 0) return "ZZZ"
  if (list.length >= 3) {
    return (list[0]![0]! + list[1]![0]! + list[2]![0]!).toUpperCase()
  }
  if (list.length === 2) {
    return (list[0]![0]! + list[1]!.slice(0, 2)).toUpperCase()
  }
  return list[0]!.slice(0, 3).padEnd(3, "X").toUpperCase()
}

// Manual ID overrides for collisions the deterministic algorithm can't
// resolve. Keyed by coordKey so we can pin a specific station without
// risking a name-match clash. The "winner" of each collision keeps the
// natural ID (typically the OSM-assigned ref:crs); the other gets a
// tweaked one. Add to this map ONLY when the audit script flags a
// real collision (`id-collision:` entries from
// scripts/audit-station-resolution.mjs). Coords from public/stations.json
// — update if stations.json changes.
const ID_OVERRIDES: Record<string, StationId> = {
  // ── London Underground collisions ────────────────────────────────
  // In each pair, the left coord is the no-CRS station whose auto-
  // generated id matches another Underground station's OSM-assigned
  // ref:crs. Override letters are mnemonic from the station name.
  "-0.1990432,51.4340563": "UWMP",  // Wimbledon Park (vs UWPA Wembley Park)
  "-0.1787546,51.5185075": "UPCH",  // Paddington Circle/H&C entrance (vs UPAD Paddington Underground)
  "-0.2066142,51.4457751": "UFLD",  // Southfields (vs USOU Southgate)
  "-0.1899646,51.5468194": "UWHP",  // West Hampstead (vs UWHA West Harrow)
  "-0.1635046,51.5222363": "UMYL",  // Marylebone (Underground) (vs UMAR Marble Arch)
  "-0.054752,51.5272449":  "UBET",  // Bethnal Green (vs UBGR Bounds Green)
}

// Cluster-anchor IDs are now stored directly as keys in
// lib/clusters-data.json (Phase 2e), so the registry no longer
// computes them. The disambiguation it used to do (CSTM for
// Streatham vs CSTR for Stratford, etc.) lives in the migration
// script (scripts/migrate-clusters-data.mjs) instead.

// ── Aliases ──────────────────────────────────────────────────────────
// Hand-curated overrides used when external data (Rambler walks, CSV
// imports, RTT calling-point names) refers to a station by a short or
// ambiguous form. Keys are normalised (lowercase, prefix-stripped, no
// punctuation) so look-ups are case-insensitive. Values are canonical
// IDs from this registry.
//
// Source: memory entries (station_aliases_*). Add new aliases here
// rather than scattering them across consumers — having one table
// keeps name resolution centralised.
const STATION_ALIASES: Record<string, StationId> = {
  // Each comment notes the raw form a data source uses.
  "rhoose": "RIA",                     // = Rhoose Cardiff International Airport
  "bath": "BTH",                       // = Bath Spa
  "canary wharf": "CWX",               // = Canary Wharf Elizabeth line
  "box hill": "BXW",                   // = Box Hill & Westhumble
  "canterbury": "CBE",                 // = Canterbury East (default; Canterbury West = CBW)
  "goring": "GOR",                     // = Goring & Streatley
  "christs hospital": "CHH",           // (apostrophe-stripped form)
  "didcot": "DID",                     // = Didcot Parkway
  "earlswood": "ELD",                  // = Earlswood Surrey (NOT the Birmingham one)
  "newport essex": "NWE",              // = Newport on the West Anglia line
  "haddenham thame parkway": "HDM",    // = Haddenham and Thame Parkway
  "waterloo": "WAT",                   // = London Waterloo (NOT Liverpool's WLO)
  // "St Margarets" is ambiguous between SMT (Hertfordshire) and SMG
  // (Richmond). Resolved by resolveName() via the optional `region`
  // hint, not by this static map.
}

// Region hint → SMT/SMG for "St Margarets" disambiguation. Values are
// substrings of the walk's `region` field (lowercase). Hertfordshire/
// East → SMT, Richmond/SW → SMG.
function resolveStMargarets(regionHint: string | undefined): StationId | undefined {
  if (!regionHint) return undefined
  const r = regionHint.toLowerCase()
  if (r.includes("hertfordshire") || r.includes("east") || r.includes("herts")) return "SMT"
  if (r.includes("richmond") || r.includes("sw") || r.includes("south west") || r.includes("london")) return "SMG"
  return undefined
}

// ── Module init: build maps from stations.json + clusters-data.json ─

type RawStation = {
  type: "Feature"
  geometry: { type: "Point"; coordinates: [number, number] }
  properties: { name?: string; "ref:crs"?: string; network?: string;[k: string]: unknown }
}
type RawClusters = { CLUSTERS: Record<string, { displayName: string; coord: string; members: string[]; isPrimaryOrigin: boolean; isFriendOrigin: boolean }> }

// Three forward-direction maps. All built once at module load.
const idToStation = new Map<StationId, StationRecord>()
const coordKeyToId = new Map<string, StationId>()
// Name lookup uses normalized keys (lowercase, prefix-stripped) so
// "London Bridge", "london bridge", and "London Bridge Station" all
// resolve. Multiple raw names can normalize to the same key — last
// write wins, but the alias map (Phase 1c) provides explicit overrides
// for ambiguous cases.
const normalizedNameToId = new Map<string, StationId>()

function normalizeName(name: string): string {
  return name
    .toLowerCase()
    .replace(/^london\s+/i, "")
    .replace(/\s+station$/i, "")
    .replace(/\s*\([^)]*\)/g, "")
    .replace(/['']/g, "")
    .replace(/[.,&-]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
}

// First pass: index every real station from public/stations.json
{
  const features = (stationsData as { features: RawStation[] }).features
  for (const f of features) {
    const name = f.properties.name
    if (!name) continue   // 42 unnamed heritage halts; skip
    const [lng, lat] = f.geometry.coordinates
    const coordKey = `${lng},${lat}`
    const network = f.properties.network ?? null
    const crs = f.properties["ref:crs"]

    let id: StationId
    if (crs) {
      id = crs
    } else {
      const overridden = ID_OVERRIDES[coordKey]
      id = overridden ?? networkPrefix(network) + pickLetters(name)
    }
    // Synthetic = our 4-character convention (network-prefix + 3
    // letters, or C-prefix for cluster anchors). Real ATOC CRS codes
    // are 3 chars — including the 5 ATOC-real codes that happen to
    // start with Z (ZFD, ZLW, ZEL, ZCW, ZTU). Length is the cleanest
    // discriminator since it matches the user-visible distinction.
    const isSynthetic = id.length === 4

    const record: StationRecord = {
      id,
      name,
      coord: [lng, lat],
      coordKey,
      network,
      isSynthetic,
      isClusterAnchor: false,
    }
    // First-write-wins on ID collisions — the audit script catches
    // these before they cause silent overwrites in production data.
    if (!idToStation.has(id)) idToStation.set(id, record)
    coordKeyToId.set(coordKey, id)
    // Name-collision rule: when multiple stations normalise to the
    // same key (e.g. "Paddington" the NR station vs "Paddington
    // (Underground)" the tube entrance both map to "paddington"),
    // prefer the NON-synthetic one. This matches the memory-stored
    // network-priority rule (NR > Elizabeth > Overground > DLR >
    // Underground): real-CRS wins over our synthetic-prefix codes.
    // If the existing entry IS synthetic and this one isn't, upgrade.
    const normalized = normalizeName(name)
    const existing = normalizedNameToId.get(normalized)
    if (!existing) {
      normalizedNameToId.set(normalized, id)
    } else if (!isSynthetic && idToStation.get(existing)?.isSynthetic) {
      normalizedNameToId.set(normalized, id)
    }
  }
}

// Second pass: index every cluster anchor from clusters-data.json.
// Post Phase 2e the JSON is keyed by C-prefix synthetic ID, with
// each entry carrying its centroid `coord` and an ID-array of
// `members`. Anchors are synthetic centroids, NOT real stations —
// they don't appear in stations.json and never have CRS codes.
{
  const clusters = (clustersData as RawClusters).CLUSTERS
  for (const [id, def] of Object.entries(clusters)) {
    const coordKey = def.coord
    const [lngStr, latStr] = coordKey.split(",")
    const lng = Number(lngStr)
    const lat = Number(latStr)
    const record: StationRecord = {
      id,
      name: def.displayName,
      coord: [lng, lat],
      coordKey,
      network: null,
      isSynthetic: true,
      isClusterAnchor: true,
    }
    if (!idToStation.has(id)) idToStation.set(id, record)
    coordKeyToId.set(coordKey, id)
    // Cluster anchor names overlap with member station names (e.g.
    // "Stratford" the cluster vs "Stratford" the SRA station). The
    // member station was indexed first; we DON'T overwrite normalized-
    // name → ID with the anchor. Callers wanting the anchor must look
    // up by ID directly or via a coord/region hint.
  }
}

// ── Public API ───────────────────────────────────────────────────────

// Primary lookup: get the full record for a known ID.
export function getStation(id: StationId): StationRecord | undefined {
  return idToStation.get(id)
}

// Resolve a coordKey to its ID. coordKey must be the full-precision
// `${lng},${lat}` form used in data files (NOT the truncated map-click
// clipboard form). Returns undefined if no station has that coord.
export function resolveCoordKey(coordKey: string): StationId | undefined {
  return coordKeyToId.get(coordKey)
}

// Resolve a station name to its ID. The lookup order matters:
//   1) STATION_ALIASES — hand-curated overrides for ambiguous short
//      forms ("Bath" → BTH not Bath North, "Rhoose" → RIA, etc.).
//   2) "St Margarets" special case — needs a `regionHint` to pick
//      between SMT (Hertfordshire) and SMG (Richmond). Returns
//      undefined if no hint is supplied.
//   3) Normalised-name fallback — built from stations.json at module
//      init. Lowercase, prefix-stripped, punctuation-collapsed.
// Returns undefined when no match is found — the caller decides
// whether to log, retry with a different form, or skip.
export function resolveName(name: string, regionHint?: string): StationId | undefined {
  const normalized = normalizeName(name)
  if (normalized === "st margarets") return resolveStMargarets(regionHint)
  const aliased = STATION_ALIASES[normalized]
  if (aliased) return aliased
  return normalizedNameToId.get(normalized)
}

// Reverse lookups for consumers that need the legacy form.
export function getCoordKey(id: StationId): string | undefined {
  return idToStation.get(id)?.coordKey
}

export function getName(id: StationId): string | undefined {
  return idToStation.get(id)?.name
}

// Iterator over every record. Useful for build scripts and audits;
// returns a defensive copy so callers can't mutate the registry.
export function getAllStations(): StationRecord[] {
  return [...idToStation.values()]
}
