import { NextRequest, NextResponse } from "next/server"
import { readDataFile, writeDataFile } from "@/lib/github-data"
import { handleAdminWrite } from "@/app/api/dev/_helpers"

// Admin endpoint for the walkingclub.org.uk extraction dataset.
//
// GET  → returns the whole data/rambler-walks.json file (the admin page
//        polls this periodically to show progress).
// POST → partial-updates a single walk entry, merging the posted fields
//        into the existing entry. Used later by the extraction script and
//        by manual admin edits on the page (toggling `issues`, editing
//        `notes`, etc.).

const FILE_PATH = "data/rambler-walks.json"

// All walk-source files follow the same shape (slug/title/url/...), so we
// merge them into one record on GET. The admin page is a single view over
// every extracted walk regardless of source — the source domain is carried
// in the `url` field, which the UI uses to drive the domain filter.
const SOURCE_FILES = [
  "data/rambler-walks.json",
  "data/leicester-ramblers-walks.json",
  "data/heart-rail-trails-walks.json",
  "data/abbey-line-walks.json",
]

// Files updated as side-effects of marking a walk `resolved: true`. See
// cleanupOnResolve below for the exact semantics.
const STATION_NOTES_PATH = "data/station-notes.json"
const HAS_ISSUE_PATH = "data/has-issue-stations.json"

// Auto-generated-block delimiters in a station's privateNote. The
// build-rambler-notes script inserts walk-issue lines between these two
// markers; we remove them on resolution.
const BLOCK_START = "-- Rambler-walk issues (auto-generated) --"
const BLOCK_END = "-- end Rambler-walk issues --"

// Shape is intentionally loose — the file holds both index-level fields
// (slug/title/url/region/favourite) and extraction payload (walks, places,
// etc.). We don't want to fight TS over payload keys here.
type RamblerWalk = Record<string, unknown> & { slug: string }

type StationNote = {
  name?: string
  publicNote?: string
  privateNote?: string
  ramblerNote?: string
}

export async function GET() {
  // Read all source files + station-notes in parallel. Station-notes is
  // the source of truth for what walks are actually "on the map" (they
  // appear in a station's ramblerNote), so we compute the attachedStations
  // per walk on the fly rather than relying on the stale onMap boolean.
  const [walkResults, notesResult] = await Promise.all([
    Promise.all(SOURCE_FILES.map((p) => readDataFile<Record<string, RamblerWalk>>(p))),
    readDataFile<Record<string, StationNote>>(STATION_NOTES_PATH),
  ])

  const merged: Record<string, RamblerWalk> = {}
  for (const { data } of walkResults) Object.assign(merged, data)

  // Build slug → coordKey[] by scanning each station's ramblerNote for
  // walk URLs. ramblerNote contains markdown links like
  // `[Walk Title](https://www.walkingclub.org.uk/walk/<slug>/)` — the
  // slug only appears in the URL (not the link text), so we key off URL.
  const urlToSlug = new Map<string, string>()
  for (const slug of Object.keys(merged)) {
    const url = (merged[slug] as { url?: string }).url
    if (url) urlToSlug.set(url, slug)
  }
  const attachmentsBySlug: Record<string, string[]> = {}
  const linkRe = /\]\(([^)]+)\)/g
  for (const [coord, note] of Object.entries(notesResult.data)) {
    const rn = (note as StationNote)?.ramblerNote
    if (!rn) continue
    const seen = new Set<string>()
    let m: RegExpExecArray | null
    while ((m = linkRe.exec(rn)) !== null) {
      const slug = urlToSlug.get(m[1])
      if (!slug || seen.has(slug)) continue
      seen.add(slug)
      ;(attachmentsBySlug[slug] ||= []).push(coord)
    }
  }

  // Inject attachedStations into each walk. Sort coordKeys for stable UI
  // rendering (the page doesn't otherwise sort them).
  for (const slug of Object.keys(merged)) {
    merged[slug] = { ...merged[slug], attachedStations: (attachmentsBySlug[slug] ?? []).sort() }
  }

  return NextResponse.json(merged)
}

export async function POST(req: NextRequest) {
  const body = await req.json()
  const { slug, ...patch } = body as { slug?: string } & Record<string, unknown>
  if (!slug) return NextResponse.json({ error: "missing slug" }, { status: 400 })

  return handleAdminWrite(async () => {
    // Walks now live across several source files, so find the one holding
    // this slug and write only there. We read sequentially rather than in
    // parallel because once we find the match we need that specific sha for
    // the writeDataFile optimistic-concurrency check.
    for (const path of SOURCE_FILES) {
      const { data: walks, sha } = await readDataFile<Record<string, RamblerWalk>>(path)
      if (!walks[slug]) continue

      // Shallow merge: top-level keys in `patch` overwrite existing values.
      // Nested objects (places, walks[]) are replaced wholesale if included —
      // consumers should send whole objects for those when updating them.
      walks[slug] = { ...walks[slug], ...patch, slug }
      await writeDataFile(path, walks, `Update rambler walk: ${slug}`, sha)

      // Side effect: a walk being marked resolved triggers cleanup of the
      // auto-generated issue lines in every affected station's privateNote,
      // and removes the station from has-issue-stations if that was the
      // last rambler-walk issue on it.
      if (patch.resolved === true) {
        await cleanupOnResolve(slug)
      }

      return NextResponse.json({ message: "ok" })
    }

    return NextResponse.json({ error: `unknown slug: ${slug}` }, { status: 404 })
  })
}

// Remove the walk's auto-generated issue block from every station's
// privateNote, drop the marker lines when no blocks remain, and unflag
// any station that had only this walk's issue. Designed to be idempotent
// — if the slug's line is already gone we simply do nothing.
async function cleanupOnResolve(slug: string) {
  const linePrefix = `[${slug}](`

  const { data: notes, sha: notesSha } =
    await readDataFile<Record<string, StationNote>>(STATION_NOTES_PATH)

  // Coords whose privateNote no longer has ANY rambler-walk issue block
  // after this cleanup — candidates for has-issue unflagging.
  const unflagCandidates: string[] = []
  let notesChanged = false

  for (const coord of Object.keys(notes)) {
    const entry = notes[coord]
    const pn = entry?.privateNote
    if (!pn || !pn.includes(linePrefix)) continue

    // Strip every line that identifies this walk (there should only be
    // one, but be defensive in case of accidental duplicates).
    let lines = pn.split("\n").filter((l) => !l.startsWith(linePrefix))

    // If the marker block is now empty of walk-issue lines, drop the
    // markers too. "Empty" = no non-blank lines strictly between them.
    const startIdx = lines.findIndex((l) => l.trim() === BLOCK_START)
    const endIdx = lines.findIndex((l) => l.trim() === BLOCK_END)
    if (startIdx !== -1 && endIdx !== -1 && endIdx > startIdx) {
      const inner = lines.slice(startIdx + 1, endIdx).filter((l) => l.trim() !== "")
      if (inner.length === 0) {
        lines.splice(startIdx, endIdx - startIdx + 1)
      }
    }

    // Collapse runs of blank lines left behind by removals, then trim.
    const newPn = lines.join("\n").replace(/\n{3,}/g, "\n\n").trim()
    if (newPn !== pn) {
      entry.privateNote = newPn
      notesChanged = true
      if (!newPn.includes(BLOCK_START)) unflagCandidates.push(coord)
    }
  }

  if (notesChanged) {
    await writeDataFile(
      STATION_NOTES_PATH,
      notes,
      `Clean up rambler-walk issue for resolved ${slug}`,
      notesSha
    )
  }

  if (unflagCandidates.length > 0) {
    const { data: list, sha: listSha } = await readDataFile<string[]>(HAS_ISSUE_PATH)
    const set = new Set(list)
    let listChanged = false
    for (const c of unflagCandidates) {
      if (set.delete(c)) listChanged = true
    }
    if (listChanged) {
      await writeDataFile(
        HAS_ISSUE_PATH,
        [...set].sort(),
        `Clear issue flag for stations after resolving ${slug}`,
        listSha
      )
    }
  }
}
