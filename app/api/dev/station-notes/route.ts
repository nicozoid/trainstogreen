import { NextRequest, NextResponse } from "next/server"
import { readDataFile, writeDataFile } from "@/lib/github-data"

const FILE_PATH = "data/station-notes.json"

type NotesEntry = { name: string; publicNote: string; privateNote: string; ramblerNote?: string; publicRamblerNote?: string }

// POST accepts publicNote and privateNote only. `ramblerNote` and its
// sidecar `publicRamblerNote` are pure build outputs
// (scripts/build-rambler-notes.mjs) and are NOT writable through this
// endpoint — structured edits happen via /api/dev/walk/[id] which
// rewrites the source walk JSON and re-runs the build. Existing
// build-output fields are preserved so writes to the other notes
// don't clobber them.
export async function POST(req: NextRequest) {
  const { coordKey, name, publicNote, privateNote } = await req.json()
  if (!coordKey) return NextResponse.json({ error: "missing coordKey" }, { status: 400 })

  const { data: notes, sha } = await readDataFile<Record<string, NotesEntry>>(FILE_PATH)

  const existing = notes[coordKey]
  const existingRambler = existing?.ramblerNote ?? ""
  const existingPublicRambler = existing?.publicRamblerNote ?? ""

  if (publicNote || privateNote || existingRambler) {
    notes[coordKey] = {
      name: name ?? coordKey,
      publicNote: publicNote ?? "",
      privateNote: privateNote ?? "",
      ramblerNote: existingRambler,
      publicRamblerNote: existingPublicRambler,
    }
  } else {
    // Everything empty — remove the entry entirely
    delete notes[coordKey]
  }

  await writeDataFile(FILE_PATH, notes, `Update notes for ${name ?? coordKey}`, sha)
  return NextResponse.json({ message: "ok" })
}

// GET returns all notes so the map can load them on startup
export async function GET() {
  const { data: notes } = await readDataFile<Record<string, NotesEntry>>(FILE_PATH)
  return NextResponse.json(notes)
}
