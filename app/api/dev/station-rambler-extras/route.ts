import { NextRequest, NextResponse } from "next/server"
import { readDataFile, writeDataFile } from "@/lib/github-data"
import { handleAdminWrite } from "@/app/api/dev/_helpers"
import { buildRamblerNotes } from "@/scripts/build-rambler-notes.mjs"

const FILE_PATH = "data/station-rambler-extras.json"

// Shape on disk: `{ _readme: string, [coordKey: string]: string[] }`.
// The `_readme` key is metadata and is preserved across writes; every
// other key is an array of markdown strings, each rendered as its own
// paragraph AFTER the walk summaries in the station's ramblerNote.
// One-shot replacement semantics — POST with `lines: []` clears the
// entry.
type ExtrasFile = { _readme?: string; [coordKey: string]: string | string[] | undefined }

// GET — returns the full file so the client can render + edit existing
// notes. The `_readme` key is filtered out so consumers don't have to
// special-case it on every lookup.
export async function GET() {
  const { data } = await readDataFile<ExtrasFile>(FILE_PATH)
  const out: Record<string, string[]> = {}
  for (const [k, v] of Object.entries(data)) {
    if (k === "_readme") continue
    if (Array.isArray(v)) out[k] = v
  }
  return NextResponse.json(out)
}

// POST — replace one station's notes. Body: `{ coordKey, lines }`.
// An empty `lines` array deletes the entry so the file doesn't
// accumulate empty keys after an admin clears their notes.
export async function POST(req: NextRequest) {
  const { coordKey, lines } = await req.json()
  if (typeof coordKey !== "string" || !coordKey) {
    return NextResponse.json({ error: "missing coordKey" }, { status: 400 })
  }
  if (!Array.isArray(lines)) {
    return NextResponse.json({ error: "lines must be an array" }, { status: 400 })
  }
  // Trim + drop empty strings so a row the admin left blank doesn't
  // render as a ghost paragraph in the prose.
  const cleaned = lines
    .map((s) => (typeof s === "string" ? s.trim() : ""))
    .filter(Boolean)

  return handleAdminWrite(async () => {
    const { data, sha } = await readDataFile<ExtrasFile>(FILE_PATH)

    if (cleaned.length === 0) {
      delete data[coordKey]
    } else {
      data[coordKey] = cleaned
    }

    await writeDataFile(FILE_PATH, data, `Update station-rambler-extras for ${coordKey}`, sha)

    // Rebuild station-notes.json so the public prose reflects the edit
    // immediately — mirrors the per-walk PATCH flow.
    try {
      await buildRamblerNotes({ dryRun: false, flipOnMap: false })
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error("rebuild after rambler-extras write failed:", err)
      return NextResponse.json(
        { message: "saved but rebuild failed" },
        { status: 500 },
      )
    }

    return NextResponse.json({ message: "ok" })
  })
}
