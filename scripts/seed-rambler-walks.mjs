// Seeds data/rambler-walks.json by fetching the walkingclub.org.uk walk
// index and parsing out slug, title, region, and favourite status for every
// walk listed. Safe to re-run — merges with any existing data, so per-walk
// extraction state (extracted/onMap/issues/notes/walks/places/…) is
// preserved and only the index-level fields are refreshed.
//
// Usage:  node scripts/seed-rambler-walks.mjs
//
// Fields populated from the index:
//   - slug         URL slug, e.g. "hastings-to-rye"
//   - title        display title
//   - url          full walk URL
//   - region       geographic region from the Region column
//   - favourite    true when the page is starred on the index ("My Favourites")
//
// Fields initialised to defaults (populated later by extraction):
//   - extracted    has the per-page extractor run against this walk yet
//   - onMap        has the extracted data been applied to station RamblerNotes
//   - issues       is there an unresolved ambiguity flagged on this walk
//   - notes        free-text note for the admin table (e.g. "off mainland Britain")

import { readFileSync, writeFileSync, existsSync } from "fs"
import { fileURLToPath } from "url"
import { dirname, join } from "path"

const __dirname = dirname(fileURLToPath(import.meta.url))
const PROJECT_ROOT = join(__dirname, "..")
const OUT_PATH = join(PROJECT_ROOT, "data", "rambler-walks.json")
const INDEX_URL = "https://www.walkingclub.org.uk/walk/"

// Bot-block workaround — the site rejects default curl/node user agents
// with a 403, but accepts a real browser UA.
const BROWSER_UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"

async function fetchIndex() {
  const res = await fetch(INDEX_URL, { headers: { "User-Agent": BROWSER_UA } })
  if (!res.ok) throw new Error(`Fetch failed: ${res.status} ${res.statusText}`)
  return res.text()
}

// Parse each walk row. Each row on the index looks like:
//   <tr>
//     <td>East Sussex</td>                                        ← region
//     <td data-text="0 Coast, Beach, My Favourites">
//       <span title="My Favourites" ...>★</span>                  ← favourite marker
//     </td>
//     <td data-text="cw2.29">29</td>                              ← walk number
//     <td data-text="Hastings to Rye">
//       <a href="/walk/hastings-to-rye/">Hastings to Rye</a>      ← slug + title
//     </td>
//     <td>19</td>  <td>7</td>  ...                                ← metrics
//   </tr>
//
// Unstarred rows have an empty star cell: <td data-text="1 "></td>
function parseIndex(html) {
  const rows = []
  // Split on <tr> so each chunk is a row we can scan in isolation
  const trChunks = html.split(/<tr\b[^>]*>/i)
  for (const chunk of trChunks) {
    // Find the /walk/<slug>/ link — if absent this chunk isn't a walk row
    const linkMatch = chunk.match(/<a\s+href="\/walk\/([^"/]+)\/?"[^>]*>([^<]+)<\/a>/)
    if (!linkMatch) continue
    const [, slug, title] = linkMatch

    // Region is the text of the first <td> in the row
    const regionMatch = chunk.match(/<td[^>]*>\s*([^<]+?)\s*<\/td>/)
    const region = regionMatch ? regionMatch[1].trim() : ""

    // Favourite if the star cell carries title="My Favourites"
    const favourite = /title="My Favourites"/.test(chunk)

    rows.push({ slug, title: title.trim(), region, favourite })
  }
  return rows
}

function mergeWithExisting(fresh) {
  // Load any existing file so per-walk extraction state is preserved
  const existing = existsSync(OUT_PATH)
    ? JSON.parse(readFileSync(OUT_PATH, "utf-8"))
    : {}

  const merged = {}
  for (const row of fresh) {
    const prev = existing[row.slug] ?? {}
    merged[row.slug] = {
      // Index-level fields — always refreshed from the live index
      slug: row.slug,
      title: row.title,
      url: `${INDEX_URL}${row.slug}/`,
      region: row.region,
      favourite: row.favourite,
      // Per-walk state fields — preserved if previously set, else defaulted
      extracted: prev.extracted ?? false,
      onMap: prev.onMap ?? false,
      issues: prev.issues ?? false,
      notes: prev.notes ?? "",
      // Extraction payload — preserved verbatim if present. Shape evolves as
      // the extractor is developed; we don't prescribe it here.
      ...(prev.outsideMainlandBritain !== undefined && { outsideMainlandBritain: prev.outsideMainlandBritain }),
      ...(prev.regions && { regions: prev.regions }),
      ...(prev.categories && { categories: prev.categories }),
      ...(prev.tags && { tags: prev.tags }),
      ...(prev.places && { places: prev.places }),
      ...(prev.walks && { walks: prev.walks }),
    }
  }
  return merged
}

async function main() {
  // eslint-disable-next-line no-console
  console.log(`Fetching ${INDEX_URL}…`)
  const html = await fetchIndex()
  const rows = parseIndex(html)
  // eslint-disable-next-line no-console
  console.log(`Parsed ${rows.length} walks (${rows.filter((r) => r.favourite).length} starred).`)

  const merged = mergeWithExisting(rows)
  writeFileSync(OUT_PATH, JSON.stringify(merged, null, 2) + "\n", "utf-8")
  // eslint-disable-next-line no-console
  console.log(`Wrote ${Object.keys(merged).length} entries to ${OUT_PATH}`)
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error(err)
  process.exit(1)
})
