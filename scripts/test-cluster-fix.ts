import { composePolylineForJourney, isHighQualityComposition } from "../lib/journey-composer"
const cases = [
  { o: "KGX", d: "CNWK", label: "KGX → CNWK (dest cluster)" },
  { o: "KGX", d: "NNG", label: "KGX → NNG (direct)" },
  { o: "WAT", d: "CDOC", label: "WAT → CDOC (dest cluster, 2nd member)" },
  { o: "CLON", d: "PLY", label: "CLON → PLY (origin cluster)" },
  { o: "CLON", d: "CNWK", label: "CLON → CNWK (both clusters)" },
  { o: "CLON", d: "CDOC", label: "CLON → CDOC (both clusters)" },
]
for (const c of cases) {
  const r = composePolylineForJourney(c.o, c.d)
  if (!r) { console.log(`✗ ${c.label}: null`); continue }
  console.log(`${isHighQualityComposition(r) ? "✓" : "○"} ${c.label}: ${r.coords.length}pts (${r.edgesResolved}/${r.edgesFallback}/${r.edgesMissing})`)
}
