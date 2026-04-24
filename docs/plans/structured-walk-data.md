# Plan: Structured walk data + Komoot + admin overlay

Status: Phases 1–5 landed. Remaining: Phase 6 (sources).

**Phase 2 reconciliation note (landed):** the recently-added `data/station-seasons.json` is no longer editable as its own source of truth. It's now a pure build output of `scripts/build-rambler-notes.mjs`, derived from each walk variant's structured `bestSeasons` field (months → seasons aggregated per station). The admin season checkboxes and the POST `/api/dev/station-seasons` handler were removed; GET is read-only so the map can still hydrate filters on startup. `scripts/build-station-seasons.mjs` was deleted.

## Goal

Make the per-walk data in `data/rambler-walks.json` slightly richer so:

1. **Komoot links** can live in source data and flow through the build into the rendered ramblerNote, rather than being hand-patched into `data/station-notes.json` (which gets wiped on every `node scripts/build-rambler-notes.mjs` run).
2. **Mud warnings** and **best seasons** become structured fields instead of free-text, so they can be rendered as icons/chips in future UI and filtered on.
3. **The per-station admin overlay** (wherever the ramblerNote is edited today) stops editing prose directly and instead edits structured fields — the prose gets regenerated from them.

## Why not the full flatten?

Open question from the conversation: *"how is this different from the big flatten-everything?"*

Structurally it's close. If we add `komootUrl`, `bestSeasons`, `mudWarning` to each variant in the existing `walks[]` array, the variants effectively become the individual walk objects you described. The difference is:

- **Keep current nesting**: page-level metadata (title, tagline, favourite, places, categories) sits above a `walks[]` array. Each variant holds its own stats + the new structured fields. No mass data migration.
- **Full flatten**: every walk becomes a top-level record, and page-level metadata gets duplicated across all variants of the same page. ~1000 walks × migration work, with no user-visible benefit.

**Recommendation: keep nesting, add fields.** The admin UI can still present walks as individual rows/cards regardless of underlying nesting.

## Schema changes

### `data/rambler-walks.json` — per walk (inside `walks[]`)

Add three new optional fields to each variant object:

```jsonc
{
  "role": "main",
  "name": "Main Walk",
  // ... existing fields ...
  "komootUrl": "https://www.komoot.com/tour/2905513618",  // NEW — optional
  "bestSeasons": ["jul", "aug"],                           // NEW — optional, array of 3-letter month codes
  "mudWarning": true                                       // NEW — optional, default false
}
```

Month codes: `"jan" | "feb" | "mar" | "apr" | "may" | "jun" | "jul" | "aug" | "sep" | "oct" | "nov" | "dec"`.

### Additional admin-only fields on walk variants

Landed as schema conventions (the JSON has no enforced schema, so these are just new optional keys that start populating once the Phase 5 admin editor supports them, or via manual edits). None of them render in the current `ramblerNote` — they're for the future per-walk cards that replace the prose.

```jsonc
{
  // ── on each sight (sights[]) ──
  "name": "Hastings Castle",
  "url": "...",                  // already existed
  "description": "Ruined Norman castle on the clifftop.", // NEW, optional

  // ── on each lunch stop (lunchStops[]) ──
  "name": "Gun Inn",
  "location": "Keyhaven",        // already existed — place name, e.g. village
  "url": "...",                  // already existed
  "notes": "Great beer garden, cash only.", // NEW, optional free text
  "rating": "good",              // NEW, optional: "good" | "fine" | "poor"

  // ── on each walk variant (walks[]) ──
  "id": "a7kq",                  // NEW, required — unique 4-char base36 code
  "previousWalkDates": ["2024-08-17", "2025-05-03"] // NEW, optional, ISO dates
}
```

**`id`** is a short unique handle for referring to one variant in conversation (e.g. "fix walk `a7kq`"). 4 characters from `[0-9a-z]` — 1.67M combinations, safe for ~1500 variants and plenty of headroom for growth. Assigned by [scripts/assign-walk-ids.mjs](../../scripts/assign-walk-ids.mjs) which is idempotent: run it any time new walks are added and it fills in `id` for only the ones missing one, avoiding collisions with existing ids across ALL walks files. Display is deferred to Phase 5 cards — admins can look it up in the source JSON for now.

**`previousWalkDates`** is a purely private metadata field — a log of when the user personally walked this route. Never surfaced in public UI. ISO date strings only (`YYYY-MM-DD`).

**`lunchStops[].rating`** and **`lunchStops[].notes`** will render in Phase 5 cards (e.g. good/fine/poor badge, notes as a sub-line under the venue). For now: admin metadata only.

**`sights[].description`** will render in Phase 5 cards as a second line under the sight name. For now: admin metadata only.

### Walk name (deferred — not changing)

Considered having the variant `name` auto-derive from `startStation` + `endStation` (e.g. `"Hurst Green to Oxted"` or `"Oxted circular"` with an optional editable suffix like `"via Titsey Place"`). Decided against it for now:
- The ramblerNote renderer already synthesizes `"Start to End"` titles inline for non-main variants, so the displayed text is already derived.
- Introducing a derived+suffix field means migrating ~1000 existing `name` values.
- The Phase 5 cards will reshape how names are presented anyway — wait until that lands before locking in a storage format.

**Season → months mapping** (for migrating existing `bestTime` free-text):
- spring → mar, apr, may
- summer → jun, jul, aug
- autumn / fall → sep, oct, nov
- winter → dec, jan, feb
- "late July/Aug" → jul, aug (use the inclusive reading — if a month is mentioned at all, include it)
- "early/mid/late X" → just X
- prose like "Can be very cold in winter" = usage advice, not a best-season. Leave empty in those cases.

**Migration of `mudWarning`**: set `true` where the existing prose `warnings` string contains "mud" or "muddy" (case-insensitive). Don't delete the prose — `warnings` still holds the free-text for anything not captured by structured flags (e.g. "MOD closures apply").

**Migration of `bestSeasons`**: parse the existing free-text `bestTime` field into month codes using the mapping above. Keep `bestTime` around as a legacy field for now (can drop in a later pass).

### `scripts/build-rambler-notes.mjs` — emit the new fields

In `buildSummary()`:

1. **`komootUrl`**: emit a trailing clause `[Komoot](url).` (mirror the existing `entry.gpx` handling, but per-variant, not per-entry).
2. **When `komootUrl` is present**: skip the distance and hours clauses. Komoot provides authoritative figures; the Rambler ones are often approximate and now conflict. (This replaces the feedback memory rule that says "hand-delete km/hours when adding Komoot".)
3. **`bestSeasons`**: render as "Best in July, August." (join with commas, "and" before last, full month names). Replaces the old `variant.bestTime` rendering when structured is present; fall back to the free-text when not.
4. **`mudWarning`**: when true, emit "Can be muddy." — but only if the free-text `warnings` doesn't already start with mud-related wording (avoid duplication). Other warnings still render as the free-text clause.

Keep the favourites-first sort (already landed in this PR).

## Walk sources (generalized — not just books)

Sources can be any origin a walk comes from: a URL (Rambler, SWC, Heart), a book, an organization (Ramblers Association, Trains to Green itself), or anything else. Each source has optional metadata (title, edition, URL, etc.) and walks reference it by slug so we don't duplicate metadata across every walk. Below is framed around books as the concrete first example, but the same `data/sources.json` registry should cover all types (`type: "book" | "url" | "organization" | "tg"`, etc.).

### Book sources (first concrete example)

Some walks aren't sourced from a URL but from a book (e.g. *The Rough Guide to Walks in London & the South East*, 3rd edition). Today these live as hand-edited `publicNote` text. Going forward we want them as first-class walk entries alongside Rambler walks, so they share the same schema, admin UX, and rendering pipeline.

Key constraint: **a single book will be cited by many walks.** Duplicating full book metadata on every walk would be wasteful and error-prone — update the edition once and it should propagate everywhere.

### Proposed shape

**New file: `data/book-sources.json`** — keyed by slug, holds book metadata once:

```jsonc
{
  "rough-guide-walks-london-south-east-3rd": {
    "title": "The Rough Guide to Walks in London & the South East",
    "edition": "3rd",
    "author": "Helena Smith, Judith Bamber",
    "publisher": "Rough Guides",
    "year": 2012,
    "isbn": "…"
  }
}
```

**Walk entries** get an optional alternative source field instead of (or alongside) `url`:

```jsonc
{
  "slug": "borough-green-to-sevenoaks-via-ightham-mote",
  "title": "Borough Green to Sevenoaks, via Ightham Mote",
  "source": { "book": "rough-guide-walks-london-south-east-3rd", "page": 42, "walkNumber": 15 },
  // OR the existing URL-style:
  // "source": { "url": "https://www.walkingclub.org.uk/…" }
  // Existing top-level `url` becomes a legacy field; keep populated from `source.url` during migration.
  "favourite": true,
  "walks": [ … ]
}
```

`page` / `walkNumber` are optional — whichever the book uses for referencing. We might want both.

### Rendering

In `buildSummary()`, the linked page title clause adapts to the source:

- **URL source**: unchanged — `**[Walk Title](url)**:`
- **Book source**: `**Walk Title**:` (no link on the title), with a trailing clause `Adapted from [book title, edition].` (possibly with page reference).

The book metadata gets looked up from `book-sources.json` via the slug. If the book has no `url`, the title renders as plain text in the trailing clause; if it has an optional `url` field (e.g. publisher page or bookshop link) we can link it.

### Admin UX

The admin overlay needs a "source" field per walk with a picker: **URL** (text input) or **Book** (dropdown of existing book slugs + optional page/walkNumber). Adding a new book is a separate admin action (or just a manual edit of `book-sources.json` for now).

### Extras integration

The build script already merges `data/leicester-ramblers-walks.json`, `data/heart-rail-trails-walks.json`, `data/abbey-line-walks.json` via `EXTRA_WALKS_PATHS`. Book-sourced walks can follow the same pattern: a dedicated `data/rough-guide-london-walks.json` (or similar) registered in `EXTRA_WALKS_PATHS`. Each entry in it uses `source: { book: "..." }` instead of `source: { url: "..." }`. This keeps Rambler/SWC data and book data cleanly separated on disk.

### Migration of existing hand-edited publicNote walks

A small one-shot task: find every `publicNote` in `station-notes.json` that starts with a `**[Walk title](url)**: …` pattern, convert to a walk entry in the appropriate source file, then clear the `publicNote`. Sevenoaks's Borough-Green-via-Ightham-Mote entry is the first candidate. The user wants to do these by hand for now — fine, we're just making the target schema available.

## Admin overlay changes

> This is the biggest piece and the most uncertain — needs exploration in the session that implements this.

The current `/admin/rambler-walks` page is a pipeline status table (extracted / onMap / issues), **not** a prose editor. Somewhere else — likely the map station overlay or a dedicated station-notes editor — is where ramblerNote is presented and possibly edited.

Steps for the implementing session:

1. **Find the editor**: grep for `ramblerNote` in `components/` and `app/`. Identify the component(s) that render an editable text area over the ramblerNote.
2. **Decide the split**: the editor should present one card/section per walk (iterate `walks[]` of the entries whose start or end station matches the coord key). Each card shows: name, role, sights, terrain, distance, hours, lunch stops, Komoot URL (new editable), best seasons (new — month picker), mud warning (new — checkbox), other warnings (free text).
3. **Page-level fields** (title, favourite, tagline) stay editable at the page level — one "page" section above the walks, or on a separate screen.
4. **Save path**: when the admin edits any field, persist to `data/rambler-walks.json` (via an API route), then kick off the build script to regenerate `data/station-notes.json`. In dev, this can be synchronous; in a future prod setup, a CI hook.
5. **Remove direct ramblerNote editing**: `station-notes.json` becomes purely a build output. The admin overlay never writes to it directly.

## Migration + cutover order

1. **Add the schema fields + build-script handling** (no data changes yet). Build script emits nothing new because no entries have the new fields. Safe to merge.
2. **Add Komoot URL for Milford→Haslemere** (the one we already have) to `data/rambler-walks.json`. Run the build → verify it comes through in the ramblerNote. This replaces the hand-patch currently in `station-notes.json`.
3. **Backfill `mudWarning` + `bestSeasons`** via a one-shot migration script (parse existing `warnings` and `bestTime` text). Dry-run first, eyeball a sample, then commit.
4. **Update the admin overlay** to edit structured walks instead of prose. Biggest change; do last.
5. **Optional later**: drop the legacy `bestTime` / `warnings` free-text fields if `mudWarning` + `bestSeasons` + any new structured warnings cover everything.

## Open questions to resolve when implementing

- Where is the ramblerNote editor today? (Answer will reshape step 4 above.)
- Should `bestSeasons` support a range notation (`"jul-aug"`) or stay as an explicit array of month codes? Array is simpler; range compresses better — array wins for now.
- Any other warning types worth structuring beyond mud? Possible: MOD closures, steep climbs, bull fields. Leave as free-text unless a clear pattern emerges during migration.
- Do any walks have multiple Komoot URLs (e.g. one per variant)? Probably yes eventually — putting `komootUrl` on the variant rather than the page handles this.
