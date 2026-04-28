// One-off: hand-coded extraction of the Leicester Ramblers car-free-walks
// train-routes page. Unlike walkingclub.org.uk (one URL per walk), this
// is a single listing page with 27 walks described inline — there are
// no per-walk URLs to link to. All entries share the same source URL.
//
// Run:
//   node scripts/seed-leicester-walks.mjs
//
// Writes data/leicester-ramblers-walks.json in the same shape as
// data/rambler-walks.json so build-rambler-notes.mjs can merge the two.

import { readFileSync, writeFileSync } from "fs"
import { fileURLToPath } from "url"
import { dirname, join } from "path"

const __dirname = dirname(fileURLToPath(import.meta.url))
const ROOT = join(__dirname, "..")
const STATIONS_PATH = join(ROOT, "public", "stations.json")
const OUT_PATH = join(ROOT, "data", "leicester-ramblers-walks.json")

const SOURCE_URL = "https://ramblers-leicester.org.uk/car-free-walks/120-car-free-train-routes.html"
const PAGE_TITLE = "Leicester Ramblers car-free train walks"

// Build a name → CRS lookup. "Barrow-upon-Soar" vs "Barrow Upon Soar"
// is handled by a small alias table at the bottom of this helper.
const geo = JSON.parse(readFileSync(STATIONS_PATH, "utf-8"))
const crsByName = new Map()
for (const f of geo.features) {
  const name = f.properties?.name
  const crs = f.properties?.["ref:crs"]
  if (name && crs) crsByName.set(name, crs)
}
const NAME_ALIASES = {
  "Barrow Upon Soar": "Barrow-upon-Soar",
  "Barrow upon Soar": "Barrow-upon-Soar",
  "Leicester City Centre": "Leicester",
}
function crsFor(name) {
  const resolved = NAME_ALIASES[name] ?? name
  return crsByName.get(resolved) ?? null
}

// ── Walks — extracted from the Leicester Ramblers page. Each entry is a
// top-level walk with a single `main` variant. Structure mirrors the
// SWC dataset so the shared builder can handle both uniformly.
const walksSource = [
  { num: 101, title: "Nottingham to East Midlands Parkway", start: "Nottingham", end: "East Midlands Parkway", miles: 14, terrain: "Flat, mostly on decent paths.", sights: ["Nottingham Canal", "Beeston Canal", "River Trent", "Trentlock", "Sawley Cut"], lunch: [{ name: "refreshments", location: "Trentlock and Sawley Cut" }] },
  { num: 102, title: "East Midlands Parkway to Barrow upon Soar", start: "East Midlands Parkway", end: "Barrow Upon Soar", miles: 14, terrain: "Flat, mostly on decent paths, along the River Soar and Grand Union Canal.", sights: ["Redhill Boatyard", "Kegworth", "Zouch", "River Soar", "Grand Union Canal"], lunch: [{ name: "pubs", location: "Zouch, Loughborough, and Barrow" }] },
  { num: 103, title: "Barrow upon Soar to Leicester", start: "Barrow Upon Soar", end: "Leicester City Centre", miles: 12, terrain: "Flat, on decent paths.", sights: ["Cossington Lock", "Watermead Country Park", "National Space Centre", "Abbey Park"] },
  { num: 105, title: "Market Harborough Circular", start: "Market Harborough", end: "Market Harborough", sights: ["Brampton Valley Way", "Dingley Church", "Braybrooke", "Great Oxendon"], terrain: "Views, old-railway cycle/walking path." },
  { num: 106, title: "Oakham Circular", start: "Oakham", end: "Oakham", miles: 12, terrain: "Villages, churches, views across the Vale of Catmose.", sights: ["Rutland Water Nature Reserve", "Egleton", "Manton", "Brooke", "Braunston"] },
  { num: 107, title: "Syston to Melton Mowbray — A Wreake Valley Ramble", start: "Syston", end: "Melton Mowbray", miles: 13, terrain: "Flat, footpaths.", sights: ["Kirby Bellars Church", "Rearsby", "Brooksby", "Rotherby", "Frisby on the Wreake"], warnings: "Winter flooding possible." },
  { num: 108, title: "Melton Mowbray to Oakham via Whissendine", start: "Melton Mowbray", end: "Oakham", miles: 13, terrain: "Rural countryside.", sights: ["Whissendine Windmill"], lunch: [{ name: "Grain Store", location: "Oakham" }] },
  { num: 109, title: "East Midlands Parkway Circular", start: "East Midlands Parkway", end: "East Midlands Parkway", miles: 11.5, terrain: "Rolling farmland.", sights: ["Cuckoo Tree", "Ratcliffe-on-Soar", "West Leake", "Gotham"], lunch: [{ name: "pubs and seating by the church", location: "Gotham" }] },
  { num: 204, title: "Nottingham to East Midlands Parkway — South Bank of the River Trent", start: "Nottingham", end: "East Midlands Parkway", miles: 11, terrain: "Canal, river, wooded track, roadside footpath.", sights: ["Trent Bridge", "West Bridgford", "Clifton Hall", "Ratcliffe Power Station", "River Trent"], warnings: "Short stretch on busy A453.", lunch: [{ name: "Barton in Fabis farm shop and cafe", location: "" }] },
  { num: 206, title: "Atherstone — Bluebells & Beer", start: "Atherstone", end: "Atherstone", miles: 12.5, terrain: "Woodlands, country park, valley views.", sights: ["Hartshill Country Park", "Anker Valley"], warnings: "Best late April for bluebells.", lunch: [{ name: "Church End Brewery", location: "Ridge Lane" }] },
  { num: 210, title: "Derby to Long Eaton", start: "Derby", end: "Long Eaton", terrain: "Waterways — River Derwent, Derby & Sandiacre Canal, Erewash Canal.", sights: ["River Derwent", "Derby & Sandiacre Canal", "Erewash Canal"] },
  { num: 212, title: "Atherstone Circular", start: "Atherstone", end: "Atherstone", miles: 11, terrain: "Canal, villages.", sights: ["Coventry Canal", "Sheepy Magna", "Ratcliffe Culey", "Witherley"] },
  { num: 311, title: "Fiskerton and Southwell", start: "Fiskerton", end: "Fiskerton", miles: 8, terrain: "River, lanes, racecourse.", sights: ["Southwell Minster", "Southwell Racecourse", "River Greet"], lunch: [{ name: "pubs and cafes", location: "Southwell" }] },
  { num: 305, title: "Lichfield Trent Valley Circular", start: "Lichfield Trent Valley", end: "Lichfield Trent Valley", miles: 10, terrain: "Golf club, heath, woodland, Heart of England Way.", sights: ["Hopwas Hayes Wood", "Whittington Heath"], warnings: "MOD firing range — check access." },
  { num: 315, title: "Derby City", start: "Derby", end: "Derby", miles: 11, terrain: "Parks, river, heritage trail.", sights: ["Derby Cathedral", "Markeaton Park", "Allestree Park", "Darley Abbey", "Bonnie Prince Charlie Walk", "Big Wood", "River Derwent Heritage Trail"] },
  { num: 317, title: "Bingham Circular", start: "Bingham", end: "Bingham", miles: 8, terrain: "Village greens, countryside.", sights: ["Scarrington Horseshoe Pile", "Car Colston village green"], lunch: [{ name: "Cafe Velo", location: "Car Colston" }] },
  { num: 402, title: "Attenborough Nature Reserve, Beeston Canal & River Trent", start: "Attenborough", end: "Attenborough", miles: 8.5, terrain: "Good paths, nature reserve, canal, river.", sights: ["Attenborough Nature Reserve", "Beeston Canal", "River Trent"], warnings: "Check for flooding.", lunch: [{ name: "cafe", location: "Attenborough Nature Reserve" }] },
  { num: 404, title: "Burton Joyce to Fiskerton — A Walk by the River Trent", start: "Burton Joyce", end: "Fiskerton", terrain: "Riverside, good paths, open views.", sights: ["Gunthorpe Lock", "Gunthorpe village", "River Trent"], warnings: "Irregular train times.", lunch: [{ name: "pubs", location: "Gunthorpe" }, { name: "cafe at the lock", location: "Gunthorpe" }, { name: "pub", location: "Fiskerton" }] },
  { num: 409, title: "Loughborough Circular", start: "Loughborough", end: "Loughborough", miles: 10, terrain: "Canal, footpaths, roadside footpath.", sights: ["Grand Union Canal", "Cotes Bridge", "Walton on the Wolds"], warnings: "Last section on busy road." },
  { num: 410, title: "Spondon Circular to Dale Abbey", start: "Spondon", end: "Spondon", miles: 10, terrain: "Villages, park grounds, ornamental lake.", sights: ["Dale Abbey", "All Saints Church", "Hermitage Cave", "Ockbrook Moravian Settlement", "Locko Park"] },
  { num: 411, title: "Nuneaton Circular", start: "Nuneaton", end: "Nuneaton", miles: 10.5, terrain: "Parks, river, country park, canal.", sights: ["Hartshill Country Park", "Coventry Canal", "Sandon Park", "River Anker"] },
  { num: 415, title: "Stamford Circular", start: "Stamford", end: "Stamford", miles: 10.5, terrain: "Old railway, Roman road, park grounds, meadows.", sights: ["Burghley Park", "Wothorpe Towers", "Torpel Way", "Ermine Street", "Hereward Way", "Jurassic Way"] },
  { num: 416, title: "Long Eaton to Ilkeston — The Erewash Valley", start: "Long Eaton", end: "Ilkeston", miles: 10, terrain: "Canal, industrial towns, disused railway viaduct.", sights: ["Bennerley Viaduct", "Erewash Canal", "Erewash Valley Trail"] },
  { num: 417, title: "Lowdham to Burton Joyce", start: "Lowdham", end: "Burton Joyce", miles: 9, terrain: "Countryside, river.", sights: ["River Trent", "Gonalston", "Caythorpe", "Gunthorpe"], lunch: [{ name: "pub", location: "Burton Joyce" }] },
  { num: 418, title: "Kettering Circular", start: "Kettering", end: "Kettering", miles: 11, terrain: "Villages, countryside.", sights: ["Pytchley", "Broughton", "Great Cransley"] },
  // Walk 419 — Ruddington is bus-accessed from Nottingham (no mainline station),
  // so this is a bus-dependent walk. Flagged as requiresBus, not station-to-station.
  { num: 419, title: "Ruddington to Loughborough (bus from Nottingham)", start: "Nottingham", end: "Loughborough", miles: 12, terrain: "Country park, villages, hall grounds, river.", sights: ["Rushcliffe Country Park", "Stanford Hall", "Cotes Bridge", "East Leake"], requiresBus: true },
  { num: 426, title: "Duffield to Derby", start: "Duffield", end: "Derby", terrain: "Repurposed railway track along the Great Northern Greenway.", sights: ["Great Northern Greenway", "Horsley Carr", "Morley"] },
]

function entryFor(w) {
  const startCrs = crsFor(w.start)
  const endCrs = crsFor(w.end)
  const requiresBus = w.requiresBus ?? false
  const stationToStation = Boolean(startCrs && endCrs && !requiresBus)
  const slug = `leicester-ramblers-${w.num}`
  return {
    slug,
    title: `Walk ${w.num}: ${w.title}`,
    // All Leicester walks share the one source page — credit consistent.
    url: SOURCE_URL,
    favourite: false,
    region: "East Midlands",
    tags: ["leicester-ramblers"],
    categories: [],
    places: { villages: [], landmarks: [], historic: [], modern: [], nature: [], paths: [] },
    features: [],
    walks: [
      {
        role: "main",
        name: `Walk ${w.num}`,
        startPlace: w.start,
        endPlace: w.end,
        startStation: startCrs,
        endStation: endCrs,
        requiresBus,
        stationToStation,
        distanceKm: w.km ?? null,
        distanceMiles: w.miles ?? null,
        hours: w.hours ?? null,
        lunchStops: (w.lunch ?? []).map((l) => ({ name: l.name, location: l.location ?? "", url: l.url ?? null })),
        terrain: w.terrain ?? "",
        sights: (w.sights ?? []).map((name) => (typeof name === "string" ? { name, url: null } : name)),
        miscellany: w.warnings ?? "",
      },
    ],
    extracted: true,
    onMap: false,
    issues: false,
    notes: "",
    outsideMainlandBritain: false,
  }
}

const merged = {}
let resolved = 0, bus = 0, unresolved = 0
for (const w of walksSource) {
  const e = entryFor(w)
  merged[e.slug] = e
  const v = e.walks[0]
  if (v.stationToStation) resolved++
  else if (v.requiresBus) bus++
  else unresolved++
}

writeFileSync(OUT_PATH, JSON.stringify(merged, null, 2) + "\n", "utf-8")
// eslint-disable-next-line no-console
console.log(
  `Wrote ${Object.keys(merged).length} Leicester walks to ${OUT_PATH}  (s2s=${resolved}  bus=${bus}  unresolved=${unresolved})`
)
