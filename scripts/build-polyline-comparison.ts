// Phase 1 exit criterion: render baked polylines (current main) vs.
// composer polylines (lib/compose-segment-polyline) on the same map for a
// few real journeys, so the user can eyeball whether the composer's output
// is genuinely better before we wire it into map.tsx.
//
// Picks journeys from public/routing/central-london.json that have a baked
// polyline AND a known calling-points sequence in data/origin-routes.json.
// Builds a self-contained HTML page (Leaflet via CDN, no Mapbox token),
// drops it at /tmp/polyline-comparison.html, and prints the path.
//
// Run: npx tsx scripts/build-polyline-comparison.ts

import { readFileSync, writeFileSync } from "fs"
import { fileURLToPath } from "url"
import { dirname, join } from "path"
import {
  composeFromCallingPoints,
  decodePolyline,
  type RailSegments,
} from "../lib/compose-segment-polyline"

const __dirname = dirname(fileURLToPath(import.meta.url))
const root = join(__dirname, "..")

const segments = JSON.parse(
  readFileSync(join(root, "data/rail-segments.json"), "utf8"),
) as RailSegments

const stationsGeoJson = JSON.parse(
  readFileSync(join(root, "public/stations.json"), "utf8"),
) as {
  features: {
    geometry?: { coordinates?: number[] }
    properties?: { "ref:crs"?: string; name?: string } | null
  }[]
}

const routes = JSON.parse(
  readFileSync(join(root, "data/origin-routes.json"), "utf8"),
) as Record<
  string,
  { directReachable?: Record<string, { fastestCallingPoints?: string[] }> }
>

const diffs = JSON.parse(
  readFileSync(join(root, "public/routing/central-london.json"), "utf8"),
) as Record<
  string,
  {
    journeys?: Record<
      string,
      {
        legs?: { departureStation?: string; arrivalStation?: string; vehicleType?: string }[]
        polylineCoords?: [number, number][]
      }
    >
  }
>

const crsToCoord = new Map<string, [number, number]>()
for (const f of stationsGeoJson.features) {
  const crs = f.properties?.["ref:crs"]
  const c = f.geometry?.coordinates
  if (!crs || !Array.isArray(c) || c.length < 2) continue
  if (!crsToCoord.has(crs)) crsToCoord.set(crs, [c[0] as number, c[1] as number])
}

// Pick three test journeys whose baked polylines are rich (≥30 points) and
// whose calling points exist in origin-routes.
const testCases: { label: string; origCrs: string; destCrs: string }[] = [
  { label: "Waterloo → Dorchester South (13 stops, Wessex Main Line)", origCrs: "WAT", destCrs: "DCH" },
  { label: "King's Cross → Newark Northgate (3 stops, ECML)", origCrs: "KGX", destCrs: "NNG" },
  { label: "London Bridge → Arundel (13 stops, Sussex)", origCrs: "LBG", destCrs: "ARU" },
]

type Result = {
  label: string
  origCrs: string
  destCrs: string
  callingPoints: string[]
  bakedCoords: [number, number][]
  composerCoords: [number, number][]
  composerStats: { resolved: number; fallback: number; missing: number }
}

const results: Result[] = []

for (const tc of testCases) {
  const cp = routes[tc.origCrs]?.directReachable?.[tc.destCrs]?.fastestCallingPoints
  if (!cp || cp.length < 2) {
    console.warn(`SKIP ${tc.label}: no calling points`)
    continue
  }

  // Find baked polyline by matching origin coord and destination coord.
  const origCoord = crsToCoord.get(tc.origCrs)
  const destCoord = crsToCoord.get(tc.destCrs)
  if (!origCoord || !destCoord) {
    console.warn(`SKIP ${tc.label}: missing coord`)
    continue
  }

  // The Central London diff is keyed by destination coord. Search for the
  // matching journey by departureStation matching tc.origCrs's station.
  let baked: [number, number][] | null = null
  // Match on destination coord (rounded to 7 decimals like the keys).
  const destKey = `${destCoord[0]},${destCoord[1]}`
  const destEntry = diffs[destKey]
  if (destEntry?.journeys) {
    for (const j of Object.values(destEntry.journeys)) {
      if (!j.polylineCoords) continue
      const firstLeg = j.legs?.[0]
      // Loose match: first-leg departure station name contains the origin name's first word.
      const origName = stationsGeoJson.features.find(
        (f) => f.properties?.["ref:crs"] === tc.origCrs,
      )?.properties?.name
      if (
        firstLeg?.departureStation &&
        origName &&
        (firstLeg.departureStation.includes(origName.split(" ")[0]) ||
          origName.includes(firstLeg.departureStation.split(" ")[0]))
      ) {
        baked = j.polylineCoords
        break
      }
    }
  }
  if (!baked) {
    console.warn(`SKIP ${tc.label}: no baked polyline at dest ${destKey}`)
    continue
  }

  const result = composeFromCallingPoints(cp, { segments, crsToCoord })

  results.push({
    label: tc.label,
    origCrs: tc.origCrs,
    destCrs: tc.destCrs,
    callingPoints: cp,
    bakedCoords: baked,
    composerCoords: result.coords,
    composerStats: {
      resolved: result.edgesResolved,
      fallback: result.edgesFallback,
      missing: result.edgesMissing,
    },
  })
  console.log(
    `✓ ${tc.label}: baked=${baked.length}pts, composer=${result.coords.length}pts (resolved=${result.edgesResolved}/fallback=${result.edgesFallback}/missing=${result.edgesMissing})`,
  )
}

// Inline the data into a self-contained Leaflet page.
const html = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <title>Polyline comparison: baked vs. composer</title>
  <link rel="stylesheet" href="https://unpkg.com/leaflet@1.9.4/dist/leaflet.css" />
  <style>
    body { margin: 0; font-family: -apple-system, BlinkMacSystemFont, sans-serif; }
    #map { height: 70vh; }
    #panel { padding: 12px 16px; background: #fafafa; border-top: 1px solid #ddd; }
    button { margin-right: 6px; padding: 6px 10px; cursor: pointer; }
    button.active { background: #222; color: white; border-color: #222; }
    .legend span { display: inline-block; width: 14px; height: 4px; vertical-align: middle; margin-right: 4px; }
    .legend .baked { background: #d9534f; }
    .legend .composer { background: #2c7be5; }
    .stats { font-size: 13px; color: #555; margin-top: 6px; }
    code { background: #eef; padding: 1px 4px; border-radius: 3px; }
  </style>
</head>
<body>
  <div id="map"></div>
  <div id="panel">
    <div id="buttons"></div>
    <div class="legend" style="margin-top: 8px;">
      <span class="baked"></span> baked polyline (current main) &nbsp;
      <span class="composer"></span> composer (rail-segments)
    </div>
    <div class="stats" id="stats"></div>
  </div>
  <script src="https://unpkg.com/leaflet@1.9.4/dist/leaflet.js"></script>
  <script>
    const cases = ${JSON.stringify(results)};
    const map = L.map('map').setView([53, -2], 6);
    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
      maxZoom: 19, attribution: '© OpenStreetMap'
    }).addTo(map);
    let currentLayers = [];
    function show(idx) {
      currentLayers.forEach(l => map.removeLayer(l));
      currentLayers = [];
      const c = cases[idx];
      const baked = L.polyline(c.bakedCoords.map(p => [p[1], p[0]]), { color: '#d9534f', weight: 5, opacity: 0.8 }).addTo(map);
      const comp = L.polyline(c.composerCoords.map(p => [p[1], p[0]]), { color: '#2c7be5', weight: 3, opacity: 0.9 }).addTo(map);
      currentLayers.push(baked, comp);
      const bounds = baked.getBounds().extend(comp.getBounds());
      map.fitBounds(bounds, { padding: [40, 40] });
      document.querySelectorAll('#buttons button').forEach((b, i) => b.classList.toggle('active', i === idx));
      document.getElementById('stats').innerHTML =
        \`<strong>\${c.label}</strong><br />\` +
        \`calling points: <code>\${c.callingPoints.join(' → ')}</code><br />\` +
        \`baked: \${c.bakedCoords.length} points &nbsp;|&nbsp; \` +
        \`composer: \${c.composerCoords.length} points (resolved=\${c.composerStats.resolved}, fallback=\${c.composerStats.fallback}, missing=\${c.composerStats.missing})\`;
    }
    const btns = document.getElementById('buttons');
    cases.forEach((c, i) => {
      const b = document.createElement('button');
      b.textContent = c.label;
      b.onclick = () => show(i);
      btns.appendChild(b);
    });
    if (cases.length) show(0);
  </script>
</body>
</html>
`

const outPath = "/tmp/polyline-comparison.html"
writeFileSync(outPath, html)
console.log(`\nWrote ${outPath}`)
console.log(`Open with: open ${outPath}`)
